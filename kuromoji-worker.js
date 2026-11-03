// ============================================================
//  kuromoji off the main thread — the dictionary step of the furigana
//  chain (see FURIGANA_CHAIN in furigana.js and readWithKuromoji in
//  app.js).
//
//  Loading kuromoji means downloading ~18 MB of dictionary and decompressing
//  and indexing it, which on the page's own thread froze it for over a
//  second at a time, stopping the lyrics mid-scroll.  Here it runs beside
//  the page instead.  The page sends `{id, lines}`; this answers
//  `{id, tokens}` — each line's tokens as `{surface_form, reading}`, which
//  the page turns into readings with dictionaryReadings() — or `{id, error}`.
// ============================================================

const KUROMOJI_SCRIPT = 'https://cdn.jsdelivr.net/npm/kuromoji@0.1.2/build/kuromoji.js';
// The script runs with this worker's access, so it is pinned to its exact
// bytes: fetch() rejects a response that does not match.
const KUROMOJI_INTEGRITY = 'sha384-LCHxvFGxgpk9Bl+0+OaV6Rf24HQamJPrNHIo6VGkXkVgGWRvl68eqUwCW5PWqfwh';
const KUROMOJI_DICT = 'https://cdn.jsdelivr.net/npm/kuromoji@0.1.2/dict/';

let tokenizer = null;   // a promise, once loading has started

function loadTokenizer() {
  tokenizer ||= (async () => {
    const resp = await fetch(KUROMOJI_SCRIPT, { integrity: KUROMOJI_INTEGRITY });
    if (!resp.ok) throw new Error(`kuromoji script HTTP ${resp.status}`);
    const url = URL.createObjectURL(new Blob([await resp.text()], { type: 'text/javascript' }));
    try {
      importScripts(url);
    } finally {
      URL.revokeObjectURL(url);
    }
    return new Promise((resolve, reject) => {
      self.kuromoji.builder({ dicPath: KUROMOJI_DICT }).build((err, t) => (err ? reject(err) : resolve(t)));
    });
  })();
  // A failed load is forgotten, so a later song can try again.
  tokenizer.catch(() => { tokenizer = null; });
  return tokenizer;
}

self.onmessage = async ({ data }) => {
  const { id, lines } = data || {};
  try {
    const t = await loadTokenizer();
    const tokens = lines.map((line) => t.tokenize(line)
      .map(({ surface_form: surface, reading }) => ({ surface_form: surface, reading })));
    self.postMessage({ id, tokens });
  } catch (err) {
    self.postMessage({ id, error: String(err?.message || err) });
  }
};
