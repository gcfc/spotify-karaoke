/**
 * Unit tests for furigana — run splitting, reply checking, the lyrics' own
 * bracketed readings, layout over word-synced syllables, the page's fetch,
 * and the Worker's /furigana route.  Runs entirely offline; Gemini and the
 * Worker are stubbed.
 *
 * Sample lines are written for these tests, not taken from songs.
 *
 * Usage:  node tests/test_furigana.mjs
 */

import fs from 'node:fs';
import {
  annotate,
  buildFuriganaPrompt,
  checkFuriganaReadings,
  fetchFurigana,
  FURIGANA_ALLOWED_MODELS,
  FURIGANA_CHUNK_LINES,
  FURIGANA_MAX_LINES,
  FURIGANA_MODELS,
  furiganaEntry,
  furiganaSegments,
  geminiFuriganaRequest,
  hasKanji,
  inlineReadings,
  isKana,
  kanjiRuns,
  layoutWordFurigana,
  mergeInlineReadings,
  parseFuriganaReply,
  planFurigana,
  stripSuffix,
} from '../furigana.js';
import worker from '../worker/worker.js';

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
const texts = (runs) => runs.map((r) => r.text);

// ── 1. Kanji runs ──

console.log('\n── kanjiRuns ──');

assert(eq(texts(kanjiRuns('雨が降り止む')), ['雨', '降', '止']), 'kana splits runs');
assert(eq(texts(kanjiRuns('日々の暮らし')), ['日々', '暮']), '々 stays with the kanji it repeats');
assert(eq(texts(kanjiRuns('2人の影')), ['2人', '影']), 'digits written against kanji join the run (2人 is ふたり)');
assert(eq(texts(kanjiRuns('三ヶ月ぶり')), ['三ヶ月']), 'the counter ヶ stays inside its run');
assert(eq(texts(kanjiRuns('〆切まで')), ['〆切']), '〆 counts as kanji');
assert(eq(texts(kanjiRuns('ケーキ屋さん')), ['屋']), 'katakana splits runs');
assert(eq(texts(kanjiRuns('123 Go ラララ')), []), 'digits alone need no reading');
assert(eq(texts(kanjiRuns('𠮟られた')), ['𠮟']), 'kanji outside the basic block are found');
const offsets = kanjiRuns('今、夜に');
assert(offsets[0].start === 0 && offsets[1].start === 2 && offsets[1].end === 3, 'runs carry offsets into the line');
assert(hasKanji('ひらがな漢') && !hasKanji('ひらがな 123'), 'hasKanji');

// ── 2. What the model is asked ──

console.log('\n── furiganaEntry / prompt ──');

let entry = furiganaEntry('全てが分かった');
assert(eq(entry.runs, [{ text: '全', suffix: 'てが' }, { text: '分', suffix: 'かった' }]),
  'each run goes with the kana after it');
entry = furiganaEntry('夜ニ紛レ');
assert(eq(entry.runs.map((r) => r.suffix), ['ニ', 'レ']), 'katakana written after a run is its tail too');
entry = furiganaEntry('泣いていくのだろう');
assert(entry.runs[0].suffix === 'いていく', 'a long kana tail is capped at four');
entry = furiganaEntry('溢(こぼ)れた、二人今');
assert(entry.runs[0].suffix === '' && entry.runs[1].suffix === '', 'no tail across brackets, punctuation or the end');

const prompt = buildFuriganaPrompt([furiganaEntry('全てが分かった'), furiganaEntry('夜')]);
assert(prompt.includes('These are 2 lines') && prompt.includes('each of the 2 lines'), 'the prompt states the line count');
assert(prompt.includes('pieces: 全てが | 分かった'), 'the prompt lists each piece with its kana');
const body = geminiFuriganaRequest([furiganaEntry('夜')]);
assert(body.generationConfig.temperature === 0 && body.generationConfig.responseSchema.type === 'ARRAY',
  'the request pins temperature 0 and a nested-array schema');

// The prompt's examples must not be words the evaluation scores, or the
// prompt would hand the model its answers.
const gold = JSON.parse(fs.readFileSync(new URL('./furigana_gold.json', import.meta.url), 'utf8'));
const keyKanji = new Set(gold.songs.flatMap((s) => s.lines.flatMap((l) => l.runs.flatMap((r) => [...r.text]))));
const instructions = buildFuriganaPrompt([]).split('Lines:')[0];
const exampleKanji = [...instructions].filter((c) => hasKanji(c));
assert(exampleKanji.length > 0 && exampleKanji.every((c) => !keyKanji.has(c)),
  `the prompt's examples share no kanji with the answer key (${exampleKanji.join('')})`);

// ── 3. Cutting the kana tail ──

console.log('\n── stripSuffix ──');

assert(stripSuffix('すべてが', 'てが') === 'すべ', 'the tail is cut');
assert(stripSuffix('ぼくわ', 'わ') === 'ぼく' && stripSuffix('ぼくわ', 'は') === 'ぼく', 'は written as sung (わ) still matches');
assert(stripSuffix('みちお', 'を') === 'みち' && stripSuffix('うちえ', 'へ') === 'うち', 'を and へ as sung match too');
assert(stripSuffix('よるに', 'ニ') === 'よる', 'a katakana tail matches its hiragana');
assert(stripSuffix('ひとりでに', 'で') === null, 'a reading that ran past the piece is refused');
assert(stripSuffix('て', 'て') === null, 'a reading that is all tail is refused');
assert(stripSuffix('なみだ', '') === 'なみだ', 'no tail, nothing cut');
assert(stripSuffix('あいだだけ', 'だけ') === 'あいだ', 'a reading that ends like its tail is cut only once');

// ── 4. Checking a model reply ──

console.log('\n── parseFuriganaReply ──');

const entries = [furiganaEntry('全てが分かった'), furiganaEntry('一人で帰る'), furiganaEntry('本気で')];
const numbered = (...lists) => lists.map((readings, i) => [String(i + 1), ...readings]);

let parsed = parseFuriganaReply(entries, numbered(
  ['すべてが', 'わかった'],
  ['ひとりでに', 'かえる'],     // ran past its piece
  ['マジで'],                   // a katakana reading is a reading
));
assert(eq(parsed[0], ['すべ', 'わ']), 'good readings come back without their tails');
assert(eq(parsed[1], [null, 'かえ']), 'one bad reading costs that run, not the line');
assert(eq(parsed[2], ['マジ']), 'katakana readings are kept as written');

parsed = parseFuriganaReply(entries, numbered(['すべてが'], ['ひと りで', ' かえる '], ['本気で']));
assert(parsed[0] === null, 'a line with the wrong number of readings is dropped');
assert(eq(parsed[1], ['ひとり', 'かえ']), 'spaces inside a reading are removed');
assert(parsed[2] === null, 'a line with no usable reading is dropped');

parsed = parseFuriganaReply(entries, [
  ['3', 'まじで'],
  ['1', 'すべてが', 'わかった'],
]);
assert(eq(parsed, [['すべ', 'わ'], null, ['まじ']]),
  'entries pair by their line number: a line left out is null and the rest stay in place');
parsed = parseFuriganaReply(entries, [
  ['1', 'すべてが', 'わかった'],
  ['2', 'ひとりで', 'かえる'],
  ['2', 'ふたりで', 'かえる'],
]);
assert(parsed[1] === null && parsed[0] !== null, 'a line answered twice is not trusted');
parsed = parseFuriganaReply(entries, [['すべてが', 'わかった'], ['1', 'すべてが', 'わかった']]);
assert(eq(parsed[0], ['すべ', 'わ']), 'an entry without a number is ignored');

let threw = false;
try { parseFuriganaReply(entries, [['9', 'よ']]); } catch { threw = true; }
assert(threw, 'a reply that answers no line throws, so the next model is tried');
threw = false;
try { parseFuriganaReply(entries, { lines: [] }); } catch { threw = true; }
assert(threw, 'a reply that is not a list throws');
assert(isKana('ぎゅー') && !isKana('kana') && !isKana('漢'), 'isKana');

// ── 5. Readings printed in the lyrics ──

console.log('\n── inline readings ──');

const printedLine = '涙が溢(こぼ)れた夜';
const inline = inlineReadings(printedLine);
assert(inline.length === 1 && inline[0].reading === 'こぼ' && printedLine.slice(inline[0].start, inline[0].end) === '溢',
  'a bracketed reading attaches to the run before it');
assert(printedLine.slice(inline[0].end, inline[0].hideEnd) === '(こぼ)', 'the bracket is marked for hiding');
assert(inlineReadings('終幕（さいご）は').length === 1, 'full-width brackets work too');
assert(inlineReadings('ラララ(らららー)').length === 0, 'a bracket after kana is not a reading');
assert(inlineReadings('夜 (night)').length === 0, 'a bracket of English is not a reading');

const fromModel = annotate(printedLine, ['なみだ', 'あふ', 'よる']);
const merged = mergeInlineReadings(printedLine, fromModel);
assert(eq(merged.map((a) => a.reading), ['なみだ', 'こぼ', 'よる']), "the lyrics' own reading beats the model's");
const onlyPrinted = mergeInlineReadings(printedLine, null);
assert(onlyPrinted.length === 1 && onlyPrinted[0].reading === 'こぼ', 'a line the model failed still gets its printed reading');
assert(mergeInlineReadings('雨', null) === null, 'nothing printed and nothing from the model stays null');

// ── 6. Layout ──

console.log('\n── furiganaSegments ──');

const segLine = '雨が降り止む';
const segs = furiganaSegments(segLine, annotate(segLine, ['あめ', 'ふ', 'や']));
assert(segs.map((s) => s.text).join('') === segLine, 'segments join back into the line');
assert(eq(segs.filter((s) => s.reading).map((s) => `${s.text}:${s.reading}`), ['雨:あめ', '降:ふ', '止:や']),
  'each run carries its reading');
const printedSegs = furiganaSegments(printedLine, merged);
assert(printedSegs.map((s) => s.text).join('') === '涙が溢れた夜', 'the printed bracket is left out once it is ruby');
assert(eq(annotate('雨が降る', ['あめ', null]).map((a) => a.reading), ['あめ']), 'a run without a reading gets no ruby');

console.log('\n── layoutWordFurigana ──');

const wordLine = '二人で歩いた';
let groups = layoutWordFurigana(wordLine, ['二', '人で', '歩いた'], annotate(wordLine, ['ふたり', 'ある']));
assert(groups[0].reading === 'ふたり' && eq(groups[0].fragments.map((f) => f.pieceIndex), [0, 1]),
  'a run over two syllables is one ruby holding both');
assert(groups[1].fragments[0].text === 'で' && groups[1].fragments[0].pieceIndex === 1 && !groups[1].reading,
  'the rest of a cut syllable keeps its syllable index');
assert(groups.flatMap((g) => g.fragments).map((f) => f.text).join('') === wordLine, 'fragments join back into the line');
const lasts = groups.flatMap((g) => g.fragments).filter((f) => f.lastOfPiece).map((f) => f.pieceIndex);
assert(eq(lasts, [0, 1, 2]), 'each syllable ends exactly once (where its space goes)');

groups = layoutWordFurigana(printedLine, ['涙が', '溢(こぼ)', 'れた', '夜'], merged);
const shown = groups.flatMap((g) => g.fragments);
assert(shown.map((f) => f.text).join('') === '涙が溢れた夜', 'a printed bracket is hidden in word-synced lines too');
assert(shown.find((f) => f.text === '溢').lastOfPiece, 'a syllable whose last part was hidden still ends once');

assert(layoutWordFurigana('雨が降る', ['雨が', '雪'], annotate('雨が降る', ['あめ', 'ふ'])) === null,
  'syllables that are not in the line give up on furigana for it');
groups = layoutWordFurigana('雨 降る', ['雨', '降る'], [{ start: 0, end: 3, reading: 'あめふ' }]);
assert(groups.every((g) => !g.reading), 'a run spanning a gap between syllables goes without a reading');

// ── 7. Planning and the page's check ──

console.log('\n── planFurigana / checkFuriganaReadings ──');

const plan = planFurigana(['夜', 'ラララ', '', '夜', '朝']);
assert(eq(plan.unique, ['夜', '朝']) && eq(plan.slots, [0, -1, -1, 0, 1]), 'kana-only lines are skipped and repeats sent once');

threw = false;
try { checkFuriganaReadings(['夜'], []); } catch { threw = true; }
assert(threw, 'a Worker reply of the wrong length throws');
const checked = checkFuriganaReadings(['夜の雨', '朝', '昼'], [['よる', 'yoru'], ['あさ', 'x'], 'ひる']);
assert(eq(checked, [['よる', null], null, null]), 'the page drops bad readings and wrongly shaped lines');

// ── 8. fetchFurigana against a stubbed Worker ──

console.log('\n── fetchFurigana ──');

const realFetch = globalThis.fetch;
const realDebug = console.debug;
console.debug = () => {};

function stubWorker(handler) {
  const calls = [];
  globalThis.fetch = async (url, init) => {
    const req = JSON.parse(init.body);
    calls.push({ url: String(url), ...req });
    return handler(req, calls.length);
  };
  return calls;
}
const readAll = (req) => new Response(JSON.stringify({
  readings: req.lines.map((l) => kanjiRuns(l).map((r) => 'よ'.repeat(r.text.length))),
}), { status: 200 });

let calls = stubWorker(readAll);
let result = await fetchFurigana(['夜の雨', 'ラララ', '夜の雨', '朝'], { workerUrl: 'https://w.test' });
assert(calls.length === 1 && calls[0].url === 'https://w.test/furigana', 'one request to the Worker for a short song');
assert(eq(calls[0].lines, ['夜の雨', '朝']), 'only unique lines with kanji are sent');
assert(result.length === 4 && eq(result[1], []) && eq(result[0], result[2]), 'results line up with every original line');
assert(calls[0].model === FURIGANA_MODELS[0], 'the first model is asked first');

const many = Array.from({ length: 60 }, (_, i) => `第${i + 1}夜`);
calls = stubWorker(readAll);
result = await fetchFurigana(many, { workerUrl: 'https://w.test' });
assert(calls.every((c) => c.lines.length <= FURIGANA_CHUNK_LINES) && calls.length === Math.ceil(60 / FURIGANA_CHUNK_LINES),
  `a long song goes in bounded chunks (${calls.map((c) => c.lines.length).join('+')})`);
assert(result.every((r) => r && r.length > 0), 'every chunk lands on its lines');

let inFlight = 0;
let maxInFlight = 0;
stubWorker(async (req) => {
  inFlight++;
  maxInFlight = Math.max(maxInFlight, inFlight);
  await new Promise((r) => setTimeout(r, 30));
  inFlight--;
  return readAll(req);
});
await fetchFurigana(many, { workerUrl: 'https://w.test' });
assert(maxInFlight === Math.ceil(60 / FURIGANA_CHUNK_LINES), "a song's chunks are requested together, not in turn");

calls = stubWorker((req) => (req.model === FURIGANA_MODELS[0]
  ? new Response('{"error":"busy"}', { status: 503 })
  : readAll(req)));
const chunkLog = [];
result = await fetchFurigana(['夜'], { workerUrl: 'https://w.test', onChunk: (c) => chunkLog.push(c) });
assert(result && eq(calls.map((c) => c.model), FURIGANA_MODELS.slice(0, 2)), 'an overloaded model hands the chunk to the next');
assert(chunkLog[0].ok === false && chunkLog[0].transient === true && chunkLog[1].ok === true, 'onChunk reports each attempt');

calls = stubWorker(() => new Response('{"error":"no key"}', { status: 501 }));
result = await fetchFurigana(['夜'], { workerUrl: 'https://w.test' });
assert(result === null && calls.length === 1, 'a Worker without a key stops at once and shows nothing');

stubWorker(() => new Response('{"error":"bad"}', { status: 502 }));
result = await fetchFurigana(['涙が溢(こぼ)れた', '夜'], { workerUrl: 'https://w.test' });
assert(result && result[0][0].reading === 'こぼ' && result[1] === null,
  'with every model down, printed readings still show and other lines go without');

stubWorker(() => new Response('{"error":"bad"}', { status: 502 }));
result = await fetchFurigana(['夜'], { workerUrl: 'https://w.test' });
assert(result === null, 'with nothing to show at all, the result is null');
assert(await fetchFurigana(['夜'], {}) === null, 'no Worker URL, no furigana');
result = await fetchFurigana(['ラララ'], { workerUrl: 'https://w.test' });
assert(eq(result, [[]]), 'a song without kanji needs no request');

// ── 9. The Worker's /furigana route ──

console.log('\n── Worker /furigana ──');

const ENV = { GEMINI_API_KEY: 'test-key' };
async function post(body, env = ENV) {
  const resp = await worker.fetch(new Request('https://w.test/furigana', {
    method: 'POST', body: JSON.stringify(body), headers: { 'Content-Type': 'application/json' },
  }), env);
  return { status: resp.status, data: await resp.json() };
}
function stubGemini(reply, status = 200) {
  const seen = [];
  globalThis.fetch = async (url, init) => {
    seen.push({ url: String(url), body: JSON.parse(init.body), key: init.headers['x-goog-api-key'] });
    if (status !== 200) return new Response('{"error":{"message":"nope"}}', { status });
    return new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: JSON.stringify(reply) }] } }] }), { status: 200 });
  };
  return seen;
}

let seen = stubGemini([['1', 'すべてが', 'わかった'], ['2', 'よる']]);
let r = await post({ lines: ['全てが分かった', '夜'] });
assert(r.status === 200 && eq(r.data.readings, [['すべ', 'わ'], ['よる']]), 'readings come back with their kana tails cut');
assert(seen[0].url.includes(`/${FURIGANA_MODELS[0]}:generateContent`) && seen[0].key === 'test-key',
  'the default model is called with the key');
assert(seen[0].body.contents[0].parts[0].text.includes('pieces: 全てが | 分かった'), 'the Worker sends the shared prompt');

r = await post({ lines: ['夜'] }, {});
assert(r.status === 501, 'no Gemini key: 501');
r = await post({ lines: ['ラララ'] });
assert(r.status === 400, 'a line without kanji is refused');
r = await post({ lines: Array(FURIGANA_MAX_LINES + 1).fill('夜') });
assert(r.status === 400, 'too many lines are refused');
r = await post({ lines: ['夜'.repeat(301)] });
assert(r.status === 400, 'an overlong line is refused');
r = await post({ lines: ['夜'], model: 'gemini-ultra-unlisted' });
assert(r.status === 400, 'a model outside the allowed list is refused');
assert(FURIGANA_MODELS.every((m) => FURIGANA_ALLOWED_MODELS.includes(m)), 'every model in the chain is allowed');

stubGemini(null, 429);
r = await post({ lines: ['夜'] });
assert(r.status === 429, 'Gemini rate-limiting passes through as 429');
stubGemini(null, 503);
r = await post({ lines: ['夜'] });
assert(r.status === 503, 'Gemini overload passes through as 503');
stubGemini(null, 400);
r = await post({ lines: ['夜'] });
assert(r.status === 502, 'other Gemini failures are 502');
stubGemini([['2', 'よる']]);
r = await post({ lines: ['夜'] });
assert(r.status === 502, 'a reply that answers none of the lines is 502');
stubGemini([['1', 'よる']]);
r = await post({ lines: ['夜', '朝'] });
assert(r.status === 200 && eq(r.data.readings, [['よる'], null]), 'a line the model left out comes back null, the rest intact');

// ── 10. The answer key's own shape ──

console.log('\n── furigana_gold.json ──');

const allRuns = gold.songs.flatMap((s) => s.lines.flatMap((l) => l.runs));
assert(allRuns.length > 0 && allRuns.every((x) => Array.isArray(x.gold) && x.gold.length > 0 && x.gold.every(isKana)),
  `every run in the key has kana answers (${allRuns.length} runs)`);
assert(allRuns.every((x) => gold.categories[x.cat]), 'every run has a known category');
assert(allRuns.every((x) => eq(texts(kanjiRuns(x.text)), [x.text])), 'every keyed run is exactly one kanji run');

globalThis.fetch = realFetch;
console.debug = realDebug;

// ── Summary ──

console.log(`\n${'─'.repeat(40)}`);
console.log(`Results: ${passed} passed, ${failed} failed, ${passed + failed} total`);

if (failed > 0) {
  process.exit(1);
}
