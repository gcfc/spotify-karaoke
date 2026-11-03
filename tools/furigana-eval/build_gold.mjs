/**
 * Builds tests/furigana_gold.json, the answer key the furigana evaluation
 * (tests/eval_furigana_live.mjs) scores models against.
 *
 * Two independent sources are compared for every line with kanji:
 *
 *   - kuromoji, a dictionary-based analyzer, which reads each word the way
 *     its dictionary does, without looking at context;
 *   - NetEase's romanized lyrics (`romalrc`), timestamp-aligned with the
 *     lyrics.  NetEase does not say who or what writes them, but they get
 *     right what a dictionary cannot — 二人 as ふたり, 側 as そば, 明日 sung
 *     as あす — so they at least follow context, and often the singer.
 *
 * Where the two agree (after folding away spelling differences such as wo/o
 * and long vowels), kuromoji's readings are taken as the answer.  Where they
 * do not, the line is printed for a person to settle, and the decision is
 * recorded in adjudications.json.  Gemini plays no part in building the key,
 * so it is never graded against its own answers.
 *
 * Agreement is strong evidence for ordinary words but not proof: if the
 * romanization were itself dictionary-made, both would miss a reading the
 * lyricist assigned.  The build lists runs that lyrics often read specially
 * (WATCH_LIST) so a person can check those by ear.
 *
 * The key holds only kanji runs and their readings, keyed by NetEase song id
 * and line timestamp — never the lyric lines — and the evaluation fetches
 * the lyrics live, as the other live tests do.
 *
 * Usage (from this directory, after `npm install`):
 *   node build_gold.mjs              rebuild the key; lists lines still to settle
 *   node build_gold.mjs --survey     agreement statistics only, nothing written
 *   node build_gold.mjs --pending    print every line still to settle, in full
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import kuromoji from 'kuromoji';
import { toRomaji } from 'wanakana';
import { dictionaryReadings, kanjiRuns, hasKanji } from '../../furigana.js';

const DIR = path.dirname(fileURLToPath(import.meta.url));
const GOLD_PATH = path.join(DIR, '../../tests/furigana_gold.json');
const ADJUDICATIONS_PATH = path.join(DIR, 'adjudications.json');
const CACHE_DIR = path.join(DIR, '.cache');

const SURVEY = process.argv.includes('--survey');
const PENDING = process.argv.includes('--pending');

/**
 * Chosen to cover what makes readings hard: context-dependent words, numbers
 * and counters, rare kanji, readings the singer chooses between, older
 * literary Japanese, and readings the lyricist assigns.
 */
export const SONGS = [
  { title: '夜に駆ける', artist: 'YOASOBI', netease: 1409311773 },
  { title: 'Lemon', artist: '米津玄師', netease: 536622304 },
  { title: 'マリーゴールド', artist: 'あいみょん', netease: 1293904824 },
  { title: '紅蓮華', artist: 'LiSA', netease: 1360592706 },
  { title: '残酷な天使のテーゼ', artist: '高橋洋子', netease: 657666 },
  { title: '春よ、来い', artist: '松任谷由実', netease: 27566649 },
  { title: '白日', artist: 'King Gnu', netease: 1347630432 },
  { title: '千本桜', artist: '黒うさP feat. 初音ミク', netease: 22677433 },
];

// ── Fetching ──

async function fetchSong(id) {
  const cached = path.join(CACHE_DIR, `${id}.json`);
  if (fs.existsSync(cached)) return JSON.parse(fs.readFileSync(cached, 'utf8'));
  const resp = await fetch(`https://music.163.com/api/song/lyric?id=${id}&lv=1&tv=-1&rv=-1`, {
    headers: { 'User-Agent': 'Mozilla/5.0', Accept: 'application/json' },
  });
  if (!resp.ok) throw new Error(`NetEase HTTP ${resp.status} for ${id}`);
  const data = await resp.json();
  fs.mkdirSync(CACHE_DIR, { recursive: true });
  fs.writeFileSync(cached, JSON.stringify(data));
  return data;
}

/** `[mm:ss.xx]text` lines, keyed by a two-decimal timestamp so the lyric
 *  and its romanization line up even when one writes three decimals. */
export function parseTimedLines(lrc) {
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

// ── kuromoji readings, per kanji run ──

const kataToHira = (s) => s.replace(/[ァ-ヶ]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0x60));

/**
 * kuromoji's reading of each kanji run in a line (null where it has none) —
 * read by the same dictionaryReadings() the app falls back on, so the
 * baseline in the key is exactly what the app's dictionary step would show —
 * and the whole line as kana for comparing with the romanization.  Particles
 * are written as sung: は as わ, へ as え, を as お.
 */
function kuromojiLine(tokenizer, line) {
  const tokens = tokenizer.tokenize(line);
  const kana = tokens.map((t) => {
    if (t.pos === '助詞' && t.surface_form === 'は') return 'わ';
    if (t.pos === '助詞' && t.surface_form === 'へ') return 'え';
    if (t.pos === '助詞' && t.surface_form === 'を') return 'お';
    return t.reading && t.reading !== '*' ? kataToHira(t.reading) : t.surface_form;
  });
  const readings = dictionaryReadings(tokens, line);
  const runs = kanjiRuns(line).map((run, i) => ({ text: run.text, kuromoji: readings[i] }));
  return { runs, romaji: toRomaji(kana.join('')) };
}

// ── Comparing with the romanization ──

/** Fold romanization styles together so only differences of reading remain. */
export function foldRomaji(s) {
  return s.toLowerCase()
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z]/g, '')
    .replace(/wo/g, 'o')
    .replace(/tu/g, 'tsu').replace(/si/g, 'shi').replace(/ti/g, 'chi').replace(/hu/g, 'fu')
    .replace(/zi/g, 'ji').replace(/sy([aou])/g, 'sh$1').replace(/ty([aou])/g, 'ch$1')
    .replace(/zy([aou])/g, 'j$1').replace(/jy([aou])/g, 'j$1')
    .replace(/m(?=[bp])/g, 'n')
    .replace(/ou/g, 'o').replace(/oo/g, 'o').replace(/uu/g, 'u').replace(/aa/g, 'a')
    .replace(/ii/g, 'i').replace(/ee/g, 'e').replace(/ei/g, 'e')
    .replace(/(.)\1/g, '$1');
}

// ── Adjudications ──

export const CATEGORIES = {
  dictionary: 'the reading a dictionary gives the word out of context',
  context: 'a word whose reading depends on the words around it',
  number: 'numbers and counters (2人, 一日)',
  rare: 'uncommon kanji or words a dictionary analyzer does not know',
  sung: 'more than one reading is correct; the singer chose one',
  gikun: 'a reading the lyricist assigned, not one any dictionary gives',
  printed: 'a reading written into the lyrics themselves, as in 溢(こぼ)れた',
};

// Words lyricists often give readings of their own (運命 as さだめ, 宇宙 as
// そら, 本気 as マジ …).  Runs in the key that contain one are listed after
// a build: a dictionary reading there is the likeliest kind of wrong answer
// to slip through when both sources agree.
const WATCH_LIST = ['運命', '宇宙', '永遠', '未来', '本気', '地球', '瞬間', '理由', '世界',
  '時代', '季節', '故郷', '現在', '真実', '本当', '奇跡', '約束', '明日', '今日', '心', '夢', '人生',
  '強敵', '仲間', '記憶', '場所', '一瞬', '刹那', '本物'];

/**
 * One adjudicated run, written compactly as `reading[|alternative…][:category]`.
 * The first reading is the one sung; the rest are also correct.  A run
 * whose reading matches kuromoji needs no category.
 */
function expandRun(spec, run) {
  const [readings, cat] = spec.split(':');
  const gold = readings.split('|');
  const category = cat || (gold[0] === run.kuromoji ? 'dictionary' : null);
  if (!category) throw new Error(`run ${run.text}: ${spec} differs from kuromoji (${run.kuromoji}) and needs a category`);
  if (!CATEGORIES[category]) throw new Error(`run ${run.text}: unknown category ${category}`);
  return { text: run.text, gold, cat: category, kuromoji: run.kuromoji };
}

// ── Main ──

const tokenizer = await new Promise((resolve, reject) => {
  kuromoji.builder({ dicPath: path.join(DIR, 'node_modules/kuromoji/dict') })
    .build((err, t) => (err ? reject(err) : resolve(t)));
});

const adjudications = fs.existsSync(ADJUDICATIONS_PATH)
  ? JSON.parse(fs.readFileSync(ADJUDICATIONS_PATH, 'utf8'))
  : {};
const usedAdjudications = new Set();

const gold = {
  about: 'Answer key for tests/eval_furigana_live.mjs. Built by tools/furigana-eval/build_gold.mjs; '
    + 'edit adjudications.json there, not this file. Holds kanji runs and readings only — the lyrics '
    + 'are fetched live from NetEase by song id and line timestamp. gold[0] is the reading sung; '
    + 'any other entries are also correct. kuromoji is the dictionary baseline\'s reading (null: none).',
  categories: CATEGORIES,
  songs: [],
};

let totalLines = 0;
let totalAgree = 0;
let totalPending = 0;

for (const song of SONGS) {
  const data = await fetchSong(song.netease);
  const lyric = parseTimedLines(data?.lrc?.lyric);
  const roma = new Map(parseTimedLines(data?.romalrc?.lyric).map((l) => [l.t, l.text]));

  const seen = new Set();
  const lines = [];
  let agree = 0;
  const pending = [];

  for (const { t, text } of lyric) {
    if (!hasKanji(text) || seen.has(text) || !roma.get(t)) continue;
    seen.add(text);

    const k = kuromojiLine(tokenizer, text);
    const key = `${song.netease}@${t}`;
    const adjudication = adjudications[key];

    if (adjudication) {
      usedAdjudications.add(key);
      if (adjudication.skip) continue;
      if (adjudication.runs.length !== k.runs.length) {
        throw new Error(`${key}: ${adjudication.runs.length} adjudicated runs for ${k.runs.length} in the line`);
      }
      lines.push({
        t,
        src: 'adjudicated',
        ...(adjudication.note ? { note: adjudication.note } : {}),
        runs: adjudication.runs.map((spec, i) => expandRun(spec, k.runs[i])),
      });
      continue;
    }

    const agrees = k.runs.every((r) => r.kuromoji) && foldRomaji(k.romaji) === foldRomaji(roma.get(t));
    if (agrees) {
      agree++;
      lines.push({ t, src: 'agree', runs: k.runs.map((r) => ({ text: r.text, gold: [r.kuromoji], cat: 'dictionary', kuromoji: r.kuromoji })) });
    } else {
      pending.push({ key, text, runs: k.runs, kuroRomaji: foldRomaji(k.romaji), romaji: roma.get(t) });
    }
  }

  const considered = agree + pending.length + lines.filter((l) => l.src === 'adjudicated').length;
  totalLines += considered;
  totalAgree += agree;
  totalPending += pending.length;
  console.log(`${song.title} (${song.artist}) — ${considered} unique kanji lines with romaji: `
    + `${agree} agree, ${lines.length - agree} adjudicated, ${pending.length} to settle`);

  if (PENDING) {
    for (const p of pending) {
      console.log(`  "${p.key}": ${p.text}`);
      console.log(`      kuromoji: ${p.runs.map((r) => `${r.text}=${r.kuromoji ?? '?'}`).join('  ')}`);
      console.log(`      kuro→ ${p.kuroRomaji}`);
      console.log(`      roma→ ${foldRomaji(p.romaji)}   (${p.romaji})`);
    }
  }

  gold.songs.push({ title: song.title, artist: song.artist, netease: song.netease, lines });
}

console.log(`\nAll songs: ${totalAgree}/${totalLines} lines agree outright; ${totalPending} still to settle.`);

const stale = Object.keys(adjudications).filter((k) => !usedAdjudications.has(k));
if (stale.length) console.log(`Adjudications that matched no line (lyrics changed?): ${stale.join(', ')}`);

if (!SURVEY) {
  fs.writeFileSync(GOLD_PATH, `${JSON.stringify(gold, null, 1)}\n`);
  const runs = gold.songs.flatMap((s) => s.lines.flatMap((l) => l.runs));
  console.log(`Wrote ${path.relative(process.cwd(), GOLD_PATH)}: ${gold.songs.reduce((n, s) => n + s.lines.length, 0)} lines, ${runs.length} runs.`);
  if (totalPending) console.log('Lines still to settle are left out of the key. Run with --pending to see them.');

  const byCat = {};
  for (const r of runs) byCat[r.cat] = (byCat[r.cat] || 0) + 1;
  console.log(`Runs by category: ${Object.entries(byCat).map(([c, n]) => `${c} ${n}`).join(', ')}`);

  console.log('\nTo check by ear — agreed runs containing words lyrics often read specially:');
  for (const song of gold.songs) {
    for (const line of song.lines) {
      if (line.src !== 'agree') continue;
      for (const r of line.runs) {
        if (WATCH_LIST.some((w) => r.text.includes(w))) console.log(`  ${song.title} ${line.t}  ${r.text} = ${r.gold[0]}`);
      }
    }
  }
  console.log('\nAdjudicated runs whose sources disagreed (notes):');
  for (const song of gold.songs) {
    for (const line of song.lines) {
      if (line.note && /confirm by ear/.test(line.note)) console.log(`  ${song.title} ${line.t}  ${line.note}`);
    }
  }
}
