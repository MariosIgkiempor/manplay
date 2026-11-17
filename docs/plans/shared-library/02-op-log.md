# Step 2: op log, tags and playlists

Estimate: 1 day. First slice: tags and playlists sync between two devices.

## Identity

- New UUIDs (v7, time-ordered) for shareable items: add `uid TEXT UNIQUE` to `tags`,
  `playlists`, `smart_playlists`. Keep the integer `id` as the local row key; ops use `uid`.
- Tracks are referenced by `audio_fp` (step 1).
- Device ID: a UUID made on first launch, stored in `settings` (`device_id`), plus a display name
  (machine name, editable).

## Scope

Add `scope TEXT NOT NULL DEFAULT 'shared'` (`shared` | `local`) to `tags`, `playlists`,
`smart_playlists`, and `hidden INTEGER NOT NULL DEFAULT 0` (shared, but not shown here).

- Local items never write ops. Their memberships (`track_tags`, `playlist_tracks`) take the
  parent's scope.
- New items use the library default (`settings.default_scope`, default `shared`).
- Not joined to a shared library (step 5): nothing writes ops at all.

## Op format

One JSON object per line:

```json
{"v":1,"clock":"001763300000000-0000-<device>","dev":"<device>","e":"playlist","id":"<uid>","f":"name","val":"Warmup"}
```

| Key | Meaning |
|---|---|
| `v` | op format version |
| `clock` | hybrid logical clock: UTC ms (15 digits, zero-padded), counter (4 digits), device ID. Compares as a string. |
| `dev` | writer |
| `e` | entity: `tag`, `playlist`, `playlist_track`, `track_tag`, `smart_playlist`, `tag_custom`, `analysis` |
| `id` | entity key: `uid`; memberships `<parent uid>/<audio_fp>`; `tag_custom` `<field>/<value>`; `analysis` `<audio_fp>` |
| `f` | field, or `_delete`, `_merge` |
| `val` | new value (JSON) |

Entities and fields in this step:

| Entity | Fields |
|---|---|
| `tag` | `name` (full path, e.g. `Genre/House`) |
| `track_tag` | `present` (bool) |
| `playlist` | `name` |
| `playlist_track` | `present` (bool), `pos` (fractional index string) |

Special ops: `_delete` (tombstone, `val` null) and `_merge` (`val` = uid it merges into).

### Rules

- Last writer wins per `(e, id, f)` by `clock`.
- Delete wins over a concurrent edit (an edit with a lower clock than the tombstone is dropped;
  a later edit does not resurrect, it needs an explicit restore).
- Playlist order: `pos` is a fractional index (base-62 strings between neighbours), so concurrent
  inserts never collide. Ties sort by `audio_fp`.
- Ops for an `audio_fp` not in the library yet are stored and applied when the track appears.

### Clock

Hybrid logical clock: `max(now_utc_ms, last_seen_ms)`, counter bumps on ties. Updated from every
op read. Step 7 adds the skew cap.

## Storage

- Local: table `oplog(clock PRIMARY KEY, dev, e, id, f, val, uploaded INTEGER)`. Every shared
  write in `db.rs` goes through one function that updates the row and appends an op in the same
  transaction.
- Remote: each sync uploads unuploaded ops as a new immutable chunk
  `.manplay/log/<device>/<seq>.jsonl.gz` (seq zero-padded). Never append to or rewrite a chunk.
- Applied cursor: table `op_cursor(dev PRIMARY KEY, seq)`: last chunk applied per device.
- Writes: temp name then rename (WebDAV `MOVE`); R2 puts are atomic.

## Sync run

Runs as part of the existing sync, before files:

1. Upload own new ops as one chunk.
2. List `log/*/`; download chunks past each device's cursor; apply in clock order.
3. Rebuild affected rows; refresh queries in the UI.

## Code

- New module `src-tauri/src/libsync/` (`ops.rs` format + apply, `clock.rs`, `remote.rs` chunk
  I/O on the existing `sync::Backend`).
- Frontend: none beyond a "Library data" line in the sync summary (ops sent/received).

## Tests

- Apply is order-independent: shuffled op lists give the same tables.
- LWW per field; delete beats concurrent edit.
- Fractional index: inserting between any two positions always works.
- Two in-memory databases exchanging chunks converge.

## Done when

Device A tags a song and adds it to a playlist, both sync, and device B shows the same tag and
playlist, in the same order.

## As built

Code: `src-tauri/src/libsync/` (`ops.rs`, `clock.rs`, `frac.rs`, `state.rs`, `apply.rs`,
`write.rs`, `seed.rs`, `remote.rs`, `schema.rs`, `tests.rs`); `sync.rs` holds the WebDAV/R2 chunk
store (`LogStore`) and `run_library_data`.

- **Off by default, per destination.** `sync_targets.libsync` (additive column, default 0) and a
  "Library data" switch on the destination's Sync tab. Until some destination has it on, no edit
  writes an op and nothing is created under `.manplay/`. Only one destination can have it on
  (one local log, one cursor set); step 5's join/leave replaces the switch. Changing a
  destination's folder switches it off.
- **Switching on seeds the log** (`seed::seed`): an op for every shared tag, playlist and
  membership that has none, and the whole own log is marked unuploaded and the cursors cleared,
  because the destination may be a new one (replaying is idempotent). Removals made while sharing
  was off are not sent, only what exists now.
- **Op store.** Besides `oplog` (own ops, `uploaded`) and `op_cursor`, a table `op_state` holds
  the winning op per `(e, id, f)` from everyone, with `ref` (the `audio_fp` of a membership).
  Replay writes the registers first, then rebuilds only the affected rows from the registers, so
  order never matters, and ops for songs the library lacks simply wait there: after a scan
  `apply::materialize_pending` applies them. Ops with `v` above 1 go to `op_unknown` untouched;
  unknown entities and fields are stored in `op_state` and forwarded, never applied.
- **One write path.** Edits in `db.rs` collect their ops in a `libsync::Batch` and commit them in
  the same transaction as the row change (`write::record` is the only place an op gets a clock).
  A batch does nothing when sharing is off or the item's `scope` is `local`.
- **Tags.** Each level (`Genre`, `Genre/House`) is its own tag with its own uid, as in the
  tables. Rename/merge (`migrate_tags`) is written as: name op for a new target, `present` ops for
  the moved songs on the target (taken from the local rows and from waiting ops), `_delete` on the
  old tag. `_merge` is in the format but not written yet. Deleting a tag is a tombstone for that
  tag only, as before.
- **Same name, two uids** (two devices created `House`): same item. The row keeps the lowest uid;
  the other uid is an alias whose memberships land on that row. Different case counts as the same
  name for tags. This is a stopgap for step 4's clashes list. A same-named item that is `local`
  is never merged into; the shared one is left out of the tables until step 4.
- **Playlists.** `playlist_tracks.pos` holds the fractional index (base 62, `frac.rs`);
  `position` stays as the song's rank, renumbered after replay, so queries and exports are
  unchanged. Old rows get keys at open. A song whose audio is already in the playlist (another
  copy) joins at the same key and sends nothing. Removing a song removes every copy of its audio
  from that playlist (a playlist holds each audio once).
- **Copies of one audio.** A membership is per `audio_fp`: replay tags or lists every file with
  that audio, but a local edit only touches the file it was made on until the next replay.
- **Device ID** is made on first use (`settings.device_id`, UUID v7). The display name and
  `devices/<id>.json` are left to step 5; `library.json` and `.ignore` too.
- **Chunks.** `.manplay/log/<device>/<seq 8 digits>.jsonl.gz`. WebDAV: written as `<seq>.part`
  then `MOVE`d (never overwrites); R2: one `PUT` after a check that the chunk does not exist. A
  device reads another's chunks only in order without gaps (a missing chunk stops that device
  until it appears) and never reads its own. Crash between upload and marking `uploaded` re-sends
  those ops in the next chunk; replay absorbs it.
- **Run.** The frontend calls `libsync_run` first in a Sync (before pull and push), also when
  nothing else is ticked ("Sync library data"); the result screen has a "Library data" block
  (sent, received, errors). The ops go through `sync::Backend`'s existing calls (`list`, `get`,
  `put`, `rename`, `mkdir`, `remote_size`) via a small async `ChunkStore` trait, so tests use an
  in-memory store.
- **Clock.** `Hlc` kept in `settings.hlc`; the 4-digit counter rolls over into the next
  millisecond instead of overflowing (bulk seeding writes thousands of ops per millisecond).
- **Smart playlists** only got `uid`, `scope`, `hidden` this step (their ops are step 3).
