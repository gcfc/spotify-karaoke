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

export default {
  async fetch(request, env) {
    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: CORS_HEADERS });
    }

    const url = new URL(request.url);

    if (url.pathname !== '/lyrics') {
      return new Response(JSON.stringify({ error: 'Not found' }), {
        status: 404,
        headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
      });
    }

    const trackId = url.searchParams.get('track_id');
    if (!trackId) {
      return new Response(JSON.stringify({ error: 'Missing track_id parameter' }), {
        status: 400,
        headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
      });
    }

    const spDc = env.SP_DC;
    if (!spDc) {
      return new Response(JSON.stringify({ error: 'SP_DC secret not configured' }), {
        status: 500,
        headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
      });
    }

    try {
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
        return new Response(JSON.stringify({ error: 'Lyrics not found' }), {
          status: 404,
          headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
        });
      }

      return new Response(JSON.stringify(data), {
        headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
      });
    } catch (err) {
      return new Response(JSON.stringify({ error: err.message }), {
        status: 502,
        headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
      });
    }
  },
};
