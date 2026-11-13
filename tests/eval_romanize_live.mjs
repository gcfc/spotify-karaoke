/**
 * Live evaluation of romanization against the answer keys:
 *   tests/romanize_gold_hi.json     Hindi — published romanized lyrics,
 *                                   paired with the Devanagari by LRCLIB
 *                                   timestamps (tools/romanize-eval/build_gold.mjs)
 *   tests/romanize_gold_small.json  Greek, Thai, Arabic, Hebrew — small
 *                                   hand-made keys (see its "about")
 *
 * Each source runs through the page's own code (fetchRomanization) with its
 * requests handed straight to the Worker's handler, so what is measured is
 * what the page shows.  A word scores exact when its romanization matches an
 * accepted spelling (case, apostrophes and hyphens aside), loose when it
 * does once spelling variants are folded (tools/romanize-eval/score.mjs).
 *
 * Usage:
 *   GEMINI_API_KEY=… node tests/eval_romanize_live.mjs [--lang hi,th] [--source rules,gemini-3.1-flash-lite,chain] [--runs 2] [--misses]
 */
import { readFileSync } from 'node:fs';
import worker from '../worker/worker.js';
import { fetchRomanization, ROMANIZE_CHAINS, RULES_STEP, romanWords } from '../romanize.js';
import { exactKey, looseKey } from '../tools/romanize-eval/score.mjs';

const args = process.argv.slice(2);
const opt = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : fallback;
};
const langs = opt('lang', 'el,hi,th,ar,he').split(',');
const runs = Number(opt('runs', '1'));
const showMisses = args.includes('--misses');

// The Worker, called in-process.  No KV binding: every song is read afresh.
const env = { GEMINI_API_KEY: process.env.GEMINI_API_KEY };
const realFetch = globalThis.fetch;
globalThis.fetch = (url, init) => (String(url).startsWith('http://worker/')
  ? worker.fetch(new Request(url, init), env, {})
  : realFetch(url, init));

/** Per language: lines, each with the words expected and their accepted spellings. */
function loadKeys() {
  const keys = {};
  const hi = JSON.parse(readFileSync(new URL('./romanize_gold_hi.json', import.meta.url), 'utf8'));
  keys.hi = hi.songs.flatMap((song) => song.lines.map(({ line, gold }) => ({
    line,
    expected: romanWords(line, 'hi').map((w, i) => ({ ...w, alts: [gold[i]] })),
  })));
  const small = JSON.parse(readFileSync(new URL('./romanize_gold_small.json', import.meta.url), 'utf8'));
  for (const group of ['el', 'th', 'ar', 'he']) {
    keys[group] = small[group].map(({ line, gold }) => {
      let cursor = 0;
      const expected = gold.map(([text, alts]) => {
        const start = line.indexOf(text, cursor);
        if (start < 0) throw new Error(`${group}: "${text}" not in "${line}"`);
        cursor = start + text.length;
        return { start, end: cursor, text, alts };
      });
      return { line, expected };
    });
  }
  return keys;
}

function score(key, result) {
  const s = { words: 0, answered: 0, exact: 0, loose: 0, misses: [] };
  key.forEach(({ line, expected }, i) => {
    const got = result?.[i] || [];
    for (const w of expected) {
      s.words++;
      const a = got.find((x) => x.start === w.start && x.end === w.end);
      if (!a) { s.misses.push(`${w.text}: — (${w.alts[0]})  in ${line}`); continue; }
      s.answered++;
      const exact = w.alts.some((alt) => exactKey(alt) === exactKey(a.reading));
      const loose = exact || w.alts.some((alt) => looseKey(alt) === looseKey(a.reading));
      if (exact) s.exact++;
      if (loose) s.loose++;
      if (!loose) s.misses.push(`${w.text}: ${a.reading} (${w.alts.slice(0, 3).join('/')})  in ${line}`);
    }
  });
  return s;
}

const pct = (n, d) => (d ? `${(100 * n / d).toFixed(1)}%` : '—');
const keys = loadKeys();
console.log('lang  source                   words  answered  exact    loose    lines dropped  time');
for (const group of langs) {
  const key = keys[group];
  const lines = key.map((k) => k.line);
  const chain = ROMANIZE_CHAINS[group];
  const sources = opt('source', [...chain, ...(chain.length > 1 ? ['chain'] : [])].join(',')).split(',')
    .filter((s) => s === 'chain' || chain.includes(s));
  for (const source of sources) {
    for (let run = 0; run < runs; run++) {
      const t0 = Date.now();
      const steps = [];
      const result = await fetchRomanization(lines, {
        group, workerUrl: 'http://worker', chain: source === 'chain' ? chain : [source], onStep: (st) => steps.push(st),
      });
      const s = score(key, result);
      const dropped = key.filter((_, i) => !result?.[i]).length;
      const errors = steps.filter((st) => !st.ok).map((st) => `${st.step}: ${st.error}`);
      console.log(`${group.padEnd(5)} ${source.padEnd(24)} ${String(s.words).padStart(5)}  ${pct(s.answered, s.words).padStart(7)}  ${pct(s.exact, s.words).padStart(6)}  ${pct(s.loose, s.words).padStart(6)}  ${String(dropped).padStart(8)}/${key.length}  ${((Date.now() - t0) / 1000).toFixed(1)}s${errors.length ? `  ${errors.join('; ')}` : ''}`);
      if (showMisses && run === 0) s.misses.slice(0, 40).forEach((m) => console.log(`        ${m}`));
    }
  }
}
if (langs.some((g) => ROMANIZE_CHAINS[g]?.includes(RULES_STEP))) {
  console.log('\nexact: an accepted spelling; loose: once vowel length, w/v, z/j, doubled letters and a final nasal n are folded.');
}
