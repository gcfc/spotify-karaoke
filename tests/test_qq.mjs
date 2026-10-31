/**
 * Unit tests for the Worker's /qq-lyrics route, with QQ Music's search and
 * lyric endpoints stubbed by fixtures shaped like real responses, so the
 * matching is checked deterministically and offline.
 *
 * QQ carries several cuts of many songs — 起风了 by 买辣椒也用券 is listed at
 * six lengths — and without a length check the first hit wins, which for
 * 起风了 was the 旧版 (old version), 13 seconds shorter than Spotify's.
 *
 * Usage:  node tests/test_qq.mjs
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

const song = (songmid, songname, singers, interval) =>
  ({ songmid, songname, singer: singers.map((name) => ({ name })), interval });

// Search results in the order QQ ranks them.
const SEARCH = {
  起风了: [
    song('OLD', '起风了 (旧版)', ['买辣椒也用券'], 312),
    song('CURRENT', '起风了', ['买辣椒也用券'], 325),
  ],
  不能成情人: [
    song('ORIGINAL', '不能成情人', ['丁家怡'], 194),
    song('GANGFENG', '不能成情人 (港风电音)', ['丁家怡'], 192),
    song('DJ', '不能成情人 (开平DJ小鱼版)', ['丁家怡'], 178),
  ],
};

const LYRIC = {
  OLD: '[00:12.00]这一路上走走停停',
  CURRENT: '[00:25.24]这一路上走走停停\n[00:28.59]顺着少年漂流的痕迹',
  ORIGINAL: '[00:17.55]轻轻的风 已吹起念记',
  GANGFENG: '[00:00.54]常常叹气 无道理',
  DJ: '[00:02.44]轻轻的风 已吹起念记',
};

let requests = [];

globalThis.fetch = async (input) => {
  const url = new URL(String(input));
  requests.push(url);
  if (url.pathname.endsWith('/client_search_cp')) {
    const q = url.searchParams.get('w') || '';
    const key = Object.keys(SEARCH).find((title) => q.includes(title));
    return json({ code: 0, data: { song: { list: key ? SEARCH[key] : [] } } });
  }
  if (url.pathname.endsWith('/fcg_query_lyric_new.fcg')) {
    const lyric = LYRIC[url.searchParams.get('songmid')];
    return json(lyric ? { retcode: 0, lyric } : { retcode: -1901 });
  }
  return json({ error: 'unexpected request' }, 500);
};

async function qq(params) {
  requests = [];
  const resp = await worker.fetch(new Request(`https://worker.test/qq-lyrics?${new URLSearchParams(params)}`), {});
  return { status: resp.status, body: await resp.json() };
}

const lyricRequestFor = () =>
  requests.find((u) => u.pathname.endsWith('/fcg_query_lyric_new.fcg'))?.searchParams.get('songmid');

console.log('\n── Picking the recording by length ──');

let r = await qq({ title: '起风了', artist: '买辣椒也用券', duration: '326' });
assert(r.status === 200 && lyricRequestFor() === 'CURRENT' && r.body.matchedDurationSec === 325,
  'the 325s cut is picked over the 312s 旧版 that QQ lists first');
assert(r.body.syncedLyrics?.includes('[00:25.24]'),
  '…and its lyrics are returned');

r = await qq({ title: '不能成情人 (港风电音)', artist: '丁家怡', duration: '192' });
assert(r.status === 200 && lyricRequestFor() === 'GANGFENG',
  'a version suffix on the Spotify title picks that cut, 2s from the original');

r = await qq({ title: '不能成情人', artist: '丁家怡', duration: '178' });
assert(r.status === 200 && lyricRequestFor() === 'DJ',
  'a length matching only the DJ remix picks the remix');

r = await qq({ title: '不能成情人', artist: '丁家怡', duration: '240' });
assert(r.status === 404 && /No matching/.test(r.body.error),
  'nothing within 5s of the track length → 404 rather than another cut\'s timing');

console.log('\n── Compatibility ──');

r = await qq({ title: '起风了', artist: '买辣椒也用券' });
assert(r.status === 200 && lyricRequestFor() === 'CURRENT',
  'without a duration the length check is skipped, and an exact title still beats 旧版');

r = await qq({ title: 'Nonexistent Song', artist: 'Nobody', duration: '200' });
assert(r.status === 404, 'no matching song → 404');

r = await qq({ artist: '丁家怡' });
assert(r.status === 400, 'missing title → 400');

// ── Summary ──

console.log(`\n${'─'.repeat(40)}`);
console.log(`Results: ${passed} passed, ${failed} failed, ${passed + failed} total`);

if (failed > 0) {
  process.exit(1);
}
