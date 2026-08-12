/**
 * Unit tests for script-insensitive search matching — Spotify hands us a title
 * in whatever script the release used (usually Simplified), while KKBOX stores
 * its catalogue in Traditional.
 *
 * Offline: the candidate lists below are trimmed from real
 * kkbox.com/api/search/song responses (titles and artists only).
 *
 * Usage:  node tests/test_matching.mjs
 */

import {
  cleanTrackName,
  foldToSimplified,
  normalizeForMatch,
  selectBestMatch,
  titleQueryVariants,
} from '../matching.js';

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

// ── 1. Traditional → Simplified folding ──

console.log('\n── foldToSimplified ──');

assert(foldToSimplified('在鬆手跟不鬆手之間') === '在松手跟不松手之间',
  'the reported title folds to its Simplified form');

assert(foldToSimplified('後來') === '后来', '後來 → 后来');
assert(foldToSimplified('愛情轉移') === '爱情转移', '愛情轉移 → 爱情转移');
assert(foldToSimplified('紅玫瑰') === '红玫瑰', '紅玫瑰 → 红玫瑰');

assert(foldToSimplified('在松手跟不松手之间') === '在松手跟不松手之间',
  'already-Simplified text is unchanged');

// A few of the Simplified forms in the table are outside the BMP, so anything
// that walks it by UTF-16 index instead of by code point returns garbage from
// the first surrogate pair onwards.  These characters sit past that point.
assert(foldToSimplified('龜難響頻') === '龟难响频',
  'characters late in the table fold correctly (surrogate-pair alignment)');

assert(foldToSimplified('Bohemian Rhapsody') === 'Bohemian Rhapsody',
  'Latin text passes through untouched');

assert(foldToSimplified('桜が咲く春の日に') === '桜が咲く春の日に',
  'kana passes through untouched');

assert(foldToSimplified('') === '' && foldToSimplified(null) === '',
  'empty and null fold to empty string');

// ── 2. Comparison form ──

console.log('\n── normalizeForMatch ──');

assert(normalizeForMatch('在鬆手跟不鬆手之間') === normalizeForMatch('在松手跟不松手之间'),
  'Traditional and Simplified spellings share one comparison form');

assert(normalizeForMatch('Eason Chan') === 'easonchan',
  'case and spaces dropped');

assert(normalizeForMatch('紅玫瑰(國) - Album Version') === '红玫瑰国albumversion',
  'punctuation and brackets dropped');

assert(normalizeForMatch('ＡＰＴ．') === 'apt',
  'full-width characters normalized to half-width');

// ── 3. Query variants ──

console.log('\n── titleQueryVariants ──');

assert(JSON.stringify(titleQueryVariants('在松手跟不松手之间')) === JSON.stringify(['在松手跟不松手之间']),
  'a Simplified, suffix-free title yields exactly one query');

assert(titleQueryVariants('在鬆手跟不鬆手之間').join('|') === '在鬆手跟不鬆手之間|在松手跟不松手之间',
  'a Traditional title also gets tried Simplified');

assert(titleQueryVariants('痴心的廢墟 - 電視劇《黃金十年》主題曲').join('|')
  === '痴心的廢墟 - 電視劇《黃金十年》主題曲|痴心的废墟 - 电视剧《黄金十年》主题曲|痴心的廢墟|痴心的废墟',
  'full title first, then suffix-stripped, each in both scripts');

assert(cleanTrackName('Hello (feat. Adele)') === 'Hello',
  'cleanTrackName still strips metadata suffixes');

// ── 4. Picking the right song out of a search page ──

console.log('\n── selectBestMatch ──');

// Real response for q="在松手跟不松手之间 Ecrolyn", terr=hk — KKBOX answers in
// Traditional even though the query was Simplified.
const ecrolyn = [
  { title: '在鬆手跟不鬆手之間', artist: 'Ecrolyn' },
  { title: '在鬆手跟不鬆手之間 - DJHZ版', artist: 'Ecrolyn, DJHZ' },
  { title: '在鬆手跟不鬆手之間 - 伴奏', artist: 'Ecrolyn' },
];

assert(selectBestMatch(ecrolyn, '在松手跟不松手之间', 'Ecrolyn') === 0,
  'Simplified Spotify title matches the Traditional KKBOX song (the reported case)');

assert(selectBestMatch(ecrolyn, '在鬆手跟不鬆手之間', 'Ecrolyn') === 0,
  'the same query written in Traditional matches too');

assert(selectBestMatch(ecrolyn, '在松手跟不松手之间', '') === 0,
  'the original wins over the remix and the instrumental when no artist is given');

// Real response for q="红玫瑰 陈奕迅" — KKBOX decorates the title, and pairs the
// Chinese artist name with its romanization.
const eason = [
  { title: '紅玫瑰(國) - Album Version', artist: '陳奕迅 (Eason Chan)' },
  { title: '孤兒仔', artist: '陳奕迅&苦榮&小苦妹&吳君如' },
];

assert(selectBestMatch(eason, '红玫瑰', '陈奕迅') === 0,
  'decorated KKBOX titles still match the plain Spotify title');

assert(selectBestMatch(eason, '红玫瑰', 'Eason Chan') === 0,
  'a romanized Spotify artist matches KKBOX\'s bilingual artist name');

// Real response for q="zzzznotarealsongxyz Nobody" — KKBOX never returns an
// empty page, so an unrelated song sits at index 0.
const noSuchSong = [
  { title: 'nowhere, nobody', artist: 'Sarah Kang' },
  { title: 'Nobody', artist: 'Mitski' },
];

assert(selectBestMatch(noSuchSong, 'zzzznotarealsongxyz', 'Nobody') === -1,
  'a page of unrelated results is rejected rather than scraped');

assert(selectBestMatch([], '在松手跟不松手之间', 'Ecrolyn') === -1,
  'an empty result list yields no match');

assert(selectBestMatch([{ title: '后', artist: '' }], '来', '') === -1,
  'single-character titles need an exact match, not a substring');

// ── Summary ──

console.log(`\n${'─'.repeat(40)}`);
console.log(`Results: ${passed} passed, ${failed} failed, ${passed + failed} total`);

if (failed > 0) {
  process.exit(1);
}
