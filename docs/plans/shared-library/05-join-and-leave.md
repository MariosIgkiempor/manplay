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
