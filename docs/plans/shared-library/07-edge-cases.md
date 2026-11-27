# Step 7: edge cases

Estimate: 1 day. Some of these land earlier, inside the step they touch; the rest are here.

## Identity

| Case | Handling |
|---|---|
| Ops arrive for audio not downloaded yet | Keep them pending; apply when the track appears (step 2). Never drop. |
| Re-encode (MP3 → FLAC) gives a new `audio_fp` | On replace/import of a same-named file, offer "Carry over tags and playlists": writes ops moving memberships and analysis to the new `audio_fp`. |
| Two files with one `audio_fp` | Duplicates notice (step 1). |
| Fingerprint algorithm change | `audio_fp_version` in `settings` and `library.json`. A change ships a `remap` op chunk (old → new) written by the first upgraded device; older apps refuse to sync until updated. |

## Devices and clocks

| Case | Handling |
|---|---|
| Clock far ahead (laptop set a year ahead) | Reject ops whose clock is more than 10 min past the newest clock already on the destination and this device's UTC time. Show "This device's clock is wrong". |
| Cloned device ID (copied app data, restored backup) | On sync, if the remote already has chunk seqs this device doesn't know, make a new device ID and re-upload unsent ops under it. |
| Half-written file on WebDAV | Write to `<name>.part`, then `MOVE`. Readers skip `.part` and ignore a trailing partial line. |
| Mixed app versions | Unknown entities/fields are stored and kept, never dropped, including in snapshots. A device refuses to compact if `library.json` `format` is newer than it knows. |
| Two shared libraries | Not allowed: one per device (step 5). |

## Semantics

| Case | Handling |
|---|---|
| Delete vs edit at the same time | Delete wins; Recently deleted can restore (step 6). |
| Rename a parent tag while someone adds a child | Tags are paths (`Genre/House`). The child keeps the old parent path; `restore_tag_parents` recreates the parent. Shows as a separate tag to tidy up, not lost. |
| Smart playlist rules by name | Store tag uids (step 3). |
| `export_selections` stores integer ids | Switch to uids, or USB selections break when ids differ across devices. |
| Same file's tags edited on two devices | File-level three-way merge (step 0). |

## Tests

One test per row where it can be faked: skewed clock rejected, cloned ID detected, `.part`
files ignored, unknown op kept through a snapshot.

## Done when

Every row above has a test or a manual check written down in the PR.

## As built

Code: `libsync/skew.rs` (clock cap), `identity.rs` (cloned IDs), `remap.rs` (fingerprint change),
`carry.rs` (re-encode), `membership.rs` (`ensure`: format and fingerprint gates, `library.json`
race), tests in `libsync/tests/edge.rs`.

| Row | Handled where | Test |
|---|---|---|
| Ops for audio not downloaded yet | `op_state` + `apply::materialize_pending` (step 2) | `memberships_wait_for_songs_that_arrive_later` |
| Re-encode, new `audio_fp` | `carry.rs`; found by `db::upsert` (`audio_changes`, same path) or same folder and name with another extension. Drawer under the status bar notice "N re-encoded songs": "Carry over tags and playlists" / "Leave them". Moves tag and playlist memberships (same place), hand-set BPM, key and grid, and cues; writes ordinary ops | `a_re_encoded_song_can_take_...`, `audio_replaced_in_place_is_noticed_...` |
| Two files, one `audio_fp` | Duplicates notice (step 1) | step 1 tests |
| Fingerprint algorithm change | `library.json` `audioFpVersion`; `remap::remap_tracks` (local move + one `audio_fp_remap` op per song), `remap::apply_pair` on receipt; `lib.rs::reprint_audio_fps` runs it at start when `audioprint::VERSION` is above `settings.audio_fp_version`. A device on an older build or not yet re-printed refuses to sync, with a message | `a_new_audio_fingerprint_is_remapped_and_older_builds_wait` |
| Clock far ahead | `skew::screen`: an op more than 10 min past both this device's UTC time and the newest applied op of other devices is held in `op_future`, not applied, retried every sync. The holder lists the writer in its `devices/<id>.json` (`skewed`); the writer shows "This device's clock is wrong" in the sync result. After the clock is fixed, `skew::restamp` re-stamps its future ops, re-sends them and writes a `clock_reset` op that voids the held copies | `ops_a_day_ahead_...`, `a_device_whose_clock_is_a_year_ahead_...` |
| Cloned device ID | `identity::check`: chunks under this ID past the newest one this install uploaded (`settings.libsync_sent`) holding ops it never made. New ID, unsent ops re-stamped under it, the other copy's chunks read as another device's. Own chunks whose ops are all known (stopped before recording the upload) are adopted instead | `a_copied_device_id_is_replaced_...`, `an_upload_that_was_never_recorded_...` |
| Half-written file | `.part` then `MOVE` for chunks and snapshots (`sync.rs::LogStore`); readers skip non-chunk names; `remote::decode` counts an unreadable line instead of failing | `a_half_written_last_line_and_part_files_are_ignored`, `chunks_round_trip_...` |
| Mixed app versions | Unknown entities and fields stored and forwarded, newer-version ops set aside (step 2/6). `library.json` `format` newer than `LIBRARY_FORMAT`: no join, no sync, no compaction | `unknown_ops_are_kept_in_snapshots`, `a_library_of_a_newer_format_is_neither_joined_nor_synced`, `compaction_leaves_a_library_of_a_newer_format_alone` |
| Two shared libraries | One per device (step 5) | `a_device_in_one_library_cannot_join_another` |
| Two devices writing `library.json` | After writing it (start, carry-over) the device reads it again and goes by what is there (last write stands) | `two_devices_starting_a_library_at_once_...` |
| Delete vs edit | `_delete` wins; Restore (step 6) | `delete_beats_concurrent_and_later_edits` |
| Rename parent while a child is added | The child is a tag of its own; the parent comes back at the next start (`restore_tag_parents`) | `a_child_added_under_a_renamed_parent_...` |
| Smart rules by tag uid | step 3; a tag deleted elsewhere is now dropped from the rules on every device (`entities::drop_dead_tag`, `materialize_smart_rules`; locally `db::drop_smart_rule_tag`) | `a_tag_deleted_elsewhere_leaves_no_unknown_tag_...` |
| `export_selections` | Playlists and smart playlists stored as uids; the API still gives row ids (`db::ids_from_stored`). Old integer ids are converted at open (`migrate_selection_uids`) | `export_selections_keep_playlists_by_uid_...` |
| Same file edited on two devices | Three-way merge (step 0) | step 0 tests |

Also fixed from earlier steps: analysis rows that come back from the old tables after sharing
started are sent (`seed::send_missing_analysis`, test `analysis_moved_from_the_old_tables_...`);
the local `oplog` is pruned of uploaded rows a snapshot covers (new column `oplog.seq`, in
`compact::clean_up`, test `the_local_log_forgets_what_a_snapshot_holds`).

Breaking changes to stored data: `export_selections.playlists` / `smart` hold uids instead of
integer ids (migrated at open; a playlist that no longer exists is dropped). Additive: `oplog.seq`,
tables `op_future`, `audio_changes`, `carry_dismissed`, settings `libsync_sent`,
`libsync_clock_wrong`; `library.json` gains `audioFpVersion`, member files gain `skewed` (older
builds ignore both). An older build opening a migrated database would not find its selections.

Known gaps: a device that read `library.json` in the milliseconds before another write replaced it
stops with "another shared library" and must leave and join again; ops already applied before a
device's clock went wrong are not undone; the 10 minute cap cannot tell a device whose clock is
behind (its ops lose ties but are not held); songs missing from disk are not re-printed by a
fingerprint change, so their old shared edits keep the old name; a re-encode under another name
or folder is not found; oplog rows uploaded before `seq` existed are never pruned; the remap and
reprint path has no real algorithm change to run on yet (`VERSION` is 1), only tests.
