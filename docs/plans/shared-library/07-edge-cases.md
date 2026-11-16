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
| `export_selections` stores integer ids | Switch to uids, or USB/rekordbox selections break when ids differ across devices. |
| Same file's tags edited on two devices | File-level three-way merge (step 0). |

## Tests

One test per row where it can be faked: skewed clock rejected, cloned ID detected, `.part`
files ignored, unknown op kept through a snapshot.

## Done when

Every row above has a test or a manual check written down in the PR.
