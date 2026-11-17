//! Devices whose clock is wrong.
//!
//! Every op carries its writer's UTC time, and the newest clock wins. A laptop set a year ahead
//! would win every conflict for a year. So an op whose time is more than ten minutes past both
//! this device's own time and the newest op already applied from other devices is *held*: kept in
//! `op_future`, not applied, and tried again at every sync (it applies once time has caught up, or
//! never, if the writer re-stamps it). The device that holds ops lists their writers in its member
//! file (`skewed`); a writer that finds itself there shows "This device's clock is wrong", and
//! once its clock is fixed it re-stamps what it wrote with the wrong time.

use std::collections::BTreeSet;

use rusqlite::{Connection, params};

use super::clock::{self, Hlc};
use super::ops::Op;
use super::write::{NewOp, device_id, record};
use crate::db;
use crate::error::Error;

/// How far past "now" and past everything already applied an op may be.
pub const TOLERANCE_MS: i64 = 10 * 60 * 1000;
/// Entity of the op a device writes after re-stamping: `id` is the device, field `above`, value
/// the first millisecond that was wrong. Whoever holds ops of that device from then on drops them
/// (the device sends them again with right times).
pub const E_RESET: &str = "clock_reset";
const F_ABOVE: &str = "above";
const SETTING_CLOCK_WRONG: &str = "libsync_clock_wrong";

/// Ops split by whether their clock can be believed.
#[derive(Debug, Default)]
pub struct Screened {
    pub accepted: Vec<Op>,
    /// Ops kept back, including ones held by earlier syncs.
    pub held: usize,
}

fn ms_of(clock: &str) -> i64 {
    clock::parse(clock).map_or(0, |(ms, _)| ms)
}

/// The newest time among the ops other devices wrote that are already applied.
fn newest_other(conn: &Connection, me: &str) -> Result<i64, Error> {
    let newest: Option<String> = conn.query_row(
        "SELECT MAX(clock) FROM op_state WHERE clock NOT LIKE ?1",
        params![format!("%-{me}")],
        |r| r.get(0),
    )?;
    Ok(newest.as_deref().map_or(0, ms_of))
}

/// Splits `incoming` (and the ops held earlier) into what can be applied at `now_ms` and what is
/// held. Run it inside the transaction that applies the result.
pub fn screen(conn: &Connection, mut incoming: Vec<Op>, now_ms: i64) -> Result<Screened, Error> {
    let me = device_id(conn)?;
    let earlier: Vec<String> = conn
        .prepare("SELECT op FROM op_future")?
        .query_map([], |r| r.get(0))?
        .collect::<Result<_, _>>()?;
    for raw in earlier {
        if let Ok(op) = serde_json::from_str::<Op>(&raw) {
            incoming.push(op);
        }
    }
    incoming.sort_by(|a, b| a.clock.cmp(&b.clock));
    incoming.dedup_by(|a, b| a.clock == b.clock);
    let mut newest = newest_other(conn, &me)?;
    let mut screened = Screened::default();
    let mut held: Vec<Op> = Vec::new();
    for op in incoming {
        let ms = ms_of(&op.clock);
        if ms > newest.max(now_ms).saturating_add(TOLERANCE_MS) {
            held.push(op);
        } else {
            newest = newest.max(ms);
            screened.accepted.push(op);
        }
    }
    conn.execute("DELETE FROM op_future", [])?;
    for op in &held {
        conn.execute(
            "INSERT INTO op_future (clock, dev, op) VALUES (?1, ?2, ?3)",
            params![
                op.clock,
                op.dev,
                serde_json::to_string(op).map_err(|e| Error::Msg(e.to_string()))?
            ],
        )?;
    }
    screened.held = held.len();
    Ok(screened)
}

/// Devices whose ops are being held.
pub fn skewed_devices(conn: &Connection) -> Result<BTreeSet<String>, Error> {
    Ok(conn
        .prepare("SELECT DISTINCT dev FROM op_future")?
        .query_map([], |r| r.get(0))?
        .collect::<Result<_, _>>()?)
}

/// Gives the ops this device wrote with a clock from the future (its time was wrong, and has
/// been set right since) new clocks from now, and queues them to be sent again. Returns how many.
/// Does nothing while this device's clock is still ahead.
pub fn restamp(conn: &Connection, now_ms: i64) -> Result<usize, Error> {
    let mut hlc = clock::load(conn)?;
    let limit = now_ms.saturating_add(TOLERANCE_MS);
    if hlc.ms() <= limit {
        return Ok(0);
    }
    let me = device_id(conn)?;
    let first_future = clock::before_ms(limit.saturating_add(1));
    let rows: Vec<String> = conn
        .prepare("SELECT clock FROM oplog WHERE dev = ?1 AND clock >= ?2 ORDER BY clock")?
        .query_map(params![me, first_future], |r| r.get(0))?
        .collect::<Result<_, _>>()?;
    // Start again from the newest time that is believable.
    let believable: Option<String> = conn.query_row(
        "SELECT MAX(clock) FROM op_state WHERE clock < ?1",
        params![first_future],
        |r| r.get(0),
    )?;
    hlc = Hlc::default();
    if let Some(clock) = believable {
        hlc.observe(&clock);
    }
    for old in &rows {
        let (ms, counter) = hlc.tick(now_ms);
        let new = clock::format(ms, counter, &me);
        conn.execute(
            "UPDATE oplog SET clock = ?2, uploaded = 0, seq = NULL WHERE clock = ?1",
            params![old, new],
        )?;
        conn.execute(
            "UPDATE op_state SET clock = ?2 WHERE clock = ?1",
            params![old, new],
        )?;
    }
    clock::save(conn, hlc)?;
    set_clock_wrong(conn, false)?;
    if !rows.is_empty() {
        record(
            conn,
            &[NewOp {
                e: E_RESET,
                id: me,
                f: F_ABOVE,
                val: serde_json::json!(limit.saturating_add(1)),
            }],
        )?;
    }
    Ok(rows.len())
}

/// A device re-stamped what it wrote with a wrong clock: the held copies of those ops are void.
pub fn release(conn: &Connection, dev: &str, above_ms: i64) -> Result<(), Error> {
    conn.execute(
        "DELETE FROM op_future WHERE dev = ?1 AND clock >= ?2",
        params![dev, clock::before_ms(above_ms)],
    )?;
    Ok(())
}

/// Whether other devices have said this device's clock is wrong.
pub fn clock_wrong(conn: &Connection) -> Result<bool, Error> {
    Ok(db::get_setting(conn, SETTING_CLOCK_WRONG)?.is_some())
}

pub fn set_clock_wrong(conn: &Connection, wrong: bool) -> Result<(), Error> {
    db::set_setting(conn, SETTING_CLOCK_WRONG, wrong.then_some("1"))
}
