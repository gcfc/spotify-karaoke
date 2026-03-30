"""
Test the full fetchAndSetLyrics priority chain from the command line.
Mirrors the logic in app.js — tries each source in order and prints the result.

Usage:
  python test_lyrics.py "APT." "ROSÉ"
  python test_lyrics.py "稻香" "周杰倫"
  python test_lyrics.py "Bohemian Rhapsody" "Queen" --track-id 4u7EnebtmKWzUH433cf5Qv --duration 355
  python test_lyrics.py   (interactive prompt)
"""

import sys
import re
import json
import urllib.request
import urllib.parse

sys.stdout.reconfigure(encoding="utf-8")

WORKER_URL = "https://spotify-lyrics-worker.spotify-karaoke.workers.dev"

HEADERS_HTML = {
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
    "Accept": "text/html",
}
HEADERS_JSON = {
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
    "Accept": "application/json",
}


def http_get_json(url, headers=None):
    req = urllib.request.Request(url, headers=headers or HEADERS_JSON)
    with urllib.request.urlopen(req, timeout=15) as resp:
        return json.loads(resp.read().decode("utf-8"))


def http_get_text(url, headers=None):
    req = urllib.request.Request(url, headers=headers or HEADERS_HTML)
    with urllib.request.urlopen(req, timeout=15) as resp:
        return resp.read().decode("utf-8", errors="replace")


# ── Source 1: Cloudflare Worker (Spotify internal lyrics) ──

def fetch_from_worker(track_id):
    """Priority 1 — Spotify word-synced or line-synced via Cloudflare Worker."""
    if not track_id:
        return None, None
    url = f"{WORKER_URL}/lyrics?track_id={urllib.parse.quote(track_id)}"
    print(f"  [Worker] GET {url}")
    try:
        data = http_get_json(url)
    except Exception as e:
        print(f"  [Worker] Failed: {e}")
        return None, None

    lyrics_obj = data.get("lyrics")
    if not lyrics_obj or not lyrics_obj.get("lines"):
        print("  [Worker] No lyrics in response")
        return None, None

    sync_type = lyrics_obj.get("syncType")
    if sync_type not in ("WORD_SYNCED", "LINE_SYNCED"):
        print(f"  [Worker] Unsupported syncType: {sync_type}")
        return None, None

    lines = lyrics_obj["lines"]
    text = "\n".join(
        line.get("words", "") for line in lines if line.get("words")
    )
    mode = "word-synced" if sync_type == "WORD_SYNCED" else "line-synced"
    return text, f"Spotify · {mode}"


# ── Source 2: LRCLIB (synced then plain) ──

def fetch_from_lrclib(track_name, artist_name, duration_sec=None):
    """Priority 2 — LRCLIB synced lyrics, then plain."""
    headers = {**HEADERS_JSON, "Lrclib-Client": "SpotifyKaraoke/1.0"}

    params = urllib.parse.urlencode({
        "track_name": track_name,
        "artist_name": artist_name,
        **({"duration": str(round(duration_sec))} if duration_sec else {}),
    })
    url = f"https://lrclib.net/api/get?{params}"
    print(f"  [LRCLIB] GET {url}")
    try:
        data = http_get_json(url, headers)
    except urllib.error.HTTPError:
        data = None
    except Exception as e:
        print(f"  [LRCLIB] get failed: {e}")
        data = None

    if not data or not (data.get("syncedLyrics") or data.get("plainLyrics")):
        q = f"{track_name} {artist_name}"
        url2 = f"https://lrclib.net/api/search?q={urllib.parse.quote(q)}"
        print(f"  [LRCLIB] Fallback search: {url2}")
        try:
            results = http_get_json(url2, headers)
        except Exception as e:
            print(f"  [LRCLIB] search failed: {e}")
            return None, None
        if not results:
            return None, None
        data = next((r for r in results if r.get("syncedLyrics")), results[0])

    if data.get("syncedLyrics"):
        text = parse_lrc(data["syncedLyrics"])
        if text:
            return text, "LRCLIB · line-synced"

    if data.get("plainLyrics"):
        return data["plainLyrics"], "LRCLIB · plain"

    return None, None


def parse_lrc(lrc_string):
    lines = []
    for raw in lrc_string.split("\n"):
        m = re.match(r"^\[(\d+):(\d+)\.(\d+)\]\s*(.*)", raw)
        if not m:
            continue
        text = m.group(4).strip()
        if text:
            lines.append(text)
    return "\n".join(lines) if lines else None


# ── Source 3: KKBOX (plain text via JSON API + JSON-LD) ──

def fetch_from_kkbox(track_name, artist_name):
    """Priority 3 — KKBOX search API + song page JSON-LD scrape."""
    q = f"{track_name} {artist_name}".strip()
    url = (
        "https://www.kkbox.com/api/search/song?q="
        + urllib.parse.quote(q)
        + "&terr=hk&lang=tc"
    )
    print(f"  [KKBOX] Search API: {url}")
    try:
        data = http_get_json(url)
    except Exception as e:
        print(f"  [KKBOX] Search failed: {e}")
        return None, None

    results = data.get("data", {}).get("result", [])
    if not results:
        print("  [KKBOX] No search results")
        return None, None

    song_url = results[0].get("url")
    print(f"  [KKBOX] Song page: {song_url}")

    try:
        html = http_get_text(song_url)
    except Exception as e:
        print(f"  [KKBOX] Song page failed: {e}")
        return None, None

    for m in re.finditer(
        r'<script type="application/ld\+json">(.*?)</script>', html, re.DOTALL
    ):
        try:
            ld = json.loads(m.group(1))
            text = (ld.get("recordingOf") or {}).get("lyrics", {}).get("text")
            if text:
                return text, "KKBOX · plain"
        except json.JSONDecodeError:
            continue

    print("  [KKBOX] No lyrics in JSON-LD")
    return None, None


# ── Main: same priority chain as fetchAndSetLyrics ──

def fetch_and_set_lyrics(track_id, track_name, artist_name, duration_ms=None):
    duration_sec = duration_ms / 1000 if duration_ms else None

    sources = [
        ("1. Spotify (Worker)", lambda: fetch_from_worker(track_id)),
        ("2. LRCLIB",           lambda: fetch_from_lrclib(track_name, artist_name, duration_sec)),
        ("3. KKBOX",            lambda: fetch_from_kkbox(track_name, artist_name)),
    ]

    for label, fn in sources:
        print(f"\n── Trying {label} ──")
        text, source = fn()
        if text:
            return text, source
        print(f"  → No result")

    return None, None


def main():
    import argparse
    parser = argparse.ArgumentParser(description="Test the full lyrics fetch chain")
    parser.add_argument("title", nargs="?", help="Song title")
    parser.add_argument("artist", nargs="?", default="", help="Artist name")
    parser.add_argument("--track-id", default=None, help="Spotify track ID (for Worker source)")
    parser.add_argument("--duration", type=float, default=None, help="Track duration in seconds")
    args = parser.parse_args()

    title = args.title or input("Song title: ").strip()
    artist = args.artist or input("Artist name (optional): ").strip()

    if not title:
        print("Error: song title is required.")
        sys.exit(1)

    duration_ms = args.duration * 1000 if args.duration else None

    print(f"Track: {title!r} by {artist!r}")
    if args.track_id:
        print(f"Spotify ID: {args.track_id}")
    if duration_ms:
        print(f"Duration: {args.duration}s")

    text, source = fetch_and_set_lyrics(args.track_id, title, artist, duration_ms)

    if not text:
        print("\n✗ No lyrics available from any source.")
        sys.exit(1)

    print(f"\n{'='*50}")
    print(f"Source: {source}")
    print(f"{'='*50}")
    print(text)
    print(f"{'='*50}")


if __name__ == "__main__":
    main()
