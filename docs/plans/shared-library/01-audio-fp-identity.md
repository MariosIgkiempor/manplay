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
