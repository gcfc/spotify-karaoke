// ============================================================
//  Now-Playing Sources — pure data logic, no DOM dependencies.
//  Shared by app.js (browser) and test scripts (Node.js).
//
//  A source answers one question: what is playing right now?  Everything
//  downstream — the lyrics chain, the karaoke animation loop, the progress
//  bar — consumes the NowPlaying shape below and neither knows nor cares
//  which service produced it.
// ============================================================

/**
 * @typedef {Object} NowPlaying
 * @property {string}      trackId     Stable key for change detection and the lyrics cache.
 * @property {string}      title
 * @property {string}      artist
 * @property {number}      durationMs  0 when the source does not report it.
 * @property {number|null} progressMs  Playback position, or null when unavailable.
 * @property {boolean}     isPlaying
 * @property {string|null} artworkUrl  null when the source has no artwork.
 */

/**
 * @typedef {Object} SourceCapabilities
 * @property {'precise'|'coarse'|'none'} position
 *   How much to trust `progressMs`.  'precise' re-anchors the estimator on
 *   every poll; 'coarse' only corrects it past SNAP_THRESHOLD_MS, so a
 *   low-cadence feed does not make the highlight stutter; 'none' means the
 *   estimator free-runs from the track change.
 * @property {boolean} seek     Whether the source can be seeked.
 * @property {boolean} artwork  Whether `artworkUrl` is ever populated.
 * @property {boolean} duration Whether `durationMs` is ever populated.
 */

/** Position corrections smaller than this are left to the animation loop's LERP. */
export const SNAP_THRESHOLD_MS = 1500;

// ============================================================
//  Position Estimator
// ============================================================

/**
 * Turns a stream of poll results into the two values the animation loop
 * extrapolates from: a position and the timestamp it was true at.
 *
 * This exists because not every source reports a playback position, and the
 * ones that do report it at wildly different cadences — Spotify's Web API
 * gives an exact `progress_ms` once a second, Tesla's telemetry gives
 * `MediaNowPlayingElapsed` roughly twice a second, and a source that reports
 * nothing at all still needs a timeline for line-synced lyrics to run against.
 * The estimator normalises all three into the same anchor, and the existing
 * rAF loop in app.js interpolates between anchors exactly as it always has.
 */
export class PositionEstimator {
  /**
   * @param {Object}   [opts]
   * @param {'precise'|'coarse'|'none'} [opts.quality='precise']
   * @param {() => number} [opts.now]  Injectable clock, so tests need no timers.
   * @param {number}   [opts.snapThresholdMs]
   */
  constructor({ quality = 'precise', now = () => Date.now(), snapThresholdMs = SNAP_THRESHOLD_MS } = {}) {
    this.quality = quality;
    this.now = now;
    this.snapThresholdMs = snapThresholdMs;
    this.reset();
  }

  reset() {
    this.positionMs = 0;
    this.anchorAt = this.now();
    this.running = false;
    this.trackId = null;
  }

  /** Position as of `t`, extrapolating if playback is running. */
  positionAt(t = this.now()) {
    return this.running ? this.positionMs + (t - this.anchorAt) : this.positionMs;
  }

  /**
   * Fold one poll result into the anchor.
   *
   * @param {NowPlaying|null} np
   * @returns {{ progressMs: number, timestampMs: number, isPlaying: boolean, trackChanged: boolean }}
   */
  update(np) {
    const t = this.now();

    if (!np) {
      this.reset();
      return { progressMs: 0, timestampMs: t, isPlaying: false, trackChanged: this.trackId !== null };
    }

    const trackChanged = np.trackId !== this.trackId;

    if (trackChanged) {
      // A new track restarts the timeline.  A source that reports no position
      // is assumed to have started the track at zero, which is true unless the
      // listener seeks — hence the manual offset control.
      this.trackId = np.trackId;
      this.positionMs = np.progressMs ?? 0;
      this.anchorAt = t;
      this.running = np.isPlaying;
      return { progressMs: this.positionMs, timestampMs: this.anchorAt, isPlaying: this.running, trackChanged };
    }

    const estimate = this.positionAt(t);
    const reported = np.progressMs;

    if (reported != null && this.quality === 'precise') {
      // Trust it outright — this is the pre-existing Spotify behaviour, where
      // the animation loop's LERP absorbs the small poll-to-poll jitter.
      this.positionMs = reported;
      this.anchorAt = t;
    } else if (reported != null && this.quality === 'coarse' && Math.abs(reported - estimate) > this.snapThresholdMs) {
      // Only correct a real divergence (a seek, a stall).  Re-anchoring on
      // every coarse tick would jerk the highlight backwards and forwards.
      this.positionMs = reported;
      this.anchorAt = t;
    } else if (np.isPlaying !== this.running) {
      // Pause freezes the clock at the estimate; resume restarts from there.
      this.positionMs = estimate;
      this.anchorAt = t;
    }

    this.running = np.isPlaying;
    return { progressMs: this.positionMs, timestampMs: this.anchorAt, isPlaying: this.running, trackChanged };
  }

  /** Called when the listener seeks, so the anchor moves without waiting for a poll. */
  seek(positionMs) {
    this.positionMs = Math.max(0, positionMs);
    this.anchorAt = this.now();
  }
}

// ============================================================
//  Spotify Web API source
// ============================================================

const SPOTIFY_API = 'https://api.spotify.com/v1';

/**
 * The original source, unchanged in behaviour.  Works in a Tesla as-is: the
 * car's built-in Spotify is a Spotify Connect device, so `currently-playing`
 * reports it like any other, with a real `progress_ms`.
 *
 * Auth stays in app.js — this takes an accessor rather than tokens so the
 * PKCE flow has one owner.
 *
 * @param {Object} opts
 * @param {() => Promise<string|null>} opts.getAccessToken
 * @param {() => Promise<void>} [opts.onUnauthorized]  Invoked on a 401.
 */
export function createSpotifySource({ getAccessToken, onUnauthorized }) {
  async function call(path, init) {
    const token = await getAccessToken();
    if (!token) return null;

    const resp = await fetch(SPOTIFY_API + path, {
      ...init,
      headers: { ...(init?.headers || {}), Authorization: 'Bearer ' + token },
    });

    if (resp.status === 401) {
      await onUnauthorized?.();
      return null;
    }
    return resp;
  }

  return {
    id: 'spotify',
    label: 'Spotify',
    pollIntervalMs: 1000,
    capabilities: { position: 'precise', seek: true, artwork: true, duration: true },

    async poll() {
      const resp = await call('/me/player/currently-playing');
      // 204 No Content / 202 Accepted both mean "nothing to report".
      if (!resp || resp.status === 204 || resp.status === 202 || !resp.ok) return null;

      const data = await resp.json();
      if (!data || !data.item) return null;

      const track = data.item;
      return {
        trackId: track.id,
        title: track.name,
        artist: (track.artists || []).map((a) => a.name).join(', '),
        durationMs: track.duration_ms || 0,
        progressMs: data.progress_ms ?? 0,
        isPlaying: !!data.is_playing,
        artworkUrl: track.album?.images?.[0]?.url || null,
      };
    },

    async seek(positionMs) {
      await call(`/me/player/seek?position_ms=${Math.round(positionMs)}`, { method: 'PUT' });
    },
  };
}

// ============================================================
//  Tesla Fleet API source
// ============================================================

/**
 * Tesla reports now-playing metadata but no track id, so one is synthesised
 * from the metadata itself.  It has to be stable across polls (it drives
 * change detection) and distinct between tracks (it is the lyrics cache key),
 * which title + artist + album achieves for everything except a genuine
 * duplicate, where sharing a cache entry is the right answer anyway.
 */
export function teslaTrackId(info) {
  const part = (s) => String(s || '').trim().toLowerCase();
  return ['tesla', part(info.now_playing_title), part(info.now_playing_artist), part(info.now_playing_album)].join('|');
}

/**
 * Maps one `vehicle_state.media_info` object to NowPlaying.
 * Exported for tests and for reuse by a streaming-telemetry transport.
 *
 * @param {Object|null|undefined} info
 * @returns {NowPlaying|null}
 */
export function mapTeslaMediaInfo(info) {
  if (!info) return null;

  // Radio and some streaming sources populate a station but no track title.
  // Without a title there is nothing to look lyrics up by, so report silence
  // rather than a row the lyrics chain will only fail on.
  const title = String(info.now_playing_title || '').trim();
  if (!title) return null;

  const duration = Number(info.now_playing_duration) || 0;
  const elapsedRaw = info.now_playing_elapsed;
  // Tesla documents these as sometimes empty depending on the media source, so
  // an absent or non-numeric elapsed has to degrade rather than become a 0 that
  // would yank the lyrics back to the first line.
  const elapsed = Number.isFinite(Number(elapsedRaw)) && elapsedRaw !== null && elapsedRaw !== ''
    ? Number(elapsedRaw)
    : null;

  return {
    trackId: teslaTrackId(info),
    title,
    artist: String(info.now_playing_artist || '').trim(),
    durationMs: duration,
    progressMs: elapsed,
    isPlaying: String(info.media_playback_status || '').toLowerCase() === 'playing',
    artworkUrl: null,
  };
}

/**
 * Reads now-playing state from the Tesla Fleet API.
 *
 * `fetchVehicleData` is injected rather than built here because Fleet API auth
 * is a server-side flow (partner token, registered public key, per-vehicle
 * pairing) that does not belong in a static page — a Worker route will own it.
 * This adapter is complete and tested against the response shape; wiring real
 * credentials to it is a separate change.
 *
 * Note the default poll interval.  Fleet API is billed per request: polling
 * `vehicle_data` once a minute runs about $0.12 per vehicle-hour, while
 * streaming telemetry is roughly eighteen times cheaper and delivers
 * MediaNowPlayingElapsed about twice a second.  Polling here is the fallback,
 * not the destination, so it is deliberately slow — the estimator is what
 * keeps the lyrics moving between reads.
 *
 * @param {Object} opts
 * @param {() => Promise<Object|null>} opts.fetchVehicleData
 *   Resolves the parsed `response` body of
 *   `/api/1/vehicles/{vin}/vehicle_data?endpoints=vehicle_state`.
 * @param {number} [opts.pollIntervalMs=15000]
 */
export function createTeslaFleetSource({ fetchVehicleData, pollIntervalMs = 15_000 }) {
  return {
    id: 'tesla',
    label: 'Tesla',
    pollIntervalMs,
    // 'coarse' even when elapsed is present: a 15s poll (or a 500ms telemetry
    // tick) is not the once-a-second exactness the Spotify path assumes.
    capabilities: { position: 'coarse', seek: false, artwork: false, duration: true },

    async poll() {
      const data = await fetchVehicleData();
      const info = data?.vehicle_state?.media_info ?? data?.media_info ?? null;
      return mapTeslaMediaInfo(info);
    },
  };
}

// ============================================================
//  Source selection
// ============================================================

export const SOURCE_IDS = ['spotify', 'tesla'];

/**
 * Resolves which source to run, in order: `?source=` (wins, and is remembered),
 * then the stored preference, then Spotify.
 *
 * @param {Object} [env]
 * @param {string} [env.search]   location.search
 * @param {Storage} [env.storage] localStorage
 */
export function selectSourceId({ search = '', storage = null } = {}) {
  const fromQuery = new URLSearchParams(search).get('source');
  if (fromQuery && SOURCE_IDS.includes(fromQuery)) {
    try { storage?.setItem('now-playing-source', fromQuery); } catch { /* private mode */ }
    return fromQuery;
  }

  let stored = null;
  try { stored = storage?.getItem('now-playing-source'); } catch { /* private mode */ }
  return SOURCE_IDS.includes(stored) ? stored : 'spotify';
}
