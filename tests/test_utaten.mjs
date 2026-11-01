/**
 * Unit tests for the Worker's /utaten-lyrics route, with UtaTen's search and
 * song pages stubbed by fixtures shaped like the real markup, so parsing and
 * matching are checked deterministically and offline.  The fixture lyrics are
 * invented — no real song's lyrics are stored here.
 *
 * Usage:  node tests/test_utaten.mjs
 */

import worker from '../worker/worker.js';

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

const ENABLED = { UTATEN_ENABLED: 'true' };

// One search-result row, as UtaTen lays it out.
const row = (path, title, artist) => `
      <tr>
    <td>
      <p class="searchResult__title">
                        <a href="${path}">
          ${title}        </a>
              </p>
    </td>
    <td class="searchResult__artist">
      <p>
                  <a href="/artist/1/">
                  ${artist}        </a>
      </p>
    </td>
  </tr>`;

const searchPage = (rows) => `<table class="searchResult artistLyricList">
  <tr>
    <th class="searchResult__head">楽曲・タイトル</th>
    <th class="searchResult__artist">アーティスト</th>
  </tr>${rows.join('')}
</table>`;

const ruby = (kanji, reading) => `<span class="ruby"><span class="rb">${kanji}</span><span class="rt">${reading}</span></span>`;

// Invented lyrics: two lines, a verse break, one more line.  Source newlines
// follow every <br />, as on the real pages.
const SONG_PAGE = `<div style="margin-top: 0px" class="lyricBody " oncontextmenu="return false" onselectstart="return false">
<div class="medium">
<div class="hiragana" >
      ${ruby('青', 'あお')}い${ruby('空', 'そら')}を<br />
見上げて &amp; 歩く<br />
<br />
${ruby('二番', 'にばん')}の　歌<br />
</div>
<div class="romaji" style="display:none">aoi sora wo<br /></div>
</div>
</div>`;

// Search answers, keyed by "title|artist_name".
const SEARCH = {
  "テストの歌|B'z": [row('/lyric/ja00000001/', 'テストの歌', 'B&#039;z')],
  // Romanized artist: nothing under it, but the title alone finds the
  // Japanese-named original.
  'ローマ字の歌|Romaji Singer': [],
  'ローマ字の歌|': [row('/lyric/ja00000002/', 'ローマ字の歌', '日本の歌手')],
  // The title alone only finds someone else's version.
  'カバーの歌|Real Artist': [],
  'カバーの歌|': [row('/lyric/ja00000003/', 'カバーの歌', 'Other Artist')],
  'ページ無し|ZARD': [row('/lyric/ja00000009/', 'ページ無し', 'ZARD')],
};

const PAGES = {
  '/lyric/ja00000001/': SONG_PAGE,
  '/lyric/ja00000002/': SONG_PAGE,
  '/lyric/ja00000009/': '<html><body>ページが見つかりません</body></html>',
};

let requests = [];

globalThis.fetch = async (input, init) => {
  const url = new URL(String(input));
  requests.push({ url, headers: init?.headers || {} });
  if (url.hostname !== 'utaten.com') return new Response('unexpected', { status: 500 });

  if (url.pathname === '/search') {
    // The real search answers non-site requests with an empty page.
    if (init?.headers?.Referer !== 'https://utaten.com/') return new Response('', { status: 200 });
    const key = `${url.searchParams.get('title')}|${url.searchParams.get('artist_name')}`;
    return new Response(searchPage(SEARCH[key] || []), { status: 200 });
  }
  const page = PAGES[url.pathname];
  return page ? new Response(page, { status: 200 }) : new Response('not found', { status: 404 });
};

async function utaten(params, env = ENABLED) {
  requests = [];
  const resp = await worker.fetch(new Request(`https://worker.test/utaten-lyrics?${new URLSearchParams(params)}`), env);
  return { status: resp.status, body: await resp.json() };
}

console.log('\n── Opt-in ──');

let r = await utaten({ title: 'テストの歌', artist: "B'z" }, {});
assert(r.status === 404 && /UTATEN_ENABLED/.test(r.body.error) && requests.length === 0,
  'off unless UTATEN_ENABLED is "true" — and nothing is sent to UtaTen');

r = await utaten({ title: 'テストの歌', artist: "B'z" }, { UTATEN_ENABLED: 'yes' });
assert(r.status === 404, 'only the exact value "true" opts in');

console.log('\n── Search and parsing ──');

r = await utaten({ title: 'テストの歌', artist: "B'z" });
assert(r.status === 200 && r.body.matchedArtist === "B'z",
  'finds the song by title and artist, decoding B&#039;z');
assert(requests.every((q) => q.headers.Referer === 'https://utaten.com/'),
  'every request carries the site Referer the search needs');
assert(r.body.plainLyrics === '青い空を\n見上げて & 歩く\n\n二番の 歌',
  'readings in <span class="rt"> are dropped, entities decoded, a <br /> per line and one blank line per verse break');

console.log('\n── Romanized artists ──');

r = await utaten({ title: 'ローマ字の歌', artist: 'Romaji Singer' });
assert(r.status === 200 && r.body.matchedArtist === '日本の歌手',
  'with nothing under the romanized artist, the title alone finds the Japanese-named original');

r = await utaten({ title: 'カバーの歌', artist: 'Real Artist' });
assert(r.status === 404 && /No matching/.test(r.body.error),
  '…but not someone else\'s version whose name can be compared and differs');

console.log('\n── Failure modes ──');

r = await utaten({ title: '存在しない歌', artist: 'Nobody' });
assert(r.status === 404 && /No matching/.test(r.body.error), 'no search results → 404');

r = await utaten({ title: 'ページ無し', artist: 'ZARD' });
assert(r.status === 404 && /Lyrics not found/.test(r.body.error), 'a page without the lyrics block → 404');

r = await utaten({ artist: 'ZARD' });
assert(r.status === 400, 'missing title → 400');

// ── Summary ──

console.log(`\n${'─'.repeat(40)}`);
console.log(`Results: ${passed} passed, ${failed} failed, ${passed + failed} total`);

if (failed > 0) {
  process.exit(1);
}
