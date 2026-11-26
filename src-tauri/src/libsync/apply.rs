//! Replay: turns winning ops into rows of `tags`, `track_tags`, `playlists`, `playlist_tracks`
//! and `smart_playlists`.
//!
//! Applying never reads the tables it writes to decide *what* is true, only the register store
//! (`op_state`), so any order of the same ops ends in the same rows. The one local choice is two
//! items with one name: the name stays with one of them and the other is applied under a held
//! name, with a row in `clashes` for the user to settle (see `clashes.rs`).

use std::collections::BTreeSet;

use rusqlite::{Connection, OptionalExtension, params};

use super::entities;
use super::ops::{Entity, F_DELETE, F_MERGE, F_NAME, F_POS, F_PRESENT, FORMAT, Op, member_id};
use super::state;
use crate::error::Error;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Kind {
    pub table: &'static str,
    pub entity: &'static str,
    pub member_entity: &'static str,
    pub member_table: &'static str,
    pub member_col: &'static str,
}

pub const TAGS: Kind = Kind {
    table: "tags",
    entity: "tag",
    member_entity: "track_tag",
    member_table: "track_tags",
    member_col: "tag_id",
};

pub const PLAYLISTS: Kind = Kind {
    table: "playlists",
    entity: "playlist",
    member_entity: "playlist_track",
    member_table: "playlist_tracks",
    member_col: "playlist_id",
};

/// Smart playlists have a name and rules but no members.
pub const SMARTS: Kind = Kind {
    table: "smart_playlists",
    entity: "smart_playlist",
    member_entity: "",
    member_table: "",
    member_col: "",
};

impl Kind {
    /// The name `clashes.kind` uses.
    pub fn label(self) -> &'static str {
        self.entity
    }

    pub fn from_label(label: &str) -> Option<Self> {
        [TAGS, PLAYLISTS, SMARTS]
            .into_iter()
            .find(|k| k.entity == label)
    }

    fn has_members(self) -> bool {
        !self.member_entity.is_empty()
    }
}

pub struct Row {
    pub id: i64,
    pub uid: String,
    pub name: String,
    pub scope: String,
}

fn row_from(r: &rusqlite::Row<'_>) -> rusqlite::Result<Row> {
    Ok(Row {
        id: r.get(0)?,
        uid: r.get(1)?,
        name: r.get(2)?,
        scope: r.get(3)?,
    })
}

pub fn find(
    conn: &Connection,
    kind: Kind,
    column: &str,
    value: &str,
) -> Result<Option<Row>, Error> {
    Ok(conn
        .query_row(
            &format!(
                "SELECT id, COALESCE(uid, ''), name, scope FROM {} WHERE {column} = ?1",
                kind.table
            ),
            params![value],
            row_from,
        )
        .optional()?)
}

/// Applies ops read from other devices. Run it inside a transaction.
pub fn apply_ops(conn: &Connection, ops: &[Op]) -> Result<usize, Error> {
    let mut won = Vec::new();
    for op in ops {
        if op.v > FORMAT {
            conn.execute(
                "INSERT OR IGNORE INTO op_unknown (clock, op) VALUES (?1, ?2)",
                params![
                    op.clock,
                    serde_json::to_string(op).map_err(|e| Error::Msg(e.to_string()))?
                ],
            )?;
            continue;
        }
        if state::put(conn, op)? {
            won.push(op);
        }
    }
    materialize(conn, &won)?;
    Ok(won.len())
}

/// Rebuilds the rows `ops` are about from the register store, which must already hold them.
pub fn materialize(conn: &Connection, ops: &[&Op]) -> Result<(), Error> {
    let mut items: BTreeSet<(&'static str, String)> = BTreeSet::new();
    let mut merges: BTreeSet<(&'static str, String)> = BTreeSet::new();
    let mut members: BTreeSet<(Entity, String, String)> = BTreeSet::new();
    let mut customs = BTreeSet::new();
    let mut analyses = BTreeSet::new();
    let mut remaps: Vec<(String, String)> = Vec::new();
    let mut deleted_tags: BTreeSet<String> = BTreeSet::new();
    let mut resets: Vec<(String, i64)> = Vec::new();
    for op in ops {
        match op.entity() {
            e @ (Entity::Tag | Entity::Playlist | Entity::SmartPlaylist) => {
                let kind = match e {
                    Entity::Tag => TAGS,
                    Entity::Playlist => PLAYLISTS,
                    _ => SMARTS,
                };
                items.insert((kind.entity, op.id.clone()));
                if op.f == F_MERGE {
                    merges.insert((kind.entity, op.id.clone()));
                }
                if op.f == F_DELETE && kind.table == TAGS.table {
                    deleted_tags.insert(op.id.clone());
                }
            }
            e @ (Entity::TrackTag | Entity::PlaylistTrack) => {
                if let Some((parent, fp)) = op.id.split_once('/') {
                    members.insert((e, parent.to_owned(), fp.to_owned()));
                }
            }
            Entity::TagCustom => {
                customs.insert(op.id.clone());
            }
            Entity::Analysis => {
                analyses.insert(op.id.clone());
            }
            // Recorded only: no file is moved or removed from what another device wrote.
            Entity::File => {}
            Entity::Other(name) => {
                if name == super::remap::E_REMAP
                    && let Some(new) = op.val.as_str()
                {
                    remaps.push((op.id.clone(), new.to_owned()));
                } else if name == super::skew::E_RESET
                    && let Some(ms) = op.val.as_i64()
                {
                    resets.push((op.id.clone(), ms));
                }
            }
        }
    }
    for (dev, ms) in &resets {
        super::skew::release(conn, dev, *ms)?;
    }
    // The audio fingerprint algorithm changed: what is known about the old audio is about the new.
    for (old, new) in &remaps {
        for (entity, parent) in super::remap::apply_pair(conn, old, new)? {
            let entity = Entity::parse(&entity);
            members.insert((entity.clone(), parent.clone(), new.clone()));
            members.insert((entity, parent, old.clone()));
        }
        analyses.insert(new.clone());
    }
    for id in &customs {
        entities::materialize_custom(conn, id)?;
    }
    for fp in &analyses {
        entities::materialize_analysis(conn, fp)?;
    }
    let mut touched = BTreeSet::new();
    for (entity, uid) in &items {
        if let Some(kind) = Kind::from_label(entity) {
            materialize_item(conn, kind, uid, &mut touched)?;
            if kind.entity == SMARTS.entity {
                entities::materialize_smart_rules(conn, uid)?;
            }
        }
    }
    for uid in &deleted_tags {
        if state::is_dead(conn, "tag", uid)? {
            entities::drop_dead_tag(conn, uid)?;
        } else {
            entities::rematerialize_rules_using(conn, uid)?;
        }
    }
    for (entity, uid) in &merges {
        if let Some(kind) = Kind::from_label(entity) {
            merged(conn, kind, uid, &mut touched)?;
        }
    }
    for (entity, parent, fp) in &members {
        let kind = if *entity == Entity::TrackTag {
            TAGS
        } else {
            PLAYLISTS
        };
        materialize_member(conn, kind, parent, fp, &mut touched)?;
    }
    settle(conn, &mut touched)?;
    for id in touched {
        renumber(conn, id)?;
    }
    Ok(())
}

/// What an item is called according to the registers: `None` when it is gone (deleted or merged
/// away) or was never named.
fn live_name(conn: &Connection, kind: Kind, uid: &str) -> Result<Option<String>, Error> {
    if state::is_dead(conn, kind.entity, uid)? {
        return Ok(None);
    }
    state::get_str(conn, kind.entity, uid, F_NAME)
}

/// The row that has `name` and is not `uid` itself.
fn holder_of(conn: &Connection, kind: Kind, name: &str, uid: &str) -> Result<Option<Row>, Error> {
    Ok(conn
        .query_row(
            &format!(
                "SELECT id, COALESCE(uid, ''), name, scope FROM {}
                 WHERE name = ?1 AND COALESCE(uid, '') <> ?2
                 ORDER BY scope = 'local' DESC, uid LIMIT 1",
                kind.table
            ),
            params![name, uid],
            row_from,
        )
        .optional()?)
}

/// Whether an incoming shared tag simply takes over `holder`: a local tag with no songs of its
/// own and no local tags below it, such as a parent level recreated on this device before the
/// shared one arrived. Nothing private is in it, so there is nothing to ask about.
fn adopts(conn: &Connection, kind: Kind, holder: &Row) -> Result<bool, Error> {
    if kind.table != TAGS.table || holder.scope != "local" {
        return Ok(false);
    }
    let private: bool = conn.query_row(
        "SELECT EXISTS (SELECT 1 FROM track_tags WHERE tag_id = ?1)
             OR EXISTS (SELECT 1 FROM tags WHERE scope = 'local'
                        AND lower(substr(name, 1, length(?2) + 1)) = lower(?2 || '/'))",
        params![holder.id, holder.name],
        |r| r.get(0),
    )?;
    Ok(!private)
}

/// `<name> (shared)`, or with a number when that is taken.
fn held_name(conn: &Connection, kind: Kind, name: &str) -> Result<String, Error> {
    let mut n = 1;
    loop {
        let candidate = if n == 1 {
            format!("{name} (shared)")
        } else {
            format!("{name} (shared {n})")
        };
        if find(conn, kind, "name", &candidate)?.is_none() {
            return Ok(candidate);
        }
        n += 1;
    }
}

/// Drops an item's row and its clash entry. Whoever it held the name against is promoted by the
/// next `settle`.
fn remove_row(conn: &Connection, kind: Kind, row: &Row) -> Result<(), Error> {
    conn.execute(
        &format!("DELETE FROM {} WHERE id = ?1", kind.table),
        params![row.id],
    )?;
    conn.execute(
        "DELETE FROM clashes WHERE kind = ?1 AND held = ?2",
        params![kind.label(), row.uid],
    )?;
    Ok(())
}

fn record_clash(
    conn: &Connection,
    kind: Kind,
    name: &str,
    keeps: &str,
    held: &str,
) -> Result<(), Error> {
    conn.execute(
        "INSERT INTO clashes (kind, name, keeps, held) VALUES (?1, ?2, ?3, ?4)
         ON CONFLICT(kind, held) DO UPDATE SET name = excluded.name, keeps = excluded.keeps",
        params![kind.label(), name, keeps, held],
    )?;
    Ok(())
}

/// Puts `row` (which has the contested `name`) under a held name, against `keeps`.
fn hold(conn: &Connection, kind: Kind, row: &Row, name: &str, keeps: &str) -> Result<(), Error> {
    let already: bool = conn.query_row(
        "SELECT EXISTS (SELECT 1 FROM clashes WHERE kind = ?1 AND held = ?2 AND name = ?3)",
        params![kind.label(), row.uid, name],
        |r| r.get(0),
    )?;
    if !already {
        let held = held_name(conn, kind, name)?;
        conn.execute(
            &format!("UPDATE {} SET name = ?1 WHERE id = ?2", kind.table),
            params![held, row.id],
        )?;
    }
    record_clash(conn, kind, name, keeps, &row.uid)
}

/// Brings the row of one tag, playlist or smart playlist in line with its registers. A name
/// someone else already has is not taken: see `hold`.
pub fn materialize_item(
    conn: &Connection,
    kind: Kind,
    uid: &str,
    touched: &mut BTreeSet<i64>,
) -> Result<(), Error> {
    let existing = find(conn, kind, "uid", uid)?;
    if existing.as_ref().is_some_and(|r| r.scope != "shared") {
        return Ok(());
    }
    let Some(name) = live_name(conn, kind, uid)? else {
        if let Some(r) = existing {
            remove_row(conn, kind, &r)?;
        }
        return Ok(());
    };
    let holder = holder_of(conn, kind, &name, uid)?;
    if existing.is_none()
        && let Some(h) = holder.as_ref()
        && adopts(conn, kind, h)?
    {
        conn.execute(
            &format!(
                "UPDATE {} SET uid = ?1, scope = 'shared' WHERE id = ?2",
                kind.table
            ),
            params![uid, h.id],
        )?;
        super::entities::repoint_rules(conn, &h.uid, uid)?;
        conn.execute(
            "DELETE FROM clashes WHERE kind = ?1 AND (held = ?2 OR keeps = ?2)",
            params![kind.label(), h.uid],
        )?;
        rematerialize_members(conn, kind, uid, touched)?;
        return Ok(());
    }
    // Between two shared items the lower uid keeps the name, so every device lists the same one
    // as held.
    let takes_name = holder
        .as_ref()
        .is_none_or(|h| h.scope == "shared" && h.uid.as_str() > uid);
    if let Some(h) = holder.as_ref().filter(|_| takes_name) {
        hold(conn, kind, h, &name, uid)?;
        conn.execute(
            "UPDATE clashes SET keeps = ?3 WHERE kind = ?1 AND keeps = ?2",
            params![kind.label(), h.uid, uid],
        )?;
    }
    if !takes_name {
        let keeps = holder.as_ref().map(|h| h.uid.clone()).unwrap_or_default();
        if let Some(r) = existing {
            hold(conn, kind, &r, &name, &keeps)?;
        } else {
            conn.execute(
                &format!(
                    "INSERT INTO {} (uid, name, scope) VALUES (?1, ?2, 'shared')",
                    kind.table
                ),
                params![uid, held_name(conn, kind, &name)?],
            )?;
            record_clash(conn, kind, &name, &keeps, uid)?;
            rematerialize_members(conn, kind, uid, touched)?;
        }
        return Ok(());
    }
    conn.execute(
        "DELETE FROM clashes WHERE kind = ?1 AND held = ?2",
        params![kind.label(), uid],
    )?;
    match existing {
        Some(r) if r.name == name => {}
        Some(r) => {
            conn.execute(
                &format!("UPDATE {} SET name = ?1 WHERE id = ?2", kind.table),
                params![name, r.id],
            )?;
        }
        None => {
            conn.execute(
                &format!(
                    "INSERT INTO {} (uid, name, scope) VALUES (?1, ?2, 'shared')",
                    kind.table
                ),
                params![uid, name],
            )?;
            rematerialize_members(conn, kind, uid, touched)?;
        }
    }
    Ok(())
}

/// Re-examines every held item: one whose name is free again (the other item was renamed,
/// deleted, merged or made private) takes it, and a clash entry whose item is gone is dropped.
pub fn settle(conn: &Connection, touched: &mut BTreeSet<i64>) -> Result<(), Error> {
    for _ in 0..8 {
        let before = clash_signature(conn)?;
        if before.is_empty() {
            return Ok(());
        }
        let held: Vec<(String, String)> = conn
            .prepare("SELECT kind, held FROM clashes ORDER BY id")?
            .query_map([], |r| Ok((r.get(0)?, r.get(1)?)))?
            .collect::<Result<_, _>>()?;
        for (kind, uid) in held {
            let Some(kind) = Kind::from_label(&kind) else {
                continue;
            };
            if find(conn, kind, "uid", &uid)?.is_none() {
                conn.execute(
                    "DELETE FROM clashes WHERE kind = ?1 AND held = ?2",
                    params![kind.label(), uid],
                )?;
            } else {
                materialize_item(conn, kind, &uid, touched)?;
            }
        }
        if clash_signature(conn)? == before {
            break;
        }
    }
    Ok(())
}

fn clash_signature(conn: &Connection) -> Result<Vec<(String, String, String, String)>, Error> {
    Ok(conn
        .prepare("SELECT kind, name, keeps, held FROM clashes ORDER BY kind, held")?
        .query_map([], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)))?
        .collect::<Result<_, _>>()?)
}

/// `from` was merged into another item: its row goes, everything that pointed at it points at
/// the target (memberships here, smart playlist rules for tags).
pub fn merged(
    conn: &Connection,
    kind: Kind,
    from: &str,
    touched: &mut BTreeSet<i64>,
) -> Result<(), Error> {
    materialize_item(conn, kind, from, touched)?;
    let to = state::merge_target(conn, kind.entity, from)?;
    if to == from {
        return Ok(());
    }
    if kind.has_members() {
        rematerialize_members(conn, kind, &to, touched)?;
    }
    if kind.table == "tags" {
        entities::repoint_rules(conn, from, &to)?;
    }
    Ok(())
}

/// Makes every shared tag, playlist and smart playlist the registers name have its row, as after
/// replaying everything again. Used once for libraries that merged same-named items by name
/// before clashes existed: the item that lost then comes back as a clash to settle.
pub fn rematerialize_all(conn: &Connection) -> Result<(), Error> {
    let mut touched = BTreeSet::new();
    for kind in [TAGS, PLAYLISTS, SMARTS] {
        let uids: Vec<String> = conn
            .prepare("SELECT DISTINCT id FROM op_state WHERE e = ?1 AND f = ?2 ORDER BY id")?
            .query_map(params![kind.entity, F_NAME], |r| r.get(0))?
            .collect::<Result<_, _>>()?;
        for uid in uids {
            materialize_item(conn, kind, &uid, &mut touched)?;
        }
    }
    settle(conn, &mut touched)?;
    for id in touched {
        renumber(conn, id)?;
    }
    Ok(())
}

/// The row an item's memberships go to: its own, or for a merged one the row of what it was
/// merged into.
fn resolve(conn: &Connection, kind: Kind, uid: &str) -> Result<Option<Row>, Error> {
    let target = state::merge_target(conn, kind.entity, uid)?;
    if state::is_dead(conn, kind.entity, &target)? {
        return Ok(None);
    }
    Ok(find(conn, kind, "uid", &target)?.filter(|r| r.scope == "shared"))
}

/// Every membership op of one item and of what was merged into it, applied to its row (it was
/// just created or took a merge).
pub fn rematerialize_members(
    conn: &Connection,
    kind: Kind,
    uid: &str,
    touched: &mut BTreeSet<i64>,
) -> Result<(), Error> {
    if !kind.has_members() {
        return Ok(());
    }
    let mut parents = vec![uid.to_owned()];
    parents.extend(state::merge_sources(conn, kind.entity, uid)?);
    let mut stmt =
        conn.prepare("SELECT id FROM op_state WHERE e = ?1 AND f = ?2 AND id >= ?3 AND id < ?4")?;
    let mut fps = BTreeSet::new();
    for parent in &parents {
        let ids: Vec<String> = stmt
            .query_map(
                params![
                    kind.member_entity,
                    F_PRESENT,
                    format!("{parent}/"),
                    format!("{parent}0")
                ],
                |r| r.get(0),
            )?
            .collect::<Result<_, _>>()?;
        fps.extend(
            ids.iter()
                .filter_map(|id| id.split_once('/'))
                .map(|(_, fp)| fp.to_owned()),
        );
    }
    drop(stmt);
    for fp in fps {
        materialize_member(conn, kind, uid, &fp, touched)?;
    }
    Ok(())
}

/// Whether a song is in an item and where, from the newest register among the item and
/// everything merged into it: an edit on the target wins over the copy a merge made, and a late
/// edit of a merged item (from a device that had not heard of the merge) still lands on the target.
fn member_state(
    conn: &Connection,
    kind: Kind,
    target: &str,
    audio_fp: &str,
) -> Result<(bool, Option<String>), Error> {
    let mut parents = vec![target.to_owned()];
    parents.extend(state::merge_sources(conn, kind.entity, target)?);
    let mut present: Option<(String, bool)> = None;
    let mut pos: Option<(String, String)> = None;
    for parent in &parents {
        let id = member_id(parent, audio_fp);
        if let Some((clock, v)) = state::get_clocked(conn, kind.member_entity, &id, F_PRESENT)?
            && present.as_ref().is_none_or(|(c, _)| clock > *c)
        {
            present = Some((clock, v.as_bool() == Some(true)));
        }
        if let Some((clock, v)) = state::get_clocked(conn, kind.member_entity, &id, F_POS)?
            && let Some(v) = v.as_str()
            && pos.as_ref().is_none_or(|(c, _)| clock > *c)
        {
            pos = Some((clock, v.to_owned()));
        }
    }
    Ok((present.is_some_and(|(_, p)| p), pos.map(|(_, p)| p)))
}

/// Makes the rows for one membership match its registers, for every track with that audio.
/// Nothing happens for a track the library does not have: the register waits.
pub fn materialize_member(
    conn: &Connection,
    kind: Kind,
    parent: &str,
    audio_fp: &str,
    touched: &mut BTreeSet<i64>,
) -> Result<(), Error> {
    let Some(row) = resolve(conn, kind, parent)? else {
        return Ok(());
    };
    let (present, pos) = member_state(conn, kind, &row.uid, audio_fp)?;
    let tracks: Vec<i64> = conn
        .prepare_cached("SELECT id FROM tracks WHERE audio_fp = ?1")?
        .query_map(params![audio_fp], |r| r.get(0))?
        .collect::<Result<_, _>>()?;
    for track in tracks {
        match (present, kind.table) {
            (true, "tags") => {
                conn.execute(
                    "INSERT OR IGNORE INTO track_tags (track_id, tag_id) VALUES (?1, ?2)",
                    params![track, row.id],
                )?;
            }
            (true, _) => {
                conn.execute(
                    "INSERT INTO playlist_tracks (playlist_id, track_id, position, pos)
                     VALUES (?1, ?2, 0, ?3)
                     ON CONFLICT(playlist_id, track_id) DO UPDATE SET pos = excluded.pos",
                    params![row.id, track, pos],
                )?;
            }
            (false, _) => {
                conn.execute(
                    &format!(
                        "DELETE FROM {} WHERE {} = ?1 AND track_id = ?2",
                        kind.member_table, kind.member_col
                    ),
                    params![row.id, track],
                )?;
            }
        }
    }
    if kind.table == "playlists" {
        touched.insert(row.id);
    }
    Ok(())
}

/// Sets `position` (what every query orders by) to the rank of each song by its fractional
/// index, ties by `audio_fp`.
pub fn renumber(conn: &Connection, playlist_id: i64) -> Result<(), Error> {
    let mut stmt = conn.prepare(
        "SELECT pt.track_id, pt.position FROM playlist_tracks pt
         JOIN tracks t ON t.id = pt.track_id WHERE pt.playlist_id = ?1
         ORDER BY pt.pos, COALESCE(t.audio_fp, ''), pt.track_id",
    )?;
    let rows: Vec<(i64, i64)> = stmt
        .query_map(params![playlist_id], |r| Ok((r.get(0)?, r.get(1)?)))?
        .collect::<Result<_, _>>()?;
    drop(stmt);
    for (rank, (track, position)) in (0_i64..).zip(rows) {
        if position != rank {
            conn.execute(
                "UPDATE playlist_tracks SET position = ?1 WHERE playlist_id = ?2 AND track_id = ?3",
                params![rank, playlist_id, track],
            )?;
        }
    }
    Ok(())
}

/// Applies memberships that were waiting for a song with that audio, after a scan or a pull
/// brought it in. Returns how many were applied.
pub fn materialize_pending(conn: &mut Connection) -> Result<usize, Error> {
    let tx = conn.transaction()?;
    let n = materialize_pending_in(&tx)?;
    tx.commit()?;
    Ok(n)
}

/// [`materialize_pending`] inside a transaction the caller already has.
pub fn materialize_pending_in(tx: &Connection) -> Result<usize, Error> {
    let mut waiting: Vec<(bool, String)> = Vec::new();
    for (kind, tracks_of) in [
        (
            TAGS,
            "SELECT 1 FROM track_tags tt JOIN tags g ON g.id = tt.tag_id
             JOIN tracks t ON t.id = tt.track_id
             WHERE g.uid = substr(s.id, 1, instr(s.id, '/') - 1) AND t.audio_fp = s.ref",
        ),
        (
            PLAYLISTS,
            "SELECT 1 FROM playlist_tracks pt JOIN playlists g ON g.id = pt.playlist_id
             JOIN tracks t ON t.id = pt.track_id
             WHERE g.uid = substr(s.id, 1, instr(s.id, '/') - 1) AND t.audio_fp = s.ref",
        ),
    ] {
        let sql = format!(
            "SELECT s.id FROM op_state s WHERE s.e = ?1 AND s.f = ?2 AND s.val = 'true'
               AND s.ref IS NOT NULL AND s.ref <> ''
               AND EXISTS (SELECT 1 FROM tracks t WHERE t.audio_fp = s.ref)
               AND NOT EXISTS ({tracks_of})"
        );
        let mut stmt = tx.prepare(&sql)?;
        let ids = stmt.query_map(params![kind.member_entity, F_PRESENT], |r| {
            r.get::<_, String>(0)
        })?;
        for id in ids {
            waiting.push((kind.table == "tags", id?));
        }
    }
    let mut touched = BTreeSet::new();
    for (is_tag, id) in &waiting {
        if let Some((parent, fp)) = id.split_once('/') {
            let kind = if *is_tag { TAGS } else { PLAYLISTS };
            materialize_member(tx, kind, parent, fp, &mut touched)?;
        }
    }
    for id in touched {
        renumber(tx, id)?;
    }
    let analyses = entities::materialize_waiting_analysis(tx)?;
    Ok(waiting.len() + analyses)
}
