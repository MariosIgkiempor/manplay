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

## As built

Code: `libsync/clashes.rs` (list, resolve, migrate), `libsync/share.rs` (share, make private, hide,
local-tag dialog data), `libsync/apply.rs` (clash detection, `_merge`), `src/components/clashes.tsx`,
`item-sharing.tsx`, `src/lib/use-item-sharing.tsx`.

Differences from the plan above:

- **Detection** is in `apply::materialize_item`, for tags, playlists and smart playlists. An
  incoming name that another row already has is applied under `<name> (shared)` (or
  `(shared 2)`, …) and a row goes into `clashes (kind, name, keeps, held)`. The stopgap of step 2
  (merge by name into the lowest uid, alias, hide the shared item behind a local one) is gone. A
  held item keeps its own memberships; nothing merges until the user chooses.
- **Who holds the name.** A local item always keeps it. Between two shared items the lower uid
  keeps it, so every device lists the same one as held. A held item whose name becomes free (the
  other was renamed, deleted, merged, made private) takes it on the next `settle`, which runs after
  every replay and after local renames and deletes.
- **Combine** for a local item against a shared one: the local songs are written as memberships of
  the shared item (after a confirm that says how many), the local row goes, and smart playlists
  that used it use the shared tag. For two shared items it writes `_merge` (held into the one that
  keeps the name) and the songs of the merged one are copied to the target as ordinary
  membership ops, so a later removal on the target wins by clock. Two smart playlists: the local
  one is dropped, or the shared pair is merged (no rules are combined).
- **`_merge`** works like a tombstone for the source and redirects: replay follows merge chains
  for memberships (a late edit of the merged uid lands on the target; the newest register of the
  target and its sources wins) and for the `tag` uids inside smart playlist rules (`entities::
  materialize_smart_rules`, `repoint_rules`), on every device. Renaming or merging a tag
  (`migrate_tags`) now writes `_merge` old to new instead of `_delete`, which closes step 3's gap
  (`?<uid>` in the rules of a device that had not heard of a rename). A plain delete still leaves
  `?<uid>` in other devices' rules. `op_state` got a small partial index for `_merge`.
- **Rename** is by uid and for one side of the clash: a local item is renamed here; a shared one
  gets a `name` op (everyone gets it). Tags carry the levels below them *of the same side*
  (`House` with `House/Deep`); a clash on a child level is its own entry, as planned.
- **Rename mine / Rename shared** are labelled by scope of each side, so two shared items
  both read "Rename shared".
- **Hide** is `hidden` on the row (column from step 2). Hidden items leave the sidebar and are
  listed under "N hidden" in each group, with Unhide. Hidden tags still appear in pick lists.
- **Make private** keeps the same row: new uid, `scope = 'local'`, `_delete` for the old uid. Only
  that tag is made private, not the levels below it. A tag used by shared smart playlists needs
  "Remove rule" (the backend refuses otherwise); other devices' local playlists using it show
  `?<uid>`.
- **Smart playlist dialog** has the same three outcomes in both directions (Share tag too /
  Remove rule / Cancel), in the Share dialog, when a rule picks a local tag in a shared smart
  playlist (the editor asks before the rule is kept), and when making a tag private (there it is
  "Remove rule" or cancel, since "Share tag too" is not making it private). The backend also
  refuses to save a shared smart playlist over local tags.
- **Confirms.** Nothing private is shared without one: Share, Combine with a local item, "Share
  tag too", and merging a local tag into a shared one by renaming (its confirm now says the songs
  become visible). Switching library data on still shares only items whose scope is `shared`.
- **Marks.** Lock / people show only while some destination has library data on; the warning mark
  on a held item always shows. Share and Make private are in the menu always, so scope can be set
  before switching sharing on.
- **Sidebar.** A "Clashes" row with the count under Sync (opens the destination's Sync tab) and a
  dot on the collapsed Export icon. The list itself is under the Library data row of the sync
  destination that has it on.

Existing aliases from step 2 (names merged without asking): on first open `clashes::migrate`
(once, `settings.libsync_clashes`) re-applies every named tag, playlist and smart playlist from the
register store. The uid that lost the name comes back as a row under a held name, so the merge is
now a clash to settle; the songs the winner took from it stay on the winner row until you combine.
Nothing is dropped.

Breaking changes to stored data: a new local table `clashes` and an index on `op_state` (additive);
`oplog`/`op_state` unchanged in shape. Tag/playlist/smart lists gain `scope`, `hidden`, `held`
(read only). An older build opening the database ignores the new table; a newer device's `_merge`
op is stored as before by older devices but has no effect there (they would show the merged tag
twice).

Known gaps: "Combine all" is not there (each clash is settled on its own, and two devices that
both set up the same tag tree get one clash per level); making a tag private does not carry its
subtags; a tag deleted (not merged) elsewhere still leaves `?<uid>` in rules; a clash is only
listed on devices that have applied both items.
