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

### Done in 9.1

- Rule 1: `db::present_tracks` and move detection (`db::Known::can_vanish`) skip streamed songs.
  A file found at a streamed song's path makes it kept (`db::upsert`).
- Rule 2: `files::record` treats a streamed song as still had (`Copies::streamed`).
- Rule 3: `sync::not_streamed_paths` and `not_streamed_prints` take a streamed song's file out of
  the plan's extras, by path and by audio. `db::present_sizes` keeps streamed songs, so their files
  are not offered for pull either.
- Rule 4: everything that reads, writes, exports or trashes a song's file skips streamed songs:
  analysis jobs, audio fingerprint fill, scan cache, duplicates, rekordbox export, the tag reading
  for the shared library (`song_tags::unread`, `tracked`), replaced-file candidates (`carry.rs`),
  and the "another copy is still here" checks in `files.rs`. Commands that take a path from the
  UI (tag editor, trash, convert, USB export) fail on a streamed song's missing file without
  changing anything; 9.3 and 9.6 give them a proper answer.
- Song lists, playlists, tags, import's "already in the library" and Jellyfin matching keep
  streamed songs.

Left for later steps:

- `files::arrivals_wanted` counts a streamed row as "here", so a streamed song is not downloaded.
  That is what Stream wants; 9.5 adds the download for kept songs.
- `ONE_PER_AUDIO` may pick the streamed row when one audio is both kept and streamed; an export
  then leaves that song out. Rare; revisit in 9.6.
- The frontend does not see `file_state` yet (9.3).

### Done in 9.2

- The `file` entity has `size`, `duration_ms`, `bitrate` and `sample_rate`, written once by the
  first device with the file (early ops, never edits), so a size goes stale after a tag edit.
- `libsync::streamed::refresh` runs after every sync of a shared library kept on a destination:
  adds a streamed row per song the log has and this library has no file of, follows renames and
  tag edits, and drops rows of songs removed, kept here, or no longer in a shared library (or one
  kept in the library folder). Names follow the scan: album artist, else artist, else folder.
- `NewSongs` (`new_shared_songs` setting, commands `new_shared_songs` / `set_new_shared_songs`):
  Stream (default) adds rows and downloads nothing; Download adds no rows and `fetch_shared_songs`
  downloads as before. **Behaviour change:** songs other devices add are no longer downloaded by
  default.
- `files::moves_wanted` skips songs that are only streamed here.

Left for later steps: covers of streamed songs (the art route reads the file; 9.3), and the
Tag Database's value lists (`tag_values`), which only scans fill, so a streamed song's genre is
not offered in pick lists until some file here has it.

### Done in 9.3

- `Track` carries `fileState` (`fileStateSchema` in `api.ts`, default `here`).
- The player loads every song through `trackUrl`: a kept song from its file; a streamed one from
  `stream_source`, which answers `remote:<destination id>/<path>` for the shared library's
  destination. A stream that fails says the destination may be out of reach.

Left for 9.4: the stream cache (so `stream_source` answers a local file once a song is cached),
Windows AIFF/ALAC through `pcm://`, and covers of streamed songs from the cached file.

### Done in 9.4

- `stream_cache.rs`: whole files of streamed songs under the app's cache folder
  (`stream-cache/<audio_fp>.<ext>`), trimmed to the limit (`stream_cache_bytes`, 0.5 GB to 1 TB,
  default 5 GB) by when each was last played; a file name is made only from a safe audio print
  and extension. Commands `stream_cache_usage`, `set_stream_cache_limit` (trims at once),
  `empty_stream_cache`.
- `stream_source` answers the cached file when there is one, else the destination while the whole
  file downloads into the cache in the background. AIFF/ALAC on Windows download first, then play
  through `pcm://`. The player asks for the next streamed song ahead (`stream_prefetch`).
- A streamed song's cover comes from its cached file, once it was played.

### Done in 9.5

- `libsync/keep.rs`: keep rules (`keep_rules`: a song by `audio_fp`, a playlist by uid; local
  only). `fetch_shared_songs` downloads the streamed songs a rule keeps, and the songs other
  devices add when set to Download. **Albums:** "Keep" on an album keeps its songs now (song
  rules); there is no album rule, so a song added to the album later streams.
- Commands `keep_songs`, `set_playlist_kept`, `stream_only`. Stream only sets the row streamed
  first, then moves the file to the Trash (Recycle Bin), and puts the row back if that fails. It
  leaves a song kept when a kept playlist has it or the destination does not have its file, and
  says how many.
- Song menu: "Keep on this device" for streamed songs, "Stream only" (asks first) for kept ones;
  "Show in Finder" only for kept songs. Playlist menu: "Keep songs on this device". A cloud
  mark next to a streamed song's title.
- Settings, Library: a Streaming group (shown when the shared library is on a destination) with
  Songs other devices add, Stream cache size and Empty cache.

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
