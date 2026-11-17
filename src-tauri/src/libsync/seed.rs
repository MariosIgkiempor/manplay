//! Switching library data on: ops for what the library already holds.

use rusqlite::{Connection, params};
use serde_json::{Value, json};

use super::frac;
use super::ops::{
    A_BAR_OFFSET, A_BPM, A_BPM_EDITED, A_BPM_HAND, A_DURATION, A_FIRST_BEAT, A_GRID_BPM,
    A_GRID_EDITED, A_GRID_HAND, A_KEY, A_KEY_EDITED, A_KEY_HAND, A_VERSION, F_NAME, F_PRESENT,
};
use super::state;
use super::write::{Batch, active};
use crate::db;
use crate::error::Error;

/// Which entities a library's ops were last caught up to: 2 is tags and playlists, 3 adds smart
/// playlists, hand-made Tag Database values and analysis.
const SEEDED: &str = "3";
const SETTING_SEEDED: &str = "libsync_seeded";

/// Writes an op for every shared tag, playlist and membership the register store does not have
/// yet (or holds under another name), and marks the whole log for upload again, since the
/// destination may be a new one. Returns how many ops were written.
///
/// Edits made while sharing was off that *remove* something are not sent: only what exists now.
pub fn seed(conn: &mut Connection) -> Result<usize, Error> {
    let tx = conn.transaction()?;
    let mut batch = Batch::new(&tx)?;
    seed_basics(&tx, &mut batch)?;
    seed_more(&tx, &mut batch)?;
    let written = batch.len();
    batch.commit(&tx)?;
    tx.execute("UPDATE oplog SET uploaded = 0, seq = NULL", [])?;
    tx.execute("DELETE FROM op_cursor", params![])?;
    // The destination may be a new one: every waveform has to be checked against it again.
    tx.execute("UPDATE analysis SET wf_pushed = 0", [])?;
    db::set_setting(&tx, SETTING_SEEDED, Some(SEEDED))?;
    tx.commit()?;
    Ok(written)
}

/// Writes ops for analysis rows that exist here but were never shared (rows made after sharing
/// was on, for example by the move of old analysis to `audio_fp` keys).
pub fn send_missing_analysis(conn: &Connection) -> Result<(), Error> {
    if !active(conn)? {
        return Ok(());
    }
    let tx = conn.unchecked_transaction()?;
    let mut batch = Batch::new(&tx)?;
    seed_analysis(&tx, &mut batch)?;
    batch.commit(&tx)?;
    Ok(tx.commit()?)
}

/// A library that had library data on before smart playlists, analysis and Tag Database values
/// were shared gets their ops once, without sending its whole log again.
pub fn catch_up(conn: &Connection) -> Result<(), Error> {
    if !active(conn)? || db::get_setting(conn, SETTING_SEEDED)?.as_deref() == Some(SEEDED) {
        return Ok(());
    }
    let tx = conn.unchecked_transaction()?;
    let mut batch = Batch::new(&tx)?;
    seed_more(&tx, &mut batch)?;
    batch.commit(&tx)?;
    db::set_setting(&tx, SETTING_SEEDED, Some(SEEDED))?;
    Ok(tx.commit()?)
}

fn seed_basics(tx: &Connection, batch: &mut Batch) -> Result<(), Error> {
    for (table, entity) in [("tags", "tag"), ("playlists", "playlist")] {
        let mut stmt = tx.prepare(&format!(
            "SELECT uid, name FROM {table} WHERE scope = 'shared' AND uid IS NOT NULL
             AND uid NOT IN (SELECT held FROM clashes)"
        ))?;
        let rows: Vec<(String, String)> = stmt
            .query_map([], |r| Ok((r.get(0)?, r.get(1)?)))?
            .collect::<Result<_, _>>()?;
        drop(stmt);
        for (uid, name) in rows {
            if state::get_str(tx, entity, &uid, "name")?.as_deref() != Some(name.as_str()) {
                if table == "tags" {
                    batch.tag(&uid, &name);
                } else {
                    batch.playlist(&uid, &name);
                }
            }
        }
    }
    let mut stmt = tx.prepare(
        "SELECT DISTINCT g.uid, t.audio_fp FROM track_tags tt
         JOIN tags g ON g.id = tt.tag_id AND g.scope = 'shared' AND g.uid IS NOT NULL
         JOIN tracks t ON t.id = tt.track_id AND t.audio_fp <> ''
         LEFT JOIN op_state s ON s.e = 'track_tag' AND s.f = 'present'
              AND s.id = g.uid || '/' || t.audio_fp
         WHERE s.val IS NOT 'true'",
    )?;
    let rows: Vec<(String, String)> = stmt
        .query_map([], |r| Ok((r.get(0)?, r.get(1)?)))?
        .collect::<Result<_, _>>()?;
    drop(stmt);
    for (uid, fp) in rows {
        batch.track_tag(&uid, &fp, true);
    }
    let mut stmt = tx.prepare(
        "SELECT g.uid, t.audio_fp, MIN(pt.pos) FROM playlist_tracks pt
         JOIN playlists g ON g.id = pt.playlist_id AND g.scope = 'shared' AND g.uid IS NOT NULL
         JOIN tracks t ON t.id = pt.track_id AND t.audio_fp <> ''
         LEFT JOIN op_state s ON s.e = 'playlist_track' AND s.f = 'present'
              AND s.id = g.uid || '/' || t.audio_fp
         WHERE s.val IS NOT 'true' GROUP BY g.uid, t.audio_fp",
    )?;
    let rows: Vec<(String, String, Option<String>)> = stmt
        .query_map([], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)))?
        .collect::<Result<_, _>>()?;
    drop(stmt);
    for (uid, fp, pos) in rows {
        let pos = pos.unwrap_or_else(|| frac::between(None, None));
        batch.playlist_add(&uid, &fp, &pos);
    }
    Ok(())
}

/// Smart playlists, hand-made Tag Database values and analysis.
fn seed_more(tx: &Connection, batch: &mut Batch) -> Result<(), Error> {
    seed_smart(tx, batch)?;
    seed_custom(tx, batch)?;
    seed_analysis(tx, batch)
}

fn seed_smart(tx: &Connection, batch: &mut Batch) -> Result<(), Error> {
    let mut stmt = tx.prepare(
        "SELECT uid, name, rules FROM smart_playlists WHERE scope = 'shared' AND uid IS NOT NULL
         AND uid NOT IN (SELECT held FROM clashes)",
    )?;
    let rows: Vec<(String, String, String)> = stmt
        .query_map([], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)))?
        .collect::<Result<_, _>>()?;
    drop(stmt);
    for (uid, name, rules) in rows {
        let rules: Value = serde_json::from_str(&rules).unwrap_or_else(|_| json!({}));
        let same = state::get_str(tx, "smart_playlist", &uid, F_NAME)?.as_deref()
            == Some(name.as_str())
            && state::get(tx, "smart_playlist", &uid, "rules")?.as_ref() == Some(&rules);
        if !same {
            batch.smart_playlist(&uid, &name, &rules);
        }
    }
    Ok(())
}

fn seed_custom(tx: &Connection, batch: &mut Batch) -> Result<(), Error> {
    let mut stmt = tx.prepare("SELECT field, value FROM tag_custom")?;
    let rows: Vec<(String, String)> = stmt
        .query_map([], |r| Ok((r.get(0)?, r.get(1)?)))?
        .collect::<Result<_, _>>()?;
    drop(stmt);
    for (field, value) in rows {
        let id = format!("{field}/{}", value.to_lowercase());
        if state::get_bool(tx, "tag_custom", &id, F_PRESENT)? != Some(true) {
            batch.custom_value(&field, &value, true);
        }
    }
    Ok(())
}

/// One analysis row as ops: hand edits as hand values with their flag, automatic results as
/// they are. A row without a `version` register has not been shared yet.
fn seed_analysis(tx: &Connection, batch: &mut Batch) -> Result<(), Error> {
    type Row = (
        String,
        Option<f64>,
        Option<String>,
        i64,
        Option<f64>,
        Option<f64>,
        Option<f64>,
        Option<i64>,
        [bool; 3],
    );
    let mut stmt = tx.prepare(
        "SELECT a.audio_fp, a.bpm, a.musical_key, a.version, a.duration, a.grid_bpm, a.first_beat,
                a.bar_offset, a.bpm_edited, a.key_edited, a.grid_edited
         FROM analysis a
         WHERE a.audio_fp <> '' AND EXISTS (SELECT 1 FROM tracks t WHERE t.audio_fp = a.audio_fp)
           AND NOT EXISTS (SELECT 1 FROM op_state s WHERE s.e = 'analysis' AND s.id = a.audio_fp
                           AND s.f = 'version')",
    )?;
    let rows: Vec<Row> = stmt
        .query_map([], |r| {
            Ok((
                r.get(0)?,
                r.get(1)?,
                r.get(2)?,
                r.get(3)?,
                r.get(4)?,
                r.get(5)?,
                r.get(6)?,
                r.get(7)?,
                [r.get(8)?, r.get(9)?, r.get(10)?],
            ))
        })?
        .collect::<Result<_, _>>()?;
    drop(stmt);
    for (fp, bpm, key, version, duration, grid_bpm, first, bar, [bpm_ed, key_ed, grid_ed]) in rows {
        batch.analysis(&fp, A_VERSION, json!(version));
        let analysed = version > 0;
        if bpm_ed {
            batch.analysis(&fp, A_BPM_HAND, json!(bpm));
            batch.analysis(&fp, A_BPM_EDITED, json!(true));
        } else if analysed {
            batch.analysis(&fp, A_BPM, json!(bpm));
        }
        if key_ed {
            batch.analysis(&fp, A_KEY_HAND, json!(key));
            batch.analysis(&fp, A_KEY_EDITED, json!(true));
        } else if analysed {
            batch.analysis(&fp, A_KEY, json!(key));
        }
        if grid_ed {
            batch.analysis(
                &fp,
                A_GRID_HAND,
                json!({"grid_bpm": grid_bpm, "first_beat": first, "bar_offset": bar}),
            );
            batch.analysis(&fp, A_GRID_EDITED, json!(true));
        } else if analysed && first.is_some() {
            batch.analysis(&fp, A_GRID_BPM, json!(grid_bpm));
            batch.analysis(&fp, A_FIRST_BEAT, json!(first));
            batch.analysis(&fp, A_BAR_OFFSET, json!(bar));
        }
        if duration.is_some() {
            batch.analysis(&fp, A_DURATION, json!(duration));
        }
    }
    Ok(())
}
