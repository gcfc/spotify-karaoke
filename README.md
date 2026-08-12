# Spotify Karaoke

A static website that connects to your Spotify account and displays real-time synced lyrics for whatever you're currently playing. Hosted on GitHub Pages with an optional Cloudflare Worker proxy for the best lyrics quality.

## Features

- **Real-time karaoke display** — lyrics highlight line-by-line (or word-by-word with the Cloudflare Worker) synced to your playback
- **Spotify integration** — uses the official Spotify Web API with PKCE auth (no backend needed for auth)
- **Layered lyrics** — Spotify's internal Musixmatch-powered lyrics via the Cloudflare Worker as primary, then LRCLIB (free, open), QQ Music (line-synced, strong Chinese coverage) and KKBOX (plain text) as fallbacks
- **Graceful degradation** — word-synced → line-synced → plain scrollable lyrics → "no lyrics" message
- **Dark theme** with smooth animations — switches to light at sunrise and back to dark at sunset for San Mateo, CA. The location is fixed in `sun.js` (`DEFAULT_LOCATION`), so the page never asks for location permission; edit it to follow a different city. The toggle button overrides the theme until the next sunrise or sunset.
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
├── sun.js              # Sunrise/sunset times for the automatic light/dark theme
├── tools/
│   └── gen_zh_table.py # Regenerates matching.js's Traditional→Simplified table
├── tests/              # Node and Python tests — `node tests/test_matching.mjs`,
│                       # `node tests/test_source_priority.mjs`
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
