/**
 * Live API tests for the Worker's /kugou-lyrics, /netease-lyrics and
 * /qq-lyrics routes.  Runs the routes in-process against the real services,
 * so it checks the code in this checkout rather than whatever Worker is
 * deployed.
 *
 * QQ refuses search requests from datacenter IPs for stretches at a time
 * (HTTP 500 from its search endpoint, while its lyric endpoint still
 * answers).  Its cases are skipped, not failed, when QQ's own search is
 * refusing — a failure there means the route broke, not QQ.
 *
 * Lookups are paced a second apart, and a case that fails is retried once
 * after two seconds.  A pass on the retry is marked "(passed on retry)" and
 * counted in the summary, so a transient blip doesn't fail the run but stays
 * visible; a real breakage fails both attempts.  (The Worker also retries a
 * transient Kugou or NetEase failure once on its own.)
 *
 * Each case pins the native artist the service should resolve to and one
 * line the lyrics must contain, and checks the matched recording is within
 * the duration tolerance of the Spotify length.  Lines are compared after
 * normalisation, so punctuation, spacing and Traditional/Simplified
 * differences don't matter.
 *
 * Per service a song is either expected ('has'), or only required not to
 * come back as a cover ('no cover') — NetEase lacks the licence for Jay Chou
 * and BTS and answers with other singers' versions.
 *
 * Requires Node.js 18+ (native fetch) and network access.
 *
 * Usage:
 *   node tests/test_cn_lyrics_live.mjs
 */

import worker from '../worker/worker.js';
import { parseLRC } from '../lyrics.js';
import { normalizeForMatch } from '../matching.js';

let passed = 0;
let failed = 0;
let skipped = 0;

function assert(condition, label) {
  if (condition) {
    console.log(`  ✓ ${label}`);
    passed++;
  } else {
    console.error(`  ✗ ${label}`);
    failed++;
  }
}

function skip(label, reason) {
  console.log(`  ⊘ ${label} — skipped: ${reason}`);
  skipped++;
}

const HAS = 'has';
const NO_COVER = 'no cover';

// [Spotify title, Spotify artist, Spotify length (s), native artist, a lyric line, { kugou, netease }]
const SONGS = [
  // The reported case, plus the same singer's other Douyin-era Cantonese
  // releases, which LRCLIB does not carry.
  ['不能成情人', '丁家怡', 194, '丁家怡', '记挂某人 是苦苦回味', { kugou: HAS, netease: HAS }],
  ['心淡（港风粤语）', '丁家怡', 128, '丁家怡', '跌到極麻木 只好相信', { kugou: HAS }],
  ['别挂念我', '丁家怡', 193, '丁家怡', '当天的记忆 不可替代', { kugou: HAS }],
  // Romanized artist names, which the services list under native names.
  ['稻香', 'Jay Chou', 223, '周杰伦', '多少人为生命在努力', { kugou: HAS, netease: NO_COVER }],
  // NetEase's 小幸運 is a fan's cover (田馥甄的小迷妹) that nothing in its
  // listing gives away, so NetEase isn't checked; Kugou outranks it anyway.
  ['小幸運', 'Hebe Tien', 265, '田馥甄', '是生命最好的事情', { kugou: HAS }],
  ['孤勇者', 'Eason Chan', 256, '陈奕迅', '都是勇敢的', { kugou: HAS, netease: HAS }],
  ['光年之外', 'G.E.M.', 235, '邓紫棋', '我们微小得像尘埃', { kugou: HAS, netease: HAS }],
  ['富士山下', 'Eason Chan', 259, '陈奕迅', '原谅我不再送花', { kugou: HAS, netease: HAS }],
  ['海闊天空', 'Beyond', 326, 'BEYOND', '从没有放弃过心中的理想', { kugou: HAS, netease: HAS }],
  ['Lemon', 'Kenshi Yonezu', 255, '米津玄師', '最後にあなたが教えてくれた', { kugou: HAS, netease: HAS }],
  // Japanese, Korean and English.
  ['夜に駆ける', 'YOASOBI', 261, 'YOASOBI', '初めて会った日から', { kugou: HAS, netease: HAS }],
  ['Dynamite', 'BTS', 199, 'BTS', 'Ice tea and a game of ping pong', { kugou: HAS, netease: NO_COVER }],
  ['APT.', 'ROSÉ, Bruno Mars', 170, 'ROSÉ', '아파트 아파트', { kugou: HAS, netease: HAS }],
  ['Blinding Lights', 'The Weeknd', 200, 'The Weeknd', "I'm going through withdrawals", { kugou: HAS, netease: HAS }],
  ['Bohemian Rhapsody - Remastered 2011', 'Queen', 355, 'Queen', 'Mama just killed a man', { kugou: HAS, netease: HAS }],
];

// Pacing and one retry.  Each lookup waits PACE_MS after the last, so a run
// doesn't burst requests at services that block bursts.  A case that fails is
// run once more after RETRY_MS; passing then is reported as such, so flakiness
// stays visible, while a real breakage fails both times.
const PACE_MS = 1000;
const RETRY_MS = 2000;
let retried = 0;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function runCase(check) {
  await sleep(PACE_MS);
  let { ok, label } = await check();
  if (!ok) {
    await sleep(RETRY_MS);
    ({ ok, label } = await check());
    if (ok) {
      retried++;
      label += ' (passed on retry)';
    }
  }
  assert(ok, label);
}

async function lookup(service, title, artist, duration) {
  const params = new URLSearchParams({ title, artist });
  if (duration) params.set('duration', String(duration));
  const resp = await worker.fetch(new Request(`https://worker.test/${service}-lyrics?${params}`), {});
  return { status: resp.status, body: await resp.json() };
}

async function checkSong(service, [title, artist, duration, nativeArtist, line], expectation) {
  const label = `${title} — ${artist}`;
  const { status, body } = await lookup(service, title, artist, duration);
  const byArtist = status === 200
    && normalizeForMatch(body.matchedArtist).includes(normalizeForMatch(nativeArtist));

  if (expectation === NO_COVER) {
    return { ok: status === 404 || byArtist, label: `${label}: not a cover → ${status === 200 ? body.matchedArtist : status}` };
  }
  if (status !== 200) {
    return { ok: false, label: `${label}: HTTP ${status} ${body.error || ''}` };
  }
  const lines = parseLRC(body.syncedLyrics);
  const text = normalizeForMatch(lines.map((l) => l.words).join('\n'));
  return {
    ok: byArtist
      && Math.abs(body.matchedDurationSec - duration) <= 5
      && lines.length >= 20
      && (!line || text.includes(normalizeForMatch(line))),
    label: `${label} → ${body.matchedArtist} / ${body.matchedTitle} (${body.matchedDurationSec}s, ${lines.length} lines)`,
  };
}

for (const service of ['kugou', 'netease']) {
  console.log(`\n── ${service}: songs ──`);

  for (const song of SONGS) {
    const expectation = song[5][service];
    if (expectation) await runCase(() => checkSong(service, song, expectation));
  }

  console.log(`\n── ${service}: picking the right cut ──`);

  // Listed under the bare title on Kugou, 2s shorter than the original.
  await runCase(async () => {
    const r = await lookup(service, '不能成情人 (港风电音)', '丁家怡', 192);
    return {
      ok: r.status === 200 && Math.round(r.body.matchedDurationSec) === 192 && r.body.matchedTitle.includes('港风电音'),
      label: `the 港风电音 remix, not the original → ${r.body.matchedTitle} (${r.body.matchedDurationSec}s)`,
    };
  });

  await runCase(async () => ({
    ok: (await lookup(service, '不能成情人', '丁家怡', 240)).status === 404,
    label: 'a length no recording is near → 404, rather than another cut\'s timing',
  }));

  await runCase(async () => ({
    ok: (await lookup(service, 'zzqx qwvb nonexistent', 'Nobody Atall', 200)).status === 404,
    label: 'nonsense query → 404',
  }));
}

console.log('\n── qq ──');

// [Spotify title, Spotify artist, Spotify length (s), native artist] — each
// length checked against QQ's own listing.
const QQ_SONGS = [
  ['不能成情人', '丁家怡', 194, '丁家怡'],
  // Listed at 312 (旧版), 321, 323, 325, 328 and 329s.
  ['起风了', '买辣椒也用券', 326, '买辣椒也用券'],
  ['稻香', 'Jay Chou', 223, '周杰伦'],
  ['Blinding Lights', 'The Weeknd', 200, 'The Weeknd'],
];

async function qqSearchAnswers() {
  const url = `https://c.y.qq.com/soso/fcgi-bin/client_search_cp?format=json&p=1&n=10&w=${encodeURIComponent('稻香 周杰伦')}`;
  try {
    const resp = await fetch(url, { headers: { Referer: 'https://y.qq.com/portal/player.html' } });
    return resp.ok ? null : `QQ's search endpoint answered HTTP ${resp.status}`;
  } catch (err) {
    return `QQ's search endpoint is unreachable (${err.message})`;
  }
}

const qqDown = await qqSearchAnswers();
for (const song of QQ_SONGS) {
  if (qqDown) {
    skip(`${song[0]} — ${song[1]}`, qqDown);
    continue;
  }
  await runCase(() => checkSong('qq', song, HAS));
}

// ── Summary ──

console.log(`\n${'─'.repeat(40)}`);
console.log(`Results: ${passed} passed (${retried} on retry), ${failed} failed, ${skipped} skipped, ${passed + failed + skipped} total`);

if (failed > 0) {
  process.exit(1);
}
