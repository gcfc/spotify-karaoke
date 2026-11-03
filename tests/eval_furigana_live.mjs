/**
 * Live evaluation of furigana against the answer key in
 * tests/furigana_gold.json (built by tools/furigana-eval/build_gold.mjs).
 *
 * It runs the code that ships: the page's fetchFurigana() walks the chain,
 * calling the Worker's /furigana handler for model steps (which calls
 * Gemini) and kuromoji for the dictionary step.  By default the Worker runs
 * here, in-process, with the key from GEMINI_API_KEY; with --worker it calls
 * a deployed Worker instead.  kuromoji comes from tools/furigana-eval's own
 * npm install.  Lyrics are fetched live from NetEase, since the key holds
 * only readings.
 *
 * Scored per kanji run:
 *   accepted — the reading is one of the key's correct readings
 *   sung     — the reading is the one actually sung (gold[0])
 *   missing  — no reading came back for the run
 * broken down by category (dictionary, context, number, rare, sung,
 * printed) and by the chain step that supplied the reading, plus how often
 * a line got any reading, how often repeated passes give the same answer
 * (--runs), and time per song.  kuromoji's readings from the key are scored
 * alongside as a dictionary baseline — but note it is flattered on
 * "dictionary" runs, which are by construction where it agreed with the
 * romanization, so the same goes for whatever the dictionary step fills.
 *
 * By default it scores `chain`: FURIGANA_CHAIN exactly as the app runs it,
 * with no retries.  Naming models scores each alone instead, retrying a
 * song whose requests failed only because the model was busy; `a>b` scores
 * a chain of your own — `gemini-3.5-flash-lite>dictionary` is what the app
 * falls back to while 3.1 is down.
 *
 * Usage:
 *   GEMINI_API_KEY=… node tests/eval_furigana_live.mjs --runs 3
 *   GEMINI_API_KEY=… node tests/eval_furigana_live.mjs --models gemini-3.1-flash-lite,gemini-3.5-flash-lite --runs 3
 *   node tests/eval_furigana_live.mjs --worker https://…workers.dev
 *   … --cache        give the in-process Worker an in-memory store, so later
 *                    passes are served from stored readings
 *   … --songs Lemon,白日   --verbose (list every wrong run)   --json out.json
 *   … --min-accuracy 0.95  (exit 1 if any configuration's accepted accuracy is lower)
 */

import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import {
  DICTIONARY_STEP,
  dictionaryReadings,
  fetchFurigana,
  FURIGANA_CHAIN,
  kanjiRuns,
  mergeInlineReadings,
} from '../furigana.js';
import worker from '../worker/worker.js';

const { values } = parseArgs({
  options: {
    models: { type: 'string', default: 'chain' },
    runs: { type: 'string', default: '1' },
    songs: { type: 'string', default: '' },
    worker: { type: 'string', default: '' },
    cache: { type: 'boolean', default: false },
    verbose: { type: 'boolean', short: 'v', default: false },
    json: { type: 'string', default: '' },
    'min-accuracy': { type: 'string', default: '' },
    pace: { type: 'string', default: '1500' },
  },
});

const DIR = path.dirname(fileURLToPath(import.meta.url));
const GOLD = JSON.parse(fs.readFileSync(path.join(DIR, 'furigana_gold.json'), 'utf8'));
const CONFIGS = values.models.split(',').map((m) => m.trim()).filter(Boolean);
const RUNS = Math.max(1, Number(values.runs) || 1);
const PACE_MS = Number(values.pace) || 0;
const SONG_FILTER = values.songs ? values.songs.split(',') : null;

const LOCAL_WORKER = 'http://worker.local';
const workerUrl = values.worker || LOCAL_WORKER;

if (!values.worker && !process.env.GEMINI_API_KEY) {
  console.error('Set GEMINI_API_KEY, or pass --worker <url> to use a deployed Worker.');
  process.exit(2);
}

// An in-memory stand-in for the Worker's KV namespace.
function memoryKV() {
  const store = new Map();
  return {
    async get(key, type) { const v = store.get(key); return v == null ? null : type === 'json' ? JSON.parse(v) : v; },
    async put(key, value) { store.set(key, value); },
  };
}

// Route the page's requests to the in-process Worker; everything else
// (NetEase, Gemini) goes out as normal.
const realFetch = globalThis.fetch;
if (!values.worker) {
  const env = { GEMINI_API_KEY: process.env.GEMINI_API_KEY, ...(values.cache ? { FURIGANA_CACHE: memoryKV() } : {}) };
  globalThis.fetch = (url, init) => {
    if (!String(url).startsWith(LOCAL_WORKER)) return realFetch(url, init);
    const call = worker.fetch(new Request(url, init), env);
    // Honour the page's timeout, as a real network request would.
    const signal = init?.signal;
    if (!signal) return call;
    return Promise.race([call, new Promise((_, reject) => {
      signal.addEventListener('abort', () => reject(signal.reason), { once: true });
    })]);
  };
}
// fetchFurigana logs each failed step; the evaluation reports them itself.
console.debug = () => {};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const kataToHira = (s) => String(s || '').replace(/[ァ-ヶ]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0x60));

// ── kuromoji, for the dictionary step ──

let readWithDictionary = null;
if (CONFIGS.some((c) => c === 'chain' || c.split('>').includes(DICTIONARY_STEP))) {
  try {
    const toolDir = path.join(DIR, '../tools/furigana-eval');
    const kuromoji = createRequire(path.join(toolDir, 'package.json'))('kuromoji');
    const tokenizer = await new Promise((resolve, reject) => {
      kuromoji.builder({ dicPath: path.join(toolDir, 'node_modules/kuromoji/dict') })
        .build((err, t) => (err ? reject(err) : resolve(t)));
    });
    readWithDictionary = async (lines) => lines.map((line) => dictionaryReadings(tokenizer.tokenize(line), line));
  } catch (err) {
    console.error(`kuromoji unavailable (${err.message}); run \`npm install\` in tools/furigana-eval.`
      + ' The dictionary step will be skipped.\n');
  }
}

// ── Lyrics ──

function parseTimedLines(lrc) {
  const out = [];
  for (const raw of String(lrc || '').split('\n')) {
    const tags = [...raw.matchAll(/\[(\d+):(\d+)(?:[.:](\d+))?\]/g)];
    if (tags.length === 0) continue;
    const text = raw.replace(/\[[^\]]*\]/g, '').trim();
    for (const m of tags) {
      const t = `${m[1].padStart(2, '0')}:${m[2].padStart(2, '0')}.${(m[3] || '0').padEnd(2, '0').slice(0, 2)}`;
      out.push({ t, text });
    }
  }
  return out;
}

async function fetchLyricLines(id) {
  const resp = await realFetch(`https://music.163.com/api/song/lyric?id=${id}&lv=1`, {
    headers: { 'User-Agent': 'Mozilla/5.0', Accept: 'application/json' },
  });
  if (!resp.ok) throw new Error(`NetEase HTTP ${resp.status}`);
  return parseTimedLines((await resp.json())?.lrc?.lyric);
}

// ── Scoring ──

function emptyTally() {
  return { runs: 0, accepted: 0, sung: 0, missing: 0 };
}

function score(tallies, run, reading) {
  for (const x of tallies) {
    x.runs++;
    if (reading == null) { x.missing++; continue; }
    const r = kataToHira(reading);
    if (run.gold.includes(r)) x.accepted++;
    if (r === run.gold[0]) x.sung++;
  }
}

const pct = (n, d) => (d ? `${((100 * n) / d).toFixed(1)}%` : '—');

// ── Main ──

const songs = [];
for (const song of GOLD.songs) {
  if (SONG_FILTER && !SONG_FILTER.some((f) => song.title.includes(f))) continue;
  const lyric = await fetchLyricLines(song.netease);
  const textAt = new Map(lyric.map((l) => [l.t, l.text]));
  // The key's lines, matched to today's lyrics; a line whose runs no longer
  // match the key (the lyrics were edited upstream) is left out.
  const keyed = [];
  let stale = 0;
  for (const line of song.lines) {
    const text = textAt.get(line.t);
    const runs = text ? kanjiRuns(text).map((r) => r.text) : null;
    if (!runs || runs.join('|') !== line.runs.map((r) => r.text).join('|')) { stale++; continue; }
    keyed.push({ ...line, text });
  }
  songs.push({ ...song, lyricTexts: lyric.map((l) => l.text), keyed, stale });
}

const keyRuns = songs.reduce((n, s) => n + s.keyed.reduce((m, l) => m + l.runs.length, 0), 0);
console.log(`Answer key: ${songs.length} songs, ${songs.reduce((n, s) => n + s.keyed.length, 0)} lines, ${keyRuns} runs`
  + `${songs.some((s) => s.stale) ? ` (${songs.reduce((n, s) => n + s.stale, 0)} stale lines skipped)` : ''}`);
console.log(`Scoring: ${CONFIGS.join(', ')} · ${RUNS} pass(es) · via ${values.worker ? values.worker : 'in-process Worker'}`
  + `${values.cache ? ' with an in-memory store' : ''}\n`);

const report = { date: new Date().toISOString(), runs: RUNS, models: {} };

// Baseline: kuromoji's readings from the key, with the lyrics' own bracketed
// readings applied the same way the app applies them.
{
  const tally = emptyTally();
  const byCat = {};
  for (const song of songs) {
    for (const line of song.keyed) {
      const inline = mergeInlineReadings(line.text, []) || [];
      const runs = kanjiRuns(line.text);
      line.runs.forEach((run, i) => {
        const printed = inline.find((a) => a.start === runs[i].start);
        score([tally, byCat[run.cat] ||= emptyTally()], run, printed ? printed.reading : run.kuromoji);
      });
    }
  }
  report.baseline = { tally, byCat };
}

for (const config of CONFIGS) {
  const isChain = config === 'chain';
  const chain = isChain ? FURIGANA_CHAIN : config.split('>');
  const label = isChain ? `chain (${FURIGANA_CHAIN.join(' → ')})` : chain.join(' → ');
  const tally = emptyTally();
  const byCat = {};
  const bySource = {};             // chain step (or "printed") -> tally of the runs it supplied
  const answers = new Map();       // run key -> readings across passes
  const mistakes = [];
  const steps = {};                // chain step -> {ran, ok, failed, transient, cached, filled}
  const failureReasons = new Map();
  let linesSent = 0;
  let linesValid = 0;
  const songMs = [];

  for (let r = 0; r < RUNS; r++) {
    for (const song of songs) {
      let result = null;
      let attempts = 0;
      const t0 = Date.now();
      let log = [];
      // Scoring one model, a song that failed only because the model was busy
      // is tried again after a pause: overload says nothing about its
      // answers.  The chain is scored as the app runs it, with no retry.
      for (;;) {
        log = [];
        result = await fetchFurigana(song.lyricTexts, { workerUrl, chain, readWithDictionary, onStep: (s) => log.push(s) });
        const busy = log.some((s) => !s.ok && s.transient);
        if (isChain || !busy || ++attempts >= 4) break;
        await sleep(10_000 * attempts);
      }
      songMs.push(Date.now() - t0);

      const source = new Map();    // "line\u0000run" -> step that filled it
      for (const s of log) {
        const st = steps[s.step] ||= { ran: 0, ok: 0, failed: 0, transient: 0, cached: 0, filled: 0 };
        st.ran++;
        if (s.ok) { st.ok++; st.filled += s.filled; if (s.cached) st.cached++; } else { st.failed++; if (s.transient) st.transient++; }
        if (!s.ok) {
          const reason = `${s.step}: ${String(s.error).slice(0, 150)}`;
          failureReasons.set(reason, (failureReasons.get(reason) || 0) + 1);
        }
        for (const f of s.filledRuns || []) source.set(`${f.line}\u0000${f.run}`, s.step);
      }
      process.stderr.write(`  ${label} pass ${r + 1} ${song.title}: ${((Date.now() - t0) / 1000).toFixed(1)}s — `
        + log.map((s) => `${s.step} ${s.ok ? `${s.filled} filled${s.cached ? ' (stored)' : ''}` : 'failed'}`).join(', ')
        + `${attempts ? `, ${attempts} busy retr${attempts > 1 ? 'ies' : 'y'}` : ''}\n`);

      const indexOf = new Map(song.lyricTexts.map((text, i) => [text, i]).reverse());
      for (const text of new Set(song.lyricTexts.filter((t) => kanjiRuns(t).length > 0))) {
        linesSent++;
        if (result?.[indexOf.get(text)]) linesValid++;
      }

      for (const line of song.keyed) {
        const ann = result?.[indexOf.get(line.text)] || null;
        const runs = kanjiRuns(line.text);
        const printed = new Set((mergeInlineReadings(line.text, []) || []).map((a) => a.start));
        line.runs.forEach((run, i) => {
          const reading = ann ? ann.find((a) => a.start === runs[i].start)?.reading ?? null : null;
          const from = printed.has(runs[i].start) ? 'printed in the lyrics'
            : reading == null ? 'none' : source.get(`${line.text}\u0000${i}`) || 'none';
          score([tally, byCat[run.cat] ||= emptyTally(), bySource[from] ||= emptyTally()], run, reading);
          const key = `${song.netease}@${line.t}#${i}`;
          if (!answers.has(key)) answers.set(key, []);
          answers.get(key).push(reading == null ? null : kataToHira(reading));
          if (r === 0 && !(reading != null && run.gold.includes(kataToHira(reading)))) {
            mistakes.push({ song: song.title, t: line.t, line: line.text, run: run.text, got: reading, from,
              gold: run.gold, cat: run.cat, kuromoji: run.kuromoji });
          }
        });
      }
      if (PACE_MS) await sleep(PACE_MS);
    }
  }

  const consistent = [...answers.values()].filter((a) => a.every((x) => x !== null && x === a[0])).length;
  report.models[label] = {
    tally, byCat, bySource, steps, linesSent, linesValid,
    failureReasons: Object.fromEntries(failureReasons),
    consistency: RUNS > 1 ? consistent / answers.size : null,
    medianSongMs: songMs.sort((a, b) => a - b)[Math.floor(songMs.length / 2)],
    mistakes,
  };
}

// ── Report ──

const CATS = Object.keys(GOLD.categories);
const rows = [['', 'lines read', 'accepted', 'sung', 'missing', ...CATS, 'same across passes', 'median s/song']];
const catCounts = CATS.map((c) => report.baseline.byCat[c]?.runs || 0);
for (const [name, m] of Object.entries(report.models)) {
  rows.push([
    name,
    pct(m.linesValid, m.linesSent),
    pct(m.tally.accepted, m.tally.runs),
    pct(m.tally.sung, m.tally.runs),
    String(m.tally.missing),
    ...CATS.map((c) => pct(m.byCat[c]?.accepted || 0, m.byCat[c]?.runs || 0)),
    m.consistency == null ? '—' : pct(m.consistency, 1),
    (m.medianSongMs / 1000).toFixed(1),
  ]);
}
const b = report.baseline;
rows.push(['kuromoji (baseline)', '—', pct(b.tally.accepted, b.tally.runs), pct(b.tally.sung, b.tally.runs), String(b.tally.missing),
  ...CATS.map((c) => pct(b.byCat[c]?.accepted || 0, b.byCat[c]?.runs || 0)), '—', '—']);
rows.push(['(runs in key)', '', String(b.tally.runs), '', '', ...catCounts.map(String), '', '']);

const table = (rs) => {
  const widths = rs[0].map((_, i) => Math.max(...rs.map((r) => [...r[i]].length)));
  for (const r of rs) console.log(r.map((cell, i) => (i === 0 ? cell.padEnd(widths[i]) : cell.padStart(widths[i]))).join('  '));
};
table(rows);
console.log('\naccepted/sung/categories: share of the key\'s runs read correctly. Categories show "accepted".');

for (const [name, m] of Object.entries(report.models)) {
  console.log(`\n${name} — where each run's reading came from:`);
  table([['source', 'runs', 'accepted', 'sung'],
    ...Object.entries(m.bySource).map(([src, t]) => [src, String(t.runs), pct(t.accepted, t.runs), pct(t.sung, t.runs)])]);
  console.log('  steps: ' + Object.entries(m.steps).map(([s, st]) => `${s} ran ${st.ran}× (${st.ok} ok`
    + `${st.cached ? `, ${st.cached} from stored readings` : ''}${st.failed ? `, ${st.failed} failed` : ''}), filled ${st.filled}`).join('; '));
  for (const [reason, n] of Object.entries(m.failureReasons)) console.log(`  ${n}× ${reason.replace(/\s+/g, ' ')}`);
  if (values.verbose && m.mistakes.length) {
    console.log(`\n${name} — wrong or missing runs (first pass):`);
    for (const x of m.mistakes) {
      console.log(`  ${x.song} ${x.t} [${x.cat}] ${x.run}: got ${x.got ?? '(none)'} from ${x.from}, want ${x.gold.join('|')}   ${x.line}`);
    }
  }
}

if (values.json) {
  fs.writeFileSync(values.json, `${JSON.stringify(report, null, 1)}\n`);
  console.log(`\nWrote ${values.json}`);
}

if (values['min-accuracy']) {
  const min = Number(values['min-accuracy']);
  const failing = Object.entries(report.models).filter(([, m]) => m.tally.accepted / m.tally.runs < min);
  if (failing.length) {
    console.error(`\nBelow ${pct(min, 1)} accepted: ${failing.map(([n]) => n).join(', ')}`);
    process.exit(1);
  }
}
