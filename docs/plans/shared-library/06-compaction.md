# Step 6: compaction, tombstones, Recently deleted

Estimate: ½ day.

## Snapshots

- Trigger: after a sync, if the remote logs (all devices) total more than ~2 MB gzipped.
- Write `.manplay/snapshot/<device>-<clock>.jsonl.gz`:
  - Line 1, header: `{"v":1,"format":1,"covers":{"<device>":<seq>, ...},"clock":"..."}`.
  - Then one op per live field (the current winner), plus tombstones.
- Readers use the newest snapshot by `clock`, then chunks past `covers` per device.
- Two devices compacting at once is fine: both snapshots are valid; the newer wins.
- Older snapshots are deleted by their writer once a newer one exists.

## Log cleanup

Each device deletes **its own** chunks at or below its `covers` entry in the newest snapshot.
Nobody deletes another device's files, except:

- Devices with no `devices/<id>.json` and no chunk newer than 90 days: their chunks are deleted by
  whoever compacts, once a snapshot covers them.

## Tombstones and Recently deleted

- `_delete` ops are kept as tombstones for 90 days, then dropped from snapshots.
- A device offline for more than 90 days reloads from the snapshot and discards its unsent ops
  older than the snapshot's tombstone horizon. Accepted risk: it may bring back items deleted
  while it was away; Recently deleted makes that visible.
- **Recently deleted** (sidebar, under Organise): shared items deleted in the last 90 days, who
  deleted them and when, with **Restore** (writes a new create with the old uid).

## Waveform cleanup

Compaction also removes waveform files whose `audio_fp` no destination track has, and old
analysis versions no device uses (`devices/<id>.json` lists the analysis version).

## Tests

- Snapshot + newer chunks rebuilds the same tables as replaying everything.
- A device only deletes its own chunks.
- Restore brings back an item with its memberships.

## Done when

After years of simulated edits, `.manplay/` minus waveforms stays near the size of one snapshot.

## As built

Code: `src-tauri/src/libsync/snapshot.rs` (format, build, load, heal), `compact.rs` (trigger,
cleanup, waveform cleanup), `recent.rs` (Recently deleted, Restore), `remote.rs` (the sync reads
a snapshot first), `membership.rs` (`run_joined_at` compacts after a sync), the destination half
of `ChunkStore` in `sync.rs`, `src/components/recently-deleted.tsx`, `sidebar-deleted.tsx`.

Differences from the plan above:

- **File name** is `snapshot/<clock>.jsonl.gz` (the writer's clock already holds its device ID), so
  names sort by time and a writer finds its own. The header also has `horizon` (UTC ms): tombstones
  older than it are not in the file.
- **Trigger.** After a successful sync, when the chunks *past the newest snapshot's `covers`* add
  up to more than 2 MB gzipped (not all chunks: other devices delete theirs later, and counting
  them would make every device compact again). `ChunkStore::list_chunks` now returns sizes. A
  device holds back when a newer snapshot than the one it knows is on the destination (its next
  sync reads that first), and writes nothing when it has applied nothing the newest one lacks.
- **Content.** One op per register in `op_state` (live values, tombstones, merges), plus
  `op_unknown`. Unknown entities and fields are carried as they are. Smart playlist rules have
  merged tags replaced by their target, so they stay right once `_merge` is dropped.
- **Reading.** Before it uploads or downloads, a sync lists `snapshot/` (one listing). A snapshot
  it has not seen is downloaded once; if some device's cursor is behind its `covers` (a new
  device, a device behind removed chunks, a device that just did Replace) the snapshot is applied
  like ops and the cursors jump to `covers`. The newest snapshot this device knows is in
  `settings.libsync_snapshot`. An unreadable newest snapshot falls back to the next older one.
- **Gaps.** Step 2's "a missing chunk stops that device" still holds, but before stopping the reader
  looks through every snapshot for one that covers the hole and applies it (this is what saves a
  device when two snapshots were written at once and the newer one covers less). Cursors only move
  forward now. A new chunk's number is never one a snapshot covers, so numbers are not reused
  after a device removed its chunks.
- **Deleting.** A device removes its own chunks up to the *lowest* `covers` of all snapshots present
  (usually one), and its own snapshots that are not the newest. It does nothing when a snapshot
  cannot be read. Whoever writes a snapshot also removes chunks of devices with no member file
  whose newest chunk is older than 90 days (the age is the newest op clock in it, since a listing
  has no timestamps), up to `covers`.
- **Tombstones.** `_delete` and `_merge` older than 90 days are dropped from snapshots with every
  register of that entity (its name, its memberships). Removed memberships (`present: false`) and
  hand-made values removed from the Tag Database are dropped the same way. A restore marker
  (below) older than 90 days is dropped on its own.
- **Away over 90 days.** A device whose last complete sync (`settings.libsync_last_sync`) is older
  than the snapshot's `horizon` starts over when it loads that snapshot: its unsent ops older than
  the horizon are discarded, registers older than the horizon that the snapshot lacks are
  forgotten, and the shared rows are rebuilt from what is left (shared items that are gone are
  removed; local items, hidden marks and analysis rows stay). A device that has never synced
  (a new join) keeps its unsent ops.
- **Restore** cannot be "a new create with the old uid": `_delete` wins over every later edit. A
  restore writes the item again (name, rules, songs with their positions) and a `_delete` op whose
  value is `false`, which replaces the tombstone (`state::is_dead` reads the newest `_delete`).
  Older builds ignore the value and keep the item deleted. Made-private items (a `_delete` for the
  old uid) also show in the list.
- **Recently deleted** is a page (`/deleted`) with a sidebar row under Organise, shown while the
  device is in a shared library. Names of other members come from `devices/` (cached in
  `libsync_devices` after each sync); a member that has since left shows as "Another device".
- **Waveform cleanup** runs only when a snapshot was written. A file is removed when no analysis op
  and no local track mentions its `audio_fp` (a destination's audio files cannot be listed from
  here), or when its version is used by no device (`devices/<id>.json`, plus this one) and is not
  the version in that song's analysis ops. It is skipped when any device file lacks an analysis
  version, and when some chunk is not applied yet (a waveform is uploaded after the chunk that
  names it, so an unapplied chunk may be what makes a new file look like an orphan).
- **Library format.** A device does not compact when `library.json` has a newer `format` (step 7
  repeats this).
- WebDAV writes snapshots as `<name>.part` and renames them.

Breaking changes to stored data: none to old formats. New files under `.manplay/snapshot/`; a new
local table `libsync_devices`; new settings `libsync_snapshot`, `libsync_last_sync`; a `_delete`
op can now carry `false` (restore). Chunks of devices that have compacted are removed from the
destination, so a build from before this step that joins later finds a hole and cannot read past
it (it has no snapshot reader).

Known gaps: the 2 MB trigger is untested against a real destination; a destination is listed for
snapshots on every sync (one more request); two devices compacting within the same few seconds
can both write (safe, the newer wins, the older one's writer removes it); orphan waveforms of
audio that some analysis op still names are never removed; Recently deleted keeps no record of
tags removed by "Make private" apart from listing them like deletes.
