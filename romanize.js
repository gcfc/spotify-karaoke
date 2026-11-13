// ============================================================
//  Romanization for Greek, Hindi, Thai, Arabic and Hebrew lyrics —
//  shared by app.js (browser), worker/worker.js (Cloudflare Worker) and
//  the tests.
//
//  As with furigana, the lyrics are split into words here, locally, and a
//  model is asked only for one romanization per word.  It never writes the
//  lyric text back, so it cannot alter it: a reply has the right number of
//  romanizations for a line, or the line is dropped.  Each word's
//  romanization is drawn under that word, so word-synced highlighting keeps
//  working, and right-to-left lines keep each word's romanization under it.
//
//  Spelling is the singer-friendly kind people type: plain letters, no
//  accents or tone marks — "pyaar", "habibi", "sawasdee".
//
//  Greek is spelled as it sounds, almost letter by letter, so it is
//  romanized by rules (romanizeGreekWord), in the browser, with no model.
//  Hindi asks the models first and falls back to rules (romanizeHindiWord);
//  Thai, Arabic and Hebrew leave too much unwritten — Thai has no spaces and
//  unwritten vowels, Arabic and Hebrew rarely write their short vowels — for
//  rules to recover, so they use the models only.
// ============================================================

// ── Which lyrics ──

/** The scripts romanized, by font group (fontGroupFor in fonts.js). */
export const ROMAN_SCRIPTS = Object.freeze({
  el: /\p{Script=Greek}/u,
  hi: /\p{Script=Devanagari}/u,
  th: /\p{Script=Thai}/u,
  ar: /\p{Script=Arabic}/u,
  he: /\p{Script=Hebrew}/u,
});

// The language the model is told the lyrics are in, by detected language,
// for each script; anything else in a script gets that script's first.
const LANGUAGE_NAMES = Object.freeze({
  el: { el: 'Greek' },
  hi: { hi: 'Hindi', mr: 'Marathi', ne: 'Nepali' },
  th: { th: 'Thai' },
  ar: { ar: 'Arabic', fa: 'Persian', ur: 'Urdu' },
  he: { he: 'Hebrew', yi: 'Yiddish' },
});

/** The language code to romanize lyrics of `group`'s script as: the
 *  detected `language` when it is one written in that script, else the
 *  script's main language.  Null for a script not romanized. */
export function romanLanguage(group, language) {
  const names = LANGUAGE_NAMES[group];
  if (!names) return null;
  const base = String(language || '').toLowerCase().split(/[-_]/)[0];
  return names[base] ? base : Object.keys(names)[0];
}

/** The script group of a romanization language ('hi' for Marathi …). */
export function romanScriptOf(language) {
  return Object.keys(LANGUAGE_NAMES).find((g) => LANGUAGE_NAMES[g][language]) || null;
}

export function romanLanguageName(language) {
  const group = romanScriptOf(language);
  return group ? LANGUAGE_NAMES[group][language] : null;
}

// ── Words ──

// A word: letters, marks and digits, with an apostrophe or Hebrew geresh
// inside or at its end (σ’αγαπώ, ג׳ורג׳).
const WORD_RE = /[\p{L}\p{M}\p{N}]+(?:['’׳״][\p{L}\p{M}\p{N}]*)*/gu;

let thaiSegmenter;
function segmentThai(text) {
  if (thaiSegmenter === undefined) {
    thaiSegmenter = typeof Intl !== 'undefined' && Intl.Segmenter ? new Intl.Segmenter('th', { granularity: 'word' }) : null;
  }
  if (!thaiSegmenter) return null;
  return [...thaiSegmenter.segment(text)].filter((s) => s.isWordLike).map((s) => ({ start: s.index, text: s.segment }));
}

/**
 * The words of a line that need romanizing — those with a letter of the
 * script — with their UTF-16 offsets: `[{start, end, text}]`.  Thai, written
 * without spaces, is split by the platform's dictionary (Intl.Segmenter);
 * where there is none, each run of Thai is one piece.  A Thai word's
 * dictionary split may differ between platforms, so the Worker sends back
 * the words it used rather than the page splitting again.
 */
export function romanWords(line, group) {
  const script = ROMAN_SCRIPTS[group];
  const text = String(line || '');
  if (!script) return [];
  const words = [];
  for (const m of text.matchAll(WORD_RE)) {
    if (!script.test(m[0])) continue;
    if (group === 'th') {
      const parts = segmentThai(m[0]);
      if (parts && parts.length > 0) {
        for (const p of parts) {
          if (script.test(p.text)) words.push({ start: m.index + p.start, end: m.index + p.start + p.text.length, text: p.text });
        }
        continue;
      }
    }
    words.push({ start: m.index, end: m.index + m[0].length, text: m[0] });
  }
  return words;
}

export function hasRomanWords(line, group) {
  return romanWords(line, group).length > 0;
}

// ── Checking a romanization ──

/**
 * A romanization as drawn: accents and tone marks removed (a model may add
 * them despite being asked not to), lowercase kept as written, and only
 * letters, apostrophes and hyphens inside.  Null when nothing usable is
 * left, or when it is not in Latin letters at all.
 */
export function cleanRomanization(value) {
  if (typeof value !== 'string') return null;
  const plain = value.normalize('NFD').replace(/\p{M}/gu, '').replace(/[ʻʼʾʿ‘]/g, "'").replace(/\s+/g, ' ').trim()
    .replace(/^['’]+|['’]+$/g, '');
  if (!plain || plain.length > 60) return null;
  return /^[A-Za-z](?:[A-Za-z'’\- ]*[A-Za-z'])?$/.test(plain) ? plain : null;
}

// ── Greek rules ──

const GREEK = { α: 'a', β: 'v', γ: 'g', δ: 'd', ε: 'e', ζ: 'z', η: 'i', θ: 'th', ι: 'i', κ: 'k', λ: 'l', μ: 'm',
  ν: 'n', ξ: 'x', ο: 'o', π: 'p', ρ: 'r', σ: 's', ς: 's', τ: 't', υ: 'i', φ: 'f', χ: 'h', ψ: 'ps', ω: 'o' };
const GREEK_VOWEL = new Set('αεηιουω');
const GREEK_VOICELESS = new Set('θκξπστφχψς');
const GREEK_DIGRAPH_VOWEL = { αι: 'e', ει: 'i', οι: 'i', υι: 'i', ου: 'ou' };

/**
 * A Greek word as it sounds, in plain letters: καλημέρα → kalimera,
 * ευχαριστώ → efharisto, μπαμπάς → babas, γιατί → yati.  Pairs of vowels
 * that make one sound are written as that sound unless a diaeresis or an
 * accent on the first splits them (νεράιδα → neraida).
 */
export function romanizeGreekWord(word) {
  const letters = [];
  for (const ch of String(word || '')) {
    const nfd = ch.normalize('NFD');
    const base = nfd[0];
    const lower = base.toLowerCase();
    letters.push({ ch, base: lower, upper: base !== lower, acute: /[́́]/.test(nfd), dia: /̈/.test(nfd) });
  }
  const at = (i) => letters[i] || { base: '' };
  // Two letters that sound as one: not when the second has a diaeresis or the first carries the accent.
  const joins = (i) => !at(i + 1).dia && !at(i).acute;
  const frontVowelAt = (i) => {
    const a = at(i).base;
    const b = at(i + 1).base;
    return a === 'ε' || a === 'η' || a === 'ι' || a === 'υ' || ((a === 'α' || a === 'ο') && b === 'ι' && joins(i));
  };

  let out = '';
  for (let i = 0; i < letters.length; i++) {
    const { base } = letters[i];
    const next = at(i + 1).base;
    const pair = base + next;
    if (!GREEK[base]) {
      out += letters[i].ch;
      continue;
    }
    if (GREEK_DIGRAPH_VOWEL[pair] && joins(i)) {
      out += GREEK_DIGRAPH_VOWEL[pair];
      i++;
      continue;
    }
    if ((pair === 'αυ' || pair === 'ευ' || pair === 'ηυ') && joins(i)) {
      const after = at(i + 2).base;
      out += GREEK[base] + (!after || GREEK_VOICELESS.has(after) ? 'f' : 'v');
      i++;
      continue;
    }
    if (pair === 'γγ') { out += 'ng'; i++; continue; }
    if (pair === 'γκ') { out += i === 0 ? 'g' : 'ng'; i++; continue; }
    if (pair === 'γξ') { out += 'nx'; i++; continue; }
    if (pair === 'γχ') { out += 'nh'; i++; continue; }
    if (pair === 'μπ') { out += i === 0 ? 'b' : 'mb'; i++; continue; }
    if (pair === 'ντ') { out += i === 0 ? 'd' : 'nd'; i++; continue; }
    if (pair === 'τσ') { out += 'ts'; i++; continue; }
    if (pair === 'τζ') { out += 'tz'; i++; continue; }
    if (base === 'γ') {
      // γι and γει before a vowel are one sound, y: γιατί → yati, γεια → ya.
      if (next === 'ι' && !at(i + 1).acute && !at(i + 1).dia && GREEK_VOWEL.has(at(i + 2).base)) {
        out += 'y';
        i += 1;
        continue;
      }
      if (next === 'ε' && at(i + 2).base === 'ι' && joins(i + 1) && GREEK_VOWEL.has(at(i + 3).base)) {
        out += 'y';
        i += 2;
        continue;
      }
      out += frontVowelAt(i + 1) ? 'y' : 'g';
      continue;
    }
    out += GREEK[base];
  }
  return letters[0]?.upper ? out.charAt(0).toUpperCase() + out.slice(1) : out;
}

// ── Hindi rules ──

const DEV_CONSONANTS = {
  क: 'k', ख: 'kh', ग: 'g', घ: 'gh', ङ: 'n', च: 'ch', छ: 'chh', ज: 'j', झ: 'jh', ञ: 'n',
  ट: 't', ठ: 'th', ड: 'd', ढ: 'dh', ण: 'n', त: 't', थ: 'th', द: 'd', ध: 'dh', न: 'n', ऩ: 'n',
  प: 'p', फ: 'ph', ब: 'b', भ: 'bh', म: 'm', य: 'y', र: 'r', ऱ: 'r', ल: 'l', ळ: 'l', ऴ: 'l',
  व: 'v', श: 'sh', ष: 'sh', स: 's', ह: 'h',
};
// With a nukta — the sounds Urdu words bring: क़ q, ख़ kh, ग़ gh, ज़ z, फ़ f, and the flapped ड़ ढ़.
const DEV_NUKTA = { क: 'q', ख: 'kh', ग: 'gh', ज: 'z', झ: 'zh', ड: 'd', ढ: 'dh', फ: 'f', य: 'y' };
const DEV_PRECOMPOSED = { 'क़': 'क', 'ख़': 'ख', 'ग़': 'ग', 'ज़': 'ज', 'ड़': 'ड', 'ढ़': 'ढ', 'फ़': 'फ', 'य़': 'य' };
const DEV_VOWELS = { अ: 'a', आ: 'aa', इ: 'i', ई: 'ee', उ: 'u', ऊ: 'oo', ऋ: 'ri', ए: 'e', ऐ: 'ai', ओ: 'o', औ: 'au', ऑ: 'o', ऍ: 'e', ॠ: 'ri', ऌ: 'li' };
const DEV_MATRAS = { 'ा': 'aa', 'ि': 'i', 'ी': 'ee', 'ु': 'u', 'ू': 'oo', 'ृ': 'ri', 'ॄ': 'ri', 'े': 'e', 'ै': 'ai', 'ो': 'o', 'ौ': 'au', 'ॉ': 'o', 'ॅ': 'e' };
const DEV_LABIALS = new Set(['p', 'ph', 'b', 'bh', 'm', 'f']);
const VIRAMA = '्';
const NUKTA = '़';
const SCHWA = 'a*';   // the inherent vowel, which Hindi often does not say

// Spelled differently from how the rules would sound them out, and common in lyrics.
const HINDI_EXCEPTIONS = { हम: 'hum', ज्ञान: 'gyaan' };

/**
 * A Hindi word in the letters Bollywood lyrics are typed in: प्यार → pyaar,
 * ज़िंदगी → zindagi, धड़कन → dhadkan, नहीं → nahin.  Long vowels are doubled
 * inside a word and single at its end; the inherent "a" that Hindi does not
 * say is dropped (schwa deletion): at the end of a word, and between two
 * single consonants after a vowel, working from the right.
 */
export function romanizeHindiWord(word) {
  let text = String(word || '').normalize('NFC');
  if (HINDI_EXCEPTIONS[text]) return HINDI_EXCEPTIONS[text];
  for (const [composed, base] of Object.entries(DEV_PRECOMPOSED)) text = text.split(composed).join(base + NUKTA);
  text = text.split(`ज${VIRAMA}ञ`).join('ग्य');   // ज्ञ is said gy

  // Units: a consonant with its vowel (the inherent one, a matra, or none
  // after a virama), or a vowel on its own.  A nasal mark rides on its unit.
  const units = [];
  const chars = [...text];
  for (let i = 0; i < chars.length; i++) {
    const ch = chars[i];
    if (DEV_CONSONANTS[ch]) {
      let c = DEV_CONSONANTS[ch];
      if (chars[i + 1] === NUKTA) { c = DEV_NUKTA[ch] || c; i++; }
      let v = SCHWA;
      if (chars[i + 1] === VIRAMA) { v = ''; i++; } else if (DEV_MATRAS[chars[i + 1]]) { v = DEV_MATRAS[chars[i + 1]]; i++; }
      units.push({ c, v, nasal: false });
    } else if (DEV_VOWELS[ch]) {
      units.push({ c: '', v: DEV_VOWELS[ch], nasal: false });
    } else if (ch === 'ं' || ch === 'ँ') {
      const last = units[units.length - 1];
      if (last) { last.nasal = true; if (last.v === SCHWA) last.v = 'a'; }
    } else if (ch === 'ः') {
      units.push({ c: 'h', v: '', nasal: false });
    } else if (ch === 'ॐ') {
      units.push({ c: '', v: 'om', nasal: false });
    } else if (ch !== NUKTA && ch !== VIRAMA && ch !== '‌' && ch !== '‍') {
      units.push({ c: ch, v: '', nasal: false, raw: true });
    }
  }

  const vowelled = units.filter((u) => u.v).length;
  // The final inherent a goes, unless it is the word's only vowel (न is na)
  // or it ends a cluster closing in y, r, l or v, which would be unsayable
  // without it (मित्र is mitra, but इश्क़ is ishq and दर्द is dard).
  const last = units[units.length - 1];
  const afterCluster = units[units.length - 2]?.v === '';
  if (last && last.v === SCHWA && vowelled > 1 && !(afterCluster && ['y', 'r', 'l', 'v'].includes(last.c))) last.v = '';
  // Medial: V C a C V loses the a.  Not after a nasal (ज़िंदगी keeps
  // zindagi) or a cluster, and never two in a row.
  for (let i = units.length - 2; i >= 1; i--) {
    const u = units[i];
    const prev = units[i - 1];
    const next = units[i + 1];
    if (u.v === SCHWA && !u.nasal && u.c && prev.v && !prev.nasal && next.c && !next.raw && next.v) {
      u.v = '';
      i--;
    }
  }

  let out = '';
  units.forEach((u, i) => {
    const final = i === units.length - 1;
    let v = u.v === SCHWA ? 'a' : u.v;
    if (final && !u.nasal) v = { aa: 'a', ee: 'i', oo: 'u' }[v] || v;
    if (final && u.nasal && v === 'ee') v = 'i';
    out += u.c + v;
    if (u.nasal) {
      const nextC = units[i + 1]?.c;
      out += nextC && DEV_LABIALS.has(nextC) ? 'm' : 'n';
    }
  });
  return out;
}

/** Each word of each line romanized by the rules for `group`: per line,
 *  `[{start, end, reading}]`. */
export function romanizeByRules(lines, group) {
  const rule = group === 'el' ? romanizeGreekWord : group === 'hi' ? romanizeHindiWord : null;
  if (!rule) return lines.map(() => null);
  return lines.map((line) => romanWords(line, group).map((w) => ({ start: w.start, end: w.end, reading: cleanRomanization(rule(w.text)) })));
}

// ── Asking a model ──

const STYLE = {
  Hindi: `the way Bollywood lyrics are usually typed in English letters: long vowels doubled inside a word (pyaar, jaana, yaad, dheere, dhoondh), single at the end (tera, zindagi, tu); the "a" Hindi does not say left out as it is sung (dil, samajh, dhadkan, karna); nasal vowels with an n (main, hain, nahin); ज़ as z, फ़ as f, क़ as q, श as sh, च as ch, छ as chh`,
  Marathi: 'the way Marathi lyrics are usually typed in English letters, long vowels doubled inside a word, the unsaid "a" left out as it is sung',
  Nepali: 'the way Nepali lyrics are usually typed in English letters, long vowels doubled inside a word, the unsaid "a" left out as it is sung',
  Thai: `as it is sung, in the spelling of the Royal Thai General System (no tone marks, no vowel-length marks): ฉัน → chan, รัก → rak, เธอ → thoe, ใจ → chai, สวัสดี → sawatdi; write the vowels Thai leaves unwritten`,
  Arabic: `as it is sung, with the short vowels the script leaves unwritten, in the dialect of the song (Egyptian, Levantine, Gulf, Maghrebi or standard Arabic): حبيبي → habibi, قلبي → albi in Egyptian or qalbi in standard Arabic; the article assimilated as said (الشمس → esh-shams); plain letters only: no numbers for sounds, no accents; kh, gh, sh, th, dh for those sounds`,
  Persian: 'as it is sung in Persian, with the short vowels the script leaves unwritten, in plain letters (no accents): دوستت دارم → dooset daram, eshgh, del',
  Urdu: 'the way Urdu lyrics are usually typed in English letters (pyaar, dil, mohabbat, zindagi), with the short vowels the script leaves unwritten',
  Hebrew: `as it is sung, in modern Israeli pronunciation, with the vowels the script leaves unwritten: אני → ani, אוהב → ohev, אותך → otach; ח and fricative כ as ch, צ as tz, ש as sh; plain letters only`,
  Yiddish: 'as it is sung, in plain letters, with the vowels the script leaves unwritten',
};

/** What is sent for one line: the line and its words to romanize. */
export function romanEntry(line, group) {
  return { line: String(line || ''), words: romanWords(line, group) };
}

/**
 * The instruction sent with every request.  Exported so the Worker and the
 * evaluation (tests/eval_romanize_live.mjs) send exactly the same prompt.
 * The examples are deliberately words absent from the answer keys.
 */
export function buildRomanizePrompt(entries, language) {
  const name = romanLanguageName(language) || 'the';
  const n = entries.length;
  const listed = entries
    .map((e, i) => `${i + 1}. ${e.line}\n   words: ${e.words.map((w) => w.text).join(' | ')}`)
    .join('\n');
  return `These are ${n} lines of ${name} song lyrics. Under each line is a list of words taken from it. Write each word in plain English letters, so that someone who cannot read the script can sing along.

Rules:
- Return one entry for each of the ${n} lines, in order: the line's number, then one romanization for each of its words, in the order listed — for line 1 with words w1 | w2, ["1", "...", "..."].
- Write each word ${STYLE[name] || 'as it is sung, in plain letters'}.
- Read each word the way it is sung in that line, using the words around it.
- Plain letters only: no accents, no tone marks, no numbers standing for sounds. An apostrophe or hyphen inside a word is fine.
- No translations, no punctuation, no explanations.

Lines:
${listed}`;
}

export const ROMANIZE_RESPONSE_SCHEMA = {
  type: 'ARRAY',
  items: { type: 'ARRAY', items: { type: 'STRING' } },
};

/** The generateContent body for one chunk of lines. */
export function geminiRomanizeRequest(entries, language) {
  return {
    contents: [{ parts: [{ text: buildRomanizePrompt(entries, language) }] }],
    generationConfig: {
      temperature: 0,
      responseMimeType: 'application/json',
      responseSchema: ROMANIZE_RESPONSE_SCHEMA,
    },
  };
}

/**
 * The model's numbered reply, checked: per entry, its words' romanizations
 * as `[[start, end, romanization], …]`, or null for a line answered with
 * the wrong number of words, or not at all.  A word with no usable
 * romanization is left out of its line.  Throws if no line was answered.
 */
export function parseRomanizeReply(entries, reply) {
  if (!Array.isArray(reply)) throw new Error('romanization reply is not a list');
  const byLine = new Map();
  const repeated = new Set();
  for (const item of reply) {
    if (!Array.isArray(item) || !/^\s*\d+\s*$/.test(String(item[0]))) continue;
    const n = Number(item[0]);
    if (byLine.has(n)) repeated.add(n);
    byLine.set(n, item.slice(1));
  }
  const out = entries.map((entry, i) => {
    const got = byLine.get(i + 1);
    if (repeated.has(i + 1) || !Array.isArray(got) || got.length !== entry.words.length) return null;
    const line = [];
    entry.words.forEach((w, k) => {
      const r = cleanRomanization(got[k]);
      if (r) line.push([w.start, w.end, r]);
    });
    return line.length > 0 ? line : null;
  });
  if (out.every((r) => r === null)) {
    throw new Error(`romanization reply answered none of ${entries.length} lines (${reply.length} entries)`);
  }
  return out;
}

/**
 * The page's check on what the Worker sends back for each line: spans in
 * order, inside the line, each over a word of the script, with a usable
 * romanization.  A line that fails is null.
 */
export function checkRomanizations(lines, group, romanized) {
  if (!Array.isArray(romanized) || romanized.length !== lines.length) {
    throw new Error(`romanization: ${Array.isArray(romanized) ? romanized.length : 'no'} entries for ${lines.length} lines`);
  }
  const script = ROMAN_SCRIPTS[group];
  return lines.map((line, i) => {
    const spans = romanized[i];
    if (!Array.isArray(spans) || spans.length === 0) return null;
    const out = [];
    let cursor = 0;
    for (const s of spans) {
      if (!Array.isArray(s) || s.length !== 3) return null;
      const [start, end, value] = s;
      const reading = cleanRomanization(value);
      if (!Number.isInteger(start) || !Number.isInteger(end) || start < cursor || end <= start || end > line.length) return null;
      if (!script.test(line.slice(start, end)) || !reading) return null;
      out.push({ start, end, reading });
      cursor = end;
    }
    return out;
  });
}

// ── Models and the chain ──

/** Models the Worker will romanize with, pinned as for furigana. */
export const ROMANIZE_ALLOWED_MODELS = ['gemini-3.1-flash-lite', 'gemini-3.5-flash-lite'];

/** The chain step that romanizes by rules, in the browser. */
export const RULES_STEP = 'rules';

/**
 * Where romanizations come from, by script, in order; each step fills only
 * the words the steps before it left.  Greek needs no model.  Hindi falls
 * back to rules when both models fail; Thai, Arabic and Hebrew have no
 * rules good enough to fall back to.  See the README for the measured
 * accuracy of each.
 */
export const ROMANIZE_CHAINS = Object.freeze({
  el: [RULES_STEP],
  hi: ['gemini-3.1-flash-lite', 'gemini-3.5-flash-lite', RULES_STEP],
  th: ['gemini-3.1-flash-lite', 'gemini-3.5-flash-lite'],
  ar: ['gemini-3.1-flash-lite', 'gemini-3.5-flash-lite'],
  he: ['gemini-3.1-flash-lite', 'gemini-3.5-flash-lite'],
});

/** The first model of the chains: the only one whose answers the Worker stores. */
export const ROMANIZE_STORED_MODEL = ROMANIZE_ALLOWED_MODELS[0];

export const ROMANIZE_CHUNK_LINES = 25;
export const ROMANIZE_TIMEOUT_MS = 20_000;
export const ROMANIZE_GEMINI_TIMEOUT_MS = 17_000;
export const ROMANIZE_MAX_LINES = 200;
export const ROMANIZE_MAX_LINE_CHARS = 300;

export const ROMANIZE_CACHE_VERSION = 1;
export const ROMANIZE_CACHE_TTL_S = 180 * 24 * 60 * 60;

/** The key a song's romanizations are stored under: its language and a
 *  hash of its distinct lines, in order. */
export async function romanizeCacheKey(language, lines) {
  const bytes = new TextEncoder().encode(JSON.stringify(lines));
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
  const hex = [...digest].map((b) => b.toString(16).padStart(2, '0')).join('');
  return `romanize:v${ROMANIZE_CACHE_VERSION}:${language}:${hex}`;
}

/** Lines with words to romanize, each once, plus each line's slot (-1 for none). */
export function planRomanization(lines, group) {
  const unique = [];
  const indexOfLine = new Map();
  const slots = lines.map((line) => {
    const text = String(line || '');
    if (!hasRomanWords(text, group)) return -1;
    if (!indexOfLine.has(text)) {
      indexOfLine.set(text, unique.length);
      unique.push(text);
    }
    return indexOfLine.get(text);
  });
  return { unique, slots };
}

/** One Worker request: romanizations for up to ROMANIZE_MAX_LINES lines. */
async function requestLines(lines, group, language, model, workerUrl) {
  const resp = await fetch(`${workerUrl}/romanize`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ lines, language, model }),
    signal: AbortSignal.timeout(ROMANIZE_TIMEOUT_MS),
  });
  // 501: no Gemini key.  404: a Worker older than this route.
  if (resp.status === 501 || resp.status === 404) {
    const err = new Error(resp.status === 501 ? 'romanize: Worker has no Gemini key' : 'romanize: Worker has no /romanize route');
    err.unconfigured = true;
    throw err;
  }
  if (!resp.ok) {
    const detail = await resp.json().then((d) => d?.error || '', () => '');
    const err = new Error(`romanize HTTP ${resp.status}${detail ? `: ${detail}` : ''}`);
    err.transient = resp.status === 429 || resp.status === 503;
    throw err;
  }
  const data = await resp.json();
  return {
    romanized: checkRomanizations(lines, group, data?.romanized),
    cached: Boolean(data?.cached),
    model: typeof data?.model === 'string' ? data.model : model,
  };
}

async function requestRomanized(lines, group, language, model, workerUrl) {
  const parts = [];
  for (let i = 0; i < lines.length; i += ROMANIZE_MAX_LINES) parts.push(lines.slice(i, i + ROMANIZE_MAX_LINES));
  const replies = await Promise.all(parts.map((part) => requestLines(part, group, language, model, workerUrl)));
  return { romanized: replies.flatMap((r) => r.romanized), cached: replies.every((r) => r.cached), model: replies[0].model };
}

/**
 * Romanizations for every line, as an array the same length as `lines`:
 * per line `[{start, end, reading}]` over its words (`[]` for a line with
 * none to romanize), or null when none could be had for it.  Null overall
 * when nothing came back.
 *
 * The song's distinct lines go through the script's chain in order, each
 * step filling only words still unromanized.  A model step is one Worker
 * request for the song, which looks up stored romanizations first.  The
 * rules step runs here.  `onStep` reports each step as fetchFurigana's
 * does: `{step, model, lines, ok, filled, cached, ms, error, transient}`.
 *
 * @param {string[]} lines
 * @param {{group: string, language?: string, workerUrl?: string,
 *          chain?: string[], onStep?: Function}} options
 */
export async function fetchRomanization(lines, options) {
  const { group, workerUrl, onStep } = options || {};
  const language = romanLanguage(group, options?.language);
  const chain = options?.chain || ROMANIZE_CHAINS[group];
  if (!language || !chain || !Array.isArray(lines) || lines.length === 0) return null;

  const { unique, slots } = planRomanization(lines, group);
  if (unique.length === 0) return lines.map(() => []);

  // Per distinct line: its words, each with a romanization or null.  A
  // model's words replace the local split of a line nothing has filled yet
  // (Thai's dictionary split may differ between the Worker and this page).
  const words = unique.map((line) => romanWords(line, group).map((w) => ({ start: w.start, end: w.end, reading: null })));
  const unfilled = () => unique.map((_, i) => i).filter((i) => words[i].length === 0 || words[i].some((w) => !w.reading));
  let workerUsable = Boolean(workerUrl);

  for (const step of chain) {
    const todo = unfilled();
    if (todo.length === 0) break;
    const isRules = step === RULES_STEP;
    if (!isRules && !workerUsable) continue;

    const t0 = Date.now();
    const asked = todo.map((i) => unique[i]);
    try {
      let got;
      let cached = false;
      let model = isRules ? null : step;
      if (isRules) {
        got = romanizeByRules(asked, group);
      } else {
        ({ romanized: got, cached, model } = await requestRomanized(asked, group, language, step, workerUrl));
      }
      let filled = 0;
      todo.forEach((i, k) => {
        const spans = got?.[k];
        if (!Array.isArray(spans)) return;
        // Words the Worker split differently (Thai) replace the local split,
        // if nothing has filled the line yet.  Spans that are all local
        // words — perhaps fewer, a word left unanswered — just fill those.
        const differentSplit = spans.some((s) => !words[i].some((w) => w.start === s.start && w.end === s.end));
        if (differentSplit && !isRules && words[i].every((w) => !w.reading)) {
          words[i] = spans.map((s) => ({ ...s }));
          filled += spans.length;
          return;
        }
        for (const s of spans) {
          const w = words[i].find((x) => x.start === s.start && x.end === s.end);
          if (w && !w.reading && s.reading) { w.reading = s.reading; filled++; }
        }
      });
      onStep?.({ step, model, lines: todo.length, ok: true, filled, cached, ms: Date.now() - t0 });
    } catch (err) {
      console.debug(`[romanize] ${step} failed:`, err.message);
      onStep?.({ step, lines: todo.length, ok: false, filled: 0, ms: Date.now() - t0, error: err.message, transient: Boolean(err.transient) });
      if (err.unconfigured) workerUsable = false;
    }
  }

  const result = lines.map((_, i) => {
    const slot = slots[i];
    if (slot < 0) return [];
    const done = words[slot].filter((w) => w.reading);
    return done.length > 0 ? done : null;
  });
  return result.some((r) => r && r.length > 0) ? result : null;
}
