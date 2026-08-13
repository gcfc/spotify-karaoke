# Spotify Karaoke

A static website that connects to your Spotify account and displays real-time synced lyrics for whatever you're currently playing. Hosted on GitHub Pages with an optional Cloudflare Worker proxy for the best lyrics quality.

## Features

- **Real-time karaoke display** — lyrics highlight line-by-line (or word-by-word with the Cloudflare Worker) synced to your playback
- **Spotify integration** — uses the official Spotify Web API with PKCE auth (no backend needed for auth)
- **Layered lyrics** — Spotify's internal Musixmatch-powered lyrics via the Cloudflare Worker as primary, then LRCLIB (free, open), QQ Music (line-synced, strong Chinese coverage) and KKBOX (plain text) as fallbacks
- **Graceful degradation** — word-synced → line-synced → plain scrollable lyrics → "no lyrics" message
- **Dark theme** with smooth animations — switches to light at sunrise and back to dark at sunset for San Mateo, CA. The location is fixed in `sun.js` (`DEFAULT_LOCATION`), so the page never asks for location permission; edit it to follow a different city. The toggle button overrides the theme until the next sunrise or sunset.
- **Translation** — for lyrics that are neither English nor Chinese, a translate toggle shows each line's translation underneath it in a smaller font. Pick the target language from the dropdown; the app falls back across an LLM, a keyless endpoint and Google Cloud on its own
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
wrangler secret put GEMINI_API_KEY
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

## How It Works

1. **Auth**: Spotify PKCE flow (browser-only, no client secret needed)
2. **Polling**: Every 3 seconds, fetches the currently playing track from Spotify's Web API
3. **Lyrics**: On track change, tries Spotify via the Worker first. On a miss it queries LRCLIB, QQ Music and KKBOX in parallel and takes the best result:

   ```
   Spotify word-synced > Spotify line-synced > LRCLIB synced >
   QQ Music synced > LRCLIB plain > KKBOX
   ```

   Synced always beats plain, which is why KKBOX — the only plain-text source — sits last.
4. **Display**: `requestAnimationFrame` loop interpolates playback position between polls and highlights the current line/word

## Limitations

- **Spotify Dev Mode (Feb 2026)**: Requires Spotify Premium for the app owner, max 5 authorized users. Fine for personal use.
- **sp_dc cookie**: Unofficial, lasts ~1 year. If it expires, the Worker will return errors and the site falls back to LRCLIB automatically.
- **LRCLIB coverage**: Not all songs have synced lyrics in LRCLIB's crowdsourced database.
- **KKBOX is currently blocked**: KKBOX song pages sit behind an AWS WAF JavaScript challenge (`x-amzn-waf-action: challenge`) that rejects datacenter IPs, so the Worker cannot scrape them — its search API still answers, but every page fetch returns the challenge instead of the lyrics. QQ Music covers most of what KKBOX used to, and with line-level timing rather than plain text. The KKBOX path is left in place as a fallback in case the rule is relaxed.
- **QQ Music access**: Must be fetched through the Worker — the endpoints send no CORS headers, and the lyric API rejects requests without a `y.qq.com` referer, which a browser cannot set cross-origin.
- **Polling latency**: Lyrics sync is approximate (±3 seconds) due to polling interval.

## File Structure

```
spotify-karaoke/
├── index.html          # Page shell
├── style.css           # Dark karaoke theme
├── app.js              # All client-side logic
├── lyrics.js           # Lyrics fetch chain (no DOM dependencies)
├── matching.js         # Script-insensitive search matching (see below)
├── translate.js        # Language detection + translation providers
├── sun.js              # Sunrise/sunset times for the automatic light/dark theme
├── tools/
│   └── gen_zh_table.py # Regenerates matching.js's Traditional→Simplified table
├── tests/              # Node and Python tests — `node tests/test_matching.mjs`,
│                       # `node tests/test_source_priority.mjs`,
│                       # `node tests/test_translate.mjs`
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
rather than scraped.
