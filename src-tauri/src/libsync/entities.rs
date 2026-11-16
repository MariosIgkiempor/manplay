//! Replay for the entities that are one row each: smart playlists, hand-made Tag Database
//! values and analysis (BPM, key, beat grid). Like the rest of replay it reads only the register
//! store, so the order ops arrive in never matters.

use rusqlite::{Connection, OptionalExtension, params};
use serde_json::Value;

use super::ops::{
    A_BAR_OFFSET, A_BPM, A_BPM_EDITED, A_BPM_HAND, A_DURATION, A_FIRST_BEAT, A_GRID_BPM,
    A_GRID_EDITED, A_GRID_HAND, A_KEY, A_KEY_EDITED, A_KEY_HAND, A_VERSION, F_NAME, F_PRESENT,
    F_RULES,
};
use super::state;
use crate::error::Error;

/// Brings the row of one smart playlist in line with its registers. A local one is never touched.
pub fn materialize_smart(conn: &Connection, uid: &str) -> Result<(), Error> {
    let existing: Option<(i64, String)> = conn
        .query_row(
            "SELECT id, scope FROM smart_playlists WHERE uid = ?1",
            params![uid],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .optional()?;
    if existing
        .as_ref()
        .is_some_and(|(_, scope)| scope != "shared")
    {
        return Ok(());
    }
    let name = state::get_str(conn, "smart_playlist", uid, F_NAME)?;
    let Some(name) = name.filter(|_| !state::is_dead(conn, "smart_playlist", uid).unwrap_or(true))
    else {
        if let Some((id, _)) = existing {
            conn.execute("DELETE FROM smart_playlists WHERE id = ?1", params![id])?;
        }
        return Ok(());
    };
    let rules = state::get(conn, "smart_playlist", uid, F_RULES)?
        .filter(Value::is_object)
        .map_or_else(|| "{}".to_owned(), |v| v.to_string());
    match existing {
        Some((id, _)) => {
            conn.execute(
                "UPDATE smart_playlists SET name = ?2, rules = ?3 WHERE id = ?1",
                params![id, name, rules],
            )?;
        }
        None => {
            conn.execute(
                "INSERT INTO smart_playlists (name, rules, uid, scope) VALUES (?1, ?2, ?3, 'shared')",
                params![name, rules, uid],
            )?;
        }
    }
    Ok(())
}

/// Applies one hand-made Tag Database value (`id` is `<field>/<value>`).
pub fn materialize_custom(conn: &Connection, id: &str) -> Result<(), Error> {
    let Some((field, value)) = id.split_once('/') else {
        return Ok(());
    };
    match state::get_bool(conn, "tag_custom", id, F_PRESENT)? {
        Some(true) => {
            // The spelling is the one in the registers, whichever was typed here first.
            let spelled =
                state::get_str(conn, "tag_custom", id, F_NAME)?.unwrap_or_else(|| value.to_owned());
            conn.execute(
                "DELETE FROM tag_custom WHERE field = ?1 AND value = ?2",
                params![field, spelled],
            )?;
            conn.execute(
                "INSERT INTO tag_custom (field, value) VALUES (?1, ?2)",
                params![field, spelled],
            )?;
        }
        Some(false) => {
            conn.execute(
                "DELETE FROM tag_custom WHERE field = ?1 AND value = ?2",
                params![field, value],
            )?;
        }
        None => {}
    }
    Ok(())
}

fn reg(conn: &Connection, fp: &str, f: &str) -> Result<Option<Value>, Error> {
    state::get(conn, "analysis", fp, f)
}

fn int(conn: &Connection, fp: &str, f: &str) -> Result<Option<i64>, Error> {
    Ok(state::get(conn, "analysis", fp, f)?.and_then(|v| v.as_i64()))
}

fn flag(conn: &Connection, fp: &str, f: &str) -> Result<bool, Error> {
    Ok(state::get_bool(conn, "analysis", fp, f)?.unwrap_or(false))
}

/// Sets `column` to what the registers say: the hand value while the `edited` flag is up, the
/// automatic one otherwise. A column with no register keeps what it has.
fn bpm_or_key(
    conn: &Connection,
    fp: &str,
    column: &str,
    auto: &str,
    hand: &str,
    edited: &str,
) -> Result<bool, Error> {
    let edited = flag(conn, fp, edited)?;
    let value = state::get(conn, "analysis", fp, if edited { hand } else { auto })?;
    let Some(value) = value else {
        return Ok(edited);
    };
    let value = match value {
        Value::String(s) => rusqlite::types::Value::Text(s),
        Value::Number(n) => rusqlite::types::Value::Real(n.as_f64().unwrap_or_default()),
        _ => rusqlite::types::Value::Null,
    };
    conn.execute(
        &format!("UPDATE analysis SET {column} = ?2 WHERE audio_fp = ?1"),
        params![fp, value],
    )?;
    Ok(edited)
}

/// The song's analysis row, from the registers. Nothing happens for audio the library does not
/// have: the registers wait for it (see [`materialize_waiting_analysis`]). The waveform is not
/// part of ops (it is a file), so it is left alone.
pub fn materialize_analysis(conn: &Connection, fp: &str) -> Result<(), Error> {
    let present: bool = conn.query_row(
        "SELECT EXISTS (SELECT 1 FROM tracks WHERE audio_fp = ?1)",
        params![fp],
        |r| r.get(0),
    )?;
    if !present || fp.is_empty() {
        return Ok(());
    }
    conn.execute(
        "INSERT OR IGNORE INTO analysis (audio_fp, version, analyzed_at) VALUES (?1, 0, 0)",
        params![fp],
    )?;
    if let Some(version) = int(conn, fp, A_VERSION)? {
        let (local, has_waveform): (i64, bool) = conn.query_row(
            "SELECT version, waveform IS NOT NULL FROM analysis WHERE audio_fp = ?1",
            params![fp],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )?;
        if version > local {
            // A newer analysis than the one this device holds: its waveform is out of date.
            let drop_waveform = has_waveform && local > 0;
            conn.execute(
                "UPDATE analysis SET version = ?2, error = NULL,
                     analyzed_at = MAX(analyzed_at, 1),
                     waveform = CASE WHEN ?3 THEN NULL ELSE waveform END,
                     wf_pushed = CASE WHEN ?3 THEN 0 ELSE wf_pushed END
                 WHERE audio_fp = ?1",
                params![fp, version, drop_waveform],
            )?;
        }
    }
    let bpm_edited = bpm_or_key(conn, fp, "bpm", A_BPM, A_BPM_HAND, A_BPM_EDITED)?;
    let key_edited = bpm_or_key(conn, fp, "musical_key", A_KEY, A_KEY_HAND, A_KEY_EDITED)?;
    conn.execute(
        "UPDATE analysis SET bpm_edited = ?2, key_edited = ?3 WHERE audio_fp = ?1",
        params![fp, bpm_edited, key_edited],
    )?;
    if let Some(d) = reg(conn, fp, A_DURATION)?.and_then(|v| v.as_f64()) {
        conn.execute(
            "UPDATE analysis SET duration = ?2 WHERE audio_fp = ?1",
            params![fp, d],
        )?;
    }
    let grid_edited = flag(conn, fp, A_GRID_EDITED)?;
    let grid = if grid_edited {
        state::get(conn, "analysis", fp, A_GRID_HAND)?.map(|g| {
            (
                g.get("grid_bpm").and_then(Value::as_f64),
                g.get("first_beat").and_then(Value::as_f64),
                g.get("bar_offset").and_then(Value::as_i64),
            )
        })
    } else {
        let bpm = reg(conn, fp, A_GRID_BPM)?;
        let first = reg(conn, fp, A_FIRST_BEAT)?.and_then(|v| v.as_f64());
        let bar = int(conn, fp, A_BAR_OFFSET)?;
        (bpm.is_some() || first.is_some() || bar.is_some()).then_some((
            bpm.and_then(|v| v.as_f64()),
            first,
            bar,
        ))
    };
    if let Some((bpm, first, bar)) = grid {
        conn.execute(
            "UPDATE analysis SET grid_bpm = ?2, first_beat = COALESCE(?3, first_beat),
                 bar_offset = COALESCE(?4, bar_offset)
             WHERE audio_fp = ?1",
            params![fp, bpm, first, bar],
        )?;
    }
    conn.execute(
        "UPDATE analysis SET grid_edited = ?2 WHERE audio_fp = ?1",
        params![fp, grid_edited],
    )?;
    Ok(())
}

/// Analysis ops for audio that arrived after them (a scan found the song): applies each.
pub fn materialize_waiting_analysis(conn: &Connection) -> Result<usize, Error> {
    let mut stmt = conn.prepare(
        "SELECT DISTINCT s.id FROM op_state s
         WHERE s.e = 'analysis' AND EXISTS (SELECT 1 FROM tracks t WHERE t.audio_fp = s.id)
           AND NOT EXISTS (SELECT 1 FROM analysis a WHERE a.audio_fp = s.id)",
    )?;
    let ids: Vec<String> = stmt
        .query_map([], |r| r.get(0))?
        .collect::<Result<_, _>>()?;
    drop(stmt);
    for id in &ids {
        materialize_analysis(conn, id)?;
    }
    Ok(ids.len())
}
