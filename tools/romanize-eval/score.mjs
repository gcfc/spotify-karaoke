/**
 * Comparing a romanization with the answer key's.
 *
 * Typed romanizations of the same sung word differ in ways a singer does
 * not notice — pyaar or pyar, nahin or nahi, wafa or vafa — so a word is
 * scored twice: exactly (case, apostrophes and hyphens aside), and loosely,
 * with those variants folded together (looseKey).
 */

export function exactKey(word) {
  return String(word || '').toLowerCase().replace(/['’\-\s]/g, '');
}

/** The word with the spelling choices typed lyrics disagree on folded away:
 *  vowel length (aa/a, ee/i, oo/u), w/v, z/j, q/k, ph/f, doubled letters,
 *  chh/ch and chch/ch, ei/e and a y between vowels (hawaayein/hawaayen,
 *  jaayein/jaaen), an h closing a vowel (oh/o, reh/re) and a nasal n or m
 *  at the end (nahin/nahi, main/mai, chalein/chalem).  Aspiration (jh/j,
 *  gh/g) is a different sound and is not folded. */
export function looseKey(word) {
  let k = exactKey(word).replace(/[^a-z]/g, '');
  k = k.replace(/ph/g, 'f').replace(/w/g, 'v').replace(/z/g, 'j').replace(/q/g, 'k').replace(/chh/g, 'ch').replace(/x/g, 'ks');
  k = k.replace(/ee/g, 'i').replace(/oo/g, 'u').replace(/ou/g, 'u');
  k = k.replace(/([a-z])\1+/g, '$1').replace(/(ch)+/g, 'ch');
  k = k.replace(/([aeiou])y(?=[aeiou])/g, '$1').replace(/ei/g, 'e');
  k = k.replace(/([a-z])\1+/g, '$1');
  k = k.replace(/([aeiou])h(?=[^aeiou]|$)/g, '$1');
  k = k.replace(/([aeiou])[nm]$/, '$1');
  return k;
}

const firstSound = (w) => {
  const k = looseKey(w);
  return /^[aeiouy]/.test(k) ? 'V' : k.slice(0, 1);
};

/** Whether two romanizations start with the same sound — enough to tell a
 *  line paired with its own romanization from one paired with another. */
export function sameStart(a, b) {
  return firstSound(a) === firstSound(b);
}
