import { fetchLyrics } from './lyrics.js';

// ============================================================
//  Configuration — fill these in before deploying
// ============================================================

const CONFIG = {
  SPOTIFY_CLIENT_ID: '1253e21fe567410c99a9eddeb94b4d35', // Your Spotify app's client ID
  REDIRECT_URI: window.location.origin + window.location.pathname,
  SCOPES: 'user-read-currently-playing user-read-playback-state',
  // URL of your Cloudflare Worker lyrics proxy (leave empty to skip)
  WORKER_URL: 'https://spotify-lyrics-worker.spotify-karaoke.workers.dev',
  POLL_INTERVAL_MS: 3000,
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
let rafId = null;
let pollTimer = null;

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
//  Lyrics Fetching — delegates to lyrics.js module
// ============================================================

async function fetchAndSetLyrics(trackId, trackName, artistName, trackDurationMs) {
  lyrics = null;
  syncType = null;
  clearLyricsDisplay();
  hideLyricsSource();
  showStatus('Loading lyrics...');

  const result = await fetchLyrics(CONFIG.WORKER_URL, trackId, trackName, artistName, trackDurationMs, accessToken);

  if (!result.lyrics) {
    showStatus('No lyrics available for this track');
    return;
  }

  syncType = result.syncType;
  lyrics = result.lyrics;

  if (syncType === 'WORD_SYNCED' || syncType === 'LINE_SYNCED') {
    renderSyncedLyrics();
  } else {
    renderPlainLyrics(lyrics);
  }
  showLyricsSource(result.source);
}

// ============================================================
//  Lyrics Rendering
// ============================================================

function clearLyricsDisplay() {
  lyricsLines.innerHTML = '';
  hideStatus();
}

function renderSyncedLyrics() {
  clearLyricsDisplay();
  hideStatus();

  lyrics.forEach((line, i) => {
    const el = document.createElement('div');
    el.className = 'lyrics-line';
    el.dataset.index = i;

    if (syncType === 'WORD_SYNCED' && line.syllables && line.syllables.length > 0) {
      // Word-synced: render each word/syllable as a span
      line.syllables.forEach((syl) => {
        const span = document.createElement('span');
        span.className = 'word';
        span.textContent = syl.word + ' ';
        span.dataset.startMs = syl.startTimeMs;
        span.dataset.endMs = syl.endTimeMs || syl.startTimeMs;
        el.appendChild(span);
      });
    } else {
      el.textContent = line.words || '';
    }

    lyricsLines.appendChild(el);
  });
}

function renderPlainLyrics(text) {
  clearLyricsDisplay();
  hideStatus();
  const el = document.createElement('div');
  el.className = 'lyrics-plain';
  el.textContent = text;
  lyricsLines.appendChild(el);
}

// ============================================================
//  Karaoke Animation Loop
// ============================================================

function startAnimationLoop() {
  if (rafId) return;

  function tick() {
    rafId = requestAnimationFrame(tick);

    const now = Date.now();
    const estimated = isPlaying
      ? lastProgressMs + (now - lastPollTimestamp)
      : lastProgressMs;
    updateProgressUI(estimated, durationMs);

    if (!lyrics || syncType === 'PLAIN') return;
    highlightLyrics(estimated);
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
    lastProgressMs = data.progress_ms || 0;
    lastPollTimestamp = Date.now();
    durationMs = track.duration_ms || 0;

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

connectBtn.addEventListener('click', startAuth);
disconnectBtn.addEventListener('click', logout);
document.addEventListener('DOMContentLoaded', init);
