"""
Test script for KKBOX lyrics fetching.
Replicates the same logic as the Cloudflare Worker's /kkbox-lyrics endpoint.

Usage:
  python test_kkbox.py "APT." "ROSÉ"
  python test_kkbox.py "稻香" "周杰倫"
  python test_kkbox.py   (interactive prompt)
"""

import sys
import re
import json
import urllib.request
import urllib.parse

try:
    import opencc
    _t2s = opencc.OpenCC('t2s')
except ImportError:
    _t2s = None

sys.stdout.reconfigure(encoding="utf-8")

HEADERS_HTML = {
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
    "Accept": "text/html",
}
HEADERS_JSON = {
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
    "Accept": "application/json",
}


def fetch_json(url):
    req = urllib.request.Request(url, headers=HEADERS_JSON)
    with urllib.request.urlopen(req, timeout=15) as resp:
        return json.loads(resp.read().decode("utf-8"))


def fetch_html(url):
    req = urllib.request.Request(url, headers=HEADERS_HTML)
    with urllib.request.urlopen(req, timeout=15) as resp:
        return resp.read().decode("utf-8", errors="replace")


def search_kkbox(title, artist):
    q = f"{title} {artist}".strip()
    url = (
        "https://www.kkbox.com/api/search/song?q="
        + urllib.parse.quote(q)
        + "&terr=hk&lang=tc"
    )
    print(f"[1/3] Searching KKBOX API: {url}")
    data = fetch_json(url)
    results = data.get("data", {}).get("result", [])
    if not results:
        return None
    first = results[0]
    print(f"      Best match: {first['name']} — {first['album']['artist']['name']}")
    return first["url"]


def scrape_kkbox_lyrics(song_url):
    print(f"[2/3] Fetching song page: {song_url}")
    html = fetch_html(song_url)
    for m in re.finditer(
        r'<script type="application/ld\+json">(.*?)</script>', html, re.DOTALL
    ):
        try:
            data = json.loads(m.group(1))
            text = (data.get("recordingOf") or {}).get("lyrics", {}).get("text")
            if text:
                return text
        except json.JSONDecodeError:
            continue
    return None


def main():
    if len(sys.argv) >= 3:
        title, artist = sys.argv[1], sys.argv[2]
    elif len(sys.argv) == 2:
        title, artist = sys.argv[1], ""
    else:
        title = input("Song title: ").strip()
        artist = input("Artist name: ").strip()

    if not title:
        print("Error: song title is required.")
        sys.exit(1)

    print(f"Input: title={title!r}, artist={artist!r}\n")

    song_url = search_kkbox(title, artist)
    if not song_url:
        print("No results found on KKBOX.")
        sys.exit(1)

    lyrics = scrape_kkbox_lyrics(song_url)
    if not lyrics:
        print("Song page found but no lyrics extracted.")
        sys.exit(1)

    if _t2s and re.search(r"[\u4e00-\u9fff]", lyrics):
        lyrics = _t2s.convert(lyrics)
        print("[3/3] Lyrics converted to Simplified Chinese")

    print(f"[3/3] Lyrics found ({len(lyrics)} chars):\n")
    print("=" * 50)
    print(lyrics)
    print("=" * 50)


if __name__ == "__main__":
    main()
