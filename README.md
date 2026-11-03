# Spotify Karaoke

A static website that connects to your Spotify account and displays real-time synced lyrics for whatever you're currently playing. Hosted on GitHub Pages with an optional Cloudflare Worker proxy for the best lyrics quality.

## Features

- **Real-time karaoke display** — lyrics highlight line-by-line (or word-by-word with the Cloudflare Worker) synced to your playback
- **Spotify integration** — uses the official Spotify Web API with PKCE auth (no backend needed for auth)
- **Layered lyrics** — Spotify's internal Musixmatch-powered lyrics via the Cloudflare Worker as primary, then LRCLIB (free, open), Kugou Music, QQ Music and NetEase Cloud Music (all line-synced, strong Chinese coverage) as fallbacks. KKBOX (plain text) is deprecated — see Limitations
- **Graceful degradation** — word-synced → line-synced → plain scrollable lyrics → "no lyrics" message
- **Dark theme** with smooth animations — switches to light at sunrise and back to dark at sunset for San Mateo, CA. The location is fixed in `sun.js` (`DEFAULT_LOCATION`), so the page never asks for location permission; edit it to follow a different city. The toggle button overrides the theme until the next sunrise or sunset.
- **Translation** — for lyrics that are neither English nor Chinese, a translate toggle shows each line's translation underneath it in a smaller font. Pick the target language from the dropdown; the app falls back across an LLM, a keyless endpoint and Google Cloud on its own
- **Furigana** — for Japanese lyrics, a 字 toggle puts each kanji word's reading above it, read in context by Gemini and scored against an answer key of eight songs (see [Furigana](#furigana))
- **Responsive** — works on desktop and mobile

## Quick Start

### 1. Create a Spotify App

1. Go to [Spotify Developer Dashboard](https://developer.spotify.com/dashboard)
2. Create a new app
3. Add redirect URIs:
   - `https://<your-username>.github.io/<repo-name>/` (for production)
   - `http://localhost:8080/` (for local development)
4. Copy your **Client ID**

### 2. Configure

Edit `app.js` and replace the placeholder:

```js
const CONFIG = {
  SPOTIFY_CLIENT_ID: 'paste-your-client-id-here',
  // ...
};
```

### 3. Test Locally

```bash
cd spotify-karaoke
python3 -m http.server 8080
```

Open `http://localhost:8080/` and click "Connect to Spotify".

### 4. Deploy to GitHub Pages

Push to GitHub, then go to **Settings → Pages → Deploy from branch** (main).

## Cloudflare Worker Setup (Optional — Better Lyrics)

The Cloudflare Worker uses your Spotify `sp_dc` cookie to access Spotify's internal lyrics API, which provides:

- **Better coverage** (Spotify/Musixmatch database vs. LRCLIB crowdsourced)
- **Word-level sync** for true karaoke (individual words light up)

Without it, the site still works using LRCLIB for line-synced or plain lyrics.

### Get your sp_dc cookie

1. Open an **incognito/private** browser tab
2. Log into [open.spotify.com](https://open.spotify.com)
3. Open DevTools (F12) → Application → Cookies → `open.spotify.com`
4. Copy the value of `sp_dc`
5. **Close the tab without logging out** (keeps the cookie valid for ~1 year)

### Deploy the Worker

```bash
# Install Wrangler CLI (if not already installed)
npm install -g wrangler

# Navigate to the worker directory
cd worker

# Login to Cloudflare
wrangler login

# Set your sp_dc cookie as a secret
wrangler secret put SP_DC
# Paste your sp_dc value when prompted

# Optional: keys for the translation providers (see below)
wrangler secret put GOOGLE_TRANSLATE_API_KEY
wrangler secret put GEMINI_API_KEY        # also enables furigana
wrangler secret put OPENROUTER_API_KEY

# Deploy
wrangler deploy
```

Note your worker URL (e.g., `https://spotify-lyrics-worker.<your-subdomain>.workers.dev`), then set it in `app.js`:

```js
const CONFIG = {
  // ...
  WORKER_URL: 'https://spotify-lyrics-worker.your-subdomain.workers.dev',
};
```

## Lyrics Translation

When the lyrics are neither English nor Chinese, a translate button appears next to
the theme toggle. Toggling it on renders each line's translation directly beneath the
original in a smaller, dimmer font — for synced and plain lyrics alike. The dropdown
beside it selects the target language (English or 中文) and the provider.

**Nothing is sent to a translation service until the button is switched on.** The
language of the lyrics is worked out locally in `translate.js`: by script for Japanese,
Korean, Chinese, Cyrillic, Greek, Hebrew, Arabic, Thai and Devanagari, and for
Latin-script text by how often English function words appear. That keeps the button's
visibility a local decision rather than a request.

### Providers

The dropdown appears only while translation is toggled on, and offers just the
target language — English or 中文. Which service does the work is decided
automatically.

### The provider chain

Providers are tried in order until one answers:

```
gemini-flash-lite-latest  →  Default (keyless Google)  →  Better (Google Cloud)
```

The model goes first because it sees the whole song in one prompt, so recurring
imagery and idiom stay consistent between verses in a way per-line machine
translation cannot manage. The keyless endpoint sits second as a quick rescue —
measured at roughly half the model's latency, so a fallback is barely slower
than a success. Google Cloud is last because it is the only one that can cost
money.

Two behaviours keep a bad provider from costing time:

- **A slow provider does not block the queue.** If one has not answered within
  `HEDGE_DELAY_MS` (2.5s), the next starts alongside it and whichever answers
  first wins. Healthy requests finish well inside that, so it rarely fires.
- **A failure is remembered.** A provider that fails is benched for
  `PROVIDER_COOLDOWN_MS` (5 minutes), so every later track skips it instead of
  waiting for it to fail again. This is worth far more than racing: it turns a
  repeated penalty into a single one.

| Provider | Secret | How it is called |
|---|---|---|
| `gemini-flash-lite-latest` | `GEMINI_API_KEY` | Gemini via the Worker's `/llm-translate` route |
| **Default** | none | `translate.googleapis.com` direct from the browser — it sends `Access-Control-Allow-Origin: *`. Undocumented and unsupported, so it can change without notice |
| **Better** | `GOOGLE_TRANSLATE_API_KEY` | Google Cloud Translation v2 through the Worker's `/translate` route |

### Comparing models

The other verified models stay available, just not in the menu. Pin one from the
browser console:

```js
localStorage.setItem('translate-provider', 'gemini-3.5-flash-lite')
localStorage.removeItem('translate-provider')   // back to automatic
```

Valid ids come from `TRANSLATE_PROVIDERS` in `translate.js`: `free`, `cloud`,
`gemini-flash-lite-latest`, `gemini-3.5-flash-lite`, `gemini-3.1-flash-lite`,
`gemini-flash-latest`, `nemotron-3-super-120b`. A pinned provider does **not**
fall back, so a failure shows the originals — which is what makes it useful for
judging one model on its own. An unknown id is ignored and the chain resumes.

Each model was measured on 44 unique lines before being listed, and all returned
exactly one translation per line on repeated runs. Requests are chunked to 25
lines. This is not cosmetic: on a 44-line list one model stopped at exactly 32
translations every time, with `finish_reason: stop` and the token budget
untouched — it simply decided it was done. Raising `max_tokens` changed nothing;
keeping requests small did.

### Cost

Only **Better** can cost money: Google Cloud Translation is free for the first
500,000 characters a month, then about $20 per million. Measured across real
songs, a track costs roughly **400 characters** — blank lines are skipped,
repeated lines are sent once, and results are cached per track and target — so
the free tier covers on the order of 1,000 songs a month.

The dependable cap is a quota override in the Google Cloud console, under
**APIs & Services → Cloud Translation API → Quotas & System Limits**. Past the
limit the API errors, the chain falls back, and no charge accrues. Divide by the
longest month, not the average one: **16,129 characters/day** (`500,000 / 31`)
stays inside the free tier every month, whereas a figure derived from a 28-day
month overshoots by ~$1 in a 31-day one.

Note that a **billing budget does not cap spend** — it only sends email. The
quota override is the control that actually stops requests.

OpenRouter's free tier allows 50 requests per day per account, so
`nemotron-3-super-120b:free` stops working once that is spent and returns the
next day. The Gemini free tier is more generous but still finite.

## Furigana

For Japanese lyrics with kanji, a 字 button appears beside the translate button.
Switched on, every kanji word gets its reading above it in small kana — on synced
and plain lyrics alike, and in word-synced lyrics the readings light up with the
words. As with translation, nothing is sent until the button is switched on.
It needs `GEMINI_API_KEY` on the Worker, and stores each song's readings once
read if the Worker has a KV namespace (see [Stored readings](#stored-readings)).

### How a line is read

1. **Kanji runs are found locally** (`kanjiRuns` in `furigana.js`): kanji, plus any
   digits written against them, so 2人 is one run read ふたり. A reading covers a
   whole run, because many cannot be split per character — 今日 is きょう, 大人 is
   おとな.
2. **The model reads natural pieces.** The Worker's `/furigana` route sends each
   line for context and, for every run, the run plus up to four kana written after
   it: 全てが rather than 全. The model reads the piece in full (すべてが) and the
   Worker cuts the known kana back off (すべ). Asked for runs alone, models
   misjudged where a reading stops — すべて for the 全 of 全て — on 1 run in 23
   (`gemini-3.5-flash-lite`) or 1 in 93 (`gemini-3.1-flash-lite`).
3. **Every reading is checked.** It must be kana and end with the kana it was
   given; one that fails (一人で read as ひとりでに) costs that run its furigana,
   not the line. Replies carry each line's number, so a line the model leaves
   out costs only that line and nothing shifts onto the wrong line. The model
   never writes lyric text back, so it cannot alter the lyrics.
4. **Readings printed in the lyrics win.** Lyric databases sometimes keep the
   lyricist's ruby in brackets — 溢(こぼ)れた, 終幕(さいご)は. Those override the
   model, and with furigana on the bracket is hidden and shown as ruby instead.

### Where readings come from

`FURIGANA_CHAIN` in `furigana.js` is tried in order, and each step fills only
the words the steps before it left unread — it never overrides them:

1. **Stored readings**, if the Worker has them for this exact text.
2. **`gemini-3.1-flash-lite`**, through the Worker. A song is one request: the
   Worker splits it into chunks of 25 lines and sends them to Gemini together.
3. **`gemini-3.5-flash-lite`**, through the Worker, for words 3.1 left unread. Less
   accurate than 3.1, but like it, it reads from context.
4. **The dictionary — kuromoji, in the browser**, for words both models left
   unread. Free and needing no quota, but it reads each word the way its
   dictionary does, ignoring context (二人 as ににん, not ふたり). Its dictionary is
   about 18 MB, fetched from jsDelivr only the first time a song reaches this
   step and then cached by the browser; the script is pinned with a
   subresource-integrity hash, since it runs inside the page.

So the browser downloads the dictionary only when both models leave a word
unread; while 3.1 answers, it never does. Each request gives up after 20 seconds.
Model versions are pinned rather than `-latest` aliases:
`gemini-flash-lite-latest` moved to 3.5, which reads less accurately.

### Stored readings

The Worker keeps each song's readings in a KV namespace, keyed by a SHA-256 of the
song's distinct kanji lines, and looks there before calling any model. So a song
read once is answered at once, with no Gemini request, by everyone after. It is
keyed by text rather than track id because the same track can arrive with
different lyrics from different sources.

Only readings the Worker itself got from `gemini-3.1-flash-lite`, for every chunk
of the song, are stored. A client cannot write readings of its own, and a song
read while 3.1 was down is read again by 3.1 later, rather than kept at the
fallback's quality. Entries expire after 180 days; bump `FURIGANA_CACHE_VERSION`
to drop them all at once.

To enable it, create the namespace and bind it in `worker/wrangler.toml`. The
block is there, commented out:

```bash
cd worker
wrangler kv namespace create FURIGANA_CACHE   # prints an id
# paste the id into wrangler.toml's [[kv_namespaces]] block, uncomment it, then
wrangler deploy
```

Without the binding, `/furigana` works the same, uncached. The free KV tier
allows 1,000 writes a day — one per newly read song.

### Evaluation

`tests/furigana_gold.json` is an answer key of 746 kanji runs from 322 lines of
eight songs — 夜に駆ける, Lemon, マリーゴールド, 紅蓮華, 残酷な天使のテーゼ,
春よ、来い, 白日 and 千本桜. It holds only runs and readings, keyed by NetEase
song id and line timestamp; the evaluation fetches the lyrics live.

It was built from two independent sources: kuromoji, a dictionary-based analyzer
that ignores context, and NetEase's romanized lyrics, which follow context and
often the singer. Where they agree (267 lines) kuromoji's readings were taken;
the other 55 lines were settled by hand in `tools/furigana-eval/adjudications.json`.
Gemini played no part, so it is not graded against its own answers. Each run has
a category; `gold[0]` is the reading sung and any others are also correct (明日 sung
あす also accepts あした).

Three passes over the key, through the same page and Worker code that ships:

| | correct (any accepted) | correct (as sung) | no reading | same across passes | median per song |
|---|---|---|---|---|---|
| `gemini-3.1-flash-lite` | **99.7%** | **98.5%** | 0 | 100% | 5.0 s |
| `gemini-3.5-flash-lite` | 96.3% | 95.7% | 2.1% | 94.6% | 1.6 s |
| kuromoji (dictionary baseline) | 96.2% | 95.4% | 1.3% | — | — |

That table scores each model on its own. What a listener gets is the chain, and
that depends on whether `gemini-3.1-flash-lite` is answering. Measured on
2026-11-03:

| | correct (any accepted) | correct (as sung) | no reading | context (8) | numbers (7) | rare (13) |
|---|---|---|---|---|---|---|
| **The chain while 3.1 answers** (3 passes) | **99.7%** | **98.5%** | 0 | 100% | 100% | 92.3% |
| **The chain while 3.1 is down** — 3.5, then the dictionary | 97.7% | 97.2% | 1 | 100% | 100% | 69.2% |
| For comparison: dictionary, then 3.5 | 97.3% | 96.5% | 1 | 0% | 42.9% | 38.5% |
| For comparison: 3.5 alone | 95.7% | 95.0% | 18 | 100% | 85.7% | 69.2% |

While 3.1 answers it reads every word itself, so the chain is 3.1's accuracy
(2,232 of 2,238 runs over three passes); the median song took 1.7 s. Earlier
that day 3.1 had answered every request with 503 "high demand" for over half an
hour.

While 3.1 is down, 3.5 goes first because it reads from context. With the
dictionary first instead, 二人 came out ににん four times in one song, 側 がわ and
降り止む おり: the context, number and rare columns above. 3.5's own weakness is
whole lines left unread, and that is what the dictionary covers — here it filled
the 11 words 3.5 left, which took 3.5 alone from 95.7% to 97.7%. The dictionary
row's 100% on ordinary words is flattered by how the key was built, so the
comparison that matters is the hard columns.

By category (correct, any accepted reading):

| | dictionary (703) | context (8) | numbers (7) | rare (13) | sung (7) | printed (8) |
|---|---|---|---|---|---|---|
| `gemini-3.1-flash-lite` | 99.9% | 100% | 100% | 92.3% | 100% | 100% |
| `gemini-3.5-flash-lite` | 96.5% | 100% | 100% | 76.9% | 100% | 100% |
| kuromoji | 100%* | 0% | 0% | 0% | 100% | 100% |

\* By construction: dictionary runs are mostly where kuromoji agreed with the
romanization, and the hard categories mostly where it did not. The baseline is a
floor for the hard cases, not an estimate of kuromoji's real accuracy.

`gemini-3.1-flash-lite` made the same two mistakes on every pass: 鳴き声 read
こえ for ごえ (the sound change spans two runs) and 真っ新 read しん for さら.
Context cases a dictionary gets wrong — 降り止む as ふり, 側 as そば, 二人 and 2人 as
ふたり, 如何しようも as どう — it got right every time.

What the evaluation changed along the way:

- **Pieces instead of bare runs** took `gemini-3.1-flash-lite` from 97.9% to 99.2%.
- **Numbered replies.** With a plain list, `gemini-3.5-flash-lite` dropped a line
  from some 25-line chunks and lost the whole chunk. `{line, readings}` objects
  fixed that but doubled the output, pushing `gemini-3.1-flash-lite` past the
  timeout (95.9%). Putting the number first in the same list fixed both: 3.1 to
  99.7%, 3.5 from 89% to 96%.
- **The key's own errors**, found while checking misses: 預ける had kuromoji's old
  spelling あづ; 誘う as いざなう and 皆 as みんな are real readings the singer did not
  use, so they now count as correct but not as sung.

Caveats:

- The hard categories are small — one run moves a column by 8–14 points.
- NetEase does not say who writes its romanizations, so agreement is strong
  evidence rather than proof. Seven adjudicated lines are noted "confirm by ear",
  and `build_gold.mjs` lists agreed runs that lyrics often read specially (紅蓮華's
  理由 as りゆう, for one) for a listen.
- A reading the lyricist assigned but the lyrics do not print — 運命 sung さだめ
  with no bracket — cannot be known from the text. None occurs in the key, so the
  score says nothing about them.
- `gemini-flash-latest` was not measured: during the evaluation it did not answer
  even a one-line request within 60 seconds, so it is not allowed.

### Running the evaluation

```bash
GEMINI_API_KEY=… node tests/eval_furigana_live.mjs --runs 3       # the chain, as the app runs it
GEMINI_API_KEY=… node tests/eval_furigana_live.mjs --models gemini-3.1-flash-lite --runs 3 --verbose   # one model alone
GEMINI_API_KEY=… node tests/eval_furigana_live.mjs --models 'gemini-3.5-flash-lite>dictionary'        # the chain while 3.1 is down
node tests/eval_furigana_live.mjs --worker https://….workers.dev    # a deployed Worker instead
```

The dictionary step needs `npm install` in `tools/furigana-eval` (it runs kuromoji
in Node). The report breaks results down by the step each reading came from.
`--cache` gives the in-process Worker an in-memory store, so later passes are
answered from stored readings, as a deployed Worker with KV would.
`--songs Lemon,白日` limits the songs, `--json out.json` saves the full report,
and `--min-accuracy 0.98` exits non-zero below that share. `--verbose` and
`--json` include the lines a model got wrong, so keep their output local.
`node tests/test_furigana.mjs` covers the same code offline.

### Adding songs to the key

```bash
cd tools/furigana-eval && npm install
# add { title, artist, netease } to SONGS in build_gold.mjs, then:
node build_gold.mjs --pending      # prints the lines where the sources disagree
```

Settle each printed line in `adjudications.json` as one entry per run —
`"reading"`, `"reading|alternative"`, with `:category` when it differs from
kuromoji (`"ふたり:number"`, `"あす|あした:sung"`), or `{ "skip": "why" }` — and
run `node build_gold.mjs` again to write the key.

## Now-Playing Sources

The page reads what is playing through a **source** (`sources.js`). A source
answers one question — what is playing right now? — and returns the same shape
whatever service it talked to:

```js
{ trackId, title, artist, durationMs, progressMs, isPlaying, artworkUrl }
```

Everything downstream — the lyrics chain, the karaoke animation loop, the
progress bar — consumes that shape and neither knows nor cares which source
produced it.

| Source | `?source=` | Position | Seek | Artwork |
|---|---|---|---|---|
| Spotify Web API | `spotify` (default) | precise, once a second | yes | yes |
| Tesla Fleet API | `tesla` | coarse | no | no |

Pick one with `?source=tesla`; the choice is remembered in `localStorage`. A
source that cannot seek hides the touch-control toggle rather than offering a
control that does nothing, and one with no artwork hides the album art — the
stored preference itself is left alone, so switching back to Spotify restores it.

### Why Spotify already works in a Tesla

The car's built-in Spotify is a Spotify Connect device, so
`/v1/me/player/currently-playing` reports it like any other device, with a real
`progress_ms`. The Spotify source needs **no Tesla API at all** and costs
nothing to run. The Tesla source exists for everything else the car can play —
Apple Music, Tidal, USB, Bluetooth, radio — which Spotify cannot see.

### Position estimation

Sources report position at very different cadences, and some cannot report it
at all, so `PositionEstimator` normalises them into the one anchor the
animation loop extrapolates from:

- **`precise`** (Spotify) — re-anchors on every poll. The loop's LERP absorbs
  the poll-to-poll jitter, exactly as before.
- **`coarse`** (Tesla) — only corrects past `SNAP_THRESHOLD_MS` (1.5s), so a
  low-cadence read does not jerk the highlight back and forth. Tesla's
  `MediaNowPlayingElapsed` arrives about twice a second over streaming
  telemetry, but Tesla documents the now-playing fields as sometimes empty
  depending on the media source, so an absent elapsed degrades to no position
  rather than becoming a `0` that would yank the lyrics back to line one.
- **`none`** — free-runs from the track change, freezing on pause and resuming
  where it froze. Enough for line-synced lyrics with the manual offset.

### Tesla source status

The adapter and its response mapping are complete and tested, but **auth is not
wired**. Fleet API authentication is a server-side flow — partner token, a
registered public key on your domain, per-vehicle pairing — that does not belong
in a static page, so `createTeslaFleetSource` takes an injected
`fetchVehicleData` and the app points it at a `/tesla-media` Worker route that
does not exist yet. Until it does, the Tesla source reports silence instead of
throwing on every poll.

Note the poll interval. Fleet API is billed per request: polling `vehicle_data`
once a minute runs about **$0.12 per vehicle-hour**, while streaming telemetry
is roughly eighteen times cheaper and is where this should end up. The default
15s poll is a deliberate fallback — the estimator is what keeps the lyrics
moving between reads.

## How It Works

1. **Auth**: Spotify PKCE flow (browser-only, no client secret needed)
2. **Polling**: The active source is polled on its own cadence (Spotify: 1s)
   for the currently playing track
3. **Lyrics**: On track change, tries Spotify via the Worker first — skipped
   unless the track id is a real Spotify id, since that route resolves against
   Spotify's own catalogue. On a miss it queries LRCLIB, Kugou Music, QQ Music
   and NetEase Cloud Music in parallel and takes the best result:

   ```
   Spotify word-synced > Spotify line-synced > LRCLIB synced >
   Kugou Music synced > QQ Music synced > NetEase synced >
   LRCLIB plain
   ```

   It returns as soon as the winner is known — the moment a source has lyrics
   and every source ranked above it has answered — rather than waiting for the
   slowest. On a 27-song benchmark that cut typical loading from 3.4s to about
   0.7s. Synced always beats plain, so plain lyrics are used only once every
   synced source has missed.
   Kugou outranks QQ because both are Tencent Music, Kugou found every song QQ
   did, and it answered about three times faster.
4. **Display**: `requestAnimationFrame` loop interpolates playback position between polls and highlights the current line/word

## Limitations

- **Spotify Dev Mode (Feb 2026)**: Requires Spotify Premium for the app owner, max 5 authorized users. Fine for personal use.
- **sp_dc cookie**: Unofficial, lasts ~1 year. If it expires, the Worker will return errors and the site falls back to LRCLIB automatically.
- **LRCLIB coverage**: Not all songs have synced lyrics in LRCLIB's crowdsourced database.
- **KKBOX is deprecated**: its code is commented out in `lyrics.js` and `worker.js` (and `/kkbox-lyrics` now 404s), because every lookup spent five or more searches from both the Worker and the browser on a source that could no longer return lyrics. `python tests/test_kkbox.py "稻香" "周杰倫"` checks whether KKBOX has dropped the block; if it prints lyrics again, the code can be restored. The cause: the lyrics live in each song page's JSON-LD, and the song pages sit behind an AWS WAF challenge on CloudFront. A request without an `aws-waf-token` cookie — which only a browser that has run KKBOX's challenge script holds — gets HTTP 202 with `x-amzn-waf-action: challenge` and a challenge page instead. Neither the Worker nor the page's cross-origin `fetch()` can carry that token, and a full set of browser headers makes no difference. The search API is not behind the challenge, so searches still succeed and only the page fetch fails. KKBOX's official Open API has no lyrics endpoint.
- **QQ Music access**: Must be fetched through the Worker — the endpoints send no CORS headers, and the lyric API rejects requests without a `y.qq.com` referer, which a browser cannot set cross-origin. Its search endpoint also refuses datacenter traffic for stretches (HTTP 500 for every query, while the lyric endpoint keeps answering), seen on 2026-10-31 from both a test machine and the deployed Worker.
- **Kugou Music access**: Also Worker-only, because Kugou's search and lyric endpoints answer only over plain HTTP, which an HTTPS page may not call.
- **Transient failures**: Kugou and NetEase occasionally fail one request and answer the next, so the Worker retries a request once, after 500ms, on a network error, a 5xx or a body that isn't JSON. A 4xx is treated as an answer. QQ is not retried: its failures so far have been blocks lasting minutes or hours, which a retry only prolongs.
- **NetEase Cloud Music access**: Worker-only too — its endpoints send no CORS headers. NetEase lacks the licence for some catalogues (Jay Chou, BTS) and answers those searches with other singers' covers, so it sits last among the synced sources.
- **Matching for QQ, Kugou and NetEase**: all three list remixes, live cuts and covers under the same title (QQ has 起风了 at six lengths), so the Worker also checks length and artist. A recording more than 5 seconds off the Spotify length is rejected rather than shown with the wrong timing. A cover is rejected when its artist is recognisably someone else, when its title says so (原唱, 翻唱, Cover…), or when another cut of the song on the same page is credited to the artist under Spotify's name. A romanized artist ("Hebe Tien") can't be compared with a native name (田馥甄), so a cover by a Chinese-named singer with no such marker can still get through.
- **kugeci.com is not used directly**: it serves the same kind of LRC, but every page sits behind a Cloudflare managed challenge ("Just a moment…") that needs JavaScript and a cookie, so neither the Worker nor the page can fetch it. Kugou's API is the direct route to equivalent data.
- **Kuwo and Migu are not used**: on a 20-song benchmark Kuwo's search found synced lyrics for 1 song. Migu's search reports no track lengths, so it can't tell a song from its remixes, and it showed it — its Blinding Lights was timed about 14 seconds away from the three other sources that had the song.
- **Polling latency**: Lyrics sync is approximate — the animation loop interpolates between polls, so accuracy tracks the active source's cadence rather than matching playback exactly.
- **Tesla source auth is not wired**: the adapter is complete and tested, but it needs a server-side Fleet API route before it returns anything. See *Tesla source status* above.

## File Structure

```
spotify-karaoke/
├── index.html          # Page shell
├── style.css           # Dark karaoke theme
├── app.js              # All client-side logic
├── sources.js          # Now-playing sources + position estimator (no DOM deps)
├── lyrics.js           # Lyrics fetch chain (no DOM dependencies)
├── matching.js         # Script-insensitive search matching (see below)
├── translate.js        # Language detection + translation providers
├── furigana.js         # Kanji runs, the reading chain, prompt, reply checks, layout
├── sun.js              # Sunrise/sunset times for the automatic light/dark theme
├── tools/
│   ├── gen_zh_table.py # Regenerates matching.js's Traditional→Simplified table
│   └── furigana-eval/  # Builds tests/furigana_gold.json (has its own npm deps)
├── tests/              # Node and Python tests — `node tests/test_matching.mjs`,
│                       # `node tests/test_source_priority.mjs`,
│                       # `node tests/test_sources.mjs`,
│                       # `node tests/test_kugou.mjs`,
│                       # `node tests/test_netease.mjs`,
│                       # `node tests/test_qq.mjs`,
│                       # `node tests/test_translate.mjs`,
│                       # `node tests/test_furigana.mjs`;
│                       # live: `node tests/test_cn_lyrics_live.mjs`,
│                       # `GEMINI_API_KEY=… node tests/eval_furigana_live.mjs`
├── worker/
│   ├── worker.js       # Cloudflare Worker (lyrics proxy)
│   └── wrangler.toml   # Worker config
└── README.md
```

`worker.js` imports `../matching.js`; Wrangler bundles it into the deployed
Worker, so no extra build step is needed.

### Simplified vs. Traditional Chinese

Spotify reports a track title in whatever script the release used — very often
Simplified — while KKBOX stores its catalogue in Traditional. `matching.js`
folds Traditional to Simplified before comparing titles and artists, so
Spotify's `在松手跟不松手之间` matches KKBOX's `在鬆手跟不鬆手之間`. The folding
table is generated from OpenCC and inlined, because it has to run in the
browser, in the Worker (which cannot import from a CDN at runtime) and in the
Node tests. Regenerate it with:

```bash
pip install opencc
python tools/gen_zh_table.py --check   # verify matching.js is current
python tools/gen_zh_table.py           # print fresh constants to paste in
```

This matters for correctness as well as coverage: KKBOX's search endpoint
answers *every* query with a full page of ~20 songs, even nonsense ones, so the
top hit is not evidence of a match. Results are now scored against the
requested title and artist, and a page with no plausible match is rejected
rather than scraped. KKBOX itself is now deprecated, but QQ, Kugou and NetEase
searches go through the same matcher.
