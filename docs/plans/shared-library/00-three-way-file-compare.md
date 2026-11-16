# Step 0: three-way file compare

Estimate: 1 day. Independent of the database sync; ships first.

## Problem today

`sync::plan_target` (`src-tauri/src/sync.rs:368`) compares the library file with the destination
copy only. "Who edited" is guessed from the local file's modified time vs `synced_at`
(`sync.rs:857`).

| Edited since last sync | Review shows | Problem |
|---|---|---|
| Only here | Replace, ticked ("Edited here") | fine |
| Only on the destination | Replace, unticked ("Edited on the destination. Tick to overwrite.") | Their edit can never come in: `sync::pull` never overwrites a library file (`sync.rs:1314`). The item reappears every sync. |
| Both | Treated as "Edited here", ticked | Their edit is overwritten. The backup copy is on this machine only. |

The modified-time guess is also wrong after copying or touching a file.

## Change

Keep the **base**: the state of each file at its last successful sync, per destination.

### Database

Add to `synced_files` (local table, keyed `(target_id, track_id)`):

| Column | Type | Meaning |
|---|---|---|
| `local_sig` | TEXT | `local_signature` of the library file right after sync |
| `remote_sig` | TEXT | `remote_signature` of the destination copy right after sync (same value as `local_sig` when they match) |
| `base_tags` | TEXT | JSON of the file's tag fields at sync time (same shape as `tracks.fields` plus title/artist/album) |

Written after every upload, replace, move and pull. Rows from before this change have no base:
treat them as today (two-way) until their next sync writes one.

### Review rules

`L` = library file differs from base, `R` = destination copy differs from base.

| L | R | Action | Ticked |
|---|---|---|---|
| no | no | in sync | — |
| yes | no | Replace (push) | yes |
| no | yes | **Update library** (new `Kind::Update`): download over the library file; the old one goes to the Trash/Recycle Bin first | yes |
| tags only | tags only | **Merge**: per field, take the side that changed; fields changed on both sides need a choice | yes once every field is chosen |
| audio | audio | **Conflict**: pick "keep mine" (push) or "keep theirs" (update) | no |
| no base | — | today's behaviour | — |

Audio changed = the `audio_fp` differs; otherwise a signature difference is a tag edit.

### Merge

1. Read destination tags (the tag-region read in `record_tag_changes` already does this).
2. Three-way merge per field against `base_tags`.
3. Write the merged tags into the library file (`tags.rs` writer), then push it. Both sides end
   with identical files, and the base is updated.

### UI

- Pull side of the Sync tab gets the `Update library` rows, with the existing tag diff view.
- Merge rows show a field table: base, mine, theirs, with a radio per conflicting field.
- Drop the "Edited on the destination. Tick to overwrite." note.

### Apply safety

Keep `ensure_unchanged` (`sync.rs:781`): refuse if the destination changed since review.
`Kind::Update` also refuses if the library file changed since review.

## Tests

- `diff` rules: each row of the table above, with fake signatures.
- Merge: disjoint field edits merge; same-field edits report a conflict; base missing falls back.
- Update: library file is replaced and the old copy is in the trash dir; base is rewritten.

## Done when

Two machines edit different tags of one file, both sync, and both end with both edits.
