/**
 * Unit tests for the source panel's text — "lyrics | translation | furigana".
 *
 * Usage:  node tests/test_source_labels.mjs
 */

import { DICTIONARY_STEP } from '../furigana.js';
import {
  furiganaLabel,
  shortModelLabel,
  SOURCE_FAILED,
  SOURCE_LOADING,
  sourcePanelText,
  translationLabel,
} from '../source-labels.js';

let passed = 0;
let failed = 0;

function assert(condition, label) {
  if (condition) {
    console.log(`  ✓ ${label}`);
    passed++;
  } else {
    console.error(`  ✗ ${label}`);
    failed++;
  }
}

console.log('\n── shortModelLabel ──');

assert(shortModelLabel('gemini-3.1-flash-lite') === '3.1', 'a versioned Gemini model shows its version');
assert(shortModelLabel('gemini-3.5-flash-lite') === '3.5', '3.5 likewise');
assert(shortModelLabel('gemini-flash-lite-latest') === 'flash-lite', 'an alias without a version keeps its family');
assert(shortModelLabel('gemini-flash-latest') === 'flash', 'gemini-flash-latest is flash');
assert(shortModelLabel('nvidia/nemotron-3-super-120b-a12b:free') === 'nemotron', 'an OpenRouter model shows its first word');

console.log('\n── translationLabel ──');

assert(translationLabel({ provider: 'gemini-flash-lite-latest', model: 'gemini-3.5-flash-lite' }) === '3.5',
  'the model that answered, not the alias that was asked');
assert(translationLabel({ provider: 'gemini-flash-lite-latest', model: null }) === 'flash-lite',
  "an older Worker that does not say which version answered: the alias's family");
assert(translationLabel({ provider: 'free', model: null }) === 'Google', 'the keyless endpoint is Google');
assert(translationLabel({ provider: 'cloud', model: null }) === 'Google Cloud', 'the paid one is Google Cloud');
assert(translationLabel(null) === SOURCE_FAILED, 'no report at all reads as failed');

console.log('\n── furiganaLabel ──');

const step = (s, extra = {}) => ({ step: s, ok: true, filled: 3, ...extra });
assert(furiganaLabel([step('gemini-3.1-flash-lite')]) === '3.1', '3.1 alone');
assert(furiganaLabel([step('gemini-3.1-flash-lite', { model: 'gemini-3.1-flash-lite', cached: true })]) === '3.1 (stored)',
  'stored readings are marked');
assert(furiganaLabel([step('gemini-3.5-flash-lite', { model: 'gemini-3.1-flash-lite', cached: true })]) === '3.1 (stored)',
  'stored readings are credited to the model that made them, not the one asked');
assert(furiganaLabel([step('gemini-3.1-flash-lite'), step(DICTIONARY_STEP)]) === '3.1+kuro',
  'every step that filled a word, in chain order');
assert(furiganaLabel([{ step: 'gemini-3.1-flash-lite', ok: false, filled: 0 }, step('gemini-3.5-flash-lite'), step(DICTIONARY_STEP)])
  === '3.5+kuro', 'a step that failed is left out');
assert(furiganaLabel([step('gemini-3.1-flash-lite'), step('gemini-3.5-flash-lite', { filled: 0 })]) === '3.1',
  'a step that filled nothing is left out');
assert(furiganaLabel([]) === 'printed', 'readings only from the lyrics themselves are "printed"');

console.log('\n── sourcePanelText ──');

assert(sourcePanelText({ lyrics: 'Kugou', translation: '3.5', furigana: '3.1+kuro' }) === 'Kugou | 3.5 | 3.1+kuro',
  'all three slots');
assert(sourcePanelText({ lyrics: 'Kugou', translation: null, furigana: null }) === 'Kugou', 'lyrics alone');
assert(sourcePanelText({ lyrics: 'Kugou', translation: '3.5', furigana: null }) === 'Kugou | 3.5', 'a trailing slot that is off is left out');
assert(sourcePanelText({ lyrics: 'Kugou', translation: null, furigana: '3.1' }) === 'Kugou | – | 3.1',
  'a slot that is off before one that is on shows a dash, so slots keep their places');
assert(sourcePanelText({ lyrics: 'Spotify', translation: SOURCE_LOADING, furigana: SOURCE_FAILED }) === 'Spotify | … | ×',
  'loading and failed have their own marks');

console.log(`\n${'─'.repeat(40)}`);
console.log(`Results: ${passed} passed, ${failed} failed, ${passed + failed} total`);

if (failed > 0) {
  process.exit(1);
}
