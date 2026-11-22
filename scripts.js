// ============================================================
//  Which script lyrics are written in — judged by words, not by single
//  characters.  Shared by translate.js (language detection), fonts.js
//  (the font menu) and romanize.js (the romanization toggle).
//
//  Lyrics databases carry look-alike letters typed by mistake: every
//  LRCLIB upload of The Weeknd's "Hong Kong" spells "tеnsion" with a
//  Cyrillic е.  Counting such a character as Cyrillic made an English and
//  Chinese song look partly Russian.  So a word belongs to a script only
//  when most of its letters do, and lyrics are in a script only when
//  enough of their words are.
// ============================================================

const WORD_RE = /[\p{L}\p{M}]+(?:['’][\p{L}\p{M}]+)*/gu;
const LETTER_RE = /\p{L}/gu;

// Lyrics are in a script with at least this many of its words, or this
// share of all their words (for a short sample, such as one line).
const MIN_WORDS = 3;
const MIN_SHARE = 0.25;

/** Whether most of `word`'s letters are in the script `pattern` matches
 *  (a single-character class, such as /[Ѐ-ӿ]/). */
export function wordIsInScript(word, pattern) {
  const letters = String(word || '').match(LETTER_RE) || [];
  if (letters.length === 0) return false;
  return letters.filter((ch) => pattern.test(ch)).length * 2 > letters.length;
}

/** The words of `sample` that are in the script `pattern` matches. */
export function wordsInScript(sample, pattern) {
  return (String(sample || '').match(WORD_RE) || []).filter((w) => wordIsInScript(w, pattern));
}

/** Whether `sample` is written (at least partly, but in earnest) in the
 *  script `pattern` matches: enough of its words are in it. */
export function writtenIn(sample, pattern) {
  const all = String(sample || '').match(WORD_RE) || [];
  const inScript = all.filter((w) => wordIsInScript(w, pattern)).length;
  return inScript >= MIN_WORDS || (inScript > 0 && inScript >= MIN_SHARE * all.length);
}
