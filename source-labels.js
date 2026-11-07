// ============================================================
//  The source panel in the lower right: which service supplied the lyrics,
//  the translation and the furigana now on screen, as
//  "lyrics | translation | furigana" — "Kugou | 3.5 | 3.1+kuro".
//
//  The slots keep their places: one that is off shows "–" while a later one
//  is on ("Kugou | – | 3.1"), one still loading shows "…", and one whose
//  sources all failed shows "×".  Trailing slots that are off are left out,
//  so lyrics with neither shown read just "Kugou".
// ============================================================

import { DICTIONARY_STEP } from './furigana.js';

export const SOURCE_LOADING = '…';
export const SOURCE_FAILED = '×';
const SOURCE_OFF = '–';

// lyrics.js names its sources in full; the panel shortens the long ones.
const LYRICS_SHORT = {
  'Kugou Music': 'Kugou',
  'QQ Music': 'QQ',
  'NetEase Cloud Music': 'NetEase',
};

/** The lyrics slot: Spotify, LRCLIB, Kugou, QQ or NetEase. */
export function lyricsLabel(source) {
  return LYRICS_SHORT[source] || source || '';
}

/**
 * A model's short name.  A versioned Gemini model shows its version
 * (gemini-3.1-flash-lite → 3.1); an alias without one keeps its family
 * (gemini-flash-lite-latest → flash-lite); anything else its first word
 * (nvidia/nemotron-3-super-120b-a12b:free → nemotron).
 */
export function shortModelLabel(model) {
  const id = String(model || '');
  const version = id.match(/gemini-(\d+(?:\.\d+)?)/);
  if (version) return version[1];
  const family = id.match(/gemini-([a-z-]+?)(?:-latest)?$/);
  if (family) return family[1];
  return id.split('/').pop().split(/[-:]/)[0] || id;
}

/**
 * The translation slot, from translateLines' onServed report
 * (`{provider, model}`).  An LLM shows the model that answered, which for
 * gemini-flash-lite-latest is whichever version the alias points at.
 */
export function translationLabel(served) {
  if (!served?.provider) return SOURCE_FAILED;
  if (served.provider === 'free') return 'Google';
  if (served.provider === 'cloud') return 'Google Cloud';
  return shortModelLabel(served.model || served.provider);
}

/**
 * The furigana slot, from fetchFurigana's onStep reports: every step that
 * filled a word, in chain order — "3.1", "3.1+kuro", "3.1 (stored)" when the
 * Worker answered from stored readings.  A song whose only readings were
 * printed in its lyrics shows "printed".
 */
export function furiganaLabel(steps) {
  const parts = (steps || []).filter((s) => s.ok && s.filled > 0).map((s) => (s.step === DICTIONARY_STEP
    ? 'kuro'
    : `${shortModelLabel(s.model || s.step)}${s.cached ? ' (stored)' : ''}`));
  return parts.length > 0 ? parts.join('+') : 'printed';
}

/**
 * The panel's text.  `translation` and `furigana` are a label, SOURCE_LOADING,
 * SOURCE_FAILED, or null when that feature is off.
 */
export function sourcePanelText({ lyrics, translation, furigana }) {
  const slots = [lyricsLabel(lyrics), translation, furigana];
  while (slots.length > 1 && !slots[slots.length - 1]) slots.pop();
  return slots.map((s) => s || SOURCE_OFF).join(' | ');
}
