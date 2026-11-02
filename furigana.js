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

/**
 * Tried in order for each chunk, chosen by tests/eval_furigana_live.mjs
 * against the answer key in tests/furigana_gold.json (see the README):
 * 3.1 read 99.7% of the key's runs correctly, 3.5 96.3%, so 3.5 is only
 * the fallback for when 3.1 is busy or fails.
 */
export const FURIGANA_MODELS = ['gemini-3.1-flash-lite', 'gemini-3.5-flash-lite'];

// Kept to the size the translation models were verified at.
export const FURIGANA_CHUNK_LINES = 25;

// A request that has not answered by now is abandoned for the next model,
// so a stalled call cannot leave the button spinning.
export const FURIGANA_TIMEOUT_MS = 20_000;

// The Worker refuses anything larger, so it cannot be used to run arbitrary
// long prompts against the key.
export const FURIGANA_MAX_LINES = 40;
export const FURIGANA_MAX_LINE_CHARS = 300;

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

async function requestChunk(chunk, model, workerUrl) {
  const resp = await fetch(`${workerUrl}/furigana`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ lines: chunk, model }),
    signal: AbortSignal.timeout(FURIGANA_TIMEOUT_MS),
  });
  if (resp.status === 501) {
    const err = new Error('furigana: Worker has no Gemini key');
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
  return checkFuriganaReadings(chunk, data?.readings);
}

/**
 * Furigana for every line, as an array the same length as `lines`: for each
 * line its annotations (`[]` when it has no kanji), or null when no reading
 * could be had for it.  Returns null when nothing came back at all, leaving
 * the lyrics as they are.
 *
 * A song's chunks — two or three — go out together rather than in turn, so
 * the wait is one request, not three; each tries the models in order, so one
 * overloaded model costs a retry rather than the song.  A line the model got
 * wrong in shape stays null rather than being retried: the other lines of
 * its chunk are fine, and a partly annotated song is more use than a second
 * wait.  Readings the lyrics carry in brackets are laid over the model's,
 * and kept even for a line the model failed.
 *
 * `onChunk` reports each attempt — `{model, lines, ok, ms, error, transient}`
 * — for the evaluation; the app does not use it.
 *
 * @param {string[]} lines
 * @param {{workerUrl: string, models?: string[], onChunk?: Function}} options
 */
export async function fetchFurigana(lines, options) {
  const { workerUrl, models = FURIGANA_MODELS, onChunk } = options || {};
  if (!workerUrl || !Array.isArray(lines) || lines.length === 0) return null;

  const { unique, slots } = planFurigana(lines);
  if (unique.length === 0) return lines.map(() => []);

  const readings = new Array(unique.length).fill(null);
  let unconfigured = false;

  const runChunk = async (start) => {
    const chunk = unique.slice(start, start + FURIGANA_CHUNK_LINES);
    for (const model of models) {
      if (unconfigured) return;
      const t0 = Date.now();
      try {
        const got = await requestChunk(chunk, model, workerUrl);
        got.forEach((r, i) => { readings[start + i] = r; });
        onChunk?.({ model, lines: chunk.length, ok: true, ms: Date.now() - t0 });
        return;
      } catch (err) {
        console.debug(`[furigana] ${model} failed:`, err.message);
        onChunk?.({ model, lines: chunk.length, ok: false, ms: Date.now() - t0, error: err.message, transient: Boolean(err.transient) });
        if (err.unconfigured) { unconfigured = true; return; }
      }
    }
  };

  const starts = [];
  for (let start = 0; start < unique.length; start += FURIGANA_CHUNK_LINES) starts.push(start);
  await Promise.all(starts.map(runChunk));
  if (unconfigured) return null;

  const result = lines.map((line, i) => {
    const slot = slots[i];
    if (slot < 0) return [];
    const merged = mergeInlineReadings(line, readings[slot] ? annotate(line, readings[slot]) : null);
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
