//! A change of the audio fingerprint algorithm (`audioprint::VERSION`).
//!
//! Every shared edit about a song names its `audio_fp`, so a new algorithm renames every song at
//! once. The first device that has re-printed its songs (`remap_tracks`) writes one `remap` op
//! per song (old to new), which every other device applies to what it holds (`apply_pair`), and
//! raises `audioFpVersion` in `library.json`. A device on an older algorithm cannot make sense
//! of the new names, so it refuses to sync until it is updated; one on the new algorithm that has
//! not re-printed yet waits for its own re-print (`membership::ensure`).

use std::collections::BTreeSet;

use rusqlite::{Connection, params};
use serde_json::json;

use super::write::{NewOp, active, record};
use crate::db;
use crate::error::Error;

/// Entity of a remap op: `id` is the old `audio_fp`, field `to`, value the new one.
pub const E_REMAP: &str = "audio_fp_remap";
const F_TO: &str = "to";

/// The version of the algorithm this device's `audio_fp` values come from.
pub fn local_version(conn: &Connection) -> Result<i64, Error> {
    Ok(db::get_setting(conn, db::SETTING_AUDIO_FP_VERSION)?
        .and_then(|v| v.parse().ok())
        .unwrap_or(1))
}

/// Entities whose id is the `audio_fp` itself.
const SONG_ENTITIES: &str = "('analysis', 'file', 'song_tags')";

/// Memberships whose `ref` is `old`, with the parent they belong to.
const MEMBER_ENTITIES: &str = "('track_tag', 'playlist_track')";

/// Moves every register about `old` to `new`; a register `new` already has stays if it is newer.
/// Returns the memberships it moved as `(entity, parent uid)`, so their rows can be rebuilt.
pub fn apply_pair(
    conn: &Connection,
    old: &str,
    new: &str,
) -> Result<BTreeSet<(String, String)>, Error> {
    if old == new || old.is_empty() || new.is_empty() {
        return Ok(BTreeSet::new());
    }
    let moved: BTreeSet<(String, String)> = conn
        .prepare(&format!(
            "SELECT DISTINCT e, substr(id, 1, instr(id, '/') - 1) FROM op_state
             WHERE e IN {MEMBER_ENTITIES} AND ref = ?1"
        ))?
        .query_map(params![old], |r| Ok((r.get(0)?, r.get(1)?)))?
        .collect::<Result<_, _>>()?;
    conn.execute(
        &format!(
            "INSERT INTO op_state (e, id, f, clock, val, ref)
             SELECT e, substr(id, 1, instr(id, '/')) || ?2, f, clock, val, ?2 FROM op_state
             WHERE e IN {MEMBER_ENTITIES} AND ref = ?1 AND true
             ON CONFLICT(e, id, f) DO UPDATE SET
                 clock = excluded.clock, val = excluded.val, ref = excluded.ref
             WHERE excluded.clock > op_state.clock"
        ),
        params![old, new],
    )?;
    conn.execute(
        &format!("DELETE FROM op_state WHERE e IN {MEMBER_ENTITIES} AND ref = ?1"),
        params![old],
    )?;
    conn.execute(
        &format!(
            "INSERT INTO op_state (e, id, f, clock, val, ref)
             SELECT e, ?2, f, clock, val, ref FROM op_state
             WHERE e IN {SONG_ENTITIES} AND id = ?1 AND true
             ON CONFLICT(e, id, f) DO UPDATE SET
                 clock = excluded.clock, val = excluded.val, ref = excluded.ref
             WHERE excluded.clock > op_state.clock"
        ),
        params![old, new],
    )?;
    conn.execute(
        &format!("DELETE FROM op_state WHERE e IN {SONG_ENTITIES} AND id = ?1"),
        params![old],
    )?;
    conn.execute(
        "UPDATE OR REPLACE file_local SET audio_fp = ?2 WHERE audio_fp = ?1",
        params![old, new],
    )?;
    conn.execute(
        "UPDATE OR REPLACE song_tags_local SET audio_fp = ?2 WHERE audio_fp = ?1",
        params![old, new],
    )?;
    // What this device has not sent yet names the new audio too.
    conn.execute(
        &format!(
            "UPDATE oplog SET id = substr(id, 1, instr(id, '/')) || ?2
             WHERE uploaded = 0 AND e IN {MEMBER_ENTITIES} AND substr(id, instr(id, '/') + 1) = ?1"
        ),
        params![old, new],
    )?;
    conn.execute(
        &format!(
            "UPDATE oplog SET id = ?2 WHERE uploaded = 0 AND e IN {SONG_ENTITIES} AND id = ?1"
        ),
        params![old, new],
    )?;
    Ok(moved)
}

/// This device has re-printed its songs: `pairs` is `(old, new)` for every audio that changed.
/// Moves the local analysis and cues, the shared registers, and tells the other devices with one
/// `remap` op per song. Sets the device's fingerprint version to `version`.
pub fn remap_tracks(
    conn: &mut Connection,
    pairs: &[(String, String)],
    version: i64,
) -> Result<(), Error> {
    let tx = conn.transaction()?;
    let sharing = active(&tx)?;
    let mut ops: Vec<NewOp> = Vec::new();
    for (old, new) in pairs.iter().filter(|(old, new)| old != new) {
        tx.execute(
            "UPDATE OR IGNORE analysis SET audio_fp = ?2 WHERE audio_fp = ?1",
            params![old, new],
        )?;
        tx.execute("DELETE FROM analysis WHERE audio_fp = ?1", params![old])?;
        tx.execute(
            "UPDATE OR IGNORE cues SET audio_fp = ?2 WHERE audio_fp = ?1",
            params![old, new],
        )?;
        tx.execute("DELETE FROM cues WHERE audio_fp = ?1", params![old])?;
        if sharing {
            apply_pair(&tx, old, new)?;
            ops.push(NewOp {
                e: E_REMAP,
                id: old.clone(),
                f: F_TO,
                val: json!(new),
            });
        }
    }
    if !ops.is_empty() {
        record(&tx, &ops)?;
    }
    db::set_setting(
        &tx,
        db::SETTING_AUDIO_FP_VERSION,
        Some(&version.to_string()),
    )?;
    tx.commit()?;
    Ok(())
}
