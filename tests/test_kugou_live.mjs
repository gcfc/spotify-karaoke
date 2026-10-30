/**
 * Live API tests for the Worker's /kugou-lyrics route.  Runs the route
 * in-process against the real Kugou endpoints, so it checks the code in this
 * checkout rather than whatever Worker is deployed.
 *
 * Each case pins the native artist Kugou should resolve to, one line the
 * lyrics must contain, and that the matched recording is within the duration
 * tolerance of the Spotify length.  Lines are compared after normalisation,
 * so punctuation, spacing and Traditional/Simplified differences don't matter.
 *
 * Requires Node.js 18+ (native fetch) and network access.
 *
 * Usage:
 *   node tests/test_kugou_live.mjs
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

// [Spotify title, Spotify artist, Spotify length (s), Kugou artist, a lyric line]
const SONGS = [
  // The reported case, plus the same singer's other Douyin-era Cantonese
  // releases, which LRCLIB does not carry.
  ['不能成情人', '丁家怡', 194, '丁家怡', '记挂某人 是苦苦回味'],
  ['心淡（港风粤语）', '丁家怡', 128, '丁家怡', '跌到極麻木 只好相信'],
  ['别挂念我', '丁家怡', 193, '丁家怡', '当天的记忆 不可替代'],
  // Romanized artist names, which only Kugou's song search resolves.
  ['稻香', 'Jay Chou', 223, '周杰伦', '多少人为生命在努力'],
  ['小幸運', 'Hebe Tien', 265, '田馥甄', '是生命最好的事情'],
  ['光年之外', 'G.E.M.', 235, '邓紫棋', '我们微小得像尘埃'],
  ['富士山下', 'Eason Chan', 259, '陈奕迅', '原谅我不再送花'],
  ['海闊天空', 'Beyond', 326, 'BEYOND', '从没有放弃过心中的理想'],
  ['Lemon', 'Kenshi Yonezu', 255, '米津玄師', '最後にあなたが教えてくれた'],
  // Japanese, Korean and English.
  ['夜に駆ける', 'YOASOBI', 261, 'YOASOBI', '初めて会った日から'],
  ['Dynamite', 'BTS', 199, 'BTS', 'Ice tea and a game of ping pong'],
  ['APT.', 'ROSÉ, Bruno Mars', 170, 'ROSÉ', '아파트 아파트'],
  ['Blinding Lights', 'The Weeknd', 200, 'The Weeknd', "I'm going through withdrawals"],
  ['Bohemian Rhapsody - Remastered 2011', 'Queen', 355, 'Queen', 'Mama just killed a man'],
];

async function kugou(title, artist, duration) {
  const params = new URLSearchParams({ title, artist });
  if (duration) params.set('duration', String(duration));
  const resp = await worker.fetch(new Request(`https://worker.test/kugou-lyrics?${params}`), {});
  return { status: resp.status, body: await resp.json() };
}

console.log('\n── Songs Kugou should have ──');

for (const [title, artist, duration, kugouArtist, line] of SONGS) {
  const label = `${title} — ${artist}`;
  const { status, body } = await kugou(title, artist, duration);
  if (status !== 200) {
    assert(false, `${label}: HTTP ${status} ${body.error || ''}`);
    continue;
  }
  const lines = parseLRC(body.syncedLyrics);
  const text = normalizeForMatch(lines.map((l) => l.words).join('\n'));
  assert(
    normalizeForMatch(body.matchedArtist).includes(normalizeForMatch(kugouArtist))
      && Math.abs(body.matchedDurationSec - duration) <= 5
      && lines.length >= 20
      && text.includes(normalizeForMatch(line)),
    `${label} → ${body.matchedArtist} / ${body.matchedTitle} (${body.matchedDurationSec}s, ${lines.length} lines)`,
  );
}

console.log('\n── Picking the right cut ──');

// Listed on Kugou under the bare title, 2s shorter than the original.
let r = await kugou('不能成情人 (港风电音)', '丁家怡', 192);
assert(r.status === 200 && r.body.matchedDurationSec === 192 && r.body.matchedTitle.includes('港风电音'),
  `the 港风电音 remix, not the original → ${r.body.matchedTitle} (${r.body.matchedDurationSec}s)`);

r = await kugou('不能成情人 (开平DJ小鱼版)', '丁家怡', 178);
assert(r.status === 200 && r.body.matchedDurationSec === 178,
  `the DJ remix → ${r.body.matchedTitle} (${r.body.matchedDurationSec}s)`);

r = await kugou('不能成情人', '丁家怡', 240);
assert(r.status === 404,
  'a length no recording is near → 404, rather than another cut\'s timing');

console.log('\n── Songs that do not exist ──');

r = await kugou('zzqx qwvb nonexistent', 'Nobody Atall', 200);
assert(r.status === 404, 'nonsense query → 404');

// ── Summary ──

console.log(`\n${'─'.repeat(40)}`);
console.log(`Results: ${passed} passed, ${failed} failed, ${passed + failed} total`);

if (failed > 0) {
  process.exit(1);
}
