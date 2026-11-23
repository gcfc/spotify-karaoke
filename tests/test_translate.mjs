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
  languageTag,
  sameText,
  leftUntranslated,
  freeScriptGroup,
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
assert(detectLyricsLanguage('But that tеnsion never fades, I know you want it every night') === 'en',
  'a look-alike Cyrillic е typed into an English word does not make the song Russian (The Weeknd, Hong Kong)');
assert(detectLyricsLanguage('I know thіs is what you want, baby, all of the time') === 'en' && detectLyricsLanguage('I lοve you so, every night and all of the time') === 'en',
  'nor a Cyrillic і (Ukrainian) or a Greek ο');
assert(detectLyricsLanguage('Привет, мой друг, как дела?\nI love you, baby, all of the time') === 'ru', 'a Russian line in an English song still counts');
assert(detectLyricsLanguage('Стефанія мамо, мамо') === 'uk' && detectLyricsLanguage('Љубав је') === 'sr' && detectLyricsLanguage('Группа крови') === 'ru',
  "Cyrillic is told apart by each language's own letters, else Russian");
assert(detectLyricsLanguage('ਮੁੰਡਿਆਂ ਤੋਂ ਬਚ ਕੇ ਰਹੀਂ\nOh ho, yeah') === 'pa', 'Gurmukhi marks Punjabi, English lines or not');

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

console.log('\n── lines already in the target language ──');

assert(sameText('It was just two lovers', 'It was just two lovers'), 'a line handed back as it was is the same');
assert(sameText('Like, "Where you at tonight?", got no alibi', 'like where you at tonight got no alibi'),
  'case and punctuation aside');
assert(sameText('You and I got no tears in our eyes', 'You and I got no tears in our eyеs'),
  "a look-alike Cyrillic е in the lyrics, which the translator hands back as a plain e (golden hour's eyеs)");
assert(!sameText('Golden-colored Planet', '黄金色の Planet') && !sameText('When we wake up we\'re gonna fly', '目を覚ませば we\'re gonna fly'),
  'a mixed line that was translated is not');
assert(!sameText('', '') && !sameText('...', '...'), 'nor is nothing, or punctuation alone');
assert(sameText('Él es', 'El es'), 'accents aside');
assert(sameText('I was a ghost, i was alone', 'I was a ghost,i was alone(hah)'), 'and ad-libs in brackets, which translators drop (HUNTR/X, Golden)');
assert(leftUntranslated('영원히 깨질 수 없는', '영원히 깨질 수 없는', 'en') && leftUntranslated("But now that's how i'm getting paid,끝없이 on stage", "But now that's how i'm getting paid, 끝없이 on stage", 'en'),
  'a Korean line, or an English one with a Korean word, handed back unchanged was left untranslated');
assert(!leftUntranslated('Shine', 'Shine', 'en') && !leftUntranslated('tears in our eyеs', 'tears in our eyes', 'en') && !leftUntranslated('영원히', 'Forever', 'en'),
  'an English line handed back, look-alike letters and all, is just already English; a translated one is translated');
assert(leftUntranslated('Shine', 'Shine', 'zh'), 'but not when translating to Chinese');
assert(freeScriptGroup('영원히 깨질 수 없는') === 'ko' && freeScriptGroup("getting paid,끝없이 on stage") === 'ko' && freeScriptGroup('Shine on') === 'latin',
  "the keyless Google requests group lines by script: a Korean word puts a line with the Korean");
assert(freeScriptGroup('tears in our eyеs') === 'latin' && freeScriptGroup('雨') === 'zh' && freeScriptGroup('雨', true) === 'ja',
  "a look-alike letter does not; a kanji-only line of a Japanese song goes with the Japanese");

console.log('\n── languageTag ──');

assert(languageTag('zh') === 'zh-Hans', 'Chinese is tagged Simplified, as it is shown');
assert(languageTag('ja') === 'ja' && languageTag('ar') === 'ar' && languageTag('en') === 'en', 'other languages keep their code');
assert(languageTag('und') === '' && languageTag('') === '' && languageTag(undefined) === '', 'an undetermined language gets no tag');

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

// A translator hands lines already in the target language back as they were.
globalThis.fetch = async (url, opts) => {
  const body = JSON.parse(opts.body);
  return new Response(JSON.stringify({ translations: body.lines.map((l) => (/[ぁ-ん]/.test(l) ? 'Arrived at a secret' : l.replace('е', 'e'))) }), { status: 200 });
};
result = await translateLines(['Shine', 'たどり着いた Secret', 'tears in our eyеs', 'Shine'], { target: 'en', provider: 'cloud', workerUrl: 'https://w.test' });
assert(result[0] === '' && result[2] === '' && result[3] === '' && result[1] === 'Arrived at a secret',
  'lines already in the target language get no translation; the rest keep theirs');

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

// The keyless endpoint detects one language per request.  This stand-in
// does the same: a request mostly in Korean is translated, anything else
// handed back as it was — what Google did with Golden sent whole.
function stubMajorityGoogle() {
  const requests = [];
  globalThis.fetch = async (url) => {
    const q = decodeURIComponent(String(url).split('&q=')[1]);
    requests.push(q);
    const lines = q.split('\n');
    const korean = lines.filter((l) => /[\uac00-\ud7af]/.test(l)).length * 2 > lines.length;
    const text = lines.map((l) => (korean ? `en(${l})` : l)).join('\n');
    return new Response(JSON.stringify([[[text, '']], null, korean ? 'ko' : 'en']), { status: 200 });
  };
  return requests;
}
const golden = ['I was a ghost', 'Shine', 'We shine', 'Up up up', '영원히 깨질 수 없는', 'Gonna be golden', '밝게 빛나는 우린', 'Oh'];
resetProviderHealth();
let googleRequests = stubMajorityGoogle();
result = await translateLines(golden, { target: 'en', provider: 'free' });
assert(googleRequests.length === 2, 'the keyless endpoint gets one request for the English lines and one for the Korean');
assert(result[4] === 'en(영원히 깨질 수 없는)' && result[6] === 'en(밝게 빛나는 우린)', 'so the Korean lines are translated');
assert(result[0] === '' && result[1] === '', 'and the English lines, handed back, show none');

// A fast answer that left lines untranslated must not beat a complete one.
resetProviderHealth();
globalThis.fetch = async (url, opts) => {
  if (String(url).includes('translate.googleapis.com')) {
    const q = decodeURIComponent(String(url).split('&q=')[1]);
    return new Response(JSON.stringify([[[q, '']], null, 'en']), { status: 200 });   // every line handed back
  }
  await new Promise((r) => setTimeout(r, 150));
  const body = JSON.parse(opts.body);
  return new Response(JSON.stringify({ translations: body.lines.map((l) => (/[\uac00-\ud7af]/.test(l) ? 'Forever unbreakable' : l)), modelVersion: 'gemini-3.5-flash-lite' }), { status: 200 });
};
let servedBy = null;
result = await translateLines(golden, { ...CHAIN_OPTS, hedgeDelayMs: 20, onServed: (sv) => { servedBy = sv.provider; } });
assert(servedBy === 'gemini-flash-lite-latest' && result[4] === 'Forever unbreakable',
  "a faster answer that left the Korean untranslated loses to the model's complete one");

resetProviderHealth();
globalThis.fetch = async (url) => {
  if (String(url).includes('translate.googleapis.com')) {
    const q = decodeURIComponent(String(url).split('&q=')[1]);
    return new Response(JSON.stringify([[[q, '']], null, 'en']), { status: 200 });
  }
  return new Response('down', { status: 500 });
};
result = await translateLines(golden, { ...CHAIN_OPTS, hedgeDelayMs: 20 });
assert(Array.isArray(result) && result.every((r) => r === ''), 'with nothing better, the incomplete answer is still used, its unchanged lines left out');

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

// ── 9. Which source served — for the page's source panel ──

console.log('\n── onServed ──');

let served = null;
const onServed = (s) => { served = s; };

resetProviderHealth();
globalThis.fetch = async (url, opts) => {
  const body = JSON.parse(opts.body);
  return new Response(JSON.stringify({
    translations: body.lines.map((l) => `g(${l})`), model: 'gemini-flash-lite-latest', modelVersion: 'gemini-3.5-flash-lite',
  }), { status: 200 });
};
await translateLines(two, { ...CHAIN_OPTS, onServed });
assert(served?.provider === 'gemini-flash-lite-latest' && served.model === 'gemini-3.5-flash-lite',
  'an LLM reports the model version that answered, not just the alias asked');

resetProviderHealth();
served = null;
stubChain();
await translateLines(two, { ...CHAIN_OPTS, onServed });
assert(served?.provider === 'gemini-flash-lite-latest' && served.model === 'gemini-flash-lite-latest',
  "an older Worker that does not name the version: the provider's own name stands in");

resetProviderHealth();
served = null;
stubChain({ gemini: 'fail' });
await translateLines(two, { ...CHAIN_OPTS, onServed });
assert(served?.provider === 'free' && served.model === null, 'the keyless provider reports itself, with no model');

resetProviderHealth();
served = null;
stubChain();
await translateLines(two, { ...CHAIN_OPTS, provider: 'cloud', onServed });
assert(served?.provider === 'cloud', 'a pinned provider reports itself');

resetProviderHealth();
served = null;
stubChain({ gemini: 'fail', free: 'fail', cloud: 'fail' });
await translateLines(two, { ...CHAIN_OPTS, onServed });
assert(served === null, 'nothing is reported when nothing served');

// The Worker passes on the version Gemini says answered.
const { default: worker } = await import('../worker/worker.js');
globalThis.fetch = async () => new Response(JSON.stringify({
  candidates: [{ content: { parts: [{ text: JSON.stringify(['One', 'Two']) }] } }], modelVersion: 'gemini-3.5-flash-lite',
}), { status: 200 });
const resp = await worker.fetch(new Request('https://w.test/llm-translate', {
  method: 'POST', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ lines: two, target: 'en', provider: 'gemini-flash-lite-latest' }),
}), { GEMINI_API_KEY: 'k' });
const routed = await resp.json();
assert(resp.status === 200 && routed.model === 'gemini-flash-lite-latest' && routed.modelVersion === 'gemini-3.5-flash-lite',
  "the Worker's /llm-translate reports the model version that answered");

globalThis.fetch = realFetch;

// ── Summary ──

console.log(`\n${'─'.repeat(40)}`);
console.log(`Results: ${passed} passed, ${failed} failed, ${passed + failed} total`);

if (failed > 0) {
  process.exit(1);
}
