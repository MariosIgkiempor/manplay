//! The register store behind replay: the newest op per `(entity, id, field)`.

use rusqlite::{Connection, OptionalExtension, params};
use serde_json::Value;

use super::ops::{F_DELETE, Op};
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

pub fn get_str(conn: &Connection, e: &str, id: &str, f: &str) -> Result<Option<String>, Error> {
    Ok(get(conn, e, id, f)?.and_then(|v| v.as_str().map(str::to_owned)))
}

pub fn get_bool(conn: &Connection, e: &str, id: &str, f: &str) -> Result<Option<bool>, Error> {
    Ok(get(conn, e, id, f)?.and_then(|v| v.as_bool()))
}

/// Whether the entity has a tombstone.
pub fn is_dead(conn: &Connection, e: &str, id: &str) -> Result<bool, Error> {
    Ok(conn
        .prepare_cached("SELECT 1 FROM op_state WHERE e = ?1 AND id = ?2 AND f = ?3")?
        .exists(params![e, id, F_DELETE])?)
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
