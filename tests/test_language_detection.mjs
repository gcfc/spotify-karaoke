/**
 * Unit tests for CJK language detection — verifies that Traditional→Simplified
 * conversion only activates for Chinese lyrics, not Japanese or other languages.
 *
 * Usage:  node tests/test_language_detection.mjs
 */

import { isChinese } from '../lyrics.js';

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

// ── 1. Spotify language tag takes priority ──

console.log('\n── Spotify language tag (explicit) ──');

assert(isChinese('', 'zh-Hant') === true,
  'zh-Hant → Chinese (Traditional Chinese)');

assert(isChinese('', 'zh-TW') === true,
  'zh-TW → Chinese (Taiwan)');

assert(isChinese('', 'zh-HK') === true,
  'zh-HK → Chinese (Hong Kong)');

assert(isChinese('', 'zh') === true,
  'zh → Chinese (generic)');

assert(isChinese('', 'ja') === false,
  'ja → NOT Chinese (Japanese)');

assert(isChinese('', 'ko') === false,
  'ko → NOT Chinese (Korean)');

assert(isChinese('', 'en') === false,
  'en → NOT Chinese (English)');

assert(isChinese('', 'JA') === false,
  'JA (uppercase) → NOT Chinese');

assert(isChinese('', 'ZH-Hant') === true,
  'ZH-Hant (mixed case) → Chinese');

// Language tag overrides text content
assert(isChinese('桜が咲く春の日に', 'zh') === true,
  'lang=zh overrides even if text has no kana');

assert(isChinese('這是中文歌詞', 'ja') === false,
  'lang=ja overrides even if text looks Chinese');

// ── 2. Heuristic: Japanese (Kanji + Hiragana/Katakana) ──

console.log('\n── Heuristic: Japanese text (has kana) ──');

assert(isChinese('桜が咲く春の日に', null) === false,
  'Kanji + Hiragana → Japanese, not Chinese');

assert(isChinese('東京タワーへ行こう', null) === false,
  'Kanji + Katakana + Hiragana → Japanese');

assert(isChinese('カラオケで歌う夜', null) === false,
  'Katakana + Hiragana + Kanji → Japanese');

assert(isChinese('ありがとう', null) === false,
  'Pure Hiragana (no Kanji) → not Chinese');

assert(isChinese('アイドル', null) === false,
  'Pure Katakana → not Chinese');

assert(isChinese('夜に駆ける', null) === false,
  'YOASOBI-style mixed → Japanese');

// ── 3. Heuristic: Chinese text (Hanzi only, no kana) ──

console.log('\n── Heuristic: Chinese text (no kana) ──');

assert(isChinese('這是中文歌詞', null) === true,
  'Traditional Chinese → Chinese');

assert(isChinese('稻香', null) === true,
  'Short Traditional Chinese → Chinese');

assert(isChinese('我爱你中国', null) === true,
  'Simplified Chinese → Chinese');

assert(isChinese('天涯共此時 明月幾時有', null) === true,
  'Classical Chinese poetry → Chinese');

// ── 4. Non-CJK text ──

console.log('\n── Non-CJK text ──');

assert(isChinese('Hello world, this is English', null) === false,
  'English text → not Chinese');

assert(isChinese('', null) === false,
  'Empty string → not Chinese');

assert(isChinese('1234567890!@#$%', null) === false,
  'Digits and symbols → not Chinese');

assert(isChinese('안녕하세요 사랑해요', null) === false,
  'Korean Hangul (no Hanja) → not Chinese');

// ── 5. Edge cases: mixed content ──

console.log('\n── Edge cases ──');

assert(isChinese('周杰倫 Jay Chou - 稻香 Rice Field', null) === true,
  'Chinese + English mix (no kana) → Chinese');

assert(isChinese('米津玄師 - Lemon レモン', null) === false,
  'Japanese artist + Katakana → Japanese');

assert(isChinese('YOASOBI「夜に駆ける」', null) === false,
  'Japanese with brackets + kana → Japanese');

// Realistic multi-line samples (first 5 lines joined like convertLyricsToSimplified does)
const chineseSample = '對你愛愛愛不完我可以天天月月年年到永遠';
const japaneseSample = '夜に駆けるよ僕らは今夜も走り続ける';

assert(isChinese(chineseSample, null) === true,
  'Multi-line Chinese lyrics sample → Chinese');

assert(isChinese(japaneseSample, null) === false,
  'Multi-line Japanese lyrics sample → Japanese');

// ── Summary ──

console.log(`\n${'─'.repeat(40)}`);
console.log(`Results: ${passed} passed, ${failed} failed, ${passed + failed} total`);

if (failed > 0) {
  process.exit(1);
}
