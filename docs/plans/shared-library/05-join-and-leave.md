# Step 5: join and leave

Estimate: ½ day.

## One shared library per device

- One local database belongs to at most one shared library (`settings.shared_target_id`).
  Every other destination is files-only.
- Destination list and Sync tab: a **Shared library** badge on that destination, **Files only**
  on the rest.
- Joining another one opens "Leave *X* to join *Y*?".

## Joining

Adding a destination (or turning on sharing for one) reads `.manplay/library.json`.

**Library found** — dialog shows its name, members (from `devices/`) and last change:

| Choice | Effect |
|---|---|
| **Join and merge** | My items become shared; name clashes go to the Clashes list (step 4). |
| **Join, keep mine local** | I receive everything shared; my existing items become `local`. |
| **Join and replace mine** | Drop my tags and playlists, take theirs. Confirm first. |
| **Files only** | Don't join; `.manplay/` is never read or written. |

**No library** — "Start a shared library here?": **Yes** (writes `library.json`, my items
become shared) or **Files only**.

Joining loads the newest snapshot, then logs after it (step 6), then writes
`devices/<me>.json`.

## Leaving

| Choice | Effect |
|---|---|
| **Keep a copy (snapshot)** | Pull once for the latest state, then every shared item becomes `local`. |
| **Keep only my local items** | Remove shared items from this device. |

Either way: stop reading and writing `.manplay/`, delete `devices/<me>.json`. My log chunks stay
until the next compaction covers them. My past edits stay in the library for others.

Re-joining later: the kept copies clash with the shared items, and **Combine** resolves them.

## Tests

- Each join choice produces the right scopes.
- Files-only never touches `.manplay/`.
- Leave with snapshot keeps every item as local.

## Done when

A second device can join an existing library through the dialog and leave it without losing
data.

## As built

Code: `src-tauri/src/libsync/membership.rs` (inspect, join, ensure, leave), `sync.rs`
(`inspect_library`, `join_library`, `leave_library`, the `.manplay/` file calls of `LogStore`),
`src/components/shared-library.tsx` (dialogs, badge, Sync tab row), `device-settings.tsx`.

Differences from the plan above:

- **Membership is `sync_targets.libsync`**, not `settings.shared_target_id`: the switch's column
  from step 2 now means "this destination holds my library". The library's id and name are in
  `settings.library_id` / `library_name`. The "Library data" switch and `set_target_libsync` as a
  command are gone; the db function stays as the join's last step.
- **`ChunkStore`** got `read_meta`, `write_meta`, `delete_meta`, `list_meta` for the small files
  under `.manplay/` (the in-memory store in the tests implements them and counts calls, so tests
  can show a destination was never touched).
- **Files** written: `library.json` `{format, libraryId, name, createdAt}`, `.ignore` (empty),
  `devices/<id>.json` `{name, lastSeen, analysisVersion}` (analysis version is `analysis::VERSION`,
  for step 6). The device file is rewritten at the start of every sync (that is `lastSeen`). The
  dialog's "last change" is the newest `lastSeen` of the members: there is no per-op timestamp
  to read without downloading chunks.
- **Snapshots** do not exist yet (step 6): joining loads every chunk from the start, as a sync
  does.
- **Join** order: (Start only) write `library.json` and `.ignore`, then the local changes in one
  transaction, then `set_target_libsync` (seeds), then one sync and the device file. A failure in
  that first sync is reported in the result but the device is joined; the next sync repeats it.
  - Merge: nothing changes locally; mine that are `shared` are sent, same names become clashes.
  - Keep mine local: every tag, playlist and smart playlist gets scope `local` first. BPM, key,
    beat grids and Tag Database values are still shared (they have no scope).
  - Replace: deletes all my tags, playlists and smart playlists (local ones too, the confirm says
    how many), their ops and registers, and the cursors, then joins. Songs, files and BPM/key
    are untouched. A rescan can make tags from file tags again.
  - Files only: no backend call at all. The only read before the choice is `library.json` and
    `devices/`.
- **Adding a destination** opens the join dialog first (then the Pull drawer), unless the device
  is already in a library; the destination is then files only and the Sync tab has "Join or
  start…". Turning sharing on for an existing destination is the same button.
- **One library per device**: joining while in another is refused by the backend; the dialog
  first shows "Leave X to join Y?" (the leave choices), then the join dialog.
- **Leave** runs one last sync first (sends my edits, pulls theirs). If the destination cannot be
  reached the leaving stops and the dialog offers "Leave without syncing". Then in one transaction:
  - Keep a copy: shared items become `local` with **new uids** (rules of smart playlists follow),
    so joining again meets them as clashes, never as the same item.
  - Keep only my local items: shared tags, playlists, smart playlists and their members are
    deleted. A local smart playlist that used a shared tag then shows "Unknown tag".
  - Both: the op log, registers, cursors, clashes and unknown ops are cleared, `libsync` is off,
    the library id/name settings go, and `devices/<me>.json` is deleted (best effort). BPM, key
    and grids stay as plain values; waveforms are marked to be checked again on a later join.
- **Removing a destination, or changing its folder,** leaves its library with a copy and without
  asking it (before, changing the folder only switched the switch off and left the op state).
- **Device name**: `settings.device_name`, default the computer's name (`scutil --get
  ComputerName` on macOS, `COMPUTERNAME` on Windows, else `hostname`). Settings, "This device".
- **Badges**: "Shared library" / "Files only" in the destination list and on the Sync tab.
- **Existing users with the switch on** are treated as joined. At their next library sync
  (`membership::ensure`) the device adopts the `library.json` it finds, or writes one named
  after the destination (with `.ignore`), then writes its device file. Nothing is re-sent or
  re-scoped. Until that sync the Sync tab shows the destination's name for the library.
- **A destination that now holds another library** (different `libraryId` than the one this
  device joined) stops the sync with an error asking to leave and join again.

Breaking changes to stored data: none to old formats. New settings keys `library_id`,
`library_name`, `device_name` (additive); a destination's `library.json` and `devices/` are new
files under `.manplay/`. Old builds ignore them. The user-visible change is that the Library data
switch is replaced by the join / leave flow.

Known gaps: two devices that both carry over at the same moment can each write a
`library.json` (step 7); a stale `devices/<id>.json` stays if its device never leaves; the member
list has no "remove device"; Replace does not stop a rescan from recreating tags from file tags.

## The library folder as the library's home

A shared library can also live in the library folder itself (`<library folder>/.manplay/`, same
files as on a destination), for a folder several computers open: a network share, or a folder a
sync app copies around.

- **Home**: `membership::Home` is `Target(id)` (`sync_targets.libsync`) or `Folder`
  (`settings.library_in_folder = "1"`). Still one library per device.
- **Store**: `libsync/folder.rs` (`FolderStore`). Every file is written under a dot-named temp
  name and renamed; chunks are never replaced. The sync lock is `.manplay/sync.lock` as on a
  destination, created with a hard link (or create-new where links are refused)
  (`sync::lock::acquire_folder`).
- **Detecting**: `FolderLibraryWatch` (mounted in `__root.tsx`) reads the folder's
  `library.json` and `devices/` when the device is in no library. If another computer is a
  member it opens the join dialog once per library (dismissal kept in `localStorage`).
- **Sharing**: Settings → Shared library → Library folder → "Share or join…" (Start).
- **Syncing**: `libsync_run_folder` at launch, every minute and when the window comes back
  (`useFolderLibrarySync`). Waveforms move after each run like after a destination sync.
- **Changing the library folder** leaves the old folder's library with a copy, like removing a
  destination.

Breaking changes: none. New setting `library_in_folder` (additive).
