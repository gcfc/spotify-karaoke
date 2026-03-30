// ============================================================
//  Lyrics Fetching — pure data logic, no DOM dependencies.
//  Shared by app.js (browser) and test scripts (Node.js).
// ============================================================

export async function fetchLyricsFromWorker(workerUrl, trackId) {
  if (!workerUrl) return null;
  const url = `${workerUrl}/lyrics?track_id=${trackId}`;
  console.debug('[lyrics] Worker:', url);
  try {
    const resp = await fetch(url);
    if (!resp.ok) { console.debug('[lyrics] Worker: HTTP', resp.status); return null; }
    const data = await resp.json();
    if (!data || !data.lyrics || !data.lyrics.lines) { console.debug('[lyrics] Worker: no lyrics in response'); return null; }
    console.debug('[lyrics] Worker: got', data.lyrics.syncType);
    return data;
  } catch (err) {
    console.debug('[lyrics] Worker: error', err.message);
    return null;
  }
}

export async function fetchLyricsFromLRCLIB(trackName, artistName, durationSec) {
  try {
    const params = new URLSearchParams({
      track_name: trackName,
      artist_name: artistName,
    });
    if (durationSec) params.set('duration', String(Math.round(durationSec)));

    const lrcHeaders = { 'Lrclib-Client': 'SpotifyKaraoke/1.0' };

    const getUrl = 'https://lrclib.net/api/get?' + params.toString();
    console.debug('[lyrics] LRCLIB get:', getUrl);
    let resp = await fetch(getUrl, { headers: lrcHeaders });
    if (resp.ok) {
      const data = await resp.json();
      if (data.syncedLyrics || data.plainLyrics) {
        console.debug('[lyrics] LRCLIB get: found', data.syncedLyrics ? 'synced' : 'plain');
        return data;
      }
      console.debug('[lyrics] LRCLIB get: response OK but no lyrics fields');
    } else {
      console.debug('[lyrics] LRCLIB get: HTTP', resp.status);
    }

    const q = `${trackName} ${artistName}`;
    const searchUrl = 'https://lrclib.net/api/search?q=' + encodeURIComponent(q);
    console.debug('[lyrics] LRCLIB search:', searchUrl);
    resp = await fetch(searchUrl, { headers: lrcHeaders });
    if (!resp.ok) { console.debug('[lyrics] LRCLIB search: HTTP', resp.status); return null; }
    const results = await resp.json();
    console.debug('[lyrics] LRCLIB search:', results.length, 'results');
    if (results.length > 0) {
      const best = results.find((r) => r.syncedLyrics) || results[0];
      return best;
    }
    return null;
  } catch (err) {
    console.debug('[lyrics] LRCLIB: error', err.message);
    return null;
  }
}

export async function fetchLyricsFromKKBOX(workerUrl, trackName, artistName) {
  if (!workerUrl) return null;
  const params = new URLSearchParams({ title: trackName, artist: artistName });
  const url = `${workerUrl}/kkbox-lyrics?${params}`;
  console.debug('[lyrics] KKBOX:', url);
  try {
    const resp = await fetch(url);
    if (!resp.ok) { console.debug('[lyrics] KKBOX: HTTP', resp.status); return null; }
    const data = await resp.json();
    if (data.plainLyrics) { console.debug('[lyrics] KKBOX: found plain lyrics'); }
    else { console.debug('[lyrics] KKBOX: response OK but no plainLyrics'); }
    return data.plainLyrics || null;
  } catch (err) {
    console.debug('[lyrics] KKBOX: error', err.message);
    return null;
  }
}

/**
 * Browser-direct fallback: calls KKBOX search API + scrapes song page JSON-LD
 * without going through the Cloudflare Worker. Works when the Worker is
 * unreachable or KKBOX blocks Worker IPs but allows browser requests.
 */
export async function fetchLyricsFromKKBOXDirect(trackName, artistName) {
  const KKBOX_UA_HEADERS = {
    Accept: 'application/json',
  };

  try {
    const q = `${trackName} ${artistName}`.trim();
    const searchUrl =
      'https://www.kkbox.com/api/search/song?q=' +
      encodeURIComponent(q) +
      '&terr=hk&lang=tc';
    console.debug('[lyrics] KKBOX-direct: search', searchUrl);

    const searchResp = await fetch(searchUrl, { headers: KKBOX_UA_HEADERS });
    if (!searchResp.ok) {
      console.debug('[lyrics] KKBOX-direct: search HTTP', searchResp.status);
      return null;
    }
    const searchData = await searchResp.json();
    const songUrl = searchData?.data?.result?.[0]?.url;
    if (!songUrl) {
      console.debug('[lyrics] KKBOX-direct: no search results');
      return null;
    }
    console.debug('[lyrics] KKBOX-direct: song page', songUrl);

    const pageResp = await fetch(songUrl, { headers: { Accept: 'text/html' } });
    if (!pageResp.ok) {
      console.debug('[lyrics] KKBOX-direct: page HTTP', pageResp.status);
      return null;
    }
    const html = await pageResp.text();

    const jsonLdRegex = /<script type="application\/ld\+json">([\s\S]*?)<\/script>/g;
    let match;
    while ((match = jsonLdRegex.exec(html)) !== null) {
      try {
        const ld = JSON.parse(match[1]);
        const text = ld?.recordingOf?.lyrics?.text;
        if (text) {
          console.debug('[lyrics] KKBOX-direct: found plain lyrics');
          return text;
        }
      } catch { /* not the right JSON-LD block */ }
    }

    console.debug('[lyrics] KKBOX-direct: no lyrics in JSON-LD');
    return null;
  } catch (err) {
    console.debug('[lyrics] KKBOX-direct: error', err.message);
    return null;
  }
}

export function parseLRC(lrcString) {
  const lines = [];
  for (const raw of lrcString.split('\n')) {
    const match = raw.match(/^\[(\d+):(\d+)\.(\d+)\]\s*(.*)/);
    if (!match) continue;
    const min = parseInt(match[1], 10);
    const sec = parseInt(match[2], 10);
    const ms = parseInt(match[3].padEnd(3, '0').slice(0, 3), 10);
    const timeMs = min * 60000 + sec * 1000 + ms;
    const text = match[4].trim();
    if (text) lines.push({ startTimeMs: timeMs, words: text });
  }
  return lines;
}

/**
 * Orchestrates the full lyrics fetch chain.
 * Returns { lyrics, syncType, source } or { lyrics: null } when nothing found.
 */
export async function fetchLyrics(workerUrl, trackId, trackName, artistName, trackDurationMs) {
  console.debug('[lyrics] fetchLyrics called:', { trackId, trackName, artistName, trackDurationMs });

  // 1. Spotify internal via Cloudflare Worker (word or line synced)
  const workerData = await fetchLyricsFromWorker(workerUrl, trackId);
  if (workerData && workerData.lyrics) {
    const sType = workerData.lyrics.syncType;
    if (sType === 'WORD_SYNCED' || sType === 'LINE_SYNCED') {
      const modeLabel = sType === 'WORD_SYNCED' ? 'word-synced' : 'line-synced';
      return {
        lyrics: workerData.lyrics.lines,
        syncType: sType,
        source: `Spotify · ${modeLabel}`,
      };
    }
  }

  // 2. LRCLIB (synced, then plain)
  const lrcData = await fetchLyricsFromLRCLIB(trackName, artistName, trackDurationMs / 1000);
  if (lrcData) {
    if (lrcData.syncedLyrics) {
      const lines = parseLRC(lrcData.syncedLyrics);
      if (lines.length > 0) {
        return { lyrics: lines, syncType: 'LINE_SYNCED', source: 'LRCLIB · line-synced' };
      }
    }
    if (lrcData.plainLyrics) {
      return { lyrics: lrcData.plainLyrics, syncType: 'PLAIN', source: 'LRCLIB · plain' };
    }
  }

  // 3. KKBOX via Cloudflare Worker (plain text)
  const kkboxLyrics = await fetchLyricsFromKKBOX(workerUrl, trackName, artistName);
  if (kkboxLyrics) {
    return { lyrics: kkboxLyrics, syncType: 'PLAIN', source: 'KKBOX · plain' };
  }

  // 4. KKBOX direct from browser (fallback when Worker can't reach KKBOX)
  const kkboxDirect = await fetchLyricsFromKKBOXDirect(trackName, artistName);
  if (kkboxDirect) {
    return { lyrics: kkboxDirect, syncType: 'PLAIN', source: 'KKBOX · plain (direct)' };
  }

  return { lyrics: null, syncType: null, source: null };
}
