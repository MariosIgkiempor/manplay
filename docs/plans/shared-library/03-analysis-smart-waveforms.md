# Step 3: smart playlists, analysis, waveforms

Estimate: 1 day.

## Smart playlists

- Entity `smart_playlist`, fields `name`, `rules`.
- Rules must reference tags by `uid`, not name, so renames don't break them. Convert the rules
  JSON (`src/lib/smart-rules.ts`, `src-tauri/src/smart.rs`) to store tag uids.
- Rules on local-only data (e.g. cues) give different results per device. Mark those rule types
  "this device only" in the rule editor.

## Analysis (grid, BPM, key)

- Entity `analysis`, id `<audio_fp>`, fields `bpm`, `key`, `grid_bpm`, `first_beat`,
  `bar_offset`, plus the `*_edited` flags.
- Automatic analysis results sync too, so a device doesn't re-analyse what another already did.
  A hand edit (`*_edited = 1`) always beats an automatic result, whatever the clocks.
- Cues: **not synced**. `cues` and `cues_edited` stay local.

## `tag_custom`

Entity `tag_custom`, id `<field>/<value>`, field `present`. Shared vocabulary for the Tag
Database pickers.

## Waveforms

Files, not ops: they are big, never edited, and the same audio gives the same waveform.

- Path: `.manplay/waveforms/<first 2 of audio_fp>/<audio_fp>-v<analysis version>.bin`.
- Content: the raw `analysis.waveform` blob. Cap 1 MB; skip larger.
- Push: after analysis, upload if the path doesn't exist yet (HEAD first). First writer wins.
- Pull: lazily, when a track without a local waveform is shown or played; also a background
  fill after sync, throttled.
- Kept out of snapshots and compaction. Orphans (no track with that `audio_fp` on the
  destination) are removed by compaction (step 6).
- A newer analysis version writes a new file; old versions are removed once no device reports
  using them (step 6).

## Tests

- A smart playlist rule survives renaming its tag.
- Hand-edited BPM beats a later automatic one.
- Waveform upload skips existing files; lazy fetch fills `analysis.waveform`.

## Done when

Device A analyses and edits a grid; device B shows the same grid and waveform without
analysing, and A's smart playlists show the same songs on B.
