# Step 8: Jellyfin playlists

Date: 2026-11-19. Status: built (see As built); not yet tried against a live server end to end.
Estimate: 3 days.

Push chosen library playlists to a Jellyfin server as real Jellyfin playlists, made through its
HTTP API. Songs still reach Jellyfin as plain files on a destination; only the playlists go
through the API.

## Why not playlist files

`.m3u8` files in a music library are unreliable across Jellyfin versions: ignored outside the
library root, empty on 10.9.6 (jellyfin#12110), zero tracks on 12.1 (jellyfin#18169), and
typed "Unknown" so some apps hide them. Tried by hand: a `Playlists/` folder did not show up.

## Setup (per device, one server per destination)

On a destination page, a **Jellyfin** section:

| Field | Where it lives |
|---|---|
| Server URL (often a Tailscale name, e.g. `http://nas:8096`) | `jellyfin_servers` table, keyed by destination (`target_id`) |
| API key (Dashboard → API Keys) | OS keychain, `manplay-jellyfin` / `target-<id>` |
| Jellyfin user the playlists belong to | `jellyfin_servers.user_id` (picked from `GET /Users`) |
| Jellyfin library that scans this destination | `jellyfin_servers.library_id` (from `GET /Library/VirtualFolders`) |
| Which playlists | `export_selections`, key `jellyfin:<target id>`, chosen with `ExportChooser` |

**Connect** reads `GET /System/Info`, `GET /Users` and `GET /Library/VirtualFolders` and shows
the server name and version; **Save** reads them again and checks the user and library exist.

Nothing here is shared through the op log: every person can point at their own server and user.

## Choosing playlists (two views, one list)

What goes where is one list per Jellyfin destination (`export_selections`, key
`jellyfin:<target id>`). Two places edit it:

- **Destination page → Playlists:** `ExportChooser`, as rekordbox and USB drives use, with the
  library's playlists, smart playlists and tags.
- **Playlist → Send to Jellyfin:** a picker on each playlist (and smart playlist) listing the
  Jellyfin destinations, ticked where it is in that destination's list.

## Matching songs to Jellyfin items

1. `GET /Items?ParentId=<library>&Recursive=true&IncludeItemTypes=Audio&Fields=Path` (paged).
2. Each item's `Path` is compared with the song's destination path (`sync::Item.rel`) by
   **suffix**: the last N segments must equal `rel`. No path-prefix setting is needed, and it
   works whatever the server calls the mount (`/media/music`, `D:\Music`).
3. Both sides are NFC-normalised, lower-cased (like `sync::folded`) and split on `/` and `\`
   (macOS file names are NFD; Windows servers use `\`).
4. Several items with the same suffix: pick the one under the folder most other songs matched
   under; still tied, leave it out and report it.
5. Songs on the destination are the ones in `synced_files` for it.

**Check songs** on the Jellyfin section runs this and shows how many synced songs Jellyfin has,
with a few of the missing ones. Items are read fresh each time (20 pages of 1000 for 20k songs);
a cache can come later if that is slow.

## Pushing

Runs after a destination sync finishes uploading, and from a **Push playlists** button.

1. New songs uploaded this run: `POST /Library/Media/Updated {Updates: [{Path, UpdateType:
   "Created"}]}` with their server paths (library `Locations` from `GET /Library/VirtualFolders`
   joined with `rel`). When the library has several locations, or that request fails, fall back
   to `POST /Items/<library>/Refresh?Recursive=true`. Then poll the library's `RefreshStatus` and
   `GET /Items` (every 5 s, up to 2 min) until those paths appear.
2. Per chosen playlist, build the ordered list of Jellyfin item ids. Songs not on the
   destination or not yet scanned are left out and counted ("3 songs waiting for Jellyfin").
   Smart playlists are worked out at push time; tag playlists the same way as for rekordbox.
3. Find the Jellyfin playlist: by the stored id (`jellyfin_playlists`: target id, playlist uid,
   Jellyfin id); else by exact name among the user's playlists (adopt, so a second device does
   not make a duplicate); else `POST /Playlists` with a JSON body `{Name, Ids, UserId,
   MediaType: "Audio"}` (query parameters are obsolete); the reply is `{Id}`.
4. Existing playlist with different songs: `GET /Playlists/<id>/Items?userId=…` for its
   entries (`PlaylistItemId`), `DELETE /Playlists/<id>/Items?entryIds=…` for all of them, then
   `POST /Playlists/<id>/Items?ids=…&userId=…` with the new list in order. This removes entries
   only, never files. Unchanged: no request.
   `POST /Playlists/<id>` (update) is not used: with an API key it fails with
   `400 Error processing request.` (tested on 12.4.0; it likely needs a signed-in user).
5. Renamed in manplay: create the playlist under the new name with its songs, then delete the
   old one (guarded as below). Its `jellyfin_playlists` row moves to the new id.
6. A playlist taken out of the selection, or deleted in manplay: `DELETE /Items/<id>`, only for
   playlists manplay made or adopted (has a `jellyfin_playlists` row).

**`DELETE /Items/<id>` deletes from the library and the filesystem.** Given a song's id it
deletes the audio file on the server. So:

- Jellyfin ids are typed per kind in Rust (`JellyfinPlaylistId`, `JellyfinAudioId`); the delete
  function only takes `JellyfinPlaylistId`.
- Right before deleting, `GET /Items?ids=<id>&includeItemTypes=Playlist` must return exactly
  that one playlist, or nothing is deleted.
- `DELETE /Items?ids=…` (bulk) is never called.

## Review and backup

The destructive-actions rule applies to replacing and deleting playlists on the server.

- The push shows a review first: **New 2 · Updated 3 · Removed 1 · Adopted 1**, with a
  per-playlist songs added and removed list. An adopted playlist (made outside manplay) is
  flagged in orange.
- Before any update or delete, the playlist's current name and item ids are saved to
  `<app data>/jellyfin-backups/<server>/<unix time>-<id>.json`. **Restore** re-creates it.
  Pruned like `sync::prune_backups`.

## Shared libraries

- Playlists come from the shared tables, so every member device builds the same item lists
  once their op logs agree. Two devices pushing to the same Jellyfin user converge: the last
  push wins, and the next push from the other device is a no-op.
- Playlist uids are shared, so `jellyfin_playlists` rows line up across devices; name adoption
  covers a device that never pushed before.
- Local-only playlists can be chosen too; they are just not on other devices.

## Code

| What | Where |
|---|---|
| HTTP client, DTOs (serde, validated), auth header `Authorization: MediaBrowser Token="…"` | new `src-tauri/src/jellyfin.rs` |
| Matching, plan, apply, backups | new `src-tauri/src/jellyfin/push.rs` |
| Tables `jellyfin_servers`, `jellyfin_playlists`, `jellyfin_items` | `db.rs` (additive) |
| Keychain entry | `jellyfin.rs`, same pattern as `r2.rs::entry` |
| Commands (save server, test, plan push, apply push, restore) | `lib.rs` |
| Zod schemas, wrappers, queries | `src/lib/api.ts`, `src/lib/queries.ts` |
| Destination section, review dialog | new `src/components/jellyfin-section.tsx`, `src/routes/export.*.tsx` |

## Tests

- Dataset: path suffix matching (NFD vs NFC, `\` vs `/`, same file name in two albums, deeper
  server mount, missing song).
- Dataset: plan from (manplay lists, Jellyfin state) → new / updated / unchanged / removed /
  adopted.
- DTO parsing against recorded JSON from a real server (12.4) as fixtures.
- Delete guard: an audio id, an unknown id, and a playlist id that the server reports as another
  type are all refused without a `DELETE` request.
- Apply against a fake server (local HTTP test server): backups are written before every
  update and delete.

## Checked against the server's OpenAPI spec (Jellyfin 12.4.0)

- Auth: an `Authorization` header (`MediaBrowser Token="<key>"`).
- `CreatePlaylistDto` {Name (required), Ids, UserId, MediaType, Users, IsPublic};
  `UpdatePlaylistDto` {Name, Ids, Users, IsPublic}, null fields kept.
- `BaseItemDto` has `Path`, `PlaylistItemId`, `Etag`, `MediaType`.
- `POST /Library/Refresh` and `POST /Items/<id>/Refresh` need an admin key.
- `GET /Playlists/<id>/Items` returns `PlaylistItemId` per entry.

## Tested on the live server (12.4.0, admin API key)

| Call | Result |
|---|---|
| `GET /Items?…&Fields=Path` | `Path` is the server's full path, e.g. `/Volumes/KINGSTON/media/music/…` |
| `POST /Playlists` (JSON body) | creates it with the given songs |
| `POST /Playlists/<id>` with `Ids` | `400 Error processing request.`, playlist unchanged |
| `POST /Playlists/<id>/Items?ids=…&userId=…` | 204, songs appended in order |
| `DELETE /Playlists/<id>/Items?entryIds=…` | 204, entry removed, file untouched |

Oldest server version to support: 12.4 for now; older versions untested.

## Breaking changes

None: three new tables and new keychain entries.

## As built

Connection settings (Settings tab of a destination → **Jellyfin**):
`src-tauri/src/jellyfin.rs` (`ServerUrl`, `ApiKey`, `Jellyfin::server`, keychain),
`db.rs` (`jellyfin_servers`, `jellyfin_settings`, `save_jellyfin`, `remove_jellyfin`),
`lib.rs` (`jellyfin_settings`, `jellyfin_probe`, `jellyfin_save`, `jellyfin_forget`; removing a
destination forgets its key), `src/lib/api.ts`, `src/components/jellyfin-section.tsx`.

Song matching: `src-tauri/src/jellyfin/matching.rs` (`match_songs`), `Jellyfin::audio_items`
(pages of 1000), `db::synced_track_paths`, command `jellyfin_check_songs`, **Songs in Jellyfin**
row with **Check songs**.

Choosing playlists: commands `jellyfin_destinations`, `jellyfin_set_selection`,
`jellyfin_server_playlists` (the **In Jellyfin** tab); `src/components/jellyfin-playlists.tsx`
(**Playlists → Choose…** drawer with `ExportChooser`); `src/components/jellyfin-menu.tsx`
(**Send to Jellyfin: <destination>** rows in the ⋯ menu of playlist, smart playlist and tag pages,
through `CollectionHeader.menuExtra`); `toggleSelection` in `src/lib/export-selection.ts`.
Removing a destination deletes its `jellyfin:<id>` selection; Disconnect keeps it.

Pushing: `src-tauri/src/jellyfin/push.rs` (`plan`, `Planned::needs_review`, `Row`, `Summary`),
`Jellyfin::{playlist_entries, create_playlist, add_songs, remove_entries, delete_playlist,
report_new_files}` (`delete_playlist` checks the id is exactly one `Playlist` first; ids are
`PlaylistId`, never `AudioId`), table `jellyfin_playlists` and `jellyfin_servers.last_push*`,
commands `jellyfin_plan` (kept in `AppState.jellyfin_plans`) and `jellyfin_push` (sends exactly
the reviewed plan), `jellyfin_after_sync` (spawned by `sync_apply`: tells Jellyfin about chosen
songs it lacks, waits up to 2 minutes for its scan, then sends creates and refills of playlists
manplay made; renames, removals and take-overs wait), backups in
`<app data>/jellyfin-backups/<unix time>/<target>-<playlist>.json`, pruned after 30 days.
UI: **Send playlists** row and review drawer in `src/components/jellyfin-push.tsx`.

Who sees them: **Visible to** on the Jellyfin section (`jellyfin::Visibility`: only the owner,
`IsPublic` for everyone, or `Users` with `CanEdit: false`), sent when a playlist is made and
stored per sent playlist (`jellyfin_playlists.visibility`). Sharing cannot be changed with an API
key, so a playlist made for other people than now chosen is made again and the old one deleted
(`Action::Reshare`, waits for a review). Taken-over playlists keep their own sharing.

Not built: a **Restore** button for the backups (the files hold the name and song ids).

## Steps

| # | What | Status |
|---|---|---|
| 1 | Connection settings | built |
| 2 | Match songs, **Check songs** | built |
| 3 | Choose playlists: destination chooser and per-playlist picker | built |
| 4 | Push plan and review | built |
| 5 | Apply: create, refill, rename, guarded delete, backups | built |
| 6 | Push after each sync, and a **Review and send…** button | built |

## Done when

Choosing two playlists on a destination and syncing makes them appear in Jellyfin's Playlists
tab with the right songs in order; editing one in manplay and syncing again updates it; removing
it from the selection deletes it, after the review, with a backup.
