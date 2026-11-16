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
| Shared library data (op log: tags, playlists; off per destination until switched on) | `src-tauri/src/libsync/`, `docs/plans/shared-library/` |
| rekordbox / USB export | `rekordbox.rs`, `usb*.rs`, `pdb/`, `onelib/` |
| Frontend API wrappers | `src/lib/api.ts`, `src/lib/queries.ts` |
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
