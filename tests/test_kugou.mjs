/**
 * Unit tests for the Worker's /kugou-lyrics route, with Kugou's three
 * endpoints stubbed by fixtures modelled on real responses so the matching
 * is checked deterministically and offline:
 *
 *   song search (title, artist, hash, length) → lyric search by hash →
 *   base64 LRC download
 *
 * Kugou lists remixes and live cuts under the same title, so most of these
 * cases are about picking the right recording.
 *
 * Usage:  node tests/test_kugou.mjs
 */

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

const json = (body, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

const song = (singername, songname, duration, hash, filename = `${singername} - ${songname}`) =>
  ({ singername, songname, duration, hash, filename });

// Song search results, in the order Kugou ranks them.  Taken from real
// responses: the original and the 港风电音 remix are both listed under the
// bare title, and only `filename` tells them apart.
const SONG_SEARCH = {
  不能成情人: [
    song('丁家怡', '不能成情人', 194, 'ORIGINAL'),
    song('丁家怡', '不能成情人', 192, 'GANGFENG', '丁家怡 - 不能成情人 (港风电音)'),
    song('丁家怡', '不能成情人 (开平DJ小鱼版)', 178, 'DJ'),
    song('鱼蛋', '不能成情人', 167, 'COVER'),
  ],
  // Live cut ranked first on purpose: the studio recording should still win.
  小幸运: [
    song('田馥甄', '小幸运 (2015如果巡回演唱会高雄站)', 266, 'LIVE'),
    song('田馥甄', '小幸运', 263, 'STUDIO', '田馥甄 - 小幸运【《我的少女时代》电影主题曲】'),
  ],
};

const LRC = {
  ORIGINAL: '[ti:]\n[offset:0]\n[00:00.00]不能成情人 - 丁家怡\n[00:17.55]轻轻的风 已吹起念记\n[00:20.97]记挂某人 是苦苦回味',
  GANGFENG: '[00:00.00]不能成情人(港风电音)-丁家怡\n[00:00.54]常常叹气 无道理\n[00:03.27]换到共你这种结尾',
  DJ: '[00:00.00]不能成情人 (开平DJ小鱼版) - 丁家怡\n[00:02.44]轻轻的风 已吹起念记',
  STUDIO: '[00:00.00]田馥甄 - 小幸运\n[00:16.00]我听见雨滴落在青青草地',
  LIVE: '[00:00.00]小幸运 (Live)\n[00:20.00]我听见雨滴落在青青草地',
  SNIPPET: '[00:00.00]30 second ringtone cut',
};

// Lyric candidates per recording hash.  ORIGINAL's first candidate is a
// ringtone-length snippet, which has to be skipped.
const LYRIC_SEARCH = {
  ORIGINAL: [
    { id: 'SNIPPET', accesskey: 'k', duration: 30000 },
    { id: 'ORIGINAL', accesskey: 'k', duration: 194000 },
  ],
  GANGFENG: [{ id: 'GANGFENG', accesskey: 'k', duration: 192000 }],
  DJ: [{ id: 'DJ', accesskey: 'k', duration: 178000 }],
  STUDIO: [{ id: 'STUDIO', accesskey: 'k', duration: 263000 }],
  LIVE: [{ id: 'LIVE', accesskey: 'k', duration: 266000 }],
  COVER: [],
};

let requests = [];

// Injected failures, { step, kind, times }: each matching request uses one up.
let faults = [];
const stepOf = (url) => (url.hostname === 'mobilecdn.kugou.com' ? 'song search'
  : url.pathname === '/search' ? 'lyric search' : 'download');
const FAULTS = {
  'network error': () => { throw new TypeError('fetch failed'); },
  503: () => json({ error: 'unavailable' }, 503),
  'non-JSON body': () => new Response('<html>busy</html>', { status: 200 }),
  404: () => json({ status: 404 }, 404),
};

globalThis.fetch = async (input) => {
  const url = new URL(String(input));
  requests.push(url);
  const fault = faults.find((f) => f.step === stepOf(url) && f.times > 0);
  if (fault) {
    fault.times--;
    return FAULTS[fault.kind]();
  }
  const q = url.searchParams;

  if (url.hostname === 'mobilecdn.kugou.com') {
    const keyword = q.get('keyword') || '';
    const key = Object.keys(SONG_SEARCH).find((title) => keyword.includes(title));
    return json({ status: 1, data: { info: key ? SONG_SEARCH[key] : [] } });
  }
  if (url.hostname === 'lyrics.kugou.com' && url.pathname === '/search') {
    return json({ status: 200, candidates: LYRIC_SEARCH[q.get('hash')] || [] });
  }
  if (url.hostname === 'lyrics.kugou.com' && url.pathname === '/download') {
    const lrc = LRC[q.get('id')];
    if (!lrc) return json({ status: 404 }, 404);
    return json({ status: 200, fmt: 'lrc', content: Buffer.from(lrc, 'utf8').toString('base64') });
  }
  return json({ error: 'unexpected request' }, 500);
};

async function kugou(params) {
  requests = [];
  const resp = await worker.fetch(new Request(`https://worker.test/kugou-lyrics?${new URLSearchParams(params)}`), {});
  return { status: resp.status, body: await resp.json() };
}

console.log('\n── Picking the recording ──');

let r = await kugou({ title: '不能成情人', artist: '丁家怡', duration: '194' });
assert(r.status === 200 && r.body.matchedDurationSec === 194,
  'plain title at 194s picks the original');
assert(r.body.syncedLyrics?.includes('[00:17.55]轻轻的风 已吹起念记'),
  'base64 LRC is decoded back to UTF-8 Chinese');

r = await kugou({ title: '不能成情人 (港风电音)', artist: '丁家怡', duration: '192' });
assert(r.status === 200 && r.body.matchedTitle === '不能成情人 (港风电音)',
  'a version suffix on the Spotify title finds that cut via filename, not the original 2s away');
assert(r.body.syncedLyrics?.includes('[00:00.54]常常叹气 无道理')
  && !r.body.syncedLyrics.includes('轻轻的风'),
  '…and returns that cut\'s lyrics, not the original\'s');

r = await kugou({ title: '不能成情人 (开平DJ小鱼版)', artist: '丁家怡', duration: '178' });
assert(r.status === 200 && r.body.matchedDurationSec === 178,
  'the DJ remix is found by its own title and length');

r = await kugou({ title: '小幸運', artist: 'Hebe Tien', duration: '265' });
assert(r.status === 200 && r.body.matchedDurationSec === 263,
  'studio recording beats a live cut inside the tolerance, despite search order and a romanized artist');

console.log('\n── Duration checks ──');

r = await kugou({ title: '不能成情人', artist: '丁家怡', duration: '240' });
assert(r.status === 404,
  'nothing within 5s of the track length → 404 rather than another cut\'s timing');

r = await kugou({ title: '不能成情人', artist: '丁家怡', duration: '194' });
const lyricSearch = requests.find((u) => u.hostname === 'lyrics.kugou.com' && u.pathname === '/search');
const download = requests.find((u) => u.pathname === '/download');
assert(lyricSearch?.searchParams.get('hash') === 'ORIGINAL' && lyricSearch?.searchParams.get('duration') === '194000',
  'lyrics are looked up by the matched recording\'s hash and length');
assert(download?.searchParams.get('id') === 'ORIGINAL',
  'a 30-second snippet listed first is skipped for the full-length lyric');

r = await kugou({ title: '不能成情人', artist: '丁家怡' });
assert(r.status === 200 && r.body.matchedDurationSec === 194,
  'without a duration the length check is skipped and search order decides');

console.log('\n── Failure modes ──');

r = await kugou({ title: '不能成情人', artist: '鱼蛋', duration: '167' });
assert(r.status === 404 && /Lyrics not available/.test(r.body.error),
  'a matched recording with no lyric candidates → 404');

r = await kugou({ title: 'Nonexistent Song', artist: 'Nobody', duration: '200' });
assert(r.status === 404 && /No matching/.test(r.body.error),
  'no matching song → 404');

r = await kugou({ artist: '丁家怡' });
assert(r.status === 400,
  'missing title → 400');

const corsResp = await worker.fetch(new Request('https://worker.test/kugou-lyrics?title=x'), {});
assert(corsResp.headers.get('Access-Control-Allow-Origin') === '*',
  'responses carry the CORS header the page needs');

console.log('\n── Transient failures ──');

const attempts = (step) => requests.filter((u) => stepOf(u) === step).length;
const ORIGINAL_SONG = { title: '不能成情人', artist: '丁家怡', duration: '194' };

for (const [step, kind] of [['song search', 'network error'], ['lyric search', 503], ['download', 'non-JSON body']]) {
  faults = [{ step, kind, times: 1 }];
  r = await kugou(ORIGINAL_SONG);
  assert(r.status === 200 && r.body.syncedLyrics?.includes('轻轻的风') && attempts(step) === 2,
    `a ${kind} on the ${step} is retried once, and the lookup succeeds`);
}

faults = [{ step: 'download', kind: 503, times: 2 }];
r = await kugou(ORIGINAL_SONG);
assert(r.status === 404 && attempts('download') === 2,
  'a failure that repeats is given up after one retry');

faults = [{ step: 'lyric search', kind: 404, times: 1 }];
r = await kugou(ORIGINAL_SONG);
assert(r.status === 404 && attempts('lyric search') === 1,
  'a 4xx is an answer, not a blip, and is not retried');

faults = [];

// ── Summary ──

console.log(`\n${'─'.repeat(40)}`);
console.log(`Results: ${passed} passed, ${failed} failed, ${passed + failed} total`);

if (failed > 0) {
  process.exit(1);
}
