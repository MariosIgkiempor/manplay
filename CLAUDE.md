# manplay

Desktop music library for DJs: scan, tag, play, analyse (BPM, key, beat grid, waveform, cues),
sync to remote destinations, and export to rekordbox and Pioneer USB drives. macOS and
Windows 10/11 x64.

## Stack

- **App shell:** Tauri 2. Rust backend in `src-tauri/src/`, app state lives in one SQLite database
  (`library.db` in the app data dir; rusqlite with bundled SQLCipher).
- **Frontend:** React 19, TanStack Router (file routes in `src/routes/`, `routeTree.gen.ts` is
  generated), TanStack Query, Tailwind 4, Base UI. Zod schemas in `src/lib/api.ts` validate
  every `invoke` result.
- **Sidecar:** static ffmpeg in `src-tauri/binaries/`, fetched by `pnpm install`
  (`scripts/fetch-ffmpeg.mjs`).

## Map

| Area | Where |
|---|---|
| Tauri commands | `src-tauri/src/lib.rs` |
| Schema and queries | `src-tauri/src/db.rs` |
| Library scan, file tags | `scan.rs`, `tags.rs`, `tag_region.rs` |
| Audio identity | `audioprint.rs` (`audio_fp`: audio only), `scan::fingerprint` (whole file) |
| Analysis, waveforms | `analysis.rs`, `anlz.rs` |
| Destinations sync (WebDAV over Tailscale, R2) | `sync.rs`, `sync/transfer.rs`, `webdav.rs`, `r2.rs`, `tailscale.rs` |
| Background destination reads, per-destination plans | `sync_scans.rs`, `scan_worker` in `lib.rs`, `src/lib/sync-status.ts`, `src/lib/review-reads.ts` |
| Source and destination pages | `src/routes/export.*.tsx`, `src/routes/import.*.tsx`, `src/lib/places.ts`, `src/components/place-crumb.tsx` |
| Shared library data (op log: tags, playlists, smart playlists, analysis, Tag Database values; waveform files; one shared library per device, joined or left per destination) | `src-tauri/src/libsync/`, `docs/plans/shared-library/` |
| rekordbox / USB export | `rekordbox.rs`, `usb*.rs`, `pdb/`, `onelib/` |
| The formats a USB export writes (`usb_export::Outputs`): rekordbox, Serato crates, VirtualDJ library (`VirtualDJ/`), Gemini MDJ library (`GEMINI/`, the V-CASE format), playlists as folders (`Playlists/`); the drive's own song list when rekordbox is off (`.manplay/`) | `usb_export.rs`, `serato.rs`, `virtualdj.rs`, `gemini.rs`, `playlist_folders.rs`, `usb_files.rs`, `src/lib/usb-outputs.ts`, `docs/virtualdj.md`, `docs/gemini-vcase.md` |
| Frontend API wrappers | `src/lib/api.ts`, `src/lib/queries.ts` |
| Harness: the UI in a headless browser on a fake backend, for looking at and driving the app | `scripts/harness.mjs`, `src/harness/`, `docs/harness.md` |
| Plans and research | `docs/plans/`, `docs/*.md` |

## Commands

```bash
pnpm install          # also fetches ffmpeg
pnpm tauri dev        # run the app
pnpm verify           # typecheck + biome + vitest
cargo clippy --manifest-path src-tauri/Cargo.toml
cargo test   --manifest-path src-tauri/Cargo.toml
```

CI runs all of these on macOS and Windows. Run them before calling work done.

## Seeing the UI

To look at a screen or check a UI change, use the harness instead of the desktop app or OS
screenshots. It runs the frontend in a headless browser against a made-up library:

```bash
pnpm harness start            # once; --platform windows for the Windows wording and webview
pnpm harness goto /settings
pnpm harness text             # the page as an accessibility tree (cheap; read this first)
pnpm harness shot settings    # a PNG; prints its path
pnpm harness click 'role=tab[name="Songs"]'
pnpm harness tour             # a screenshot of every kind of page
pnpm harness stop
```

Every command also prints new console errors. `docs/harness.md` has the rest: scenarios, backend
events, adding a command to the fake backend. The backend is fake, so anything in Rust still needs
`cargo test` or the real app.

## Rules for agents

- **Flag breaking changes to the user.** check whether old formats should be supported (and if we need a migration or not). Additive (eg `add_column`) schema changes are fine.
- **Rust:** `unwrap` is denied and clippy pedantic warns. Return `Result<_, Error>`
  (`error.rs`). Don't add new clippy warnings. No `unsafe`.
- **TypeScript:** Biome formats (tabs, double quotes, width 100). Import with `#/…` paths.
  Parse backend data with zod in `api.ts`; don't call `invoke` from components.
- **Comments:** doc comments say what something is or why, in plain words. No change logs.
- **Times:** store Unix time in UTC; show local time.
- **Windows parity:** paths, trash/Recycle Bin wording and USB handling differ per platform
  (`src/lib/platform.ts`, `usb_mac.rs`, `usb_windows.rs`). Keep both working.
- **Destructive file actions** (delete, overwrite on a destination or drive) need a review step
  and a backup or trash copy, like `sync::apply_target`.
- **Secrets** live in the OS keychain (`r2.rs`), never in the database or `localStorage`.
- **Commits:** subject starts with the area (`Sync: …`, `Tags: …`) and describes what the user
  now sees. Commit only when asked.
