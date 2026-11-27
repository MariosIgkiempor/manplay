# Step 1: `audio_fp` as track identity

Estimate: ½ day.

## Problem

- `analysis` and `cues` are keyed by `tracks.fingerprint` (whole file), e.g. the joins at
  `src-tauri/src/db.rs:575`. A retag on one device changes that key, so its grid and BPM would
  split from everyone else's.
- `tracks.audio_fp` is only filled in when imports need it (`db::tracks_without_audio_fp`,
  `db.rs:1919`).

## Change

1. Fill `audio_fp` for every track after each scan (reuse `db::set_audio_fps`, run in the
   background like the existing caller at `lib.rs:2433`).
2. Re-key `analysis.fingerprint` to `audio_fp` values. Rename the column to `audio_fp` and update
   every join (`grep -n "a.fingerprint = t.fingerprint" src-tauri/src/db.rs`). No migration of old
   rows: re-key what maps through `tracks`, drop rows that don't.
3. `cues` stays on the whole-file `fingerprint` for now (cues are local-only), but move it to
   `audio_fp` too if it is trivial, so one key rules everything.
4. Version the fingerprint: store `audio_fp_version` in `settings`. A future algorithm change must
   ship a remap (see step 7).

## Duplicates notice

Two present tracks with the same `audio_fp` share tags, grid and playlist entries. Flag it:

- Query: `SELECT audio_fp, count(*) FROM tracks WHERE missing_since IS NULL AND audio_fp IS NOT NULL GROUP BY audio_fp HAVING count(*) > 1`.
- UI: a "Duplicates" notice (library header or the audit page, `src/lib/audit.ts`) listing each
  group with reveal and move-to-trash per file.
- Playlists show one entry per `audio_fp`.

## Tests

- After a retag (new `fingerprint`, same `audio_fp`) the analysis still joins.
- Duplicate query finds a pair and ignores missing tracks.

## Done when

Every present track has an `audio_fp`, analysis survives a retag, and duplicates are listed.

## As built

- **`audio_fp` is filled by the scan itself** (`scan::read_track`), not by a separate background
  pass: the scan already opens every file, and the print reads ~64 KiB. This also keeps it fresh
  when audio is replaced at the same path. A file that cannot be printed stores `''` (never
  retried every scan, never joins). A failed read never overwrites a good print with `''`.
  `detect_moves` / `apply_move` write it too. A startup task (`fill_audio_fps`) prints tracks
  that still have none (libraries from before this change) and finishes the re-key.
- **Re-key.** On open, an old `analysis` / `cues` (keyed `fingerprint`) is renamed
  `analysis_legacy` / `cues_legacy` and new tables keyed `audio_fp` are created.
  `db::rekey_legacy` (after every scan and after the startup fill) copies each legacy row whose
  track now has an `audio_fp`, through `tracks.fingerprint`, hand edits, grids and waveforms
  included. When every present track has an `audio_fp`, the legacy tables are dropped. Kept:
  rows of tracks in the library. Dropped: rows with no track (orphans from deleted or purged
  songs), and rows of tracks that are missing from disk and never had an `audio_fp`.
  Duplicates with different analyses: the present track's, then the newest, wins.
- **`cues` moved to `audio_fp` too** (it was a column rename plus the same re-key).
- **Carry on retag removed** from `upsert`: the key no longer changes on a retag.
- **`audio_fp_version`** setting is written once (`audioprint::VERSION`, 1) when absent. Nothing
  reads it yet; step 7 owns the remap when it changes.
- **Duplicates notice**: status bar indicator plus a drawer (`src/components/duplicates.tsx`),
  not the audit page. Reveal and move to Trash per file (reuses `fs_trash`). Query:
  `db::duplicate_groups`, command `list_duplicates`. Empty `audio_fp` never counts as a duplicate.
- **One entry per `audio_fp` in playlists**: applied to `playlist_tracks`, the playlist count and
  the USB export members (first position wins). Tag playlists, smart playlists and the
  library list still show every file. USB export playlists built elsewhere are not deduplicated.
- `ExportTrack.fingerprint` and `usb_export::Source.fingerprint` are now `audio_fp`.
