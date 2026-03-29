const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

let cachedToken = null;
let tokenExpiresAt = 0;

async function getSpotifyToken(spDc) {
  if (cachedToken && Date.now() < tokenExpiresAt) {
    return cachedToken;
  }

  const resp = await fetch('https://open.spotify.com/get_access_token?reason=transport&productType=web_player', {
    headers: {
      Cookie: `sp_dc=${spDc}`,
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
    },
  });

  if (!resp.ok) {
    throw new Error(`Token fetch failed: ${resp.status}`);
  }

  const data = await resp.json();
  if (!data.accessToken) {
    throw new Error('No access token in response — sp_dc may be expired');
  }

  cachedToken = data.accessToken;
  tokenExpiresAt = data.accessTokenExpirationTimestampMs - 60_000;
  return cachedToken;
}

async function fetchLyrics(trackId, token) {
  const url = `https://spclient.wg.spotify.com/color-lyrics/v2/track/${trackId}?format=json&vocalRemoval=false&syllableSync=true`;
  const resp = await fetch(url, {
    headers: {
      Authorization: `Bearer ${token}`,
      'App-Platform': 'WebPlayer',
      Accept: 'application/json',
    },
  });

  if (!resp.ok) {
    return null;
  }

  return resp.json();
}

// ── KKBOX scraping helpers ──

const KKBOX_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
  Accept: 'text/html',
};

async function searchKKBOX(title, artist) {
  const q = `${title} ${artist}`.trim();
  const url = `https://www.kkbox.com/api/search/song?q=${encodeURIComponent(q)}&terr=hk&lang=tc`;
  const resp = await fetch(url, {
    headers: { ...KKBOX_HEADERS, Accept: 'application/json' },
  });
  if (!resp.ok) return null;
  const data = await resp.json();
  const first = data?.data?.result?.[0];
  return first?.url || null;
}

async function scrapeKKBOXLyrics(songUrl) {
  const resp = await fetch(songUrl, { headers: KKBOX_HEADERS });
  if (!resp.ok) return null;
  const html = await resp.text();

  const jsonLdRegex = /<script type="application\/ld\+json">([\s\S]*?)<\/script>/g;
  let match;
  while ((match = jsonLdRegex.exec(html)) !== null) {
    try {
      const data = JSON.parse(match[1]);
      const text = data?.recordingOf?.lyrics?.text;
      if (text) return text;
    } catch {
      // not the right JSON-LD block, keep looking
    }
  }
  return null;
}

// ── Route handlers ──

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
  });
}

async function handleSpotifyLyrics(url, env) {
  const trackId = url.searchParams.get('track_id');
  if (!trackId) {
    return jsonResponse({ error: 'Missing track_id parameter' }, 400);
  }

  const spDc = env.SP_DC;
  if (!spDc) {
    return jsonResponse({ error: 'SP_DC secret not configured' }, 500);
  }

  let token = await getSpotifyToken(spDc);
  let data = await fetchLyrics(trackId, token);

  // If fetch failed, token may be stale — clear cache and retry once
  if (!data && cachedToken) {
    cachedToken = null;
    tokenExpiresAt = 0;
    token = await getSpotifyToken(spDc);
    data = await fetchLyrics(trackId, token);
  }

  if (!data) {
    return jsonResponse({ error: 'Lyrics not found' }, 404);
  }
  return jsonResponse(data);
}

async function handleKKBOXLyrics(url) {
  const title = url.searchParams.get('title');
  const artist = url.searchParams.get('artist');
  if (!title) {
    return jsonResponse({ error: 'Missing title parameter' }, 400);
  }

  const songUrl = await searchKKBOX(title, artist || '');
  if (!songUrl) {
    return jsonResponse({ error: 'No KKBOX results found' }, 404);
  }

  const plainLyrics = await scrapeKKBOXLyrics(songUrl);
  if (!plainLyrics) {
    return jsonResponse({ error: 'Lyrics not found on KKBOX page' }, 404);
  }

  return jsonResponse({ plainLyrics });
}

export default {
  async fetch(request, env) {
    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: CORS_HEADERS });
    }

    const url = new URL(request.url);

    try {
      if (url.pathname === '/lyrics') {
        return await handleSpotifyLyrics(url, env);
      }
      if (url.pathname === '/kkbox-lyrics') {
        return await handleKKBOXLyrics(url);
      }
      return jsonResponse({ error: 'Not found' }, 404);
    } catch (err) {
      return jsonResponse({ error: err.message }, 502);
    }
  },
};
