const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
};

let cachedToken = null;
let tokenExpiresAt = 0;

const BROWSER_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
  'Accept': 'application/json',
  'Accept-Language': 'en-US,en;q=0.9',
  'sec-ch-ua': '"Chromium";v="131", "Not_A Brand";v="24"',
  'sec-ch-ua-mobile': '?0',
  'sec-ch-ua-platform': '"Windows"',
  'sec-fetch-dest': 'empty',
  'sec-fetch-mode': 'cors',
  'sec-fetch-site': 'same-origin',
  'Referer': 'https://open.spotify.com/',
  'Origin': 'https://open.spotify.com',
};

const TOKEN_URL = 'https://open.spotify.com/get_access_token?reason=transport&productType=web_player';

async function getSpotifyToken(spDc) {
  if (cachedToken && Date.now() < tokenExpiresAt) {
    return cachedToken;
  }

  const resp = await fetch(TOKEN_URL, {
    headers: {
      ...BROWSER_HEADERS,
      Cookie: `sp_dc=${spDc}`,
    },
    redirect: 'follow',
  });

  if (!resp.ok) {
    const body = await resp.text().catch(() => '');
    const snippet = body.slice(0, 200);
    throw new Error(`Token fetch failed: ${resp.status} — ${snippet}`);
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

const KKBOX_TERRITORIES = ['hk', 'tw', 'jp', 'sg', 'my'];

function cleanTrackName(name) {
  return name
    .replace(/\s*[-–—]\s.*$/, '')
    .replace(/\s*[(\[【].*$/, '')
    .trim();
}

async function searchKKBOX(title, artist) {
  const cleaned = cleanTrackName(title);
  const isExact = cleaned === title;
  const queries = [
    { q: `${title} ${artist}`.trim(), exact: true },
    ...(isExact ? [] : [{ q: `${cleaned} ${artist}`.trim(), exact: false }]),
  ];

  for (const { q, exact } of queries) {
    for (const terr of KKBOX_TERRITORIES) {
      const url = `https://www.kkbox.com/api/search/song?q=${encodeURIComponent(q)}&terr=${terr}&lang=tc`;
      try {
        const resp = await fetch(url, {
          headers: { ...KKBOX_HEADERS, Accept: 'application/json' },
        });
        if (!resp.ok) continue;
        const data = await resp.json();
        const first = data?.data?.result?.[0];
        if (first?.url) return { url: first.url, territory: terr, exact };
      } catch { continue; }
    }
  }
  return null;
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

async function handleSpotifyLyrics(request, url, env) {
  const trackId = url.searchParams.get('track_id');
  if (!trackId) {
    return jsonResponse({ error: 'Missing track_id parameter' }, 400);
  }

  // Strategy 1: use client-provided OAuth token (avoids CDN IP blocks)
  const authHeader = request.headers.get('Authorization');
  if (authHeader) {
    const clientToken = authHeader.replace(/^Bearer\s+/i, '');
    const data = await fetchLyrics(trackId, clientToken);
    if (data) return jsonResponse(data);
  }

  // Strategy 2: fall back to sp_dc → web-player token
  const spDc = env.SP_DC;
  if (spDc) {
    try {
      let token = await getSpotifyToken(spDc);
      let data = await fetchLyrics(trackId, token);
      if (!data && cachedToken) {
        cachedToken = null;
        tokenExpiresAt = 0;
        token = await getSpotifyToken(spDc);
        data = await fetchLyrics(trackId, token);
      }
      if (data) return jsonResponse(data);
    } catch { /* sp_dc path failed, continue to 404 */ }
  }

  return jsonResponse({ error: 'Lyrics not found' }, 404);
}

async function handleDebugToken(env) {
  const spDc = env.SP_DC;
  if (!spDc) {
    return jsonResponse({ error: 'SP_DC secret not configured' }, 500);
  }

  const resp = await fetch(TOKEN_URL, {
    headers: {
      ...BROWSER_HEADERS,
      Cookie: `sp_dc=${spDc}`,
    },
    redirect: 'manual',
  });

  const body = await resp.text().catch(() => '<unreadable>');
  const respHeaders = Object.fromEntries(resp.headers.entries());

  return jsonResponse({
    status: resp.status,
    redirected: resp.redirected,
    responseHeaders: respHeaders,
    bodySnippet: body.slice(0, 500),
    spDcLength: spDc.length,
    spDcPrefix: spDc.slice(0, 8) + '…',
  });
}

async function handleKKBOXLyrics(url) {
  const title = url.searchParams.get('title');
  const artist = url.searchParams.get('artist');
  if (!title) {
    return jsonResponse({ error: 'Missing title parameter' }, 400);
  }

  const match = await searchKKBOX(title, artist || '');
  if (!match) {
    return jsonResponse({ error: 'No KKBOX results found' }, 404);
  }

  const plainLyrics = await scrapeKKBOXLyrics(match.url);
  if (!plainLyrics) {
    return jsonResponse({ error: 'Lyrics not found on KKBOX page' }, 404);
  }

  return jsonResponse({
    plainLyrics,
    territory: match.territory,
    exact: match.exact,
  });
}

export default {
  async fetch(request, env) {
    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: CORS_HEADERS });
    }

    const url = new URL(request.url);

    try {
      if (url.pathname === '/lyrics') {
        return await handleSpotifyLyrics(request, url, env);
      }
      if (url.pathname === '/kkbox-lyrics') {
        return await handleKKBOXLyrics(url);
      }
      if (url.pathname === '/debug-token') {
        return await handleDebugToken(env);
      }
      return jsonResponse({ error: 'Not found' }, 404);
    } catch (err) {
      return jsonResponse({ error: err.message }, 502);
    }
  },
};
