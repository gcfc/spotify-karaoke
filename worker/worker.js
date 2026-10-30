import { normalizeForMatch, selectBestMatch, titleQueryVariants } from '../matching.js';
import {
  buildTranslationPrompt,
  decodeHtmlEntities,
  findProvider,
  googleTargetCode,
} from '../translate.js';

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
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

/**
 * Pick the song in a KKBOX search response that really is the track we asked
 * for.  KKBOX answers every query with a full page of ~20 songs — even
 * nonsense ones — so the top hit is not evidence of a match.  Matching folds
 * Traditional to Simplified first, so Spotify's "在松手跟不松手之间" finds
 * KKBOX's "在鬆手跟不鬆手之間".
 */
function pickKKBOXResult(data, title, artist) {
  const results = data?.data?.result;
  if (!Array.isArray(results) || results.length === 0) return null;

  const candidates = results.map((r) => ({
    title: r?.name || '',
    artist: r?.album?.artist?.name || '',
    url: r?.url || '',
  }));

  const index = selectBestMatch(candidates, title, artist);
  if (index < 0 || !candidates[index].url) return null;
  return candidates[index];
}

async function searchKKBOX(title, artist) {
  const fullTitle = normalizeForMatch(title);
  const queries = titleQueryVariants(title).map((name) => ({
    q: `${name} ${artist}`.trim(),
    exact: normalizeForMatch(name) === fullTitle,
  }));

  for (const { q, exact } of queries) {
    for (const terr of KKBOX_TERRITORIES) {
      const url = `https://www.kkbox.com/api/search/song?q=${encodeURIComponent(q)}&terr=${terr}&lang=tc`;
      try {
        const resp = await fetch(url, {
          headers: { ...KKBOX_HEADERS, Accept: 'application/json' },
        });
        if (!resp.ok) continue;
        const data = await resp.json();
        const hit = pickKKBOXResult(data, title, artist);
        if (hit) {
          return {
            url: hit.url,
            territory: terr,
            exact,
            matchedTitle: hit.title,
            matchedArtist: hit.artist,
          };
        }
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

// ── QQ Music (line-synced LRC) ──

const QQ_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
  // The lyric endpoint answers retcode -1310 without a y.qq.com referer.  A
  // browser cannot set a cross-origin Referer, which is why QQ Music has to be
  // fetched here rather than direct from the page.
  Referer: 'https://y.qq.com/portal/player.html',
  Accept: 'application/json',
};

// format=json returns plain JSON today, but the endpoint is undocumented and
// some of its siblings wrap the payload in a JSONP callback.
function parseMaybeJSONP(text) {
  try {
    return JSON.parse(text);
  } catch {
    return JSON.parse(text.trim().replace(/^\w+\(/, '').replace(/\)$/, ''));
  }
}

async function searchQQ(title, artist) {
  for (const name of titleQueryVariants(title)) {
    const q = encodeURIComponent(`${name} ${artist}`.trim());
    const url = `https://c.y.qq.com/soso/fcgi-bin/client_search_cp?format=json&p=1&n=10&w=${q}`;
    try {
      const resp = await fetch(url, { headers: QQ_HEADERS });
      if (!resp.ok) continue;
      const data = parseMaybeJSONP(await resp.text());
      const results = data?.data?.song?.list;
      if (!Array.isArray(results) || results.length === 0) continue;

      const candidates = results.map((song) => ({
        title: song?.songname || '',
        artist: (song?.singer || []).map((a) => a?.name || '').join(', '),
        mid: song?.songmid || '',
      }));

      // QQ ranks loosely — a search for a song it does not carry still returns
      // a page of the artist's other work — so the hit has to be verified.
      const index = selectBestMatch(candidates, title, artist);
      if (index >= 0 && candidates[index].mid) return candidates[index];
    } catch { continue; }
  }
  return null;
}

async function fetchQQLyrics(mid) {
  const url = `https://c.y.qq.com/lyric/fcgi-bin/fcg_query_lyric_new.fcg?songmid=${encodeURIComponent(mid)}&format=json&nobase64=1&g_tk=5381`;
  try {
    const resp = await fetch(url, { headers: QQ_HEADERS });
    if (!resp.ok) return null;
    const data = parseMaybeJSONP(await resp.text());
    if (data?.retcode !== 0) return null;
    return data.lyric || null;
  } catch {
    return null;
  }
}

// ── Kugou Music (line-synced LRC) ──
//
// Stands in for kugeci.com, which serves the same kind of LRC but sits behind
// a Cloudflare managed challenge that no fetch() — here or in the browser —
// can pass.  Both Kugou endpoints are plain HTTP only (the HTTPS hosts present
// a mismatched certificate or reset the connection), so a page served over
// HTTPS could not call them even if they sent CORS headers.

const KUGOU_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
  Accept: 'application/json',
};

// The same recording is listed a few seconds apart across platforms (up to
// ~4s measured), while a remix or radio edit of the same title is usually
// further off.  Lyrics timed for a different cut would drift out of sync.
const KUGOU_DURATION_TOLERANCE_S = 5;

function kugouDurationMatches(candidateSec, wantedSec) {
  if (!wantedSec) return true;
  return Math.abs(candidateSec - wantedSec) <= KUGOU_DURATION_TOLERANCE_S;
}

// `songname` sometimes drops the version suffix — the original 不能成情人 and
// its 港风电音 remix are both listed as plain "不能成情人" — whereas
// `filename` ("<singers> - <title>") keeps it.  `filename` can also carry a
// promo note instead (小幸运【《我的少女时代》电影主题曲】), so neither field
// alone is the title.
function kugouFilenameTitle(song) {
  const prefix = `${song?.singername || ''} - `;
  const filename = song?.filename || '';
  if (song?.singername && filename.startsWith(prefix)) return filename.slice(prefix.length);
  return song?.songname || '';
}

/**
 * Find the Kugou recording that is the track being played.  The song search
 * resolves romanized artists ("Hebe Tien" → 田馥甄), which the lyric search
 * cannot, and returns each recording's hash and length so the lyrics can be
 * tied to the right cut.
 */
async function searchKugou(title, artist, durationSec) {
  const wantedTitle = normalizeForMatch(title);

  for (const name of titleQueryVariants(title)) {
    const q = encodeURIComponent(`${name} ${artist}`.trim());
    const url = `http://mobilecdn.kugou.com/api/v3/search/song?format=json&keyword=${q}&page=1&pagesize=20`;
    try {
      const resp = await fetch(url, { headers: KUGOU_HEADERS });
      if (!resp.ok) continue;
      const data = await resp.json();
      const results = data?.data?.info;
      if (!Array.isArray(results) || results.length === 0) continue;

      const candidates = results
        .map((song) => ({
          title: song?.songname || '',
          filenameTitle: kugouFilenameTitle(song),
          artist: song?.singername || '',
          hash: song?.hash || '',
          durationSec: Number(song?.duration) || 0,
        }))
        .filter((c) => c.hash && kugouDurationMatches(c.durationSec, durationSec));

      // A title that matches suffix and all goes first.  Otherwise a live cut
      // that happens to fall inside the tolerance ties with the studio
      // recording once suffixes are stripped, and can win on search order.
      const exact = candidates.filter((c) =>
        normalizeForMatch(c.title) === wantedTitle || normalizeForMatch(c.filenameTitle) === wantedTitle);
      for (const pool of [exact, candidates]) {
        const index = selectBestMatch(pool, title, artist);
        if (index >= 0) return pool[index];
      }
    } catch { continue; }
  }
  return null;
}

function decodeBase64Utf8(base64) {
  const bytes = Uint8Array.from(atob(base64), (ch) => ch.charCodeAt(0));
  return new TextDecoder().decode(bytes);
}

async function fetchKugouLyrics(song) {
  try {
    const searchParams = new URLSearchParams({
      ver: '1',
      man: 'yes',
      client: 'pc',
      keyword: `${song.artist} - ${song.title}`,
      duration: String(song.durationSec * 1000),
      hash: song.hash,
    });
    const searchResp = await fetch(`http://lyrics.kugou.com/search?${searchParams}`, { headers: KUGOU_HEADERS });
    if (!searchResp.ok) return null;
    const candidates = (await searchResp.json())?.candidates;
    if (!Array.isArray(candidates)) return null;

    // Kugou also files ringtone-length snippets — 30 seconds of chorus —
    // under a song's title, so the lyric's own length is checked as well.
    const lyric = candidates.find((c) =>
      c?.id && c?.accesskey && kugouDurationMatches((Number(c.duration) || 0) / 1000, song.durationSec));
    if (!lyric) return null;

    const downloadParams = new URLSearchParams({
      ver: '1',
      client: 'pc',
      id: lyric.id,
      accesskey: lyric.accesskey,
      fmt: 'lrc',
      charset: 'utf8',
    });
    const downloadResp = await fetch(`http://lyrics.kugou.com/download?${downloadParams}`, { headers: KUGOU_HEADERS });
    if (!downloadResp.ok) return null;
    const content = (await downloadResp.json())?.content;
    return content ? decodeBase64Utf8(content) : null;
  } catch {
    return null;
  }
}

// ── Google Cloud Translation v2 ──

const GOOGLE_TRANSLATE_ENDPOINT = 'https://translation.googleapis.com/language/translate/v2';

// The v2 API caps a request at 128 text segments.
const TRANSLATE_SEGMENT_LIMIT = 128;

async function translateChunkGoogleCloud(lines, target, apiKey) {
  const resp = await fetch(`${GOOGLE_TRANSLATE_ENDPOINT}?key=${encodeURIComponent(apiKey)}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ q: lines, target: googleTargetCode(target), format: 'text' }),
  });

  if (!resp.ok) {
    const detail = await resp.text().catch(() => '');
    throw new Error(`Google Translate HTTP ${resp.status}: ${detail.slice(0, 200)}`);
  }

  const data = await resp.json();
  const translations = data?.data?.translations;
  if (!Array.isArray(translations) || translations.length !== lines.length) {
    throw new Error('Google Translate returned a misaligned response');
  }
  return translations.map((t) => decodeHtmlEntities(t.translatedText || ''));
}

// ── LLM translation providers ──

const GEMINI_ENDPOINT = 'https://generativelanguage.googleapis.com/v1beta/models';
const OPENROUTER_ENDPOINT = 'https://openrouter.ai/api/v1/chat/completions';

/**
 * Gemini takes a JSON schema directly, so the reply is already an array of
 * strings and only its length needs checking.
 */
async function translateWithGemini(lines, target, model, apiKey) {
  const resp = await fetch(`${GEMINI_ENDPOINT}/${model}:generateContent`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-goog-api-key': apiKey },
    body: JSON.stringify({
      contents: [{ parts: [{ text: buildTranslationPrompt(lines, target) }] }],
      generationConfig: {
        temperature: 0,
        responseMimeType: 'application/json',
        responseSchema: { type: 'ARRAY', items: { type: 'STRING' } },
      },
    }),
  });

  if (!resp.ok) {
    throw new Error(`Gemini HTTP ${resp.status}: ${(await resp.text()).slice(0, 200)}`);
  }

  const data = await resp.json();
  const text = data?.candidates?.[0]?.content?.parts?.map((p) => p.text).join('') || '';
  if (!text) throw new Error('Gemini returned no content');
  return JSON.parse(text);
}

/**
 * OpenRouter follows the OpenAI shape, where a json_schema has to wrap the
 * array in an object.
 */
async function translateWithOpenRouter(lines, target, model, apiKey) {
  const resp = await fetch(OPENROUTER_ENDPOINT, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({
      model,
      temperature: 0,
      messages: [{ role: 'user', content: buildTranslationPrompt(lines, target) }],
      response_format: {
        type: 'json_schema',
        json_schema: {
          name: 'translation',
          strict: true,
          schema: {
            type: 'object',
            properties: { lines: { type: 'array', items: { type: 'string' } } },
            required: ['lines'],
            additionalProperties: false,
          },
        },
      },
    }),
  });

  if (!resp.ok) {
    throw new Error(`OpenRouter HTTP ${resp.status}: ${(await resp.text()).slice(0, 200)}`);
  }

  const data = await resp.json();
  const content = data?.choices?.[0]?.message?.content;
  if (!content) throw new Error(`OpenRouter returned no content (${data?.choices?.[0]?.finish_reason})`);
  return JSON.parse(content).lines;
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
    return jsonResponse({ error: 'No matching KKBOX song found' }, 404);
  }

  const plainLyrics = await scrapeKKBOXLyrics(match.url);
  if (!plainLyrics) {
    return jsonResponse({ error: 'Lyrics not found on KKBOX page', songUrl: match.url }, 404);
  }

  return jsonResponse({
    plainLyrics,
    territory: match.territory,
    exact: match.exact,
    matchedTitle: match.matchedTitle,
    matchedArtist: match.matchedArtist,
  });
}

async function handleQQLyrics(url) {
  const title = url.searchParams.get('title');
  const artist = url.searchParams.get('artist');
  if (!title) {
    return jsonResponse({ error: 'Missing title parameter' }, 400);
  }

  const match = await searchQQ(title, artist || '');
  if (!match) {
    return jsonResponse({ error: 'No matching QQ Music song found' }, 404);
  }

  const syncedLyrics = await fetchQQLyrics(match.mid);
  if (!syncedLyrics) {
    return jsonResponse({ error: 'Lyrics not available for this QQ Music song' }, 404);
  }

  return jsonResponse({
    syncedLyrics,
    matchedTitle: match.title,
    matchedArtist: match.artist,
  });
}

async function handleKugouLyrics(url) {
  const title = url.searchParams.get('title');
  const artist = url.searchParams.get('artist');
  const durationSec = Number(url.searchParams.get('duration')) || 0;
  if (!title) {
    return jsonResponse({ error: 'Missing title parameter' }, 400);
  }

  const match = await searchKugou(title, artist || '', durationSec);
  if (!match) {
    return jsonResponse({ error: 'No matching Kugou song found' }, 404);
  }

  const syncedLyrics = await fetchKugouLyrics(match);
  if (!syncedLyrics) {
    return jsonResponse({ error: 'Lyrics not available for this Kugou song' }, 404);
  }

  return jsonResponse({
    syncedLyrics,
    matchedTitle: match.filenameTitle,
    matchedArtist: match.artist,
    matchedDurationSec: match.durationSec,
  });
}

async function handleTranslate(request, env) {
  const apiKey = env.GOOGLE_TRANSLATE_API_KEY;
  if (!apiKey) {
    // 501 rather than 500: the client reads this as "use the keyless provider".
    return jsonResponse({ error: 'GOOGLE_TRANSLATE_API_KEY secret not configured' }, 501);
  }

  let body;
  try {
    body = await request.json();
  } catch {
    return jsonResponse({ error: 'Body must be JSON' }, 400);
  }

  const lines = body?.lines;
  const target = body?.target === 'zh' ? 'zh' : 'en';
  if (!Array.isArray(lines) || lines.length === 0) {
    return jsonResponse({ error: 'Missing lines array' }, 400);
  }
  if (!lines.every((line) => typeof line === 'string')) {
    return jsonResponse({ error: 'lines must all be strings' }, 400);
  }

  const translations = [];
  for (let i = 0; i < lines.length; i += TRANSLATE_SEGMENT_LIMIT) {
    const chunk = lines.slice(i, i + TRANSLATE_SEGMENT_LIMIT);
    translations.push(...(await translateChunkGoogleCloud(chunk, target, apiKey)));
  }

  return jsonResponse({ translations, target });
}

async function handleLlmTranslate(request, env) {
  let body;
  try {
    body = await request.json();
  } catch {
    return jsonResponse({ error: 'Body must be JSON' }, 400);
  }

  const provider = findProvider(body?.provider);
  if (!provider?.llm) {
    return jsonResponse({ error: `Unknown LLM provider: ${body?.provider}` }, 400);
  }

  const lines = body?.lines;
  const target = body?.target === 'zh' ? 'zh' : 'en';
  if (!Array.isArray(lines) || lines.length === 0 || !lines.every((l) => typeof l === 'string')) {
    return jsonResponse({ error: 'lines must be a non-empty array of strings' }, 400);
  }

  const { backend, model } = provider.llm;
  const apiKey = backend === 'gemini' ? env.GEMINI_API_KEY : env.OPENROUTER_API_KEY;
  if (!apiKey) {
    // 501 tells the client this provider is unconfigured, not broken.
    const secret = backend === 'gemini' ? 'GEMINI_API_KEY' : 'OPENROUTER_API_KEY';
    return jsonResponse({ error: `${secret} secret not configured` }, 501);
  }

  let translations;
  try {
    translations = backend === 'gemini'
      ? await translateWithGemini(lines, target, model, apiKey)
      : await translateWithOpenRouter(lines, target, model, apiKey);
  } catch (err) {
    return jsonResponse({ error: err.message }, 502);
  }

  // The model can silently drop lines; pairing by index only works if the
  // count matches, so a mismatch is reported rather than returned.
  if (!Array.isArray(translations) || translations.length !== lines.length) {
    return jsonResponse({
      error: `Model returned ${translations?.length} translations for ${lines.length} lines`,
    }, 502);
  }

  return jsonResponse({ translations: translations.map(decodeHtmlEntities), model });
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
      if (url.pathname === '/llm-translate') {
        if (request.method !== 'POST') {
          return jsonResponse({ error: 'Use POST' }, 405);
        }
        return await handleLlmTranslate(request, env);
      }
      if (url.pathname === '/translate') {
        if (request.method !== 'POST') {
          return jsonResponse({ error: 'Use POST' }, 405);
        }
        return await handleTranslate(request, env);
      }
      if (url.pathname === '/qq-lyrics') {
        return await handleQQLyrics(url);
      }
      if (url.pathname === '/kugou-lyrics') {
        return await handleKugouLyrics(url);
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
