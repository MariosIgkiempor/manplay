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
