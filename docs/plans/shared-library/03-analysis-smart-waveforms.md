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

## As built

Code: `libsync/entities.rs` (replay of smart playlists, `tag_custom`, analysis), `libsync/waveforms.rs`
(push, fetch, fill), `libsync/seed.rs`, `Batch` methods in `libsync/write.rs`, rule conversion in
`db.rs` and `smart.rs`, the waveform half of `LogStore` in `sync.rs`.

Differences from the plan above:

- **Smart playlist rules.** Stored and shared rules name tags by uid, but the editor and the
  matching code still see tag names: `db::smart_playlists` turns uids into names on read and
  `save_smart_playlist` turns names into uids on write. `smart.rs` and `smart-rules.ts` keep their
  shape. A uid this device has no tag for (a tag that is local to another device, or deleted)
  reaches the editor as `?<uid>`, shows as "Unknown tag", matches nothing and is saved back as the
  same uid. Entities: `smart_playlist`, id = uid, fields `name`, `rules` (the rules object),
  `_delete`. Same-named smart playlists are allowed (no clash handling).
- **Existing saved rules** (names) are converted at open (`convert_smart_rules`): a name that is a
  tag here (ignoring case) becomes its uid, a name that is no tag stays as a name (it matched
  nothing before and still does not). Nothing is dropped. Safe to repeat.
- **Renaming or merging a tag** gives the target a new uid (step 2), so `migrate_tags` repoints
  every smart playlist that used the old uid to the new one and writes a `rules` op for shared
  ones. A tag deleted on one device while another device's rules still use it leaves `?<uid>`
  there until step 4/7 add `_merge`.
- **"This device only"** is shown on the *Added* filter (it counts when a song reached this
  device). The rule is still shared; other devices count their own dates. Tags and tempo are
  shared. Cues are not a rule type, so nothing else is marked. Step 4 owns the dialog for shared
  playlists that use local tags.
- **Analysis ops** use more fields than the plan: besides `bpm`, `key`, `grid_bpm`, `first_beat`,
  `bar_offset` (the automatic result) there are `duration`, `version` (the analysis version, which
  names the waveform file), `bpm_hand`, `key_hand`, `grid_hand` (`{grid_bpm, first_beat,
  bar_offset}`) and the flags `bpm_edited`, `key_edited`, `grid_edited`. A hand edit writes its hand
  register and raises the flag; while a flag is up the hand value shows whatever the clocks say.
  A new automatic result never touches the hand registers; "replace edits" writes the flag as
  `false`. Local columns keep the value that shows (hand or automatic) as before.
  Failed analyses are not shared. Analysis ops are written by `store_analysis`, `set_tempo_key`,
  `mark_grid_edited` and the grid saved while exporting to a drive.
- **Analysis rows are only made for songs the library has.** Ops for other audio wait in
  `op_state`; `materialize_pending` (after a scan) applies them.
- **`tag_custom`**: id `<field>/<lower-case value>`, fields `name` (the spelling) and `present`,
  because values compare ignoring case.
- **Waveform files** are as planned (`.manplay/waveforms/<ab>/<audio_fp>-v<version>.bin`, 1 MB cap,
  HEAD before write, first writer wins) with these choices:
  - `ChunkStore` got `waveform_exists`, `read_waveform` and `write_waveform`; the in-memory store
    in the tests implements them. A row with version 0 (only hand edits, or a waveform made while
    exporting) uses the current analysis version in the name.
  - Local column `analysis.wf_pushed` (additive) records "known on the destination"; it is reset
    when a waveform is stored and when sharing is switched on.
  - Push runs at the end of each library data run, at most 200 files per run (the rest in the
    next sync). Fill: after each sync a background task fetches up to 500 waveforms, 100 ms apart,
    for songs that have a version from ops but no waveform. Lazy fetch: `track_analysis` (library
    detail and player) asks the destination when a song has an analysis but no waveform, and
    `analyze_tracks` fetches before it decides to analyse, so songs analysed elsewhere are not
    analysed again. Files not found are remembered until the next sync (`Misses`).
  - A row made from ops has `version` but no waveform, so the status bar counts it as not analysed
    until the waveform arrives.
- **Seeding.** `seed::seed` covers the new entities; `seed::catch_up` (run at open, once, guarded
  by `settings.libsync_seeded`) gives a library that already shared tags and playlists in step 2
  their smart playlists, values and analysis without resending the whole log.

Breaking changes to stored data: smart playlist rules JSON changes from names to uids (migrated at
open, nothing dropped, see above); `analysis` gets a column (additive). Old builds reading a new
database would show uids as tag names in smart playlists.

Known gaps: the shared analysis ignores `error`; a tag that other devices' rules use and that is
deleted elsewhere stays unresolved; analysis rows re-keyed from a legacy table after sharing was
switched on are not sent until the next switch-on; orphan waveform files are left for step 6.
