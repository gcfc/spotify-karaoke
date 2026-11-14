/**
 * Unit tests for romanization (romanize.js) and its source-panel label.
 * No network: the Worker is stubbed.
 *
 * Usage:  node tests/test_romanize.mjs
 */

import {
  buildRomanizePrompt,
  checkRomanizations,
  cleanRomanization,
  fetchRomanization,
  parseRomanizeReply,
  planRomanization,
  romanEntry,
  romanizeByRules,
  romanizeCacheKey,
  romanizeGreekWord,
  romanizeHindiWord,
  romanizeCyrillicWord,
  romanGroupFor,
  romanizePunjabiWord,
  gurmukhiToDevanagari,
  ROMANIZE_CHAINS,
  romanLanguage,
  romanScriptOf,
  romanWords,
  RULES_STEP,
} from '../romanize.js';
import { romanizationLabel, sourcePanelText } from '../source-labels.js';
import { furiganaSegments, layoutWordFurigana } from '../furigana.js';
import { looseKey } from '../tools/romanize-eval/score.mjs';

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

const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);

console.log('\n── languages ──');

assert(romanLanguage('hi', 'mr') === 'mr' && romanLanguage('hi', 'en') === 'hi' && romanLanguage('ar', 'fa') === 'fa',
  "a detected language written in the script is kept; anything else takes the script's main language");
assert(romanLanguage('pa', 'hi') === 'pa' && romanScriptOf('pa') === 'pa', 'Punjabi lyrics are romanized as Punjabi, whatever language they were declared');
assert(romanLanguage('ja', 'ja') === null && romanLanguage('latin', 'en') === null, 'scripts not romanized have no language');
assert(romanScriptOf('ur') === 'ar' && romanScriptOf('ne') === 'hi' && romanScriptOf('ja') === null, "a language's script group");

console.log('\n── words ──');

assert(eq(romanWords('ฉันรักเธอ love', 'th').map((w) => w.text), ['ฉัน', 'รัก', 'เธอ']), 'Thai, written without spaces, is split into words');
assert(eq(romanWords('أحبك يا حبيبي baby', 'ar').map((w) => w.text), ['أحبك', 'يا', 'حبيبي']), 'English words in the lyrics are left alone');
assert(eq(romanWords('תודה, ג׳ורג׳!', 'he').map((w) => w.text), ['תודה', 'ג׳ורג׳']), 'a Hebrew geresh stays in its word');
assert(eq(romanWords('Σ’αγαπώ πολύ', 'el').map((w) => w.text), ['Σ’αγαπώ', 'πολύ']), 'an elided Greek word stays whole');
const hiWords = romanWords('तुम ही हो, अब', 'hi');
assert(eq(hiWords.map((w) => [w.start, w.end]), [[0, 3], [4, 6], [7, 9], [11, 13]]), 'each word carries its offsets in the line');
assert(eq(planRomanization(['तुम ही हो', 'Oh baby', 'तुम ही हो'], 'hi'), { unique: ['तुम ही हो'], slots: [0, -1, 0] }),
  'a repeated line is asked once, and a line with nothing to romanize not at all');

console.log('\n── Greek rules ──');

const greek = {
  καλημέρα: 'kalimera', ευχαριστώ: 'efharisto', αύριο: 'avrio', άνθρωπος: 'anthropos', άγγελος: 'angelos',
  γιατί: 'yati', γεια: 'ya', παιδί: 'pedi', ντροπή: 'dropi', πάντα: 'panda', εγκαίρως: 'engeros', ψυχή: 'psihi',
  νεράιδα: 'neraida', ρολόι: 'roloi', χορεύουμε: 'horevoume', φεύγεις: 'fevyis', Ελλάδα: 'Ellada', μπορείς: 'boris',
};
for (const [word, want] of Object.entries(greek)) assert(romanizeGreekWord(word) === want, `${word} → ${want}`);

console.log('\n── Hindi rules ──');

const hindi = {
  प्यार: 'pyaar', ज़िंदगी: 'zindagi', धड़कन: 'dhadkan', नहीं: 'nahin', मैं: 'main', तेरा: 'tera', जाना: 'jaana',
  दिल: 'dil', समझ: 'samajh', करना: 'karna', मोहब्बत: 'mohabbat', क्या: 'kya', हैं: 'hain', आँखें: 'aankhen',
  संभल: 'sambhal', इश्क़: 'ishq', मित्र: 'mitra', हम: 'hum', धीरे: 'dheere', ढूँढ: 'dhoondh',
};
for (const [word, want] of Object.entries(hindi)) assert(romanizeHindiWord(word) === want, `${word} → ${want}`);
assert(romanizeHindiWord('ज़िंदगी') === romanizeHindiWord('ज़िंदगी'), 'a nukta letter reads the same precomposed or not');
assert(eq(romanizeByRules(['तुम ही हो'], 'hi')[0].map((a) => a.reading), ['tum', 'hi', 'ho']), 'rules romanize each word of a line');
assert(romanizeByRules(['ฉันรักเธอ'], 'th')[0].every((a) => a.reading === null), 'there are no Thai rules');

console.log('\n── Punjabi rules ──');

assert(gurmukhiToDevanagari('ਮੁੰਡਿਆਂ') === 'मुंडिआं', 'a Gurmukhi word is spelled in Devanagari letter for letter, the tippi as a nasal');
assert(gurmukhiToDevanagari('ਬੱਚਾ') === 'बच्चा', 'the addak doubles the consonant after it');
const punjabi = {
  ਮੁੰਡਿਆਂ: 'mundiaan', ਬਚ: 'bach', ਕੇ: 'ke', ਕੁੜੀ: 'kudi', ਸੋਹਣੀ: 'sohni', ਯਾਰ: 'yaar', ਬੱਚਾ: 'bachcha',
  ਪੱਕਾ: 'pakka', ਨੱਚ: 'nach', ਗੱਲ: 'gal', 'ਖ਼ੁਸ਼': 'khush', 'ਖੁਸ਼': 'khush', ਨਹੀਂ: 'nahin', ਜ਼ਿੰਦਗੀ: 'zindagi',
};
for (const [word, want] of Object.entries(punjabi)) assert(romanizePunjabiWord(word) === want, `${word} → ${want}`);
assert(eq(romanizeByRules(['ਮੁੰਡਿਆਂ ਤੋਂ ਬਚ ਕੇ, yeah'], 'pa')[0].map((a) => a.reading), ['mundiaan', 'ton', 'bach', 'ke']),
  'rules romanize the Gurmukhi words of a Punjabi line, not the English');
assert(eq(ROMANIZE_CHAINS.pa, ROMANIZE_CHAINS.hi), 'Punjabi, like Hindi, asks the models and falls back to rules');

console.log('\n── Cyrillic rules ──');

const russian = {
  Я: 'Ya', тебя: 'tebya', люблю: 'lyublyu', ещё: 'yeshcho', жёлтый: 'zholty', новый: 'novy', синий: 'siniy',
  её: 'yeyo', объявление: 'obyavleniye', семья: 'semya', щастье: 'shchastye', Звёзды: 'Zvyozdy', хочу: 'khochu',
};
for (const [word, want] of Object.entries(russian)) assert(romanizeCyrillicWord(word) === want, `${word} → ${want}`);
assert(romanizeCyrillicWord('гарна', 'uk') === 'harna' && romanizeCyrillicWord('дівчина', 'uk') === 'divchyna' && romanizeCyrillicWord('Їде', 'uk') === 'Yide',
  'Ukrainian: г is h, и is y, ї is yi');
assert(romanizeCyrillicWord('България', 'bg') === 'Balgariya' && romanizeCyrillicWord('щастие', 'bg') === 'shtastie', 'Bulgarian: ъ is a, щ is sht, е stays e');
assert(romanizeCyrillicWord('Љубав', 'sr') === 'Ljubav' && romanizeCyrillicWord('ђак', 'sr') === 'djak', "Serbian's own letters");
assert(eq(romanizeByRules(['Стефанія мамо, гарна'], 'ru', 'uk')[0].map((a) => a.reading), ['Stefaniya', 'mamo', 'harna']),
  "the song's language picks the rules for its words");
assert(eq(ROMANIZE_CHAINS.ru, [RULES_STEP]), 'Cyrillic, like Greek, is romanized by rules alone');
assert(romanGroupFor('latin', 'Группа крови на рукаве') === 'ru' && romanGroupFor('latin', 'Every night') === null && romanGroupFor('hi', 'तुम') === 'hi',
  'Cyrillic lyrics, which share the Latin fonts, still get the button');
assert(romanLanguage('ru', 'uk') === 'uk' && romanLanguage('ru', 'en') === 'ru', 'a Cyrillic language is kept; anything else is read as Russian');

console.log('\n── songs that switch scripts ──');

const mixed = 'ओ, तेरे लिए आज ਗੱਡੀ मैं तो मोड़-माड़ के';
assert(eq(romanWords(mixed, 'hi').map((w) => w.text), ['ओ', 'तेरे', 'लिए', 'आज', 'ਗੱਡੀ', 'मैं', 'तो', 'मोड़', 'माड़', 'के']),
  "a Hindi song's Gurmukhi word is romanized with the rest");
assert(romanWords('ਓ, what a look! ਤੈਨੂੰ ਹੀ ਕਰਾਂ ਮੈਂ chase', 'hi').length === 5, "and so is a Hindi song's Punjabi line, its English left alone");
assert(eq(romanizeByRules([mixed], 'hi')[0].map((a) => a.reading), ['o', 'tere', 'lie', 'aaj', 'gaddi', 'main', 'to', 'mod', 'maad', 'ke']),
  'the rules read each word by its own script');
assert(romanWords('ਮੁੰਡਿਆਂ', 'latin').length === 0, 'lyrics in a script not romanized have nothing to romanize');
assert(eq(checkRomanizations(['ਤੈਨੂੰ ਹੀ'], 'hi', [[[0, 5, 'tainu'], [6, 8, 'hi']]])[0].map((a) => a.reading), ['tainu', 'hi']),
  "the page accepts the Worker's romanization of a Gurmukhi line in a Hindi song");

console.log('\n── checking replies ──');

assert(cleanRomanization('pyār') === 'pyar' && cleanRomanization('chǎn') === 'chan', 'accents and tone marks are removed');
assert(cleanRomanization('ʿala') === 'ala' && cleanRomanization('esh-shams') === 'esh-shams', "a leading ʿayn is dropped; a hyphen inside stays");
assert(cleanRomanization('7abibi') === null && cleanRomanization('हम') === null && cleanRomanization('') === null,
  'numbers for sounds, the script itself, or nothing: refused');

const entries = ['तुम ही हो', 'दिल'].map((l) => romanEntry(l, 'hi'));
assert(eq(parseRomanizeReply(entries, [['1', 'tum', 'hi', 'ho'], ['2', 'dil']]), [[[0, 3, 'tum'], [4, 6, 'hi'], [7, 9, 'ho']], [[0, 3, 'dil']]]),
  'a numbered reply becomes each word with its offsets');
assert(eq(parseRomanizeReply(entries, [['1', 'tum hi ho'], ['2', 'dil']]), [null, [[0, 3, 'dil']]]),
  'a line answered with the wrong number of words is dropped, the rest kept');
assert(eq(parseRomanizeReply(entries, [['2', 'dil'], ['1', 'tum', 'हि', 'ho']]), [[[0, 3, 'tum'], [7, 9, 'ho']], [[0, 3, 'dil']]]),
  'entries are paired by number, and a word left in the script is left out');
let threw = false;
try { parseRomanizeReply(entries, [['3', 'x']]); } catch { threw = true; }
assert(threw, 'a reply answering no line is an error, so the chain moves on');

assert(eq(checkRomanizations(['तुम ही हो'], 'hi', [[[0, 3, 'tum'], [4, 6, 'hi']]]), [[{ start: 0, end: 3, reading: 'tum' }, { start: 4, end: 6, reading: 'hi' }]]),
  "the page accepts the Worker's spans");
assert(eq(checkRomanizations(['तुम ही हो'], 'hi', [[[4, 6, 'hi'], [0, 3, 'tum']]]), [null]), 'spans out of order are refused');
assert(eq(checkRomanizations(['तुम hi'], 'hi', [[[4, 6, 'hi']]]), [null]), 'a span over a word not in the script is refused');
assert(eq(checkRomanizations(['तुम'], 'hi', [[[0, 9, 'tum']]]), [null]), 'a span past the end of the line is refused');

const prompt = buildRomanizePrompt([romanEntry('ฉันรักเธอ', 'th')], 'th');
assert(prompt.includes('Thai song lyrics') && prompt.includes('words: ฉัน | รัก | เธอ') && prompt.includes('Royal Thai General System'),
  'the prompt names the language, lists the words, and asks for its spelling');

console.log('\n── the chain ──');

assert(eq(ROMANIZE_CHAINS.el, [RULES_STEP]) && ROMANIZE_CHAINS.hi.at(-1) === RULES_STEP && !ROMANIZE_CHAINS.th.includes(RULES_STEP),
  'Greek by rules only; Hindi falls back to rules; Thai, Arabic and Hebrew use models only');
assert((await romanizeCacheKey('hi', ['a'])) !== (await romanizeCacheKey('mr', ['a'])) && (await romanizeCacheKey('hi', ['a'])).startsWith('romanize:v3:hi:'),
  'stored romanizations are keyed by language and lines');

const realFetch = globalThis.fetch;
const asked = [];
function stubWorker(reply) {
  globalThis.fetch = async (url, init) => {
    const body = JSON.parse(init.body);
    asked.push({ url, ...body });
    return reply(body);
  };
}
const json = (data, status = 200) => new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });

const greekResult = await fetchRomanization(['Σ’ αγαπώ', 'oh yeah'], { group: 'el', workerUrl: 'http://w' });
assert(eq(greekResult, [[{ start: 0, end: 2, reading: 'S' }, { start: 3, end: 8, reading: 'agapo' }], []]) && asked.length === 0,
  'Greek is romanized in the page, without asking the Worker');

stubWorker((body) => (body.model === 'gemini-3.1-flash-lite'
  ? json({ romanized: [[[0, 3, 'tum']], null], model: body.model })
  : json({ error: 'busy' }, 503)));
let steps = [];
const hiResult = await fetchRomanization(['तुम ही', 'दिल', 'तुम ही'], { group: 'hi', language: 'hi', workerUrl: 'http://w', onStep: (s) => steps.push(s) });
assert(eq(hiResult.map((l) => l && l.map((a) => a.reading)), [['tum', 'hi'], ['dil'], ['tum', 'hi']]),
  "the rules fill the words both models left, and a repeated line shares its romanization");
assert(eq(steps.map((s) => [s.step, s.ok, s.filled]), [['gemini-3.1-flash-lite', true, 1], ['gemini-3.5-flash-lite', false, 0], [RULES_STEP, true, 2]]),
  'each step reports what it filled');
assert(romanizationLabel(steps) === '3.1+rules', 'the panel names the sources that filled words: 3.1+rules');
assert(eq(asked[0].lines, ['तुम ही', 'दिल']) && asked[0].language === 'hi' && asked[1].lines.length === 2,
  'the Worker is asked for each distinct line, with the language');

asked.length = 0;
stubWorker(() => json({ romanized: [[[0, 6, 'chanrak'], [6, 9, 'thoe']]], model: 'gemini-3.1-flash-lite', cached: true }));
steps = [];
const thResult = await fetchRomanization(['ฉันรักเธอ'], { group: 'th', workerUrl: 'http://w', onStep: (s) => steps.push(s) });
assert(eq(thResult, [[{ start: 0, end: 6, reading: 'chanrak' }, { start: 6, end: 9, reading: 'thoe' }]]),
  "a Thai line split differently by the Worker is drawn over the Worker's words");
assert(romanizationLabel(steps) === '3.1 (stored)', 'stored romanizations show as such');

stubWorker(() => json({ error: 'no key' }, 501));
steps = [];
assert(await fetchRomanization(['ฉันรักเธอ'], { group: 'th', workerUrl: 'http://w', onStep: (s) => steps.push(s) }) === null,
  'with the Worker unconfigured, Thai shows no romanization');
assert(steps.length === 1 && romanizationLabel(steps) === '×', 'and the model after the first is not asked; the panel shows ×');
globalThis.fetch = realFetch;

console.log('\n── drawing ──');

const line = 'तुम ही हो';
const annotations = romanizeByRules([line], 'hi')[0];
assert(eq(furiganaSegments(line, annotations).map((s) => [s.text, s.reading || null]), [['तुम', 'tum'], [' ', null], ['ही', 'hi'], [' ', null], ['हो', 'ho']]),
  "a line is drawn as each word over its romanization, with furigana's layout");
const groups = layoutWordFurigana(line, ['तुम ', 'ही ', 'हो'], annotations);
assert(groups && eq(groups.filter((g) => g.reading).map((g) => g.reading), ['tum', 'hi', 'ho']), 'word-synced lines keep each word timed');
assert(sourcePanelText({ lyrics: 'LRCLIB', translation: null, furigana: null, romanization: '3.1' }) === 'LRCLIB | – | 3.1',
  'romanization shows in the third slot of the source panel');

console.log('\n── scoring ──');

assert(looseKey('hawaayein') === looseKey('hawaayen') && looseKey('nahin') === looseKey('nahi') && looseKey('wafa') === looseKey('vafa'),
  'loose scoring folds spelling variants of one sound');
assert(looseKey('tujhe') !== looseKey('tuje') && looseKey('dil') !== looseKey('dal'), 'but not different sounds');

console.log(`\n${'─'.repeat(40)}`);
console.log(`Results: ${passed} passed, ${failed} failed, ${passed + failed} total`);

if (failed > 0) {
  process.exit(1);
}
