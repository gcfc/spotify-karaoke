/**
 * Live API tests for the Worker's /kugou-lyrics and /netease-lyrics routes.
 * Runs the routes in-process against the real services, so it checks the
 * code in this checkout rather than whatever Worker is deployed.
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

function assert(condition, label) {
  if (condition) {
    console.log(`  ✓ ${label}`);
    passed++;
  } else {
    console.error(`  ✗ ${label}`);
    failed++;
  }
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

async function lookup(service, title, artist, duration) {
  const params = new URLSearchParams({ title, artist });
  if (duration) params.set('duration', String(duration));
  const resp = await worker.fetch(new Request(`https://worker.test/${service}-lyrics?${params}`), {});
  return { status: resp.status, body: await resp.json() };
}

for (const service of ['kugou', 'netease']) {
  console.log(`\n── ${service}: songs ──`);

  for (const [title, artist, duration, nativeArtist, line, expect] of SONGS) {
    const expectation = expect[service];
    if (!expectation) continue;

    const label = `${title} — ${artist}`;
    const { status, body } = await lookup(service, title, artist, duration);
    const byArtist = status === 200
      && normalizeForMatch(body.matchedArtist).includes(normalizeForMatch(nativeArtist));

    if (expectation === NO_COVER) {
      assert(status === 404 || byArtist,
        `${label}: not a cover → ${status === 200 ? body.matchedArtist : status}`);
      continue;
    }
    if (status !== 200) {
      assert(false, `${label}: HTTP ${status} ${body.error || ''}`);
      continue;
    }
    const lines = parseLRC(body.syncedLyrics);
    const text = normalizeForMatch(lines.map((l) => l.words).join('\n'));
    assert(
      byArtist
        && Math.abs(body.matchedDurationSec - duration) <= 5
        && lines.length >= 20
        && text.includes(normalizeForMatch(line)),
      `${label} → ${body.matchedArtist} / ${body.matchedTitle} (${body.matchedDurationSec}s, ${lines.length} lines)`,
    );
  }

  console.log(`\n── ${service}: picking the right cut ──`);

  // Listed under the bare title on Kugou, 2s shorter than the original.
  let r = await lookup(service, '不能成情人 (港风电音)', '丁家怡', 192);
  assert(r.status === 200 && Math.round(r.body.matchedDurationSec) === 192 && r.body.matchedTitle.includes('港风电音'),
    `the 港风电音 remix, not the original → ${r.body.matchedTitle} (${r.body.matchedDurationSec}s)`);

  r = await lookup(service, '不能成情人', '丁家怡', 240);
  assert(r.status === 404,
    'a length no recording is near → 404, rather than another cut\'s timing');

  r = await lookup(service, 'zzqx qwvb nonexistent', 'Nobody Atall', 200);
  assert(r.status === 404, 'nonsense query → 404');
}

// ── Summary ──

console.log(`\n${'─'.repeat(40)}`);
console.log(`Results: ${passed} passed, ${failed} failed, ${passed + failed} total`);

if (failed > 0) {
  process.exit(1);
}
