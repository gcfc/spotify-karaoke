/**
 * Unit tests for lyrics translation — language gating, batching plan and
 * response handling. Runs entirely offline; the provider calls are stubbed.
 *
 * All sample text below is ordinary prose written for these tests, not
 * lyrics from any song.
 *
 * Usage:  node tests/test_translate.mjs
 */

import {
  applyTranslationPlan,
  decodeHtmlEntities,
  detectLyricsLanguage,
  googleTargetCode,
  planTranslation,
  shouldOfferTranslation,
  translateLines,
} from '../translate.js';

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

// ── 1. Language detection ──

console.log('\n── detectLyricsLanguage ──');

assert(detectLyricsLanguage('', 'ja') === 'ja', 'a declared language wins outright');
assert(detectLyricsLanguage('', 'zh-Hant') === 'zh', 'a declared regional tag reduces to its base');
assert(detectLyricsLanguage('', 'en-US') === 'en', 'en-US reduces to en');

assert(detectLyricsLanguage('昨日の夜は雨が降っていた') === 'ja',
  'kana marks Japanese even though the text also uses Han');
assert(detectLyricsLanguage('오늘은 하늘이 맑다') === 'ko', 'Hangul marks Korean');
assert(detectLyricsLanguage('今天天气很好我们去公园') === 'zh', 'Han alone marks Chinese');
assert(detectLyricsLanguage('Сегодня хорошая погода') === 'ru', 'Cyrillic marks Russian');
assert(detectLyricsLanguage('اليوم الطقس جميل') === 'ar', 'Arabic script detected');
assert(detectLyricsLanguage('วันนี้อากาศดี') === 'th', 'Thai script detected');

assert(detectLyricsLanguage('I know that you have been waiting for me all of this time')
  === 'en', 'English prose is recognised as English');
assert(detectLyricsLanguage('And I would just like to know what they are doing over there')
  === 'en', 'a second English sample is recognised');

assert(detectLyricsLanguage('Guten Morgen wie geht es dir heute mein Freund') === 'und',
  'German is flagged as non-English Latin');
assert(detectLyricsLanguage('Buenos dias como estas hoy mi querido amigo') === 'und',
  'Spanish is flagged as non-English Latin');
assert(detectLyricsLanguage('Bonjour comment allez vous aujourd hui mon ami') === 'und',
  'French is flagged as non-English Latin');

assert(detectLyricsLanguage('') === '', 'empty text yields no language');
assert(detectLyricsLanguage('   \n  ') === '', 'whitespace yields no language');
assert(detectLyricsLanguage('Oh oh oh') === '', 'too few tokens to judge yields no language');

// ── 2. Gating ──

console.log('\n── shouldOfferTranslation ──');

assert(shouldOfferTranslation('en') === false, 'English is not offered translation');
assert(shouldOfferTranslation('zh') === false, 'Chinese is not offered translation');
assert(shouldOfferTranslation('') === false, 'unknown language is not offered translation');
assert(shouldOfferTranslation('ja') === true, 'Japanese is offered translation');
assert(shouldOfferTranslation('und') === true, 'non-English Latin is offered translation');

assert(googleTargetCode('zh') === 'zh-CN' && googleTargetCode('en') === 'en',
  'Chinese target maps to the Simplified region code');

// ── 3. Batching plan ──

console.log('\n── planTranslation ──');

const lines = ['Erste Zeile', '', 'Zweite Zeile', 'Erste Zeile', '   ', 'Dritte Zeile'];
const plan = planTranslation(lines);

assert(plan.unique.length === 3, 'blank lines are skipped and repeats collapse to one request');
assert(plan.slots.length === lines.length, 'every original line keeps a slot');
assert(plan.slots[0] === plan.slots[3], 'a repeated line points at the same translation');
assert(plan.slots[1] === -1 && plan.slots[4] === -1, 'blank and whitespace-only lines have no slot');

const scattered = applyTranslationPlan(plan.slots, ['First line', 'Second line', 'Third line']);
assert(scattered.length === lines.length, 'scattering restores the original length');
assert(scattered[0] === 'First line' && scattered[3] === 'First line',
  'the repeated line gets the same translation back');
assert(scattered[1] === '' && scattered[4] === '', 'blank lines stay blank');
assert(scattered[5] === 'Third line', 'the last line lands in the right slot');

// ── 4. Entity decoding ──

console.log('\n── decodeHtmlEntities ──');

assert(decodeHtmlEntities('It&#39;s fine') === "It's fine", 'numeric entities decode');
assert(decodeHtmlEntities('&quot;quoted&quot;') === '"quoted"', 'named entities decode');
assert(decodeHtmlEntities('a &amp;#39; b') === "a &#39; b", 'ampersand decodes last, not twice');
assert(decodeHtmlEntities('plain text') === 'plain text', 'text without entities is untouched');

// ── 5. translateLines against stubbed providers ──

console.log('\n── translateLines ──');

const realFetch = globalThis.fetch;

// Keyless Google: a nested array whose segments concatenate into the
// translated text, newlines intact.
function stubFreeProvider({ dropALine = false, fail = false } = {}) {
  globalThis.fetch = async (url) => {
    if (fail) return new Response('nope', { status: 500 });
    const q = decodeURIComponent(String(url).split('&q=')[1]);
    let out = q.split('\n').map((l) => `T(${l})`);
    if (dropALine) out = out.slice(0, -1);
    // Google returns the translation split into segments that concatenate
    // back into the text — with its newlines, and no trailing one.
    const text = out.join('\n');
    const mid = Math.ceil(text.length / 2);
    const segments = [[text.slice(0, mid), ''], [text.slice(mid), '']];
    return new Response(JSON.stringify([segments, null, 'de']), { status: 200 });
  };
}

stubFreeProvider();
let result = await translateLines(['Eins', '', 'Zwei', 'Eins'], { target: 'en', provider: 'free' });
assert(result.length === 4, 'free provider returns one entry per original line');
assert(result[0] === 'T(Eins)' && result[3] === 'T(Eins)', 'repeats resolve to the same translation');
assert(result[1] === '', 'the blank line stays blank');

stubFreeProvider({ fail: true });
result = await translateLines(['Eins', 'Zwei'], { target: 'en', provider: 'free' });
assert(result === null, 'a provider error yields null so originals show alone');

// A misaligned reply must never be paired up positionally. With a single
// line left to split, the halving fallback gives up and returns blanks.
stubFreeProvider({ dropALine: true });
result = await translateLines(['Eins', 'Zwei'], { target: 'en', provider: 'free' });
assert(result !== null && result.every((r) => r === ''),
  'a misaligned reply is discarded rather than shifted onto the wrong lines');

// Worker provider.
globalThis.fetch = async (url, opts) => {
  const body = JSON.parse(opts.body);
  return new Response(JSON.stringify({ translations: body.lines.map((l) => `C(${l})`) }), { status: 200 });
};
result = await translateLines(['Eins', '', 'Zwei'], { target: 'zh', provider: 'cloud', workerUrl: 'https://w.test' });
assert(result[0] === 'C(Eins)' && result[1] === '' && result[2] === 'C(Zwei)',
  'cloud provider results land on the right lines');

globalThis.fetch = async () => new Response(JSON.stringify({ error: 'no key' }), { status: 501 });
result = await translateLines(['Eins'], { target: 'en', provider: 'cloud', workerUrl: 'https://w.test' });
assert(result === null, 'a Worker without an API key yields null rather than throwing');

globalThis.fetch = async (url, opts) => {
  const body = JSON.parse(opts.body);
  return new Response(JSON.stringify({ translations: body.lines.slice(1).map((l) => `C(${l})`) }), { status: 200 });
};
result = await translateLines(['Eins', 'Zwei'], { target: 'en', provider: 'cloud', workerUrl: 'https://w.test' });
assert(result === null, 'a misaligned Worker reply is rejected');

result = await translateLines([], { target: 'en', provider: 'free' });
assert(result === null, 'no lines means nothing to translate');

globalThis.fetch = realFetch;

// ── Summary ──

console.log(`\n${'─'.repeat(40)}`);
console.log(`Results: ${passed} passed, ${failed} failed, ${passed + failed} total`);

if (failed > 0) {
  process.exit(1);
}
