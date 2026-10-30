/**
 * Unit tests for the Worker's /netease-lyrics route, with NetEase's search
 * and lyric endpoints stubbed by fixtures shaped like real responses, so the
 * matching is checked deterministically and offline.
 *
 * NetEase lacks the licence for some catalogues (Jay Chou, BTS) and answers a
 * search for those songs with covers under the same title and length, so
 * several cases here are about refusing a cover.
 *
 * Usage:  node tests/test_netease.mjs
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

const song = (id, name, artists, durationMs) =>
  ({ id, name, artists: artists.map((a) => ({ name: a, alias: [] })), duration: durationMs });

// Search results in the order NetEase ranks them.  Covers come first in the
// cover cases on purpose: the original should still win, or nothing should.
const SEARCH = {
  不能成情人: [
    song(1, '不能成情人', ['丁家怡'], 194040),
    song(2, '不能成情人(港风电音)', ['丁家怡'], 192000),
    song(3, '不能成情人', ['鱼蛋'], 167820),
  ],
  'Blinding Lights': [
    song(10, 'Blinding Lights', ['Piano Echoes'], 200500),
    song(11, 'Blinding Lights', ['The Weeknd'], 200045),
  ],
  Dynamite: [song(20, 'Dynamite（原唱：BTS）', ['柏奈'], 198060)],
  // BTS is on the page under Spotify's name, so 睿轩's cover — whose artist
  // can't be compared with "BTS" on its own — is exposed.
  Butter: [
    song(50, 'Butter (Live)', ['BTS (防弹少年团)'], 250000),
    song(51, 'Butter', ['睿轩'], 164000),
  ],
  // Only the native name is listed, so the romanized one can't be checked.
  晴天: [song(60, '晴天', ['周杰伦'], 269000)],
  // Real page: an unrelated track by an artist named "Eason Chan" must not
  // make 陈奕迅's own listing look like a cover.
  孤勇者: [
    song(70, '孤勇者', ['陈奕迅'], 256000),
    song(71, '回应的', ['Eason Chan'], 106300),
  ],
  稻香: [song(30, '稻香', ['周杰伦'], 223000)],
  心淡: [song(40, '心淡（港风粤语）', ['丁家怡'], 128000)],
};

const LYRIC = {
  1: '[00:00.00] 作词 : 李明声\n[00:17.26]轻轻的风 已吹起念记\n[00:21.10]记挂某人 是苦苦回味',
  2: '[00:00.54]常常叹气 无道理\n[00:03.27]换到共你这种结尾',
  // The covers have lyrics of their own, so only the cover checks keep them out.
  3: '[00:15.00]轻轻的风 已吹起念记',
  10: "[00:29.00]I've been tryna call",
  11: "[00:00.00] 作词 : Abel Tesfaye\n[00:31.250]I've been tryna call",
  20: "[00:05.00]Cause I, I, I'm in the stars tonight",
  51: '[00:10.00]Smooth like butter',
  60: '[00:29.00]故事的小黄花',
  70: '[00:20.00]都是勇敢的',
  // Untimed text in the lrc field — served as plain lyrics by NetEase.
  30: '对这个世界如果你有太多的抱怨\n跌倒了就不敢继续往前走',
};

let searchCode = 200;

globalThis.fetch = async (input) => {
  const url = new URL(String(input));
  if (url.hostname !== 'music.163.com') return json({ error: 'unexpected request' }, 500);

  if (url.pathname === '/api/search/get') {
    if (searchCode !== 200) return json({ code: searchCode, msg: 'Cheating' });
    const q = url.searchParams.get('s') || '';
    const key = Object.keys(SEARCH).find((title) => q.includes(title));
    return json({ code: 200, result: { songs: key ? SEARCH[key] : [], songCount: key ? SEARCH[key].length : 0 } });
  }
  if (url.pathname === '/api/song/lyric') {
    const lyric = LYRIC[url.searchParams.get('id')];
    return json(lyric ? { code: 200, lrc: { version: 1, lyric } } : { code: 200, nolyric: true });
  }
  return json({ error: 'unexpected request' }, 500);
};

async function netease(params) {
  const resp = await worker.fetch(new Request(`https://worker.test/netease-lyrics?${new URLSearchParams(params)}`), {});
  return { status: resp.status, body: await resp.json() };
}

console.log('\n── Picking the recording ──');

let r = await netease({ title: '不能成情人', artist: '丁家怡', duration: '194' });
assert(r.status === 200 && r.body.syncedLyrics?.includes('[00:17.26]轻轻的风 已吹起念记'),
  'plain title at 194s returns the original\'s LRC');

r = await netease({ title: '不能成情人 (港风电音)', artist: '丁家怡', duration: '192' });
assert(r.status === 200 && r.body.syncedLyrics?.includes('[00:00.54]常常叹气 无道理'),
  'a version suffix on the Spotify title picks that cut, 2s from the original');

r = await netease({ title: '不能成情人', artist: '丁家怡', duration: '240' });
assert(r.status === 404,
  'nothing within 5s of the track length → 404');

console.log('\n── Refusing covers ──');

r = await netease({ title: 'Blinding Lights', artist: 'The Weeknd', duration: '200' });
assert(r.status === 200 && r.body.matchedArtist === 'The Weeknd',
  'a cover by another Latin-named artist ranked first is skipped for the original');

r = await netease({ title: '不能成情人', artist: '丁家怡', duration: '168' });
assert(r.status === 404 && /No matching/.test(r.body.error),
  'a same-length cover by another Chinese-named singer is refused');

r = await netease({ title: 'Blinding Lights', artist: 'The Weeknd', duration: '201' });
assert(r.body.matchedArtist !== 'Piano Echoes',
  'a Latin-named cover is never picked, even when it is nearer in length');

r = await netease({ title: 'Dynamite', artist: 'BTS', duration: '199' });
assert(r.status === 404 && /No matching/.test(r.body.error),
  'a cover marked 原唱 in its title is refused even when the artist can\'t be compared');

r = await netease({ title: 'Butter', artist: 'BTS', duration: '164' });
assert(r.status === 404 && /No matching/.test(r.body.error),
  'with the artist credited elsewhere on the page, a cross-script cover is refused');

r = await netease({ title: '晴天', artist: 'Jay Chou', duration: '269' });
assert(r.status === 200 && r.body.matchedArtist === '周杰伦',
  'a romanized artist still finds the native-name original when the page never uses the romanization');

r = await netease({ title: '孤勇者', artist: 'Eason Chan', duration: '256' });
assert(r.status === 200 && r.body.matchedArtist === '陈奕迅',
  'an unrelated track by a same-named artist doesn\'t make the original look like a cover');

console.log('\n── Failure modes ──');

r = await netease({ title: '稻香', artist: 'Jay Chou', duration: '223' });
assert(r.status === 404 && /Synced lyrics not available/.test(r.body.error),
  'untimed text in the lrc field is not passed off as synced');

r = await netease({ title: '心淡（港风粤语）', artist: '丁家怡', duration: '128' });
assert(r.status === 404 && /Synced lyrics not available/.test(r.body.error),
  'a song flagged nolyric → 404');

searchCode = -460;
r = await netease({ title: '不能成情人', artist: '丁家怡', duration: '194' });
assert(r.status === 404 && /No matching/.test(r.body.error),
  'a refused search (code -460) → 404 rather than an error');
searchCode = 200;

r = await netease({ artist: '丁家怡' });
assert(r.status === 400,
  'missing title → 400');

// ── Summary ──

console.log(`\n${'─'.repeat(40)}`);
console.log(`Results: ${passed} passed, ${failed} failed, ${passed + failed} total`);

if (failed > 0) {
  process.exit(1);
}
