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

/// Sets the rules of one smart playlist's row from its register, with every tag that was merged
/// into another replaced by what it became. The row itself (its name) is `apply::materialize_item`.
/// A local playlist is never touched.
pub fn materialize_smart_rules(conn: &Connection, uid: &str) -> Result<(), Error> {
    let existing: Option<(i64, String)> = conn
        .query_row(
            "SELECT id, scope FROM smart_playlists WHERE uid = ?1",
            params![uid],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .optional()?;
    let Some((id, scope)) = existing else {
        return Ok(());
    };
    if scope != "shared" {
        return Ok(());
    }
    let Some(rules) = state::get(conn, "smart_playlist", uid, F_RULES)?.filter(Value::is_object)
    else {
        return Ok(());
    };
    let rules: crate::smart::Rules = serde_json::from_value(rules).unwrap_or_default();
    let mut failure = None;
    let moved = rules.map_tags(|entry| {
        if !crate::smart::is_uid(entry) {
            return entry.to_owned();
        }
        state::merge_target(conn, "tag", entry).unwrap_or_else(|e| {
            failure = Some(e);
            entry.to_owned()
        })
    });
    if let Some(e) = failure {
        return Err(e);
    }
    // A tag that was deleted (not merged) can never match again: the rule stops asking for it,
    // the same on every device because it follows the tombstone.
    let mut moved = moved;
    let mut entries: Vec<String> = Vec::new();
    for list in [&moved.all_tags, &moved.any_tags, &moved.none_tags] {
        entries.extend(list.iter().filter(|t| crate::smart::is_uid(t)).cloned());
    }
    for entry in entries {
        if state::is_dead(conn, "tag", &entry)? {
            moved = moved.without_tag(&entry);
        }
    }
    let json = serde_json::to_string(&moved).map_err(|e| Error::Msg(e.to_string()))?;
    conn.execute(
        "UPDATE smart_playlists SET rules = ?2 WHERE id = ?1",
        params![id, json],
    )?;
    Ok(())
}

/// A tag was deleted: every smart playlist row on this device stops asking for it. Shared ones
/// reach the same result from their registers (`materialize_smart_rules`); this is for the rows
/// of local playlists, and for shared ones until their next replay.
pub fn drop_dead_tag(conn: &Connection, uid: &str) -> Result<(), Error> {
    if uid.is_empty() || !state::is_dead(conn, "tag", uid)? {
        return Ok(());
    }
    let rows: Vec<(i64, String)> = conn
        .prepare("SELECT id, rules FROM smart_playlists WHERE instr(rules, ?1) > 0")?
        .query_map(params![uid], |r| Ok((r.get(0)?, r.get(1)?)))?
        .collect::<Result<_, _>>()?;
    for (id, rules) in rows {
        let old: crate::smart::Rules = serde_json::from_str(&rules).unwrap_or_default();
        let kept = old.without_tag(uid);
        if kept != old {
            let json = serde_json::to_string(&kept).map_err(|e| Error::Msg(e.to_string()))?;
            conn.execute(
                "UPDATE smart_playlists SET rules = ?2 WHERE id = ?1",
                params![id, json],
            )?;
        }
    }
    Ok(())
}

/// A deleted tag came back (Restore): shared smart playlists that name it by their registers ask
/// for it again.
pub fn rematerialize_rules_using(conn: &Connection, uid: &str) -> Result<(), Error> {
    let ids: Vec<String> = conn
        .prepare(
            "SELECT id FROM op_state WHERE e = 'smart_playlist' AND f = ?2 AND instr(val, ?1) > 0",
        )?
        .query_map(params![uid, F_RULES], |r| r.get(0))?
        .collect::<Result<_, _>>()?;
    for id in ids {
        materialize_smart_rules(conn, &id)?;
    }
    Ok(())
}

/// Smart playlists (of any scope) that used tag `from` use `to`: the tag was merged into it.
/// Changes only this device's rows; shared playlists reach the same result on every device
/// because `materialize_smart_rules` follows merges.
pub fn repoint_rules(conn: &Connection, from: &str, to: &str) -> Result<(), Error> {
    if from.is_empty() || to.is_empty() || from == to {
        return Ok(());
    }
    let rows: Vec<(i64, String)> = conn
        .prepare("SELECT id, rules FROM smart_playlists WHERE instr(rules, ?1) > 0")?
        .query_map(params![from], |r| Ok((r.get(0)?, r.get(1)?)))?
        .collect::<Result<_, _>>()?;
    for (id, rules) in rows {
        let old: crate::smart::Rules = serde_json::from_str(&rules).unwrap_or_default();
        let moved = old.map_tags(|t| {
            if t == from {
                to.to_owned()
            } else {
                t.to_owned()
            }
        });
        if moved != old {
            let json = serde_json::to_string(&moved).map_err(|e| Error::Msg(e.to_string()))?;
            conn.execute(
                "UPDATE smart_playlists SET rules = ?2 WHERE id = ?1",
                params![id, json],
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
