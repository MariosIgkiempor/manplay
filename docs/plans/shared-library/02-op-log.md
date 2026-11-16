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
