/**
 * Unit tests for the lyrics source priority chain, with every network call
 * stubbed so the ordering is checked deterministically and offline:
 *
 *   LRCLIB synced > QQ synced > LRCLIB plain > KKBOX Worker > KKBOX Direct
 *
 * Synced always beats plain, and KKBOX stays a last resort because it only
 * ever yields plain text.
 *
 * Usage:  node tests/test_source_priority.mjs
 */

import { fetchLyrics } from '../lyrics.js';

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

const WORKER = 'https://worker.test';

// Placeholder stand-ins for real lyrics — ASCII so the Traditional→Simplified
// pass (which lazy-loads OpenCC from a CDN) stays out of these tests.
const LRC = '[00:01.00]first line\n[00:02.50]second line\n[00:04.00]third line';
const PLAIN = 'first line\nsecond line';

const json = (body, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

const NOT_FOUND = () => json({ error: 'not found' }, 404);

/**
 * Route stubbed responses by URL fragment.  Anything unlisted 404s, which is
 * how a source is said to have nothing for the track.
 */
function stubFetch(routes) {
  globalThis.fetch = async (url) => {
    const target = String(url);
    for (const [fragment, respond] of Object.entries(routes)) {
      if (target.includes(fragment)) return respond();
    }
    return NOT_FOUND();
  };
}

const LRCLIB_SYNCED = () => json({ syncedLyrics: LRC, plainLyrics: PLAIN });
const LRCLIB_PLAIN = () => json({ plainLyrics: PLAIN });
const QQ_SYNCED = () => json({ syncedLyrics: LRC, matchedTitle: 'Song', matchedArtist: 'Artist' });
const KKBOX_PLAIN = () => json({ plainLyrics: PLAIN, territory: 'hk', exact: true });

// Every case needs its own track id — fetchLyrics caches by it.
let trackCounter = 0;
async function run(routes) {
  stubFetch(routes);
  return fetchLyrics(WORKER, `track-${trackCounter++}`, 'Song', 'Artist', 180000, null);
}

const realFetch = globalThis.fetch;

console.log('\n── Source priority ──');

let result = await run({ '/api/get': LRCLIB_SYNCED, '/qq-lyrics': QQ_SYNCED, '/kkbox-lyrics': KKBOX_PLAIN });
assert(result.source === 'LRCLIB' && result.syncType === 'LINE_SYNCED',
  'LRCLIB synced outranks QQ synced');

result = await run({ '/qq-lyrics': QQ_SYNCED, '/kkbox-lyrics': KKBOX_PLAIN });
assert(result.source === 'QQ Music' && result.syncType === 'LINE_SYNCED',
  'QQ synced is used when LRCLIB has nothing');

assert(Array.isArray(result.lyrics) && result.lyrics.length === 3
  && result.lyrics[1].startTimeMs === 2500,
  'QQ LRC is parsed into timestamped lines');

result = await run({ '/api/get': LRCLIB_PLAIN, '/qq-lyrics': QQ_SYNCED, '/kkbox-lyrics': KKBOX_PLAIN });
assert(result.source === 'QQ Music',
  'QQ synced outranks LRCLIB plain — synced beats plain');

result = await run({ '/api/get': LRCLIB_PLAIN, '/kkbox-lyrics': KKBOX_PLAIN });
assert(result.source === 'LRCLIB' && result.syncType === 'PLAIN',
  'LRCLIB plain outranks KKBOX');

result = await run({ '/kkbox-lyrics': KKBOX_PLAIN });
assert(result.source === 'KKBOX' && result.syncType === 'PLAIN',
  'KKBOX still serves as the last-resort fallback');

result = await run({});
assert(result.lyrics === null && result.source === null,
  'no source has the track → empty result');

console.log('\n── QQ failure modes ──');

result = await run({ '/qq-lyrics': () => json({ error: 'No matching QQ Music song found' }, 404), '/kkbox-lyrics': KKBOX_PLAIN });
assert(result.source === 'KKBOX',
  'a QQ 404 falls through to KKBOX rather than aborting the chain');

result = await run({ '/qq-lyrics': () => json({ matchedTitle: 'Song' }), '/kkbox-lyrics': KKBOX_PLAIN });
assert(result.source === 'KKBOX',
  'a QQ response without syncedLyrics is ignored');

result = await run({ '/qq-lyrics': () => json({ syncedLyrics: 'no timestamps here' }), '/kkbox-lyrics': KKBOX_PLAIN });
assert(result.source === 'KKBOX',
  'QQ lyrics that parse to zero timed lines fall through');

globalThis.fetch = realFetch;

// ── Summary ──

console.log(`\n${'─'.repeat(40)}`);
console.log(`Results: ${passed} passed, ${failed} failed, ${passed + failed} total`);

if (failed > 0) {
  process.exit(1);
}
