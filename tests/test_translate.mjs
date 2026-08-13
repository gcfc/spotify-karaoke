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
  buildTranslationPrompt,
  decodeHtmlEntities,
  detectLyricsLanguage,
  findProvider,
  googleTargetCode,
  LLM_CHUNK_LINES,
  normalizeProvider,
  planTranslation,
  resetProviderHealth,
  TRANSLATE_CHAIN,
  shouldOfferTranslation,
  TRANSLATE_PROVIDERS,
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

// ── 6. Provider registry ──

console.log('\n── providers ──');

assert(TRANSLATE_PROVIDERS.length === 7, 'Default, Better and five models are listed');
assert(findProvider('free') && !findProvider('free').llm, 'the keyless provider is not an LLM');
assert(findProvider('cloud') && !findProvider('cloud').llm, 'the Cloud provider is not an LLM');

const llmProviders = TRANSLATE_PROVIDERS.filter((p) => p.llm);
assert(llmProviders.length === 5, 'five LLM providers are registered');
assert(llmProviders.filter((p) => p.llm.backend === 'gemini').length === 4, 'four are Gemini models');
assert(llmProviders.filter((p) => p.llm.backend === 'openrouter').length === 1, 'one is an OpenRouter model');
assert(llmProviders.every((p) => p.label && p.llm.model), 'every model entry carries a label and a model id');

assert(normalizeProvider('gemini-flash-lite-latest') === 'gemini-flash-lite-latest',
  'a known provider id passes through');
assert(normalizeProvider('made-up-model') === 'free',
  'an unknown provider id falls back to the keyless one');
assert(normalizeProvider(null) === 'free', 'a missing provider id falls back to the keyless one');

// ── 7. LLM prompt and chunking ──

console.log('\n── LLM provider ──');

const prompt = buildTranslationPrompt(['Eins', 'Zwei', 'Drei'], 'zh');
assert(prompt.includes('exactly 3 translations'), 'the prompt states the exact line count');
assert(prompt.includes('Simplified Chinese'), 'the prompt names the target language');
assert(prompt.includes('1. Eins') && prompt.includes('3. Drei'), 'the prompt numbers every line');

// A song longer than one chunk must arrive as several bounded requests.
const many = Array.from({ length: 60 }, (_, i) => `Zeile ${i + 1}`);
const chunkSizes = [];
globalThis.fetch = async (url, opts) => {
  const body = JSON.parse(opts.body);
  chunkSizes.push(body.lines.length);
  return new Response(JSON.stringify({ translations: body.lines.map((l) => `L(${l})`) }), { status: 200 });
};
result = await translateLines(many, { target: 'en', provider: 'gemini-flash-lite-latest', workerUrl: 'https://w.test' });
assert(result.length === 60 && result[59] === 'L(Zeile 60)', 'a long song reassembles in order across chunks');
assert(chunkSizes.length === 3 && chunkSizes.every((n) => n <= LLM_CHUNK_LINES),
  `60 lines split into bounded chunks (${chunkSizes.join('+')})`);

// One bad chunk must sink the whole result rather than shifting later lines.
let call = 0;
globalThis.fetch = async (url, opts) => {
  const body = JSON.parse(opts.body);
  const out = body.lines.map((l) => `L(${l})`);
  if (call++ === 1) out.pop();
  return new Response(JSON.stringify({ translations: out }), { status: 200 });
};
result = await translateLines(many, { target: 'en', provider: 'gemini-flash-lite-latest', workerUrl: 'https://w.test' });
assert(result === null, 'a model that drops a line yields no translation rather than misaligned ones');

globalThis.fetch = async () => new Response(JSON.stringify({ error: 'no key' }), { status: 501 });
result = await translateLines(['Eins'], { target: 'en', provider: 'nemotron-3-super-120b', workerUrl: 'https://w.test' });
assert(result === null, 'an unconfigured model key yields null');

result = await translateLines(['Eins'], { target: 'en', provider: 'gemini-flash-lite-latest' });
assert(result === null, 'an LLM provider without a Worker URL yields null');

// ── 8. The automatic provider chain ──

console.log('\n── provider chain ──');

assert(TRANSLATE_CHAIN.join(' -> ') === 'gemini-flash-lite-latest -> free -> cloud',
  'the model is tried first and the paid provider last');

// Route by URL so each provider can be made to succeed, fail or stall.
function stubChain({ gemini = 'ok', free = 'ok', cloud = 'ok', slowMs = 0 } = {}) {
  const calls = [];
  globalThis.fetch = async (url, opts) => {
    const target = String(url);
    // Order matters: the keyless host is translate.googleapis.com/translate_a,
    // which also contains "/translate".
    let who = 'free';
    if (target.includes('/llm-translate')) who = 'gemini';
    else if (target.includes('translate.googleapis.com')) who = 'free';
    else if (target.includes('/translate')) who = 'cloud';
    calls.push(who);

    const mode = { gemini, free, cloud }[who];
    if (mode === 'slow') await new Promise((r) => setTimeout(r, slowMs));
    if (mode === 'fail') return new Response('nope', { status: 500 });

    if (who === 'free') {
      const q = decodeURIComponent(target.split('&q=')[1]);
      const text = q.split('\n').map((l) => `free(${l})`).join('\n');
      const mid = Math.ceil(text.length / 2);
      return new Response(JSON.stringify([[[text.slice(0, mid), ''], [text.slice(mid), '']], null, 'de']), { status: 200 });
    }
    const body = JSON.parse(opts.body);
    return new Response(JSON.stringify({ translations: body.lines.map((l) => `${who}(${l})`) }), { status: 200 });
  };
  return calls;
}

const CHAIN_OPTS = { target: 'en', workerUrl: 'https://w.test' };
const two = ['Eins', 'Zwei'];

resetProviderHealth();
let calls = stubChain();
result = await translateLines(two, CHAIN_OPTS);
assert(result[0] === 'gemini(Eins)', 'a healthy chain is served by the first provider');
assert(calls.length === 1 && calls[0] === 'gemini', 'no other provider is called when the first succeeds');

resetProviderHealth();
calls = stubChain({ gemini: 'fail' });
result = await translateLines(two, CHAIN_OPTS);
assert(result[0] === 'free(Eins)', 'a failing model falls through to the keyless provider');
assert(!calls.includes('cloud'), 'the paid provider is not called once a free one succeeds');

resetProviderHealth();
calls = stubChain({ gemini: 'fail', free: 'fail' });
result = await translateLines(two, CHAIN_OPTS);
assert(result[0] === 'cloud(Eins)', 'the paid provider catches the case where both free ones fail');

resetProviderHealth();
stubChain({ gemini: 'fail', free: 'fail', cloud: 'fail' });
result = await translateLines(two, CHAIN_OPTS);
assert(result === null, 'a chain that fails outright yields no translation');

// Sticky failure: the second track must not pay for the first track's timeout.
resetProviderHealth();
calls = stubChain({ gemini: 'fail' });
await translateLines(two, CHAIN_OPTS);
const afterFirst = calls.length;
calls.length = 0;
await translateLines(two, CHAIN_OPTS);
assert(!calls.includes('gemini'),
  'a provider that just failed is skipped on the next track rather than retried');
assert(afterFirst === 2 && calls.length === 1, 'the second attempt makes one call instead of two');

resetProviderHealth();
calls = stubChain({ gemini: 'fail' });
await translateLines(two, CHAIN_OPTS);
calls.length = 0;
resetProviderHealth();
await translateLines(two, CHAIN_OPTS);
assert(calls.includes('gemini'), 'clearing provider health puts a benched provider back in the chain');

// Hedging: a slow first provider must not hold the whole request.
resetProviderHealth();
calls = stubChain({ gemini: 'slow', slowMs: 400 });
let t0 = Date.now();
result = await translateLines(two, { ...CHAIN_OPTS, hedgeDelayMs: 50 });
const elapsed = Date.now() - t0;
assert(calls.includes('free'), 'a slow provider triggers the next one alongside it');
assert(result[0] === 'free(Eins)', 'whichever provider answers first supplies the translation');
assert(elapsed < 400, `the hedge returns before the slow provider does (${elapsed}ms)`);

// A slow provider that is still the only one to answer should still be used.
resetProviderHealth();
stubChain({ gemini: 'slow', slowMs: 120, free: 'fail', cloud: 'fail' });
result = await translateLines(two, { ...CHAIN_OPTS, hedgeDelayMs: 20 });
assert(result[0] === 'gemini(Eins)', 'a slow but successful provider still wins if the others fail');

// A pinned provider skips the chain entirely — the console override.
resetProviderHealth();
calls = stubChain();
result = await translateLines(two, { ...CHAIN_OPTS, provider: 'cloud' });
assert(result[0] === 'cloud(Eins)' && calls.length === 1 && calls[0] === 'cloud',
  'pinning a provider bypasses the chain');

resetProviderHealth();
stubChain({ cloud: 'fail' });
result = await translateLines(two, { ...CHAIN_OPTS, provider: 'cloud' });
assert(result === null, 'a pinned provider that fails does not fall back');

globalThis.fetch = realFetch;

// ── Summary ──

console.log(`\n${'─'.repeat(40)}`);
console.log(`Results: ${passed} passed, ${failed} failed, ${passed + failed} total`);

if (failed > 0) {
  process.exit(1);
}
