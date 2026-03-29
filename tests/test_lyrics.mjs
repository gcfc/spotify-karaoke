/**
 * CLI test for the full lyrics fetch chain.
 * Calls the same fetchLyrics function that the browser uses — no re-implementation.
 *
 * Requires Node.js 18+ (native fetch).
 *
 * Usage:
 *   node tests/test_lyrics.mjs "APT." "ROSÉ"
 *   node tests/test_lyrics.mjs "稻香" "周杰倫"
 *   node tests/test_lyrics.mjs "Bohemian Rhapsody" "Queen" --track-id 4u7EnebtmKWzUH433cf5Qv --duration 355
 */

import { fetchLyrics } from '../lyrics.js';
import { parseArgs } from 'node:util';

const WORKER_URL = 'https://spotify-karaoke.workers.dev';

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    'track-id': { type: 'string', default: '' },
    duration:   { type: 'string', default: '' },
    help:       { type: 'boolean', short: 'h', default: false },
  },
});

if (values.help || positionals.length === 0) {
  console.log('Usage: node tests/test_lyrics.mjs <title> [artist] [--track-id ID] [--duration SEC]');
  process.exit(0);
}

const title    = positionals[0];
const artist   = positionals[1] || '';
const trackId  = values['track-id'] || null;
const duration = values.duration ? parseFloat(values.duration) * 1000 : 0;

console.log(`Track:  ${title} — ${artist || '(no artist)'}`);
if (trackId)  console.log(`ID:     ${trackId}`);
if (duration) console.log(`Length: ${duration / 1000}s`);
console.log();

const result = await fetchLyrics(WORKER_URL, trackId, title, artist, duration);

if (!result.lyrics) {
  console.log('No lyrics available from any source.');
  process.exit(1);
}

const text = Array.isArray(result.lyrics)
  ? result.lyrics.map((l) => l.words || '').join('\n')
  : result.lyrics;

console.log('='.repeat(50));
console.log(`Source: ${result.source}`);
console.log('='.repeat(50));
console.log(text);
console.log('='.repeat(50));
