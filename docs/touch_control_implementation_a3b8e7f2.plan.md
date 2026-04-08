---
name: Touch control implementation
overview: Add a toggleable "touch control" mode that makes the progress bar draggable for seeking and makes line-synced lyrics clickable to jump to that timestamp, both using the Spotify Player Seek API.
todos:
  - id: scope
    content: Add `user-modify-playback-state` to SCOPES in app.js CONFIG
    status: completed
  - id: seek-api
    content: Implement `seekToPosition(ms)` function using Spotify PUT endpoint
    status: completed
  - id: toggle-html
    content: Add touch-control toggle button in index.html next to theme toggle
    status: completed
  - id: toggle-js
    content: Wire toggle state (localStorage, data attribute, icon swap) in app.js
    status: completed
  - id: progress-drag
    content: Implement draggable progress bar with pointer events in app.js
    status: completed
  - id: progress-css
    content: Style interactive progress bar (larger hit area, cursor) in style.css
    status: completed
  - id: lyrics-click
    content: Implement lyrics line click-to-seek handler in app.js
    status: completed
  - id: lyrics-css
    content: Style clickable lyrics lines (cursor, hover) in style.css
    status: completed
isProject: false
---

# Touch Control for Spotify Karaoke

## Scope change: OAuth

The current scope in [app.js](spotify-karaoke/app.js) line 10 is:

```
SCOPES: 'user-read-currently-playing user-read-playback-state',
```

Must add `user-modify-playback-state` to enable seeking. **Users will need to re-authenticate** after this change.

## New Spotify API helper: `seekToPosition()`

Add a function in [app.js](spotify-karaoke/app.js) that calls:

```
PUT https://api.spotify.com/v1/me/player/seek?position_ms={ms}
Authorization: Bearer {accessToken}
```

This updates the actual Spotify playback position. After seeking, also update `lastProgressMs` and `lastPollTimestamp` locally for smooth UI continuity.

## Toggle button in the now-playing bar

In [index.html](spotify-karaoke/index.html), add a new button (`#touch-control-toggle`) next to the existing `#theme-toggle` button, using a "hand/touch" SVG icon. Visual treatment identical to the theme toggle (`btn-theme-toggle` style pattern).

State is persisted in `localStorage('touch-control')` and tracked via a `touchControlEnabled` boolean in [app.js](spotify-karaoke/app.js). When enabled, add a `data-touch-control` attribute to `<html>` for CSS hooks.

## Feature 1: Draggable progress bar

When touch control is on, the `.progress-bar-track` element becomes interactive:

- In [app.js](spotify-karaoke/app.js), attach `pointerdown` / `pointermove` / `pointerup` listeners to `.progress-bar-track`
- On drag, calculate `position_ms = (pointerX / trackWidth) * durationMs`, update `progressFill` width in real time
- On release (`pointerup`), call `seekToPosition(position_ms)`
- CSS in [style.css](spotify-karaoke/style.css): when `[data-touch-control]` is set:
  - Larger hit area (height ~12px instead of 3px), `cursor: pointer`
  - A circle thumb on `.progress-bar-fill::after` -- small white circle (12px) positioned at the right edge of the fill, hidden by default, shown on `.progress-bar-track:hover` and while dragging (via a `.dragging` class). Standard Spotify/YouTube pattern.

## Feature 2: Clickable lyrics lines

When touch control is on and sync type is `LINE_SYNCED` or `WORD_SYNCED`:

- In [app.js](spotify-karaoke/app.js), add a delegated click handler on `#lyrics-lines`
- On click of a `.lyrics-line` that is not `.active`, read its `data-index`, look up `lyrics[index].startTimeMs`
- Account for manual offset: `seekMs = startTimeMs - lyricsOffsetMs` (so the offset-adjusted position lands on that line)
- Clamp to `[0, durationMs]` and call `seekToPosition(seekMs)`
- CSS: when touch control is on, give `.lyrics-line` a `cursor: pointer` and a subtle hover effect (except the `.active` line)

## Files to change

- [index.html](spotify-karaoke/index.html) -- add toggle button markup
- [app.js](spotify-karaoke/app.js) -- add scope, toggle state, seek API call, progress bar drag, lyrics click handler
- [style.css](spotify-karaoke/style.css) -- interactive progress bar styles, lyrics hover styles, toggle icon styles

