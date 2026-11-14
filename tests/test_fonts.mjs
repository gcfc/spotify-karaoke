/**
 * Unit tests for the lyrics font choices (fonts.js).
 *
 * Usage:  node tests/test_fonts.mjs
 */

import { readFileSync } from 'node:fs';

import {
  findFont,
  fontFamilyValue,
  fontGroupFor,
  fontStorageKey,
  googleFontsUrl,
  LYRICS_FONT_GROUPS,
  previewFontUrl,
  scriptChars,
} from '../fonts.js';

let passed = 0;
let failed = 0;

function assert(condition, label) {
  if (condition) {
    console.log(`  ✓ ${label}`);
    passed++;
  } else {
    console.error(`  ✗ ${label}`);
    failed++;
  }
}

console.log('\n── fontGroupFor ──');

assert(fontGroupFor('ja', '今日は雨') === 'ja' && fontGroupFor('ko', '오늘') === 'ko' && fontGroupFor('zh', '月亮') === 'zh',
  'Chinese, Japanese and Korean have fonts of their own');
assert(fontGroupFor('ja', '雨雪') === 'ja', 'a song declared Japanese stays Japanese even in a kanji-only sample');
assert(fontGroupFor('', '今日は雨が降る\nI love you') === 'ja', 'Japanese with English lines is Japanese');
assert(fontGroupFor('', '사랑해 baby') === 'ko', 'Korean with English is Korean');
assert(fontGroupFor('th', 'ฉันรักเธอ') === 'th', 'Thai has fonts of its own');
assert(fontGroupFor('ar', 'أحبك') === 'ar' && fontGroupFor('fa', 'دوستت دارم') === 'ar',
  'Arabic, and Persian written in Arabic script, take the Arabic fonts');
assert(fontGroupFor('he', 'אני אוהב') === 'he', 'Hebrew has fonts of its own');
assert(fontGroupFor('hi', 'मैं तुमसे') === 'hi' && fontGroupFor('mr', 'मला आवडते') === 'hi', 'Hindi and Marathi take the Devanagari fonts');
assert(fontGroupFor('el', 'Σ’ αγαπώ') === 'el', 'Greek has fonts of its own');
assert(fontGroupFor('en', 'Every night') === 'latin' && fontGroupFor('und', 'Tiếng Việt ở đây') === 'latin',
  'English and Vietnamese take the Latin fonts');
assert(fontGroupFor('ru', 'Привет мир') === 'latin', 'Cyrillic takes the Latin fonts, which all cover it');
assert(fontGroupFor('ta', 'தமிழ் பாடல்') === null && fontGroupFor('', '') === null, 'a script no font covers, or nothing to judge: no picker');
assert(fontGroupFor('pa', 'ਮੁੰਡਿਆਂ ਤੋਂ ਬਚ ਕੇ ਰਹੀਂ\nOh ho ho, yeah') === 'pa', 'Punjabi in Gurmukhi has fonts of its own, English lines or not');
assert(fontGroupFor('', 'தமிழ் பாடல் வரிகள் இங்கே\nyeah baby') === null,
  'lyrics mostly in a script with no fonts here are not taken for Latin over a few English words');
assert(fontGroupFor('en', 'Every night in my dreams, தமிழ்') === 'latin', 'English with a word of another script is still Latin');

console.log('\n── the choices ──');

const groups = Object.entries(LYRICS_FONT_GROUPS);
assert(groups.map(([g]) => g).join(',') === 'latin,zh,ja,ko,th,ar,he,hi,pa,el',
  'groups: Latin, Chinese, Japanese, Korean, Thai, Arabic, Hebrew, Devanagari, Gurmukhi, Greek');
assert(groups.every(([, list]) => list[0].family === '' && !list[0].spec), "each group starts with the page's own font");
assert(groups.every(([, list]) => list.slice(1).every((c) => c.family && c.label && c.spec && Number.isInteger(c.weight))),
  'every other choice has a family, a label, a stylesheet and a weight');
assert(groups.every(([, list]) => new Set(list.map((c) => c.family)).size === list.length), 'no font is listed twice in a group');
assert(groups.every(([, list]) => list.slice(1).every((c) => !/wght@/.test(c.spec) || c.spec.endsWith(`wght@${c.weight}`))),
  'a font with weights is fetched in the weight it is drawn at, so nothing is faux-bolded');
assert(groups.every(([g, list]) => list.slice(1).every((c) => /wght@/.test(c.spec) || c.weight === 400 || g === 'zh')),
  'single-weight fonts are drawn at 400, except the Chinese ones, which keep their 600');
const latin = LYRICS_FONT_GROUPS.latin.map((c) => c.family).filter(Boolean);
assert(latin.join(',') === 'Roboto,Open Sans,Noto Sans,Montserrat,Nunito,Oswald,Raleway,Exo 2,Comfortaa,Playfair Display,Lora',
  'the Latin fonts are those that cover English, Vietnamese and Cyrillic alike');
assert(['Poppins', 'Fredoka', 'Bebas Neue', 'Rubik'].every((f) => !latin.includes(f)),
  'fonts missing Vietnamese or Cyrillic are not among them');
assert(['Roboto', 'Open Sans', 'Noto Sans'].every((f) => findFont('el', f).family === f),
  'the everyday sans fonts, which cover Greek too, are offered for Greek as well');
assert(!['Raleway', 'Exo 2'].some((f) => findFont('el', f).family === f), 'fonts with no Greek are not offered for it');
assert(findFont('zh', 'Noto Serif SC').label === '宋体' && findFont('zh', 'Noto Serif SC').weight === 700, '宋体 keeps its true bold');

assert(LYRICS_FONT_GROUPS.hi === LYRICS_FONT_GROUPS.pa, 'Hindi and Punjabi share one list, so a label from Spotify cannot change it');
assert(fontStorageKey('pa') === fontStorageKey('hi'), 'and one remembered choice');
assert(LYRICS_FONT_GROUPS.hi.slice(1).every((c) => c.family === 'Google Sans' || (c.families?.length === 2 && c.spec.includes('&family='))),
  'every choice draws both scripts: Google Sans itself, the others as a Devanagari and Gurmukhi edition of one family');
assert(fontFamilyValue(findFont('pa', 'Mukta')) === '"Mukta", "Mukta Mahee", sans-serif', 'a pair is set as both families, each drawing its own script');
assert(scriptChars('hi', 'तेरे ਤੈਨੂੰ').some((c) => /[\u0a00-\u0a7f]/.test(c)), "the device test for Hindi lyrics includes their Gurmukhi");

console.log('\n── defaults ──');

for (const g of ['zh', 'ja', 'ko', 'th', 'ar', 'he', 'hi', 'pa']) {
  assert(/^Noto\+Sans\+/.test(LYRICS_FONT_GROUPS[g][0].fallback || ''), `${g}: the default has a Noto web font as its last resort`);
}
assert(!LYRICS_FONT_GROUPS.latin[0].fallback && !LYRICS_FONT_GROUPS.el[0].fallback, 'Latin and Greek need none: Inter draws them');
assert(googleFontsUrl(findFont('th', '')) === 'https://fonts.googleapis.com/css2?family=Noto+Sans+Thai:wght@400;600&display=swap',
  "a default's stylesheet is its fallback font");

console.log('\n── lazy loading ──');

assert(previewFontUrl(findFont('latin', 'Exo 2')) === 'https://fonts.googleapis.com/css2?family=Exo+2:wght@700&text=Exo%202&display=swap',
  "the menu's preview fetches only the letters of the font's name");
assert(previewFontUrl(findFont('zh', 'Noto Serif SC')).includes('&text=%E5%AE%8B%E4%BD%93&'), 'a Chinese preview fetches just its two characters');
assert(previewFontUrl(findFont('th', '')) === '', "the page's own font needs no preview");
assert(scriptChars('th', 'ฉันรัก love ฉัน').join('') === 'ฉันรก', "the device is tested on the lyrics' own characters, each once");
assert(scriptChars('ja', '今日は雨').join('') === '今日は雨', 'Japanese is tested on its kanji and kana');
assert(scriptChars('zh', '一二三四五六七八').length === 6, 'a few characters are enough');
assert(scriptChars('ar', 'hello').length === 0, 'none, for lyrics with none of the script');

for (const [g, noto] of [['zh', 'Noto Sans SC'], ['ja', 'Noto Sans JP']]) {
  const stack = readFileSync(new URL('../style.css', import.meta.url), 'utf8').match(new RegExp(`--fonts-${g}: ([^;]*);`))[1];
  assert(stack === [...LYRICS_FONT_GROUPS[g][0].local, noto].map((f) => `"${f}"`).join(', '),
    `${g}: the fonts the device is tested for are the language's font stack in style.css`);
}
assert(!LYRICS_FONT_GROUPS.ko[0].local && !LYRICS_FONT_GROUPS.th[0].local, 'other scripts need only some font that draws them');

console.log('\n── helpers ──');

assert(findFont('ja', 'M PLUS Rounded 1c').label === '丸ゴシック', 'a family is found in its group');
assert(findFont('ja', 'Noto Serif SC').family === '', "a family from another group falls back to the page's own font");
assert(findFont('nope', 'x') === null, 'an unknown group has no choices');
assert(googleFontsUrl(findFont('latin', 'Montserrat')) === 'https://fonts.googleapis.com/css2?family=Montserrat:wght@700&display=swap',
  'the stylesheet URL asks for the weight drawn');
assert(googleFontsUrl(findFont('latin', '')) === '', 'the Latin default needs no stylesheet');
assert(fontFamilyValue(findFont('latin', 'Oswald')) === '"Oswald", sans-serif', 'a sans font falls back to sans-serif');
assert(fontFamilyValue(findFont('ar', 'Amiri')) === '"Amiri", serif', 'a serif font falls back to serif');
assert(fontFamilyValue(findFont('zh', '')) === '', "the page's own font is no font-family at all");
assert(fontStorageKey('ko') === 'lyrics-font:ko', 'each group remembers its choice under its own key');

console.log(`\n${'─'.repeat(40)}`);
console.log(`Results: ${passed} passed, ${failed} failed, ${passed + failed} total`);

if (failed > 0) {
  process.exit(1);
}
