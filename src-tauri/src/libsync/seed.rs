//! Switching library data on: ops for what the library already holds.

use rusqlite::{Connection, params};

use super::frac;
use super::state;
use super::write::Batch;
use crate::error::Error;

/// Writes an op for every shared tag, playlist and membership the register store does not have
/// yet (or holds under another name), and marks the whole log for upload again, since the
/// destination may be a new one. Returns how many ops were written.
///
/// Edits made while sharing was off that *remove* something are not sent: only what exists now.
pub fn seed(conn: &mut Connection) -> Result<usize, Error> {
    let tx = conn.transaction()?;
    let mut batch = Batch::new(&tx)?;
    for (table, entity) in [("tags", "tag"), ("playlists", "playlist")] {
        let mut stmt = tx.prepare(&format!(
            "SELECT uid, name FROM {table} WHERE scope = 'shared' AND uid IS NOT NULL"
        ))?;
        let rows: Vec<(String, String)> = stmt
            .query_map([], |r| Ok((r.get(0)?, r.get(1)?)))?
            .collect::<Result<_, _>>()?;
        drop(stmt);
        for (uid, name) in rows {
            if state::get_str(&tx, entity, &uid, "name")?.as_deref() != Some(name.as_str()) {
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
    let written = batch.len();
    batch.commit(&tx)?;
    tx.execute("UPDATE oplog SET uploaded = 0", [])?;
    tx.execute("DELETE FROM op_cursor", params![])?;
    tx.commit()?;
    Ok(written)
}
