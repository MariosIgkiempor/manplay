# Harness

The harness runs manplay's frontend in a headless browser and drives it from the command line,
so an agent (or a person) can open a screen, click through it, read it and take screenshots
without the desktop app, a window server or OS screen capture.

The Rust backend does not run. A fake one in `src/harness/` answers every Tauri command from
memory with a made-up library, so each run shows the same songs and the same sources and
destinations. That makes the harness right for layout, wording, states and flows of the UI, and
wrong for anything the backend does: scanning, tags on disk, syncing, exports. Check those with
`cargo test` or `pnpm tauri dev`.

## Setup

```bash
pnpm install
pnpm exec playwright install webkit chromium   # once per machine
```

## Use

```bash
pnpm harness start                 # dev server + browser, left running in the background
pnpm harness goto /export          # open a route
pnpm harness text                  # the page as an accessibility tree
pnpm harness text 'role=dialog'    # one part of it
pnpm harness shot export           # PNG in node_modules/.cache/manplay-harness/shots/
pnpm harness shot out/x.png --selector 'main header'
pnpm harness click 'text=Add destination'
pnpm harness fill 'role=textbox[name="Bucket"]' my-bucket
pnpm harness press Meta+k
pnpm harness errors                # console errors; commands the fake backend lacks
pnpm harness stop
```

`pnpm harness help` lists every command. Selectors are Playwright's: `text=…`,
`role=button[name="…"]`, or CSS.

The page stays open between commands, so a click followed by `shot` shows the result of the
click. Each command waits for the page to settle and then prints any console error, uncaught
error or unanswered backend command seen since the last one, so a broken screen is noticed at the
step that broke it.

`text` costs far less than a screenshot. Read the page with it first and take a screenshot when
the question is how something looks.

### All pages at once

```bash
pnpm harness tour before     # one screenshot per kind of page, in shots/before/
# …change the UI…
pnpm harness tour after
```

The routes are the `TOUR` list in `scripts/harness.mjs`. Add a route there when a new kind of
page appears.

### Platforms and sizes

`start` takes `--platform mac` (default: WebKit, as in the macOS app) or `--platform windows`
(Chromium with a Windows user agent, as WebView2), plus `--width`, `--height` and `--scale`.
`resize <width> <height>` changes the window while running; the app's smallest window is 960×600.

Windows mode shows the Windows wording (`Ctrl+K`, Recycle Bin). Fonts are still this machine's.

### Scenarios

```bash
pnpm harness scenario empty   # a first launch: no library folder, no destinations
pnpm harness scenario large   # about 1,400 songs, the size of a real collection
pnpm harness scenario full    # the default
```

### Backend events

Progress arrives from the backend as events. Send one by hand to see a screen mid-run:

```bash
pnpm harness emit sync-progress '{"targetId":1,"done":3,"total":12,"current":"a.mp3"}'
```

Event names and payloads are the `listen(...)` calls in `src/lib/api.ts`.

## How it works

- `vite --mode harness` serves the app. In that mode only, `src/client.tsx` loads
  `src/harness/install.ts` before the app starts; every other build drops the import.
- `install.ts` puts the fake backend where Tauri's IPC would be (`@tauri-apps/api/mocks`), draws
  album covers from the album's name, and gives the player silent audio of the right length.
- `fake-backend.ts` holds the commands. Reads come from `fake-library.ts` (songs, tags, playlists)
  and `fake-places.ts` (destinations, drives, import folders). Playlist, tag and settings edits
  change that state so a click shows its result; other writes succeed and do nothing.
- `scripts/harness.mjs` is the driver: `start` leaves one process holding Vite, the browser and
  the page, and the other commands are requests to it.

`window.__harness` in the page has the scenario, the commands called so far and `emit`.

## Keeping it honest

`src/harness/fake-backend.test.ts` runs with `pnpm test` and fails when:

- `api.ts` calls a command the fake backend has no answer for, or
- an answer no longer passes the zod schema `api.ts` checks the real backend with.

So after adding or changing a command in `api.ts`, add or update it in `fake-backend.ts`. A read
goes in one of the `…Commands` functions and in the test's `READS`; a write that needs no visible
effect goes in `ACCEPTED`.
