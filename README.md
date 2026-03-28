# Spotify Karaoke

A static website that connects to your Spotify account and displays real-time synced lyrics for whatever you're currently playing. Hosted on GitHub Pages with an optional Cloudflare Worker proxy for the best lyrics quality.

## Features

- **Real-time karaoke display** — lyrics highlight line-by-line (or word-by-word with the Cloudflare Worker) synced to your playback
- **Spotify integration** — uses the official Spotify Web API with PKCE auth (no backend needed for auth)
- **Two-layer lyrics** — Cloudflare Worker (Spotify's internal Musixmatch-powered lyrics) as primary, LRCLIB (free, open) as fallback
- **Graceful degradation** — word-synced → line-synced → plain scrollable lyrics → "no lyrics" message
- **Dark theme** with smooth animations
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
3. **Lyrics**: On track change, fetches lyrics from the Worker (primary) or LRCLIB (fallback)
4. **Display**: `requestAnimationFrame` loop interpolates playback position between polls and highlights the current line/word

## Limitations

- **Spotify Dev Mode (Feb 2026)**: Requires Spotify Premium for the app owner, max 5 authorized users. Fine for personal use.
- **sp_dc cookie**: Unofficial, lasts ~1 year. If it expires, the Worker will return errors and the site falls back to LRCLIB automatically.
- **LRCLIB coverage**: Not all songs have synced lyrics in LRCLIB's crowdsourced database.
- **Polling latency**: Lyrics sync is approximate (±3 seconds) due to polling interval.

## File Structure

```
spotify-karaoke/
├── index.html          # Page shell
├── style.css           # Dark karaoke theme
├── app.js              # All client-side logic
├── worker/
│   ├── worker.js       # Cloudflare Worker (lyrics proxy)
│   └── wrangler.toml   # Worker config
└── README.md
```
