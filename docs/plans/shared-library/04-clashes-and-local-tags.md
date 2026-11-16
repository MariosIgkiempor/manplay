# Step 4: clashes, local tags, shared↔local

Estimate: 1 day.

## Clashes

A clash is two items of the same kind with the same name: a local one and an incoming shared
one, or two shared ones created at once on different devices.

- Detected when applying a `name` op. The incoming item is applied under a held name and a row
  goes into a local `clashes` table.
- UI: a **Clashes** list on the Sync tab with a count badge in the sidebar. Per clash:

| Choice | Effect |
|---|---|
| **Combine** | Merge into the shared item. For a local item: its memberships become shared; a confirm dialog lists what will be shared. For two shared items: writes `_merge` (A into B); every device repoints A's memberships to B. |
| **Rename mine** | Type a new name; mine keeps its scope. |
| **Rename shared** | Type a new name for the shared item; everyone gets it. |

- Until resolved, both items show in the sidebar, the held one with a warning marker.
- Tag names are paths (`Genre/House`): renaming a parent renames children, which can clash too;
  each clash is listed on its own.

## Smart playlists that use local tags

When sharing a smart playlist, or making a tag local while a shared smart playlist uses it, show
a dialog listing the local tags involved. Per tag: **Share tag too** or **Remove rule**; or
**Cancel**.

## Shared ↔ local

| Action | Effect |
|---|---|
| Local → shared | Write create ops for the item and all its memberships. |
| Shared → local | Confirm "This removes it for everyone else". Write `_delete`; keep a local copy (new local `uid`). |
| Hide | Local flag only; others keep it. Unhide any time. |

UI: an item's context menu gets **Share** / **Make private** / **Hide**, and the item shows a
small icon for local (lock) or shared (people).

## Tests

- Local "Techno" meets incoming shared "Techno": clash recorded, nothing merged.
- `_merge` on two devices converges to one item with both sets of memberships.
- Sharing a smart playlist with a local tag is blocked until resolved.

## Done when

Every clash case above can be resolved from the UI, and no private item is shared without a
confirm.
