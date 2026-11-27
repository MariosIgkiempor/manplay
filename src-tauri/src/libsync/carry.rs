//! A re-encode (MP3 to FLAC) gives a song a new `audio_fp`, so every shared edit about the old
//! audio (tags, playlists, hand-set tempo) no longer points at the file. This finds such pairs and
//! moves what belongs to the old audio over to the new one on request, as ordinary ops, so every
//! device follows. Nothing is carried over without the user choosing it.
//!
//! Two shapes: the file was replaced in place (same path, new audio; `audio_changes`), or a file
//! of the same name in the same folder with another extension took the place of one that is now
//! missing.

use rusqlite::{Connection, OptionalExtension, params};
use serde::Serialize;

use crate::db;
use crate::error::Error;

/// A song whose old audio has tags, playlists or hand-set tempo to carry over.
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Candidate {
    pub old_fp: String,
    /// The file that now has the new audio.
    pub track_id: i64,
    pub title: String,
    pub artist: String,
    pub path: String,
    /// Where the old audio was, when it was another file.
    pub old_path: Option<String>,
    pub tags: i64,
    pub playlists: i64,
    /// A hand-set BPM, key or beat grid.
    pub edits: bool,
}

/// What a carry-over moved.
#[derive(Debug, Clone, Copy, Default, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Carried {
    pub tags: usize,
    pub playlists: usize,
    pub edits: usize,
}

struct Counts {
    tags: i64,
    playlists: i64,
    edits: bool,
}

/// What the files holding `old_fp` (other than `except`) carry.
fn counts(conn: &Connection, old_fp: &str, except: i64) -> Result<Counts, Error> {
    let tags: i64 = conn.query_row(
        "SELECT COUNT(DISTINCT tt.tag_id) FROM track_tags tt JOIN tracks t ON t.id = tt.track_id
         WHERE t.audio_fp = ?1 AND t.id <> ?2",
        params![old_fp, except],
        |r| r.get(0),
    )?;
    let playlists: i64 = conn.query_row(
        "SELECT COUNT(DISTINCT pt.playlist_id) FROM playlist_tracks pt
         JOIN tracks t ON t.id = pt.track_id WHERE t.audio_fp = ?1 AND t.id <> ?2",
        params![old_fp, except],
        |r| r.get(0),
    )?;
    counts_with_edits(conn, old_fp, tags, playlists)
}

fn counts_with_edits(
    conn: &Connection,
    old_fp: &str,
    tags: i64,
    playlists: i64,
) -> Result<Counts, Error> {
    let edits: bool = conn.query_row(
        "SELECT EXISTS (SELECT 1 FROM analysis WHERE audio_fp = ?1
                        AND (bpm_edited = 1 OR key_edited = 1 OR grid_edited = 1))",
        params![old_fp],
        |r| r.get(0),
    )?;
    Ok(Counts {
        tags,
        playlists,
        edits,
    })
}

fn dismissed(conn: &Connection, old_fp: &str) -> Result<bool, Error> {
    Ok(conn.query_row(
        "SELECT EXISTS (SELECT 1 FROM carry_dismissed WHERE old_fp = ?1)",
        params![old_fp],
        |r| r.get(0),
    )?)
}

/// Whether some present file other than `except` still has this audio: then it was copied, not
/// replaced, and the old audio keeps its tags.
fn still_held(conn: &Connection, fp: &str, except: i64) -> Result<bool, Error> {
    Ok(conn.query_row(
        "SELECT EXISTS (SELECT 1 FROM tracks WHERE audio_fp = ?1 AND id <> ?2
                        AND missing_since IS NULL AND file_state = 'here')",
        params![fp, except],
        |r| r.get(0),
    )?)
}

/// Every pair worth offering, newest decisions left out (dismissed ones).
pub fn candidates(conn: &Connection) -> Result<Vec<Candidate>, Error> {
    let mut out: Vec<Candidate> = Vec::new();
    // Replaced in place.
    let rows: Vec<(i64, String, String, String, String, String)> = conn
        .prepare(
            "SELECT c.track_id, c.old_fp, t.title, t.artist, t.path, c.new_fp FROM audio_changes c
             JOIN tracks t ON t.id = c.track_id
             WHERE t.missing_since IS NULL AND t.audio_fp = c.new_fp ORDER BY t.path",
        )?
        .query_map([], |r| {
            Ok((
                r.get(0)?,
                r.get(1)?,
                r.get(2)?,
                r.get(3)?,
                r.get(4)?,
                r.get(5)?,
            ))
        })?
        .collect::<Result<_, _>>()?;
    for (track_id, old_fp, title, artist, path, _) in rows {
        if dismissed(conn, &old_fp)? || still_held(conn, &old_fp, track_id)? {
            continue;
        }
        // Memberships of the file itself, plus any other file that had the old audio.
        let own = own_counts(conn, track_id)?;
        let others = counts(conn, &old_fp, track_id)?;
        let edits = others.edits;
        let (tags, playlists) = (own.0.max(others.tags), own.1.max(others.playlists));
        if tags + playlists == 0 && !edits {
            continue;
        }
        out.push(Candidate {
            old_fp,
            track_id,
            title,
            artist,
            path,
            old_path: None,
            tags,
            playlists,
            edits,
        });
    }
    // A file of the same name and another extension took the place of a missing one.
    let missing: Vec<(i64, String, String)> = conn
        .prepare(
            "SELECT id, path, audio_fp FROM tracks
             WHERE missing_since IS NOT NULL AND audio_fp IS NOT NULL AND audio_fp <> ''
             ORDER BY path",
        )?
        .query_map([], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)))?
        .collect::<Result<_, _>>()?;
    for (old_id, old_path, old_fp) in missing {
        if dismissed(conn, &old_fp)?
            || out.iter().any(|c| c.old_fp == old_fp)
            || still_held(conn, &old_fp, old_id)?
        {
            continue;
        }
        let Some(stem) = stem_of(&old_path) else {
            continue;
        };
        let found: Option<(i64, String, String, String)> = conn
            .query_row(
                "SELECT id, path, title, artist FROM tracks
                 WHERE missing_since IS NULL AND file_state = 'here'
                   AND audio_fp IS NOT NULL AND audio_fp <> '' AND audio_fp <> ?1 AND lower(substr(path, 1, length(?2) + 1)) = lower(?2 || '.')
                   AND instr(substr(path, length(?2) + 2), '.') = 0
                 ORDER BY path LIMIT 1",
                params![old_fp, stem],
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)),
            )
            .optional()?;
        let Some((track_id, path, title, artist)) = found else {
            continue;
        };
        let c = counts(conn, &old_fp, track_id)?;
        if c.tags + c.playlists == 0 && !c.edits {
            continue;
        }
        out.push(Candidate {
            old_fp,
            track_id,
            title,
            artist,
            path,
            old_path: Some(old_path),
            tags: c.tags,
            playlists: c.playlists,
            edits: c.edits,
        });
    }
    Ok(out)
}

/// `(tags, playlists)` a file has itself.
fn own_counts(conn: &Connection, track_id: i64) -> Result<(i64, i64), Error> {
    Ok((
        conn.query_row(
            "SELECT COUNT(*) FROM track_tags WHERE track_id = ?1",
            params![track_id],
            |r| r.get(0),
        )?,
        conn.query_row(
            "SELECT COUNT(*) FROM playlist_tracks WHERE track_id = ?1",
            params![track_id],
            |r| r.get(0),
        )?,
    ))
}

/// The path without its extension.
fn stem_of(path: &str) -> Option<&str> {
    let name_start = path.rfind(['/', '\\']).map_or(0, |i| i + 1);
    let dot = path[name_start..].rfind('.')?;
    (dot > 0).then(|| &path[..name_start + dot])
}

/// Moves what belongs to `old_fp` over to the audio of `track_id`: tag and playlist memberships
/// (with their places in the playlists), hand-set BPM, key and beat grid, and cues. Shared items
/// get ops, so other devices follow; local ones move only here.
pub fn carry_over(conn: &mut Connection, old_fp: &str, track_id: i64) -> Result<Carried, Error> {
    let tx = conn.transaction()?;
    let new_fp = db::audio_fp_of(&tx, track_id)?
        .filter(|fp| !fp.is_empty())
        .ok_or_else(|| Error::Msg("That song has no audio fingerprint yet.".into()))?;
    if new_fp == old_fp {
        return Ok(Carried::default());
    }
    let changed_in_place: bool = tx.query_row(
        "SELECT EXISTS (SELECT 1 FROM audio_changes WHERE track_id = ?1 AND old_fp = ?2)",
        params![track_id, old_fp],
        |r| r.get(0),
    )?;
    // Files whose memberships move: every file with the old audio, and the file itself when its
    // audio was replaced under it.
    let mut carriers: Vec<i64> = tx
        .prepare("SELECT id FROM tracks WHERE audio_fp = ?1 AND id <> ?2")?
        .query_map(params![old_fp, track_id], |r| r.get(0))?
        .collect::<Result<_, _>>()?;
    carriers.push(track_id);
    let mut out = Carried::default();
    let mut ops = crate::libsync::Batch::new(&tx)?;

    for &carrier in &carriers {
        let tags: Vec<(i64, String, String)> = tx
            .prepare(
                "SELECT g.id, COALESCE(g.uid, ''), g.scope FROM track_tags tt
                 JOIN tags g ON g.id = tt.tag_id WHERE tt.track_id = ?1",
            )?
            .query_map(params![carrier], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)))?
            .collect::<Result<_, _>>()?;
        for (tag_id, uid, scope) in tags {
            // The file itself keeps its tags when it is the carrier (replaced in place).
            if carrier != track_id {
                tx.execute(
                    "INSERT OR IGNORE INTO track_tags (track_id, tag_id) VALUES (?1, ?2)",
                    params![track_id, tag_id],
                )?;
                tx.execute(
                    "DELETE FROM track_tags WHERE track_id = ?1 AND tag_id = ?2",
                    params![carrier, tag_id],
                )?;
            } else if !changed_in_place {
                continue;
            }
            if scope == "shared" && !uid.is_empty() {
                ops.track_tag(&uid, old_fp, false);
                ops.track_tag(&uid, &new_fp, true);
            }
            out.tags += 1;
        }
        let lists: Vec<(i64, String, String, i64, Option<String>)> = tx
            .prepare(
                "SELECT p.id, COALESCE(p.uid, ''), p.scope, pt.position, pt.pos
                 FROM playlist_tracks pt JOIN playlists p ON p.id = pt.playlist_id
                 WHERE pt.track_id = ?1",
            )?
            .query_map(params![carrier], |r| {
                Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?))
            })?
            .collect::<Result<_, _>>()?;
        for (playlist_id, uid, scope, position, pos) in lists {
            if carrier != track_id {
                tx.execute(
                    "INSERT OR IGNORE INTO playlist_tracks (playlist_id, track_id, position, pos)
                     VALUES (?1, ?2, ?3, ?4)",
                    params![playlist_id, track_id, position, pos],
                )?;
                tx.execute(
                    "DELETE FROM playlist_tracks WHERE playlist_id = ?1 AND track_id = ?2",
                    params![playlist_id, carrier],
                )?;
            } else if !changed_in_place {
                continue;
            }
            if scope == "shared"
                && !uid.is_empty()
                && let Some(pos) = pos
            {
                ops.playlist_remove(&uid, old_fp);
                ops.playlist_add(&uid, &new_fp, &pos);
            }
            out.playlists += 1;
        }
    }
    ops.commit(&tx)?;

    out.edits = carry_edits(&tx, old_fp, &new_fp, track_id)?;
    // Cues belong to the audio; the new audio keeps its own when it has any.
    tx.execute(
        "UPDATE cues SET audio_fp = ?2 WHERE audio_fp = ?1
         AND NOT EXISTS (SELECT 1 FROM cues WHERE audio_fp = ?2)",
        params![old_fp, new_fp],
    )?;
    tx.execute(
        "DELETE FROM audio_changes WHERE track_id = ?1",
        params![track_id],
    )?;
    // Done: the old audio is not offered again.
    tx.execute(
        "INSERT OR IGNORE INTO carry_dismissed (old_fp) VALUES (?1)",
        params![old_fp],
    )?;
    tx.commit()?;
    Ok(out)
}

/// Hand-set BPM, key and beat grid of the old audio go to the new one unless it has its own.
fn carry_edits(
    conn: &Connection,
    old_fp: &str,
    new_fp: &str,
    track_id: i64,
) -> Result<usize, Error> {
    type Row = (
        Option<f64>,
        Option<String>,
        bool,
        bool,
        bool,
        Option<f64>,
        Option<f64>,
        Option<i64>,
    );
    let old: Option<Row> = conn
        .query_row(
            "SELECT bpm, musical_key, bpm_edited, key_edited, grid_edited, grid_bpm, first_beat,
                    bar_offset FROM analysis WHERE audio_fp = ?1",
            params![old_fp],
            |r| {
                Ok((
                    r.get(0)?,
                    r.get(1)?,
                    r.get(2)?,
                    r.get(3)?,
                    r.get(4)?,
                    r.get(5)?,
                    r.get(6)?,
                    r.get(7)?,
                ))
            },
        )
        .optional()?;
    let Some((bpm, key, bpm_edited, key_edited, grid_edited, grid_bpm, first, bar)) = old else {
        return Ok(0);
    };
    let (new_bpm, new_key, new_grid): (bool, bool, bool) = conn
        .query_row(
            "SELECT bpm_edited, key_edited, grid_edited FROM analysis WHERE audio_fp = ?1",
            params![new_fp],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
        )
        .optional()?
        .unwrap_or((false, false, false));
    let mut moved = 0;
    if bpm_edited && !new_bpm && bpm.is_some() {
        db::set_tempo_key(conn, track_id, Some(bpm), None)?;
        moved += 1;
    }
    if key_edited && !new_key && key.is_some() {
        db::set_tempo_key(conn, track_id, None, Some(key.as_deref()))?;
        moved += 1;
    }
    if grid_edited && !new_grid && first.is_some() {
        conn.execute(
            "INSERT OR IGNORE INTO analysis (audio_fp, version, analyzed_at) VALUES (?1, 0, 0)",
            params![new_fp],
        )?;
        conn.execute(
            "UPDATE analysis SET grid_bpm = ?2, first_beat = ?3, bar_offset = ?4
             WHERE audio_fp = ?1",
            params![new_fp, grid_bpm, first, bar],
        )?;
        db::mark_grid_edited(conn, track_id)?;
        moved += 1;
    }
    Ok(moved)
}

/// The user chose to leave this old audio's tags and playlists where they are.
pub fn dismiss(conn: &Connection, old_fp: &str) -> Result<(), Error> {
    conn.execute(
        "INSERT OR IGNORE INTO carry_dismissed (old_fp) VALUES (?1)",
        params![old_fp],
    )?;
    conn.execute(
        "DELETE FROM audio_changes WHERE old_fp = ?1",
        params![old_fp],
    )?;
    Ok(())
}
