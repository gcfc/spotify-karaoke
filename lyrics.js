// ============================================================
//  Lyrics Fetching — pure data logic, no DOM dependencies.
//  Shared by app.js (browser) and test scripts (Node.js).
// ============================================================

// ── Traditional → Simplified Chinese conversion (lazy-loaded) ──

const CJK_RE = /[\u4e00-\u9fff]/;
const JAPANESE_RE = /[\u3040-\u309f\u30a0-\u30ff]/;  // Hiragana + Katakana

export function isChinese(sample, language) {
  if (language) {
    const lang = language.toLowerCase();
    return lang.startsWith('zh');
  }
  if (!CJK_RE.test(sample)) return false;
  if (JAPANESE_RE.test(sample)) return false;
  return true;
}

let _t2sConverter = null;
let _t2sLoadFailed = false;

async function getT2SConverter() {
  if (_t2sConverter) return _t2sConverter;
  if (_t2sLoadFailed) return null;
  try {
    const OpenCC = await import('https://cdn.jsdelivr.net/npm/opencc-js@1.0.5/dist/esm/t2cn.js');
    _t2sConverter = OpenCC.Converter({ from: 'hk', to: 'cn' });
    console.debug('[lyrics] OpenCC t2cn converter loaded');
    return _t2sConverter;
  } catch (err) {
    _t2sLoadFailed = true;
    console.debug('[lyrics] OpenCC load failed:', err.message);
    return null;
  }
}

async function convertLyricsToSimplified(result) {
  if (!result || !result.lyrics) return result;

  let sample = '';
  if (typeof result.lyrics === 'string') {
    sample = result.lyrics;
  } else if (Array.isArray(result.lyrics)) {
    sample = result.lyrics.slice(0, 5).map((l) => l.words || '').join('');
  }

  if (!isChinese(sample, result.language)) {
    if (result.language) {
      console.debug('[lyrics] Skipping t2s — language:', result.language);
    } else if (JAPANESE_RE.test(sample)) {
      console.debug('[lyrics] Skipping t2s — detected Japanese (kana present)');
    }
    return result;
  }

  const convert = await getT2SConverter();
  if (!convert) return result;

  if (typeof result.lyrics === 'string') {
    result.lyrics = convert(result.lyrics);
  } else if (Array.isArray(result.lyrics)) {
    for (const line of result.lyrics) {
      if (line.words) line.words = convert(line.words);
      if (line.syllables) {
        for (const syl of line.syllables) {
          if (syl.word) syl.word = convert(syl.word);
        }
      }
    }
  }

  console.debug('[lyrics] Converted lyrics to Simplified Chinese');
  return result;
}

export async function fetchLyricsFromWorker(workerUrl, trackId, spotifyToken) {
  if (!workerUrl) return null;
  const url = `${workerUrl}/lyrics?track_id=${trackId}`;
  console.debug('[lyrics] Worker:', url);
  try {
    const headers = {};
    if (spotifyToken) headers['Authorization'] = `Bearer ${spotifyToken}`;
    const resp = await fetch(url, { headers });
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

// ── LRU Cache ──

const CACHE_MAX = 50;
const lyricsCache = new Map();

function cacheGet(trackId) {
  if (!lyricsCache.has(trackId)) return undefined;
  const val = lyricsCache.get(trackId);
  lyricsCache.delete(trackId);
  lyricsCache.set(trackId, val);
  return val;
}

function cacheSet(trackId, result) {
  if (lyricsCache.has(trackId)) lyricsCache.delete(trackId);
  lyricsCache.set(trackId, result);
  if (lyricsCache.size > CACHE_MAX) {
    lyricsCache.delete(lyricsCache.keys().next().value);
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

const NO_RESULT = Object.freeze({ lyrics: null, syncType: null, source: null });

/**
 * Orchestrates the full lyrics fetch chain.
 *
 *  1. Returns immediately on cache hit.
 *  2. Tries Spotify (highest-quality, word/line synced) first.
 *  3. On miss, fires LRCLIB + KKBOX Worker + KKBOX Direct in parallel,
 *     then picks the best result by priority:
 *       LRCLIB synced > LRCLIB plain > KKBOX Worker > KKBOX Direct
 *  4. Caches successful results for instant re-visits.
 */
export async function fetchLyrics(workerUrl, trackId, trackName, artistName, trackDurationMs, spotifyToken) {
  console.debug('[lyrics] fetchLyrics called:', { trackId, trackName, artistName, trackDurationMs });

  const cached = cacheGet(trackId);
  if (cached) {
    console.debug('[lyrics] cache hit:', cached.source);
    return cached;
  }

  // 1. Spotify internal via Cloudflare Worker (word or line synced)
  const workerData = await fetchLyricsFromWorker(workerUrl, trackId, spotifyToken);
  if (workerData?.lyrics) {
    const sType = workerData.lyrics.syncType;
    if (sType === 'WORD_SYNCED' || sType === 'LINE_SYNCED') {
      const modeLabel = sType === 'WORD_SYNCED' ? 'word-synced' : 'line-synced';
      const result = await convertLyricsToSimplified({
        lyrics: workerData.lyrics.lines,
        syncType: sType,
        source: `Spotify · ${modeLabel}`,
        language: workerData.lyrics.language,
      });
      cacheSet(trackId, result);
      return result;
    }
  }

  // 2. Fire remaining sources in parallel
  console.debug('[lyrics] Spotify miss — querying LRCLIB + KKBOX in parallel');
  const [lrcData, kkboxWorker, kkboxDirect] = await Promise.all([
    fetchLyricsFromLRCLIB(trackName, artistName, trackDurationMs / 1000),
    fetchLyricsFromKKBOX(workerUrl, trackName, artistName),
    fetchLyricsFromKKBOXDirect(trackName, artistName),
  ]);

  // 3. Pick best result by priority
  let result = null;

  if (lrcData?.syncedLyrics) {
    const lines = parseLRC(lrcData.syncedLyrics);
    if (lines.length > 0) {
      result = { lyrics: lines, syncType: 'LINE_SYNCED', source: 'LRCLIB · line-synced' };
    }
  }
  if (!result && lrcData?.plainLyrics) {
    result = { lyrics: lrcData.plainLyrics, syncType: 'PLAIN', source: 'LRCLIB · plain' };
  }
  if (!result && kkboxWorker) {
    result = { lyrics: kkboxWorker, syncType: 'PLAIN', source: 'KKBOX · plain' };
  }
  if (!result && kkboxDirect) {
    result = { lyrics: kkboxDirect, syncType: 'PLAIN', source: 'KKBOX · plain (direct)' };
  }

  if (result) {
    result = await convertLyricsToSimplified(result);
    cacheSet(trackId, result);
    return result;
  }

  return NO_RESULT;
}
