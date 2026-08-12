// ============================================================
//  Lyrics translation — shared by app.js (browser),
//  worker/worker.js (Cloudflare Worker) and the CLI tests.
//
//  Providers, chosen from the UI:
//    'free'  — translate.googleapis.com, no key, called straight from the
//              browser (it sends Access-Control-Allow-Origin: *).
//    'cloud' — Google Cloud Translation v2 through the Worker, which holds
//              the API key.  A static site cannot keep a key secret.
//    LLM     — one model per entry, also through the Worker.  These translate
//              the whole song in one prompt, so recurring imagery and idiom
//              stay consistent in a way per-line machine translation cannot
//              manage.  Listed by model name so they can be compared directly.
// ============================================================

export const TRANSLATE_TARGETS = ['en', 'zh'];

/**
 * Every model here was measured translating 44 unique lines, chunked, before
 * being listed: all returned one translation per line on repeated runs.
 * Latencies are for a whole song and vary with load.
 */
export const TRANSLATE_PROVIDERS = [
  { id: 'free', label: 'Default' },
  { id: 'cloud', label: 'Better' },
  { id: 'gemini-flash-lite-latest', label: 'gemini-flash-lite-latest',
    llm: { backend: 'gemini', model: 'gemini-flash-lite-latest' } },
  { id: 'gemini-3.5-flash-lite', label: 'gemini-3.5-flash-lite',
    llm: { backend: 'gemini', model: 'gemini-3.5-flash-lite' } },
  { id: 'gemini-3.1-flash-lite', label: 'gemini-3.1-flash-lite',
    llm: { backend: 'gemini', model: 'gemini-3.1-flash-lite' } },
  { id: 'gemini-flash-latest', label: 'gemini-flash-latest',
    llm: { backend: 'gemini', model: 'gemini-flash-latest' } },
  { id: 'nemotron-3-super-120b', label: 'nemotron-3-super-120b:free',
    llm: { backend: 'openrouter', model: 'nvidia/nemotron-3-super-120b-a12b:free' } },
];

export const DEFAULT_PROVIDER = 'free';

export function findProvider(id) {
  return TRANSLATE_PROVIDERS.find((p) => p.id === id) || null;
}

/** Unknown ids fall back to the keyless provider rather than failing. */
export function normalizeProvider(id) {
  return findProvider(id) ? id : DEFAULT_PROVIDER;
}

// ── Language detection ──
//
// The button has to appear (or not) before anything is sent, so the language
// is decided locally rather than by asking a translation API to detect it.

// Kana is checked before Han: Japanese uses both, Chinese only Han.
const SCRIPT_PATTERNS = [
  ['ja', /[\u3040-\u309f\u30a0-\u30ff]/],
  ['ko', /[\uac00-\ud7af\u1100-\u11ff]/],
  ['zh', /[\u3400-\u9fff\uf900-\ufaff]/],
  ['ru', /[\u0400-\u04ff]/],
  ['el', /[\u0370-\u03ff]/],
  ['he', /[\u0590-\u05ff]/],
  ['ar', /[\u0600-\u06ff]/],
  ['th', /[\u0e00-\u0e7f]/],
  ['hi', /[\u0900-\u097f]/],
];

// Function words that are common in English and rare or absent in the other
// Latin-script languages a listener is likely to meet.  Deliberately no
// content words, and none of the words English shares with Spanish, French,
// German or Italian ("me", "a", "no", "in", "so", "son", "the" is safe).
const ENGLISH_MARKERS = new Set([
  'the', 'and', 'you', 'your', 'that', "that's", 'this', 'is', "it's", 'of',
  'to', 'with', 'but', 'not', 'are', 'was', 'were', 'have', 'has', 'had',
  'what', 'when', 'where', 'why', 'how', 'they', 'them', 'their', 'there',
  'would', 'could', 'should', 'been', 'from', "i'm", "don't", "can't",
  "won't", "didn't", 'know', 'just', 'like', 'about', 'all', 'we', 'she',
  'he', 'him', 'her', 'his', 'our', 'who', 'into', 'over', 'down', 'away',
  'never', 'always', 'every', 'something', 'nothing', 'everything', 'because',
  'through', 'again', 'only', 'these', 'those', 'been', 'will', 'want',
]);

// Latin-script lyrics need this share of tokens to be English markers before
// the language counts as English.  English lyrics land far above it and other
// Latin-script languages far below, so the exact value is not delicate.
const ENGLISH_MARKER_RATIO = 0.08;
const MIN_TOKENS_FOR_ENGLISH_CHECK = 6;

const LATIN_PATTERN = /[a-z\u00c0-\u024f]/i;

/**
 * Best-effort language of a block of lyrics.  Returns an ISO 639-1 code, or
 * 'und' for Latin-script text that is clearly not English but whose actual
 * language needs a real detector — the translation APIs auto-detect the
 * source anyway, so 'und' is enough to decide whether to offer the button.
 * Returns '' when there is nothing to judge.
 *
 * @param {string} sample  lyrics text (or a representative slice of it)
 * @param {string} [declaredLanguage]  language reported by the source, if any
 */
export function detectLyricsLanguage(sample, declaredLanguage) {
  if (declaredLanguage) return declaredLanguage.toLowerCase().split(/[-_]/)[0];
  if (!sample || !sample.trim()) return '';

  for (const [code, pattern] of SCRIPT_PATTERNS) {
    if (pattern.test(sample)) return code;
  }

  if (!LATIN_PATTERN.test(sample)) return '';

  const tokens = sample.toLowerCase().match(/[a-z\u00c0-\u024f']+/g) || [];
  if (tokens.length < MIN_TOKENS_FOR_ENGLISH_CHECK) return '';

  const markers = tokens.filter((t) => ENGLISH_MARKERS.has(t)).length;
  return markers / tokens.length >= ENGLISH_MARKER_RATIO ? 'en' : 'und';
}

/** Translation is offered for anything that isn't already English or Chinese. */
export function shouldOfferTranslation(language) {
  return Boolean(language) && language !== 'en' && language !== 'zh';
}

// ── Shared helpers ──

// Google wants a region for Chinese; the app renders Simplified throughout.
export function googleTargetCode(target) {
  return target === 'zh' ? 'zh-CN' : 'en';
}

/**
 * Translate only what needs translating: blank lines are skipped, and a line
 * repeated across a chorus is sent once.  Returns the unique non-blank texts
 * plus a mapping back onto the original line positions.
 */
export function planTranslation(lines) {
  const unique = [];
  const indexOfText = new Map();
  const slots = lines.map((line) => {
    const text = (line || '').trim();
    if (!text) return -1;
    if (!indexOfText.has(text)) {
      indexOfText.set(text, unique.length);
      unique.push(text);
    }
    return indexOfText.get(text);
  });
  return { unique, slots };
}

/** Scatter translated unique texts back onto the original line positions. */
export function applyTranslationPlan(slots, translated) {
  return slots.map((slot) => (slot < 0 ? '' : translated[slot] || ''));
}

// Google Cloud sometimes HTML-escapes punctuation even with format:text.
export function decodeHtmlEntities(text) {
  if (!text || !text.includes('&')) return text;
  return text
    .replace(/&#(\d+);/g, (_, code) => String.fromCharCode(Number(code)))
    .replace(/&#x([0-9a-f]+);/gi, (_, code) => String.fromCharCode(parseInt(code, 16)))
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&');
}

// ── Provider: keyless Google, called direct from the browser ──

const GOOGLE_FREE_ENDPOINT = 'https://translate.googleapis.com/translate_a/single';

// The whole batch travels in the query string, so chunks stay well inside
// practical URL limits.
const FREE_CHUNK_CHARS = 1400;

function chunkByChars(texts, maxChars) {
  const chunks = [];
  let current = [];
  let size = 0;
  for (const text of texts) {
    if (current.length > 0 && size + text.length + 1 > maxChars) {
      chunks.push(current);
      current = [];
      size = 0;
    }
    current.push(text);
    size += text.length + 1;
  }
  if (current.length > 0) chunks.push(current);
  return chunks;
}

/**
 * One keyless request.  The response splits the text by sentence rather than
 * by line, but the segments concatenate back into the translated text with
 * its newlines intact, so splitting on newline recovers the lines.  A count
 * that doesn't match means the split moved and the result cannot be trusted.
 */
async function translateChunkFree(texts, target) {
  const url = `${GOOGLE_FREE_ENDPOINT}?client=gtx&sl=auto&tl=${encodeURIComponent(googleTargetCode(target))}`
    + `&dt=t&q=${encodeURIComponent(texts.join('\n'))}`;

  const resp = await fetch(url, { headers: { Accept: 'application/json' } });
  if (!resp.ok) throw new Error(`google-free HTTP ${resp.status}`);

  const data = await resp.json();
  const segments = data?.[0];
  if (!Array.isArray(segments)) throw new Error('google-free: unexpected response shape');

  const joined = segments.map((s) => (s && s[0]) || '').join('');
  const lines = joined.split('\n');
  if (lines.length !== texts.length) return null;
  return lines.map((l) => l.trim());
}

/**
 * Translate a batch, halving any chunk whose lines come back misaligned so a
 * bad split costs a few extra requests instead of silently pairing every
 * later line with the wrong translation.
 */
async function translateBatchFree(texts, target) {
  const out = await translateChunkFree(texts, target);
  if (out) return out;
  if (texts.length === 1) return [''];

  const mid = Math.ceil(texts.length / 2);
  const [left, right] = await Promise.all([
    translateBatchFree(texts.slice(0, mid), target),
    translateBatchFree(texts.slice(mid), target),
  ]);
  return [...left, ...right];
}

async function translateViaFree(texts, target) {
  const results = [];
  for (const chunk of chunkByChars(texts, FREE_CHUNK_CHARS)) {
    results.push(...(await translateBatchFree(chunk, target)));
  }
  return results;
}

// ── Provider: Google Cloud Translation v2, through the Worker ──

async function translateViaWorker(texts, target, workerUrl) {
  if (!workerUrl) throw new Error('cloud provider needs a Worker URL');

  const resp = await fetch(`${workerUrl}/translate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ lines: texts, target }),
  });
  if (!resp.ok) throw new Error(`worker translate HTTP ${resp.status}`);

  const data = await resp.json();
  if (!Array.isArray(data?.translations) || data.translations.length !== texts.length) {
    throw new Error('worker translate: misaligned response');
  }
  return data.translations;
}

// ── Provider: an LLM, through the Worker ──

// Models grow unreliable on long lists — one dropped 12 of 44 lines, always
// stopping at exactly 32 — so requests are kept to a size every tested model
// handled with one translation per line on repeated runs.
export const LLM_CHUNK_LINES = 25;

/**
 * The instruction sent with every LLM request.  Exported so the Worker builds
 * exactly the prompt these models were verified against.
 */
export function buildTranslationPrompt(lines, target) {
  const language = target === 'zh' ? 'Simplified Chinese' : 'English';
  const numbered = lines.map((line, i) => `${i + 1}. ${line}`).join('\n');
  return `Translate each of the following ${lines.length} song lyric lines into ${language}.

Rules:
- Return exactly ${lines.length} translations, one per input line, in the same order.
- Never merge, split, add or drop lines.
- Translate the line only: no commentary, no numbering, no notes.
- Keep the register and imagery of the original; these are song lyrics, not prose.
- If a line cannot be translated, repeat it unchanged.

Lines:
${numbered}`;
}

function chunkByCount(texts, size) {
  const chunks = [];
  for (let i = 0; i < texts.length; i += size) chunks.push(texts.slice(i, i + size));
  return chunks;
}

/**
 * Chunks are translated one at a time rather than in parallel: the free tiers
 * rate-limit bursts, and a whole song is only two or three requests.
 */
async function translateViaLlm(texts, target, provider, workerUrl) {
  if (!workerUrl) throw new Error('LLM providers need a Worker URL');

  const results = [];
  for (const chunk of chunkByCount(texts, LLM_CHUNK_LINES)) {
    const resp = await fetch(`${workerUrl}/llm-translate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ lines: chunk, target, provider }),
    });
    if (!resp.ok) throw new Error(`llm translate HTTP ${resp.status}`);

    const data = await resp.json();
    if (!Array.isArray(data?.translations) || data.translations.length !== chunk.length) {
      throw new Error(`llm translate: misaligned chunk (${data?.translations?.length}/${chunk.length})`);
    }
    results.push(...data.translations);
  }
  return results;
}

// ── Entry point ──

/**
 * Translate lyrics lines, returning an array the same length as the input so
 * translations can be paired with their originals by index.  Blank lines come
 * back blank.  Returns null if the provider fails, leaving the caller showing
 * the original lyrics alone.
 *
 * @param {string[]} lines
 * @param {{target: string, provider: string, workerUrl?: string}} options
 */
export async function translateLines(lines, { target, provider, workerUrl }) {
  if (!Array.isArray(lines) || lines.length === 0) return null;

  const { unique, slots } = planTranslation(lines);
  if (unique.length === 0) return null;

  const chosen = findProvider(provider);

  try {
    let translated;
    if (chosen?.llm) {
      translated = await translateViaLlm(unique, target, chosen.id, workerUrl);
    } else if (chosen?.id === 'cloud') {
      translated = await translateViaWorker(unique, target, workerUrl);
    } else {
      translated = await translateViaFree(unique, target);
    }
    return applyTranslationPlan(slots, translated.map(decodeHtmlEntities));
  } catch (err) {
    console.debug('[translate] failed:', err.message);
    return null;
  }
}
