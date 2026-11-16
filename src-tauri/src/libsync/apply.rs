//! Replay: turns winning ops into rows of `tags`, `track_tags`, `playlists` and
//! `playlist_tracks`.
//!
//! Applying never reads the tables it writes to decide *what* is true, only the register store
//! (`op_state`), so any order of the same ops ends in the same rows. The one local choice is two
//! shared items with the same name: they are the same item, and the row keeps the lowest uid.

use std::collections::BTreeSet;

use rusqlite::{Connection, OptionalExtension, params};

use super::ops::{Entity, F_NAME, F_POS, F_PRESENT, FORMAT, Op, member_id};
use super::state;
use crate::error::Error;

#[derive(Clone, Copy)]
struct Kind {
    table: &'static str,
    entity: &'static str,
    member_entity: &'static str,
    member_table: &'static str,
    member_col: &'static str,
}

const TAGS: Kind = Kind {
    table: "tags",
    entity: "tag",
    member_entity: "track_tag",
    member_table: "track_tags",
    member_col: "tag_id",
};

const PLAYLISTS: Kind = Kind {
    table: "playlists",
    entity: "playlist",
    member_entity: "playlist_track",
    member_table: "playlist_tracks",
    member_col: "playlist_id",
};

struct Row {
    id: i64,
    uid: String,
    name: String,
    scope: String,
}

fn find(conn: &Connection, kind: Kind, column: &str, value: &str) -> Result<Option<Row>, Error> {
    Ok(conn
        .query_row(
            &format!(
                "SELECT id, COALESCE(uid, ''), name, scope FROM {} WHERE {column} = ?1",
                kind.table
            ),
            params![value],
            |r| {
                Ok(Row {
                    id: r.get(0)?,
                    uid: r.get(1)?,
                    name: r.get(2)?,
                    scope: r.get(3)?,
                })
            },
        )
        .optional()?)
}

/// Applies ops read from other devices. Run it inside a transaction.
pub fn apply_ops(conn: &Connection, ops: &[Op]) -> Result<usize, Error> {
    let mut tags = BTreeSet::new();
    let mut playlists = BTreeSet::new();
    let mut members: BTreeSet<(Entity, String, String)> = BTreeSet::new();
    let mut won = 0;
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
        if !state::put(conn, op)? {
            continue;
        }
        won += 1;
        match op.entity() {
            Entity::Tag => {
                tags.insert(op.id.clone());
            }
            Entity::Playlist => {
                playlists.insert(op.id.clone());
            }
            e @ (Entity::TrackTag | Entity::PlaylistTrack) => {
                if let Some((parent, fp)) = op.id.split_once('/') {
                    members.insert((e, parent.to_owned(), fp.to_owned()));
                }
            }
            _ => {}
        }
    }
    let mut touched = BTreeSet::new();
    for uid in &tags {
        materialize_item(conn, TAGS, uid, true, &mut touched)?;
    }
    for uid in &playlists {
        materialize_item(conn, PLAYLISTS, uid, true, &mut touched)?;
    }
    for (entity, parent, fp) in &members {
        let kind = if *entity == Entity::TrackTag {
            TAGS
        } else {
            PLAYLISTS
        };
        materialize_member(conn, kind, parent, fp, &mut touched)?;
    }
    for id in touched {
        renumber(conn, id)?;
    }
    Ok(won)
}

/// Brings the row of one tag or playlist in line with its registers.
fn materialize_item(
    conn: &Connection,
    kind: Kind,
    uid: &str,
    follow: bool,
    touched: &mut BTreeSet<i64>,
) -> Result<(), Error> {
    let existing = find(conn, kind, "uid", uid)?;
    if existing.as_ref().is_some_and(|r| r.scope != "shared") {
        return Ok(());
    }
    let name = state::get_str(conn, kind.entity, uid, F_NAME)?;
    let name = match name {
        Some(name) if !state::is_dead(conn, kind.entity, uid)? => name,
        _ => {
            if let Some(r) = existing {
                conn.execute(
                    &format!("DELETE FROM {} WHERE id = ?1", kind.table),
                    params![r.id],
                )?;
                if follow {
                    reconsider(conn, kind, &r.name, touched)?;
                }
            }
            return Ok(());
        }
    };
    let same_name = find(conn, kind, "name", &name)?;
    match (existing, same_name) {
        (Some(r), _) if r.name == name => {}
        (Some(r), other) if other.as_ref().is_none_or(|o| o.id == r.id) => {
            conn.execute(
                &format!("UPDATE {} SET name = ?1 WHERE id = ?2", kind.table),
                params![name, r.id],
            )?;
            if follow {
                reconsider(conn, kind, &r.name, touched)?;
            }
        }
        (None, None) => {
            conn.execute(
                &format!(
                    "INSERT INTO {} (uid, name, scope) VALUES (?1, ?2, 'shared')",
                    kind.table
                ),
                params![uid, name],
            )?;
            rematerialize_members(conn, kind, uid, touched)?;
        }
        (this, Some(other)) => {
            clash(conn, kind, this, &other, uid, &name, touched)?;
            rematerialize_members(conn, kind, uid, touched)?;
        }
        // Not reachable: a row with no other holder of the name is renamed above.
        (Some(_), None) => {}
    }
    Ok(())
}

/// Two uids with one name: the lower uid keeps the row and the other becomes an alias of it.
fn clash(
    conn: &Connection,
    kind: Kind,
    this: Option<Row>,
    other: &Row,
    uid: &str,
    name: &str,
    touched: &mut BTreeSet<i64>,
) -> Result<(), Error> {
    // A local item is never merged into; step 4 gives the user a say.
    if other.scope != "shared" {
        return Ok(());
    }
    if other.uid.as_str() < uid {
        if let Some(r) = this {
            move_members(conn, kind, r.id, other.id)?;
            conn.execute(
                &format!("DELETE FROM {} WHERE id = ?1", kind.table),
                params![r.id],
            )?;
            touched.insert(other.id);
        }
    } else if let Some(r) = this {
        move_members(conn, kind, other.id, r.id)?;
        conn.execute(
            &format!("DELETE FROM {} WHERE id = ?1", kind.table),
            params![other.id],
        )?;
        conn.execute(
            &format!("UPDATE {} SET name = ?1 WHERE id = ?2", kind.table),
            params![name, r.id],
        )?;
        touched.insert(r.id);
    } else {
        conn.execute(
            &format!("UPDATE {} SET uid = ?1 WHERE id = ?2", kind.table),
            params![uid, other.id],
        )?;
    }
    Ok(())
}

fn move_members(conn: &Connection, kind: Kind, from: i64, to: i64) -> Result<(), Error> {
    if kind.table == "tags" {
        conn.execute(
            "INSERT OR IGNORE INTO track_tags (track_id, tag_id)
             SELECT track_id, ?1 FROM track_tags WHERE tag_id = ?2",
            params![to, from],
        )?;
    } else {
        conn.execute(
            "INSERT OR IGNORE INTO playlist_tracks (playlist_id, track_id, position, pos)
             SELECT ?1, track_id, position, pos FROM playlist_tracks WHERE playlist_id = ?2",
            params![to, from],
        )?;
    }
    Ok(())
}

/// A name was freed (renamed or deleted): another live uid that has it may now take the row.
fn reconsider(
    conn: &Connection,
    kind: Kind,
    name: &str,
    touched: &mut BTreeSet<i64>,
) -> Result<(), Error> {
    let mut stmt =
        conn.prepare("SELECT id, val FROM op_state WHERE e = ?1 AND f = ?2 ORDER BY id")?;
    let rows = stmt.query_map(params![kind.entity, F_NAME], |r| {
        Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?))
    })?;
    let mut candidates = Vec::new();
    for row in rows {
        let (uid, val) = row?;
        let same = serde_json::from_str::<String>(&val).is_ok_and(|v| {
            if kind.table == "tags" {
                v.eq_ignore_ascii_case(name)
            } else {
                v == name
            }
        });
        if same {
            candidates.push(uid);
        }
    }
    drop(stmt);
    for uid in candidates {
        materialize_item(conn, kind, &uid, false, touched)?;
    }
    Ok(())
}

/// The row an item's memberships go to: its own, or for a uid that lost a name clash, the row
/// that took its name.
fn resolve(conn: &Connection, kind: Kind, uid: &str) -> Result<Option<Row>, Error> {
    if state::is_dead(conn, kind.entity, uid)? {
        return Ok(None);
    }
    if let Some(r) = find(conn, kind, "uid", uid)? {
        return Ok((r.scope == "shared").then_some(r));
    }
    let Some(name) = state::get_str(conn, kind.entity, uid, F_NAME)? else {
        return Ok(None);
    };
    Ok(find(conn, kind, "name", &name)?.filter(|r| r.scope == "shared"))
}

/// Every membership op of one item, applied to its row (it was just created or took over a name).
fn rematerialize_members(
    conn: &Connection,
    kind: Kind,
    uid: &str,
    touched: &mut BTreeSet<i64>,
) -> Result<(), Error> {
    let mut stmt =
        conn.prepare("SELECT id FROM op_state WHERE e = ?1 AND f = ?2 AND id >= ?3 AND id < ?4")?;
    let ids: Vec<String> = stmt
        .query_map(
            params![
                kind.member_entity,
                F_PRESENT,
                format!("{uid}/"),
                format!("{uid}0")
            ],
            |r| r.get(0),
        )?
        .collect::<Result<_, _>>()?;
    drop(stmt);
    for id in ids {
        if let Some((_, fp)) = id.split_once('/') {
            materialize_member(conn, kind, uid, fp, touched)?;
        }
    }
    Ok(())
}

/// Makes the rows for one membership match its registers, for every track with that audio.
/// Nothing happens for a track the library does not have: the register waits.
fn materialize_member(
    conn: &Connection,
    kind: Kind,
    parent: &str,
    audio_fp: &str,
    touched: &mut BTreeSet<i64>,
) -> Result<(), Error> {
    let Some(row) = resolve(conn, kind, parent)? else {
        return Ok(());
    };
    let id = member_id(parent, audio_fp);
    let present = state::get_bool(conn, kind.member_entity, &id, F_PRESENT)? == Some(true);
    let pos = state::get_str(conn, kind.member_entity, &id, F_POS)?;
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
            materialize_member(&tx, kind, parent, fp, &mut touched)?;
        }
    }
    for id in touched {
        renumber(&tx, id)?;
    }
    tx.commit()?;
    Ok(waiting.len())
}
