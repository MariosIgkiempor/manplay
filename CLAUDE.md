# manplay

Desktop music library for DJs: scan, tag, play, analyse (BPM, key, beat grid, waveform, cues),
sync to remote destinations, and export to rekordbox and Pioneer USB drives. macOS and
Windows 10/11 x64.

## Stack

- **App shell:** Tauri 2. Rust backend in `src-tauri/src/`, app state lives in one SQLite database
  (`library.db` in the app data dir; rusqlite with bundled SQLCipher).
- **Frontend:** React 19, TanStack Router (file routes in `src/routes/`, `routeTree.gen.ts` is
  generated), TanStack Query, Tailwind 4, UI SDK (`@ui-sdk/react`; menus and popovers go through
  `src/components/ui/popup.tsx`). Zod schemas in `src/lib/api.ts` validate every `invoke` result.
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
| Tag and cover lookup online (MusicBrainz, Cover Art Archive, and Discogs once a token is saved in the keychain; on demand, behind the `lookup` service switch) | `lookup.rs`, `lookup/musicbrainz.rs`, `lookup/discogs.rs`, `src/lib/tag-lookup.ts`, `src/lib/use-tag-suggestions.ts`, `src/components/tag-lookup-strip.tsx` (found values shown in the tag editor), `cover-card.tsx` (the cover grown into a card to change it) |
| Destinations sync (WebDAV over Tailscale, R2) | `sync.rs`, `sync/transfer.rs`, `webdav.rs`, `r2.rs`, `tailscale.rs` |
| Background destination reads, per-destination plans | `sync_scans.rs`, `scan_worker` in `lib.rs`, `src/lib/sync-status.ts`, `src/lib/review-reads.ts` |
| Shared library syncing on its own (when it runs, the list of what other devices changed with Undo, the stop before many deletions at once) | `libsync/auto.rs`, `libsync/journal.rs`, `libsync/brake.rs`, `libsync_worker` in `lib.rs`, `src/components/library-changes.tsx`, `src/lib/library-changes.ts` |
| Where each song's file is and which songs were removed on purpose, written to the shared library's log, and the library following moves and renames other devices made and the review of songs other devices removed (new songs are recorded only) | `libsync/files.rs`, `record_files`, `follow_file_moves` and `fs_trash` in `lib.rs` |
| Source and destination pages | `src/routes/export.*.tsx`, `src/routes/import.*.tsx`, `src/lib/places.ts`, `src/components/place-crumb.tsx` |
| Shared library data (op log: tags, playlists, smart playlists, analysis, Tag Database values; waveform files; one shared library per device, joined or left per destination) | `src-tauri/src/libsync/`, `docs/plans/shared-library/` |
| rekordbox / USB export | `rekordbox.rs`, `usb*.rs`, `pdb/`, `onelib/` |
| The formats a USB export writes (`usb_export::Outputs`): rekordbox, Serato crates, VirtualDJ library (`VirtualDJ/`), Gemini MDJ library (`GEMINI/`, the V-CASE format), playlists as folders (`Playlists/`); the drive's own song list when rekordbox is off (`.manplay/`) | `usb_export.rs`, `serato.rs`, `virtualdj.rs`, `gemini.rs`, `playlist_folders.rs`, `usb_files.rs`, `src/lib/usb-outputs.ts`, `docs/virtualdj.md`, `docs/gemini-vcase.md` |
| Frontend API wrappers | `src/lib/api.ts`, `src/lib/queries.ts` |
| The app's own file picker, confirm question, two-press confirm button and hover hints, in place of native UI | `file_picker.rs`, `src/lib/file-picker.ts`, `src/components/file-picker.tsx`, `src/lib/confirm.ts`, `src/components/ui/confirm-button.tsx`, `src/components/hint-layer.tsx`, `src/components/text-field-menu.tsx` |
| Harness: the UI in a headless browser on a fake backend, for looking at and driving the app | `scripts/harness.mjs`, `src/harness/`, `docs/harness.md` |
| Plans and research | `docs/plans/`, `docs/*.md` |

## Commands

```bash
pnpm install          # also fetches ffmpeg
pnpm tauri dev        # run the app
pnpm verify           # typecheck + biome + vitest
pnpm setup-worktree   # in a new git worktree: clone the main checkout's Rust build, then install
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
- **No native UI.** The app draws everything itself: no system file pickers or message boxes, no
  browser tooltips (`title`), `<select>`, `<datalist>` or date inputs. Use `pickPath`
  (`src/lib/file-picker.ts`), `data-hint` or `Hint`, `Select`, `SuggestInput`, `DateField`
  (`src/components/ui/`). An action worth a second thought that starts from a button uses
  `ConfirmButton` (press twice), not a dialog; one that starts from a menu or shortcut uses
  `askConfirm` (`src/lib/confirm.ts`). A right-click opens an app menu or, in a text field,
  `TextFieldMenu`; never the webview's. `src/lib/no-native-ui.test.ts` enforces what it can.
- **Comments:** doc comments say what something is or why, in plain words. No change logs.
- **Times:** store Unix time in UTC; show local time.
- **Windows parity:** paths, trash/Recycle Bin wording and USB handling differ per platform
  (`src/lib/platform.ts`, `usb_mac.rs`, `usb_windows.rs`). Keep both working.
- **Destructive file actions** (delete, overwrite on a destination or drive) need a review step
  and a backup or trash copy, like `sync::apply_target`.
- **Secrets** live in the OS keychain (`r2.rs`), never in the database or `localStorage`.
- **Commits:** subject starts with the area (`Sync: …`, `Tags: …`) and describes what the user
  now sees. Commit only when asked.
