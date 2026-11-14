/**
 * Build a romanization answer key from LRCLIB: for each song, one upload in
 * the native script and one typed in English letters, both time-synced.
 * Their lines are paired by timestamp, and a pair is kept only when both
 * have the same number of words, and most of them start with the same sound
 * in both — judged from the rules' romanization, by first letter only, so a
 * line paired with a neighbouring line of the same length is dropped
 * without favouring any one spelling.  (For scripts with no rules, the
 * first check is all.)  Each native word is then paired with the romanized
 * word in the same place.  The romanizations are what listeners
 * typed, so they follow the conventions people sing from.
 *
 * Usage:  node tools/romanize-eval/build_gold.mjs <group> <out.json> "<query>" …
 *   e.g.  node tools/romanize-eval/build_gold.mjs hi tests/romanize_gold_hi.json "tum hi ho arijit"
 */
import { writeFileSync } from 'node:fs';
import { romanWords, ROMAN_SCRIPTS, romanizeCyrillicWord, romanizeGreekWord, romanizeHindiWord, romanizePunjabiWord } from '../../romanize.js';
import { sameStart } from './score.mjs';

const [group, out, ...queries] = process.argv.slice(2);
const script = ROMAN_SCRIPTS[group];
if (!script || !out || queries.length === 0) {
  console.error('usage: build_gold.mjs <group> <out.json> "<query>" …');
  process.exit(2);
}

const parseLrc = (lrc) => String(lrc || '').split('\n').flatMap((row) => {
  const stamps = [...row.matchAll(/\[(\d+):(\d+(?:\.\d+)?)\]/g)];
  const text = row.replace(/\[[^\]]*\]/g, '').trim();
  return text ? stamps.map((m) => ({ t: Number(m[1]) * 60 + Number(m[2]), text })) : [];
}).sort((a, b) => a.t - b.t);

const countOf = (text, re) => (text.match(re) || []).length;
const latinWords = (text) => text.match(/[A-Za-z]+(?:['’][A-Za-z]+)*/g) || [];

const songs = [];
for (const query of queries) {
  const resp = await fetch(`https://lrclib.net/api/search?q=${encodeURIComponent(query)}`, { headers: { 'User-Agent': 'lyrics-romanization-eval' } });
  const results = (await resp.json()).filter((r) => r.syncedLyrics);
  const scriptCount = (r) => countOf(r.syncedLyrics, new RegExp(script.source, 'gu'));
  const native = results.filter((r) => scriptCount(r) > 100 && countOf(r.syncedLyrics, /[A-Za-z]/g) < 40);
  const roman = results.filter((r) => scriptCount(r) === 0 && countOf(r.syncedLyrics, /[A-Za-z]/g) > 200);
  // The pair whose lines line up best: most lines at the same moment.
  let best = null;
  for (const n of native.slice(0, 15)) {
    for (const r of roman.slice(0, 15)) {
      if (Math.abs(n.duration - r.duration) > 3) continue;
      const a = parseLrc(n.syncedLyrics);
      const b = parseLrc(r.syncedLyrics);
      const pairs = [];
      for (const x of a) {
        const near = b.filter((y) => Math.abs(y.t - x.t) <= 0.6);
        if (near.length === 1) pairs.push([x.text, near[0].text]);
      }
      if (!best || pairs.length > best.pairs.length) best = { n, r, pairs };
    }
  }
  if (!best) { console.log(`${query}: no native + romanized pair`); continue; }

  const lines = [];
  const seen = new Set();
  for (const [nativeLine, romanLine] of best.pairs) {
    if (seen.has(nativeLine)) continue;
    const words = romanWords(nativeLine, group);
    const romans = latinWords(romanLine);
    // Every word in the native line must be in the script, so the places line up.
    const allNative = (nativeLine.match(/[\p{L}\p{M}\p{N}]+/gu) || []).length === words.length;
    if (!allNative || words.length === 0 || words.length !== romans.length) continue;
    const rule = { hi: romanizeHindiWord, pa: romanizePunjabiWord, el: romanizeGreekWord, ru: romanizeCyrillicWord }[group] || null;
    if (rule && words.filter((w, i) => sameStart(rule(w.text), romans[i])).length < 0.75 * words.length) continue;
    seen.add(nativeLine);
    lines.push({ line: nativeLine, roman: romanLine, gold: romans.map((w) => w.toLowerCase()) });
  }
  console.log(`${query}: ${best.n.trackName} (#${best.n.id}) + #${best.r.id}: ${best.pairs.length} lines paired, ${lines.length} kept, ${lines.reduce((n, l) => n + l.gold.length, 0)} words`);
  songs.push({ title: best.n.trackName, artist: best.n.artistName, native: best.n.id, romanized: best.r.id, lines });
}
writeFileSync(out, JSON.stringify({ group, built: new Date().toISOString().slice(0, 10), songs }, null, 1) + '\n');
console.log(`${songs.length} songs, ${songs.reduce((n, s) => n + s.lines.length, 0)} lines, ${songs.reduce((n, s) => n + s.lines.reduce((m, l) => m + l.gold.length, 0), 0)} words → ${out}`);
