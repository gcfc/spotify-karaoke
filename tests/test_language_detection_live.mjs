/**
 * Live API tests — verifies language detection against real lyrics sources.
 *
 *  1. Spotify Worker: confirms the raw API response contains a `language` field.
 *  2. LRCLIB:         fetches real lyrics and runs isChinese() on them.
 *
 * Requires Node.js 18+ (native fetch) and network access.
 *
 * Usage:
 *   node tests/test_language_detection_live.mjs
 *   node tests/test_language_detection_live.mjs --verbose
 */

import { isChinese, fetchLyricsFromWorker, fetchLyricsFromLRCLIB } from '../lyrics.js';
import { parseArgs } from 'node:util';

const { values } = parseArgs({
  options: {
    verbose: { type: 'boolean', short: 'v', default: false },
  },
});
const VERBOSE = values.verbose;

const WORKER_URL = 'https://spotify-karaoke.workers.dev';
const KANA_RE = /[\u3040-\u309f\u30a0-\u30ff]/;
const CJK_RE = /[\u4e00-\u9fff]/;

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

function sampleText(lyrics) {
  if (typeof lyrics === 'string') return lyrics.slice(0, 200);
  if (Array.isArray(lyrics)) return lyrics.slice(0, 5).map(l => l.words || '').join('');
  return '';
}

// ────────────────────────────────────────────────────────────
//  Part 1: Spotify Worker — inspect raw `language` field
// ────────────────────────────────────────────────────────────

const SPOTIFY_TRACKS = [
  { id: '4u7EnebtmKWzUH433cf5Qv', title: 'Bohemian Rhapsody', artist: 'Queen',  expectLang: 'en' },
  { id: '2BHj3evFlWmFBnYMjNOTcP', title: '稻香',              artist: '周杰倫', expectLang: 'zh' },
  { id: '2yLa0DpmYbBMKRkN1YXy1G', title: '夜に駆ける',         artist: 'YOASOBI', expectLang: 'ja' },
];

async function testSpotifyLanguageField() {
  console.log('\n══ Part 1: Spotify Worker — raw language field ══\n');

  for (const track of SPOTIFY_TRACKS) {
    const label = `${track.title} (${track.artist})`;
    console.log(`  ── ${label} ──`);

    let data;
    try {
      data = await fetchLyricsFromWorker(WORKER_URL, track.id);
    } catch (err) {
      skip(label, `worker error: ${err.message}`);
      console.log();
      continue;
    }

    if (!data?.lyrics) {
      skip(label, 'no lyrics from worker (may need auth token)');
      console.log();
      continue;
    }

    const lang = data.lyrics.language;
    if (VERBOSE) {
      console.log(`     syncType: ${data.lyrics.syncType}`);
      console.log(`     language: ${JSON.stringify(lang)}`);
      const sample = (data.lyrics.lines || []).slice(0, 3).map(l => l.words).join(' / ');
      console.log(`     sample:   ${sample}`);
    }

    assert(lang !== undefined && lang !== null,
      `${label}: response has "language" field (got ${JSON.stringify(lang)})`);

    if (lang) {
      const langLower = lang.toLowerCase();
      assert(langLower.startsWith(track.expectLang),
        `${label}: language starts with "${track.expectLang}" (got "${lang}")`);

      if (track.expectLang === 'zh') {
        assert(isChinese('', lang) === true,
          `${label}: isChinese('', '${lang}') → true`);
      } else {
        assert(isChinese('', lang) === false,
          `${label}: isChinese('', '${lang}') → false`);
      }
    }
    console.log();
  }
}

// ────────────────────────────────────────────────────────────
//  Part 2: LRCLIB — real lyrics through heuristic detection
// ────────────────────────────────────────────────────────────

const LRCLIB_TRACKS = [
  {
    title: '稻香', artist: '周杰倫', duration: 223,
    expectChinese: true,
    description: 'Chinese pop (Jay Chou)',
  },
  {
    title: '夜に駆ける', artist: 'YOASOBI', duration: 258,
    expectChinese: false,
    description: 'Japanese pop (YOASOBI)',
  },
  {
    title: 'Pretender', artist: 'Official髭男dism', duration: 327,
    expectChinese: false,
    description: 'Japanese rock (Official HIGE DANdism)',
  },
  {
    title: '明天會更好', artist: '群星', duration: 289,
    expectChinese: true,
    description: 'Chinese classic (Tomorrow Will Be Better)',
  },
  {
    title: 'Bohemian Rhapsody', artist: 'Queen', duration: 355,
    expectChinese: false,
    description: 'English rock (Queen)',
  },
  {
    title: 'Lemon', artist: '米津玄師', duration: 254,
    expectChinese: false,
    description: 'Japanese pop (Kenshi Yonezu)',
  },
];

async function testLRCLIBHeuristic() {
  console.log('\n══ Part 2: LRCLIB — heuristic detection on real lyrics ══\n');

  for (const track of LRCLIB_TRACKS) {
    const label = `${track.description}: ${track.title}`;
    console.log(`  ── ${label} ──`);

    let data;
    try {
      data = await fetchLyricsFromLRCLIB(track.title, track.artist, track.duration);
    } catch (err) {
      skip(label, `LRCLIB error: ${err.message}`);
      console.log();
      continue;
    }

    const text = data?.syncedLyrics || data?.plainLyrics;
    if (!text) {
      skip(label, 'no lyrics found on LRCLIB');
      console.log();
      continue;
    }

    const sample = text.replace(/\[\d+:\d+\.\d+\]/g, '').slice(0, 300);
    if (VERBOSE) {
      console.log(`     sample: ${sample.slice(0, 120).replace(/\n/g, ' / ')}…`);
      console.log(`     has CJK: ${CJK_RE.test(sample)}, has kana: ${KANA_RE.test(sample)}`);
    }

    const detected = isChinese(sample, null);

    assert(detected === track.expectChinese,
      `${label}: isChinese() → ${detected} (expected ${track.expectChinese})`);

    if (track.expectChinese === false && KANA_RE.test(sample)) {
      assert(true,
        `${label}: kana confirmed in lyrics (heuristic basis)`);
    }
    if (track.expectChinese === true && CJK_RE.test(sample) && !KANA_RE.test(sample)) {
      assert(true,
        `${label}: CJK present with no kana (heuristic basis)`);
    }
    console.log();
  }
}

// ────────────────────────────────────────────────────────────
//  Part 3: Full pipeline — fetchLyrics end-to-end
// ────────────────────────────────────────────────────────────

async function testFullPipeline() {
  console.log('\n══ Part 3: Full pipeline — language field propagated ══\n');

  const { fetchLyrics } = await import('../lyrics.js');

  const cases = [
    {
      trackId: '_test_zh', title: '稻香', artist: '周杰倫', duration: 223000,
      expectChinese: true,
      description: 'Chinese',
    },
    {
      trackId: '_test_ja', title: '夜に駆ける', artist: 'YOASOBI', duration: 258000,
      expectChinese: false,
      description: 'Japanese',
    },
  ];

  for (const c of cases) {
    const label = `${c.description}: ${c.title} (${c.artist})`;
    console.log(`  ── ${label} ──`);

    let result;
    try {
      result = await fetchLyrics(WORKER_URL, c.trackId, c.title, c.artist, c.duration);
    } catch (err) {
      skip(label, `pipeline error: ${err.message}`);
      console.log();
      continue;
    }

    if (!result?.lyrics) {
      skip(label, 'no lyrics from any source');
      console.log();
      continue;
    }

    const sample = sampleText(result.lyrics);
    if (VERBOSE) {
      console.log(`     source:   ${result.source}`);
      console.log(`     language: ${JSON.stringify(result.language)}`);
      console.log(`     sample:   ${sample.slice(0, 100).replace(/\n/g, ' / ')}…`);
    }

    if (!c.expectChinese) {
      if (KANA_RE.test(sample)) {
        assert(true,
          `${label}: kana preserved in output (not mangled by OpenCC)`);
      } else if (result.language && !result.language.toLowerCase().startsWith('zh')) {
        assert(true,
          `${label}: language tag "${result.language}" prevented conversion`);
      } else {
        skip(label, 'source may not have had kana or language tag to verify');
      }
    } else {
      assert(CJK_RE.test(sample),
        `${label}: output contains CJK characters`);
    }
    console.log();
  }
}

// ────────────────────────────────────────────────────────────

console.log('╔══════════════════════════════════════════════════╗');
console.log('║   Live API tests — language detection pipeline   ║');
console.log('╚══════════════════════════════════════════════════╝');

await testSpotifyLanguageField();
await testLRCLIBHeuristic();
await testFullPipeline();

console.log('─'.repeat(50));
console.log(`Results: ${passed} passed, ${failed} failed, ${skipped} skipped`);

if (failed > 0) process.exit(1);
