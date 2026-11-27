# Step 9: Streaming

Date: 2026-11-27. Status: planned, nothing built yet.

A device in a shared library sees every song, with up-to-date tags, covers, BPM, key, grids and
waveforms, without having every audio file. Each song is either **kept** (its file is in the
library folder, as today) or **streamed** (played from the destination as it plays). The person
chooses which songs, albums and playlists to keep.

The shared library's data (`.manplay/`) is always read in full, as it is today. Only the audio is
optional.

## What already exists

| Piece | Where | Use here |
|---|---|---|
| `remote://<destination id>/<path>` scheme, range requests, 2 MB chunks | `stream.rs`, `audioUrl` in `api.ts` | Plays a streamed song |
| `get_range` on WebDAV and R2 | `webdav.rs`, `r2.rs` | Behind the scheme |
| Where each song is on the destination (`file` entity: `path`, `present`) | `libsync/files.rs` | Which songs can be streamed, and from where |
| Tags and cover per song in the log | `libsync/song_tags.rs`, `covers.rs` | What a streamed song shows |
| BPM, key, grid in the log; waveform fetched one song at a time | `analysis` ops, `waveforms::fetch` | Grids and waveforms of streamed songs |
| Download of songs other devices added | `fetch_shared_songs`, `sync::fetch_songs` | "Keep on this device" |

## Model

A streamed song is a `tracks` row like any other, so playlists, smart playlists, tags, search,
sorting and the analysis all work without change. New column (additive):

```
tracks.file_state TEXT NOT NULL DEFAULT 'here'   -- 'here' | 'streamed'
```

`path` holds where the file would be in the library folder (`RelPath::under(root)`), so keeping it
later is a download to that path and nothing else changes. In Rust, `FileState` is an enum; in
`api.ts`, a zod enum.

Each device also keeps a list of what to keep (local, not shared):

```
keep_rules (kind TEXT, id TEXT)   -- kind: 'song' (audio_fp) | 'album' | 'playlist' (uid) | 'all'
```

A song is kept when any rule covers it. A rule on a playlist keeps songs added to it later.

### Song details not in the log

The log has tags but not `duration_ms`, `size`, `bitrate`, `sample_rate` or the file format,
which the song list shows. Add them as fields of the `file` entity, written by any device that has
the file. Older versions store and forward unknown fields (07-edge-cases), so this is additive.

## Rules that keep streamed songs safe

A streamed song has no file here. Every place that reads "no file" as "removed" must skip it.
Getting one of these wrong deletes songs for every device.

1. **Scan:** never marks a streamed song missing (`db::mark_missing`, `purge_expired`).
2. **`files::record`:** never writes `present = false` for a streamed song. Un-keeping a song is
   not removing it.
3. **File sync plan (`sync.rs` `pair`):** a destination file that matches a streamed song is
   accounted for: not offered for delete, not pulled, not uploaded.
4. **File actions** (trash, move, rename, duplicates, tag writes into files, USB export, convert):
   act only on kept songs, or download first (see Export).
5. **Downgrade:** an older app opening this database would see streamed rows with no file, mark
   them missing, and after the grace period write them as removed to the shared log. Add a
   `PRAGMA user_version` guard (refuse to open a database from a newer schema) and ship it one
   release before streaming. **Breaking for downgrades by design**; no migration needed forward.

Each rule gets a test in `libsync/tests` or `sync.rs` tests.

## Playback

- `audioUrl` takes a track, not a path: kept → local file as now; streamed → `remote:` URL for
  the shared library's destination; shared library in a folder (`SharedPlace::Folder`) → the file
  in that folder directly.
- **Cache:** what streams is also written to a cache dir (`stream-cache/<audio_fp>`), whole file,
  capped at a size the person sets in Settings (default 5 GB; oldest played goes first; lowering
  it trims the cache right away). Settings also shows how much the cache holds, with a button to
  empty it. A replay or seek in a cached song is
  local. The cache never counts as kept.
- **Windows AIFF/ALAC** (`pcm://` needs a local file): fetch the whole file into the cache first,
  then play. The player shows "Loading" until then.
- **Offline** (Tailscale down, R2 unreachable): streamed songs not in the cache show as not
  playable; everything else about them (tags, grids) still shows.
- **Preload next:** while a song plays, the next one in the queue starts filling the cache.

## Keep and un-keep

- Song list, album and playlist menus: **Keep on this device** / **Stream only**. A column or
  badge shows kept, streamed, cached.
- Keep → `sync::fetch_songs` into `path`, row becomes `here` after the scan picks it up. Progress
  in the existing status bar pill.
- Stream only → the file goes to the trash (Recycle Bin on Windows), row becomes `streamed`.
  Confirm with `askConfirm` (menu action). Refused when the destination does not have the file
  (this device holds the only copy) until a sync has put it there.
- New setting per device, **Songs other devices add: Download / Stream** (default Stream).
  `fetch_shared_songs` then downloads only songs some rule keeps, and adds the rest as streamed
  rows.

## Analysis, tags, export

- **Analysis:** a streamed song with no analysis from any device is analysed from the cache after
  it has been played through, or on "Analyse", which fills the cache first.
- **Tag edits on a streamed song** write `song_tags` ops directly (no file to read them from).
  Devices that keep the song write them into their files (`keep_song_tags`). When no device keeps
  it, the destination's file (what Jellyfin reads) keeps its old tags: the log holds the new ones,
  and the file catches up once a device keeps the song and syncs it. The destination's file is
  never rewritten by a device that only streams it.
- **USB / rekordbox export** with streamed songs: downloads them into the cache first, with
  progress, then exports as usual.

## Steps

| # | What | Estimate |
|---|---|---|
| 9.0 | `user_version` downgrade guard, ship alone | ½ day |
| 9.1 | `file_state` column, `FileState`, safety rules 1–4 with tests | 1 day |
| 9.2 | `file` entity details (duration, size, format, ...); streamed rows built from the log | 1 day |
| 9.3 | Player plays streamed songs: `audioUrl(track)`, folder case, offline state | ½ day |
| 9.4 | Stream cache with its size setting, preload next, Windows `pcm` path | 1 day |
| 9.5 | Keep rules, Keep / Stream only menus, badges, "Songs other devices add" setting | 1 day |
| 9.6 | Tag edits, analysis and export for streamed songs | 1 day |

About 6 days. 9.0 and 9.1 land before anything a person can see. Each step ends with
`pnpm verify`, `cargo clippy` and `cargo test` passing, and harness checks for the UI steps.

## Settings

One group, **Streaming**, on the Settings page, per device (stored in `settings`, not shared):

| Setting | Values | Default |
|---|---|---|
| Songs other devices add | Stream / Download | Stream |
| Stream cache size | a size in GB | 5 GB |
| Stream cache in use | shown, with **Empty cache** (`ConfirmButton`) | — |

Changing "Songs other devices add" to Download downloads only songs added after the change;
already streamed songs stay streamed until kept.

## Decided

- New songs from other devices stream by default; Download is a setting (2026-11-27).
- Cues are not shared: each device keeps its own, as the README says (2026-11-27).

- Tag edits on a song no device keeps live in the log until a device keeps it (2026-11-27).
- Stream cache size is a setting, default 5 GB (2026-11-27).
