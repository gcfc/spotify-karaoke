import {
  artistMatches,
  artistMayMatch,
  isMarkedCover,
  normalizeForMatch,
  selectBestMatch,
  titleMatches,
  titleQueryVariants,
} from '../matching.js';
import {
  buildTranslationPrompt,
  decodeHtmlEntities,
  findProvider,
  googleTargetCode,
} from '../translate.js';
import {
  FURIGANA_ALLOWED_MODELS,
  FURIGANA_CACHE_TTL_S,
  FURIGANA_CHUNK_LINES,
  FURIGANA_GEMINI_TIMEOUT_MS,
  FURIGANA_MAX_LINE_CHARS,
  FURIGANA_MAX_LINES,
  FURIGANA_MODELS,
  furiganaCacheKey,
  furiganaEntry,
  geminiFuriganaRequest,
  geminiReplyJson,
  hasKanji,
  parseFuriganaReply,
} from '../furigana.js';
import {
  geminiRomanizeRequest,
  hasRomanWords,
  parseRomanizeReply,
  romanEntry,
  romanizeCacheKey,
  romanScriptOf,
  ROMANIZE_ALLOWED_MODELS,
  ROMANIZE_CACHE_TTL_S,
  ROMANIZE_CHAINS,
  ROMANIZE_CHUNK_LINES,
  ROMANIZE_GEMINI_TIMEOUT_MS,
  ROMANIZE_MAX_LINE_CHARS,
  ROMANIZE_MAX_LINES,
  ROMANIZE_STORED_MODEL,
} from '../romanize.js';

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

// ── KKBOX scraping helpers (deprecated) ──
//
// DEPRECATED (2026-10-31) — commented out to save the requests it made on
// every lookup.  KKBOX's lyrics live in each song page's JSON-LD, and those
// pages now sit behind an AWS WAF challenge: a request without an
// aws-waf-token cookie gets HTTP 202 + `x-amzn-waf-action: challenge` and a
// challenge page instead, which neither the Worker nor a cross-origin fetch()
// can get past.  The search API still answers, so every lookup spent five
// or more searches (five territories per title variant), from the Worker and
// from the browser each, finding a song whose page then failed.  Kept rather
// than deleted in case KKBOX drops the challenge; tests/test_kkbox.py checks
// whether it has.
//
// const KKBOX_HEADERS = {
//   'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
//   Accept: 'text/html',
// };
//
// const KKBOX_TERRITORIES = ['hk', 'tw', 'jp', 'sg', 'my'];
//
// /**
//  * Pick the song in a KKBOX search response that really is the track we asked
//  * for.  KKBOX answers every query with a full page of ~20 songs — even
//  * nonsense ones — so the top hit is not evidence of a match.  Matching folds
//  * Traditional to Simplified first, so Spotify's "在松手跟不松手之间" finds
//  * KKBOX's "在鬆手跟不鬆手之間".
//  */
// function pickKKBOXResult(data, title, artist) {
//   const results = data?.data?.result;
//   if (!Array.isArray(results) || results.length === 0) return null;
//
//   const candidates = results.map((r) => ({
//     title: r?.name || '',
//     artist: r?.album?.artist?.name || '',
//     url: r?.url || '',
//   }));
//
//   const index = selectBestMatch(candidates, title, artist);
//   if (index < 0 || !candidates[index].url) return null;
//   return candidates[index];
// }
//
// async function searchKKBOX(title, artist) {
//   const fullTitle = normalizeForMatch(title);
//   const queries = titleQueryVariants(title).map((name) => ({
//     q: `${name} ${artist}`.trim(),
//     exact: normalizeForMatch(name) === fullTitle,
//   }));
//
//   for (const { q, exact } of queries) {
//     for (const terr of KKBOX_TERRITORIES) {
//       const url = `https://www.kkbox.com/api/search/song?q=${encodeURIComponent(q)}&terr=${terr}&lang=tc`;
//       try {
//         const resp = await fetch(url, {
//           headers: { ...KKBOX_HEADERS, Accept: 'application/json' },
//         });
//         if (!resp.ok) continue;
//         const data = await resp.json();
//         const hit = pickKKBOXResult(data, title, artist);
//         if (hit) {
//           return {
//             url: hit.url,
//             territory: terr,
//             exact,
//             matchedTitle: hit.title,
//             matchedArtist: hit.artist,
//           };
//         }
//       } catch { continue; }
//     }
//   }
//   return null;
// }
//
// async function scrapeKKBOXLyrics(songUrl) {
//   const resp = await fetch(songUrl, { headers: KKBOX_HEADERS });
//   if (!resp.ok) return null;
//   const html = await resp.text();
//
//   const jsonLdRegex = /<script type="application\/ld\+json">([\s\S]*?)<\/script>/g;
//   let match;
//   while ((match = jsonLdRegex.exec(html)) !== null) {
//     try {
//       const data = JSON.parse(match[1]);
//       const text = data?.recordingOf?.lyrics?.text;
//       if (text) return text;
//     } catch {
//       // not the right JSON-LD block, keep looking
//     }
//   }
//   return null;
// }

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

async function searchQQ(title, artist, durationSec) {
  for (const name of titleQueryVariants(title)) {
    const q = encodeURIComponent(`${name} ${artist}`.trim());
    const url = `https://c.y.qq.com/soso/fcgi-bin/client_search_cp?format=json&p=1&n=10&w=${q}`;
    try {
      const resp = await fetch(url, { headers: QQ_HEADERS });
      if (!resp.ok) continue;
      const data = parseMaybeJSONP(await resp.text());
      const results = data?.data?.song?.list;
      if (!Array.isArray(results) || results.length === 0) continue;

      const candidates = results
        .map((song) => ({
          title: song?.songname || '',
          artist: (song?.singer || []).map((a) => a?.name || '').join(', '),
          mid: song?.songmid || '',
          durationSec: Number(song?.interval) || 0,
        }))
        .filter((c) => c.mid);

      // QQ ranks loosely — a search for a song it does not carry still returns
      // a page of the artist's other work — so the hit has to be verified.  It
      // also carries several cuts of one song (起风了 by 买辣椒也用券 at 312,
      // 321, 323, 325, 328 and 329s), so the length decides between them;
      // taking the first hit gave the 312s 旧版 (old version).
      const match = pickRecording(candidates, title, artist, durationSec);
      if (match) return match;
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

// ── Retrying transient failures ──

// Kugou and NetEase occasionally fail a single request and then answer the
// next one — one Kugou lookup in about seventy came back empty in testing and
// succeeded on re-run.  So a request that fails in a way that may not repeat
// (a network error, a 5xx, or a body that isn't JSON) is retried once after a
// short pause.  A 4xx is an answer, not a blip, and is not retried.  QQ is
// deliberately left out: its failures so far have been blocks lasting
// minutes, which a retry only prolongs.
const RETRY_DELAY_MS = 500;

/** GET a JSON endpoint, retrying once on a transient failure.  Resolves to
 *  null on a 4xx; throws if the retry fails too. */
async function fetchJSONWithRetry(url, init) {
  for (let attempt = 1; ; attempt++) {
    try {
      const resp = await fetch(url, init);
      if (resp.status >= 500) throw new Error(`HTTP ${resp.status}`);
      if (!resp.ok) return null;
      return await resp.json();
    } catch (err) {
      if (attempt >= 2) throw err;
      await new Promise((resolve) => setTimeout(resolve, RETRY_DELAY_MS));
    }
  }
}

// ── Recording matching for sources that report track length ──

// The same recording is listed a few seconds apart across platforms (up to
// ~4s measured), while a remix or radio edit of the same title is usually
// further off.  Lyrics timed for a different cut would drift out of sync.
const DURATION_TOLERANCE_S = 5;

function durationMatches(candidateSec, wantedSec) {
  if (!wantedSec) return true;
  return Math.abs(candidateSec - wantedSec) <= DURATION_TOLERANCE_S;
}

/**
 * Pick the search result that is the recording being played, for sources
 * that report each result's length (QQ, Kugou, NetEase).  Candidates are
 * `{ title, artist, durationSec, titles? }`; `titles` lists every form of the
 * title the source gives, defaulting to `[title]`.
 *
 * Results more than DURATION_TOLERANCE_S off are dropped, and so are covers:
 * by an artist who is recognisably someone else, or labelled as one in the
 * title.  Of the rest, a title that matches suffix and all goes first:
 * otherwise a live cut that happens to fall inside the tolerance ties with the
 * studio recording once suffixes are stripped, and can win on search order.
 *
 * A romanized artist can't be compared with a native name, so on its own a
 * cover by 睿轩 passes for BTS.  But when another recording of the same song
 * is credited to the artist under Spotify's name — NetEase lists "Dynamite
 * (Live)" by "BTS (防弹少年团)" — the service evidently knows them by it, and
 * a result credited to someone else is a cover.  Only recordings of the song
 * count: NetEase's 孤勇者 page also carries an unrelated track by an artist
 * named "Eason Chan", which says nothing about 陈奕迅's listing.
 */
function pickRecording(candidates, title, artist, durationSec) {
  const wantedTitle = normalizeForMatch(title);
  const artistKnown = candidates.some((c) =>
    titleMatches(c.title, title) && artistMatches(c.artist, artist));
  const plausible = candidates.filter((c) =>
    durationMatches(c.durationSec, durationSec)
    && (artistKnown ? artistMatches(c.artist, artist) : artistMayMatch(c.artist, artist))
    && !(c.titles || [c.title]).some((t) => isMarkedCover(t, title)));
  const exact = plausible.filter((c) =>
    (c.titles || [c.title]).some((t) => normalizeForMatch(t) === wantedTitle));

  for (const pool of [exact, plausible]) {
    const index = selectBestMatch(pool, title, artist);
    if (index >= 0) return pool[index];
  }
  return null;
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
  for (const name of titleQueryVariants(title)) {
    const q = encodeURIComponent(`${name} ${artist}`.trim());
    const url = `http://mobilecdn.kugou.com/api/v3/search/song?format=json&keyword=${q}&page=1&pagesize=20`;
    try {
      const data = await fetchJSONWithRetry(url, { headers: KUGOU_HEADERS });
      const results = data?.data?.info;
      if (!Array.isArray(results) || results.length === 0) continue;

      const candidates = results
        .map((song) => {
          const songname = song?.songname || '';
          const filenameTitle = kugouFilenameTitle(song);
          return {
            title: songname,
            titles: [songname, filenameTitle],
            filenameTitle,
            artist: song?.singername || '',
            hash: song?.hash || '',
            durationSec: Number(song?.duration) || 0,
          };
        })
        .filter((c) => c.hash);

      const match = pickRecording(candidates, title, artist, durationSec);
      if (match) return match;
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
    const search = await fetchJSONWithRetry(`http://lyrics.kugou.com/search?${searchParams}`, { headers: KUGOU_HEADERS });
    const candidates = search?.candidates;
    if (!Array.isArray(candidates)) return null;

    // Kugou also files ringtone-length snippets — 30 seconds of chorus —
    // under a song's title, so the lyric's own length is checked as well.
    const lyric = candidates.find((c) =>
      c?.id && c?.accesskey && durationMatches((Number(c.duration) || 0) / 1000, song.durationSec));
    if (!lyric) return null;

    const downloadParams = new URLSearchParams({
      ver: '1',
      client: 'pc',
      id: lyric.id,
      accesskey: lyric.accesskey,
      fmt: 'lrc',
      charset: 'utf8',
    });
    const download = await fetchJSONWithRetry(`http://lyrics.kugou.com/download?${downloadParams}`, { headers: KUGOU_HEADERS });
    const content = download?.content;
    return content ? decodeBase64Utf8(content) : null;
  } catch {
    return null;
  }
}

// ── NetEase Cloud Music (line-synced LRC) ──
//
// A lyric database of its own — Kugou and QQ are both Tencent Music and often
// serve identical LRC — so it covers different gaps.  Its own gap is
// licensing: Jay Chou and Hebe Tien's originals aren't there, and a search
// for them returns covers under the same title and length, which is what
// pickRecording's artist check is for.  The endpoints send no CORS headers.

const NETEASE_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
  Accept: 'application/json',
};

const LRC_TIMESTAMP_RE = /^\[\d+:\d+\.\d+\]/m;

async function searchNetEase(title, artist, durationSec) {
  for (const name of titleQueryVariants(title)) {
    const q = encodeURIComponent(`${name} ${artist}`.trim());
    const url = `https://music.163.com/api/search/get?s=${q}&type=1&limit=20`;
    try {
      const data = await fetchJSONWithRetry(url, { headers: NETEASE_HEADERS });
      const results = data?.result?.songs;
      if (data?.code !== 200 || !Array.isArray(results) || results.length === 0) continue;

      const candidates = results
        .map((song) => ({
          title: song?.name || '',
          artist: (song?.artists || []).map((a) => a?.name || '').join(', '),
          id: song?.id,
          durationSec: (Number(song?.duration) || 0) / 1000,
        }))
        .filter((c) => c.id);

      const match = pickRecording(candidates, title, artist, durationSec);
      if (match) return match;
    } catch { continue; }
  }
  return null;
}

async function fetchNetEaseLyrics(id) {
  const url = `https://music.163.com/api/song/lyric?id=${encodeURIComponent(id)}&lv=1`;
  try {
    const lyric = (await fetchJSONWithRetry(url, { headers: NETEASE_HEADERS }))?.lrc?.lyric;
    // Some songs carry untimed text in the same field.
    return lyric && LRC_TIMESTAMP_RE.test(lyric) ? lyric : null;
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
 * strings and only its length needs checking.  `modelVersion` is the model
 * that actually answered, which for an alias such as
 * gemini-flash-lite-latest is not the name it was asked by.
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
  return { translations: JSON.parse(text), modelVersion: data?.modelVersion || model };
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
  return { translations: JSON.parse(content).lines, modelVersion: data?.model || model };
}

/**
 * Readings for each kanji run of each line.  The runs are worked out here
 * from the shared furigana.js, so the model is only ever asked for readings
 * and never writes the lyrics back; the kana it is given along with each
 * run is cut from its answer before the answer leaves the Worker.
 */
async function furiganaWithGemini(lines, model, apiKey) {
  const entries = lines.map(furiganaEntry);
  const resp = await fetch(`${GEMINI_ENDPOINT}/${model}:generateContent`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-goog-api-key': apiKey },
    body: JSON.stringify(geminiFuriganaRequest(entries)),
    signal: AbortSignal.timeout(FURIGANA_GEMINI_TIMEOUT_MS),
  });

  if (!resp.ok) {
    const err = new Error(`Gemini HTTP ${resp.status}: ${(await resp.text()).slice(0, 200)}`);
    err.status = resp.status;
    throw err;
  }
  return parseFuriganaReply(entries, geminiReplyJson(await resp.json()));
}

/**
 * A song's readings, read in chunks of FURIGANA_CHUNK_LINES sent together.
 * A chunk that fails leaves its lines null; `failures` holds why.
 */
async function furiganaForSong(lines, model, apiKey) {
  const chunks = [];
  for (let i = 0; i < lines.length; i += FURIGANA_CHUNK_LINES) chunks.push(lines.slice(i, i + FURIGANA_CHUNK_LINES));
  const settled = await Promise.allSettled(chunks.map((chunk) => furiganaWithGemini(chunk, model, apiKey)));

  const readings = [];
  const failures = [];
  settled.forEach((s, k) => {
    if (s.status === 'fulfilled') {
      readings.push(...s.value);
    } else {
      failures.push(s.reason);
      readings.push(...chunks[k].map(() => null));
    }
  });
  return { readings, failures, chunks: chunks.length };
}

/**
 * Romanizations for each word of each line, as `[[start, end, text], …]`
 * per line.  The words are split here, from the shared romanize.js, and
 * sent back with their offsets, so the page draws each over the word the
 * Worker split — Thai's dictionary split can differ between platforms.
 */
async function romanizeWithGemini(lines, group, language, model, apiKey) {
  const entries = lines.map((line) => romanEntry(line, group));
  const resp = await fetch(`${GEMINI_ENDPOINT}/${model}:generateContent`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-goog-api-key': apiKey },
    body: JSON.stringify(geminiRomanizeRequest(entries, language)),
    signal: AbortSignal.timeout(ROMANIZE_GEMINI_TIMEOUT_MS),
  });
  if (!resp.ok) {
    const err = new Error(`Gemini HTTP ${resp.status}: ${(await resp.text()).slice(0, 200)}`);
    err.status = resp.status;
    throw err;
  }
  return parseRomanizeReply(entries, geminiReplyJson(await resp.json()));
}

/** A song's romanizations, in chunks of ROMANIZE_CHUNK_LINES sent together. */
async function romanizeSong(lines, group, language, model, apiKey) {
  const chunks = [];
  for (let i = 0; i < lines.length; i += ROMANIZE_CHUNK_LINES) chunks.push(lines.slice(i, i + ROMANIZE_CHUNK_LINES));
  const settled = await Promise.allSettled(chunks.map((chunk) => romanizeWithGemini(chunk, group, language, model, apiKey)));
  const romanized = [];
  const failures = [];
  settled.forEach((s, k) => {
    if (s.status === 'fulfilled') {
      romanized.push(...s.value);
    } else {
      failures.push(s.reason);
      romanized.push(...chunks[k].map(() => null));
    }
  });
  return { romanized, failures, chunks: chunks.length };
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

// DEPRECATED (2026-10-31) — see the KKBOX note above.  /kkbox-lyrics now
// falls through to the 404 for unknown routes.
// async function handleKKBOXLyrics(url) {
//   const title = url.searchParams.get('title');
//   const artist = url.searchParams.get('artist');
//   if (!title) {
//     return jsonResponse({ error: 'Missing title parameter' }, 400);
//   }
//
//   const match = await searchKKBOX(title, artist || '');
//   if (!match) {
//     return jsonResponse({ error: 'No matching KKBOX song found' }, 404);
//   }
//
//   const plainLyrics = await scrapeKKBOXLyrics(match.url);
//   if (!plainLyrics) {
//     return jsonResponse({ error: 'Lyrics not found on KKBOX page', songUrl: match.url }, 404);
//   }
//
//   return jsonResponse({
//     plainLyrics,
//     territory: match.territory,
//     exact: match.exact,
//     matchedTitle: match.matchedTitle,
//     matchedArtist: match.matchedArtist,
//   });
// }

async function handleQQLyrics(url) {
  const title = url.searchParams.get('title');
  const artist = url.searchParams.get('artist');
  const durationSec = Number(url.searchParams.get('duration')) || 0;
  if (!title) {
    return jsonResponse({ error: 'Missing title parameter' }, 400);
  }

  const match = await searchQQ(title, artist || '', durationSec);
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
    matchedDurationSec: match.durationSec,
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

async function handleNetEaseLyrics(url) {
  const title = url.searchParams.get('title');
  const artist = url.searchParams.get('artist');
  const durationSec = Number(url.searchParams.get('duration')) || 0;
  if (!title) {
    return jsonResponse({ error: 'Missing title parameter' }, 400);
  }

  const match = await searchNetEase(title, artist || '', durationSec);
  if (!match) {
    return jsonResponse({ error: 'No matching NetEase song found' }, 404);
  }

  const syncedLyrics = await fetchNetEaseLyrics(match.id);
  if (!syncedLyrics) {
    return jsonResponse({ error: 'Synced lyrics not available for this NetEase song' }, 404);
  }

  return jsonResponse({
    syncedLyrics,
    matchedTitle: match.title,
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
  let modelVersion;
  try {
    ({ translations, modelVersion } = backend === 'gemini'
      ? await translateWithGemini(lines, target, model, apiKey)
      : await translateWithOpenRouter(lines, target, model, apiKey));
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

  return jsonResponse({ translations: translations.map(decodeHtmlEntities), model, modelVersion });
}

/**
 * Readings for a song's distinct kanji lines.  Stored readings are looked up
 * first (the FURIGANA_CACHE KV namespace, keyed by a hash of the lines), so
 * a song read once is never sent to a model again.  Only what this Worker
 * got from the first model in FURIGANA_MODELS, for every chunk, is stored:
 * a client cannot write readings of its own, and a song read while that
 * model was down is read again by it later rather than kept at a lower
 * quality.  Without the binding the route works, uncached.
 */
async function handleFurigana(request, env, ctx) {
  const apiKey = env.GEMINI_API_KEY;
  if (!apiKey) {
    // 501 tells the client furigana is unconfigured, not broken.
    return jsonResponse({ error: 'GEMINI_API_KEY secret not configured' }, 501);
  }

  let body;
  try {
    body = await request.json();
  } catch {
    return jsonResponse({ error: 'Body must be JSON' }, 400);
  }

  const lines = body?.lines;
  if (!Array.isArray(lines) || lines.length === 0 || lines.length > FURIGANA_MAX_LINES) {
    return jsonResponse({ error: `lines must be an array of 1–${FURIGANA_MAX_LINES} strings` }, 400);
  }
  if (!lines.every((l) => typeof l === 'string' && l.length <= FURIGANA_MAX_LINE_CHARS && hasKanji(l))) {
    return jsonResponse({ error: `every line must be a string of at most ${FURIGANA_MAX_LINE_CHARS} characters containing kanji` }, 400);
  }

  const model = body?.model || FURIGANA_MODELS[0];
  if (!FURIGANA_ALLOWED_MODELS.includes(model)) {
    return jsonResponse({ error: `Unknown furigana model: ${model}` }, 400);
  }

  const cache = env.FURIGANA_CACHE;
  const key = cache ? await furiganaCacheKey(lines) : null;
  if (cache) {
    const stored = await cache.get(key, 'json').catch(() => null);
    if (Array.isArray(stored?.readings) && stored.readings.length === lines.length) {
      return jsonResponse({ readings: stored.readings, model: stored.model, cached: true, complete: true });
    }
  }

  const { readings, failures, chunks } = await furiganaForSong(lines, model, apiKey);

  if (failures.length === chunks) {
    // Busy (429) and overloaded (503) pass through so the client can tell
    // them from a model that answered wrongly.
    const status = failures.every((f) => f.status === 429 || f.status === 503) ? failures[0].status : 502;
    return jsonResponse({ error: failures[0].message }, status);
  }

  const complete = failures.length === 0;
  if (cache && complete && model === FURIGANA_MODELS[0]) {
    const put = cache.put(key, JSON.stringify({ readings, model, storedAt: new Date().toISOString() }), {
      expirationTtl: FURIGANA_CACHE_TTL_S,
    }).catch(() => {});
    // Store after answering, not before.
    if (ctx?.waitUntil) ctx.waitUntil(put); else await put;
  }

  return jsonResponse({ readings, model, cached: false, complete });
}

/**
 * Romanizations for a song's distinct lines in Hindi, Thai, Arabic, Hebrew
 * (and the other languages of their scripts).  As with /furigana, stored
 * answers are looked up first — in the same KV namespace, under keys
 * starting "romanize:" — and only a complete answer from the first model
 * is stored.
 */
async function handleRomanize(request, env, ctx) {
  const apiKey = env.GEMINI_API_KEY;
  if (!apiKey) return jsonResponse({ error: 'GEMINI_API_KEY secret not configured' }, 501);

  let body;
  try {
    body = await request.json();
  } catch {
    return jsonResponse({ error: 'Body must be JSON' }, 400);
  }

  const language = body?.language;
  const group = romanScriptOf(language);
  // Greek is romanized by rules in the page; no model is spent on it.
  if (!group || !ROMANIZE_CHAINS[group].some((step) => ROMANIZE_ALLOWED_MODELS.includes(step))) {
    return jsonResponse({ error: `Unknown romanization language: ${language}` }, 400);
  }
  const lines = body?.lines;
  if (!Array.isArray(lines) || lines.length === 0 || lines.length > ROMANIZE_MAX_LINES) {
    return jsonResponse({ error: `lines must be an array of 1–${ROMANIZE_MAX_LINES} strings` }, 400);
  }
  if (!lines.every((l) => typeof l === 'string' && l.length <= ROMANIZE_MAX_LINE_CHARS && hasRomanWords(l, group))) {
    return jsonResponse({ error: `every line must be a string of at most ${ROMANIZE_MAX_LINE_CHARS} characters with words in the language's script` }, 400);
  }
  const model = body?.model || ROMANIZE_STORED_MODEL;
  if (!ROMANIZE_ALLOWED_MODELS.includes(model)) {
    return jsonResponse({ error: `Unknown romanization model: ${model}` }, 400);
  }

  const cache = env.FURIGANA_CACHE;
  const key = cache ? await romanizeCacheKey(language, lines) : null;
  if (cache) {
    const stored = await cache.get(key, 'json').catch(() => null);
    if (Array.isArray(stored?.romanized) && stored.romanized.length === lines.length) {
      return jsonResponse({ romanized: stored.romanized, model: stored.model, cached: true, complete: true });
    }
  }

  const { romanized, failures, chunks } = await romanizeSong(lines, group, language, model, apiKey);
  if (failures.length === chunks) {
    const status = failures.every((f) => f.status === 429 || f.status === 503) ? failures[0].status : 502;
    return jsonResponse({ error: failures[0].message }, status);
  }

  const complete = failures.length === 0;
  if (cache && complete && model === ROMANIZE_STORED_MODEL) {
    const put = cache.put(key, JSON.stringify({ romanized, model, storedAt: new Date().toISOString() }), {
      expirationTtl: ROMANIZE_CACHE_TTL_S,
    }).catch(() => {});
    if (ctx?.waitUntil) ctx.waitUntil(put); else await put;
  }
  return jsonResponse({ romanized, model, cached: false, complete });
}

export default {
  async fetch(request, env, ctx) {
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
      if (url.pathname === '/furigana') {
        if (request.method !== 'POST') {
          return jsonResponse({ error: 'Use POST' }, 405);
        }
        return await handleFurigana(request, env, ctx);
      }
      if (url.pathname === '/romanize') {
        if (request.method !== 'POST') {
          return jsonResponse({ error: 'Use POST' }, 405);
        }
        return await handleRomanize(request, env, ctx);
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
      if (url.pathname === '/netease-lyrics') {
        return await handleNetEaseLyrics(url);
      }
      // Deprecated — see the KKBOX note above.
      // if (url.pathname === '/kkbox-lyrics') {
      //   return await handleKKBOXLyrics(url);
      // }
      if (url.pathname === '/debug-token') {
        return await handleDebugToken(env);
      }
      return jsonResponse({ error: 'Not found' }, 404);
    } catch (err) {
      return jsonResponse({ error: err.message }, 502);
    }
  },
};
