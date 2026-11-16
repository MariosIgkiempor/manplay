//! The register store behind replay: the newest op per `(entity, id, field)`.

use rusqlite::{Connection, OptionalExtension, params};
use serde_json::Value;

use super::ops::{F_DELETE, F_MERGE, Op};
use crate::error::Error;

/// Records `op` unless a newer one for the same field is already stored. True if it won.
pub fn put(conn: &Connection, op: &Op) -> Result<bool, Error> {
    let val = serde_json::to_string(&op.val).map_err(|e| Error::Msg(e.to_string()))?;
    let changed = conn
        .prepare_cached(
            "INSERT INTO op_state (e, id, f, clock, val, ref) VALUES (?1, ?2, ?3, ?4, ?5, ?6)
             ON CONFLICT(e, id, f) DO UPDATE SET
                 clock = excluded.clock, val = excluded.val, ref = excluded.ref
             WHERE excluded.clock > op_state.clock",
        )?
        .execute(params![op.e, op.id, op.f, op.clock, val, op.reference()])?;
    Ok(changed > 0)
}

pub fn get(conn: &Connection, e: &str, id: &str, f: &str) -> Result<Option<Value>, Error> {
    let raw: Option<String> = conn
        .prepare_cached("SELECT val FROM op_state WHERE e = ?1 AND id = ?2 AND f = ?3")?
        .query_row(params![e, id, f], |r| r.get(0))
        .optional()?;
    Ok(raw.and_then(|s| serde_json::from_str(&s).ok()))
}

/// Like `get`, with the clock of the winning op.
pub fn get_clocked(
    conn: &Connection,
    e: &str,
    id: &str,
    f: &str,
) -> Result<Option<(String, Value)>, Error> {
    let raw: Option<(String, String)> = conn
        .prepare_cached("SELECT clock, val FROM op_state WHERE e = ?1 AND id = ?2 AND f = ?3")?
        .query_row(params![e, id, f], |r| Ok((r.get(0)?, r.get(1)?)))
        .optional()?;
    Ok(raw.and_then(|(clock, s)| Some((clock, serde_json::from_str(&s).ok()?))))
}

pub fn get_str(conn: &Connection, e: &str, id: &str, f: &str) -> Result<Option<String>, Error> {
    Ok(get(conn, e, id, f)?.and_then(|v| v.as_str().map(str::to_owned)))
}

pub fn get_bool(conn: &Connection, e: &str, id: &str, f: &str) -> Result<Option<bool>, Error> {
    Ok(get(conn, e, id, f)?.and_then(|v| v.as_bool()))
}

/// Whether the entity has a tombstone or was merged into another.
pub fn is_dead(conn: &Connection, e: &str, id: &str) -> Result<bool, Error> {
    Ok(conn
        .prepare_cached("SELECT 1 FROM op_state WHERE e = ?1 AND id = ?2 AND f IN (?3, ?4)")?
        .exists(params![e, id, F_DELETE, F_MERGE])?)
}

/// How far a chain of merges is followed (a chain longer than this is a loop or a mistake).
const MERGE_HOPS: usize = 16;

/// The uid an entity ended up as after merges: itself when it was never merged.
pub fn merge_target(conn: &Connection, e: &str, uid: &str) -> Result<String, Error> {
    let mut at = uid.to_owned();
    for _ in 0..MERGE_HOPS {
        match get_str(conn, e, &at, F_MERGE)? {
            Some(next) if next != at => at = next,
            _ => break,
        }
    }
    Ok(at)
}

/// Every uid merged into `uid`, directly or through other merges.
pub fn merge_sources(conn: &Connection, e: &str, uid: &str) -> Result<Vec<String>, Error> {
    let mut found: Vec<String> = Vec::new();
    let mut queue = vec![uid.to_owned()];
    while let Some(next) = queue.pop() {
        let val = serde_json::to_string(&next).map_err(|e| Error::Msg(e.to_string()))?;
        let mut stmt = conn.prepare_cached(
            // The literal lets SQLite use the partial index `op_state_merge`.
            "SELECT id FROM op_state WHERE e = ?1 AND f = '_merge' AND val = ?2",
        )?;
        let ids: Vec<String> = stmt
            .query_map(params![e, val], |r| r.get(0))?
            .collect::<Result<_, _>>()?;
        for id in ids {
            if id != uid && !found.contains(&id) {
                found.push(id.clone());
                queue.push(id);
            }
        }
    }
    Ok(found)
}

pub fn cursor(conn: &Connection, dev: &str) -> Result<u64, Error> {
    let seq: Option<i64> = conn
        .query_row(
            "SELECT seq FROM op_cursor WHERE dev = ?1",
            params![dev],
            |r| r.get(0),
        )
        .optional()?;
    Ok(seq.and_then(|s| u64::try_from(s).ok()).unwrap_or(0))
}

pub fn set_cursor(conn: &Connection, dev: &str, seq: u64) -> Result<(), Error> {
    conn.execute(
        "INSERT INTO op_cursor (dev, seq) VALUES (?1, ?2)
         ON CONFLICT(dev) DO UPDATE SET seq = excluded.seq",
        params![dev, i64::try_from(seq).unwrap_or(i64::MAX)],
    )?;
    Ok(())
}
