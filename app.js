import { fetchLyrics, fetchLyricsFrom, LYRICS_SOURCES } from './lyrics.js';
import {
  PositionEstimator,
  createSpotifySource,
  createTeslaFleetSource,
  selectSourceId,
} from './sources.js';
import { DEFAULT_LOCATION, isDaylight, lastSolarTransition, nextSolarTransition } from './sun.js';
import { detectLyricsLanguage, languageTag, normalizeProvider, shouldOfferTranslation, translateLines } from './translate.js';
import { dictionaryReadings, fetchFurigana, furiganaSegments, hasKanji, layoutWordFurigana } from './furigana.js';
import { fetchRomanization, hasRomanWords, romanGroupFor, romanLanguage } from './romanize.js';
import {
  findFont,
  fontFamilyValue,
  fontGroupFor,
  fontStorageKey,
  googleFontsUrl,
  previewFontUrl,
  scriptChars,
  LYRICS_FONT_GROUPS,
} from './fonts.js';
import {
  furiganaLabel,
  romanizationLabel,
  lyricsLabel,
  lyricsSlot,
  SOURCE_FAILED,
  SOURCE_LOADING,
  sourcePanelSlots,
  translationLabel,
} from './source-labels.js';

// ============================================================
//  Configuration — fill these in before deploying
// ============================================================

const CONFIG = {
  SPOTIFY_CLIENT_ID: '1253e21fe567410c99a9eddeb94b4d35', // Your Spotify app's client ID
  REDIRECT_URI: window.location.origin + window.location.pathname,
  SCOPES: 'user-read-currently-playing user-read-playback-state user-modify-playback-state',
  // URL of your Cloudflare Worker lyrics proxy (leave empty to skip)
  WORKER_URL: 'https://spotify-lyrics-worker.spotify-karaoke.workers.dev',
  // Fallback only — each source declares its own cadence (see sources.js).
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
const sourcePickerToggle = $('#source-picker-toggle');
const sourcePickerMenu = $('#source-picker-menu');
const sourceRestEl = $('#source-rest');
const themeToggle = $('#theme-toggle');
const touchControlToggle = $('#touch-control-toggle');
const progressBarTrack = $('.progress-bar-track');
const lyricsOffsetEl = $('#lyrics-offset');
const offsetResetBtn = lyricsOffsetEl.querySelector('.offset-reset');
const fontPicker = $('#font-picker');
const translateControl = $('#translate-control');
const translateToggle = $('#translate-toggle');
const translateMenuToggle = $('#translate-menu-toggle');
const furiganaToggle = $('#furigana-toggle');
const romanizeToggle = $('#romanize-toggle');

// ============================================================
//  State
// ============================================================

let accessToken = null;
let refreshToken = null;
let tokenExpiresAt = 0;

let source = null;          // the active now-playing source (see sources.js)
let estimator = null;       // normalises each source's cadence into one anchor

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
//  Now-Playing Source
// ============================================================

/**
 * Builds the active source.  Auth stays here — the sources take accessors so
 * the PKCE flow keeps one owner.
 */
function buildSource(sourceId) {
  if (sourceId === 'tesla') {
    return createTeslaFleetSource({
      // Fleet API auth is a server-side flow, so the Worker owns it.  Until
      // that route exists this resolves to null and the source reports
      // silence rather than throwing on every poll.
      fetchVehicleData: async () => {
        if (!CONFIG.WORKER_URL) return null;
        try {
          const resp = await fetch(`${CONFIG.WORKER_URL}/tesla-media`);
          if (!resp.ok) return null;
          return await resp.json();
        } catch (err) {
          console.debug('[source] tesla: ', err.message);
          return null;
        }
      },
    });
  }

  return createSpotifySource({
    getAccessToken: async () => {
      await ensureValidToken();
      return accessToken;
    },
    onUnauthorized: refreshAccessToken,
  });
}

function applySourceCapabilities(src) {
  const { seek, artwork } = src.capabilities;

  // A source that cannot be seeked must not offer controls that seek it.
  // Suppress them for this session only — writing the preference away would
  // lose the listener's Spotify setting the moment they tried another source.
  touchControlToggle.classList.toggle('hidden', !seek);
  if (!seek) {
    touchControlEnabled = false;
    document.documentElement.removeAttribute('data-touch-control');
  }

  albumArt.classList.toggle('hidden', !artwork);
}

async function seekToPosition(positionMs) {
  if (!source?.capabilities.seek) return;

  const ms = Math.round(Math.max(0, Math.min(positionMs, durationMs)));

  // Update local state synchronously so the animation loop uses the new
  // position immediately, before any async work yields to the event loop.
  lastProgressMs = ms;
  smoothPositionMs = ms;
  lastPollTimestamp = Date.now();
  lastSeekTimestamp = Date.now();
  estimator?.seek(ms);

  try {
    await source.seek(ms);
  } catch (err) {
    console.error('Seek error:', err);
  }
}

// ============================================================
//  Lyrics Fetching — delegates to lyrics.js module
// ============================================================

// The lyrics source picked in the source panel, for the current track only:
// 'auto' lets fetchLyrics choose, anything else is an id from LYRICS_SOURCES.
const AUTO_PICK = 'auto';
let lyricsPick = AUTO_PICK;
let currentTrack = null;          // the track's details, to ask another source for its lyrics
let currentLyricsSource = null;   // `source` of the lyrics on screen, or null
let lyricsRequestId = 0;          // guards against a slow reply for an old track or pick

async function fetchAndSetLyrics(trackId, trackName, artistName, trackDurationMs) {
  const requestId = ++lyricsRequestId;
  currentTrack = { trackId, trackName, artistName, trackDurationMs };
  const picked = LYRICS_SOURCES.find((s) => s.id === lyricsPick) || null;

  lyrics = null;
  syncType = null;
  lyricsLanguage = null;
  currentLyricsSource = null;
  lyricsTranslations = null;
  translationRequestId++;   // abandon any translation still in flight…
  translateToggle.classList.remove('loading');  // …so the button is not left waiting on it
  lyricsFurigana = null;
  furiganaRequestId++;      // abandon any furigana still in flight…
  furiganaToggle.classList.remove('loading');   // …so the button is not left waiting on it
  lyricsRomanization = null;
  romanizeRequestId++;
  romanizeToggle.classList.remove('loading');
  lyricsOffsetMs = 0;
  updateOffsetLabel();
  hideLyricsOffset();
  clearLyricsDisplay();
  resetSourcePanel(lyricsSlot({ picked: picked?.label, loading: true }));
  markSourcePicker();
  showStatus('Loading lyrics...');

  const result = picked
    ? await fetchLyricsFrom(picked.id, CONFIG.WORKER_URL, trackId, trackName, artistName, trackDurationMs)
    : await fetchLyrics(CONFIG.WORKER_URL, trackId, trackName, artistName, trackDurationMs, accessToken);

  // A newer request — another track, or another source picked — owns the screen now.
  if (requestId !== lyricsRequestId) return;

  if (!result.lyrics) {
    showStatus(picked
      ? `No lyrics available for this track on ${lyricsLabel(picked.label)}`
      : 'No lyrics available for this track');
    hideTranslateControl();
    hideFuriganaControl();
    hideRomanizeControl();
    // The panel stays, so another source can still be picked.
    showLyricsSource(lyricsSlot({ picked: picked?.label }));
    return;
  }

  syncType = result.syncType;
  lyrics = result.lyrics;
  lyricsLanguage = result.language || null;
  currentLyricsSource = result.source;

  if (syncType === 'WORD_SYNCED' || syncType === 'LINE_SYNCED') {
    renderSyncedLyrics();
    showLyricsOffset();
  } else {
    renderPlainLyrics(lyrics);
  }
  showLyricsSource(lyricsSlot({ picked: picked?.label, shown: result.source }));

  refreshFontPicker();

  refreshTranslateControl();
  refreshFuriganaControl();
  refreshRomanizeControl();
}

// ============================================================
//  Lyrics Rendering
// ============================================================

function clearLyricsDisplay() {
  lyricsLines.innerHTML = '';
  clearLyricsFont();   // put back by refreshFontPicker once lyrics are drawn
  lyricsLines.removeAttribute('lang');
  hideStatus();
  hideFontPicker();
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
    textEl.dir = 'auto';   // right to left for Arabic and Hebrew lines
    fillLineText(textEl, i);

    el.appendChild(textEl);
    lyricsLines.appendChild(el);
  });

  applyTranslations();
}

/**
 * Draw line `index` into its text element — as timed word spans for
 * word-synced lyrics, plain text otherwise — with furigana over its kanji
 * when furigana is on and has arrived for the line.
 */
function fillLineText(textEl, index) {
  // Furigana or romanization: lyrics are offered one or the other.
  const annotations = (lyricsFurigana ? lyricsFurigana[index] : null)
    || (lyricsRomanization ? lyricsRomanization[index] : null);
  textEl.replaceChildren();

  if (Array.isArray(lyrics)) {
    const line = lyrics[index];
    if (syncType === 'WORD_SYNCED' && line.syllables && line.syllables.length > 0) {
      fillWordSyncedText(textEl, line, annotations);
      return;
    }
    appendSegments(textEl, line.words || '', annotations);
    return;
  }
  appendSegments(textEl, plainLyricsLines(lyrics)[index] || '', annotations);
}

function rubyElement(base, reading) {
  const ruby = document.createElement('ruby');
  ruby.append(base);
  const rt = document.createElement('rt');
  rt.textContent = reading;
  ruby.appendChild(rt);
  return ruby;
}

/** Text with ruby over its annotated runs, built as nodes, never as HTML. */
function appendSegments(parent, text, annotations) {
  if (!annotations || annotations.length === 0) {
    parent.append(text);
    return;
  }
  for (const seg of furiganaSegments(text, annotations)) {
    parent.append(seg.reading ? rubyElement(seg.text, seg.reading) : seg.text);
  }
}

function wordSpan(syl, text) {
  const span = document.createElement('span');
  span.className = 'word';
  span.textContent = text;
  span.dataset.startMs = syl.startTimeMs;
  span.dataset.endMs = syl.endTimeMs || syl.startTimeMs;
  return span;
}

/**
 * Word-synced: each syllable is a timed `.word` span the highlight walks.
 * With furigana, a syllable is cut where a kanji run starts or ends inside
 * it — the pieces keep its timing, so they light up together — and a run
 * spread over several syllables gets one ruby around all of them.  That ruby
 * is itself a `.word` timed from its first syllable, so its reading lights
 * up when the run starts being sung.
 */
function fillWordSyncedText(textEl, line, annotations) {
  const syllables = line.syllables;
  const groups = annotations && annotations.length > 0
    ? layoutWordFurigana(line.words || '', syllables.map((s) => s.word), annotations)
    : null;

  if (!groups) {
    syllables.forEach((syl) => textEl.appendChild(wordSpan(syl, syl.word + ' ')));
    // The timed pieces could not be found in the line's text, so readings
    // cannot sit over their words.  Romanization is still shown, as one
    // line under the lyrics line, rather than lost.
    if (lyricsRomanization && annotations && annotations.length > 0) {
      const block = document.createElement('span');
      block.className = 'line-romanization';
      block.textContent = annotations.map((a) => a.reading).join(' ');
      textEl.appendChild(block);
    }
    return;
  }

  for (const group of groups) {
    const { fragments, reading } = group;
    if (!reading) {
      for (const f of fragments) {
        textEl.appendChild(wordSpan(syllables[f.pieceIndex], f.text + (f.lastOfPiece ? ' ' : '')));
      }
      continue;
    }

    const first = syllables[fragments[0].pieceIndex];
    const single = fragments.every((f) => f.pieceIndex === fragments[0].pieceIndex);
    // Inside one syllable the ruby's text is plain; across several, each
    // part stays a span so it keeps its own syllable's timing.
    const base = single
      ? fragments.map((f) => f.text).join('')
      : (() => {
        const frag = document.createDocumentFragment();
        fragments.forEach((f) => frag.appendChild(wordSpan(syllables[f.pieceIndex], f.text)));
        return frag;
      })();
    const ruby = rubyElement(base, reading);
    ruby.classList.add('word');
    ruby.dataset.startMs = first.startTimeMs;
    ruby.dataset.endMs = first.endTimeMs || first.startTimeMs;
    textEl.appendChild(ruby);
    // The syllable's trailing space goes after the ruby, not inside it,
    // where it would push the reading off centre.
    if (fragments[fragments.length - 1].lastOfPiece) textEl.append(' ');
  }
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
    textEl.dir = 'auto';   // right to left for Arabic and Hebrew lines
    fillLineText(textEl, i);
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
  pollTimer = setInterval(pollOnce, source?.pollIntervalMs || CONFIG.POLL_INTERVAL_MS);
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
    const np = await source.poll();

    if (!np) {
      if (currentTrackId !== null || !statusMessage.classList.contains('hidden')) {
        currentTrackId = null;
        currentTrack = null;
        lyricsRequestId++;   // drop any lyrics still on their way for the last track
        clearLyricsDisplay();
        hideLyricsSource();
        updateNowPlayingUI(null);
      }
      isPlaying = false;
      estimator.update(null);
      showStatus(`Nothing is playing on ${source.label}`);
      return;
    }

    isPlaying = np.isPlaying;
    durationMs = np.durationMs || 0;

    // A seek has already moved the anchor locally; ignore the poll that is
    // still reporting the old position so the highlight does not snap back.
    const SEEK_GRACE_MS = 2500;
    const inSeekGrace = (Date.now() - lastSeekTimestamp) < SEEK_GRACE_MS;
    if (!inSeekGrace) {
      const anchor = estimator.update(np);
      lastProgressMs = anchor.progressMs;
      lastPollTimestamp = anchor.timestampMs;
    }

    updateNowPlayingUI(np);
    updateProgressUI(lastProgressMs, durationMs);

    // Track changed — fetch new lyrics, from whichever source has them: a
    // source picked in the panel was for the previous track only.
    if (np.trackId !== currentTrackId) {
      currentTrackId = np.trackId;
      lastHighlightedIndex = -1;
      lyricsPick = AUTO_PICK;
      await fetchAndSetLyrics(np.trackId, np.title, np.artist, durationMs);
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

/** @param {import('./sources.js').NowPlaying|null} np */
function updateNowPlayingUI(np) {
  if (!np) {
    trackNameEl.textContent = 'Not Playing';
    artistNameEl.textContent = '';
    albumArt.src = '';
    return;
  }

  trackNameEl.textContent = np.title;
  artistNameEl.textContent = np.artist;

  const img = np.artworkUrl || '';
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

// The source panel, lower right: "lyrics | translation | furigana" — see
// source-labels.js for what each slot shows.  The lyrics slot is a menu
// button: picking a source there fetches this track's lyrics from it alone.
const sourcePanel = { lyrics: '', translation: null, furigana: null, romanization: null };

function renderSourcePanel() {
  if (!sourcePanel.lyrics) {
    lyricsSourceEl.classList.add('hidden');
    closeSourcePicker();
    return;
  }
  const [lyricsText, ...rest] = sourcePanelSlots(sourcePanel);
  sourcePickerToggle.textContent = lyricsText;
  sourcePickerToggle.classList.toggle('picked', lyricsPick !== AUTO_PICK);
  sourceRestEl.textContent = rest.map((slot) => ` | ${slot}`).join('');
  lyricsSourceEl.classList.remove('hidden');
}

/** Set one slot of the panel: 'translation', 'furigana' or 'romanization'. */
function setSource(slot, value) {
  sourcePanel[slot] = value;
  renderSourcePanel();
}

/** Show the lyrics slot (see lyricsSlot in source-labels.js). */
function showLyricsSource(slot) {
  sourcePanel.lyrics = slot || '';
  renderSourcePanel();
}

/** A new request for lyrics starts the panel afresh, showing `lyricsText`. */
function resetSourcePanel(lyricsText) {
  sourcePanel.lyrics = lyricsText || '';
  sourcePanel.translation = null;
  sourcePanel.furigana = null;
  sourcePanel.romanization = null;
  renderSourcePanel();
}

function hideLyricsSource() {
  resetSourcePanel('');
}

// ── The source picker ──

function closeSourcePicker() {
  lyricsSourceEl.classList.remove('open');
  sourcePickerToggle.setAttribute('aria-expanded', 'false');
}

/** Tick the option for the current pick. */
function markSourcePicker() {
  sourcePickerMenu.querySelectorAll('.source-option').forEach((opt) => {
    opt.setAttribute('aria-checked', String(opt.dataset.source === lyricsPick));
  });
}

/** Fetch this track's lyrics again, from `pick` alone or ('auto') from whichever has them. */
function pickLyricsSource(pick) {
  closeSourcePicker();
  if (!currentTrack || pick === lyricsPick) return;
  lyricsPick = pick;
  const { trackId, trackName, artistName, trackDurationMs } = currentTrack;
  fetchAndSetLyrics(trackId, trackName, artistName, trackDurationMs);
}

function initSourcePicker() {
  const options = [{ id: AUTO_PICK, label: 'Auto' }, ...LYRICS_SOURCES];
  sourcePickerMenu.replaceChildren(...options.map(({ id, label }) => {
    const opt = document.createElement('button');
    opt.type = 'button';
    opt.className = 'source-option';
    opt.setAttribute('role', 'menuitemradio');
    opt.dataset.source = id;
    opt.textContent = id === AUTO_PICK ? label : lyricsLabel(label);
    return opt;
  }));
  markSourcePicker();

  sourcePickerToggle.addEventListener('click', (e) => {
    e.stopPropagation();
    const open = lyricsSourceEl.classList.toggle('open');
    sourcePickerToggle.setAttribute('aria-expanded', String(open));
  });
  sourcePickerMenu.addEventListener('click', (e) => {
    const opt = e.target.closest('.source-option');
    if (!opt) return;
    e.stopPropagation();
    pickLyricsSource(opt.dataset.source);
  });
  document.addEventListener('click', closeSourcePicker);
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && lyricsSourceEl.classList.contains('open')) {
      closeSourcePicker();
      sourcePickerToggle.focus();
    }
  });
}

initSourcePicker();

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
  const sourceId = selectSourceId({ search: window.location.search, storage: localStorage });
  source = buildSource(sourceId);
  estimator = new PositionEstimator({ quality: source.capabilities.position });
  applySourceCapabilities(source);

  // Only Spotify needs an OAuth round trip; every other source authenticates
  // server-side, so it goes straight to polling.
  if (sourceId !== 'spotify') {
    showMainScreen();
    startPolling();
    return;
  }

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
//  Lyrics Font Picker
// ============================================================

// Offered for every script fonts.js has fonts for, with the choice
// remembered per script.
let fontGroup = null;   // the group of the lyrics on screen, or null when none is offered
let fontSample = '';    // some of the lyrics on screen, for the device test below
const loadedFonts = new Set();
const deviceDraws = new Map();   // group → whether the device has fonts for its script

// The picker once covered Chinese only, under one key.
if (localStorage.getItem('cjk-font') !== null && localStorage.getItem(fontStorageKey('zh')) === null) {
  localStorage.setItem(fontStorageKey('zh'), localStorage.getItem('cjk-font'));
}
localStorage.removeItem('cjk-font');

function loadStylesheet(url) {
  if (!url || loadedFonts.has(url)) return;
  const link = document.createElement('link');
  link.rel = 'stylesheet';
  link.href = url;
  document.head.appendChild(link);
  loadedFonts.add(url);
}

/** How `text` looks drawn on a canvas in `lang`, in the CSS font list `fonts`. */
function canvasLook(text, fonts, lang) {
  const canvas = document.createElement('canvas');
  canvas.width = 240;
  canvas.height = 48;
  canvas.lang = lang;
  canvas.style.cssText = 'position:absolute;left:-9999px;top:0';
  document.body.appendChild(canvas);   // a canvas takes its language from the page only once in it
  try {
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    if ('lang' in ctx) ctx.lang = lang;
    ctx.font = `32px ${fonts}`;
    ctx.textBaseline = 'top';
    ctx.fillText(text, 4, 4);
    return `${ctx.measureText(text).width}:${ctx.getImageData(0, 0, canvas.width, canvas.height).data.join('')}`;
  } finally {
    canvas.remove();
  }
}

/** Whether the font `name` is installed: text drawn in it differs from the
 *  generic font's (tried against two, in case it is one of them). */
function fontInstalled(name, text) {
  return ['monospace', 'serif'].some((generic) => canvasLook(text, `"${name}", ${generic}`, '') !== canvasLook(text, generic, ''));
}

/**
 * Whether the device can draw the lyrics in `group`'s script.  A character
 * no font has is drawn as the same empty box as a code point nothing is
 * assigned to, so each of a few lyrics' characters is drawn on a canvas and
 * compared with that.
 *
 * Chinese and Japanese also need a font of their own: a Chinese font has
 * kana and kanji too, but draws many kanji (直, 骨, 写 …) in Chinese forms,
 * and a Japanese font the other way about.  So one of the group's `local`
 * fonts must be installed.  Comparing the forms themselves does not work:
 * neither a canvas nor an SVG image picks a fallback font by language.
 * Android's fonts cannot be named, but its CJK font takes its forms from
 * the lyrics' lang tag, so there the first test is enough.
 *
 * If the test cannot run, assume not: the fallback is then fetched.
 */
function deviceDrawsScript(group, sample) {
  if (deviceDraws.has(group)) return deviceDraws.get(group);
  let draws = false;
  try {
    const missing = canvasLook('\u{10FFFD}', 'sans-serif', '');
    const chars = scriptChars(group, sample);
    draws = chars.length > 0 && chars.every((ch) => canvasLook(ch, 'sans-serif', '') !== missing);
    const local = LYRICS_FONT_GROUPS[group]?.[0]?.local;
    if (draws && local && !/Android/i.test(navigator.userAgent)) {
      draws = local.some((name) => fontInstalled(name, `mmwwlli ${chars.join('')}`));
    }
  } catch {
    draws = false;
  }
  deviceDraws.set(group, draws);
  return draws;
}

/** Draw the lyrics in `choice` (its family and weight), or the page's own
 *  font — fetching the Noto fallback only on a device with no font for the
 *  lyrics' script. */
function applyLyricsFont(choice) {
  if (choice?.family || (choice?.fallback && !deviceDrawsScript(fontGroup, fontSample))) {
    loadStylesheet(googleFontsUrl(choice));
  }
  lyricsLines.style.fontFamily = fontFamilyValue(choice);
  if (choice?.family) lyricsLines.style.setProperty('--lyrics-weight', String(choice.weight));
  else lyricsLines.style.removeProperty('--lyrics-weight');
}

/** Put the lyrics back in the page's own font. */
function clearLyricsFont() {
  applyLyricsFont(null);
}

const fontPickerToggle = fontPicker.querySelector('.font-picker-toggle');
const fontPickerMenu = fontPicker.querySelector('.font-picker-menu');

function closeFontPicker() {
  fontPicker.classList.remove('open');
  fontPickerToggle.setAttribute('aria-expanded', 'false');
}

function hideFontPicker() {
  fontPicker.classList.add('hidden');
  closeFontPicker();
}

/** Fill the menu with the group's fonts, each label drawn in its own font
 *  (only the label's letters, fetched once the menu is opened). */
function renderFontOptions(group, selected) {
  fontPickerMenu.replaceChildren(...LYRICS_FONT_GROUPS[group].map((choice) => {
    const opt = document.createElement('div');
    opt.className = 'font-picker-option';
    opt.setAttribute('role', 'option');
    opt.dataset.value = choice.family;
    opt.textContent = choice.label;
    opt.classList.toggle('selected', choice.family === selected.family);
    opt.setAttribute('aria-selected', String(choice.family === selected.family));
    if (choice.family) opt.style.fontFamily = fontFamilyValue(choice);
    return opt;
  }));
  fontPickerToggle.querySelector('.font-picker-label').textContent = selected.label;
  // Phones show only "Aa" on the button, so the name is also its tooltip and label.
  fontPickerToggle.title = `Lyrics font: ${selected.label}`;
  fontPickerToggle.setAttribute('aria-label', `Lyrics font: ${selected.label}`);
}

/**
 * Tag the lyrics with their language, show the picker with their script's
 * fonts, and draw them in the one last picked for it.  The tag picks the
 * default font stack for the language (style.css) and, for characters
 * Chinese and Japanese share, the right forms.  The picker is hidden, and
 * the page's own font used, for lyrics none of the fonts can draw.
 */
function refreshFontPicker() {
  const sample = currentLineTexts().slice(0, 40).join('\n');
  const language = lyrics ? detectLyricsLanguage(sample, lyricsLanguage) : '';
  fontGroup = lyrics ? fontGroupFor(language, sample) : null;
  fontSample = sample;

  // The tag follows the script the lyrics are written in: Gurmukhi lyrics
  // declared as Hindi are tagged Punjabi, so they get Gurmukhi's fonts.
  const tag = languageTag(romanLanguage(fontGroup, language) || language);
  if (tag) lyricsLines.lang = tag; else lyricsLines.removeAttribute('lang');
  if (!fontGroup) {
    hideFontPicker();
    clearLyricsFont();
    return;
  }
  const choice = findFont(fontGroup, localStorage.getItem(fontStorageKey(fontGroup)) || '');
  renderFontOptions(fontGroup, choice);
  applyLyricsFont(choice);
  fontPicker.classList.remove('hidden');
}

function pickLyricsFont(family) {
  if (!fontGroup) return;
  const choice = findFont(fontGroup, family);
  localStorage.setItem(fontStorageKey(fontGroup), choice.family);
  renderFontOptions(fontGroup, choice);
  applyLyricsFont(choice);
}

function initFontPicker() {
  fontPickerToggle.addEventListener('click', (e) => {
    e.stopPropagation();
    const open = fontPicker.classList.toggle('open');
    fontPickerToggle.setAttribute('aria-expanded', String(open));
    if (open && fontGroup) {
      for (const choice of LYRICS_FONT_GROUPS[fontGroup]) {
        if (!loadedFonts.has(googleFontsUrl(choice))) loadStylesheet(previewFontUrl(choice));
      }
    }
  });

  fontPickerMenu.addEventListener('click', (e) => {
    const opt = e.target.closest('.font-picker-option');
    if (!opt) return;
    e.stopPropagation();
    pickLyricsFont(opt.dataset.value);
    closeFontPicker();
  });

  document.addEventListener('click', closeFontPicker);
}

initFontPicker();

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

// The lyrics source is part of the key: picking another source for the same
// track brings different lines, which the first source's translation would
// no longer fit.
function translationCacheKey() {
  return `${currentTrackId}:${currentLyricsSource}:${translateTarget}:${providerOverride() || 'auto'}`;
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
    // In the target language, whatever the lyrics above are in.
    target.lang = languageTag(translateTarget);
    target.dir = 'auto';
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

  // Whatever is still in flight was for another track or target, even when
  // this load is served from the cache: left running, a late reply would
  // replace what is shown with the wrong language.
  const requestId = ++translationRequestId;

  const key = translationCacheKey();
  const cached = translationCacheGet(key);
  if (cached) {
    translateToggle.classList.remove('loading');
    lyricsTranslations = cached.translations;
    setSource('translation', cached.source);
    applyTranslations();
    return;
  }

  translateToggle.classList.add('loading');
  setSource('translation', SOURCE_LOADING);

  let served = null;
  const result = await translateLines(texts, {
    target: translateTarget,
    provider: providerOverride(),
    workerUrl: CONFIG.WORKER_URL,
    onServed: (s) => { served = s; },
  });

  // A track change (or another toggle) happened while this was in flight.
  if (requestId !== translationRequestId) return;
  translateToggle.classList.remove('loading');

  if (!result) {
    console.debug('[translate] no translation returned; showing originals only');
    setSource('translation', SOURCE_FAILED);
    return;
  }

  const source = translationLabel(served);
  translationCacheSet(key, { translations: result, source });
  lyricsTranslations = result;
  setSource('translation', source);
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
    setSource('translation', null);
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
    setSource('translation', null);
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
//  Furigana
// ============================================================

const FURIGANA_ON_KEY = 'furigana-on';

let furiganaEnabled = localStorage.getItem(FURIGANA_ON_KEY) === '1';
let lyricsFurigana = null;     // per rendered line: annotations, [] or null
let furiganaRequestId = 0;     // guards against a slow reply for an old track

// Readings depend only on the lyrics, so one entry per track and lyrics source.
const FURIGANA_CACHE_MAX = 30;
const furiganaCache = new Map();

function furiganaCacheGet(key) {
  if (!furiganaCache.has(key)) return undefined;
  const value = furiganaCache.get(key);
  furiganaCache.delete(key);
  furiganaCache.set(key, value);
  return value;
}

function furiganaCacheSet(key, value) {
  if (furiganaCache.has(key)) furiganaCache.delete(key);
  furiganaCache.set(key, value);
  if (furiganaCache.size > FURIGANA_CACHE_MAX) {
    furiganaCache.delete(furiganaCache.keys().next().value);
  }
}

/** Redraw every line's text, with or without furigana. */
function applyFurigana() {
  lyricsLines.classList.toggle('with-furigana', Boolean(lyricsFurigana));
  lineElements().forEach((el, i) => {
    const textEl = el.querySelector('.line-text');
    if (textEl) fillLineText(textEl, i);
  });
}

function hideFuriganaControl() {
  furiganaToggle.classList.add('hidden');
}

// kuromoji, the dictionary step of the furigana chain (see FURIGANA_CHAIN in
// furigana.js).  Its dictionary is ~18 MB, so it is fetched only the first
// time the chain reaches it — when both Gemini models have left a word
// unread — and then kept for the session; the browser caches the files.
// It runs in a Web Worker (kuromoji-worker.js): decompressing and indexing
// the dictionary on this page's thread froze it for over a second at a
// time, stopping the lyrics mid-scroll.  The worker sends back each line's
// tokens, and the readings are worked out here.
let kuromojiWorker = null;
let kuromojiRequestId = 0;
const kuromojiPending = new Map();   // request id -> {resolve, reject}

function kuromojiWorkerInstance() {
  if (kuromojiWorker) return kuromojiWorker;
  kuromojiWorker = new Worker(new URL('./kuromoji-worker.js', import.meta.url));
  kuromojiWorker.onmessage = ({ data }) => {
    const pending = kuromojiPending.get(data?.id);
    if (!pending) return;
    kuromojiPending.delete(data.id);
    if (data.error) pending.reject(new Error(data.error)); else pending.resolve(data.tokens);
  };
  // A worker that fails outright is dropped, so a later song starts afresh.
  kuromojiWorker.onerror = (event) => {
    for (const pending of kuromojiPending.values()) pending.reject(new Error(event.message || 'kuromoji worker failed'));
    kuromojiPending.clear();
    kuromojiWorker.terminate();
    kuromojiWorker = null;
  };
  return kuromojiWorker;
}

async function readWithKuromoji(lines) {
  const worker = kuromojiWorkerInstance();
  const id = ++kuromojiRequestId;
  const tokens = await new Promise((resolve, reject) => {
    kuromojiPending.set(id, { resolve, reject });
    worker.postMessage({ id, lines });
  });
  return lines.map((line, i) => dictionaryReadings(tokens[i], line));
}

/**
 * Fetch and show furigana for the current track.  Like translation, nothing
 * is sent until the button is switched on.
 */
async function loadFurigana() {
  const texts = currentLineTexts();
  if (texts.length === 0) return;

  // As with translation: a cached load still abandons anything in flight.
  const requestId = ++furiganaRequestId;

  // Per track and lyrics source: another source's lines need their own readings.
  const key = `${currentTrackId}:${currentLyricsSource}`;
  const cached = furiganaCacheGet(key);
  if (cached) {
    furiganaToggle.classList.remove('loading');
    lyricsFurigana = cached.result;
    setSource('furigana', cached.source);
    applyFurigana();
    return;
  }

  furiganaToggle.classList.add('loading');
  setSource('furigana', SOURCE_LOADING);

  const steps = [];
  const result = await fetchFurigana(texts, {
    workerUrl: CONFIG.WORKER_URL,
    readWithDictionary: readWithKuromoji,
    onStep: (s) => steps.push(s),
  });

  if (requestId !== furiganaRequestId) return;
  furiganaToggle.classList.remove('loading');

  if (!result) {
    console.debug('[furigana] none returned; showing lyrics as they are');
    setSource('furigana', SOURCE_FAILED);
    return;
  }

  const source = furiganaLabel(steps);
  furiganaCacheSet(key, { result, source });
  lyricsFurigana = result;
  setSource('furigana', source);
  applyFurigana();
}

function setFuriganaEnabled(enabled) {
  furiganaEnabled = enabled;
  localStorage.setItem(FURIGANA_ON_KEY, enabled ? '1' : '0');
  furiganaToggle.classList.toggle('active', enabled);
  furiganaToggle.setAttribute('aria-pressed', String(enabled));
  furiganaToggle.title = enabled ? 'Hide furigana' : 'Show furigana';

  if (enabled) {
    loadFurigana();
  } else {
    furiganaRequestId++;   // abandon anything in flight
    furiganaToggle.classList.remove('loading');
    lyricsFurigana = null;
    setSource('furigana', null);
    applyFurigana();
  }
}

/** Show the button only for Japanese lyrics that have kanji to read. */
function refreshFuriganaControl() {
  const texts = currentLineTexts();
  const language = detectLyricsLanguage(texts.slice(0, 40).join('\n'), lyricsLanguage);

  if (!lyrics || language !== 'ja' || !texts.some(hasKanji)) {
    hideFuriganaControl();
    setSource('furigana', null);
    return;
  }

  furiganaToggle.classList.remove('hidden');
  furiganaToggle.classList.toggle('active', furiganaEnabled);
  furiganaToggle.setAttribute('aria-pressed', String(furiganaEnabled));
  if (furiganaEnabled) loadFurigana();
}

furiganaToggle.addEventListener('click', () => setFuriganaEnabled(!furiganaEnabled));

// ============================================================
//  Romanization — Greek, Hindi, Punjabi, Thai, Arabic, Hebrew and Cyrillic lyrics in English
//  letters, under each word (see romanize.js)
// ============================================================

const ROMANIZE_ON_KEY = 'romanize-on';

let romanizeEnabled = localStorage.getItem(ROMANIZE_ON_KEY) === '1';
let lyricsRomanization = null;   // per rendered line: annotations, [] or null
let romanizeRequestId = 0;       // guards against a slow reply for an old track
let romanizeGroup = null;        // the lyrics' script group, while the button shows
let romanizeLanguage = null;

// The button's glyph: a letter of the lyrics' script over its romanization.
const ROMANIZE_GLYPHS = { el: ['λ', 'l'], hi: ['क', 'k'], pa: ['ਕ', 'k'], th: ['ก', 'k'], ar: ['ب', 'b'], he: ['ש', 'sh'], ru: ['Я', 'ya'] };

const ROMANIZE_CACHE_MAX = 30;
const romanizeCache = new Map();

function romanizeCacheGet(key) {
  if (!romanizeCache.has(key)) return undefined;
  const value = romanizeCache.get(key);
  romanizeCache.delete(key);
  romanizeCache.set(key, value);
  return value;
}

function romanizeCacheSet(key, value) {
  if (romanizeCache.has(key)) romanizeCache.delete(key);
  romanizeCache.set(key, value);
  if (romanizeCache.size > ROMANIZE_CACHE_MAX) romanizeCache.delete(romanizeCache.keys().next().value);
}

/** Redraw every line's text, with or without romanization. */
function applyRomanization() {
  lyricsLines.classList.toggle('with-romanization', Boolean(lyricsRomanization));
  lineElements().forEach((el, i) => {
    const textEl = el.querySelector('.line-text');
    if (textEl) fillLineText(textEl, i);
  });
}

function hideRomanizeControl() {
  romanizeToggle.classList.add('hidden');
  romanizeGroup = null;
}

/**
 * Fetch and show romanization for the current track.  As with furigana,
 * nothing is sent until the button is switched on, and the lyrics keep
 * scrolling while it loads.
 */
async function loadRomanization() {
  const texts = currentLineTexts();
  const group = romanizeGroup;
  if (texts.length === 0 || !group) return;

  const requestId = ++romanizeRequestId;
  const key = `${currentTrackId}:${currentLyricsSource}`;
  const cached = romanizeCacheGet(key);
  if (cached) {
    romanizeToggle.classList.remove('loading');
    lyricsRomanization = cached.result;
    setSource('romanization', cached.source);
    applyRomanization();
    return;
  }

  romanizeToggle.classList.add('loading');
  setSource('romanization', SOURCE_LOADING);

  const steps = [];
  const result = await fetchRomanization(texts, {
    group,
    language: romanizeLanguage,
    workerUrl: CONFIG.WORKER_URL,
    onStep: (s) => steps.push(s),
  });

  if (requestId !== romanizeRequestId) return;
  romanizeToggle.classList.remove('loading');

  if (!result) {
    console.debug('[romanize] none returned; showing lyrics as they are');
    setSource('romanization', SOURCE_FAILED);
    return;
  }

  const source = romanizationLabel(steps);
  romanizeCacheSet(key, { result, source });
  lyricsRomanization = result;
  setSource('romanization', source);
  applyRomanization();
}

function setRomanizeEnabled(enabled) {
  romanizeEnabled = enabled;
  localStorage.setItem(ROMANIZE_ON_KEY, enabled ? '1' : '0');
  romanizeToggle.classList.toggle('active', enabled);
  romanizeToggle.setAttribute('aria-pressed', String(enabled));
  romanizeToggle.title = enabled ? 'Hide romanization' : 'Show romanization';

  if (enabled) {
    loadRomanization();
  } else {
    romanizeRequestId++;   // abandon anything in flight
    romanizeToggle.classList.remove('loading');
    lyricsRomanization = null;
    setSource('romanization', null);
    applyRomanization();
  }
}

/** Show the button only for lyrics in a script romanize.js covers. */
function refreshRomanizeControl() {
  const texts = currentLineTexts();
  const sample = texts.slice(0, 40).join('\n');
  const language = lyrics ? detectLyricsLanguage(sample, lyricsLanguage) : '';
  // Not the font group alone: Cyrillic shares the Latin fonts.
  const group = lyrics ? romanGroupFor(fontGroupFor(language, sample), sample) : null;

  if (!group || !texts.some((t) => hasRomanWords(t, group))) {
    hideRomanizeControl();
    setSource('romanization', null);
    return;
  }

  romanizeGroup = group;
  romanizeLanguage = romanLanguage(group, language);
  const [letter, roman] = ROMANIZE_GLYPHS[group];
  romanizeToggle.querySelector('.romanize-glyph-letter').textContent = letter;
  romanizeToggle.querySelector('.romanize-glyph rt').textContent = roman;
  romanizeToggle.classList.remove('hidden');
  romanizeToggle.classList.toggle('active', romanizeEnabled);
  romanizeToggle.setAttribute('aria-pressed', String(romanizeEnabled));
  romanizeToggle.title = romanizeEnabled ? 'Hide romanization' : 'Show romanization';
  if (romanizeEnabled) loadRomanization();
}

romanizeToggle.addEventListener('click', () => setRomanizeEnabled(!romanizeEnabled));

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
