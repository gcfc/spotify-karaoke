/**
 * Live evaluation of furigana models against the answer key in
 * tests/furigana_gold.json (built by tools/furigana-eval/build_gold.mjs).
 *
 * It runs the code that ships: the page's fetchFurigana() calls the Worker's
 * /furigana handler, which calls Gemini.  By default the Worker runs here,
 * in-process, with the key from GEMINI_API_KEY; with --worker it calls a
 * deployed Worker instead.  Lyrics are fetched live from NetEase, since the
 * key holds only readings.
 *
 * Scored per kanji run:
 *   accepted — the reading is one of the key's correct readings
 *   sung     — the reading is the one actually sung (gold[0])
 *   missing  — no reading came back for the line
 * broken down by category (dictionary, context, number, rare, sung,
 * printed), plus how often a reply was usable, how often repeated runs give
 * the same answer (--runs), and time per song.  kuromoji's readings from
 * the key are scored alongside as a dictionary baseline — but note it is
 * flattered on "dictionary" runs, which are by construction where it agreed
 * with the romanization.
 *
 * By default it scores `chain`: what the app does, each chunk trying the
 * models in FURIGANA_MODELS in turn, with no retries beyond that.  Naming
 * models scores each on its own instead, retrying a song whose requests
 * failed only because the model was busy.
 *
 * Usage:
 *   GEMINI_API_KEY=… node tests/eval_furigana_live.mjs --runs 3
 *   GEMINI_API_KEY=… node tests/eval_furigana_live.mjs --models gemini-3.1-flash-lite,gemini-3.5-flash-lite --runs 3
 *   node tests/eval_furigana_live.mjs --worker https://…workers.dev
 *   … --songs Lemon,白日   --verbose (list every wrong run)   --json out.json
 *   … --min-accuracy 0.95  (exit 1 if any model's accepted accuracy is lower)
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { fetchFurigana, kanjiRuns, mergeInlineReadings, FURIGANA_MODELS } from '../furigana.js';
import worker from '../worker/worker.js';

const { values } = parseArgs({
  options: {
    models: { type: 'string', default: 'chain' },
    runs: { type: 'string', default: '1' },
    songs: { type: 'string', default: '' },
    worker: { type: 'string', default: '' },
    verbose: { type: 'boolean', short: 'v', default: false },
    json: { type: 'string', default: '' },
    'min-accuracy': { type: 'string', default: '' },
    pace: { type: 'string', default: '1500' },
  },
});

const DIR = path.dirname(fileURLToPath(import.meta.url));
const GOLD = JSON.parse(fs.readFileSync(path.join(DIR, 'furigana_gold.json'), 'utf8'));
const MODELS = values.models.split(',').map((m) => m.trim()).filter(Boolean);
const RUNS = Math.max(1, Number(values.runs) || 1);
const PACE_MS = Number(values.pace) || 0;
const SONG_FILTER = values.songs ? values.songs.split(',') : null;

const LOCAL_WORKER = 'http://worker.local';
const workerUrl = values.worker || LOCAL_WORKER;

if (!values.worker && !process.env.GEMINI_API_KEY) {
  console.error('Set GEMINI_API_KEY, or pass --worker <url> to use a deployed Worker.');
  process.exit(2);
}

// Route the page's requests to the in-process Worker; everything else
// (NetEase, Gemini) goes out as normal.
const realFetch = globalThis.fetch;
if (!values.worker) {
  const env = { GEMINI_API_KEY: process.env.GEMINI_API_KEY };
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
// fetchFurigana logs each failed chunk; the evaluation reports them itself.
console.debug = () => {};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const kataToHira = (s) => String(s || '').replace(/[ァ-ヶ]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0x60));

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

function score(tally, byCat, run, reading) {
  const t = [tally, byCat[run.cat] ||= emptyTally()];
  for (const x of t) {
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
console.log(`Models: ${MODELS.join(', ')} · ${RUNS} run(s) each · via ${values.worker ? values.worker : 'in-process Worker'}\n`);

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
        score(tally, byCat, run, printed ? printed.reading : run.kuromoji);
      });
    }
  }
  report.baseline = { tally, byCat };
}

for (const model of MODELS) {
  const isChain = model === 'chain';
  const models = isChain ? FURIGANA_MODELS : [model];
  const label = isChain ? `chain (${FURIGANA_MODELS.join(' → ')})` : model;
  const answeredBy = new Map();    // model -> chunks it answered
  const tally = emptyTally();
  const byCat = {};
  const answers = new Map();       // run key -> readings across runs
  const mistakes = [];
  let linesSent = 0;
  let linesValid = 0;
  let chunks = 0;
  let chunkFailures = 0;
  let transientFailures = 0;
  const failureReasons = new Map();
  const songMs = [];

  for (let r = 0; r < RUNS; r++) {
    for (const song of songs) {
      let result = null;
      let attempts = 0;
      const t0 = Date.now();
      let log = [];
      // Scoring one model, a song whose chunks failed only because the model
      // was busy is tried again after a pause: overload says nothing about
      // its answers.  The chain is scored as the app runs it, with no retry
      // beyond falling through to the next model.
      for (;;) {
        log = [];
        result = await fetchFurigana(song.lyricTexts, { workerUrl, models, onChunk: (c) => log.push(c) });
        const busy = log.some((c) => !c.ok && c.transient);
        if (isChain || !busy || ++attempts >= 4) break;
        await sleep(10_000 * attempts);
      }
      songMs.push(Date.now() - t0);
      process.stderr.write(`  ${label} run ${r + 1} ${song.title}: ${((Date.now() - t0) / 1000).toFixed(1)}s, `
        + `${log.filter((c) => c.ok).length}/${log.length} requests ok${attempts ? `, ${attempts} busy retr${attempts > 1 ? 'ies' : 'y'}` : ''}\n`);
      for (const c of log.filter((x) => x.ok)) answeredBy.set(c.model, (answeredBy.get(c.model) || 0) + 1);
      chunks += log.length;
      chunkFailures += log.filter((c) => !c.ok).length;
      transientFailures += log.filter((c) => !c.ok && c.transient).length;
      for (const c of log.filter((x) => !x.ok)) {
        const reason = String(c.error).slice(0, 160);
        failureReasons.set(reason, (failureReasons.get(reason) || 0) + 1);
      }

      const indexOf = new Map(song.lyricTexts.map((text, i) => [text, i]).reverse());
      for (const text of new Set(song.lyricTexts.filter((t) => kanjiRuns(t).length > 0))) {
        linesSent++;
        if (result?.[indexOf.get(text)]) linesValid++;
      }

      for (const line of song.keyed) {
        const ann = result?.[indexOf.get(line.text)] || null;
        const runs = kanjiRuns(line.text);
        line.runs.forEach((run, i) => {
          const reading = ann ? ann.find((a) => a.start === runs[i].start)?.reading ?? null : null;
          score(tally, byCat, run, reading);
          const key = `${song.netease}@${line.t}#${i}`;
          if (!answers.has(key)) answers.set(key, []);
          answers.get(key).push(reading == null ? null : kataToHira(reading));
          if (r === 0 && !(reading != null && run.gold.includes(kataToHira(reading)))) {
            mistakes.push({ song: song.title, t: line.t, line: line.text, run: run.text, got: reading, gold: run.gold, cat: run.cat, kuromoji: run.kuromoji });
          }
        });
      }
      if (PACE_MS) await sleep(PACE_MS);
    }
  }

  const consistent = [...answers.values()].filter((a) => a.every((x) => x !== null && x === a[0])).length;
  report.models[label] = {
    tally, byCat, linesSent, linesValid, chunks, chunkFailures, transientFailures,
    answeredBy: Object.fromEntries(answeredBy),
    failureReasons: Object.fromEntries(failureReasons),
    consistency: RUNS > 1 ? consistent / answers.size : null,
    medianSongMs: songMs.sort((a, b) => a - b)[Math.floor(songMs.length / 2)],
    mistakes,
  };
}

// ── Report ──

const CATS = Object.keys(GOLD.categories);
const rows = [['', 'usable lines', 'accepted', 'sung', 'missing', ...CATS.map((c) => `${c}`), 'same across runs', 'median s/song']];
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

const widths = rows[0].map((_, i) => Math.max(...rows.map((r) => [...r[i]].length)));
for (const r of rows) console.log(r.map((cell, i) => (i === 0 ? cell.padEnd(widths[i]) : cell.padStart(widths[i]))).join('  '));
console.log('\naccepted/sung/categories: share of the key\'s runs read correctly. Categories show "accepted".');

for (const [name, m] of Object.entries(report.models)) {
  if (Object.keys(m.answeredBy).length > 1 || name.startsWith('chain')) {
    console.log(`\n${name}: chunks answered by ${Object.entries(m.answeredBy).map(([k, n]) => `${k} ${n}`).join(', ') || 'none'}`);
  }
  if (m.chunkFailures) {
    console.log(`\n${name}: ${m.chunkFailures}/${m.chunks} requests failed (${m.transientFailures} busy/overloaded, retried)`);
    for (const [reason, n] of Object.entries(m.failureReasons)) console.log(`  ${n}× ${reason}`);
  }
  if (values.verbose && m.mistakes.length) {
    console.log(`\n${name} — wrong or missing runs (first run):`);
    for (const x of m.mistakes) {
      console.log(`  ${x.song} ${x.t} [${x.cat}] ${x.run}: got ${x.got ?? '(none)'}, want ${x.gold.join('|')}   ${x.line}`);
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
