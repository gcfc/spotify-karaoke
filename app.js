import { fetchLyrics } from './lyrics.js';
import { DEFAULT_LOCATION, isDaylight, lastSolarTransition, nextSolarTransition } from './sun.js';
import { detectLyricsLanguage, normalizeProvider, shouldOfferTranslation, translateLines } from './translate.js';

// ============================================================
//  Configuration — fill these in before deploying
// ============================================================

const CONFIG = {
  SPOTIFY_CLIENT_ID: '1253e21fe567410c99a9eddeb94b4d35', // Your Spotify app's client ID
  REDIRECT_URI: window.location.origin + window.location.pathname,
  SCOPES: 'user-read-currently-playing user-read-playback-state user-modify-playback-state',
  // URL of your Cloudflare Worker lyrics proxy (leave empty to skip)
  WORKER_URL: 'https://spotify-lyrics-worker.spotify-karaoke.workers.dev',
  POLL_INTERVAL_MS: 1000,
};

// ============================================================
//  DOM refs
// ============================================================

const $ = (sel) => document.querySelector(sel);
const loginScreen = $('#login-screen');
const mainScreen = $('#main-screen');
const connectBtn = $('#connect-btn');
const disconnectBtn = $('#disconnect-btn');
const albumArt = $('#album-art');
const trackNameEl = $('#track-name');
const artistNameEl = $('#artist-name');
const progressCurrent = $('#progress-current');
const progressTotal = $('#progress-total');
const progressFill = $('#progress-bar-fill');
const lyricsContainer = $('#lyrics-container');
const lyricsLines = $('#lyrics-lines');
const statusMessage = $('#status-message');
const statusText = $('#status-text');
const lyricsSourceEl = $('#lyrics-source');
const themeToggle = $('#theme-toggle');
const touchControlToggle = $('#touch-control-toggle');
const progressBarTrack = $('.progress-bar-track');
const lyricsOffsetEl = $('#lyrics-offset');
const offsetResetBtn = lyricsOffsetEl.querySelector('.offset-reset');
const cjkFontPicker = $('#cjk-font-picker');
const translateControl = $('#translate-control');
const translateToggle = $('#translate-toggle');
const translateMenuToggle = $('#translate-menu-toggle');

// ============================================================
//  State
// ============================================================

let accessToken = null;
let refreshToken = null;
let tokenExpiresAt = 0;

let currentTrackId = null;
let isPlaying = false;
let lastProgressMs = 0;
let lastPollTimestamp = 0;
let durationMs = 0;

let lyrics = null;       // { syncType, lines } or { plain } or null
let syncType = null;     // 'WORD_SYNCED' | 'LINE_SYNCED' | 'PLAIN' | null
let lyricsLanguage = null; // language tag from Spotify (e.g. 'ja', 'zh-Hant')
let lyricsOffsetMs = 0;
let rafId = null;
let pollTimer = null;
let smoothPositionMs = 0;
let lastSeekTimestamp = 0;

// ============================================================
//  Spotify PKCE Auth
// ============================================================

function generateRandomString(length) {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-._~';
  const values = crypto.getRandomValues(new Uint8Array(length));
  return Array.from(values, (v) => chars[v % chars.length]).join('');
}

async function sha256(plain) {
  const encoder = new TextEncoder();
  return crypto.subtle.digest('SHA-256', encoder.encode(plain));
}

function base64urlEncode(buffer) {
  const bytes = new Uint8Array(buffer);
  let str = '';
  bytes.forEach((b) => (str += String.fromCharCode(b)));
  return btoa(str).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

async function startAuth() {
  const verifier = generateRandomString(64);
  sessionStorage.setItem('pkce_verifier', verifier);
  const challenge = base64urlEncode(await sha256(verifier));

  const params = new URLSearchParams({
    client_id: CONFIG.SPOTIFY_CLIENT_ID,
    response_type: 'code',
    redirect_uri: CONFIG.REDIRECT_URI,
    scope: CONFIG.SCOPES,
    code_challenge_method: 'S256',
    code_challenge: challenge,
  });

  window.location.href = 'https://accounts.spotify.com/authorize?' + params.toString();
}

async function exchangeCode(code) {
  const verifier = sessionStorage.getItem('pkce_verifier');
  if (!verifier) throw new Error('Missing PKCE verifier');

  const resp = await fetch('https://accounts.spotify.com/api/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: CONFIG.SPOTIFY_CLIENT_ID,
      grant_type: 'authorization_code',
      code,
      redirect_uri: CONFIG.REDIRECT_URI,
      code_verifier: verifier,
    }),
  });

  if (!resp.ok) throw new Error('Token exchange failed: ' + resp.status);
  const data = await resp.json();
  setTokens(data);
  sessionStorage.removeItem('pkce_verifier');
}

async function refreshAccessToken() {
  if (!refreshToken) {
    logout();
    return;
  }

  const resp = await fetch('https://accounts.spotify.com/api/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: CONFIG.SPOTIFY_CLIENT_ID,
      grant_type: 'refresh_token',
      refresh_token: refreshToken,
    }),
  });

  if (!resp.ok) {
    console.error('Token refresh failed', resp.status);
    logout();
    return;
  }

  const data = await resp.json();
  setTokens(data);
}

function setTokens(data) {
  accessToken = data.access_token;
  if (data.refresh_token) refreshToken = data.refresh_token;
  tokenExpiresAt = Date.now() + data.expires_in * 1000 - 60_000; // refresh 1 min early

  sessionStorage.setItem('sp_access_token', accessToken);
  sessionStorage.setItem('sp_refresh_token', refreshToken || '');
  sessionStorage.setItem('sp_token_expires', String(tokenExpiresAt));
}

function loadTokensFromStorage() {
  accessToken = sessionStorage.getItem('sp_access_token');
  refreshToken = sessionStorage.getItem('sp_refresh_token') || null;
  tokenExpiresAt = parseInt(sessionStorage.getItem('sp_token_expires') || '0', 10);
  return !!accessToken;
}

function logout() {
  accessToken = null;
  refreshToken = null;
  tokenExpiresAt = 0;
  currentTrackId = null;
  sessionStorage.removeItem('sp_access_token');
  sessionStorage.removeItem('sp_refresh_token');
  sessionStorage.removeItem('sp_token_expires');
  stopPolling();
  showLoginScreen();
}

async function ensureValidToken() {
  if (Date.now() >= tokenExpiresAt) {
    await refreshAccessToken();
  }
}

// ============================================================
//  Spotify API — Currently Playing
// ============================================================

async function fetchCurrentlyPlaying() {
  await ensureValidToken();
  if (!accessToken) return null;

  const resp = await fetch('https://api.spotify.com/v1/me/player/currently-playing', {
    headers: { Authorization: 'Bearer ' + accessToken },
  });

  if (resp.status === 204 || resp.status === 202) return null;
  if (resp.status === 401) {
    await refreshAccessToken();
    return null;
  }
  if (!resp.ok) return null;

  return resp.json();
}

// ============================================================
//  Spotify API — Seek
// ============================================================

async function seekToPosition(positionMs) {
  const ms = Math.round(Math.max(0, Math.min(positionMs, durationMs)));

  // Update local state synchronously so the animation loop uses the new
  // position immediately, before any async work yields to the event loop.
  lastProgressMs = ms;
  smoothPositionMs = ms;
  lastPollTimestamp = Date.now();
  lastSeekTimestamp = Date.now();

  await ensureValidToken();
  if (!accessToken) return;

  try {
    const resp = await fetch(
      `https://api.spotify.com/v1/me/player/seek?position_ms=${ms}`,
      { method: 'PUT', headers: { Authorization: 'Bearer ' + accessToken } },
    );
    if (resp.status === 401) {
      await refreshAccessToken();
    }
  } catch (err) {
    console.error('Seek error:', err);
  }
}

// ============================================================
//  Lyrics Fetching — delegates to lyrics.js module
// ============================================================

async function fetchAndSetLyrics(trackId, trackName, artistName, trackDurationMs) {
  lyrics = null;
  syncType = null;
  lyricsLanguage = null;
  lyricsTranslations = null;
  translationRequestId++;   // abandon any translation still in flight
  lyricsOffsetMs = 0;
  updateOffsetLabel();
  hideLyricsOffset();
  clearLyricsDisplay();
  hideLyricsSource();
  showStatus('Loading lyrics...');

  const result = await fetchLyrics(CONFIG.WORKER_URL, trackId, trackName, artistName, trackDurationMs, accessToken);

  if (!result.lyrics) {
    showStatus('No lyrics available for this track');
    hideTranslateControl();
    return;
  }

  syncType = result.syncType;
  lyrics = result.lyrics;
  lyricsLanguage = result.language || null;

  if (syncType === 'WORD_SYNCED' || syncType === 'LINE_SYNCED') {
    renderSyncedLyrics();
    showLyricsOffset();
  } else {
    renderPlainLyrics(lyrics);
  }
  showLyricsSource(result.source);

  if (detectChineseLyrics()) {
    showCjkFontPicker();
    if (currentCjkFont) applyCjkFont(currentCjkFont);
  } else {
    hideCjkFontPicker();
    lyricsLines.style.fontFamily = '';
  }

  refreshTranslateControl();
}

// ============================================================
//  Lyrics Rendering
// ============================================================

function clearLyricsDisplay() {
  lyricsLines.innerHTML = '';
  lyricsLines.style.fontFamily = '';
  lyricsLines.style.fontWeight = '';
  hideStatus();
  hideCjkFontPicker();
}

function hideTranslateControl() {
  translateControl.classList.add('hidden');
  closeTranslateMenu();
}

function renderSyncedLyrics() {
  clearLyricsDisplay();
  hideStatus();

  lyrics.forEach((line, i) => {
    const el = document.createElement('div');
    el.className = 'lyrics-line';
    el.dataset.index = i;

    // The words live in their own element so a translation can be appended
    // as a sibling without disturbing them.
    const textEl = document.createElement('span');
    textEl.className = 'line-text';

    if (syncType === 'WORD_SYNCED' && line.syllables && line.syllables.length > 0) {
      // Word-synced: render each word/syllable as a span
      line.syllables.forEach((syl) => {
        const span = document.createElement('span');
        span.className = 'word';
        span.textContent = syl.word + ' ';
        span.dataset.startMs = syl.startTimeMs;
        span.dataset.endMs = syl.endTimeMs || syl.startTimeMs;
        textEl.appendChild(span);
      });
    } else {
      textEl.textContent = line.words || '';
    }

    el.appendChild(textEl);
    lyricsLines.appendChild(el);
  });

  applyTranslations();
}

function renderPlainLyrics(text) {
  clearLyricsDisplay();
  hideStatus();
  const container = document.createElement('div');
  container.className = 'lyrics-plain';

  plainLyricsLines(text).forEach((line, i) => {
    const el = document.createElement('div');
    el.className = 'lyrics-plain-line';
    el.dataset.index = i;

    const textEl = document.createElement('span');
    textEl.className = 'line-text';
    textEl.textContent = line;
    el.appendChild(textEl);

    container.appendChild(el);
  });

  lyricsLines.appendChild(container);
  applyTranslations();
}

/** Plain lyrics arrive as one blob; translation needs them line by line. */
function plainLyricsLines(text) {
  return String(text || '').split('\n');
}

// ============================================================
//  Karaoke Animation Loop
// ============================================================

const LERP_FACTOR = 0.12;
const SNAP_THRESHOLD_MS = 1500;

function startAnimationLoop() {
  if (rafId) return;

  function tick() {
    rafId = requestAnimationFrame(tick);

    const now = Date.now();
    const rawEstimate = isPlaying
      ? lastProgressMs + (now - lastPollTimestamp)
      : lastProgressMs;

    const drift = Math.abs(rawEstimate - smoothPositionMs);
    if (drift > SNAP_THRESHOLD_MS || !isPlaying) {
      smoothPositionMs = rawEstimate;
    } else {
      smoothPositionMs += (rawEstimate - smoothPositionMs) * LERP_FACTOR;
    }

    updateProgressUI(smoothPositionMs, durationMs);

    if (!lyrics || syncType === 'PLAIN') return;
    highlightLyrics(smoothPositionMs + lyricsOffsetMs);
  }

  rafId = requestAnimationFrame(tick);
}

function stopAnimationLoop() {
  if (rafId) {
    cancelAnimationFrame(rafId);
    rafId = null;
  }
}

let lastHighlightedIndex = -1;

function highlightLyrics(positionMs) {
  if (!lyrics || !Array.isArray(lyrics) || lyrics.length === 0) return;

  // Find the current line
  let activeIndex = -1;
  for (let i = lyrics.length - 1; i >= 0; i--) {
    const t = parseInt(lyrics[i].startTimeMs, 10);
    if (positionMs >= t) {
      activeIndex = i;
      break;
    }
  }

  const lineEls = lyricsLines.querySelectorAll('.lyrics-line');

  // Only update DOM + scroll when the active line changes
  if (activeIndex !== lastHighlightedIndex) {
    lastHighlightedIndex = activeIndex;
    lineEls.forEach((el, i) => {
      el.classList.toggle('active', i === activeIndex);
      el.classList.toggle('past', i < activeIndex);
    });

    // Auto-scroll to keep active line in view
    if (activeIndex >= 0 && lineEls[activeIndex]) {
      lineEls[activeIndex].scrollIntoView({ behavior: 'smooth', block: 'center' });
    }
  }

  // Word-level highlighting (runs every frame for smooth word transitions)
  if (syncType === 'WORD_SYNCED' && activeIndex >= 0) {
    const activeLine = lineEls[activeIndex];
    if (activeLine) {
      const words = activeLine.querySelectorAll('.word');
      words.forEach((w) => {
        const start = parseInt(w.dataset.startMs, 10);
        w.classList.toggle('sung', positionMs >= start);
      });
    }
  }
}

// ============================================================
//  Polling Loop
// ============================================================

function startPolling() {
  if (pollTimer) return;
  pollOnce();
  pollTimer = setInterval(pollOnce, CONFIG.POLL_INTERVAL_MS);
  startAnimationLoop();
}

function stopPolling() {
  if (pollTimer) {
    clearInterval(pollTimer);
    pollTimer = null;
  }
  stopAnimationLoop();
}

async function pollOnce() {
  try {
    const data = await fetchCurrentlyPlaying();

    if (!data || !data.item) {
      if (currentTrackId !== null || !statusMessage.classList.contains('hidden')) {
        currentTrackId = null;
        clearLyricsDisplay();
        updateNowPlayingUI(null);
      }
      isPlaying = false;
      showStatus('Nothing is playing on Spotify');
      return;
    }

    const track = data.item;
    const trackId = track.id;
    isPlaying = data.is_playing;
    durationMs = track.duration_ms || 0;

    const SEEK_GRACE_MS = 2500;
    const inSeekGrace = (Date.now() - lastSeekTimestamp) < SEEK_GRACE_MS;
    if (!inSeekGrace) {
      lastProgressMs = data.progress_ms || 0;
      lastPollTimestamp = Date.now();
    }

    updateNowPlayingUI(track);
    updateProgressUI(lastProgressMs, durationMs);

    // Track changed — fetch new lyrics
    if (trackId !== currentTrackId) {
      currentTrackId = trackId;
      lastHighlightedIndex = -1;
      const name = track.name;
      const artist = track.artists.map((a) => a.name).join(', ');
      await fetchAndSetLyrics(trackId, name, artist, durationMs);
    }
  } catch (err) {
    console.error('Poll error:', err);
  }
}

// ============================================================
//  UI Helpers
// ============================================================

function formatTime(ms) {
  const totalSec = Math.floor(ms / 1000);
  const min = Math.floor(totalSec / 60);
  const sec = totalSec % 60;
  return `${min}:${sec.toString().padStart(2, '0')}`;
}

function updateNowPlayingUI(track) {
  if (!track) {
    trackNameEl.textContent = 'Not Playing';
    artistNameEl.textContent = '';
    albumArt.src = '';
    return;
  }

  trackNameEl.textContent = track.name;
  artistNameEl.textContent = track.artists.map((a) => a.name).join(', ');

  const img = track.album?.images?.[0]?.url || '';
  if (albumArt.src !== img) albumArt.src = img;
}

function updateProgressUI(currentMs, totalMs) {
  if (totalMs <= 0) return;
  if (isDraggingProgress) return;
  const pct = Math.min(100, (currentMs / totalMs) * 100);
  progressFill.style.width = pct + '%';
  progressCurrent.textContent = formatTime(currentMs);
  progressTotal.textContent = formatTime(totalMs);
}

function showStatus(msg) {
  statusText.textContent = msg;
  statusMessage.classList.remove('hidden');
}

function hideStatus() {
  statusMessage.classList.add('hidden');
}

function showLyricsSource(label) {
  lyricsSourceEl.textContent = label;
  lyricsSourceEl.classList.remove('hidden');
}

function hideLyricsSource() {
  lyricsSourceEl.classList.add('hidden');
  lyricsSourceEl.textContent = '';
}

function showLoginScreen() {
  loginScreen.classList.add('active');
  mainScreen.classList.remove('active');
}

function showMainScreen() {
  loginScreen.classList.remove('active');
  mainScreen.classList.add('active');
  showStatus('Waiting for playback...');
}

// ============================================================
//  Init
// ============================================================

async function init() {
  // Handle OAuth callback
  const urlParams = new URLSearchParams(window.location.search);
  const code = urlParams.get('code');

  if (code) {
    // Clean URL
    window.history.replaceState({}, document.title, window.location.pathname);
    try {
      await exchangeCode(code);
      showMainScreen();
      startPolling();
      return;
    } catch (err) {
      console.error('Auth error:', err);
      showLoginScreen();
      return;
    }
  }

  // Try restoring session
  if (loadTokensFromStorage() && Date.now() < tokenExpiresAt + 60_000) {
    showMainScreen();
    startPolling();
    return;
  }

  showLoginScreen();
}

// ============================================================
//  Lyrics Offset
// ============================================================

function adjustOffset(deltaMs) {
  if (deltaMs === 0) {
    lyricsOffsetMs = 0;
  } else {
    lyricsOffsetMs += deltaMs;
  }
  lastHighlightedIndex = -1;
  updateOffsetLabel();
}

function updateOffsetLabel() {
  const sec = (lyricsOffsetMs / 1000).toFixed(1);
  const label = lyricsOffsetMs > 0 ? `+${sec}s` : `${sec}s`;
  offsetResetBtn.textContent = label;
  offsetResetBtn.classList.toggle('nonzero', lyricsOffsetMs !== 0);
}

function showLyricsOffset() {
  lyricsOffsetEl.classList.remove('hidden');
}

function hideLyricsOffset() {
  lyricsOffsetEl.classList.add('hidden');
}

// ============================================================
//  CJK Font Picker
// ============================================================

const CJK_FONTS = {
  'Noto Serif SC': 'Noto+Serif+SC:wght@400;600;700',
  'Long Cang': 'Long+Cang',
  'Ma Shan Zheng': 'Ma+Shan+Zheng',
  'Zhi Mang Xing': 'Zhi+Mang+Xing',
  'ZCOOL XiaoWei': 'ZCOOL+XiaoWei',
  'ZCOOL KuaiLe': 'ZCOOL+KuaiLe',
};

const loadedFonts = new Set();

function loadGoogleFont(fontName) {
  if (!fontName || loadedFonts.has(fontName)) return;
  const spec = CJK_FONTS[fontName];
  if (!spec) return;
  const link = document.createElement('link');
  link.rel = 'stylesheet';
  link.href = `https://fonts.googleapis.com/css2?family=${spec}&display=swap`;
  document.head.appendChild(link);
  loadedFonts.add(fontName);
}

const CJK_RE = /[\u4e00-\u9fff]/;
const JAPANESE_RE = /[\u3040-\u309f\u30a0-\u30ff]/;
let currentCjkFont = localStorage.getItem('cjk-font') || '';

function detectChineseLyrics() {
  if (lyricsLanguage) {
    return lyricsLanguage.toLowerCase().startsWith('zh');
  }
  let sample = '';
  if (typeof lyrics === 'string') {
    sample = lyrics;
  } else if (Array.isArray(lyrics)) {
    sample = lyrics.slice(0, 5).map((l) => l.words || '').join('');
  }
  if (!CJK_RE.test(sample)) return false;
  if (JAPANESE_RE.test(sample)) return false;
  return true;
}

const CJK_BOLD_FONTS = new Set(['', 'Noto Serif SC', 'Long Cang']);

function applyCjkFont(fontName) {
  currentCjkFont = fontName;
  localStorage.setItem('cjk-font', fontName);
  if (fontName) {
    loadGoogleFont(fontName);
    lyricsLines.style.fontFamily = `"${fontName}", sans-serif`;
  } else {
    lyricsLines.style.fontFamily = '';
  }
  lyricsLines.style.fontWeight = CJK_BOLD_FONTS.has(fontName) ? '' : '300';
}

const cjkPickerToggle = cjkFontPicker.querySelector('.cjk-picker-toggle');
const cjkPickerMenu = cjkFontPicker.querySelector('.cjk-picker-menu');
const cjkPickerOptions = cjkFontPicker.querySelectorAll('.cjk-picker-option');

function setCjkPickerValue(value) {
  cjkPickerOptions.forEach((opt) => {
    const match = opt.dataset.value === value;
    opt.classList.toggle('selected', match);
    if (match) cjkPickerToggle.textContent = opt.textContent;
  });
}

function showCjkFontPicker() {
  setCjkPickerValue(currentCjkFont);
  cjkFontPicker.classList.remove('hidden');
}

function hideCjkFontPicker() {
  cjkFontPicker.classList.add('hidden');
  cjkFontPicker.classList.remove('open');
}

function initCjkFont() {
  if (currentCjkFont) {
    loadGoogleFont(currentCjkFont);
  }

  cjkPickerToggle.addEventListener('click', (e) => {
    e.stopPropagation();
    cjkFontPicker.classList.toggle('open');
  });

  cjkPickerMenu.addEventListener('click', (e) => {
    const opt = e.target.closest('.cjk-picker-option');
    if (!opt) return;
    e.stopPropagation();
    const value = opt.dataset.value;
    setCjkPickerValue(value);
    applyCjkFont(value);
    cjkFontPicker.classList.remove('open');
  });

  document.addEventListener('click', () => {
    cjkFontPicker.classList.remove('open');
  });
}

initCjkFont();

// ============================================================
//  Lyrics Translation
// ============================================================

const TRANSLATE_ON_KEY = 'translate-on';
const TRANSLATE_TARGET_KEY = 'translate-target';
const TRANSLATE_PROVIDER_KEY = 'translate-provider';

let translateEnabled = localStorage.getItem(TRANSLATE_ON_KEY) === '1';
let translateTarget = localStorage.getItem(TRANSLATE_TARGET_KEY) === 'zh' ? 'zh' : 'en';

/**
 * Normally empty, which lets translate.js run its own provider chain. Setting
 * it pins one provider, which is how a single model can be compared against
 * another on the same track without a menu full of them:
 *
 *   localStorage.setItem('translate-provider', 'gemini-3.5-flash-lite')
 *   localStorage.removeItem('translate-provider')   // back to automatic
 */
function providerOverride() {
  const stored = localStorage.getItem(TRANSLATE_PROVIDER_KEY);
  if (!stored) return '';
  const known = normalizeProvider(stored);
  if (known !== stored) {
    console.debug('[translate] ignoring unknown provider override:', stored);
    return '';
  }
  return known;
}

let lyricsTranslations = null;   // aligned with the rendered lines, or null
let translationRequestId = 0;    // guards against a slow reply for an old track

// Translations are fetched once per track, target and provider, and reused
// when toggling back on or returning to a track.
const TRANSLATION_CACHE_MAX = 30;
const translationCache = new Map();

function translationCacheKey() {
  return `${currentTrackId}:${translateTarget}:${providerOverride() || 'auto'}`;
}

function translationCacheGet(key) {
  if (!translationCache.has(key)) return undefined;
  const value = translationCache.get(key);
  translationCache.delete(key);
  translationCache.set(key, value);
  return value;
}

function translationCacheSet(key, value) {
  if (translationCache.has(key)) translationCache.delete(key);
  translationCache.set(key, value);
  if (translationCache.size > TRANSLATION_CACHE_MAX) {
    translationCache.delete(translationCache.keys().next().value);
  }
}

/** The text of each rendered line, in order — the unit translation works on. */
function currentLineTexts() {
  if (!lyrics) return [];
  if (Array.isArray(lyrics)) return lyrics.map((line) => line.words || '');
  return plainLyricsLines(lyrics);
}

/** Line elements in render order, synced or plain. */
function lineElements() {
  return lyricsLines.querySelectorAll('.lyrics-line, .lyrics-plain-line');
}

function applyTranslations() {
  const elements = lineElements();
  elements.forEach((el, i) => {
    const existing = el.querySelector('.line-translation');
    const text = lyricsTranslations ? lyricsTranslations[i] : '';

    if (!text) {
      if (existing) existing.remove();
      return;
    }
    const target = existing || document.createElement('span');
    target.className = 'line-translation';
    target.textContent = text;
    if (!existing) el.appendChild(target);
  });
}

function clearTranslations() {
  lyricsTranslations = null;
  applyTranslations();
}

/**
 * Fetch and show translations for the current track. Called only from the
 * toggle and from a settings change while the toggle is on — nothing is sent
 * to a translation service until the button is switched on.
 */
async function loadTranslations() {
  const texts = currentLineTexts();
  if (texts.length === 0) return;

  const key = translationCacheKey();
  const cached = translationCacheGet(key);
  if (cached) {
    lyricsTranslations = cached;
    applyTranslations();
    return;
  }

  const requestId = ++translationRequestId;
  translateToggle.classList.add('loading');

  const result = await translateLines(texts, {
    target: translateTarget,
    provider: providerOverride(),
    workerUrl: CONFIG.WORKER_URL,
  });

  // A track change (or another toggle) happened while this was in flight.
  if (requestId !== translationRequestId) return;
  translateToggle.classList.remove('loading');

  if (!result) {
    console.debug('[translate] no translation returned; showing originals only');
    return;
  }

  translationCacheSet(key, result);
  lyricsTranslations = result;
  applyTranslations();
}

function setTranslateEnabled(enabled) {
  translateEnabled = enabled;
  localStorage.setItem(TRANSLATE_ON_KEY, enabled ? '1' : '0');
  translateToggle.classList.toggle('active', enabled);
  translateToggle.title = enabled ? 'Hide translation' : 'Show translation';

  if (enabled) {
    loadTranslations();
  } else {
    translationRequestId++;   // abandon anything in flight
    translateToggle.classList.remove('loading');
    closeTranslateMenu();
    clearTranslations();
  }
}

function setTranslateOption(setting, value) {
  if (setting !== 'target') return;
  translateTarget = value;
  localStorage.setItem(TRANSLATE_TARGET_KEY, value);
  markTranslateOptions();

  if (translateEnabled) {
    clearTranslations();
    loadTranslations();
  }
}

function closeTranslateMenu() {
  translateControl.classList.remove('open');
  translateMenuToggle.setAttribute('aria-expanded', 'false');
}

function markTranslateOptions() {
  translateControl.querySelectorAll('.translate-option').forEach((opt) => {
    opt.classList.toggle('selected', opt.dataset.value === translateTarget);
  });
}

/**
 * Show the control only for lyrics that are neither English nor Chinese.
 * The language is worked out locally so nothing is sent anywhere before the
 * button is switched on.
 */
function refreshTranslateControl() {
  const texts = currentLineTexts();
  const sample = texts.slice(0, 40).join('\n');
  const language = detectLyricsLanguage(sample, lyricsLanguage);

  if (!lyrics || !shouldOfferTranslation(language)) {
    hideTranslateControl();
    clearTranslations();
    return;
  }

  console.debug('[translate] lyrics language:', language);
  translateControl.classList.remove('hidden');
  translateToggle.classList.toggle('active', translateEnabled);
  markTranslateOptions();

  if (translateEnabled) loadTranslations();
}

function initTranslateControl() {
  markTranslateOptions();
  translateToggle.classList.toggle('active', translateEnabled);

  translateToggle.addEventListener('click', () => setTranslateEnabled(!translateEnabled));

  translateMenuToggle.addEventListener('click', (e) => {
    e.stopPropagation();
    const open = translateControl.classList.toggle('open');
    translateMenuToggle.setAttribute('aria-expanded', String(open));
  });

  translateControl.querySelector('.translate-menu').addEventListener('click', (e) => {
    const option = e.target.closest('.translate-option');
    if (!option) return;
    e.stopPropagation();
    setTranslateOption(option.dataset.setting, option.dataset.value);
    closeTranslateMenu();
  });

  document.addEventListener('click', closeTranslateMenu);
}

initTranslateControl();

// ============================================================
//  Theme — follows the local sunrise / sunset
// ============================================================

const THEME_KEY = 'theme';
const THEME_SET_AT_KEY = 'theme-set-at';

// setTimeout can't be trusted with very long delays (and the machine may sleep through
// one), so never wait more than this before re-checking where the sun is.
const MAX_THEME_TIMER_MS = 6 * 60 * 60 * 1000;

// Fixed to San Mateo, CA rather than read from the device, so the page never asks for
// location permission. Sunrise and sunset move by only a few minutes across the Bay
// Area, so a fixed point is as good as a real fix for choosing the theme.
const sunLocation = DEFAULT_LOCATION;
let themeTimer = null;

function applyTheme(theme) {
  document.documentElement.setAttribute('data-theme', theme);
}

function sunTheme(now) {
  return isDaylight(now, sunLocation.lat, sunLocation.lon) ? 'light' : 'dark';
}

/**
 * A manual toggle wins over the sun, but only until the next sunrise or sunset — after
 * that the sun takes over again. An override with no timestamp was stored by a version
 * of the app that predates this, so it counts as expired.
 */
function activeOverride(now) {
  const theme = localStorage.getItem(THEME_KEY);
  if (theme !== 'light' && theme !== 'dark') return null;

  const setAt = Number(localStorage.getItem(THEME_SET_AT_KEY));
  const lastTransition = lastSolarTransition(now, sunLocation.lat, sunLocation.lon);
  if (!setAt || (lastTransition && setAt < lastTransition.valueOf())) {
    localStorage.removeItem(THEME_KEY);
    localStorage.removeItem(THEME_SET_AT_KEY);
    return null;
  }
  return theme;
}

function refreshTheme() {
  const now = new Date();
  applyTheme(activeOverride(now) || sunTheme(now));

  clearTimeout(themeTimer);
  const next = nextSolarTransition(now, sunLocation.lat, sunLocation.lon);
  const untilNext = next ? next.valueOf() - now.valueOf() + 1000 : MAX_THEME_TIMER_MS;
  themeTimer = setTimeout(refreshTheme, Math.min(untilNext, MAX_THEME_TIMER_MS));
}

function toggleTheme() {
  const current = document.documentElement.getAttribute('data-theme');
  const next = current === 'light' ? 'dark' : 'light';
  localStorage.setItem(THEME_KEY, next);
  localStorage.setItem(THEME_SET_AT_KEY, String(Date.now()));
  applyTheme(next);
}

function initTheme() {
  refreshTheme();

  // A tab that was hidden across sunset may have slept through its timer.
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) refreshTheme();
  });
}

initTheme();

// ============================================================
//  Touch Control Toggle
// ============================================================

let touchControlEnabled = localStorage.getItem('touch-control') === 'true';

function applyTouchControl(enabled) {
  touchControlEnabled = enabled;
  localStorage.setItem('touch-control', String(enabled));
  if (enabled) {
    document.documentElement.setAttribute('data-touch-control', '');
  } else {
    document.documentElement.removeAttribute('data-touch-control');
  }
}

function toggleTouchControl() {
  applyTouchControl(!touchControlEnabled);
}

applyTouchControl(touchControlEnabled);

// ============================================================
//  Progress Bar Drag (requires touch control)
// ============================================================

let isDraggingProgress = false;

function progressPctFromPointer(e) {
  const rect = progressBarTrack.getBoundingClientRect();
  return Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
}

function onProgressPointerDown(e) {
  if (!touchControlEnabled || durationMs <= 0) return;
  e.preventDefault();
  isDraggingProgress = true;
  progressBarTrack.classList.add('dragging');
  progressBarTrack.setPointerCapture(e.pointerId);

  const pct = progressPctFromPointer(e);
  progressFill.style.width = (pct * 100) + '%';
  progressCurrent.textContent = formatTime(pct * durationMs);
}

function onProgressPointerMove(e) {
  if (!isDraggingProgress) return;
  const pct = progressPctFromPointer(e);
  progressFill.style.width = (pct * 100) + '%';
  progressCurrent.textContent = formatTime(pct * durationMs);
}

function onProgressPointerUp(e) {
  if (!isDraggingProgress) return;
  isDraggingProgress = false;
  progressBarTrack.classList.remove('dragging');

  const pct = progressPctFromPointer(e);
  const seekMs = pct * durationMs;
  seekToPosition(seekMs);
}

progressBarTrack.addEventListener('pointerdown', onProgressPointerDown);
progressBarTrack.addEventListener('pointermove', onProgressPointerMove);
progressBarTrack.addEventListener('pointerup', onProgressPointerUp);
progressBarTrack.addEventListener('pointercancel', () => {
  isDraggingProgress = false;
  progressBarTrack.classList.remove('dragging');
});

// ============================================================
//  Lyrics Line Click-to-Seek (requires touch control)
// ============================================================

lyricsLines.addEventListener('click', (e) => {
  if (!touchControlEnabled) return;
  if (syncType !== 'LINE_SYNCED' && syncType !== 'WORD_SYNCED') return;
  if (!lyrics || !Array.isArray(lyrics)) return;

  const lineEl = e.target.closest('.lyrics-line');
  if (!lineEl || lineEl.classList.contains('active')) return;

  const idx = parseInt(lineEl.dataset.index, 10);
  if (isNaN(idx) || idx < 0 || idx >= lyrics.length) return;

  const startTimeMs = parseInt(lyrics[idx].startTimeMs, 10);
  const seekMs = Math.max(0, Math.min(startTimeMs - lyricsOffsetMs, durationMs));
  seekToPosition(seekMs);
});

// ============================================================
//  Event Listeners
// ============================================================

connectBtn.addEventListener('click', startAuth);
disconnectBtn.addEventListener('click', logout);
themeToggle.addEventListener('click', toggleTheme);
touchControlToggle.addEventListener('click', toggleTouchControl);
lyricsOffsetEl.addEventListener('click', (e) => {
  const btn = e.target.closest('.offset-btn');
  if (!btn) return;
  adjustOffset(parseInt(btn.dataset.delta, 10));
});
document.addEventListener('DOMContentLoaded', init);
