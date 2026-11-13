// ============================================================
//  The source panel in the lower right: which service supplied the lyrics,
//  the translation and the furigana — or, for Greek, Hindi, Thai, Arabic
//  and Hebrew lyrics, the romanization — now on screen, as
//  "lyrics | translation | furigana" — "Kugou | 3.5 | 3.1+kuro".
//
//  The slots keep their places: one that is off shows "–" while a later one
//  is on ("Kugou | – | 3.1"), one still loading shows "…", and one whose
//  sources all failed shows "×".  Trailing slots that are off are left out,
//  so lyrics with neither shown read just "Kugou".
// ============================================================

import { DICTIONARY_STEP } from './furigana.js';
import { RULES_STEP } from './romanize.js';

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
 * The romanization slot, from fetchRomanization's onStep reports, as for
 * furigana: "3.1", "3.1+rules", "3.1 (stored)"; Greek, by rules alone,
 * shows "rules".
 */
export function romanizationLabel(steps) {
  const parts = (steps || []).filter((s) => s.ok && s.filled > 0).map((s) => (s.step === RULES_STEP
    ? 'rules'
    : `${shortModelLabel(s.model || s.step)}${s.cached ? ' (stored)' : ''}`));
  return parts.length > 0 ? parts.join('+') : SOURCE_FAILED;
}

/**
 * The lyrics slot, which is also the source picker's button.  Left to the
 * automatic chain it shows the source the lyrics came from, "…" while
 * looking and "×" when no source had any; with a source picked it names
 * that source, adding " …" while asking it and " ×" when it had nothing.
 *
 * @param {{picked?: string|null, shown?: string|null, loading?: boolean}} state
 *   `picked`: the picked source's name, or null for automatic;
 *   `shown`: the source of the lyrics on screen, or null.
 */
export function lyricsSlot({ picked = null, shown = null, loading = false }) {
  if (loading) return picked ? `${lyricsLabel(picked)} ${SOURCE_LOADING}` : SOURCE_LOADING;
  if (shown) return lyricsLabel(shown);
  return picked ? `${lyricsLabel(picked)} ${SOURCE_FAILED}` : SOURCE_FAILED;
}

/**
 * The panel's slots, lyrics first.  `translation`, `furigana` and
 * `romanization` are a label, SOURCE_LOADING, SOURCE_FAILED, or null when
 * that feature is off.  Furigana and romanization share the third slot:
 * lyrics are offered one or the other, never both.
 */
export function sourcePanelSlots({ lyrics, translation, furigana, romanization }) {
  const slots = [lyricsLabel(lyrics), translation, furigana || romanization || null];
  while (slots.length > 1 && !slots[slots.length - 1]) slots.pop();
  return slots.map((s) => s || SOURCE_OFF);
}

/** The panel's text: its slots joined, "Kugou | 3.5 | 3.1+kuro". */
export function sourcePanelText(state) {
  return sourcePanelSlots(state).join(' | ');
}
