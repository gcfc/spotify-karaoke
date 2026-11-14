// ============================================================
//  Lyrics fonts — what the font picker offers for each script.
//
//  The lyrics' script picks a group (fontGroupFor); the listener's choice
//  is remembered per group, since a Chinese font cannot draw Korean and a
//  Latin one cannot draw either.  Every font listed was checked, by drawing
//  sample lyrics, to cover its whole script and English too (lyrics mix in
//  English lines): the Latin fonts cover Vietnamese and Cyrillic as well.
//
//  Each choice is a Google Fonts family: `spec` is its css2 `family`
//  parameter, and `weight` the weight the lyrics are drawn at.  A font with
//  a true bold is drawn in it.  A font with a single weight is drawn at that
//  weight rather than faux-bolded — except the Chinese fonts, which keep
//  the 600 they have always been drawn at.  `generic` is the fallback for a
//  missing character.
//
//  The first choice in each group, with no family, is the page's own font:
//  for each language, the system font every platform ships for it (see
//  :lang() in style.css), then `fallback`, a Google Noto font fetched only
//  when the device has no font that draws the lyrics' characters — so the
//  lyrics never show as empty boxes, and no device downloads a font it
//  already has.  Chinese and Japanese share most characters but draw many
//  differently (直, 骨, 写 …), and a Chinese font draws kana too: so for
//  those two, a device must also have one of the `local` fonts, which draw
//  the language's own forms, or the Noto font is fetched.  `local` is the
//  language's font stack in style.css, which a test holds to it.
//
//  Fonts load lazily: a choice's font only once the lyrics are drawn in it,
//  and for the menu, only the letters of each font's own name.
// ============================================================

const DEFAULT_LABEL = 'Default';

// Hindi (Devanagari) and Punjabi (Gurmukhi) share one list, and one
// remembered choice: songs switch between the two scripts (Dilliwaali
// Girlfriend's Punjabi lines are in Gurmukhi), and Spotify labels Punjabi
// songs Hindi.  Only Google Sans draws both scripts itself; the others are
// type families made in matching Devanagari and Gurmukhi editions, offered
// as one choice — `families` — with each script drawn by its own edition
// (Google Fonts fetches only the files for the scripts on screen).
const INDIC_FONTS = Object.freeze([
  { family: '', label: DEFAULT_LABEL, fallback: 'Noto+Sans+Devanagari:wght@400;600&family=Noto+Sans+Gurmukhi:wght@400;600' },
  { family: 'Google Sans', label: 'Google Sans', spec: 'Google+Sans:wght@700', weight: 700 },
  { family: 'Mukta', families: ['Mukta', 'Mukta Mahee'], label: 'Mukta', spec: 'Mukta:wght@700&family=Mukta+Mahee:wght@700', weight: 700 },
  { family: 'Baloo 2', families: ['Baloo 2', 'Baloo Paaji 2'], label: 'Baloo', spec: 'Baloo+2:wght@700&family=Baloo+Paaji+2:wght@700', weight: 700 },
  { family: 'Anek Devanagari', families: ['Anek Devanagari', 'Anek Gurmukhi'], label: 'Anek', spec: 'Anek+Devanagari:wght@700&family=Anek+Gurmukhi:wght@700', weight: 700 },
  { family: 'Noto Serif Devanagari', families: ['Noto Serif Devanagari', 'Noto Serif Gurmukhi'], label: 'Noto Serif', spec: 'Noto+Serif+Devanagari:wght@700&family=Noto+Serif+Gurmukhi:wght@700', weight: 700, generic: 'serif' },
  { family: 'Tiro Devanagari Hindi', families: ['Tiro Devanagari Hindi', 'Tiro Gurmukhi'], label: 'Tiro', spec: 'Tiro+Devanagari+Hindi&family=Tiro+Gurmukhi', weight: 400, generic: 'serif' },
]);

export const LYRICS_FONT_GROUPS = Object.freeze({
  // English, Vietnamese, Cyrillic and other Latin-script lyrics.
  latin: [
    { family: '', label: DEFAULT_LABEL },
    // The everyday sans fonts first; they cover Greek as well.
    { family: 'Roboto', label: 'Roboto', spec: 'Roboto:wght@700', weight: 700 },
    { family: 'Open Sans', label: 'Open Sans', spec: 'Open+Sans:wght@700', weight: 700 },
    { family: 'Noto Sans', label: 'Noto Sans', spec: 'Noto+Sans:wght@700', weight: 700 },
    { family: 'Montserrat', label: 'Montserrat', spec: 'Montserrat:wght@700', weight: 700 },
    { family: 'Nunito', label: 'Nunito', spec: 'Nunito:wght@800', weight: 800 },
    { family: 'Oswald', label: 'Oswald', spec: 'Oswald:wght@600', weight: 600 },
    { family: 'Raleway', label: 'Raleway', spec: 'Raleway:wght@700', weight: 700 },
    { family: 'Exo 2', label: 'Exo 2', spec: 'Exo+2:wght@700', weight: 700 },
    { family: 'Comfortaa', label: 'Comfortaa', spec: 'Comfortaa:wght@700', weight: 700 },
    { family: 'Playfair Display', label: 'Playfair Display', spec: 'Playfair+Display:wght@700', weight: 700, generic: 'serif' },
    { family: 'Lora', label: 'Lora', spec: 'Lora:wght@700', weight: 700, generic: 'serif' },
  ],
  zh: [
    { family: '', label: '默认', fallback: 'Noto+Sans+SC:wght@400;600',
      local: ['PingFang SC', 'Hiragino Sans GB', 'Microsoft YaHei', 'Noto Sans CJK SC', 'Source Han Sans SC', 'WenQuanYi Micro Hei', 'WenQuanYi Zen Hei'] },
    { family: 'Noto Serif SC', label: '宋体', spec: 'Noto+Serif+SC:wght@700', weight: 700, generic: 'serif' },
    { family: 'Long Cang', label: '龙藏体', spec: 'Long+Cang', weight: 600 },
    { family: 'Ma Shan Zheng', label: '马山正', spec: 'Ma+Shan+Zheng', weight: 600 },
    { family: 'Zhi Mang Xing', label: '志莽行', spec: 'Zhi+Mang+Xing', weight: 600 },
    { family: 'ZCOOL XiaoWei', label: '站酷小薇', spec: 'ZCOOL+XiaoWei', weight: 600 },
    { family: 'ZCOOL KuaiLe', label: '站酷快乐', spec: 'ZCOOL+KuaiLe', weight: 600 },
  ],
  // Rounded gothic is the look of Japanese karaoke screens.
  ja: [
    { family: '', label: 'デフォルト', fallback: 'Noto+Sans+JP:wght@400;600',
      local: ['Hiragino Sans', 'Hiragino Kaku Gothic ProN', 'Yu Gothic', 'YuGothic', 'Meiryo', 'Noto Sans CJK JP', 'Source Han Sans JP', 'IPAexGothic', 'IPAPGothic', 'IPAGothic', 'TakaoPGothic', 'VL PGothic'] },
    { family: 'M PLUS Rounded 1c', label: '丸ゴシック', spec: 'M+PLUS+Rounded+1c:wght@700', weight: 700 },
    { family: 'Zen Maru Gothic', label: 'Zen丸ゴシック', spec: 'Zen+Maru+Gothic:wght@700', weight: 700 },
    { family: 'Noto Serif JP', label: '明朝', spec: 'Noto+Serif+JP:wght@700', weight: 700, generic: 'serif' },
    { family: 'Dela Gothic One', label: 'デラゴシック', spec: 'Dela+Gothic+One', weight: 400 },
    { family: 'Yusei Magic', label: '油性マジック', spec: 'Yusei+Magic', weight: 400 },
  ],
  ko: [
    { family: '', label: '기본', fallback: 'Noto+Sans+KR:wght@400;600' },
    { family: 'Jua', label: '주아', spec: 'Jua', weight: 400 },
    { family: 'Do Hyeon', label: '도현', spec: 'Do+Hyeon', weight: 400 },
    { family: 'Black Han Sans', label: '검은고딕', spec: 'Black+Han+Sans', weight: 400 },
    { family: 'Gowun Dodum', label: '고운돋움', spec: 'Gowun+Dodum', weight: 400 },
    { family: 'Noto Serif KR', label: '명조', spec: 'Noto+Serif+KR:wght@700', weight: 700, generic: 'serif' },
    { family: 'Nanum Pen Script', label: '나눔펜', spec: 'Nanum+Pen+Script', weight: 400 },
  ],
  th: [
    { family: '', label: DEFAULT_LABEL, fallback: 'Noto+Sans+Thai:wght@400;600' },
    { family: 'Kanit', label: 'Kanit', spec: 'Kanit:wght@700', weight: 700 },
    { family: 'Prompt', label: 'Prompt', spec: 'Prompt:wght@700', weight: 700 },
    { family: 'Mitr', label: 'Mitr', spec: 'Mitr:wght@700', weight: 700 },
    { family: 'Sarabun', label: 'Sarabun', spec: 'Sarabun:wght@700', weight: 700 },
    { family: 'Chakra Petch', label: 'Chakra Petch', spec: 'Chakra+Petch:wght@700', weight: 700 },
    { family: 'Itim', label: 'Itim', spec: 'Itim', weight: 400 },
    { family: 'Pridi', label: 'Pridi', spec: 'Pridi:wght@700', weight: 700, generic: 'serif' },
  ],
  ar: [
    { family: '', label: DEFAULT_LABEL, fallback: 'Noto+Sans+Arabic:wght@400;600' },
    { family: 'Cairo', label: 'Cairo', spec: 'Cairo:wght@700', weight: 700 },
    { family: 'Tajawal', label: 'Tajawal', spec: 'Tajawal:wght@700', weight: 700 },
    { family: 'Almarai', label: 'Almarai', spec: 'Almarai:wght@700', weight: 700 },
    { family: 'El Messiri', label: 'El Messiri', spec: 'El+Messiri:wght@700', weight: 700 },
    { family: 'Reem Kufi', label: 'Reem Kufi', spec: 'Reem+Kufi:wght@700', weight: 700 },
    { family: 'Lalezar', label: 'Lalezar', spec: 'Lalezar', weight: 400 },
    { family: 'Changa', label: 'Changa', spec: 'Changa:wght@700', weight: 700 },
    { family: 'Amiri', label: 'Amiri', spec: 'Amiri:wght@700', weight: 700, generic: 'serif' },
  ],
  he: [
    { family: '', label: DEFAULT_LABEL, fallback: 'Noto+Sans+Hebrew:wght@400;600' },
    { family: 'Heebo', label: 'Heebo', spec: 'Heebo:wght@700', weight: 700 },
    { family: 'Rubik', label: 'Rubik', spec: 'Rubik:wght@700', weight: 700 },
    { family: 'Assistant', label: 'Assistant', spec: 'Assistant:wght@700', weight: 700 },
    { family: 'Varela Round', label: 'Varela Round', spec: 'Varela+Round', weight: 400 },
    { family: 'Secular One', label: 'Secular One', spec: 'Secular+One', weight: 400 },
    { family: 'Suez One', label: 'Suez One', spec: 'Suez+One', weight: 400, generic: 'serif' },
    { family: 'Frank Ruhl Libre', label: 'Frank Ruhl Libre', spec: 'Frank+Ruhl+Libre:wght@700', weight: 700, generic: 'serif' },
  ],
  // Hindi and the other languages written in Devanagari.
  // Hindi and the other languages written in Devanagari, and Punjabi in
  // Gurmukhi: the same list (see INDIC_FONTS).
  hi: INDIC_FONTS,
  pa: INDIC_FONTS,
  // The page's own font, Inter, draws Greek itself.
  el: [
    { family: '', label: DEFAULT_LABEL },
    { family: 'Roboto', label: 'Roboto', spec: 'Roboto:wght@700', weight: 700 },
    { family: 'Open Sans', label: 'Open Sans', spec: 'Open+Sans:wght@700', weight: 700 },
    { family: 'Noto Sans', label: 'Noto Sans', spec: 'Noto+Sans:wght@700', weight: 700 },
    { family: 'Commissioner', label: 'Commissioner', spec: 'Commissioner:wght@700', weight: 700 },
    { family: 'Manrope', label: 'Manrope', spec: 'Manrope:wght@700', weight: 700 },
    { family: 'Ubuntu', label: 'Ubuntu', spec: 'Ubuntu:wght@700', weight: 700 },
    { family: 'Fira Sans', label: 'Fira Sans', spec: 'Fira+Sans:wght@700', weight: 700 },
    { family: 'Comfortaa', label: 'Comfortaa', spec: 'Comfortaa:wght@700', weight: 700 },
    { family: 'Advent Pro', label: 'Advent Pro', spec: 'Advent+Pro:wght@700', weight: 700 },
    { family: 'Alegreya', label: 'Alegreya', spec: 'Alegreya:wght@700', weight: 700, generic: 'serif' },
    { family: 'GFS Didot', label: 'GFS Didot', spec: 'GFS+Didot', weight: 400, generic: 'serif' },
  ],
});

// The script of the lyrics' own characters decides, in this order: a K-pop
// or J-pop song with English lines is still Korean or Japanese, and a
// language Spotify names (Persian, Urdu, Marathi …) is drawn by the fonts
// for its script.
const SCRIPT_GROUPS = [
  ['ja', /[぀-ゟ゠-ヿ]/],
  ['ko', /[가-힯ᄀ-ᇿ㄰-㆏]/],
  ['zh', /[㐀-鿿豈-﫿]/],
  ['th', /[฀-๿]/],
  ['ar', /[؀-ۿݐ-ݿࢠ-ࣿ]/],
  ['he', /[֐-׿]/],
  ['hi', /[ऀ-ॿ]/],
  ['pa', /[\u0a00-\u0a7f]/],
  ['el', /[Ͱ-Ͽἀ-῿]/],
  ['latin', /[A-Za-zÀ-ɏḀ-ỿЀ-ӿԀ-ԯ]/],
];

/**
 * The font group for lyrics: from the characters in `sample`, except that a
 * language declared as Chinese, Japanese or Korean decides for itself (kanji
 * alone cannot tell Japanese from Chinese).  Null for a script no font here
 * covers.
 *
 * @param {string} language  the lyrics' language (detectLyricsLanguage)
 * @param {string} sample    some of the lyrics' text
 */
export function fontGroupFor(language, sample = '') {
  const base = String(language || '').toLowerCase().split(/[-_]/)[0];
  if (base === 'zh' || base === 'ja' || base === 'ko') return base;
  for (const [group, pattern] of SCRIPT_GROUPS) {
    if (!pattern.test(sample)) continue;
    // Latin only for lyrics mostly in it: a few English words in lyrics in
    // a script with no fonts here (Tamil, Bengali …) do not make them Latin.
    if (group === 'latin' && !mostlyLatin(sample)) return null;
    return group;
  }
  return null;
}

function mostlyLatin(sample) {
  const letters = sample.match(/\p{L}/gu) || [];
  const latin = letters.filter((ch) => /\p{Script=Latin}|\p{Script=Cyrillic}/u.test(ch));
  return latin.length * 2 >= letters.length;
}

/** The choice for `family` in `group`, or the group's default. */
export function findFont(group, family) {
  const choices = LYRICS_FONT_GROUPS[group] || [];
  return choices.find((c) => c.family === family) || choices[0] || null;
}

/** A Google Fonts stylesheet URL for a css2 family parameter. */
function cssUrl(spec) {
  return spec ? `https://fonts.googleapis.com/css2?family=${spec}&display=swap` : '';
}

/** The stylesheet URL for a choice: its own font, or for the default the
 *  last-resort Noto font of its script ('' when there is none). */
export function googleFontsUrl(choice) {
  return cssUrl(choice?.spec || choice?.fallback);
}

/** The stylesheet URL for the menu's preview of a choice: only the letters
 *  of its name, a few KB, rather than the whole font ('' for the page's own
 *  font). */
export function previewFontUrl(choice) {
  return choice?.spec ? `https://fonts.googleapis.com/css2?family=${choice.spec}&text=${encodeURIComponent(choice.label)}&display=swap` : '';
}

/**
 * Up to `limit` different characters of `sample` in the script of `group` —
 * for kanji-and-kana Japanese, both — to test whether the device can draw
 * them.
 */
export function scriptChars(group, sample, limit = 6) {
  const related = { ja: ['ja', 'zh'], hi: ['hi', 'pa'], pa: ['pa', 'hi'] }[group] || [group];
  const patterns = SCRIPT_GROUPS.filter(([g]) => related.includes(g)).map(([, p]) => p);
  const chars = [];
  for (const ch of new Set(String(sample || ''))) {
    if (patterns.some((p) => p.test(ch))) chars.push(ch);
    if (chars.length >= limit) break;
  }
  return chars;
}

/** The CSS font-family value for a choice, or '' for the page's own font. */
export function fontFamilyValue(choice) {
  if (!choice?.family) return '';
  const families = choice.families || [choice.family];
  return `${families.map((f) => `"${f}"`).join(', ')}, ${choice.generic || 'sans-serif'}`;
}

/** localStorage key for a group's choice. */
export function fontStorageKey(group) {
  // Hindi and Punjabi share their list, so they share the choice too.
  return `lyrics-font:${group === 'pa' ? 'hi' : group}`;
}
