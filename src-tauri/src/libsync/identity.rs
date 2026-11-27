//! Two copies of one device.
//!
//! A device ID is made once and kept in the database. Copy the app data to another computer, or
//! restore a backup, and two installs write chunks under one ID: the numbers collide, and one
//! install's ops are read by nobody. Each upload remembers the newest chunk number this install
//! wrote (`libsync_sent`); a chunk of this ID past that number that holds ops this install never
//! made means another copy is writing. This install then takes a new ID, sends what it has not
//! sent yet under it, and reads the other copy's chunks like any other device's.

use std::sync::Mutex;

use rusqlite::{Connection, params};

use super::clock;
use super::remote::{ChunkRef, ChunkStore, decode};
use super::state;
use crate::db;
use crate::error::Error;

const SETTING_SENT: &str = "libsync_sent";

fn lock(db: &Mutex<Connection>) -> Result<std::sync::MutexGuard<'_, Connection>, Error> {
    db.lock().map_err(|_| Error::Lock)
}

fn library_key(conn: &Connection) -> Result<String, Error> {
    Ok(db::get_setting(conn, "library_id")?.unwrap_or_default())
}

/// The newest chunk number this install has uploaded to this library. Before its first upload
/// to this library it is what the cursor says: a snapshot or chunks read on joining can already
/// cover this ID.
pub fn sent(conn: &Connection, me: &str) -> Result<u64, Error> {
    if let Some(raw) = db::get_setting(conn, SETTING_SENT)?
        && let Some((library, seq)) = raw.rsplit_once(':')
        && library == library_key(conn)?
        && let Ok(seq) = seq.parse()
    {
        return Ok(seq);
    }
    state::cursor(conn, me)
}

/// Remembers an upload.
pub fn set_sent(conn: &Connection, seq: u64) -> Result<(), Error> {
    let value = format!("{}:{seq}", library_key(conn)?);
    db::set_setting(conn, SETTING_SENT, Some(&value))
}

/// Looks for chunks under this device's ID that this install did not write. Returns the new ID
/// when a second copy was found and this install moved to another ID, `None` when all is well.
pub async fn check<S: ChunkStore>(
    db: &Mutex<Connection>,
    store: &S,
    me: &str,
    listed: &[ChunkRef],
) -> Result<Option<String>, Error> {
    let known = {
        let conn = lock(db)?;
        sent(&conn, me)?
    };
    let mut ahead: Vec<u64> = listed
        .iter()
        .filter(|c| c.dev == me && c.seq > known)
        .map(|c| c.seq)
        .collect();
    if ahead.is_empty() {
        return Ok(None);
    }
    ahead.sort_unstable();
    let mut found: Vec<super::ops::Op> = Vec::new();
    for &seq in &ahead {
        let bytes = store
            .read_chunk(&ChunkRef {
                dev: me.to_owned(),
                seq,
            })
            .await?;
        let (ops, _) = decode(&bytes)?;
        found.extend(ops);
    }
    let newest = ahead.last().copied().unwrap_or(known);
    let mut conn = lock(db)?;
    let tx = conn.transaction()?;
    let all_mine = {
        // The clock alone is not enough: a copy that edits in the same millisecond makes the
        // same clock for a different edit.
        let mut stmt = tx.prepare_cached(
            "SELECT EXISTS (SELECT 1 FROM oplog
                            WHERE clock = ?1 AND e = ?2 AND id = ?3 AND f = ?4 AND val = ?5)",
        )?;
        let mut all = true;
        for op in &found {
            let val = serde_json::to_string(&op.val).map_err(|e| Error::Msg(e.to_string()))?;
            if !stmt.query_row(params![op.clock, op.e, op.id, op.f, val], |r| {
                r.get::<_, bool>(0)
            })? {
                all = false;
                break;
            }
        }
        all
    };
    if all_mine {
        // This install's own upload that was never recorded (it stopped in between).
        let mut mark = tx.prepare("UPDATE oplog SET uploaded = 1, seq = ?2 WHERE clock = ?1")?;
        for op in &found {
            mark.execute(params![op.clock, i64::try_from(newest).unwrap_or(i64::MAX)])?;
        }
        drop(mark);
        state::set_cursor(&tx, me, newest)?;
        set_sent(&tx, newest)?;
        tx.commit()?;
        return Ok(None);
    }
    let fresh = change_id(&tx, me, known)?;
    tx.commit()?;
    Ok(Some(fresh))
}

/// Takes a new device ID. Ops not sent yet get clocks with it (the old ID's clocks may be made
/// again by the other copy); chunks up to `known` stay this install's, the rest are read like
/// another device's.
fn change_id(conn: &Connection, old: &str, known: u64) -> Result<String, Error> {
    let fresh = super::write::new_uid();
    let unsent: Vec<String> = conn
        .prepare("SELECT clock FROM oplog WHERE dev = ?1 AND uploaded = 0")?
        .query_map(params![old], |r| r.get(0))?
        .collect::<Result<_, _>>()?;
    for clock_old in unsent {
        if let Some((ms, counter)) = clock::parse(&clock_old) {
            let clock_new = clock::format(ms, counter, &fresh);
            conn.execute(
                "UPDATE oplog SET clock = ?2, dev = ?3 WHERE clock = ?1",
                params![clock_old, clock_new, fresh],
            )?;
            conn.execute(
                "UPDATE op_state SET clock = ?2 WHERE clock = ?1",
                params![clock_old, clock_new],
            )?;
        }
    }
    db::set_setting(conn, "device_id", Some(&fresh))?;
    state::set_cursor(conn, old, known)?;
    set_sent(conn, 0)?;
    Ok(fresh)
}
