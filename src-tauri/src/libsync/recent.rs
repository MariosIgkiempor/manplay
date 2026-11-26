//! Recently deleted: shared items someone deleted in the last 90 days, who did it and when, and
//! a way to take them back. A restore keeps the item's uid, so smart playlists that use a tag
//! find it again, and brings its songs back.

use std::collections::BTreeSet;

use rusqlite::{Connection, params};
use serde::Serialize;
use serde_json::Value;

use super::apply::{self, PLAYLISTS, SMARTS, TAGS};
use super::clock;
use super::entities;
use super::ops::{F_DELETE, F_MERGE, F_NAME, F_POS, F_PRESENT, F_RULES};
use super::snapshot::TOMBSTONE_MS;
use super::state;
use super::write::{Batch, device_id};
use crate::error::Error;

/// A deleted shared item.
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Deleted {
    /// `tag`, `playlist` or `smart_playlist`.
    pub kind: String,
    pub uid: String,
    pub name: String,
    /// Who deleted it: "This device", a member's name, or "Another device".
    pub by: String,
    /// Unix seconds, UTC.
    pub at: i64,
    /// Songs it had when it was deleted (0 for smart playlists).
    pub songs: i64,
}

/// What a member is called once its name is not known any more (it left the library).
pub const ANOTHER_DEVICE: &str = "Another device";

/// The name of another member of the library, as the destination last listed it.
pub fn member_name(conn: &Connection, device: &str) -> String {
    conn.query_row(
        "SELECT name FROM libsync_devices WHERE id = ?1",
        params![device],
        |r| r.get(0),
    )
    .unwrap_or_else(|_| ANOTHER_DEVICE.to_owned())
}

fn member_entity(kind: &str) -> &'static str {
    match kind {
        "tag" => "track_tag",
        "playlist" => "playlist_track",
        _ => "",
    }
}

/// Deleted items newer than 90 days, newest first. An item merged into another is not deleted,
/// it moved, and is not listed.
pub fn list(conn: &Connection, now_ms: i64) -> Result<Vec<Deleted>, Error> {
    let me = device_id(conn)?;
    let since = clock::before_ms(now_ms - TOMBSTONE_MS);
    let rows: Vec<(String, String, String)> = conn
        .prepare(
            "SELECT e, id, clock FROM op_state d
             WHERE f = ?1 AND val <> 'false' AND clock >= ?2
               AND e IN ('tag', 'playlist', 'smart_playlist')
               AND NOT EXISTS (SELECT 1 FROM op_state m
                               WHERE m.e = d.e AND m.id = d.id AND m.f = ?3)
             ORDER BY clock DESC",
        )?
        .query_map(params![F_DELETE, since, F_MERGE], |r| {
            Ok((r.get(0)?, r.get(1)?, r.get(2)?))
        })?
        .collect::<Result<_, _>>()?;
    let mut out = Vec::new();
    for (kind, uid, at_clock) in rows {
        let Some(name) = state::get_str(conn, &kind, &uid, F_NAME)? else {
            continue;
        };
        let by = match clock::device_of(&at_clock) {
            Some(dev) if dev == me => "This device".to_owned(),
            Some(dev) => member_name(conn, dev),
            None => ANOTHER_DEVICE.to_owned(),
        };
        let members = member_entity(&kind);
        let songs = if members.is_empty() {
            0
        } else {
            conn.query_row(
                "SELECT COUNT(*) FROM op_state WHERE e = ?1 AND f = ?2 AND val = 'true'
                 AND id >= ?3 AND id < ?4",
                params![members, F_PRESENT, format!("{uid}/"), format!("{uid}0")],
                |r| r.get(0),
            )?
        };
        out.push(Deleted {
            kind,
            uid,
            name,
            by,
            at: clock::parse(&at_clock).map_or(0, |(ms, _)| ms / 1000),
            songs,
        });
    }
    Ok(out)
}

/// Takes a deleted item back with its old uid: writes the item again (its name, its songs, its
/// rules) and lifts its tombstone, then shows it here. Songs this library does not have wait,
/// as always. Everyone else gets it at their next sync.
pub fn restore(conn: &mut Connection, kind: &str, uid: &str, now_ms: i64) -> Result<(), Error> {
    let tx = conn.transaction()?;
    restore_in(&tx, kind, uid, now_ms)?;
    tx.commit()?;
    Ok(())
}

/// [`restore`] inside the caller's transaction.
pub fn restore_in(tx: &Connection, kind: &str, uid: &str, now_ms: i64) -> Result<(), Error> {
    let apply_kind = match kind {
        "tag" => TAGS,
        "playlist" => PLAYLISTS,
        "smart_playlist" => SMARTS,
        _ => return Err(Error::Msg(format!("cannot restore a {kind}"))),
    };
    if !list(tx, now_ms)?
        .iter()
        .any(|d| d.kind == kind && d.uid == uid)
    {
        return Err(Error::Msg(
            "That item was not deleted in the last 90 days.".into(),
        ));
    }
    let mut batch = Batch::new(tx)?;
    if !batch.is_on() {
        return Err(Error::Msg("This device is not in a shared library.".into()));
    }
    let name = state::get_str(tx, kind, uid, F_NAME)?.unwrap_or_default();
    match kind {
        "tag" => batch.tag(uid, &name),
        "playlist" => batch.playlist(uid, &name),
        _ => {
            let rules = state::get(tx, kind, uid, F_RULES)?.unwrap_or(Value::Null);
            batch.smart_playlist(uid, &name, &rules);
        }
    }
    let members = member_entity(kind);
    if !members.is_empty() {
        let found: Vec<(String, Option<String>)> = tx
            .prepare(
                "SELECT id, ref FROM op_state WHERE e = ?1 AND f = ?2 AND val = 'true'
                 AND id >= ?3 AND id < ?4",
            )?
            .query_map(
                params![members, F_PRESENT, format!("{uid}/"), format!("{uid}0")],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )?
            .collect::<Result<_, _>>()?;
        for (id, fp) in found {
            let Some(fp) = fp.or_else(|| id.split_once('/').map(|(_, f)| f.to_owned())) else {
                continue;
            };
            if kind == "tag" {
                batch.track_tag(uid, &fp, true);
            } else {
                let pos = state::get_str(tx, members, &id, F_POS)?;
                batch.playlist_add(uid, &fp, pos.as_deref().unwrap_or("V"));
            }
        }
    }
    batch.restored(apply_kind.entity, uid);
    batch.commit(tx)?;
    let mut touched = BTreeSet::new();
    apply::materialize_item(tx, apply_kind, uid, &mut touched)?;
    if kind == "tag" {
        entities::rematerialize_rules_using(tx, uid)?;
    }
    if kind == "smart_playlist" {
        entities::materialize_smart_rules(tx, uid)?;
    }
    apply::settle(tx, &mut touched)?;
    for id in touched {
        apply::renumber(tx, id)?;
    }
    Ok(())
}
