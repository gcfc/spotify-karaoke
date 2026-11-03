// ============================================================
//  Furigana for Japanese lyrics — shared by app.js (browser),
//  worker/worker.js (Cloudflare Worker) and the tests.
//
//  The lyrics are split into kanji runs here, locally, and the model is
//  asked only for one reading per run.  It never writes the lyric text
//  back, so it has no way to alter it: a reply either has the right
//  number of readings, in kana, for every line, or the line is dropped.
//
//  Readings go over a whole run rather than each character, because many
//  cannot be split: 今日 is きょう, 大人 is おとな, and 二人 is ふたり,
//  with no part belonging to any one character.
// ============================================================

// Characters that take a reading.  々 repeats the kanji before it, 〆 and 〇
// are kanji in all but block, and ヶ is the small ke of 三ヶ月.
const RUN_RE = /[\p{Script=Han}々〆〇ヶヵ0-9０-９]+/gu;
const HAS_KANJI_RE = /[\p{Script=Han}々〆〇]/u;

/**
 * The stretches of a line that need a reading, with their UTF-16 offsets
 * into the line.  A run is kanji, plus any digits written against them —
 * 2人 is sung ふたり, so the 2 is part of what the reading covers.  A run of
 * digits alone has no kanji and needs no furigana.
 */
export function kanjiRuns(line) {
  const runs = [];
  for (const match of String(line || '').matchAll(RUN_RE)) {
    if (!HAS_KANJI_RE.test(match[0])) continue;
    runs.push({ start: match.index, end: match.index + match[0].length, text: match[0] });
  }
  return runs;
}

export function hasKanji(text) {
  return HAS_KANJI_RE.test(String(text || ''));
}

// A reading written into the lyrics: 溢(こぼ)れた, 終幕(さいご)は.  Lyric
// databases keep the printed ruby this way when they keep it at all.
const INLINE_RE = /([\p{Script=Han}々〆〇ヶヵ0-9０-９]+)[(（]([ぁ-ゖゝゞァ-ヺーヽヾ]+)[)）]/gu;

/**
 * Readings the lyrics already carry in brackets after a kanji run.  They are
 * the lyricist's own — 終幕(さいご) is a reading no dictionary or model could
 * know — so they override whatever the model says.  `hideEnd` marks the end
 * of the bracketed text, which is not drawn while furigana is on.
 */
export function inlineReadings(line) {
  const out = [];
  for (const match of String(line || '').matchAll(INLINE_RE)) {
    if (!HAS_KANJI_RE.test(match[1])) continue;
    const start = match.index;
    const end = start + match[1].length;
    out.push({ start, end, reading: match[2], hideEnd: start + match[0].length });
  }
  return out;
}

/**
 * Lay the lyrics' own readings over the model's.  Either side may be
 * missing: a line the model failed still gets its printed readings.
 */
export function mergeInlineReadings(line, annotations) {
  const inline = inlineReadings(line);
  if (inline.length === 0) return annotations;
  const base = (annotations || []).filter((a) => !inline.some((i) => i.start === a.start));
  return [...base, ...inline].sort((x, y) => x.start - y.start);
}

// ── Prompt and reply ──

// Kana after a run that goes to the model along with it, so it reads a
// natural piece (全てが, not 全).  Capped so a long kana tail is not copied
// out in full.
const SUFFIX_KANA_MAX = 4;
const SUFFIX_RE = /^[ぁ-ゖゝゞァ-ヺーヽヾ]+/;

/**
 * What the model is asked to read for each run: the run plus up to four kana
 * written after it.  Asked for the reading of a run alone, models misjudged
 * where it ends — すべて for the 全 of 全て, おわ for the 終 of 終わり — on 1
 * run in 23 (gemini-3.5-flash-lite) and 1 in 93 (gemini-3.1-flash-lite) of
 * the answer key.  Asked for 全てが they write すべてが, a natural reading, and
 * the known tail is cut off here.  See stripSuffix.
 *
 * @returns {{line: string, runs: {text: string, suffix: string}[]}}
 */
export function furiganaEntry(line) {
  const text = String(line || '');
  return {
    line: text,
    runs: kanjiRuns(text).map((run) => ({
      text: run.text,
      suffix: (text.slice(run.end).match(SUFFIX_RE)?.[0] || '').slice(0, SUFFIX_KANA_MAX),
    })),
  };
}

/**
 * The instruction sent with every request.  Exported so the Worker and the
 * evaluation (tests/eval_furigana_live.mjs) send exactly the same prompt.
 * The examples are deliberately words absent from the answer key.
 *
 * @param {ReturnType<typeof furiganaEntry>[]} entries
 */
export function buildFuriganaPrompt(entries) {
  const n = entries.length;
  const listed = entries
    .map((e, i) => `${i + 1}. ${e.line}\n   pieces: ${e.runs.map((r) => r.text + r.suffix).join(' | ')}`)
    .join('\n');
  return `These are ${n} lines of Japanese song lyrics. Under each line is a list of pieces taken from it. Write how each piece is read, in the order listed.

Rules:
- Return one entry for each of the ${n} lines, in order: the line's number, then one reading for each of its pieces — for line 1 with pieces 静かに | 読んだ, ["1", "しずかに", "よんだ"].
- Write each piece's whole reading in hiragana, including the kana that is part of the piece: 静かに → しずかに, 読んだ → よんだ.
- Katakana in a piece is written in hiragana too.
- Read each piece the way it is sung in that line, using the words around it. The same kanji can read differently in different lines.
- Digits are read the way they are said (8匹で → はっぴきで).
- No romaji, no punctuation, no explanations.

Lines:
${listed}`;
}

// Each entry starts with its line's number, so a line the model leaves out
// costs only that line: with a bare list, gemini-3.5-flash-lite returned 24
// entries for 25 lines and nothing after the gap could be paired with its
// line.  The number goes first in the same list of strings rather than in
// an object — {line, readings} objects roughly doubled what the model had
// to write, and gemini-3.1-flash-lite then ran past the 20s timeout.
export const FURIGANA_RESPONSE_SCHEMA = {
  type: 'ARRAY',
  items: { type: 'ARRAY', items: { type: 'STRING' } },
};

/** The generateContent body for one chunk of lines. */
export function geminiFuriganaRequest(entries) {
  return {
    contents: [{ parts: [{ text: buildFuriganaPrompt(entries) }] }],
    generationConfig: {
      temperature: 0,
      responseMimeType: 'application/json',
      responseSchema: FURIGANA_RESPONSE_SCHEMA,
    },
  };
}

/** The JSON a generateContent reply carries, parsed.  Throws if there is none. */
export function geminiReplyJson(data) {
  const text = data?.candidates?.[0]?.content?.parts?.map((p) => p.text || '').join('') || '';
  if (!text) {
    const reason = data?.candidates?.[0]?.finishReason || data?.promptFeedback?.blockReason || 'empty';
    throw new Error(`Gemini returned no content (${reason})`);
  }
  return JSON.parse(text);
}

// Hiragana, katakana (a reading such as マジ can be meant as katakana), the
// long-vowel mark and the kana iteration marks.
const KANA_RE = /^[ぁ-ゖゝゞァ-ヺーヽヾ]+$/;

export function isKana(text) {
  return KANA_RE.test(text);
}

const toHiragana = (s) => s.replace(/[ァ-ヶ]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0x60));

// The particles は, へ and を are sung わ, え and お, and a model may write
// them as sung; either way the tail matches.
const foldTail = (s) => toHiragana(s).replace(/は/g, 'わ').replace(/へ/g, 'え').replace(/を/g, 'お');

/**
 * The reading of a run alone, from the model's reading of the run plus its
 * kana tail: すべてが with tail てが gives すべ.  Null when the reading does
 * not end with the tail, or nothing is left once it is cut — the model read
 * something other than what it was given.  Every fold keeps one character
 * per character, so cutting by the tail's length is exact.
 */
export function stripSuffix(reading, suffix) {
  if (!suffix) return reading || null;
  if (reading.length <= suffix.length) return null;
  const tail = reading.slice(reading.length - suffix.length);
  if (foldTail(tail) !== foldTail(suffix)) return null;
  return reading.slice(0, reading.length - suffix.length);
}

/**
 * Turn a model's reply into one reading per run.  Entries are matched to
 * lines by the number they carry, never by position, so a line the model
 * left out or numbered twice is null and the rest are still paired right.
 * A reply that answers no line at all throws, so the next model gets the
 * chunk.
 *
 * Within a line each run stands on its own: a reading that is not kana, or
 * does not end with the kana it was given, is null and the run simply goes
 * without furigana.  Models occasionally read past the piece they were
 * given — 一人で as ひとりでに — and that should cost one reading, not the
 * line.  A line with the wrong number of readings is null.
 *
 * @param {ReturnType<typeof furiganaEntry>[]} entries
 * @param {unknown} reply  parsed model output
 * @returns {((string|null)[]|null)[]}
 */
export function parseFuriganaReply(entries, reply) {
  if (!Array.isArray(reply)) throw new Error('furigana reply is not a list');

  const byLine = new Map();
  const repeated = new Set();
  for (const item of reply) {
    if (!Array.isArray(item) || !/^\s*\d+\s*$/.test(String(item[0]))) continue;
    const n = Number(item[0]);
    if (byLine.has(n)) repeated.add(n);
    byLine.set(n, item.slice(1));
  }

  const out = entries.map((entry, i) => {
    const readings = byLine.get(i + 1);
    if (repeated.has(i + 1) || !Array.isArray(readings) || readings.length !== entry.runs.length) return null;
    const line = readings.map((reading, k) => {
      const cleaned = typeof reading === 'string' ? reading.replace(/[\s　]/g, '') : '';
      return isKana(cleaned) ? stripSuffix(cleaned, entry.runs[k].suffix) : null;
    });
    return line.some(Boolean) ? line : null;
  });

  if (out.every((r) => r === null)) {
    throw new Error(`furigana reply answered none of ${entries.length} lines (${reply.length} entries)`);
  }
  return out;
}

/**
 * The page's check on what the Worker sends back: per line, one entry per
 * run, each a kana reading or null.  The Worker has already checked the
 * model's reply, but it may be an older deployment than the page, and the
 * check is cheap.
 *
 * @param {string[]} lines
 * @param {unknown} readings
 * @returns {((string|null)[]|null)[]}
 */
export function checkFuriganaReadings(lines, readings) {
  if (!Array.isArray(readings) || readings.length !== lines.length) {
    throw new Error(`furigana: ${Array.isArray(readings) ? readings.length : 'no'} entries for ${lines.length} lines`);
  }
  return lines.map((line, i) => {
    const r = readings[i];
    if (!Array.isArray(r) || r.length !== kanjiRuns(line).length) return null;
    const out = r.map((x) => (typeof x === 'string' && isKana(x) ? x : null));
    return out.some(Boolean) ? out : null;
  });
}

// ── Models ──

/**
 * Every model the Worker will run furigana on — the ones the evaluation has
 * measured.  Anything else is refused, so the Worker's key cannot be spent
 * on an arbitrary model.  Versions are pinned rather than `-latest`
 * aliases: gemini-flash-lite-latest moved to gemini-3.5-flash-lite, which
 * reads less accurately than the 3.1 it replaced.
 */
export const FURIGANA_ALLOWED_MODELS = ['gemini-3.1-flash-lite', 'gemini-3.5-flash-lite'];

/** The chain step that reads with kuromoji, in the browser, instead of a model. */
export const DICTIONARY_STEP = 'dictionary';

/**
 * Where readings come from, in order.  Each step fills only what the steps
 * before it left unread, word by word: 3.5 fills the words 3.1 could not
 * answer, and the dictionary fills whatever both models left.
 *
 * gemini-3.1-flash-lite read 99.7% of the answer key's runs correctly when
 * it was answering (tests/eval_furigana_live.mjs, see the README).  3.5
 * comes next: it reads less accurately but, like 3.1, from context, which
 * matters most for the words lyrics use — 二人 as ふたり, 側 as そば.  The
 * dictionary — kuromoji, which knows each word's usual reading but not its
 * context — is last: free, needing no quota, and once loaded never failing,
 * it covers lines both models left unread, and its ~18 MB download happens
 * only then.
 */
export const FURIGANA_CHAIN = ['gemini-3.1-flash-lite', 'gemini-3.5-flash-lite', DICTIONARY_STEP];

/** The models in the chain, in order; the first is the only one whose
 *  readings the Worker stores. */
export const FURIGANA_MODELS = FURIGANA_CHAIN.filter((step) => step !== DICTIONARY_STEP);

// One Gemini request reads at most this many lines; the Worker splits a song
// into chunks of this size and sends them together.  Kept to the size the
// translation models were verified at.
export const FURIGANA_CHUNK_LINES = 25;

// A request that has not answered by now is abandoned for the next step, so
// a stalled call cannot leave the button spinning.  The Worker gives each
// Gemini call a little less, so it can still answer with the chunks that
// did come back.
export const FURIGANA_TIMEOUT_MS = 20_000;
export const FURIGANA_GEMINI_TIMEOUT_MS = 17_000;

// The Worker refuses anything larger, so it cannot be used to run arbitrary
// long prompts against the key.  A song is one request; few songs have more
// than a hundred distinct lines with kanji.
export const FURIGANA_MAX_LINES = 200;
export const FURIGANA_MAX_LINE_CHARS = 300;

// ── Stored readings ──

// Bump to orphan every stored song, e.g. after a change to kanjiRuns that
// would pair stored readings with different runs.
export const FURIGANA_CACHE_VERSION = 1;

// Readings do not go stale, but a better model should eventually reach
// songs that were read before it.
export const FURIGANA_CACHE_TTL_S = 180 * 24 * 60 * 60;

/**
 * The key a song's readings are stored under: a hash of its distinct kanji
 * lines, in order.  It follows the text rather than a track id, because the
 * same track can arrive with different lyrics from different sources, and
 * readings stored for one text would not fit another.
 */
export async function furiganaCacheKey(lines) {
  const bytes = new TextEncoder().encode(JSON.stringify(lines));
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
  const hex = [...digest].map((b) => b.toString(16).padStart(2, '0')).join('');
  return `furigana:v${FURIGANA_CACHE_VERSION}:${hex}`;
}

// ── Dictionary readings (kuromoji) ──

const KANA_RUN_RE = /[ぁ-ゖァ-ヺー]+|[^ぁ-ゖァ-ヺー]+/g;
const KANA_START_RE = /^[ぁ-ゖァ-ヺー]/;
const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * Split a token's reading over its surface: 取り扱い read とりあつかい gives
 * 取=と and 扱=あつか.  Null when the kana in the surface cannot be found in
 * the reading.
 */
function alignToken(surface, reading) {
  const parts = surface.match(KANA_RUN_RE) || [];
  const pattern = parts.map((p) => (KANA_START_RE.test(p) ? escapeRe(toHiragana(p)) : '(.+?)')).join('');
  const m = reading.match(new RegExp(`^${pattern}$`));
  if (!m) return null;
  const blocks = [];
  let offset = 0;
  let group = 1;
  for (const p of parts) {
    if (!KANA_START_RE.test(p)) blocks.push({ offset, length: p.length, reading: m[group++] });
    offset += p.length;
  }
  return blocks;
}

/**
 * A dictionary's reading of each kanji run in a line, from kuromoji's tokens
 * for it (`{surface_form, reading}`), with null for a run it cannot read —
 * a word it does not know, or a run whose tokens do not line up with it.
 * A run can span tokens (二人今 is three), and a token can hold several runs
 * (取り扱い holds two).
 *
 * @param {{surface_form: string, reading?: string}[]} tokens
 * @param {string} line
 * @returns {(string|null)[]}
 */
export function dictionaryReadings(tokens, line) {
  const blocks = [];
  let pos = 0;
  for (const t of tokens) {
    const surface = t.surface_form;
    const start = pos;
    pos += surface.length;
    if (!hasKanji(surface) && !/[0-9０-９]/.test(surface)) continue;
    const reading = t.reading && t.reading !== '*' ? toHiragana(t.reading) : null;
    const aligned = reading ? alignToken(surface, reading) : null;
    if (!aligned) continue;
    for (const b of aligned) blocks.push({ start: start + b.offset, end: start + b.offset + b.length, reading: b.reading });
  }

  return kanjiRuns(line).map((run) => {
    let cursor = run.start;
    let reading = '';
    for (const b of blocks) {
      if (b.end <= run.start || b.start >= run.end) continue;
      if (b.start !== cursor || b.end > run.end) return null;
      reading += b.reading;
      cursor = b.end;
    }
    return cursor === run.end && reading && isKana(reading) ? reading : null;
  });
}

// ── Client: fetching through the Worker ──

/**
 * Only lines with kanji are sent, and a line repeated across a chorus is
 * sent once.  Returns those lines plus each original line's slot in them
 * (-1 for a line with nothing to read).
 */
export function planFurigana(lines) {
  const unique = [];
  const indexOfLine = new Map();
  const slots = lines.map((line) => {
    const text = String(line || '');
    if (!hasKanji(text)) return -1;
    if (!indexOfLine.has(text)) {
      indexOfLine.set(text, unique.length);
      unique.push(text);
    }
    return indexOfLine.get(text);
  });
  return { unique, slots };
}

/** Pair each run of a line with its reading: `[{start, end, reading}]`.
 *  A run with no reading is left out. */
export function annotate(line, readings) {
  return kanjiRuns(line)
    .map((run, i) => ({ start: run.start, end: run.end, reading: readings[i] }))
    .filter((a) => a.reading);
}

/** One Worker request: readings for up to FURIGANA_MAX_LINES lines. */
async function requestLines(lines, model, workerUrl) {
  const resp = await fetch(`${workerUrl}/furigana`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ lines, model }),
    signal: AbortSignal.timeout(FURIGANA_TIMEOUT_MS),
  });
  // 501: the Worker has no Gemini key.  404: it is an older deployment
  // without this route.  Either way no model step can work, so the chain
  // goes straight to the dictionary rather than asking the next model.
  if (resp.status === 501 || resp.status === 404) {
    const err = new Error(resp.status === 501 ? 'furigana: Worker has no Gemini key' : 'furigana: Worker has no /furigana route');
    err.unconfigured = true;
    throw err;
  }
  if (!resp.ok) {
    const detail = await resp.json().then((d) => d?.error || '', () => '');
    const err = new Error(`furigana HTTP ${resp.status}${detail ? `: ${detail}` : ''}`);
    // 429 and 503 are the model being busy, not wrong.
    err.transient = resp.status === 429 || resp.status === 503;
    throw err;
  }
  const data = await resp.json();
  return { readings: checkFuriganaReadings(lines, data?.readings), cached: Boolean(data?.cached) };
}

/** A model's readings for these lines, in as many requests as the Worker's
 *  line limit needs (one, for any ordinary song). */
async function requestReadings(lines, model, workerUrl) {
  const parts = [];
  for (let i = 0; i < lines.length; i += FURIGANA_MAX_LINES) parts.push(lines.slice(i, i + FURIGANA_MAX_LINES));
  const replies = await Promise.all(parts.map((part) => requestLines(part, model, workerUrl)));
  return { readings: replies.flatMap((r) => r.readings), cached: replies.every((r) => r.cached) };
}

/**
 * Furigana for every line, as an array the same length as `lines`: for each
 * line its annotations (`[]` when it has no kanji), or null when no reading
 * could be had for it.  Returns null when nothing came back at all, leaving
 * the lyrics as they are.
 *
 * The song's distinct kanji lines go through FURIGANA_CHAIN in order, and
 * each step is asked only about lines that still have an unread word, and
 * may only fill those words: 3.5 never overrides 3.1, and the dictionary
 * never overrides either.  A model step is one request for the whole
 * song — the Worker looks up the stored readings first, and otherwise reads
 * the song's chunks together.  The dictionary step calls
 * `readWithDictionary(lines)`, which resolves to each line's readings in
 * kanjiRuns order (see dictionaryReadings); without it the step is skipped.
 * Readings the lyrics carry in brackets are laid over the result.
 *
 * `onStep` reports each step that ran — `{step, lines, ok, filled,
 * filledRuns: [{line, run}], cached, ms, error, transient}` — for the
 * evaluation; the app does not use it.
 *
 * @param {string[]} lines
 * @param {{workerUrl?: string, chain?: string[],
 *          readWithDictionary?: (lines: string[]) => Promise<(string|null)[][]>,
 *          onStep?: Function}} options
 */
export async function fetchFurigana(lines, options) {
  const { workerUrl, chain = FURIGANA_CHAIN, readWithDictionary, onStep } = options || {};
  if (!Array.isArray(lines) || lines.length === 0) return null;

  const { unique, slots } = planFurigana(lines);
  if (unique.length === 0) return lines.map(() => []);

  // Per distinct line, per kanji run: a reading, or null while unread.
  const readings = unique.map((line) => kanjiRuns(line).map(() => null));
  const unread = () => unique.map((_, i) => i).filter((i) => readings[i].includes(null));
  let workerUsable = Boolean(workerUrl);

  for (const step of chain) {
    const todo = unread();
    if (todo.length === 0) break;
    const isDictionary = step === DICTIONARY_STEP;
    if (isDictionary ? !readWithDictionary : !workerUsable) continue;

    const t0 = Date.now();
    const asked = todo.map((i) => unique[i]);
    try {
      let got;
      let cached = false;
      if (isDictionary) {
        got = await readWithDictionary(asked);
      } else {
        ({ readings: got, cached } = await requestReadings(asked, step, workerUrl));
      }
      const filledRuns = [];
      todo.forEach((i, k) => {
        const line = got?.[k];
        if (!Array.isArray(line) || line.length !== readings[i].length) return;
        line.forEach((r, j) => {
          if (readings[i][j] === null && typeof r === 'string' && isKana(r)) {
            readings[i][j] = r;
            filledRuns.push({ line: unique[i], run: j });
          }
        });
      });
      onStep?.({ step, lines: todo.length, ok: true, filled: filledRuns.length, filledRuns, cached, ms: Date.now() - t0 });
    } catch (err) {
      console.debug(`[furigana] ${step} failed:`, err.message);
      onStep?.({ step, lines: todo.length, ok: false, filled: 0, ms: Date.now() - t0,
        error: err.message, transient: Boolean(err.transient) });
      // No key on the Worker: no model step can work, but the dictionary can.
      if (err.unconfigured) workerUsable = false;
    }
  }

  const result = lines.map((line, i) => {
    const slot = slots[i];
    if (slot < 0) return [];
    const merged = mergeInlineReadings(line, annotate(line, readings[slot]));
    return merged && merged.length > 0 ? merged : null;
  });
  return result.some((r) => r && r.length > 0) ? result : null;
}

// ── Layout ──

/**
 * A line as alternating plain text and ruby: `[{text}, {text, reading}, …]`.
 * Joining every `text` gives back the line, less any bracketed reading the
 * lyrics carried, which the ruby now shows instead.
 */
export function furiganaSegments(line, annotations) {
  const text = String(line || '');
  const segments = [];
  let cursor = 0;
  for (const a of annotations || []) {
    if (a.start < cursor || a.end > text.length) continue;
    if (a.start > cursor) segments.push({ text: text.slice(cursor, a.start) });
    segments.push({ text: text.slice(a.start, a.end), reading: a.reading });
    cursor = a.hideEnd || a.end;
  }
  if (cursor < text.length) segments.push({ text: text.slice(cursor) });
  return segments;
}

/**
 * Lay furigana over a word-synced line, whose text is split into timed
 * pieces (Spotify's syllables) that the karaoke highlight walks.  Pieces are
 * located in the line in order; a piece is cut wherever a run starts or ends
 * inside it, and the cuts keep their piece's index so they keep its timing.
 *
 * Returns a list of groups — `{fragments}` for plain text, or
 * `{fragments, reading}` for one ruby, whose fragments may come from more
 * than one piece when a run straddles them — or null when the pieces cannot
 * be found in the line, in which case the line is drawn without furigana.
 *
 * @param {string} line
 * @param {string[]} pieces
 * @param {{start: number, end: number, reading: string}[]} annotations
 */
export function layoutWordFurigana(line, pieces, annotations) {
  const text = String(line || '');
  const spans = [];
  let cursor = 0;
  for (const piece of pieces) {
    const at = text.indexOf(piece, cursor);
    if (at < 0 || piece === '') return null;
    spans.push({ start: at, end: at + piece.length });
    cursor = at + piece.length;
  }

  // A run that falls partly outside every piece (in a gap the pieces do not
  // cover) cannot be drawn whole, so it goes without a reading.
  const covered = (start, end) => {
    let pos = start;
    for (const s of spans) {
      if (s.end <= pos) continue;
      if (s.start > pos) return false;
      pos = s.end;
      if (pos >= end) return true;
    }
    return false;
  };
  const usable = (annotations || []).filter((a) => covered(a.start, a.end));
  // The bracketed reading after a run, which the ruby replaces.
  const hidden = usable.filter((a) => a.hideEnd > a.end).map((a) => ({ start: a.end, end: a.hideEnd }));

  const groups = [];
  spans.forEach((span, pieceIndex) => {
    const cuts = new Set([span.start, span.end]);
    const inside = (p) => p > span.start && p < span.end;
    for (const a of usable) {
      if (inside(a.start)) cuts.add(a.start);
      if (inside(a.end)) cuts.add(a.end);
    }
    for (const h of hidden) {
      if (inside(h.start)) cuts.add(h.start);
      if (inside(h.end)) cuts.add(h.end);
    }
    const points = [...cuts].sort((x, y) => x - y);
    for (let k = 0; k < points.length - 1; k++) {
      const start = points[k];
      const end = points[k + 1];
      if (hidden.some((h) => start >= h.start && end <= h.end)) continue;
      const fragment = { pieceIndex, text: text.slice(start, end), lastOfPiece: end === span.end };
      const run = usable.find((a) => start >= a.start && end <= a.end);
      const last = groups[groups.length - 1];
      if (run && last?.run === run) {
        last.fragments.push(fragment);
      } else if (run) {
        groups.push({ run, reading: run.reading, fragments: [fragment] });
      } else {
        groups.push({ fragments: [fragment] });
      }
    }
  });

  // A piece's last visible fragment is where its trailing space goes; a
  // hidden bracket may have been its true last.
  const all = groups.flatMap((g) => g.fragments);
  all.forEach((f, i) => { f.lastOfPiece = i === all.length - 1 || all[i + 1].pieceIndex !== f.pieceIndex; });

  return groups.map(({ fragments, reading }) => (reading ? { fragments, reading } : { fragments }));
}
