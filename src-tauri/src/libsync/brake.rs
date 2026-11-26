//! A stop before another device's deletions take a lot away at once. Incoming edits that would
//! delete more than [`LIMIT`] tags, playlists and smart playlists this device has are not
//! applied: the sync holds everything it would read until the user says to let them through or
//! to keep the items (they are then restored for everyone). This device's own edits are still
//! sent while it waits.

use std::collections::BTreeMap;

use rusqlite::Connection;
use serde::{Deserialize, Serialize};
use serde_json::Value;

use super::apply::{self, Kind};
use super::ops::{F_DELETE, Op};
use super::recent;
use super::state;
use crate::db;
use crate::error::Error;

/// Deletions in one sync up to this many go through without asking.
pub const LIMIT: usize = 25;

/// Names shown of what would be deleted; the rest is a count.
const NAMES_SHOWN: usize = 5;

const SETTING_HOLD: &str = "libsync_delete_hold";
const SETTING_DECISION: &str = "libsync_delete_decision";

/// Unix time in seconds, UTC.
pub type UnixSeconds = i64;

/// Deletions that are waiting for the user.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Hold {
    /// How many tags, playlists and smart playlists would be deleted here.
    pub count: usize,
    /// The members who deleted them, by name.
    pub by: Vec<String>,
    /// The first few of their names.
    pub names: Vec<String>,
    /// When the sync first held them.
    pub at: UnixSeconds,
}

/// What the user said about held deletions.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum Decision {
    /// Let them through: the items are deleted here too.
    Apply,
    /// Keep the items: the deletions are applied and taken back at once, for everyone.
    Keep,
}

/// An item this device has that incoming ops would delete.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Doomed {
    kind: Kind,
    uid: String,
    name: String,
    device: String,
}

/// The items `ops` would delete here: a tombstone that wins, for an item that has a row and is
/// not gone already. A delete taken back later in the same ops does not count.
pub fn doomed(conn: &Connection, ops: &[Op]) -> Result<Vec<Doomed>, Error> {
    let mut last: BTreeMap<(&str, &str), &Op> = BTreeMap::new();
    for op in ops.iter().filter(|op| op.f == F_DELETE) {
        if Kind::from_label(&op.e).is_none() {
            continue;
        }
        let newest = last.entry((&op.e, &op.id)).or_insert(op);
        if op.clock > newest.clock {
            *newest = op;
        }
    }
    let mut out = Vec::new();
    for ((entity, uid), op) in last {
        let Some(kind) = Kind::from_label(entity) else {
            continue;
        };
        if op.val == Value::Bool(false) || state::is_dead(conn, entity, uid)? {
            continue;
        }
        let loses = state::get_clocked(conn, entity, uid, F_DELETE)?
            .is_some_and(|(clock, _)| clock >= op.clock);
        if loses {
            continue;
        }
        if let Some(row) = apply::find(conn, kind, "uid", uid)? {
            out.push(Doomed {
                kind,
                uid: uid.to_owned(),
                name: row.name,
                device: op.dev.clone(),
            });
        }
    }
    Ok(out)
}

/// What to do with ops that are about to be applied.
#[derive(Debug, PartialEq, Eq)]
pub enum Verdict {
    /// Apply them, then take back the deletion of `restore` ([`keep`]).
    Apply { restore: Vec<Doomed> },
    /// Do not apply them: too much would be deleted and the user has not been asked.
    Hold(Hold),
}

/// Decides about `ops` from what they would delete and what the user has said. Writes nothing:
/// the caller stores a hold with [`set_hold`], outside the transaction it gives up.
pub fn judge(conn: &Connection, ops: &[Op], now_ms: i64) -> Result<Verdict, Error> {
    let doomed = doomed(conn, ops)?;
    match decision(conn)? {
        Some(Decision::Keep) => Ok(Verdict::Apply { restore: doomed }),
        Some(Decision::Apply) => Ok(Verdict::Apply {
            restore: Vec::new(),
        }),
        None if doomed.len() <= LIMIT => Ok(Verdict::Apply {
            restore: Vec::new(),
        }),
        None => {
            let mut by: Vec<String> = doomed
                .iter()
                .map(|d| recent::member_name(conn, &d.device))
                .collect();
            by.sort();
            by.dedup();
            Ok(Verdict::Hold(Hold {
                count: doomed.len(),
                by,
                names: doomed
                    .iter()
                    .take(NAMES_SHOWN)
                    .map(|d| d.name.clone())
                    .collect(),
                at: hold(conn)?.map_or(now_ms / 1000, |h| h.at),
            }))
        }
    }
}

/// Takes back the deletion of `items`, right after the ops that deleted them were applied, in
/// the same transaction. Everyone gets them back at the next sync.
pub fn keep(conn: &Connection, items: &[Doomed], now_ms: i64) -> Result<(), Error> {
    for item in items {
        recent::restore_in(conn, item.kind.label(), &item.uid, now_ms)?;
    }
    Ok(())
}

pub fn hold(conn: &Connection) -> Result<Option<Hold>, Error> {
    Ok(db::get_setting(conn, SETTING_HOLD)?.and_then(|raw| serde_json::from_str(&raw).ok()))
}

pub fn set_hold(conn: &Connection, hold: &Hold) -> Result<(), Error> {
    let raw = serde_json::to_string(hold).map_err(|e| Error::Msg(e.to_string()))?;
    db::set_setting(conn, SETTING_HOLD, Some(&raw))
}

pub fn decision(conn: &Connection) -> Result<Option<Decision>, Error> {
    Ok(db::get_setting(conn, SETTING_DECISION)?.and_then(|raw| serde_json::from_str(&raw).ok()))
}

/// Records what the user chose for the held deletions; the next sync carries it out.
pub fn decide(conn: &Connection, choice: Decision) -> Result<(), Error> {
    if hold(conn)?.is_none() {
        return Err(Error::Msg("No deletions are waiting.".into()));
    }
    let raw = serde_json::to_string(&choice).map_err(|e| Error::Msg(e.to_string()))?;
    db::set_setting(conn, SETTING_DECISION, Some(&raw))
}

/// The deletions a sync must not read past: held, and not decided yet.
pub fn waiting(conn: &Connection) -> Result<Option<Hold>, Error> {
    if decision(conn)?.is_some() {
        return Ok(None);
    }
    hold(conn)
}

/// Forgets the hold and the decision, once a sync has read everything without stopping.
pub fn clear(conn: &Connection) -> Result<(), Error> {
    db::set_setting(conn, SETTING_HOLD, None)?;
    db::set_setting(conn, SETTING_DECISION, None)
}
