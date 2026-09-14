/**
 * Unit tests for the now-playing source abstraction.
 *
 * Two things are checked here.  First, that each source maps its service's
 * response onto the same NowPlaying shape, so everything downstream can stop
 * caring which one is running.  Second — and this is the part worth having
 * tests for — that PositionEstimator produces a sane timeline from sources
 * that report position precisely, coarsely, or not at all.
 *
 * The clock is injected, so none of this waits on real time.
 *
 * Usage:  node tests/test_sources.mjs
 */

import {
  PositionEstimator,
  createSpotifySource,
  createTeslaFleetSource,
  mapTeslaMediaInfo,
  selectSourceId,
  teslaTrackId,
} from '../sources.js';

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

function assertEqual(actual, expected, label) {
  assert(actual === expected, `${label} (got ${JSON.stringify(actual)})`);
}

/** A clock the tests advance by hand. */
function fakeClock(start = 1_000_000) {
  let t = start;
  const now = () => t;
  now.advance = (ms) => { t += ms; };
  return now;
}

const json = (body, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

// ============================================================

console.log('\nPositionEstimator — precise source (Spotify)');
{
  const now = fakeClock();
  const est = new PositionEstimator({ quality: 'precise', now });

  const np = (progressMs, isPlaying = true) => ({
    trackId: 'a', title: 'T', artist: 'A', durationMs: 200_000, progressMs, isPlaying, artworkUrl: null,
  });

  let a = est.update(np(0));
  assertEqual(a.progressMs, 0, 'anchors at the reported position on a new track');
  assertEqual(a.trackChanged, true, 'reports the track change');

  now.advance(1000);
  a = est.update(np(1000));
  assertEqual(a.progressMs, 1000, 're-anchors on every poll');
  assertEqual(a.trackChanged, false, 'same track is not a change');

  // A precise source is trusted outright, so even a small correction lands —
  // this is what lets the animation loop's LERP do the fine smoothing.
  now.advance(1000);
  a = est.update(np(1900));
  assertEqual(a.progressMs, 1900, 'accepts a small correction rather than gating it');
}

console.log('\nPositionEstimator — coarse source (Tesla telemetry)');
{
  const now = fakeClock();
  const est = new PositionEstimator({ quality: 'coarse', now, snapThresholdMs: 1500 });

  const np = (progressMs, isPlaying = true) => ({
    trackId: 'a', title: 'T', artist: 'A', durationMs: 200_000, progressMs, isPlaying, artworkUrl: null,
  });

  est.update(np(0));

  // A tick that agrees with the extrapolation to within the threshold must not
  // move the anchor, or the highlight jitters on every coarse read.
  now.advance(500);
  let a = est.update(np(400));
  assertEqual(a.progressMs, 0, 'ignores jitter inside the snap threshold');
  assertEqual(est.positionAt(), 500, 'keeps extrapolating from the original anchor');

  // A real divergence — someone seeked in the car — does move it.
  now.advance(500);
  a = est.update(np(60_000));
  assertEqual(a.progressMs, 60_000, 'snaps to a divergence past the threshold');
  assertEqual(est.positionAt(), 60_000, 'extrapolates from the corrected anchor');
}

console.log('\nPositionEstimator — source with no position at all');
{
  const now = fakeClock();
  const est = new PositionEstimator({ quality: 'none', now });

  const np = (isPlaying = true, trackId = 'a') => ({
    trackId, title: 'T', artist: 'A', durationMs: 0, progressMs: null, isPlaying, artworkUrl: null,
  });

  est.update(np());
  assertEqual(est.positionAt(), 0, 'a new track starts the timeline at zero');

  now.advance(5000);
  est.update(np());
  assertEqual(est.positionAt(), 5000, 'free-runs while playing');

  // Pause must freeze the clock, not let it keep running underneath.
  now.advance(1000);
  est.update(np(false));
  assertEqual(est.positionAt(), 6000, 'freezes at the estimate on pause');
  now.advance(10_000);
  assertEqual(est.positionAt(), 6000, 'stays frozen while paused');

  est.update(np(true));
  now.advance(2000);
  assertEqual(est.positionAt(), 8000, 'resumes from where it froze');

  // A new track restarts the timeline rather than inheriting the old one.
  est.update(np(true, 'b'));
  assertEqual(est.positionAt(), 0, 'a track change resets to zero');
}

console.log('\nPositionEstimator — seek and silence');
{
  const now = fakeClock();
  const est = new PositionEstimator({ quality: 'none', now });
  est.update({ trackId: 'a', title: 'T', artist: 'A', durationMs: 0, progressMs: null, isPlaying: true, artworkUrl: null });

  est.seek(30_000);
  assertEqual(est.positionAt(), 30_000, 'seek moves the anchor immediately');
  now.advance(1000);
  assertEqual(est.positionAt(), 31_000, 'and playback continues from there');

  const a = est.update(null);
  assertEqual(a.progressMs, 0, 'a null poll resets the timeline');
  assertEqual(a.isPlaying, false, 'and reports nothing playing');
}

// ============================================================

console.log('\nmapTeslaMediaInfo');
{
  const base = {
    now_playing_title: 'Song',
    now_playing_artist: 'Artist',
    now_playing_album: 'Album',
    now_playing_duration: 210_000,
    now_playing_elapsed: 45_000,
    media_playback_status: 'Playing',
  };

  const np = mapTeslaMediaInfo(base);
  assertEqual(np.title, 'Song', 'maps the title');
  assertEqual(np.artist, 'Artist', 'maps the artist');
  assertEqual(np.durationMs, 210_000, 'maps the duration');
  assertEqual(np.progressMs, 45_000, 'maps elapsed to progressMs');
  assertEqual(np.isPlaying, true, 'reads the playback status');
  assertEqual(np.artworkUrl, null, 'reports no artwork');

  assertEqual(mapTeslaMediaInfo({ ...base, media_playback_status: 'Paused' }).isPlaying, false,
    'Paused is not playing');

  // Tesla documents these fields as sometimes empty depending on the media
  // source.  An absent elapsed has to become null, never 0 — a 0 would yank
  // the lyrics back to the first line on every poll.
  assertEqual(mapTeslaMediaInfo({ ...base, now_playing_elapsed: null }).progressMs, null,
    'a null elapsed degrades to no position');
  assertEqual(mapTeslaMediaInfo({ ...base, now_playing_elapsed: '' }).progressMs, null,
    'an empty elapsed degrades to no position');
  assertEqual(mapTeslaMediaInfo({ ...base, now_playing_elapsed: 0 }).progressMs, 0,
    'but a real zero is kept');

  // Radio with no track title is silence as far as lyrics are concerned.
  assertEqual(mapTeslaMediaInfo({ ...base, now_playing_title: '' }), null,
    'no title means nothing to look up');
  assertEqual(mapTeslaMediaInfo(null), null, 'no media_info at all');

  // The id has to be stable across polls and distinct between tracks: it is
  // both the change detector and the lyrics cache key.
  assert(teslaTrackId(base) === teslaTrackId({ ...base }), 'track id is stable');
  assert(teslaTrackId(base) !== teslaTrackId({ ...base, now_playing_title: 'Other' }),
    'track id distinguishes titles');
  assert(teslaTrackId(base) === teslaTrackId({ ...base, now_playing_title: '  SONG ' }),
    'track id ignores case and surrounding space');
}

console.log('\ncreateTeslaFleetSource');
{
  const source = createTeslaFleetSource({
    fetchVehicleData: async () => ({
      vehicle_state: {
        media_info: {
          now_playing_title: 'Song', now_playing_artist: 'Artist', now_playing_album: 'Album',
          now_playing_duration: 210_000, now_playing_elapsed: 1000, media_playback_status: 'Playing',
        },
      },
    }),
  });

  assertEqual(source.capabilities.seek, false, 'declares it cannot seek');
  assertEqual(source.capabilities.artwork, false, 'declares it has no artwork');
  assertEqual(source.capabilities.position, 'coarse', 'declares a coarse position');
  assert(source.pollIntervalMs >= 15_000, 'polls slowly — Fleet API is billed per request');

  const np = await source.poll();
  assertEqual(np.title, 'Song', 'reads media_info out of vehicle_state');

  const empty = createTeslaFleetSource({ fetchVehicleData: async () => null });
  assertEqual(await empty.poll(), null, 'an unavailable vehicle reports silence');
}

console.log('\ncreateSpotifySource');
{
  const calls = [];
  globalThis.fetch = async (url, init) => {
    calls.push({ url: String(url), method: init?.method || 'GET' });
    if (String(url).includes('/seek')) return new Response(null, { status: 204 });
    return json({
      is_playing: true,
      progress_ms: 12_345,
      item: {
        id: '3n3Ppam7vgaVa1iaRUc9Lp',
        name: 'Mr. Brightside',
        duration_ms: 222_000,
        artists: [{ name: 'The Killers' }],
        album: { images: [{ url: 'https://img.test/a.jpg' }] },
      },
    });
  };

  const source = createSpotifySource({ getAccessToken: async () => 'tok' });
  assertEqual(source.capabilities.position, 'precise', 'declares a precise position');
  assertEqual(source.capabilities.seek, true, 'declares it can seek');

  const np = await source.poll();
  assertEqual(np.trackId, '3n3Ppam7vgaVa1iaRUc9Lp', 'maps the track id');
  assertEqual(np.title, 'Mr. Brightside', 'maps the title');
  assertEqual(np.artist, 'The Killers', 'joins the artists');
  assertEqual(np.progressMs, 12_345, 'maps progress_ms');
  assertEqual(np.artworkUrl, 'https://img.test/a.jpg', 'maps the album art');

  await source.seek(5000);
  assert(calls.some((c) => c.url.includes('position_ms=5000') && c.method === 'PUT'), 'seeks with a PUT');

  // 204 is how Spotify says nothing is playing.
  globalThis.fetch = async () => new Response(null, { status: 204 });
  assertEqual(await source.poll(), null, '204 means nothing is playing');

  // A 401 triggers a refresh and reports silence for this round.
  let refreshed = false;
  globalThis.fetch = async () => new Response('', { status: 401 });
  const guarded = createSpotifySource({
    getAccessToken: async () => 'tok',
    onUnauthorized: async () => { refreshed = true; },
  });
  assertEqual(await guarded.poll(), null, '401 reports silence');
  assert(refreshed, 'and asks for a token refresh');

  // Without a token there is nothing to call.
  const anon = createSpotifySource({ getAccessToken: async () => null });
  assertEqual(await anon.poll(), null, 'no token means no poll');
}

console.log('\nselectSourceId');
{
  const store = () => {
    const m = new Map();
    return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, v) };
  };

  assertEqual(selectSourceId({}), 'spotify', 'defaults to Spotify');
  assertEqual(selectSourceId({ search: '?source=tesla', storage: store() }), 'tesla', 'reads the query param');
  assertEqual(selectSourceId({ search: '?source=nope', storage: store() }), 'spotify', 'ignores an unknown source');

  const s = store();
  selectSourceId({ search: '?source=tesla', storage: s });
  assertEqual(selectSourceId({ storage: s }), 'tesla', 'remembers the last choice');

  // Private browsing throws on storage access; that must not break startup.
  const hostile = { getItem: () => { throw new Error('denied'); }, setItem: () => { throw new Error('denied'); } };
  assertEqual(selectSourceId({ search: '?source=tesla', storage: hostile }), 'tesla', 'survives unusable storage');
  assertEqual(selectSourceId({ storage: hostile }), 'spotify', 'falls back when storage throws');
}

// ============================================================

console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed === 0 ? 0 : 1);
