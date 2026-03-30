---
name: Lyrics sync offset controls
overview: Add a floating offset control bar to the lyrics area that appears only when synced lyrics (LINE_SYNCED or WORD_SYNCED) are active, allowing the user to shift lyrics highlighting timing without affecting actual playback.
todos:
  - id: html-offset-bar
    content: "Add #lyrics-offset div with 5 buttons (-1s, -0.5s, reset label, +0.5s, +1s) inside lyrics-wrapper in index.html"
    status: completed
  - id: css-offset-styles
    content: Add styles for .lyrics-offset bar and its buttons, positioned bottom-left of lyrics area
    status: completed
  - id: js-offset-state
    content: Add lyricsOffsetMs state, DOM refs, adjustOffset() function, and wire button listeners in app.js
    status: completed
  - id: js-tick-offset
    content: Modify tick() to pass estimated + lyricsOffsetMs to highlightLyrics()
    status: completed
  - id: js-show-hide
    content: Show offset bar only for WORD_SYNCED/LINE_SYNCED, hide for PLAIN/null, reset offset on track change
    status: completed
isProject: false
---

# Lyrics Sync Offset Controls

## How it works

The animation loop in [app.js](spotify-karaoke/app.js) calculates an `estimated` playback position (line 286) and passes it to `highlightLyrics(estimated)`. We introduce a `lyricsOffsetMs` variable that gets added to `estimated` before it reaches the highlight logic. This shifts which lyric line/word appears "active" without touching the Spotify playback position or the progress bar UI.

```mermaid
flowchart LR
    Tick["tick()"] --> Estimated["estimated ms"]
    Estimated --> OffsetAdd["estimated + lyricsOffsetMs"]
    OffsetAdd --> Highlight["highlightLyrics()"]
    Estimated --> Progress["updateProgressUI()"]
```

The progress bar continues to show actual playback time; only highlighting is shifted.

## Changes

### 1. HTML -- add offset control bar ([index.html](spotify-karaoke/index.html))

Add a new `div#lyrics-offset` inside the `lyrics-wrapper`, positioned as a sibling to the `lyrics-source` badge (bottom-left). It contains:

- Buttons: **-1s**, **-0.5s**, a **reset** label showing the current offset (e.g. `0.0s`), **+0.5s**, **+1s**
- Starts with class `hidden`; shown/hidden by JS based on `syncType`

Placement: bottom-left of the lyrics area (mirroring the `lyrics-source` badge on the bottom-right).

### 2. CSS -- style the offset controls ([style.css](spotify-karaoke/style.css))

- Position `absolute`, `bottom: 0.75rem; left: 0.75rem` (mirrors lyrics-source on the right)
- Small pill-shaped buttons using existing `--surface-overlay`, `--text-dim`, `--text-secondary` variables so it works in both light and dark mode automatically
- Compact sizing to stay unobtrusive (similar scale to the lyrics-source badge)

### 3. JS -- offset state and logic ([app.js](spotify-karaoke/app.js))

- **New state variable**: `let lyricsOffsetMs = 0;` in the State section (near line 53)
- **DOM ref**: grab `#lyrics-offset` and its child elements
- **`tick()` function** (line 282): pass `estimated + lyricsOffsetMs` to `highlightLyrics()` instead of raw `estimated`. The `updateProgressUI()` call remains unchanged (actual playback time)
- **`adjustOffset(deltaMs)` function**: adds `deltaMs` to `lyricsOffsetMs`, updates the label, and forces `lastHighlightedIndex = -1` so highlighting re-evaluates immediately
- **Show/hide logic**: in `fetchAndSetLyrics`, after setting `syncType`, show the offset bar if `syncType` is `WORD_SYNCED` or `LINE_SYNCED`, hide otherwise
- **Reset on track change**: set `lyricsOffsetMs = 0` in `fetchAndSetLyrics` when a new track loads
- **Button event listeners**: wire up click handlers for -1s, -0.5s, +0.5s, +1s buttons