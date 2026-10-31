/**
 * Unit tests for the lyrics source priority chain, with every network call
 * stubbed so the ordering is checked deterministically and offline:
 *
 *   LRCLIB synced > Kugou synced > QQ synced > NetEase synced >
 *   LRCLIB plain > KKBOX Worker > KKBOX Direct
 *
 * Synced always beats plain, and KKBOX stays a last resort because it only
 * ever yields plain text.  The chain returns as soon as the winner is known,
 * so the timing cases check it neither waits on lower-ranked sources nor
 * jumps ahead of higher-ranked ones.
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

// Answer after `ms`.  Slow answers stay on a live timer, so a chain that
// wrongly waits for one fails its time limit instead of hanging.
const after = (ms, respond) => () => new Promise((resolve) => {
  setTimeout(() => resolve(respond()), ms);
});

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
const KUGOU_SYNCED = () => json({ syncedLyrics: LRC, matchedTitle: 'Song', matchedArtist: 'Artist' });
const NETEASE_SYNCED = () => json({ syncedLyrics: LRC, matchedTitle: 'Song', matchedArtist: 'Artist' });
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
  'QQ synced is used when LRCLIB and Kugou have nothing');

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

console.log('\n── Kugou ──');

result = await run({ '/qq-lyrics': QQ_SYNCED, '/kugou-lyrics': KUGOU_SYNCED });
assert(result.source === 'Kugou Music',
  'Kugou synced outranks QQ synced');

result = await run({ '/api/get': LRCLIB_SYNCED, '/kugou-lyrics': KUGOU_SYNCED });
assert(result.source === 'LRCLIB',
  'LRCLIB synced outranks Kugou synced');

result = await run({ '/kugou-lyrics': KUGOU_SYNCED, '/kkbox-lyrics': KKBOX_PLAIN });
assert(result.source === 'Kugou Music' && result.syncType === 'LINE_SYNCED',
  'Kugou synced is used when LRCLIB has nothing');

assert(Array.isArray(result.lyrics) && result.lyrics.length === 3
  && result.lyrics[2].startTimeMs === 4000,
  'Kugou LRC is parsed into timestamped lines');

result = await run({ '/api/get': LRCLIB_PLAIN, '/kugou-lyrics': KUGOU_SYNCED, '/kkbox-lyrics': KKBOX_PLAIN });
assert(result.source === 'Kugou Music',
  'Kugou synced outranks LRCLIB plain — synced beats plain');

result = await run({ '/api/get': LRCLIB_PLAIN, '/kugou-lyrics': () => json({ error: 'No matching Kugou song found' }, 404) });
assert(result.source === 'LRCLIB' && result.syncType === 'PLAIN',
  'a Kugou 404 falls through to plain lyrics');

result = await run({ '/kugou-lyrics': () => json({ syncedLyrics: 'no timestamps here' }), '/kkbox-lyrics': KKBOX_PLAIN });
assert(result.source === 'KKBOX',
  'Kugou lyrics that parse to zero timed lines fall through');

console.log('\n── NetEase, the last synced fallback ──');

result = await run({ '/kugou-lyrics': KUGOU_SYNCED, '/netease-lyrics': NETEASE_SYNCED });
assert(result.source === 'Kugou Music',
  'Kugou synced outranks NetEase synced');

result = await run({ '/qq-lyrics': QQ_SYNCED, '/netease-lyrics': NETEASE_SYNCED });
assert(result.source === 'QQ Music',
  'QQ synced outranks NetEase synced');

result = await run({ '/netease-lyrics': NETEASE_SYNCED, '/kkbox-lyrics': KKBOX_PLAIN });
assert(result.source === 'NetEase Cloud Music' && result.syncType === 'LINE_SYNCED'
  && result.lyrics.length === 3,
  'NetEase synced is used when LRCLIB, Kugou and QQ have nothing');

result = await run({ '/api/get': LRCLIB_PLAIN, '/netease-lyrics': NETEASE_SYNCED });
assert(result.source === 'NetEase Cloud Music',
  'NetEase synced outranks LRCLIB plain — synced beats plain');

result = await run({ '/api/get': LRCLIB_PLAIN, '/netease-lyrics': () => json({ error: 'No matching NetEase song found' }, 404) });
assert(result.source === 'LRCLIB' && result.syncType === 'PLAIN',
  'a NetEase 404 falls through to plain lyrics');

// The Worker needs the track length to tell a song from its remixes.
const durationSent = {};
stubFetch({});
const stubbed = globalThis.fetch;
globalThis.fetch = async (url) => {
  const target = new URL(String(url));
  if (/\/(qq|kugou|netease)-lyrics$/.test(target.pathname)) {
    durationSent[target.pathname] = target.searchParams.get('duration');
  }
  return stubbed(url);
};
await fetchLyrics(WORKER, `track-${trackCounter++}`, 'Song', 'Artist', 194040, null);
assert(['/qq-lyrics', '/kugou-lyrics', '/netease-lyrics'].every((route) => durationSent[route] === '194'),
  'the track length is sent to the QQ, Kugou and NetEase routes in whole seconds');

console.log('\n── Returning early ──');

const SLOW = 3000;
async function timed(routes) {
  const start = performance.now();
  const r = await run(routes);
  return { result: r, ms: Math.round(performance.now() - start) };
}

let t = await timed({
  '/api/get': LRCLIB_SYNCED,
  '/kugou-lyrics': after(SLOW, KUGOU_SYNCED),
  '/qq-lyrics': after(SLOW, QQ_SYNCED),
  '/netease-lyrics': after(SLOW, NETEASE_SYNCED),
  '/kkbox-lyrics': after(SLOW, KKBOX_PLAIN),
});
assert(t.result.source === 'LRCLIB' && t.ms < 1000,
  `the top-ranked synced result returns without waiting for slower sources (${t.ms}ms)`);

t = await timed({
  '/api/get': after(300, NOT_FOUND),
  '/kugou-lyrics': after(100, KUGOU_SYNCED),
  '/qq-lyrics': after(SLOW, QQ_SYNCED),
  '/netease-lyrics': NETEASE_SYNCED,
});
assert(t.result.source === 'Kugou Music' && t.ms >= 250 && t.ms < 1000,
  `a lower-ranked answer waits for those above it: NetEase answered first, Kugou wins once LRCLIB misses, QQ isn't waited for (${t.ms}ms)`);

t = await timed({
  '/api/get': LRCLIB_PLAIN,
  '/kkbox-lyrics': after(SLOW, KKBOX_PLAIN),
});
assert(t.result.source === 'LRCLIB' && t.result.syncType === 'PLAIN' && t.ms < 1000,
  `once every synced source has missed, plain returns without waiting for KKBOX (${t.ms}ms)`);

t = await timed({
  '/api/get': LRCLIB_PLAIN,
  '/netease-lyrics': after(300, NETEASE_SYNCED),
});
assert(t.result.source === 'NetEase Cloud Music' && t.ms >= 250,
  `plain waits while a synced source is pending, and the synced answer wins (${t.ms}ms)`);

console.log('\n── Spotify tier is gated on a Spotify track id ──');

// The Worker's /lyrics route resolves a track against Spotify's own catalogue,
// so it is only worth calling for a real Spotify id.  Sources that synthesise
// their own key (see teslaTrackId in sources.js) must skip straight to the
// crowdsourced tiers instead of spending a round trip on a certain 404.

const SPOTIFY_WORD_SYNCED = () => json({
  lyrics: {
    syncType: 'WORD_SYNCED',
    language: 'en',
    lines: [{ startTimeMs: '0', words: 'first line', syllables: [] }],
  },
});

async function runWithId(trackId, routes) {
  stubFetch(routes);
  return fetchLyrics(WORKER, trackId, 'Song', 'Artist', 180000, null);
}

result = await runWithId('3n3Ppam7vgaVa1iaRUc9Lp', {
  '/lyrics': SPOTIFY_WORD_SYNCED,
  '/api/get': LRCLIB_SYNCED,
});
assert(result.source === 'Spotify' && result.syncType === 'WORD_SYNCED',
  'a real Spotify id reaches the Worker and word-synced wins');

result = await runWithId('tesla|song|artist|album', {
  '/lyrics': SPOTIFY_WORD_SYNCED,
  '/api/get': LRCLIB_SYNCED,
});
assert(result.source === 'LRCLIB',
  'a synthesised id skips the Worker and falls to LRCLIB');

globalThis.fetch = realFetch;

// ── Summary ──

console.log(`\n${'─'.repeat(40)}`);
console.log(`Results: ${passed} passed, ${failed} failed, ${passed + failed} total`);

if (failed > 0) {
  process.exit(1);
}
