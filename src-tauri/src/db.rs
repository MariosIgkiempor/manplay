use std::path::Path;

use rusqlite::{Connection, OptionalExtension, params};
use serde::Serialize;

use crate::error::Error;
use crate::sync::{RemoteSignature, SignatureCache};

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Track {
    pub id: i64,
    pub path: String,
    pub artist: String,
    pub album: String,
    pub title: String,
    pub size: i64,
    pub tags: Vec<String>,
    /// Number of sync targets that currently hold an up-to-date copy.
    pub synced_count: i64,
    pub duration_ms: Option<i64>,
    pub bitrate: Option<i64>,
    pub sample_rate: Option<i64>,
    /// Detected tempo, else the one in the file's tags.
    pub bpm: Option<f64>,
    /// Detected key in rekordbox spelling (`Am`, `F#`), else the one in the file's tags.
    pub key: Option<String>,
    /// The audio has been through BPM and key detection (whether or not it found them).
    pub analyzed: bool,
    /// Tag values shown in lists (BPM, key, genre, label, ...), as stored in the file.
    pub fields: std::collections::BTreeMap<String, String>,
    /// Which of BPM, key and beat grid were set by hand.
    pub edited: Edited,
    /// Unix seconds the song came into the library, when known.
    pub added_at: Option<i64>,
}

#[derive(Default)]
pub struct NewTrack {
    pub path: String,
    pub artist: String,
    pub album: String,
    pub title: String,
    pub size: i64,
    /// See `scan::fingerprint`; `None` when the file could not be sampled.
    pub fingerprint: Option<String>,
    /// See `audioprint`; an empty string when the audio could not be fingerprinted, `None` when
    /// it was not tried.
    pub audio_fp: Option<String>,
    pub duration_ms: Option<i64>,
    pub bitrate: Option<i64>,
    pub sample_rate: Option<i64>,
    /// BPM and key as written in the file's tags.
    pub tag_bpm: Option<f64>,
    pub tag_key: Option<String>,
    /// JSON object of the list fields (see `tags::LISTED`); `None` when the tag was unreadable.
    pub fields: Option<String>,
}

/// Remembered tag values (artists, genres, ...), rebuilt on every scan.
fn create_tag_values(conn: &Connection) -> Result<(), Error> {
    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS tag_values (
             field TEXT NOT NULL,
             value TEXT NOT NULL,
             count INTEGER NOT NULL,
             PRIMARY KEY (field, value)
         );
         -- Values made by hand in the Tag Database; kept until a song uses them.
         CREATE TABLE IF NOT EXISTS tag_custom (
             field TEXT NOT NULL,
             value TEXT NOT NULL COLLATE NOCASE,
             PRIMARY KEY (field, value)
         );",
    )?;
    Ok(())
}

/// Tag tables that live outside the main schema, plus any parent tag levels that are missing.
fn prepare_tags(conn: &Connection) -> Result<(), Error> {
    create_tag_values(conn)?;
    let tx = conn.unchecked_transaction()?;
    let mut ops = crate::libsync::Batch::new(&tx)?;
    restore_tag_parents(&tx, &mut ops)?;
    ops.commit(&tx)?;
    Ok(tx.commit()?)
}

// ---- export selections -------------------------------------------------------

/// What a destination gets: library playlists by id, and tags that become playlists. Saved when
/// the destination is exported to, so it is what the destination holds.
#[derive(Serialize, serde::Deserialize, Default, Clone, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase", default)]
pub struct ExportSelection {
    pub playlists: Vec<i64>,
    pub tags: Vec<String>,
    /// Smart playlists (see `smart_playlists`), by id.
    pub smart: Vec<i64>,
    /// USB drives: what happens to the playlists and songs already there.
    pub usb_mode: crate::usb_export::Mode,
    /// USB drives: also write the playlists as Serato crates.
    pub usb_serato: bool,
}

fn mode_text(mode: crate::usb_export::Mode) -> String {
    serde_json::to_value(mode)
        .ok()
        .and_then(|v| v.as_str().map(str::to_owned))
        .unwrap_or_default()
}

fn mode_from(text: &str) -> crate::usb_export::Mode {
    serde_json::from_value(serde_json::Value::String(text.to_owned())).unwrap_or_default()
}

/// The settings key the rekordbox choice lived under before it moved to `export_selections`.
const LEGACY_RB_SELECTION: &str = "rekordbox_selection";

/// The destination key of the rekordbox XML file. USB drives are `usb:<volume id>`.
pub const RB_DESTINATION: &str = "rekordbox";

fn create_export_selections(conn: &Connection) -> Result<(), Error> {
    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS export_selections (
             destination TEXT PRIMARY KEY,
             playlists   TEXT NOT NULL DEFAULT '[]',
             tags        TEXT NOT NULL DEFAULT '[]'
         );
         -- Rule-based playlists. Only the rules are kept; the songs are worked out when needed.
         CREATE TABLE IF NOT EXISTS smart_playlists (
             id    INTEGER PRIMARY KEY,
             name  TEXT NOT NULL,
             rules TEXT NOT NULL DEFAULT '{}'
         );",
    )?;
    // Smart playlists briefly belonged to one export destination; they are the library's now.
    if has_column(conn, "smart_playlists", "destination")? {
        conn.execute_batch(
            "DROP INDEX IF EXISTS smart_playlists_destination;
             ALTER TABLE smart_playlists DROP COLUMN destination;",
        )?;
    }
    add_column(
        conn,
        "export_selections",
        "smart",
        "TEXT NOT NULL DEFAULT '[]'",
    )?;
    add_column(
        conn,
        "export_selections",
        "usb_mode",
        "TEXT NOT NULL DEFAULT 'add'",
    )?;
    add_column(
        conn,
        "export_selections",
        "usb_serato",
        "INTEGER NOT NULL DEFAULT 0",
    )?;
    migrate_rekordbox_selection(conn)
}

/// The old rekordbox choice exported every playlist except `excludedPlaylists`. It becomes the
/// list of playlists that were going into the file, so new playlists now stay out until chosen.
fn migrate_rekordbox_selection(conn: &Connection) -> Result<(), Error> {
    #[derive(serde::Deserialize, Default)]
    #[serde(rename_all = "camelCase", default)]
    struct Legacy {
        excluded_playlists: Vec<i64>,
        tags: Vec<String>,
    }
    let Some(raw) = get_setting(conn, LEGACY_RB_SELECTION)? else {
        return Ok(());
    };
    let legacy: Legacy = serde_json::from_str(&raw).unwrap_or_default();
    if export_selection(conn, RB_DESTINATION)?.is_none() {
        let playlists = playlist_ids(conn)?
            .into_iter()
            .filter(|id| !legacy.excluded_playlists.contains(id))
            .collect();
        set_export_selection(
            conn,
            RB_DESTINATION,
            &ExportSelection {
                playlists,
                tags: legacy.tags,
                ..ExportSelection::default()
            },
        )?;
    }
    set_setting(conn, LEGACY_RB_SELECTION, None)
}

/// Every library playlist's id.
pub fn playlist_ids(conn: &Connection) -> Result<Vec<i64>, Error> {
    let mut stmt = conn.prepare("SELECT id FROM playlists ORDER BY id")?;
    let ids = stmt
        .query_map([], |r| r.get(0))?
        .collect::<Result<Vec<i64>, _>>()?;
    Ok(ids)
}

/// What was last exported to a destination; `None` before its first export.
pub fn export_selection(
    conn: &Connection,
    destination: &str,
) -> Result<Option<ExportSelection>, Error> {
    let row: Option<(String, String, String, String, bool)> = conn
        .query_row(
            "SELECT playlists, tags, smart, usb_mode, usb_serato FROM export_selections
             WHERE destination = ?1",
            params![destination],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?)),
        )
        .optional()?;
    let Some((playlists, tags, smart, usb_mode, usb_serato)) = row else {
        return Ok(None);
    };
    Ok(Some(ExportSelection {
        playlists: ids_from_stored(conn, "playlists", &playlists)?,
        tags: serde_json::from_str(&tags).unwrap_or_default(),
        smart: ids_from_stored(conn, "smart_playlists", &smart)?,
        usb_mode: mode_from(&usb_mode),
        usb_serato,
    }))
}

/// Selections keep playlists by uid, so a choice survives the ids being different on another
/// install (restored backup, joined library). Callers see this device's row ids.
fn ids_from_stored(conn: &Connection, table: &str, raw: &str) -> Result<Vec<i64>, Error> {
    let entries: Vec<serde_json::Value> = serde_json::from_str(raw).unwrap_or_default();
    let mut ids = Vec::new();
    for entry in entries {
        let id: Option<i64> = match &entry {
            serde_json::Value::String(uid) => conn
                .query_row(
                    &format!("SELECT id FROM {table} WHERE uid = ?1"),
                    params![uid],
                    |r| r.get(0),
                )
                .optional()?,
            // Saved before selections held uids; `migrate_selection_uids` rewrites these.
            serde_json::Value::Number(n) => n.as_i64(),
            _ => None,
        };
        if let Some(id) = id {
            ids.push(id);
        }
    }
    Ok(ids)
}

/// The uids of the rows with these ids; a row that is gone is left out.
fn uids_for(conn: &Connection, table: &str, ids: &[i64]) -> Result<Vec<String>, Error> {
    let mut uids = Vec::new();
    for id in ids {
        let uid: Option<Option<String>> = conn
            .query_row(
                &format!("SELECT uid FROM {table} WHERE id = ?1"),
                params![id],
                |r| r.get(0),
            )
            .optional()?;
        if let Some(Some(uid)) = uid {
            uids.push(uid);
        }
    }
    Ok(uids)
}

/// Selections saved with integer ids (older versions) become uids, once. A playlist that no
/// longer exists is dropped from the selection, as it already was in effect.
pub(crate) fn migrate_selection_uids(conn: &Connection) -> Result<(), Error> {
    let rows: Vec<(String, String, String)> = conn
        .prepare("SELECT destination, playlists, smart FROM export_selections")?
        .query_map([], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)))?
        .collect::<Result<_, _>>()?;
    for (destination, playlists, smart) in rows {
        let legacy = |raw: &str| {
            serde_json::from_str::<Vec<serde_json::Value>>(raw)
                .is_ok_and(|v| v.iter().any(serde_json::Value::is_number))
        };
        if !legacy(&playlists) && !legacy(&smart) {
            continue;
        }
        let as_uids = |table: &str, raw: &str| -> Result<String, Error> {
            let ids = ids_from_stored(conn, table, raw)?;
            serde_json::to_string(&uids_for(conn, table, &ids)?)
                .map_err(|e| Error::Msg(e.to_string()))
        };
        let playlists = as_uids("playlists", &playlists)?;
        let smart = as_uids("smart_playlists", &smart)?;
        conn.execute(
            "UPDATE export_selections SET playlists = ?2, smart = ?3 WHERE destination = ?1",
            params![destination, playlists, smart],
        )?;
    }
    Ok(())
}

pub fn remove_export_selection(conn: &Connection, destination: &str) -> Result<(), Error> {
    conn.execute(
        "DELETE FROM export_selections WHERE destination = ?1",
        params![destination],
    )?;
    Ok(())
}

pub fn set_export_selection(
    conn: &Connection,
    destination: &str,
    selection: &ExportSelection,
) -> Result<(), Error> {
    let playlists = serde_json::to_string(&uids_for(conn, "playlists", &selection.playlists)?)
        .map_err(|e| Error::Msg(e.to_string()))?;
    let tags = serde_json::to_string(&selection.tags).map_err(|e| Error::Msg(e.to_string()))?;
    let smart = serde_json::to_string(&uids_for(conn, "smart_playlists", &selection.smart)?)
        .map_err(|e| Error::Msg(e.to_string()))?;
    conn.execute(
        "INSERT INTO export_selections (destination, playlists, tags, smart, usb_mode, usb_serato)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6)
         ON CONFLICT(destination) DO UPDATE SET
             playlists = excluded.playlists, tags = excluded.tags, smart = excluded.smart,
             usb_mode = excluded.usb_mode, usb_serato = excluded.usb_serato",
        params![
            destination,
            playlists,
            tags,
            smart,
            mode_text(selection.usb_mode),
            selection.usb_serato
        ],
    )?;
    Ok(())
}

/// Rules as the editor sees them (tag names) turned into what is stored and shared (tag uids).
/// A name that is no tag here stays as typed; an unknown-tag marker goes back to its uid.
pub(crate) fn rules_to_stored(
    conn: &Connection,
    rules: &crate::smart::Rules,
) -> Result<crate::smart::Rules, Error> {
    let mut failure = None;
    let out = rules.map_tags(|entry| {
        if let Some(uid) = entry.strip_prefix(crate::smart::UNKNOWN_PREFIX)
            && crate::smart::is_uid(uid)
        {
            return uid.to_owned();
        }
        if crate::smart::is_uid(entry) {
            return entry.to_owned();
        }
        match conn
            .query_row(
                "SELECT uid FROM tags WHERE name = ?1 AND uid IS NOT NULL",
                params![entry],
                |r| r.get::<_, String>(0),
            )
            .optional()
        {
            Ok(uid) => uid.unwrap_or_else(|| entry.to_owned()),
            Err(e) => {
                failure = Some(e);
                entry.to_owned()
            }
        }
    });
    failure.map_or(Ok(out), |e| Err(e.into()))
}

/// Stored rules turned into tag names for the editor and for working out songs. A uid this
/// device has no tag for (a tag that is local to another device, or was deleted) comes back as
/// `?<uid>`, which matches no song and is saved back as the same uid.
fn rules_from_stored(
    conn: &Connection,
    rules: &crate::smart::Rules,
) -> Result<crate::smart::Rules, Error> {
    let mut failure = None;
    let out = rules.map_tags(|entry| {
        if !crate::smart::is_uid(entry) {
            return entry.to_owned();
        }
        match conn
            .query_row(
                "SELECT name FROM tags WHERE uid = ?1",
                params![entry],
                |r| r.get::<_, String>(0),
            )
            .optional()
        {
            Ok(name) => name.unwrap_or_else(|| format!("{}{entry}", crate::smart::UNKNOWN_PREFIX)),
            Err(e) => {
                failure = Some(e);
                entry.to_owned()
            }
        }
    });
    failure.map_or(Ok(out), |e| Err(e.into()))
}

pub(crate) fn rules_json(rules: &crate::smart::Rules) -> Result<serde_json::Value, Error> {
    serde_json::to_value(rules).map_err(|e| Error::Msg(e.to_string()))
}

/// Every smart playlist, by name.
pub fn smart_playlists(conn: &Connection) -> Result<Vec<crate::smart::SmartPlaylist>, Error> {
    let mut stmt =
        conn.prepare("SELECT id, name, rules FROM smart_playlists ORDER BY name COLLATE NOCASE")?;
    let rows = stmt
        .query_map([], |r| {
            Ok((
                r.get::<_, i64>(0)?,
                r.get::<_, String>(1)?,
                r.get::<_, String>(2)?,
            ))
        })?
        .collect::<Result<Vec<_>, _>>()?;
    drop(stmt);
    let mut out = Vec::new();
    for (id, name, rules) in rows {
        let stored: crate::smart::Rules = serde_json::from_str(&rules).unwrap_or_default();
        out.push(crate::smart::SmartPlaylist {
            id,
            name,
            rules: rules_from_stored(conn, &stored)?,
        });
    }
    Ok(out)
}

/// A smart playlist as the sidebar lists it, with where it is shared and whether it is hidden or
/// held under another name.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SmartListing {
    #[serde(flatten)]
    pub playlist: crate::smart::SmartPlaylist,
    pub scope: String,
    pub hidden: bool,
    pub held: bool,
}

pub fn smart_listing(conn: &Connection) -> Result<Vec<SmartListing>, Error> {
    let mut out = Vec::new();
    for playlist in smart_playlists(conn)? {
        let (scope, hidden, held): (String, bool, bool) = conn.query_row(
            "SELECT scope, hidden,
                    EXISTS (SELECT 1 FROM clashes c WHERE c.kind = 'smart_playlist' AND c.held = uid)
             FROM smart_playlists WHERE id = ?1",
            params![playlist.id],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
        )?;
        out.push(SmartListing {
            playlist,
            scope,
            hidden,
            held,
        });
    }
    Ok(out)
}

/// Adds a smart playlist (`id` 0) or changes one; returns it as stored. Shared ones also write
/// their ops.
pub fn save_smart_playlist(
    conn: &Connection,
    playlist: &crate::smart::SmartPlaylist,
) -> Result<crate::smart::SmartPlaylist, Error> {
    let tx = conn.unchecked_transaction()?;
    let stored = rules_to_stored(&tx, &playlist.rules)?;
    let value = rules_json(&stored)?;
    let rules = value.to_string();
    let mut ops = crate::libsync::Batch::new(&tx)?;
    let id = if playlist.id == 0 {
        let uid = crate::libsync::new_uid();
        let scope = crate::libsync::default_scope(&tx)?;
        if scope == "shared" {
            crate::libsync::share::refuse_local_tags(&tx, &stored)?;
        }
        tx.execute(
            "INSERT INTO smart_playlists (name, rules, uid, scope) VALUES (?1, ?2, ?3, ?4)",
            params![playlist.name, rules, uid, scope],
        )?;
        if scope == "shared" {
            ops.smart_playlist(&uid, &playlist.name, &value);
        }
        tx.last_insert_rowid()
    } else {
        let old: Option<(String, String, String, String)> = tx
            .query_row(
                "SELECT COALESCE(uid, ''), scope, name, rules FROM smart_playlists WHERE id = ?1",
                params![playlist.id],
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)),
            )
            .optional()?;
        let Some((uid, scope, old_name, old_rules)) = old else {
            return Err(Error::Msg("That smart playlist no longer exists.".into()));
        };
        if scope == "shared" {
            crate::libsync::share::refuse_local_tags(&tx, &stored)?;
        }
        tx.execute(
            "UPDATE smart_playlists SET name = ?2, rules = ?3 WHERE id = ?1",
            params![playlist.id, playlist.name, rules],
        )?;
        if scope == "shared" && !uid.is_empty() {
            if old_name != playlist.name {
                ops.smart_playlist(&uid, &playlist.name, &value);
            } else if serde_json::from_str::<serde_json::Value>(&old_rules)
                .ok()
                .as_ref()
                != Some(&value)
            {
                ops.smart_playlist_rules(&uid, &value);
            }
        }
        playlist.id
    };
    ops.commit(&tx)?;
    crate::libsync::clashes::refresh(&tx)?;
    tx.commit()?;
    Ok(crate::smart::SmartPlaylist {
        id,
        ..playlist.clone()
    })
}

pub fn delete_smart_playlist(conn: &Connection, id: i64) -> Result<(), Error> {
    let tx = conn.unchecked_transaction()?;
    let ident: Option<(String, String)> = tx
        .query_row(
            "SELECT COALESCE(uid, ''), scope FROM smart_playlists WHERE id = ?1",
            params![id],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .optional()?;
    tx.execute("DELETE FROM smart_playlists WHERE id = ?1", params![id])?;
    if let Some((uid, scope)) = ident
        && scope == "shared"
        && !uid.is_empty()
    {
        let mut ops = crate::libsync::Batch::new(&tx)?;
        ops.smart_playlist_deleted(&uid);
        ops.commit(&tx)?;
    }
    crate::libsync::clashes::refresh(&tx)?;
    tx.commit()?;
    Ok(())
}

/// A tag moved to another tag (rename or merge): smart playlists that used its uid use the new
/// one, so the rules keep working.
pub(crate) fn repoint_smart_rules(
    conn: &Connection,
    from: &str,
    to: &str,
    ops: &mut crate::libsync::Batch,
) -> Result<(), Error> {
    if from.is_empty() || to.is_empty() || from == to {
        return Ok(());
    }
    let rows: Vec<(i64, String, String, String)> = conn
        .prepare(
            "SELECT id, COALESCE(uid, ''), scope, rules FROM smart_playlists
             WHERE instr(rules, ?1) > 0",
        )?
        .query_map(params![from], |r| {
            Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?))
        })?
        .collect::<Result<_, _>>()?;
    for (id, uid, scope, rules) in rows {
        let rules: crate::smart::Rules = serde_json::from_str(&rules).unwrap_or_default();
        let moved = rules.map_tags(|t| {
            if t == from {
                to.to_owned()
            } else {
                t.to_owned()
            }
        });
        if moved == rules {
            continue;
        }
        let value = rules_json(&moved)?;
        conn.execute(
            "UPDATE smart_playlists SET rules = ?2 WHERE id = ?1",
            params![id, value.to_string()],
        )?;
        if scope == "shared" && !uid.is_empty() {
            ops.smart_playlist_rules(&uid, &value);
        }
    }
    Ok(())
}

/// A tag was deleted: smart playlists on this device stop asking for it (it can never match
/// again), instead of showing an unknown tag for good. No op is written: the deletion itself is
/// shared, and every device drops the tag from the rules the same way, so Restore can bring the
/// rule back.
fn drop_smart_rule_tag(conn: &Connection, tag_uid: &str) -> Result<(), Error> {
    if tag_uid.is_empty() {
        return Ok(());
    }
    let rows: Vec<(i64, String)> = conn
        .prepare("SELECT id, rules FROM smart_playlists WHERE instr(rules, ?1) > 0")?
        .query_map(params![tag_uid], |r| Ok((r.get(0)?, r.get(1)?)))?
        .collect::<Result<_, _>>()?;
    for (id, rules) in rows {
        let rules: crate::smart::Rules = serde_json::from_str(&rules).unwrap_or_default();
        let kept = rules.without_tag(tag_uid);
        if kept != rules {
            conn.execute(
                "UPDATE smart_playlists SET rules = ?2 WHERE id = ?1",
                params![id, rules_json(&kept)?.to_string()],
            )?;
        }
    }
    Ok(())
}

/// Rules saved before they were kept by tag uid hold tag names: each name that is a tag here is
/// replaced by its uid. A name that is no tag stays as it is (it matched nothing before and
/// still does not). Safe to repeat.
fn convert_smart_rules(conn: &Connection) -> Result<(), Error> {
    let rows: Vec<(i64, String)> = conn
        .prepare("SELECT id, rules FROM smart_playlists")?
        .query_map([], |r| Ok((r.get(0)?, r.get(1)?)))?
        .collect::<Result<_, _>>()?;
    for (id, rules) in rows {
        let Ok(old) = serde_json::from_str::<crate::smart::Rules>(&rules) else {
            continue;
        };
        let new = rules_to_stored(conn, &old)?;
        if new != old {
            conn.execute(
                "UPDATE smart_playlists SET rules = ?2 WHERE id = ?1",
                params![id, rules_json(&new)?.to_string()],
            )?;
        }
    }
    Ok(())
}

#[allow(clippy::too_many_lines)]
pub fn open(path: &Path) -> Result<Connection, Error> {
    let conn = Connection::open(path)?;
    conn.execute_batch(
        "PRAGMA journal_mode = WAL;
         PRAGMA foreign_keys = ON;
         CREATE TABLE IF NOT EXISTS tracks (
             id     INTEGER PRIMARY KEY,
             path   TEXT NOT NULL UNIQUE,
             artist TEXT NOT NULL,
             album  TEXT NOT NULL,
             title  TEXT NOT NULL,
             size   INTEGER NOT NULL
         );
         CREATE TABLE IF NOT EXISTS playlists (
             id   INTEGER PRIMARY KEY,
             name TEXT NOT NULL UNIQUE
         );
         CREATE TABLE IF NOT EXISTS playlist_tracks (
             playlist_id INTEGER NOT NULL REFERENCES playlists(id) ON DELETE CASCADE,
             track_id    INTEGER NOT NULL REFERENCES tracks(id) ON DELETE CASCADE,
             position    INTEGER NOT NULL,
             PRIMARY KEY (playlist_id, track_id)
         );
         CREATE TABLE IF NOT EXISTS settings (
             key   TEXT PRIMARY KEY,
             value TEXT NOT NULL
         );
         CREATE TABLE IF NOT EXISTS sync_targets (
             id      INTEGER PRIMARY KEY,
             tailnet TEXT NOT NULL,
             machine TEXT NOT NULL,
             path    TEXT NOT NULL,
             UNIQUE (tailnet, machine, path)
         );
         CREATE TABLE IF NOT EXISTS synced_files (
             target_id INTEGER NOT NULL REFERENCES sync_targets(id) ON DELETE CASCADE,
             track_id  INTEGER NOT NULL REFERENCES tracks(id) ON DELETE CASCADE,
             size      INTEGER NOT NULL,
             synced_at INTEGER NOT NULL,
             PRIMARY KEY (target_id, track_id)
         );
         CREATE TABLE IF NOT EXISTS sync_runs (
             id          INTEGER PRIMARY KEY,
             target_id   INTEGER NOT NULL REFERENCES sync_targets(id) ON DELETE CASCADE,
             started_at  INTEGER NOT NULL,
             finished_at INTEGER NOT NULL,
             uploaded    INTEGER NOT NULL,
             skipped     INTEGER NOT NULL,
             failed      INTEGER NOT NULL,
             first_error TEXT
         );
         CREATE TABLE IF NOT EXISTS tags (
             id   INTEGER PRIMARY KEY,
             name TEXT NOT NULL UNIQUE COLLATE NOCASE
         );
         CREATE TABLE IF NOT EXISTS track_tags (
             track_id INTEGER NOT NULL REFERENCES tracks(id) ON DELETE CASCADE,
             tag_id   INTEGER NOT NULL REFERENCES tags(id) ON DELETE CASCADE,
             PRIMARY KEY (track_id, tag_id)
         );",
    )?;
    prepare_sharing(&conn)?;
    add_column(&conn, "tracks", "missing_since", "INTEGER")?;
    add_column(&conn, "tracks", "fingerprint", "TEXT")?;
    add_column(&conn, "tracks", "duration_ms", "INTEGER")?;
    add_column(&conn, "tracks", "bitrate", "INTEGER")?;
    add_column(&conn, "tracks", "sample_rate", "INTEGER")?;
    add_column(&conn, "tracks", "tag_bpm", "REAL")?;
    add_column(&conn, "tracks", "tag_key", "TEXT")?;
    add_column(&conn, "tracks", "fields", "TEXT")?;
    // Unix seconds the song first came into the library; NULL for songs from before this column
    // (they sort by id, which follows the order they were added).
    add_column(&conn, "tracks", "added_at", "INTEGER")?;
    // Fingerprint of the audio alone (see `audioprint`): the key of a song's analysis and cues.
    add_column(&conn, "tracks", "audio_fp", "TEXT")?;
    retire_fingerprint_keys(&conn)?;
    // What each side of a destination looked like at the last successful sync (see `Base`).
    add_column(&conn, "synced_files", "local_sig", "TEXT")?;
    add_column(&conn, "synced_files", "remote_sig", "TEXT")?;
    add_column(&conn, "synced_files", "base_tags", "TEXT")?;
    // Its exact check (see `Exact`): the whole file's hash and both sides' change markers.
    add_column(&conn, "synced_files", "base_content", "TEXT")?;
    add_column(&conn, "synced_files", "base_modified", "INTEGER")?;
    add_column(&conn, "synced_files", "base_version", "TEXT")?;
    conn.execute_batch(
        "CREATE INDEX IF NOT EXISTS tracks_fingerprint ON tracks(fingerprint);
         CREATE INDEX IF NOT EXISTS tracks_audio_fp ON tracks(audio_fp);
         CREATE TABLE IF NOT EXISTS import_cache (
             folder TEXT PRIMARY KEY,
             data   TEXT NOT NULL
         );
         CREATE TABLE IF NOT EXISTS itunes_imported (
             source      TEXT NOT NULL,
             size        INTEGER NOT NULL,
             dest        TEXT NOT NULL,
             imported_at INTEGER NOT NULL,
             PRIMARY KEY (source, size)
         );
         CREATE TABLE IF NOT EXISTS activity (
             id          INTEGER PRIMARY KEY,
             source      TEXT NOT NULL,
             started_at  INTEGER NOT NULL,
             finished_at INTEGER NOT NULL,
             ok          INTEGER NOT NULL,
             skipped     INTEGER NOT NULL,
             failed      INTEGER NOT NULL,
             items       TEXT NOT NULL DEFAULT '[]',
             errors      TEXT NOT NULL DEFAULT '[]'
         );
         CREATE TABLE IF NOT EXISTS remote_prints (
             target_id INTEGER NOT NULL,
             path TEXT NOT NULL,
             size INTEGER NOT NULL,
             fingerprint TEXT NOT NULL,
             PRIMARY KEY (target_id, path)
         );
         -- BPM and key detection results, by audio content: they follow a file through renames,
         -- moves, tag edits and library resets, and duplicates share them.
         CREATE TABLE IF NOT EXISTS analysis (
             audio_fp    TEXT PRIMARY KEY,
             bpm         REAL,
             musical_key TEXT,
             error       TEXT,
             version     INTEGER NOT NULL,
             analyzed_at INTEGER NOT NULL
         );
         -- Hot and memory cues set in manplay, by audio content like the analysis.
         CREATE TABLE IF NOT EXISTS cues (
             id          INTEGER PRIMARY KEY,
             audio_fp    TEXT NOT NULL,
             -- 0-7 for hot cues A-H, NULL for a memory cue.
             slot        INTEGER,
             start       REAL NOT NULL,
             name        TEXT NOT NULL DEFAULT '',
             -- #rrggbb, or '' for the player's default.
             color       TEXT NOT NULL DEFAULT '',
             -- The memory cue the song starts from (rekordbox's main cue on load).
             main        INTEGER NOT NULL DEFAULT 0
         );
         CREATE INDEX IF NOT EXISTS cues_audio_fp ON cues(audio_fp);
         -- Signatures of destination files (tags region and audio samples), valid while the file
         -- keeps the size and change marker (modified time or ETag) it had when read.
         CREATE TABLE IF NOT EXISTS remote_signatures (
             target_id INTEGER NOT NULL REFERENCES sync_targets(id) ON DELETE CASCADE,
             path      TEXT NOT NULL,
             size      INTEGER NOT NULL,
             version   TEXT NOT NULL,
             signature TEXT NOT NULL,
             PRIMARY KEY (target_id, path)
         );
         CREATE TABLE IF NOT EXISTS stale_remote (
             target_id INTEGER NOT NULL REFERENCES sync_targets(id) ON DELETE CASCADE,
             track_id  INTEGER NOT NULL REFERENCES tracks(id) ON DELETE CASCADE,
             rel       TEXT NOT NULL,
             PRIMARY KEY (target_id, track_id, rel)
         );",
    )?;
    add_column(&conn, "sync_runs", "deleted", "INTEGER NOT NULL DEFAULT 0")?;
    add_column(&conn, "sync_runs", "errors", "TEXT NOT NULL DEFAULT '[]'")?;
    add_column(&conn, "sync_runs", "batch", "INTEGER NOT NULL DEFAULT 0")?;
    add_analysis_columns(&conn, "analysis")?;
    add_column(&conn, "cues", "main", "INTEGER NOT NULL DEFAULT 0")?;
    if get_setting(&conn, SETTING_AUDIO_FP_VERSION)?.is_none() {
        set_setting(
            &conn,
            SETTING_AUDIO_FP_VERSION,
            Some(&crate::audioprint::VERSION.to_string()),
        )?;
    }
    prepare_tags(&conn)?;
    create_export_selections(&conn)?;
    prepare_smart_sharing(&conn)?;
    migrate_selection_uids(&conn)?;
    crate::libsync::seed::catch_up(&conn)?;
    crate::libsync::clashes::migrate(&conn)?;
    retry_unnamed_waveforms(&conn)?;
    create_jellyfin(&conn)?;
    Ok(conn)
}

// ---- Jellyfin ----------------------------------------------------------------------------------

/// The Jellyfin server that scans a destination. Its API key is in the keychain
/// (`jellyfin::save_key`), not here.
fn create_jellyfin(conn: &Connection) -> Result<(), Error> {
    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS jellyfin_servers (
             target_id    INTEGER PRIMARY KEY REFERENCES sync_targets(id) ON DELETE CASCADE,
             url          TEXT NOT NULL,
             server_name  TEXT NOT NULL,
             user_id      TEXT NOT NULL,
             user_name    TEXT NOT NULL,
             library_id   TEXT NOT NULL,
             library_name TEXT NOT NULL
         );
         -- The Jellyfin playlist each chosen manplay playlist was sent to, so later pushes
         -- update it (and renames find it) instead of making another.
         CREATE TABLE IF NOT EXISTS jellyfin_playlists (
             target_id   INTEGER NOT NULL REFERENCES sync_targets(id) ON DELETE CASCADE,
             key         TEXT NOT NULL,
             playlist_id TEXT NOT NULL,
             PRIMARY KEY (target_id, key)
         );",
    )?;
    // The last push: when (Unix seconds, UTC) and what it did, as JSON.
    add_column(conn, "jellyfin_servers", "last_push_at", "INTEGER")?;
    add_column(conn, "jellyfin_servers", "last_push", "TEXT")?;
    // Who sees the playlists manplay makes (`jellyfin::Visibility` as JSON).
    add_column(
        conn,
        "jellyfin_servers",
        "visibility",
        "TEXT NOT NULL DEFAULT '{\"kind\":\"onlyMe\"}'",
    )?;
    // What a playlist was made with; NULL for one taken over, whose sharing is left alone.
    add_column(conn, "jellyfin_playlists", "visibility", "TEXT")?;
    Ok(())
}

fn visibility_from(json: Option<String>) -> Option<crate::jellyfin::Visibility> {
    serde_json::from_str(&json?).ok()
}

fn visibility_json(visibility: &crate::jellyfin::Visibility) -> Result<String, Error> {
    serde_json::to_string(visibility).map_err(|e| Error::Msg(e.to_string()))
}

/// Which Jellyfin playlist each manplay playlist was sent to, for one destination.
pub fn jellyfin_known(
    conn: &Connection,
    target_id: i64,
) -> Result<
    std::collections::HashMap<crate::jellyfin::push::PlaylistKey, crate::jellyfin::push::Sent>,
    Error,
> {
    use crate::jellyfin::PlaylistId;
    use crate::jellyfin::push::{PlaylistKey, Sent};
    let mut stmt = conn.prepare(
        "SELECT key, playlist_id, visibility FROM jellyfin_playlists WHERE target_id = ?1",
    )?;
    let rows = stmt
        .query_map(params![target_id], |r| {
            Ok((
                PlaylistKey(r.get(0)?),
                Sent {
                    id: PlaylistId(r.get(1)?),
                    visibility: visibility_from(r.get(2)?),
                },
            ))
        })?
        .collect::<Result<_, _>>()?;
    Ok(rows)
}

/// Records where a playlist was sent. `visibility` is what it was made with; `None` keeps what
/// was recorded for the same playlist (filled again, its sharing is unchanged), and marks a
/// taken-over one, whose sharing manplay leaves alone.
pub fn set_jellyfin_known(
    conn: &Connection,
    target_id: i64,
    key: &crate::jellyfin::push::PlaylistKey,
    playlist: &crate::jellyfin::PlaylistId,
    visibility: Option<&crate::jellyfin::Visibility>,
) -> Result<(), Error> {
    let visibility = visibility.map(visibility_json).transpose()?;
    conn.execute(
        "INSERT INTO jellyfin_playlists (target_id, key, playlist_id, visibility)
         VALUES (?1, ?2, ?3, ?4)
         ON CONFLICT (target_id, key) DO UPDATE SET
             visibility = CASE WHEN excluded.playlist_id = playlist_id
                               THEN COALESCE(excluded.visibility, visibility)
                               ELSE excluded.visibility END,
             playlist_id = excluded.playlist_id",
        params![target_id, key.0, playlist.0, visibility],
    )?;
    Ok(())
}

pub fn forget_jellyfin_known(
    conn: &Connection,
    target_id: i64,
    key: &crate::jellyfin::push::PlaylistKey,
) -> Result<(), Error> {
    conn.execute(
        "DELETE FROM jellyfin_playlists WHERE target_id = ?1 AND key = ?2",
        params![target_id, key.0],
    )?;
    Ok(())
}

/// Saves what the last push did; `summary` is its JSON.
pub fn record_jellyfin_push(
    conn: &Connection,
    target_id: i64,
    at: i64,
    summary: &str,
) -> Result<(), Error> {
    conn.execute(
        "UPDATE jellyfin_servers SET last_push_at = ?2, last_push = ?3 WHERE target_id = ?1",
        params![target_id, at, summary],
    )?;
    Ok(())
}

/// When the last push ran and its JSON summary.
pub fn last_jellyfin_push(
    conn: &Connection,
    target_id: i64,
) -> Result<Option<(i64, String)>, Error> {
    Ok(conn
        .query_row(
            "SELECT last_push_at, last_push FROM jellyfin_servers
             WHERE target_id = ?1 AND last_push_at IS NOT NULL AND last_push IS NOT NULL",
            params![target_id],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .optional()?)
}

/// The stable id (`uid`) of a playlist or smart playlist row.
pub fn uid_of(conn: &Connection, table: &str, id: i64) -> Result<Option<String>, Error> {
    Ok(uids_for(conn, table, &[id])?.into_iter().next())
}

pub fn jellyfin_settings(
    conn: &Connection,
    target_id: i64,
) -> Result<Option<crate::jellyfin::Settings>, Error> {
    use crate::jellyfin::{LibraryId, LibraryRef, ServerUrl, Settings, User, UserId};
    Ok(conn
        .query_row(
            "SELECT url, server_name, user_id, user_name, library_id, library_name, visibility
             FROM jellyfin_servers WHERE target_id = ?1",
            params![target_id],
            |r| {
                Ok(Settings {
                    url: ServerUrl::from_stored(r.get(0)?),
                    server_name: r.get(1)?,
                    user: User {
                        id: UserId(r.get(2)?),
                        name: r.get(3)?,
                    },
                    library: LibraryRef {
                        id: LibraryId(r.get(4)?),
                        name: r.get(5)?,
                    },
                    visibility: visibility_from(r.get(6)?).unwrap_or_default(),
                })
            },
        )
        .optional()?)
}

pub fn save_jellyfin(
    conn: &Connection,
    target_id: i64,
    settings: &crate::jellyfin::Settings,
) -> Result<(), Error> {
    conn.execute(
        "INSERT INTO jellyfin_servers
             (target_id, url, server_name, user_id, user_name, library_id, library_name,
              visibility)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)
         ON CONFLICT (target_id) DO UPDATE SET
             url = excluded.url, server_name = excluded.server_name,
             user_id = excluded.user_id, user_name = excluded.user_name,
             library_id = excluded.library_id, library_name = excluded.library_name,
             visibility = excluded.visibility",
        params![
            target_id,
            settings.url.as_str(),
            settings.server_name,
            settings.user.id.0,
            settings.user.name,
            settings.library.id.0,
            settings.library.name,
            visibility_json(&settings.visibility)?,
        ],
    )?;
    Ok(())
}

/// Songs this device has synced to a destination: track id and local path.
pub fn synced_track_paths(conn: &Connection, target_id: i64) -> Result<Vec<(i64, String)>, Error> {
    let mut stmt = conn.prepare(
        "SELECT t.id, t.path FROM synced_files sf JOIN tracks t ON t.id = sf.track_id
         WHERE sf.target_id = ?1 AND t.missing_since IS NULL ORDER BY t.path",
    )?;
    let rows = stmt
        .query_map(params![target_id], |r| Ok((r.get(0)?, r.get(1)?)))?
        .collect::<Result<_, _>>()?;
    Ok(rows)
}

pub fn remove_jellyfin(conn: &Connection, target_id: i64) -> Result<(), Error> {
    conn.execute(
        "DELETE FROM jellyfin_servers WHERE target_id = ?1",
        params![target_id],
    )?;
    Ok(())
}

/// Waveforms of prints like `a1:<hex>` could not be named as files before, and were marked as on
/// the destination without being sent. Once, they are marked to be sent again.
fn retry_unnamed_waveforms(conn: &Connection) -> Result<(), Error> {
    const KEY: &str = "libsync_wf_names";
    if get_setting(conn, KEY)?.is_none() {
        conn.execute("UPDATE analysis SET wf_pushed = 0", [])?;
        set_setting(conn, KEY, Some("1"))?;
    }
    Ok(())
}

/// Columns and tables for sharing library data (see `libsync`): a uid per shareable item, its
/// scope and whether it is hidden here, the position keys of playlists, and the op log.
fn prepare_sharing(conn: &Connection) -> Result<(), Error> {
    for table in ["tags", "playlists"] {
        add_sharing_columns(conn, table)?;
    }
    // Fractional index of a song in a playlist; `position` is its rank, kept for queries.
    add_column(conn, "playlist_tracks", "pos", "TEXT")?;
    // Whether this destination receives and sends library data (off until switched on).
    add_column(
        conn,
        "sync_targets",
        "libsync",
        "INTEGER NOT NULL DEFAULT 0",
    )?;
    crate::libsync::schema::create(conn)?;
    // The chunk an op was uploaded in, so ops a snapshot covers can be pruned.
    add_column(conn, "oplog", "seq", "INTEGER")?;
    backfill_positions(conn)
}

fn prepare_smart_sharing(conn: &Connection) -> Result<(), Error> {
    add_sharing_columns(conn, "smart_playlists")?;
    convert_smart_rules(conn)
}

fn add_sharing_columns(conn: &Connection, table: &str) -> Result<(), Error> {
    add_column(conn, table, "uid", "TEXT")?;
    add_column(conn, table, "scope", "TEXT NOT NULL DEFAULT 'shared'")?;
    add_column(conn, table, "hidden", "INTEGER NOT NULL DEFAULT 0")?;
    let ids: Vec<i64> = conn
        .prepare(&format!("SELECT id FROM {table} WHERE uid IS NULL"))?
        .query_map([], |r| r.get(0))?
        .collect::<Result<_, _>>()?;
    for id in ids {
        conn.execute(
            &format!("UPDATE {table} SET uid = ?1 WHERE id = ?2"),
            params![crate::libsync::new_uid(), id],
        )?;
    }
    conn.execute_batch(&format!(
        "CREATE UNIQUE INDEX IF NOT EXISTS {table}_uid ON {table}(uid)"
    ))?;
    Ok(())
}

/// Gives songs in playlists from before position keys one, in their current order.
fn backfill_positions(conn: &Connection) -> Result<(), Error> {
    let lists: Vec<i64> = conn
        .prepare("SELECT DISTINCT playlist_id FROM playlist_tracks WHERE pos IS NULL")?
        .query_map([], |r| r.get(0))?
        .collect::<Result<_, _>>()?;
    for list in lists {
        let tracks: Vec<i64> = conn
            .prepare("SELECT track_id FROM playlist_tracks WHERE playlist_id = ?1 ORDER BY position, track_id")?
            .query_map(params![list], |r| r.get(0))?
            .collect::<Result<_, _>>()?;
        let keys = crate::libsync::frac::spread(None, None, tracks.len());
        for (track, key) in tracks.iter().zip(keys) {
            conn.execute(
                "UPDATE playlist_tracks SET pos = ?1 WHERE playlist_id = ?2 AND track_id = ?3",
                params![key, list, track],
            )?;
        }
    }
    Ok(())
}

/// Setting that records which version of `audioprint` made the stored `audio_fp` values. A new
/// algorithm needs a remap of `tracks.audio_fp`, `analysis` and `cues` before it is used.
pub const SETTING_AUDIO_FP_VERSION: &str = "audio_fp_version";

/// The columns of `analysis` added after its first version (also for `analysis_legacy`, so the
/// old table is complete before it is re-keyed).
fn add_analysis_columns(conn: &Connection, table: &str) -> Result<(), Error> {
    // Values set by hand, which a new analysis keeps unless told to replace them.
    for column in ["bpm_edited", "key_edited", "grid_edited"] {
        add_column(conn, table, column, "INTEGER NOT NULL DEFAULT 0")?;
    }
    // The beat grid (seconds to the first beat, its place in the bar) and the detail waveform
    // (`analysis::WAVEFORM_RATE` columns per second, each whiteness << 5 | height) that the
    // library shows and USB drives and rekordbox get. A NULL waveform: not analysed that far.
    for (column, decl) in [
        ("grid_bpm", "REAL"),
        ("first_beat", "REAL"),
        ("bar_offset", "INTEGER"),
        ("duration", "REAL"),
        ("waveform", "BLOB"),
    ] {
        add_column(conn, table, column, decl)?;
    }
    // Cues were set in manplay (possibly to none): they replace a drive's own on export.
    add_column(conn, table, "cues_edited", "INTEGER NOT NULL DEFAULT 0")?;
    // Whether the waveform is known to be on the sharing destination (see `libsync::waveforms`).
    add_column(conn, table, "wf_pushed", "INTEGER NOT NULL DEFAULT 0")?;
    Ok(())
}

/// Older databases keyed `analysis` and `cues` by `tracks.fingerprint` (the whole file, which
/// every tag edit changes). Those tables are set aside as `analysis_legacy` and `cues_legacy`;
/// [`rekey_legacy`] copies what maps to a track's `audio_fp` into the new ones.
fn retire_fingerprint_keys(conn: &Connection) -> Result<(), Error> {
    if has_column(conn, "analysis", "fingerprint")? {
        add_analysis_columns(conn, "analysis")?;
        conn.execute_batch(
            "DROP TABLE IF EXISTS analysis_legacy;
             ALTER TABLE analysis RENAME TO analysis_legacy;",
        )?;
    }
    if has_column(conn, "cues", "fingerprint")? {
        add_column(conn, "cues", "main", "INTEGER NOT NULL DEFAULT 0")?;
        conn.execute_batch(
            "DROP INDEX IF EXISTS cues_fingerprint;
             DROP TABLE IF EXISTS cues_legacy;
             ALTER TABLE cues RENAME TO cues_legacy;",
        )?;
    }
    Ok(())
}

fn table_exists(conn: &Connection, name: &str) -> Result<bool, Error> {
    Ok(conn
        .query_row(
            "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?1",
            params![name],
            |_| Ok(()),
        )
        .optional()?
        .is_some())
}

/// Finishes the move of `analysis` and `cues` to `audio_fp` keys: every old row whose track now
/// has an audio fingerprint is copied under it (hand edits, grids, waveforms and cues included).
/// Once every present track has been fingerprinted the old tables are dropped, and rows that map
/// to no track go with them. Does nothing on a database without them.
pub fn rekey_legacy(conn: &mut Connection) -> Result<(), Error> {
    let has_analysis = table_exists(conn, "analysis_legacy")?;
    let has_cues = table_exists(conn, "cues_legacy")?;
    if !has_analysis && !has_cues {
        return Ok(());
    }
    let tx = conn.transaction()?;
    if has_analysis {
        // Present tracks first, then the newest analysis, win when duplicates disagree.
        tx.execute(
            "INSERT OR IGNORE INTO analysis
                 (audio_fp, bpm, musical_key, error, version, analyzed_at, bpm_edited, key_edited,
                  grid_edited, cues_edited, grid_bpm, first_beat, bar_offset, duration, waveform)
             SELECT t.audio_fp, a.bpm, a.musical_key, a.error, a.version, a.analyzed_at,
                    a.bpm_edited, a.key_edited, a.grid_edited, a.cues_edited,
                    a.grid_bpm, a.first_beat, a.bar_offset, a.duration, a.waveform
             FROM analysis_legacy a JOIN tracks t ON t.fingerprint = a.fingerprint
             WHERE t.audio_fp IS NOT NULL AND t.audio_fp <> ''
             ORDER BY t.missing_since IS NOT NULL, a.analyzed_at DESC",
            [],
        )?;
    }
    if has_cues {
        // One legacy fingerprint's cues per audio, and never over cues set since.
        tx.execute(
            "INSERT INTO cues (audio_fp, slot, start, name, color, main)
             SELECT p.audio_fp, c.slot, c.start, c.name, c.color, c.main
             FROM (SELECT t.audio_fp AS audio_fp, MIN(t.fingerprint) AS fingerprint
                   FROM tracks t
                   WHERE t.audio_fp IS NOT NULL AND t.audio_fp <> ''
                     AND t.fingerprint IN (SELECT fingerprint FROM cues_legacy)
                   GROUP BY t.audio_fp) p
             JOIN cues_legacy c ON c.fingerprint = p.fingerprint
             WHERE NOT EXISTS (SELECT 1 FROM cues n WHERE n.audio_fp = p.audio_fp)",
            [],
        )?;
    }
    let pending: i64 = tx.query_row(
        "SELECT COUNT(*) FROM tracks WHERE missing_since IS NULL AND audio_fp IS NULL",
        [],
        |r| r.get(0),
    )?;
    if pending == 0 {
        tx.execute_batch(
            "DROP TABLE IF EXISTS analysis_legacy; DROP TABLE IF EXISTS cues_legacy;",
        )?;
    }
    tx.commit()?;
    // Analysis that came back from the old tables after sharing started was never sent.
    crate::libsync::seed::send_missing_analysis(conn)?;
    Ok(())
}

fn has_column(conn: &Connection, table: &str, column: &str) -> Result<bool, Error> {
    Ok(conn
        .prepare(&format!("PRAGMA table_info({table})"))?
        .query_map([], |r| r.get::<_, String>(1))?
        .filter_map(Result::ok)
        .any(|name| name == column))
}

pub(crate) fn add_column(
    conn: &Connection,
    table: &str,
    column: &str,
    decl: &str,
) -> Result<(), Error> {
    if !has_column(conn, table, column)? {
        conn.execute(
            &format!("ALTER TABLE {table} ADD COLUMN {column} {decl}"),
            [],
        )?;
    }
    Ok(())
}

pub fn upsert(conn: &mut Connection, tracks: &[NewTrack]) -> Result<(), Error> {
    let tx = conn.transaction()?;
    {
        let mut stmt = tx.prepare(
            "INSERT INTO tracks (path, artist, album, title, size, fingerprint,
                                 duration_ms, bitrate, sample_rate, tag_bpm, tag_key, fields,
                                 audio_fp, added_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13,
                     CAST(strftime('%s', 'now') AS INTEGER))
             ON CONFLICT(path) DO UPDATE SET
                 artist = excluded.artist,
                 album = excluded.album,
                 title = excluded.title,
                 size = excluded.size,
                 fingerprint = COALESCE(excluded.fingerprint, fingerprint),
                 duration_ms = COALESCE(excluded.duration_ms, duration_ms),
                 bitrate = COALESCE(excluded.bitrate, bitrate),
                 sample_rate = COALESCE(excluded.sample_rate, sample_rate),
                 tag_bpm = excluded.tag_bpm,
                 tag_key = excluded.tag_key,
                 fields = COALESCE(excluded.fields, fields),
                 audio_fp = CASE WHEN excluded.audio_fp <> '' THEN excluded.audio_fp
                     ELSE COALESCE(audio_fp, excluded.audio_fp) END,
                 missing_since = NULL",
        )?;
        for t in tracks {
            note_audio_change(&tx, &t.path, t.audio_fp.as_deref())?;
            stmt.execute(params![
                t.path,
                t.artist,
                t.album,
                t.title,
                t.size,
                t.fingerprint,
                t.duration_ms,
                t.bitrate,
                t.sample_rate,
                t.tag_bpm,
                t.tag_key,
                t.fields,
                t.audio_fp
            ])?;
        }
    }
    tx.commit()?;
    Ok(())
}

/// A file whose audio changed in place (re-encoded over the same path) keeps its row, so its
/// tags and playlists stay; this remembers the audio it had, so other devices' edits about the
/// old audio can be carried over to the new one (`libsync::carry`).
fn note_audio_change(conn: &Connection, path: &str, new_fp: Option<&str>) -> Result<(), Error> {
    let Some(new_fp) = new_fp.filter(|fp| !fp.is_empty()) else {
        return Ok(());
    };
    let old: Option<(i64, Option<String>)> = conn
        .query_row(
            "SELECT id, audio_fp FROM tracks WHERE path = ?1",
            params![path],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .optional()?;
    let Some((id, Some(old_fp))) = old else {
        return Ok(());
    };
    if old_fp.is_empty() || old_fp == new_fp {
        return Ok(());
    }
    // Several changes in a row still start from the first audio; a change back clears it.
    let first: Option<String> = conn
        .query_row(
            "SELECT old_fp FROM audio_changes WHERE track_id = ?1",
            params![id],
            |r| r.get(0),
        )
        .optional()?;
    let first = first.unwrap_or(old_fp);
    if first == new_fp {
        conn.execute("DELETE FROM audio_changes WHERE track_id = ?1", params![id])?;
    } else {
        conn.execute(
            "INSERT INTO audio_changes (track_id, old_fp, new_fp) VALUES (?1, ?2, ?3)
             ON CONFLICT(track_id) DO UPDATE SET new_fp = excluded.new_fp",
            params![id, first, new_fp],
        )?;
    }
    Ok(())
}

const TRACK_COLS: &str = "t.id, t.path, t.artist, t.album, t.title, t.size,
    (SELECT group_concat(g.name, char(31)) FROM track_tags tt
     JOIN tags g ON g.id = tt.tag_id WHERE tt.track_id = t.id),
    (SELECT COUNT(*) FROM synced_files sf WHERE sf.track_id = t.id AND sf.size = t.size),
    t.duration_ms, t.bitrate, t.sample_rate,
    COALESCE(a.bpm, t.tag_bpm), COALESCE(a.musical_key, t.tag_key), (COALESCE(a.version, 0) >= 2
        AND (a.waveform IS NOT NULL OR a.error IS NOT NULL)),
    t.fields, COALESCE(a.bpm_edited, 0), COALESCE(a.key_edited, 0), COALESCE(a.grid_edited, 0),
    t.added_at";

/// Joined wherever [`TRACK_COLS`] is selected.
const ANALYSIS_JOIN: &str = "LEFT JOIN analysis a ON a.audio_fp = t.audio_fp";

fn track_from_row(r: &rusqlite::Row<'_>) -> rusqlite::Result<Track> {
    let tags: Option<String> = r.get(6)?;
    Ok(Track {
        id: r.get(0)?,
        path: r.get(1)?,
        artist: r.get(2)?,
        album: r.get(3)?,
        title: r.get(4)?,
        size: r.get(5)?,
        tags: tags
            .map(|s| s.split('\u{1f}').map(str::to_owned).collect())
            .unwrap_or_default(),
        synced_count: r.get(7)?,
        duration_ms: r.get(8)?,
        bitrate: r.get(9)?,
        sample_rate: r.get(10)?,
        bpm: r.get(11)?,
        key: r.get(12)?,
        analyzed: r.get(13)?,
        fields: r
            .get::<_, Option<String>>(14)?
            .and_then(|raw| serde_json::from_str(&raw).ok())
            .unwrap_or_default(),
        edited: Edited {
            bpm: r.get(15)?,
            key: r.get(16)?,
            grid: r.get(17)?,
        },
        added_at: r.get(18)?,
    })
}

/// Which of a song's analysis values were set by hand.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize)]
pub struct Edited {
    pub bpm: bool,
    pub key: bool,
    pub grid: bool,
}

/// Replaces the remembered tag values (artists, genres, ...) with what the last scan saw.
pub fn replace_tag_values(
    conn: &mut Connection,
    values: &std::collections::HashMap<(&'static str, String), i64>,
) -> Result<(), Error> {
    let tx = conn.transaction()?;
    tx.execute("DELETE FROM tag_values", [])?;
    {
        let mut stmt =
            tx.prepare("INSERT INTO tag_values (field, value, count) VALUES (?1, ?2, ?3)")?;
        for ((field, value), count) in values {
            stmt.execute(params![field, value, count])?;
        }
    }
    tx.commit()?;
    Ok(())
}

#[derive(serde::Serialize)]
pub struct TagValue {
    pub value: String,
    pub count: i64,
}

/// Known values of one field, most used first. Values made by hand come last with a count of 0.
pub fn tag_values(conn: &Connection, field: &str) -> Result<Vec<TagValue>, Error> {
    let mut stmt = conn.prepare(
        "SELECT value, count FROM (
             SELECT value, count FROM tag_values WHERE field = ?1
             UNION ALL
             SELECT value, 0 FROM tag_custom WHERE field = ?1
               AND value NOT IN (SELECT value FROM tag_values WHERE field = ?1 COLLATE NOCASE)
         ) ORDER BY count DESC, value COLLATE NOCASE",
    )?;
    let rows = stmt.query_map(params![field], |r| {
        Ok(TagValue {
            value: r.get(0)?,
            count: r.get(1)?,
        })
    })?;
    Ok(rows.collect::<Result<Vec<_>, _>>()?)
}

/// Adds a value by hand so it shows up in pick lists before any song uses it.
pub fn create_tag_value(conn: &Connection, field: &str, value: &str) -> Result<(), Error> {
    let added = conn.execute(
        "INSERT OR IGNORE INTO tag_custom (field, value) VALUES (?1, ?2)",
        params![field, value],
    )?;
    if added > 0 {
        let mut ops = crate::libsync::Batch::new(conn)?;
        ops.custom_value(field, value, true);
        ops.commit(conn)?;
    }
    Ok(())
}

/// Keeps hand-made values in step with a migration: the old ones go, and the new one takes
/// their place when one of them was hand-made.
pub fn migrate_custom_values(
    conn: &Connection,
    field: &str,
    from: &[String],
    to: Option<&str>,
) -> Result<(), Error> {
    let mut had = false;
    let mut ops = crate::libsync::Batch::new(conn)?;
    for name in from {
        let gone = conn.execute(
            "DELETE FROM tag_custom WHERE field = ?1 AND value = ?2",
            params![field, name],
        )? > 0;
        if gone {
            ops.custom_value(field, name, false);
        }
        had |= gone;
    }
    ops.commit(conn)?;
    if let (true, Some(to)) = (had, to) {
        create_tag_value(conn, field, to)?;
    }
    Ok(())
}

/// Deletes every track; cascades to playlist/tag memberships and sync records.
pub fn clear_tracks(conn: &Connection) -> Result<(), Error> {
    conn.execute("DELETE FROM tracks", [])?;
    Ok(())
}

pub fn list(conn: &Connection) -> Result<Vec<Track>, Error> {
    let mut stmt = conn.prepare(&format!(
        "SELECT {TRACK_COLS} FROM tracks t {ANALYSIS_JOIN} WHERE t.missing_since IS NULL
         ORDER BY t.artist, t.album, t.path"
    ))?;
    let rows = stmt.query_map([], track_from_row)?;
    Ok(rows.collect::<Result<Vec<_>, _>>()?)
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Playlist {
    pub id: i64,
    pub name: String,
    pub track_count: i64,
    /// `shared` (everyone on the destination has it) or `local` (this device only).
    pub scope: String,
    /// Hidden on this device only.
    pub hidden: bool,
    /// Shown under a held name because another playlist has the name (see Clashes).
    pub held: bool,
}

/// Extra condition for queries over `playlist_tracks pt JOIN tracks t`: a song whose audio
/// appears more than once in a playlist (copies share one `audio_fp`) is listed once, at its
/// first place.
const ONE_PER_AUDIO: &str = "AND NOT EXISTS (
        SELECT 1 FROM playlist_tracks p2 JOIN tracks t2 ON t2.id = p2.track_id
        WHERE p2.playlist_id = pt.playlist_id AND p2.position < pt.position
          AND t2.missing_since IS NULL AND t2.audio_fp <> '' AND t2.audio_fp = t.audio_fp)";

pub fn list_playlists(conn: &Connection) -> Result<Vec<Playlist>, Error> {
    let mut stmt = conn.prepare(
        "SELECT p.id, p.name, COUNT(t.id), p.scope, p.hidden,
                EXISTS (SELECT 1 FROM clashes c WHERE c.kind = 'playlist' AND c.held = p.uid)
         FROM playlists p LEFT JOIN playlist_tracks pt ON pt.playlist_id = p.id
         LEFT JOIN tracks t ON t.id = pt.track_id AND t.missing_since IS NULL
             AND NOT EXISTS (
                SELECT 1 FROM playlist_tracks p2 JOIN tracks t2 ON t2.id = p2.track_id
                WHERE p2.playlist_id = pt.playlist_id AND p2.position < pt.position
                  AND t2.missing_since IS NULL AND t2.audio_fp <> '' AND t2.audio_fp = t.audio_fp)
         GROUP BY p.id ORDER BY p.name COLLATE NOCASE",
    )?;
    let rows = stmt.query_map([], |r| {
        Ok(Playlist {
            id: r.get(0)?,
            name: r.get(1)?,
            track_count: r.get(2)?,
            scope: r.get(3)?,
            hidden: r.get(4)?,
            held: r.get(5)?,
        })
    })?;
    Ok(rows.collect::<Result<Vec<_>, _>>()?)
}

/// `(uid, scope)` of a playlist.
fn playlist_ident(conn: &Connection, id: i64) -> Result<(String, String), Error> {
    conn.query_row(
        "SELECT COALESCE(uid, ''), scope FROM playlists WHERE id = ?1",
        params![id],
        |r| Ok((r.get(0)?, r.get(1)?)),
    )
    .map_err(|e| match e {
        rusqlite::Error::QueryReturnedNoRows => {
            Error::Msg("That playlist no longer exists.".into())
        }
        e => e.into(),
    })
}

/// A new empty playlist. `scope` is `shared` or `local`; `None` takes the library default.
pub fn create_playlist(conn: &Connection, name: &str, scope: Option<&str>) -> Result<i64, Error> {
    let tx = conn.unchecked_transaction()?;
    let uid = crate::libsync::new_uid();
    let scope = match scope {
        Some(s) => crate::libsync::scope_of(s)?,
        None => crate::libsync::default_scope(&tx)?,
    };
    tx.execute(
        "INSERT INTO playlists (name, uid, scope) VALUES (?1, ?2, ?3)",
        params![name, uid, scope],
    )?;
    let id = tx.last_insert_rowid();
    let mut ops = crate::libsync::Batch::new(&tx)?;
    if scope == "shared" {
        ops.playlist(&uid, name);
    }
    ops.commit(&tx)?;
    tx.commit()?;
    Ok(id)
}

pub fn rename_playlist(conn: &Connection, id: i64, name: &str) -> Result<(), Error> {
    let tx = conn.unchecked_transaction()?;
    let changed = tx.execute(
        "UPDATE playlists SET name = ?2 WHERE id = ?1",
        params![id, name],
    )?;
    if changed > 0 {
        let (uid, scope) = playlist_ident(&tx, id)?;
        let mut ops = crate::libsync::Batch::new(&tx)?;
        if scope == "shared" {
            ops.playlist(&uid, name);
        }
        ops.commit(&tx)?;
    }
    crate::libsync::clashes::refresh(&tx)?;
    tx.commit()?;
    Ok(())
}

pub fn delete_playlist(conn: &Connection, id: i64) -> Result<(), Error> {
    let tx = conn.unchecked_transaction()?;
    let ident = playlist_ident(&tx, id).ok();
    tx.execute("DELETE FROM playlists WHERE id = ?1", params![id])?;
    if let Some((uid, scope)) = ident {
        let mut ops = crate::libsync::Batch::new(&tx)?;
        if scope == "shared" {
            ops.playlist_deleted(&uid);
        }
        ops.commit(&tx)?;
    }
    crate::libsync::clashes::refresh(&tx)?;
    tx.commit()?;
    Ok(())
}

/// Appends tracks to the end; tracks already in the playlist are skipped. A song whose audio is
/// already in the playlist (another copy) joins at the same place and sends nothing new.
pub fn add_to_playlist(
    conn: &mut Connection,
    playlist_id: i64,
    track_ids: &[i64],
) -> Result<(), Error> {
    let tx = conn.transaction()?;
    let (uid, scope) = playlist_ident(&tx, playlist_id)?;
    let last: Option<String> = tx
        .query_row(
            "SELECT pos FROM playlist_tracks WHERE playlist_id = ?1 AND pos IS NOT NULL
             ORDER BY pos DESC LIMIT 1",
            params![playlist_id],
            |r| r.get(0),
        )
        .optional()?;
    // One place per audio: `(audio_fp, key already in the playlist)`.
    let mut places: Vec<(String, Option<String>)> = Vec::new();
    let mut adds: Vec<(i64, usize)> = Vec::new();
    for &id in track_ids {
        let member: bool = tx.query_row(
            "SELECT EXISTS (SELECT 1 FROM playlist_tracks WHERE playlist_id = ?1 AND track_id = ?2)",
            params![playlist_id, id],
            |r| r.get(0),
        )?;
        if member {
            continue;
        }
        let fp = audio_fp_of(&tx, id)?.unwrap_or_default();
        let known = (!fp.is_empty())
            .then(|| places.iter().position(|(f, _)| *f == fp))
            .flatten();
        let place = if let Some(place) = known {
            place
        } else {
            let existing: Option<String> = if fp.is_empty() {
                None
            } else {
                tx.query_row(
                    "SELECT pt.pos FROM playlist_tracks pt JOIN tracks t ON t.id = pt.track_id
                     WHERE pt.playlist_id = ?1 AND t.audio_fp = ?2 AND pt.pos IS NOT NULL LIMIT 1",
                    params![playlist_id, fp],
                    |r| r.get(0),
                )
                .optional()?
            };
            places.push((fp, existing));
            places.len() - 1
        };
        adds.push((id, place));
    }
    let fresh: Vec<usize> = (0..places.len())
        .filter(|&i| places[i].1.is_none())
        .collect();
    let keys = crate::libsync::frac::spread(last.as_deref(), None, fresh.len());
    let mut ops = crate::libsync::Batch::new(&tx)?;
    for (&place, key) in fresh.iter().zip(keys) {
        if scope == "shared" {
            ops.playlist_add(&uid, &places[place].0, &key);
        }
        places[place].1 = Some(key);
    }
    for (id, place) in adds {
        tx.execute(
            "INSERT OR IGNORE INTO playlist_tracks (playlist_id, track_id, position, pos)
             VALUES (?1, ?2, (SELECT COALESCE(MAX(position), -1) + 1
                              FROM playlist_tracks WHERE playlist_id = ?1), ?3)",
            params![playlist_id, id, places[place].1],
        )?;
    }
    ops.commit(&tx)?;
    tx.commit()?;
    Ok(())
}

/// Takes a song out of a playlist, with every other copy of the same audio (a playlist holds
/// each audio once).
pub fn remove_from_playlist(
    conn: &Connection,
    playlist_id: i64,
    track_id: i64,
) -> Result<(), Error> {
    let tx = conn.unchecked_transaction()?;
    let fp = audio_fp_of(&tx, track_id)?.unwrap_or_default();
    let removed = tx.execute(
        "DELETE FROM playlist_tracks WHERE playlist_id = ?1
         AND (track_id = ?2 OR (?3 <> '' AND track_id IN (SELECT id FROM tracks WHERE audio_fp = ?3)))",
        params![playlist_id, track_id, fp],
    )?;
    if removed > 0
        && !fp.is_empty()
        && let Ok((uid, scope)) = playlist_ident(&tx, playlist_id)
        && scope == "shared"
    {
        let mut ops = crate::libsync::Batch::new(&tx)?;
        ops.playlist_remove(&uid, &fp);
        ops.commit(&tx)?;
    }
    tx.commit()?;
    Ok(())
}

pub fn playlist_tracks(conn: &Connection, playlist_id: i64) -> Result<Vec<Track>, Error> {
    let mut stmt = conn.prepare(&format!(
        "SELECT {TRACK_COLS} FROM playlist_tracks pt JOIN tracks t ON t.id = pt.track_id
         {ANALYSIS_JOIN} WHERE pt.playlist_id = ?1 AND t.missing_since IS NULL {ONE_PER_AUDIO}
         ORDER BY pt.position"
    ))?;
    let rows = stmt.query_map(params![playlist_id], track_from_row)?;
    Ok(rows.collect::<Result<Vec<_>, _>>()?)
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Tag {
    pub id: i64,
    /// Full path, levels separated by `/` (e.g. `Genre/Electronic/House`).
    pub name: String,
    /// Songs tagged with this tag or any tag below it.
    pub track_count: i64,
    /// `shared` (everyone on the destination has it) or `local` (this device only).
    pub scope: String,
    /// Hidden on this device only.
    pub hidden: bool,
    /// Shown under a held name because another tag has the name (see Clashes).
    pub held: bool,
}

/// Tidies a tag path: trims each level and drops empty ones (`" a / /b "` becomes `a/b`).
pub fn normalize_tag(name: &str) -> String {
    name.split('/')
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .collect::<Vec<_>>()
        .join("/")
}

/// `a/b/c` → `["a", "a/b", "a/b/c"]`.
fn tag_ancestry(name: &str) -> Vec<String> {
    let parts: Vec<&str> = name.split('/').collect();
    (1..=parts.len()).map(|n| parts[..n].join("/")).collect()
}

/// Adds one tag row if there is none by that name, with a uid, and says so in `ops`. `scope` is
/// `shared` or `local`; `None` takes the library default.
fn insert_tag(
    conn: &Connection,
    name: &str,
    scope: Option<&str>,
    ops: &mut crate::libsync::Batch,
) -> Result<(), Error> {
    let uid = crate::libsync::new_uid();
    let scope = match scope {
        Some(s) => crate::libsync::scope_of(s)?,
        None => crate::libsync::default_scope(conn)?,
    };
    let added = conn.execute(
        "INSERT OR IGNORE INTO tags (name, uid, scope) VALUES (?1, ?2, ?3)",
        params![name, uid, scope],
    )?;
    if added > 0 && scope == "shared" {
        ops.tag(&uid, name);
    }
    Ok(())
}

/// Creates the tag and every parent level it names; returns the tag's id.
fn ensure_tag(tx: &Connection, name: &str, ops: &mut crate::libsync::Batch) -> Result<i64, Error> {
    ensure_tag_as(tx, name, None, ops)
}

/// [`ensure_tag`], with the scope for levels that do not exist yet. Below a local level every new
/// level is local too: a shared tag under a parent other devices never get would arrive there
/// without its parent.
fn ensure_tag_as(
    tx: &Connection,
    name: &str,
    scope: Option<&str>,
    ops: &mut crate::libsync::Batch,
) -> Result<i64, Error> {
    let mut under_local = false;
    for level in tag_ancestry(name) {
        let existing: Option<String> = tx
            .query_row(
                "SELECT scope FROM tags WHERE name = ?1",
                params![level],
                |r| r.get(0),
            )
            .optional()?;
        match existing {
            Some(s) => under_local |= s == "local",
            None => insert_tag(tx, &level, under_local.then_some("local").or(scope), ops)?,
        }
    }
    Ok(
        tx.query_row("SELECT id FROM tags WHERE name = ?1", params![name], |r| {
            r.get(0)
        })?,
    )
}

/// Recreates any missing parent level (e.g. after `a` moved into `a/b`). A recreated level is
/// local: a parent that is missing here was deleted or made private elsewhere, and sending it
/// again would bring it back for everyone under a new uid.
fn restore_tag_parents(conn: &Connection, ops: &mut crate::libsync::Batch) -> Result<(), Error> {
    let names: Vec<String> = conn
        .prepare("SELECT name FROM tags WHERE instr(name, '/') > 0")?
        .query_map([], |r| r.get(0))?
        .collect::<Result<_, _>>()?;
    for name in names {
        for level in tag_ancestry(&name) {
            insert_tag(conn, &level, Some("local"), ops)?;
        }
    }
    Ok(())
}

/// Condition matching tag `c` being `g` itself or anywhere below it.
const IN_SUBTREE: &str =
    "(c.id = g.id OR lower(substr(c.name, 1, length(g.name) + 1)) = lower(g.name || '/'))";

pub fn list_tags(conn: &Connection) -> Result<Vec<Tag>, Error> {
    let mut stmt = conn.prepare(&format!(
        "SELECT g.id, g.name, COUNT(DISTINCT t.id), g.scope, g.hidden,
                EXISTS (SELECT 1 FROM clashes k WHERE k.kind = 'tag' AND k.held = g.uid)
         FROM tags g
         JOIN tags c ON {IN_SUBTREE}
         LEFT JOIN track_tags tt ON tt.tag_id = c.id
         LEFT JOIN tracks t ON t.id = tt.track_id AND t.missing_since IS NULL
         GROUP BY g.id ORDER BY g.name COLLATE NOCASE"
    ))?;
    let rows = stmt.query_map([], |r| {
        Ok(Tag {
            id: r.get(0)?,
            name: r.get(1)?,
            track_count: r.get(2)?,
            scope: r.get(3)?,
            hidden: r.get(4)?,
            held: r.get(5)?,
        })
    })?;
    Ok(rows.collect::<Result<Vec<_>, _>>()?)
}

/// `(id, uid, scope)` of the tag with this name.
fn tag_by_name(conn: &Connection, name: &str) -> Result<Option<(i64, String, String)>, Error> {
    Ok(conn
        .query_row(
            "SELECT id, COALESCE(uid, ''), scope FROM tags WHERE name = ?1",
            params![name],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
        )
        .optional()?)
}

/// A new empty tag (and any parent level it names that is missing), shared or local (`None`: the
/// library default). An existing tag keeps its scope.
pub fn create_tag(conn: &mut Connection, name: &str, scope: Option<&str>) -> Result<(), Error> {
    let name = normalize_tag(name);
    if name.is_empty() {
        return Ok(());
    }
    let tx = conn.transaction()?;
    let mut ops = crate::libsync::Batch::new(&tx)?;
    ensure_tag_as(&tx, &name, scope, &mut ops)?;
    ops.commit(&tx)?;
    tx.commit()?;
    Ok(())
}

/// Creates the tag (and its parent levels) if needed and attaches it to every given track.
pub fn tag_tracks(conn: &mut Connection, name: &str, track_ids: &[i64]) -> Result<(), Error> {
    let name = normalize_tag(name);
    if name.is_empty() {
        return Ok(());
    }
    let tx = conn.transaction()?;
    let mut ops = crate::libsync::Batch::new(&tx)?;
    let tag_id = ensure_tag(&tx, &name, &mut ops)?;
    let (uid, scope): (String, String) = tx.query_row(
        "SELECT COALESCE(uid, ''), scope FROM tags WHERE id = ?1",
        params![tag_id],
        |r| Ok((r.get(0)?, r.get(1)?)),
    )?;
    for &id in track_ids {
        let added = tx.execute(
            "INSERT OR IGNORE INTO track_tags (track_id, tag_id) VALUES (?1, ?2)",
            params![id, tag_id],
        )?;
        if added > 0 && scope == "shared" && ops.is_on() {
            ops.track_tag(&uid, &audio_fp_of(&tx, id)?.unwrap_or_default(), true);
        }
    }
    ops.commit(&tx)?;
    tx.commit()?;
    Ok(())
}

pub fn untag_track(conn: &Connection, name: &str, track_id: i64) -> Result<(), Error> {
    let tx = conn.unchecked_transaction()?;
    if let Some((tag_id, uid, scope)) = tag_by_name(&tx, &normalize_tag(name))? {
        let removed = tx.execute(
            "DELETE FROM track_tags WHERE track_id = ?1 AND tag_id = ?2",
            params![track_id, tag_id],
        )?;
        if removed > 0 && scope == "shared" {
            let mut ops = crate::libsync::Batch::new(&tx)?;
            ops.track_tag(
                &uid,
                &audio_fp_of(&tx, track_id)?.unwrap_or_default(),
                false,
            );
            ops.commit(&tx)?;
        }
    }
    tx.commit()?;
    Ok(())
}

/// The `audio_fp` of every song tagged with the tag, including ones this library has not got yet
/// (their ops wait in the register store).
fn tag_members(tx: &Connection, tag_id: i64, uid: &str) -> Result<Vec<String>, Error> {
    let mut stmt = tx.prepare(
        "SELECT t.audio_fp FROM track_tags tt JOIN tracks t ON t.id = tt.track_id
         WHERE tt.tag_id = ?1 AND t.audio_fp <> ''
         UNION
         SELECT ref FROM op_state WHERE e = 'track_tag' AND f = 'present' AND val = 'true'
           AND ref IS NOT NULL AND id >= ?2 AND id < ?3",
    )?;
    let rows = stmt.query_map(params![tag_id, format!("{uid}/"), format!("{uid}0")], |r| {
        r.get(0)
    })?;
    Ok(rows.collect::<Result<_, _>>()?)
}

/// Moves one tag's songs onto `to` (created with its parents) and drops it. `None` just drops it.
fn move_tag(
    tx: &Connection,
    id: i64,
    to: Option<&str>,
    ops: &mut crate::libsync::Batch,
) -> Result<(), Error> {
    let (current, uid, scope): (String, String, String) = tx.query_row(
        "SELECT name, COALESCE(uid, ''), scope FROM tags WHERE id = ?1",
        params![id],
        |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
    )?;
    let shared = scope == "shared";
    let Some(to) = to else {
        tx.execute("DELETE FROM tags WHERE id = ?1", params![id])?;
        if shared {
            ops.tag_deleted(&uid);
        }
        drop_smart_rule_tag(tx, &uid)?;
        return Ok(());
    };
    if current.eq_ignore_ascii_case(to) {
        // Same tag (names compare NOCASE): only the capitalisation can differ.
        tx.execute("UPDATE tags SET name = ?1 WHERE id = ?2", params![to, id])?;
        if shared {
            ops.tag(&uid, to);
        }
        return Ok(());
    }
    let target = ensure_tag(tx, to, ops)?;
    let (target_uid, target_scope): (String, String) = tx.query_row(
        "SELECT COALESCE(uid, ''), scope FROM tags WHERE id = ?1",
        params![target],
        |r| Ok((r.get(0)?, r.get(1)?)),
    )?;
    let members = if ops.is_on() && target_scope == "shared" {
        tag_members(tx, id, &uid)?
    } else {
        Vec::new()
    };
    tx.execute(
        "INSERT OR IGNORE INTO track_tags (track_id, tag_id)
         SELECT track_id, ?1 FROM track_tags WHERE tag_id = ?2",
        params![target, id],
    )?;
    tx.execute("DELETE FROM tags WHERE id = ?1", params![id])?;
    for fp in members {
        ops.track_tag(&target_uid, &fp, true);
    }
    repoint_smart_rules(tx, &uid, &target_uid, ops)?;
    if shared {
        // Merged, not deleted, so devices that still have rules or songs under the old uid
        // follow it to the new one.
        if target_scope == "shared" {
            ops.tag_merged(&uid, &target_uid);
        } else {
            ops.tag_deleted(&uid);
        }
    }
    Ok(())
}

/// Renames, merges or removes library tags by name: every track of each tag in `from` moves to
/// `to` (created if needed), then the old tag goes. Levels below a moved tag move along with it
/// (`Genre/House` follows `Genre` → `Style` to `Style/House`). With `to` as `None` the tags and
/// everything below them are deleted.
pub fn migrate_tags(conn: &mut Connection, from: &[String], to: Option<&str>) -> Result<(), Error> {
    let to = to.map(normalize_tag).filter(|t| !t.is_empty());
    let tx = conn.transaction()?;
    let mut ops = crate::libsync::Batch::new(&tx)?;
    // (id, new name) for every tag in each `from` subtree, deepest first so children move
    // before the parent they hang under disappears.
    let mut moves: Vec<(i64, usize, Option<String>)> = Vec::new();
    let mut seen = std::collections::HashSet::new();
    for name in from {
        let name = normalize_tag(name);
        if name.is_empty() {
            continue;
        }
        let mut stmt = tx.prepare(
            "SELECT id, name FROM tags
             WHERE lower(name) = lower(?1) OR lower(substr(name, 1, length(?1) + 1)) = lower(?1 || '/')",
        )?;
        let rows = stmt.query_map(params![name], |r| {
            Ok((r.get::<_, i64>(0)?, r.get::<_, String>(1)?))
        })?;
        for row in rows {
            let (id, tag) = row?;
            if !seen.insert(id) {
                continue;
            }
            // "" for the tag itself, "/x/y" for descendants.
            let rest: String = tag.chars().skip(name.chars().count()).collect();
            let depth = tag.matches('/').count();
            moves.push((id, depth, to.as_ref().map(|t| format!("{t}{rest}"))));
        }
    }
    moves.sort_by_key(|m| std::cmp::Reverse(m.1));
    for (id, _, target) in moves {
        let exists: Option<i64> = tx
            .query_row("SELECT id FROM tags WHERE id = ?1", params![id], |r| {
                r.get(0)
            })
            .optional()?;
        if exists.is_some() {
            move_tag(&tx, id, target.as_deref(), &mut ops)?;
        }
    }
    restore_tag_parents(&tx, &mut ops)?;
    ops.commit(&tx)?;
    crate::libsync::clashes::refresh(&tx)?;
    tx.commit()?;
    Ok(())
}

pub fn delete_tag(conn: &Connection, id: i64) -> Result<(), Error> {
    let tx = conn.unchecked_transaction()?;
    let ident: Option<(String, String)> = tx
        .query_row(
            "SELECT COALESCE(uid, ''), scope FROM tags WHERE id = ?1",
            params![id],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .optional()?;
    tx.execute("DELETE FROM tags WHERE id = ?1", params![id])?;
    if let Some((uid, scope)) = ident {
        let mut ops = crate::libsync::Batch::new(&tx)?;
        if scope == "shared" {
            ops.tag_deleted(&uid);
        }
        ops.commit(&tx)?;
        drop_smart_rule_tag(&tx, &uid)?;
    }
    crate::libsync::clashes::refresh(&tx)?;
    tx.commit()?;
    Ok(())
}

pub fn get_setting(conn: &Connection, key: &str) -> Result<Option<String>, Error> {
    match conn.query_row(
        "SELECT value FROM settings WHERE key = ?1",
        params![key],
        |r| r.get(0),
    ) {
        Ok(v) => Ok(Some(v)),
        Err(rusqlite::Error::QueryReturnedNoRows) => Ok(None),
        Err(e) => Err(e.into()),
    }
}

pub fn set_setting(conn: &Connection, key: &str, value: Option<&str>) -> Result<(), Error> {
    match value {
        Some(v) => conn.execute(
            "INSERT INTO settings (key, value) VALUES (?1, ?2)
             ON CONFLICT(key) DO UPDATE SET value = excluded.value",
            params![key, v],
        )?,
        None => conn.execute("DELETE FROM settings WHERE key = ?1", params![key])?,
    };
    Ok(())
}

/// `(path, size)` of every track currently on disk.
pub fn present_sizes(conn: &Connection) -> Result<Vec<(String, i64)>, Error> {
    let mut stmt = conn.prepare("SELECT path, size FROM tracks WHERE missing_since IS NULL")?;
    let rows = stmt.query_map([], |r| Ok((r.get(0)?, r.get(1)?)))?;
    Ok(rows.collect::<Result<Vec<_>, _>>()?)
}

/// `(path, fingerprint)` of every on-disk track that has a fingerprint.
pub fn present_fingerprints(conn: &Connection) -> Result<Vec<(String, String)>, Error> {
    let mut stmt = conn.prepare(
        "SELECT path, fingerprint FROM tracks
         WHERE missing_since IS NULL AND fingerprint IS NOT NULL",
    )?;
    let rows = stmt.query_map([], |r| Ok((r.get(0)?, r.get(1)?)))?;
    Ok(rows.collect::<Result<Vec<_>, _>>()?)
}

/// Every track record, present or missing, for matching destination files against the library.
pub struct TrackRow {
    pub id: i64,
    pub path: String,
    pub fingerprint: Option<String>,
    pub audio_fp: Option<String>,
    pub missing_since: Option<i64>,
}

pub fn all_track_rows(conn: &Connection) -> Result<Vec<TrackRow>, Error> {
    let mut stmt =
        conn.prepare("SELECT id, path, fingerprint, audio_fp, missing_since FROM tracks")?;
    let rows = stmt.query_map([], |r| {
        Ok(TrackRow {
            id: r.get(0)?,
            path: r.get(1)?,
            fingerprint: r.get(2)?,
            audio_fp: r.get(3)?,
            missing_since: r.get(4)?,
        })
    })?;
    Ok(rows.collect::<Result<Vec<_>, _>>()?)
}

/// `track id -> when it was last confirmed on the target` for every synced file.
pub fn synced_times(
    conn: &Connection,
    target_id: i64,
) -> Result<std::collections::HashMap<i64, i64>, Error> {
    let mut stmt =
        conn.prepare("SELECT track_id, synced_at FROM synced_files WHERE target_id = ?1")?;
    let rows = stmt.query_map(params![target_id], |r| Ok((r.get(0)?, r.get(1)?)))?;
    Ok(rows.collect::<Result<_, _>>()?)
}

/// A file as it was at its last successful sync with a destination: the common ancestor that
/// tells whose edit is whose. Only stored when both copies were identical.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Base {
    /// `sync::local_signature` of the library file, equal to `remote_sig`.
    pub local_sig: String,
    pub remote_sig: String,
    /// JSON of the tag fields (`tags::fields_json`); `None` when they could not be read.
    pub tags: Option<String>,
    /// `None` for bases stored before exact checks, until the next sync or read renews them.
    pub exact: Option<Exact>,
}

/// What catches an edit the signatures' samples miss: when a side's change marker moved since
/// the base, its whole content is hashed and compared with `content`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Exact {
    /// `sync::content_hash` of the whole file, the same on both sides.
    pub content: String,
    /// Modification time of the library file (Unix seconds).
    pub local_modified: i64,
    /// The destination copy's change marker (`sync::Remote::version`); `None` until a read after
    /// the sync that wrote it sees one.
    pub remote_version: Option<String>,
}

impl Exact {
    fn of_row(
        content: Option<String>,
        local_modified: Option<i64>,
        remote_version: Option<String>,
    ) -> Option<Self> {
        Some(Self {
            content: content?,
            local_modified: local_modified?,
            remote_version,
        })
    }
}

/// What a finished sync does to a file's base.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum BaseUpdate {
    /// The file was not touched; keep what is stored.
    Keep,
    Set(Base),
    /// The copies may differ now: forget the base.
    Clear,
}

/// A library file confirmed on a destination by a sync.
#[derive(Debug, Clone)]
pub struct Synced {
    pub track_id: i64,
    pub size: i64,
    pub base: BaseUpdate,
}

impl Synced {
    /// A file confirmed on the destination whose base stays as it is.
    pub fn kept(track_id: i64, size: i64) -> Self {
        Self {
            track_id,
            size,
            base: BaseUpdate::Keep,
        }
    }
}

/// `track id -> base` for every synced file of a destination that has one.
pub fn synced_bases(
    conn: &Connection,
    target_id: i64,
) -> Result<std::collections::HashMap<i64, Base>, Error> {
    let mut stmt = conn.prepare(
        "SELECT track_id, local_sig, remote_sig, base_tags, base_content, base_modified,
                base_version
         FROM synced_files
         WHERE target_id = ?1 AND local_sig IS NOT NULL AND remote_sig IS NOT NULL",
    )?;
    let rows = stmt.query_map(params![target_id], |r| {
        Ok((
            r.get(0)?,
            Base {
                local_sig: r.get(1)?,
                remote_sig: r.get(2)?,
                tags: r.get(3)?,
                exact: Exact::of_row(r.get(4)?, r.get(5)?, r.get(6)?),
            },
        ))
    })?;
    Ok(rows.collect::<Result<_, _>>()?)
}

/// Stores bases for files that are already recorded as synced.
pub fn store_bases(
    conn: &mut Connection,
    target_id: i64,
    bases: &[(i64, Base)],
) -> Result<(), Error> {
    let tx = conn.transaction()?;
    {
        let mut stmt = tx.prepare(
            "UPDATE synced_files SET local_sig = ?3, remote_sig = ?4, base_tags = ?5,
                 base_content = ?6, base_modified = ?7, base_version = ?8
             WHERE target_id = ?1 AND track_id = ?2",
        )?;
        for (track_id, b) in bases {
            let exact = b.exact.as_ref();
            stmt.execute(params![
                target_id,
                track_id,
                b.local_sig,
                b.remote_sig,
                b.tags,
                exact.map(|e| &e.content),
                exact.map(|e| e.local_modified),
                exact.and_then(|e| e.remote_version.as_ref()),
            ])?;
        }
    }
    tx.commit()?;
    Ok(())
}

/// Fingerprints of destination files read on earlier runs, keyed by `(path, size)`.
pub fn remote_prints(
    conn: &Connection,
    target_id: i64,
) -> Result<std::collections::HashMap<(String, u64), String>, Error> {
    let mut stmt =
        conn.prepare("SELECT path, size, fingerprint FROM remote_prints WHERE target_id = ?1")?;
    let rows = stmt.query_map(params![target_id], |r| {
        let size: i64 = r.get(1)?;
        Ok(((r.get(0)?, u64::try_from(size).unwrap_or(0)), r.get(2)?))
    })?;
    Ok(rows.collect::<Result<_, _>>()?)
}

pub fn store_remote_prints(
    conn: &Connection,
    target_id: i64,
    prints: &[(String, u64, String)],
) -> Result<(), Error> {
    let mut stmt = conn.prepare(
        "INSERT OR REPLACE INTO remote_prints (target_id, path, size, fingerprint) VALUES (?1, ?2, ?3, ?4)",
    )?;
    for (path, size, fp) in prints {
        stmt.execute(params![
            target_id,
            path,
            i64::try_from(*size).unwrap_or(i64::MAX),
            fp
        ])?;
    }
    Ok(())
}

/// Destination signatures read on earlier runs, by path.
pub fn remote_signatures(conn: &Connection, target_id: i64) -> Result<SignatureCache, Error> {
    let mut stmt = conn.prepare(
        "SELECT path, size, version, signature FROM remote_signatures WHERE target_id = ?1",
    )?;
    let rows = stmt.query_map(params![target_id], |r| {
        let size: i64 = r.get(1)?;
        let path: String = r.get(0)?;
        Ok((
            path.clone(),
            RemoteSignature {
                path,
                size: u64::try_from(size).unwrap_or(0),
                version: r.get(2)?,
                signature: r.get(3)?,
            },
        ))
    })?;
    Ok(rows.collect::<Result<_, _>>()?)
}

/// Replaces a destination's cached signatures with the ones its latest read used, so files gone
/// from the destination drop out.
pub fn replace_remote_signatures(
    conn: &mut Connection,
    target_id: i64,
    signatures: &[RemoteSignature],
) -> Result<(), Error> {
    let tx = conn.transaction()?;
    tx.execute(
        "DELETE FROM remote_signatures WHERE target_id = ?1",
        params![target_id],
    )?;
    {
        let mut stmt = tx.prepare(
            "INSERT OR REPLACE INTO remote_signatures (target_id, path, size, version, signature)
             VALUES (?1, ?2, ?3, ?4, ?5)",
        )?;
        for s in signatures {
            stmt.execute(params![
                target_id,
                s.path,
                i64::try_from(s.size).unwrap_or(i64::MAX),
                s.version,
                s.signature
            ])?;
        }
    }
    Ok(tx.commit()?)
}

/// A hand-set BPM and/or key for one track: replaces the detection result of its audio, so the
/// lists show it. `Some(None)` clears a value; `None` leaves it as it is.
#[allow(clippy::option_option)]
pub fn set_tempo_key(
    conn: &Connection,
    id: i64,
    bpm: Option<Option<f64>>,
    key: Option<Option<&str>>,
) -> Result<(), Error> {
    // A song never analysed gets a row (version 0, so it is still analysed later) to hold the
    // value; the analysis then fills in the rest around it.
    conn.execute(
        "INSERT OR IGNORE INTO analysis (audio_fp, version, analyzed_at)
         SELECT audio_fp, 0, 0 FROM tracks WHERE id = ?1 AND audio_fp <> ''",
        params![id],
    )?;
    if let Some(bpm) = bpm {
        conn.execute(
            "UPDATE analysis SET bpm = ?2, bpm_edited = 1, error = NULL
             WHERE audio_fp = (SELECT audio_fp FROM tracks WHERE id = ?1)",
            params![id, bpm],
        )?;
    }
    if let Some(key) = key {
        conn.execute(
            "UPDATE analysis SET musical_key = ?2, key_edited = 1, error = NULL
             WHERE audio_fp = (SELECT audio_fp FROM tracks WHERE id = ?1)",
            params![id, key],
        )?;
    }
    let mut ops = crate::libsync::Batch::new(conn)?;
    if ops.is_on()
        && let Some(fp) = audio_fp_of(conn, id)?
    {
        use crate::libsync::ops::{A_BPM_EDITED, A_BPM_HAND, A_KEY_EDITED, A_KEY_HAND};
        if let Some(bpm) = bpm {
            ops.analysis(&fp, A_BPM_HAND, serde_json::json!(bpm));
            ops.analysis(&fp, A_BPM_EDITED, serde_json::json!(true));
        }
        if let Some(key) = key {
            ops.analysis(&fp, A_KEY_HAND, serde_json::json!(key));
            ops.analysis(&fp, A_KEY_EDITED, serde_json::json!(true));
        }
    }
    ops.commit(conn)?;
    Ok(())
}

/// A hot cue (`slot` 0-7 for A-H) or memory cue (`slot` `None`).
#[derive(Debug, Clone, PartialEq, Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Cue {
    pub slot: Option<u8>,
    /// Seconds.
    pub start: f64,
    pub name: String,
    /// `#rrggbb`, or empty for the player's default.
    pub color: String,
    /// The memory cue the song starts from: rekordbox and CDJs set to auto-cue on memory cues
    /// load the song at the earliest memory cue, so this one is written first.
    #[serde(default)]
    pub main: bool,
}

/// The cues set in manplay for audio with this `audio_fp`, hot cues first; `None` when cues
/// were never set here (so a drive's own cues are left alone).
pub fn cues_of(conn: &Connection, audio_fp: &str) -> Result<Option<Vec<Cue>>, Error> {
    let edited: bool = conn
        .query_row(
            "SELECT cues_edited FROM analysis WHERE audio_fp = ?1",
            params![audio_fp],
            |r| r.get(0),
        )
        .optional()?
        .unwrap_or(false);
    if !edited {
        return Ok(None);
    }
    let mut stmt = conn.prepare(
        "SELECT slot, start, name, color, main FROM cues WHERE audio_fp = ?1
         ORDER BY slot IS NULL, slot, start",
    )?;
    let rows = stmt.query_map(params![audio_fp], |r| {
        Ok(Cue {
            slot: r.get(0)?,
            start: r.get(1)?,
            name: r.get(2)?,
            color: r.get(3)?,
            main: r.get(4)?,
        })
    })?;
    Ok(Some(rows.collect::<Result<Vec<_>, _>>()?))
}

/// Replaces a song's cues with `cues` and marks them as set in manplay.
pub fn set_cues(conn: &mut Connection, track_id: i64, cues: &[Cue]) -> Result<(), Error> {
    let tx = conn.transaction()?;
    let fp: Option<String> = tx
        .query_row(
            "SELECT audio_fp FROM tracks WHERE id = ?1 AND audio_fp <> ''",
            params![track_id],
            |r| r.get(0),
        )
        .optional()?
        .flatten();
    let Some(fp) = fp else {
        return Err(Error::Msg(
            "This song has no audio to keep cues for.".into(),
        ));
    };
    tx.execute(
        "INSERT OR IGNORE INTO analysis (audio_fp, version, analyzed_at) VALUES (?1, 0, 0)",
        params![fp],
    )?;
    tx.execute(
        "UPDATE analysis SET cues_edited = 1 WHERE audio_fp = ?1",
        params![fp],
    )?;
    tx.execute("DELETE FROM cues WHERE audio_fp = ?1", params![fp])?;
    {
        let mut ins = tx.prepare(
            "INSERT INTO cues (audio_fp, slot, start, name, color, main)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
        )?;
        // One start cue at most, and only as a memory cue.
        let mut main_seen = false;
        for c in cues {
            let main = c.main && c.slot.is_none() && !main_seen;
            main_seen |= main;
            ins.execute(params![
                fp,
                c.slot,
                c.start.max(0.0),
                c.name.trim(),
                c.color,
                main
            ])?;
        }
    }
    tx.commit()?;
    Ok(())
}

/// Marks a song's beat grid as set by hand.
pub fn mark_grid_edited(conn: &Connection, id: i64) -> Result<(), Error> {
    conn.execute(
        "UPDATE analysis SET grid_edited = 1
         WHERE audio_fp = (SELECT audio_fp FROM tracks WHERE id = ?1)",
        params![id],
    )?;
    let mut ops = crate::libsync::Batch::new(conn)?;
    if ops.is_on()
        && let Some(fp) = audio_fp_of(conn, id)?
    {
        use crate::libsync::ops::{A_GRID_EDITED, A_GRID_HAND};
        let grid: Option<(Option<f64>, Option<f64>, Option<i64>)> = conn
            .query_row(
                "SELECT grid_bpm, first_beat, bar_offset FROM analysis WHERE audio_fp = ?1",
                params![fp],
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
            )
            .optional()?;
        if let Some((bpm, first, bar)) = grid {
            ops.analysis(
                &fp,
                A_GRID_HAND,
                serde_json::json!({"grid_bpm": bpm, "first_beat": first, "bar_offset": bar}),
            );
            ops.analysis(&fp, A_GRID_EDITED, serde_json::json!(true));
        }
    }
    ops.commit(conn)?;
    Ok(())
}

pub fn track_path(conn: &Connection, id: i64) -> Result<Option<String>, Error> {
    match conn.query_row("SELECT path FROM tracks WHERE id = ?1", params![id], |r| {
        r.get(0)
    }) {
        Ok(v) => Ok(Some(v)),
        Err(rusqlite::Error::QueryReturnedNoRows) => Ok(None),
        Err(e) => Err(e.into()),
    }
}

#[derive(Debug, Clone, Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NewTarget {
    pub tailnet: String,
    pub machine: String,
    /// First segment is the Taildrive share name.
    pub path: Vec<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SyncTarget {
    pub id: i64,
    pub tailnet: String,
    pub machine: String,
    pub path: Vec<String>,
    pub synced_tracks: i64,
    /// This device's shared library lives on this destination.
    pub libsync: bool,
    /// Name of that library, once known (a device that shared before libraries existed learns it
    /// at its next sync).
    pub library_name: Option<String>,
}

fn parse_path(raw: &str) -> Vec<String> {
    serde_json::from_str(raw).unwrap_or_default()
}

pub fn add_target(conn: &Connection, t: &NewTarget) -> Result<i64, Error> {
    let path = serde_json::to_string(&t.path).map_err(|e| Error::Msg(e.to_string()))?;
    conn.execute(
        "INSERT OR IGNORE INTO sync_targets (tailnet, machine, path) VALUES (?1, ?2, ?3)",
        params![t.tailnet, t.machine, path],
    )?;
    Ok(conn.query_row(
        "SELECT id FROM sync_targets WHERE tailnet = ?1 AND machine = ?2 AND path = ?3",
        params![t.tailnet, t.machine, path],
        |r| r.get(0),
    )?)
}

/// Points a target at a new folder. Everything is re-uploaded there, so synced
/// state is cleared; copies at the old location are left untouched.
pub fn set_target_path(conn: &mut Connection, id: i64, path: &[String]) -> Result<(), Error> {
    let raw = serde_json::to_string(path).map_err(|e| Error::Msg(e.to_string()))?;
    let tx = conn.transaction()?;
    let changed = tx.execute(
        "UPDATE sync_targets SET path = ?2 WHERE id = ?1 AND path != ?2",
        params![id, raw],
    )?;
    if changed > 0 {
        // Another place has none of the library data: this device leaves the library it had
        // here (keeping a copy) and can join again from the new folder.
        crate::libsync::membership::detach_target(&tx, id)?;
        tx.execute("DELETE FROM synced_files WHERE target_id = ?1", params![id])?;
        tx.execute("DELETE FROM stale_remote WHERE target_id = ?1", params![id])?;
    }
    tx.commit()?;
    Ok(())
}

/// Switches library data sharing for one destination. Only one destination shares it at a time.
/// Switching on writes ops for what the library holds and sends the whole log again.
pub fn set_target_libsync(conn: &mut Connection, id: i64, enabled: bool) -> Result<(), Error> {
    if enabled {
        let other: bool = conn.query_row(
            "SELECT EXISTS (SELECT 1 FROM sync_targets WHERE libsync = 1 AND id <> ?1)",
            params![id],
            |r| r.get(0),
        )?;
        if other {
            return Err(Error::Msg(
                "Library data syncs with one destination at a time. Switch it off on the other first."
                    .into(),
            ));
        }
    }
    let changed = conn.execute(
        "UPDATE sync_targets SET libsync = ?2 WHERE id = ?1",
        params![id, enabled],
    )?;
    if changed == 0 {
        return Err(Error::Msg("That destination no longer exists.".into()));
    }
    if enabled {
        crate::libsync::seed::seed(conn)?;
    }
    Ok(())
}

pub fn remove_target(conn: &Connection, id: i64) -> Result<(), Error> {
    let tx = conn.unchecked_transaction()?;
    crate::libsync::membership::detach_target(&tx, id)?;
    tx.execute("DELETE FROM sync_targets WHERE id = ?1", params![id])?;
    Ok(tx.commit()?)
}

pub fn list_targets(conn: &Connection) -> Result<Vec<SyncTarget>, Error> {
    let mut stmt = conn.prepare(
        "SELECT st.id, st.tailnet, st.machine, st.path,
                (SELECT COUNT(*) FROM synced_files sf JOIN tracks t ON t.id = sf.track_id
                 WHERE sf.target_id = st.id AND sf.size = t.size AND t.missing_since IS NULL),
                st.libsync
         FROM sync_targets st ORDER BY st.machine COLLATE NOCASE, st.path",
    )?;
    let rows = stmt.query_map([], |r| {
        let raw: String = r.get(3)?;
        Ok(SyncTarget {
            id: r.get(0)?,
            tailnet: r.get(1)?,
            machine: r.get(2)?,
            path: parse_path(&raw),
            synced_tracks: r.get(4)?,
            libsync: r.get(5)?,
            library_name: None,
        })
    })?;
    let mut targets = rows.collect::<Result<Vec<_>, _>>()?;
    if targets.iter().any(|t| t.libsync) {
        let name = crate::libsync::membership::library_name(conn)?;
        for t in targets.iter_mut().filter(|t| t.libsync) {
            t.library_name.clone_from(&name);
        }
    }
    Ok(targets)
}

/// The services a user can switch on or off.
pub const SERVICES: [&str; 6] = ["downloads", "itunes", "tailscale", "r2", "rekordbox", "usb"];

fn service_key(id: &str) -> String {
    format!("service.{id}")
}

/// Explicit on/off choices; a service never switched is absent.
pub fn service_flags(conn: &Connection) -> Result<Vec<(String, String)>, Error> {
    let mut flags = Vec::new();
    for id in SERVICES {
        if let Some(v) = get_setting(conn, &service_key(id))? {
            flags.push((id.to_owned(), v));
        }
    }
    Ok(flags)
}

pub fn set_service_enabled(conn: &Connection, id: &str, enabled: bool) -> Result<(), Error> {
    if !SERVICES.contains(&id) {
        return Err(Error::Msg(format!("unknown service {id}")));
    }
    set_setting(
        conn,
        &service_key(id),
        Some(if enabled { "on" } else { "off" }),
    )
}

/// Only an explicit "off" disables a service; unconfigured ones simply do nothing.
pub fn service_off(conn: &Connection, id: &str) -> Result<bool, Error> {
    Ok(get_setting(conn, &service_key(id))?.as_deref() == Some("off"))
}

/// Which service a target belongs to.
pub fn target_service(t: &SyncTarget) -> &'static str {
    if t.tailnet.starts_with("r2:") {
        "r2"
    } else {
        "tailscale"
    }
}

/// `only` picks explicit targets; with `None` every target of an enabled service.
pub fn get_targets(conn: &Connection, only: Option<&[i64]>) -> Result<Vec<SyncTarget>, Error> {
    let mut out = Vec::new();
    for t in list_targets(conn)? {
        let keep = match only {
            Some(ids) => ids.contains(&t.id),
            None => !service_off(conn, target_service(&t))?,
        };
        if keep {
            out.push(t);
        }
    }
    Ok(out)
}

pub struct RunRecord {
    pub target_id: i64,
    pub started_at: i64,
    pub finished_at: i64,
    pub uploaded: usize,
    pub skipped: usize,
    pub failed: usize,
    pub deleted: usize,
    pub first_error: Option<String>,
    /// Every reported failure (capped upstream).
    pub errors: Vec<String>,
    /// Shared by all destinations synced by one command.
    pub batch: i64,
}

/// Stores the run and marks every confirmed-present track as synced.
pub fn record_run(
    conn: &mut Connection,
    run: &RunRecord,
    synced: &[Synced],
    deleted_tracks: &[i64],
) -> Result<(), Error> {
    let tx = conn.transaction()?;
    for track_id in deleted_tracks {
        tx.execute(
            "DELETE FROM synced_files WHERE target_id = ?1 AND track_id = ?2",
            params![run.target_id, track_id],
        )?;
    }
    {
        let mut stmt = tx.prepare(
            "INSERT INTO synced_files
                 (target_id, track_id, size, synced_at, local_sig, remote_sig, base_tags,
                  base_content, base_modified, base_version)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?9, ?10, ?11)
             ON CONFLICT(target_id, track_id) DO UPDATE SET
                 size = excluded.size, synced_at = excluded.synced_at,
                 local_sig = IIF(?8, excluded.local_sig, local_sig),
                 remote_sig = IIF(?8, excluded.remote_sig, remote_sig),
                 base_tags = IIF(?8, excluded.base_tags, base_tags),
                 base_content = IIF(?8, excluded.base_content, base_content),
                 base_modified = IIF(?8, excluded.base_modified, base_modified),
                 base_version = IIF(?8, excluded.base_version, base_version)",
        )?;
        for s in synced {
            let (sigs, replace) = match &s.base {
                BaseUpdate::Keep => (None, false),
                BaseUpdate::Set(b) => (Some(b), true),
                BaseUpdate::Clear => (None, true),
            };
            stmt.execute(params![
                run.target_id,
                s.track_id,
                s.size,
                run.finished_at,
                sigs.map(|b| &b.local_sig),
                sigs.map(|b| &b.remote_sig),
                sigs.and_then(|b| b.tags.as_ref()),
                replace,
                sigs.and_then(|b| b.exact.as_ref()).map(|e| &e.content),
                sigs.and_then(|b| b.exact.as_ref())
                    .map(|e| e.local_modified),
                sigs.and_then(|b| b.exact.as_ref())
                    .and_then(|e| e.remote_version.as_ref()),
            ])?;
        }
    }
    tx.execute(
        "INSERT INTO sync_runs
             (target_id, started_at, finished_at, uploaded, skipped, failed, deleted, first_error,
              errors, batch)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)",
        params![
            run.target_id,
            run.started_at,
            run.finished_at,
            i64::try_from(run.uploaded).unwrap_or(i64::MAX),
            i64::try_from(run.skipped).unwrap_or(i64::MAX),
            i64::try_from(run.failed).unwrap_or(i64::MAX),
            i64::try_from(run.deleted).unwrap_or(i64::MAX),
            run.first_error,
            serde_json::to_string(&run.errors).unwrap_or_else(|_| "[]".to_owned()),
            run.batch
        ],
    )?;
    tx.commit()?;
    Ok(())
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RunView {
    pub id: i64,
    pub target_id: i64,
    pub tailnet: String,
    pub machine: String,
    pub path: Vec<String>,
    pub started_at: i64,
    pub finished_at: i64,
    pub uploaded: i64,
    pub skipped: i64,
    pub failed: i64,
    pub deleted: i64,
    pub first_error: Option<String>,
    pub errors: Vec<String>,
    pub batch: i64,
}

/// One run of an import or export source (downloads, itunes, rekordbox).
#[derive(Debug, Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct Activity {
    pub id: i64,
    pub source: String,
    pub started_at: i64,
    pub finished_at: i64,
    pub ok: i64,
    pub skipped: i64,
    pub failed: i64,
    /// What was imported or exported, one line each (capped).
    pub items: Vec<String>,
    pub errors: Vec<String>,
}

const ACTIVITY_KEEP: i64 = 200;
const ACTIVITY_LINES: usize = 100;

pub fn record_activity(conn: &Connection, a: &Activity) -> Result<(), Error> {
    let cap = |v: &[String]| -> Result<String, Error> {
        serde_json::to_string(&v[..v.len().min(ACTIVITY_LINES)])
            .map_err(|e| Error::Msg(e.to_string()))
    };
    conn.execute(
        "INSERT INTO activity (source, started_at, finished_at, ok, skipped, failed, items, errors)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
        params![
            a.source,
            a.started_at,
            a.finished_at,
            a.ok,
            a.skipped,
            a.failed,
            cap(&a.items)?,
            cap(&a.errors)?
        ],
    )?;
    conn.execute(
        "DELETE FROM activity WHERE source = ?1 AND id NOT IN
         (SELECT id FROM activity WHERE source = ?1 ORDER BY id DESC LIMIT ?2)",
        params![a.source, ACTIVITY_KEEP],
    )?;
    Ok(())
}

pub fn activity_history(
    conn: &Connection,
    source: &str,
    limit: i64,
) -> Result<Vec<Activity>, Error> {
    let mut stmt = conn.prepare(
        "SELECT id, source, started_at, finished_at, ok, skipped, failed, items, errors
         FROM activity WHERE source = ?1 ORDER BY id DESC LIMIT ?2",
    )?;
    let rows = stmt.query_map(params![source, limit], |r| {
        let list = |i: usize| -> rusqlite::Result<Vec<String>> {
            Ok(serde_json::from_str(&r.get::<_, String>(i)?).unwrap_or_default())
        };
        Ok(Activity {
            id: r.get(0)?,
            source: r.get(1)?,
            started_at: r.get(2)?,
            finished_at: r.get(3)?,
            ok: r.get(4)?,
            skipped: r.get(5)?,
            failed: r.get(6)?,
            items: list(7)?,
            errors: list(8)?,
        })
    })?;
    Ok(rows.collect::<Result<Vec<_>, _>>()?)
}

pub fn dismiss_activity(conn: &Connection, ids: &[i64]) -> Result<(), Error> {
    for id in ids {
        conn.execute("DELETE FROM activity WHERE id = ?1", params![id])?;
    }
    Ok(())
}

pub fn dismiss_runs(conn: &Connection, ids: &[i64]) -> Result<(), Error> {
    for id in ids {
        conn.execute("DELETE FROM sync_runs WHERE id = ?1", params![id])?;
    }
    Ok(())
}

pub fn history(conn: &Connection, limit: i64) -> Result<Vec<RunView>, Error> {
    let mut stmt = conn.prepare(
        "SELECT r.id, r.target_id, st.machine, st.path, r.started_at, r.finished_at,
                r.uploaded, r.skipped, r.failed, r.first_error, r.deleted, r.errors, r.batch, st.tailnet
         FROM sync_runs r JOIN sync_targets st ON st.id = r.target_id
         ORDER BY r.id DESC LIMIT ?1",
    )?;
    let rows = stmt.query_map(params![limit], |r| {
        let raw: String = r.get(3)?;
        Ok(RunView {
            id: r.get(0)?,
            target_id: r.get(1)?,
            machine: r.get(2)?,
            path: parse_path(&raw),
            started_at: r.get(4)?,
            finished_at: r.get(5)?,
            uploaded: r.get(6)?,
            skipped: r.get(7)?,
            failed: r.get(8)?,
            first_error: r.get(9)?,
            deleted: r.get(10)?,
            errors: serde_json::from_str(&r.get::<_, String>(11)?).unwrap_or_default(),
            batch: r.get(12)?,
            tailnet: r.get(13)?,
        })
    })?;
    Ok(rows.collect::<Result<Vec<_>, _>>()?)
}

// ---- missing files: soft delete, grace period, backups ---------------------

/// `(id, path)` of every track that is currently present (not marked missing).
pub fn present_tracks(conn: &Connection) -> Result<Vec<(i64, String)>, Error> {
    let mut stmt = conn.prepare("SELECT id, path FROM tracks WHERE missing_since IS NULL")?;
    let rows = stmt.query_map([], |r| Ok((r.get(0)?, r.get(1)?)))?;
    Ok(rows.collect::<Result<Vec<_>, _>>()?)
}

pub fn mark_missing(conn: &mut Connection, ids: &[i64], now: i64) -> Result<(), Error> {
    let tx = conn.transaction()?;
    {
        let mut stmt = tx.prepare("UPDATE tracks SET missing_since = ?2 WHERE id = ?1")?;
        for id in ids {
            stmt.execute(params![id, now])?;
        }
    }
    tx.commit()?;
    Ok(())
}

pub fn missing_count(conn: &Connection) -> Result<i64, Error> {
    Ok(conn.query_row(
        "SELECT COUNT(*) FROM tracks WHERE missing_since IS NOT NULL",
        [],
        |r| r.get(0),
    )?)
}

pub struct MissingTrack {
    pub id: i64,
    pub path: String,
    pub title: String,
    pub artist: String,
    pub album: String,
    pub missing_since: i64,
}

/// Tracks whose files vanished from disk, longest-missing first.
pub fn missing_tracks(conn: &Connection) -> Result<Vec<MissingTrack>, Error> {
    let mut stmt = conn.prepare(
        "SELECT id, path, title, artist, album, missing_since FROM tracks
         WHERE missing_since IS NOT NULL ORDER BY missing_since, path",
    )?;
    let rows = stmt.query_map([], |r| {
        Ok(MissingTrack {
            id: r.get(0)?,
            path: r.get(1)?,
            title: r.get(2)?,
            artist: r.get(3)?,
            album: r.get(4)?,
            missing_since: r.get(5)?,
        })
    })?;
    Ok(rows.collect::<Result<_, _>>()?)
}

/// Treats every missing track as past its grace period (the user asked to remove them now).
pub fn expire_missing_now(conn: &Connection) -> Result<(), Error> {
    conn.execute(
        "UPDATE tracks SET missing_since = 0 WHERE missing_since IS NOT NULL",
        [],
    )?;
    Ok(())
}

const PURGEABLE: &str = "missing_since IS NOT NULL AND missing_since <= ?1
    AND NOT EXISTS (SELECT 1 FROM synced_files sf WHERE sf.track_id = tracks.id)";

/// Expired missing tracks with no remaining remote copies; removing them also drops
/// their playlist entries and tags.
pub fn purgeable_count(conn: &Connection, cutoff: i64) -> Result<i64, Error> {
    Ok(conn.query_row(
        &format!("SELECT COUNT(*) FROM tracks WHERE {PURGEABLE}"),
        params![cutoff],
        |r| r.get(0),
    )?)
}

pub fn purge_expired(conn: &Connection, cutoff: i64) -> Result<usize, Error> {
    Ok(conn.execute(
        &format!("DELETE FROM tracks WHERE {PURGEABLE}"),
        params![cutoff],
    )?)
}

/// Copies the database to `dir/library-<stamp>-<n>.db` and keeps only the newest `keep` copies.
pub fn backup(conn: &Connection, dir: &Path, stamp: i64, keep: usize) -> Result<(), Error> {
    std::fs::create_dir_all(dir)?;
    // Several backups can happen within one second (a move, then a purge), so never reuse a name.
    let target = (0_u32..1000)
        .map(|n| dir.join(format!("library-{stamp:012}-{n:03}.db")))
        .find(|p| !p.exists())
        .ok_or_else(|| {
            Error::Msg("no free backup file name (1000 backups in one second?)".to_owned())
        })?;
    conn.execute("VACUUM INTO ?1", params![target.to_string_lossy()])?;

    let mut backups: Vec<_> = std::fs::read_dir(dir)?
        .filter_map(Result::ok)
        .map(|e| e.path())
        .filter(|p| {
            p.file_name()
                .and_then(|n| n.to_str())
                .is_some_and(|n| n.starts_with("library-"))
        })
        .collect();
    backups.sort();
    let excess = backups.len().saturating_sub(keep);
    for old in backups.into_iter().take(excess) {
        // Pruning old backups is best-effort.
        let _ = std::fs::remove_file(old);
    }
    Ok(())
}

// ---- moves and renames ------------------------------------------------------

pub struct Known {
    pub id: i64,
    pub path: String,
    pub fingerprint: Option<String>,
}

/// Every track row, present or soft-deleted.
pub fn all_known(conn: &Connection) -> Result<Vec<Known>, Error> {
    let mut stmt = conn.prepare("SELECT id, path, fingerprint FROM tracks")?;
    let rows = stmt.query_map([], |r| {
        Ok(Known {
            id: r.get(0)?,
            path: r.get(1)?,
            fingerprint: r.get(2)?,
        })
    })?;
    Ok(rows.collect::<Result<Vec<_>, _>>()?)
}

/// Points an existing track at its new file. Tags and playlists stay because the row (and id)
/// is kept. Remote copies at the old location are queued for deletion, and the track is marked
/// not-yet-synced so the next sync uploads it to the new location first.
pub fn apply_move(
    conn: &mut Connection,
    id: i64,
    new: &NewTrack,
    old_rel: Option<&[String]>,
) -> Result<(), Error> {
    let tx = conn.transaction()?;
    if let Some(rel) = old_rel {
        let rel_json = serde_json::to_string(rel).map_err(|e| Error::Msg(e.to_string()))?;
        tx.execute(
            "INSERT OR IGNORE INTO stale_remote (target_id, track_id, rel)
             SELECT target_id, track_id, ?2 FROM synced_files WHERE track_id = ?1",
            params![id, rel_json],
        )?;
    }
    tx.execute("DELETE FROM synced_files WHERE track_id = ?1", params![id])?;
    tx.execute(
        "UPDATE tracks SET path = ?2, artist = ?3, album = ?4, title = ?5, size = ?6,
                fingerprint = ?7, missing_since = NULL,
                duration_ms = COALESCE(?8, duration_ms), bitrate = COALESCE(?9, bitrate),
                sample_rate = COALESCE(?10, sample_rate), fields = COALESCE(?11, fields),
                audio_fp = CASE WHEN ?12 <> '' THEN ?12 ELSE COALESCE(audio_fp, ?12) END
         WHERE id = ?1",
        params![
            id,
            new.path,
            new.artist,
            new.album,
            new.title,
            new.size,
            new.fingerprint,
            new.duration_ms,
            new.bitrate,
            new.sample_rate,
            new.fields,
            new.audio_fp
        ],
    )?;
    tx.commit()?;
    Ok(())
}

/// Old remote locations (from moved tracks) waiting for deletion on `target_id`.
pub fn stale_for(conn: &Connection, target_id: i64) -> Result<Vec<(i64, Vec<String>)>, Error> {
    let mut stmt = conn.prepare("SELECT track_id, rel FROM stale_remote WHERE target_id = ?1")?;
    let rows = stmt.query_map(params![target_id], |r| {
        let raw: String = r.get(1)?;
        Ok((r.get(0)?, parse_path(&raw)))
    })?;
    Ok(rows.collect::<Result<Vec<_>, _>>()?)
}

pub fn clear_stale(
    conn: &Connection,
    target_id: i64,
    done: &[(i64, Vec<String>)],
) -> Result<(), Error> {
    for (track_id, rel) in done {
        let rel_json = serde_json::to_string(rel).map_err(|e| Error::Msg(e.to_string()))?;
        conn.execute(
            "DELETE FROM stale_remote WHERE target_id = ?1 AND track_id = ?2 AND rel = ?3",
            params![target_id, track_id, rel_json],
        )?;
    }
    Ok(())
}

// ---- rekordbox export -------------------------------------------------------

pub struct ExportTrack {
    pub id: i64,
    pub path: String,
    pub artist: String,
    pub album: String,
    pub title: String,
    pub size: i64,
    pub duration_ms: Option<i64>,
    pub bitrate: Option<i64>,
    pub sample_rate: Option<i64>,
    pub bpm: Option<f64>,
    pub key: Option<String>,
    /// Under which the song's analysis and cues are kept.
    pub audio_fp: Option<String>,
    /// The kept beat grid, written as a rekordbox `TEMPO` marker; filled in by the caller.
    pub grid: Option<crate::rekordbox::Grid>,
    /// The beat grid was set by hand in manplay.
    pub grid_edited: bool,
    /// Cues set in manplay, written as `POSITION_MARK`s; filled in by the caller.
    pub cues: Vec<Cue>,
}

pub struct ExportPlaylist {
    /// Playlist id; `None` for playlists made from a tag.
    pub id: Option<i64>,
    pub name: String,
    pub track_ids: Vec<i64>,
}

/// Everything the rekordbox export needs: present tracks and playlists in their saved order.
pub fn export_data(conn: &Connection) -> Result<(Vec<ExportTrack>, Vec<ExportPlaylist>), Error> {
    let mut stmt = conn.prepare(
        "SELECT t.id, t.path, t.artist, t.album, t.title, t.size, t.duration_ms, t.bitrate,
                t.sample_rate, COALESCE(a.bpm, t.tag_bpm), COALESCE(a.musical_key, t.tag_key),
                NULLIF(t.audio_fp, ''), COALESCE(a.grid_edited, 0)
         FROM tracks t LEFT JOIN analysis a ON a.audio_fp = t.audio_fp
         WHERE t.missing_since IS NULL ORDER BY t.artist, t.album, t.path",
    )?;
    let tracks = stmt
        .query_map([], |r| {
            Ok(ExportTrack {
                id: r.get(0)?,
                path: r.get(1)?,
                artist: r.get(2)?,
                album: r.get(3)?,
                title: r.get(4)?,
                size: r.get(5)?,
                duration_ms: r.get(6)?,
                bitrate: r.get(7)?,
                sample_rate: r.get(8)?,
                bpm: r.get(9)?,
                key: r.get(10)?,
                audio_fp: r.get(11)?,
                grid: None,
                grid_edited: r.get(12)?,
                cues: Vec::new(),
            })
        })?
        .collect::<Result<Vec<_>, _>>()?;

    let mut pl_stmt =
        conn.prepare("SELECT id, name FROM playlists ORDER BY name COLLATE NOCASE")?;
    let heads = pl_stmt
        .query_map([], |r| Ok((r.get::<_, i64>(0)?, r.get::<_, String>(1)?)))?
        .collect::<Result<Vec<_>, _>>()?;
    let mut member_stmt = conn.prepare(&format!(
        "SELECT pt.track_id FROM playlist_tracks pt JOIN tracks t ON t.id = pt.track_id
         WHERE pt.playlist_id = ?1 AND t.missing_since IS NULL {ONE_PER_AUDIO}
         ORDER BY pt.position"
    ))?;
    let mut playlists = Vec::new();
    for (id, name) in heads {
        let track_ids = member_stmt
            .query_map(params![id], |r| r.get(0))?
            .collect::<Result<Vec<_>, _>>()?;
        playlists.push(ExportPlaylist {
            id: Some(id),
            name,
            track_ids,
        });
    }
    Ok((tracks, playlists))
}

/// One playlist per tag name: the present songs tagged with it or anything below it. Unknown
/// tags are skipped.
pub fn export_tag_playlists(
    conn: &Connection,
    names: &[String],
) -> Result<Vec<ExportPlaylist>, Error> {
    let mut head = conn.prepare("SELECT id, name FROM tags WHERE name = ?1 COLLATE NOCASE")?;
    let mut members = conn.prepare(&format!(
        "SELECT DISTINCT t.id FROM tags g
         JOIN tags c ON {IN_SUBTREE}
         JOIN track_tags tt ON tt.tag_id = c.id
         JOIN tracks t ON t.id = tt.track_id AND t.missing_since IS NULL
         WHERE g.id = ?1 ORDER BY t.artist, t.album, t.path"
    ))?;
    let mut out = Vec::new();
    for wanted in names {
        let found = head
            .query_row(params![wanted], |r| {
                Ok((r.get::<_, i64>(0)?, r.get::<_, String>(1)?))
            })
            .optional()?;
        let Some((id, name)) = found else {
            continue;
        };
        let track_ids = members
            .query_map(params![id], |r| r.get(0))?
            .collect::<Result<Vec<_>, _>>()?;
        out.push(ExportPlaylist {
            id: None,
            name,
            track_ids,
        });
    }
    Ok(out)
}

/// Sizes and fingerprints of the tracks currently in the library, for spotting files that are
/// already imported.
pub fn content_index(conn: &Connection) -> Result<crate::import::ContentIndex, Error> {
    let mut index = crate::import::ContentIndex::new();
    let mut stmt = conn.prepare(
        "SELECT size, fingerprint FROM tracks
         WHERE missing_since IS NULL AND fingerprint IS NOT NULL",
    )?;
    for row in stmt.query_map([], |r| Ok((r.get::<_, i64>(0)?, r.get::<_, String>(1)?)))? {
        let (size, fp) = row?;
        if let Ok(size) = u64::try_from(size) {
            index.entry(size).or_default().insert(fp);
        }
    }
    Ok(index)
}

/// Library songs by the fingerprint of their audio alone, to their paths.
pub fn audio_index(conn: &Connection) -> Result<std::collections::HashMap<String, String>, Error> {
    let mut stmt = conn.prepare(
        "SELECT audio_fp, path FROM tracks WHERE missing_since IS NULL AND audio_fp IS NOT NULL",
    )?;
    let rows = stmt.query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)))?;
    Ok(rows.collect::<Result<_, _>>()?)
}

/// One file of a [`DuplicateGroup`].
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DuplicateTrack {
    pub id: i64,
    pub path: String,
    pub artist: String,
    pub album: String,
    pub title: String,
    pub size: i64,
}

/// Present songs that share one `audio_fp`: the same recording stored more than once. They share
/// tags, analysis and playlist entries.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DuplicateGroup {
    pub audio_fp: String,
    pub tracks: Vec<DuplicateTrack>,
}

/// Every group of present songs with the same audio, files in path order.
pub fn duplicate_groups(conn: &Connection) -> Result<Vec<DuplicateGroup>, Error> {
    let mut stmt = conn.prepare(
        "SELECT t.audio_fp, t.id, t.path, t.artist, t.album, t.title, t.size FROM tracks t
         WHERE t.missing_since IS NULL AND t.audio_fp <> '' AND t.audio_fp IN (
             SELECT audio_fp FROM tracks
             WHERE missing_since IS NULL AND audio_fp IS NOT NULL AND audio_fp <> ''
             GROUP BY audio_fp HAVING COUNT(*) > 1)
         ORDER BY t.audio_fp, t.path",
    )?;
    let rows = stmt.query_map([], |r| {
        Ok((
            r.get::<_, String>(0)?,
            DuplicateTrack {
                id: r.get(1)?,
                path: r.get(2)?,
                artist: r.get(3)?,
                album: r.get(4)?,
                title: r.get(5)?,
                size: r.get(6)?,
            },
        ))
    })?;
    let mut groups: Vec<DuplicateGroup> = Vec::new();
    for row in rows {
        let (audio_fp, track) = row?;
        match groups.last_mut() {
            Some(g) if g.audio_fp == audio_fp => g.tracks.push(track),
            _ => groups.push(DuplicateGroup {
                audio_fp,
                tracks: vec![track],
            }),
        }
    }
    Ok(groups)
}

/// Present songs with an audio fingerprint: `(id, path, audio_fp)`.
pub fn tracks_with_audio_fp(conn: &Connection) -> Result<Vec<(i64, String, String)>, Error> {
    let mut stmt = conn.prepare(
        "SELECT id, path, audio_fp FROM tracks
         WHERE missing_since IS NULL AND audio_fp IS NOT NULL AND audio_fp <> ''",
    )?;
    let rows = stmt.query_map([], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)))?;
    Ok(rows.collect::<Result<_, _>>()?)
}

/// Present library songs whose audio has not been fingerprinted yet.
pub fn tracks_without_audio_fp(conn: &Connection) -> Result<Vec<(i64, String)>, Error> {
    let mut stmt = conn
        .prepare("SELECT id, path FROM tracks WHERE missing_since IS NULL AND audio_fp IS NULL")?;
    let rows = stmt.query_map([], |r| Ok((r.get(0)?, r.get(1)?)))?;
    Ok(rows.collect::<Result<_, _>>()?)
}

/// Stores audio fingerprints; an empty string marks a file that could not be fingerprinted, so
/// it is not read again every scan.
pub fn set_audio_fps(conn: &mut Connection, fps: &[(i64, String)]) -> Result<(), Error> {
    let tx = conn.transaction()?;
    {
        let mut stmt = tx.prepare("UPDATE tracks SET audio_fp = ?2 WHERE id = ?1")?;
        for (id, fp) in fps {
            stmt.execute(params![id, fp])?;
        }
    }
    tx.commit()?;
    Ok(())
}

/// The saved import-scan cache for `folder`, as written by `put_import_cache`.
pub fn get_import_cache(conn: &Connection, folder: &str) -> Result<Option<String>, Error> {
    Ok(conn
        .query_row(
            "SELECT data FROM import_cache WHERE folder = ?1",
            [folder],
            |r| r.get(0),
        )
        .optional()?)
}

pub fn put_import_cache(conn: &Connection, folder: &str, data: &str) -> Result<(), Error> {
    conn.execute(
        "INSERT INTO import_cache (folder, data) VALUES (?1, ?2)
         ON CONFLICT(folder) DO UPDATE SET data = excluded.data",
        (folder, data),
    )?;
    Ok(())
}

/// A file waiting for BPM and key detection.
pub struct AnalysisJob {
    pub path: String,
    pub audio_fp: String,
}

/// Present tracks to analyse: those in `ids` (every track when `None`), one per distinct audio
/// content. Unless `force`, content that was already analysed is left out.
pub fn analysis_jobs(
    conn: &Connection,
    ids: Option<&[i64]>,
    force: bool,
) -> Result<Vec<AnalysisJob>, Error> {
    let wanted: Option<std::collections::HashSet<i64>> = ids.map(|i| i.iter().copied().collect());
    let mut stmt = conn.prepare(
        "SELECT t.id, t.path, t.audio_fp, a.version, a.waveform IS NULL AND a.error IS NULL
         FROM tracks t
         LEFT JOIN analysis a ON a.audio_fp = t.audio_fp
         WHERE t.missing_since IS NULL AND t.audio_fp <> ''
         ORDER BY t.artist, t.album, t.path",
    )?;
    let rows = stmt.query_map([], |r| {
        Ok((
            r.get::<_, i64>(0)?,
            r.get::<_, String>(1)?,
            r.get::<_, String>(2)?,
            r.get::<_, Option<i64>>(3)?,
            r.get::<_, Option<bool>>(4)?.unwrap_or(true),
        ))
    })?;
    let mut seen = std::collections::HashSet::new();
    let mut jobs = Vec::new();
    for row in rows {
        let (id, path, audio_fp, version, no_waveform) = row?;
        if wanted.as_ref().is_some_and(|w| !w.contains(&id)) {
            continue;
        }
        // Up to date, or failed with the current version: nothing new to learn. Audio analysed
        // before the beat grid and waveform were kept (or whose kept files were lost) is done
        // again for them.
        if !force && version.is_some_and(|v| v >= crate::analysis::VERSION) && !no_waveform {
            continue;
        }
        if seen.insert(audio_fp.clone()) {
            jobs.push(AnalysisJob { path, audio_fp });
        }
    }
    Ok(jobs)
}

/// The `audio_fp` of a track, if it has been read.
pub fn audio_fp_of(conn: &Connection, track_id: i64) -> Result<Option<String>, Error> {
    Ok(conn
        .query_row(
            "SELECT audio_fp FROM tracks WHERE id = ?1 AND audio_fp <> ''",
            params![track_id],
            |r| r.get::<_, Option<String>>(0),
        )
        .optional()?
        .flatten())
}

/// A present track with a detected BPM and/or key.
pub struct AnalysisResult {
    pub path: String,
    pub bpm: Option<f64>,
    pub key: Option<String>,
}

/// Detection results for present tracks (only those in `ids` when given).
pub fn analysis_results(
    conn: &Connection,
    ids: Option<&[i64]>,
) -> Result<Vec<AnalysisResult>, Error> {
    let wanted: Option<std::collections::HashSet<i64>> = ids.map(|i| i.iter().copied().collect());
    let mut stmt = conn.prepare(
        "SELECT t.id, t.path, a.bpm, a.musical_key FROM tracks t
         JOIN analysis a ON a.audio_fp = t.audio_fp
         WHERE t.missing_since IS NULL AND (a.bpm IS NOT NULL OR a.musical_key IS NOT NULL)
         ORDER BY t.path",
    )?;
    let rows = stmt.query_map([], |r| {
        Ok((
            r.get::<_, i64>(0)?,
            AnalysisResult {
                path: r.get(1)?,
                bpm: r.get(2)?,
                key: r.get(3)?,
            },
        ))
    })?;
    let mut out = Vec::new();
    for row in rows {
        let (id, result) = row?;
        if wanted.as_ref().is_none_or(|w| w.contains(&id)) {
            out.push(result);
        }
    }
    Ok(out)
}

/// Ids of present tracks holding any of these `audio_fp`s (duplicates included).
pub fn track_ids_with_audio_fps(conn: &Connection, prints: &[&str]) -> Result<Vec<i64>, Error> {
    let mut stmt =
        conn.prepare("SELECT id FROM tracks WHERE audio_fp = ?1 AND missing_since IS NULL")?;
    let mut ids = Vec::new();
    for fp in prints {
        for id in stmt.query_map(params![fp], |r| r.get(0))? {
            ids.push(id?);
        }
    }
    Ok(ids)
}

/// Present tracks whose last analysis failed, with the reason.
pub fn analysis_failures(conn: &Connection) -> Result<Vec<crate::audit::FixFailure>, Error> {
    let mut stmt = conn.prepare(
        "SELECT t.path, a.error FROM tracks t JOIN analysis a ON a.audio_fp = t.audio_fp
         WHERE t.missing_since IS NULL AND a.error IS NOT NULL ORDER BY t.path",
    )?;
    let rows = stmt.query_map([], |r| {
        Ok(crate::audit::FixFailure {
            path: r.get(0)?,
            error: r.get(1)?,
        })
    })?;
    Ok(rows.collect::<Result<Vec<_>, _>>()?)
}

/// Stores the outcome of analysing the audio with this `audio_fp`: BPM, key, and the beat
/// grid and waveform in `stored`. BPM, key and grid set by hand stay, unless `replace_edits`,
/// which also forgets that they were set by hand. A failed analysis keeps any earlier waveform.
pub fn store_analysis(
    conn: &Connection,
    audio_fp: &str,
    result: &Result<(crate::analysis::Analysis, crate::anlz::Stored), String>,
    now: i64,
    replace_edits: bool,
) -> Result<(), Error> {
    let (bpm, key, error) = match result {
        Ok((a, _)) => (a.bpm, a.key.as_deref(), None),
        Err(e) => (None, None, Some(e.as_str())),
    };
    // Which hand edits this forgets, so other devices forget them too.
    let forgotten: (bool, bool, bool) = if replace_edits {
        conn.query_row(
            "SELECT bpm_edited, key_edited, grid_edited FROM analysis WHERE audio_fp = ?1",
            params![audio_fp],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
        )
        .optional()?
        .unwrap_or_default()
    } else {
        (false, false, false)
    };
    conn.execute(
        "INSERT INTO analysis (audio_fp, bpm, musical_key, error, version, analyzed_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6)
         ON CONFLICT(audio_fp) DO UPDATE SET
             bpm = CASE WHEN analysis.bpm_edited AND NOT ?7 THEN analysis.bpm ELSE excluded.bpm END,
             musical_key = CASE WHEN analysis.key_edited AND NOT ?7
                 THEN analysis.musical_key ELSE excluded.musical_key END,
             error = excluded.error, version = excluded.version,
             analyzed_at = excluded.analyzed_at,
             bpm_edited = analysis.bpm_edited AND NOT ?7,
             key_edited = analysis.key_edited AND NOT ?7,
             grid_edited = analysis.grid_edited AND NOT ?7",
        params![
            audio_fp,
            bpm,
            key,
            error,
            crate::analysis::VERSION,
            now,
            replace_edits
        ],
    )?;
    if let Ok((a, stored)) = result {
        conn.execute(
            "UPDATE analysis SET duration = ?2, waveform = ?3, wf_pushed = 0,
                 grid_bpm = CASE WHEN grid_edited AND waveform IS NOT NULL
                     THEN grid_bpm ELSE ?4 END,
                 first_beat = CASE WHEN grid_edited AND waveform IS NOT NULL
                     THEN first_beat ELSE ?5 END,
                 bar_offset = CASE WHEN grid_edited AND waveform IS NOT NULL
                     THEN bar_offset ELSE ?6 END
             WHERE audio_fp = ?1",
            params![
                audio_fp,
                stored.duration,
                stored.detail,
                stored.grid_bpm,
                stored.first_beat,
                stored.bar_offset
            ],
        )?;
        let mut ops = crate::libsync::Batch::new(conn)?;
        if ops.is_on() {
            use crate::libsync::ops::{
                A_BPM, A_BPM_EDITED, A_GRID_EDITED, A_KEY, A_KEY_EDITED, A_VERSION,
            };
            use serde_json::json;
            ops.analysis(audio_fp, A_BPM, json!(a.bpm));
            ops.analysis(audio_fp, A_KEY, json!(a.key));
            ops.analysis(audio_fp, A_VERSION, json!(crate::analysis::VERSION));
            share_auto_grid(&mut ops, audio_fp, stored);
            for (was, flag) in [
                (forgotten.0, A_BPM_EDITED),
                (forgotten.1, A_KEY_EDITED),
                (forgotten.2, A_GRID_EDITED),
            ] {
                if was {
                    ops.analysis(audio_fp, flag, json!(false));
                }
            }
        }
        ops.commit(conn)?;
    }
    Ok(())
}

/// Writes the automatic beat grid and duration of a finished analysis as ops.
pub fn share_auto_grid(
    ops: &mut crate::libsync::Batch,
    audio_fp: &str,
    stored: &crate::anlz::Stored,
) {
    use crate::libsync::ops::{A_BAR_OFFSET, A_DURATION, A_FIRST_BEAT, A_GRID_BPM};
    use serde_json::json;
    ops.analysis(audio_fp, A_GRID_BPM, json!(stored.grid_bpm));
    ops.analysis(audio_fp, A_FIRST_BEAT, json!(stored.first_beat));
    ops.analysis(audio_fp, A_BAR_OFFSET, json!(stored.bar_offset));
    ops.analysis(audio_fp, A_DURATION, json!(stored.duration));
}

#[cfg(test)]
#[allow(clippy::expect_used)] // tests: panicking is the failure mode
mod tests {
    use super::*;
    use crate::analysis::Analysis;

    /// A file whose audio is `audio` (its `audio_fp`).
    fn track(path: &str, audio: &str, tag_bpm: Option<f64>) -> NewTrack {
        track_with(path, &format!("file-of-{audio}"), audio, tag_bpm)
    }

    /// A file with whole-file fingerprint `fp` and `audio_fp` `audio`.
    fn track_with(path: &str, fp: &str, audio: &str, tag_bpm: Option<f64>) -> NewTrack {
        NewTrack {
            path: path.into(),
            artist: "A".into(),
            album: "B".into(),
            title: path.into(),
            size: 1,
            fingerprint: Some(fp.into()),
            audio_fp: Some(audio.into()),
            tag_bpm,
            tag_key: tag_bpm.map(|_| "Fm".to_owned()),
            ..NewTrack::default()
        }
    }

    fn signature(path: &str, version: &str) -> RemoteSignature {
        RemoteSignature {
            path: path.to_owned(),
            size: 10,
            version: version.to_owned(),
            signature: format!("sig-{path}-{version}"),
        }
    }

    #[test]
    fn remote_signatures_are_replaced_per_destination_and_go_with_it() {
        let mut conn = open(Path::new(":memory:")).expect("db");
        let target = |machine: &str| NewTarget {
            tailnet: "t".to_owned(),
            machine: machine.to_owned(),
            path: vec!["share".to_owned()],
        };
        let one = add_target(&conn, &target("one")).expect("target");
        let two = add_target(&conn, &target("two")).expect("target");
        replace_remote_signatures(&mut conn, one, &[signature("a", "1"), signature("b", "1")])
            .expect("store");
        replace_remote_signatures(&mut conn, two, &[signature("a", "9")]).expect("store");
        replace_remote_signatures(&mut conn, one, &[signature("a", "2")]).expect("replace");

        let kept = remote_signatures(&conn, one).expect("read");
        assert_eq!(kept.len(), 1);
        assert_eq!(kept.get("a"), Some(&signature("a", "2")));
        assert_eq!(
            remote_signatures(&conn, two).expect("read").get("a"),
            Some(&signature("a", "9"))
        );

        remove_target(&conn, one).expect("remove");
        assert!(remote_signatures(&conn, one).expect("read").is_empty());
    }

    #[test]
    fn analyzed_flag_tracks_the_current_analysis_version() {
        assert!(TRACK_COLS.contains(&format!(">= {}", crate::analysis::VERSION)));
    }

    #[test]
    fn cues_are_kept_by_audio_and_follow_a_tag_edit() {
        let mut conn = open(Path::new(":memory:")).expect("db");
        upsert(&mut conn, &[track("/a.mp3", "x", None)]).expect("upsert");
        assert_eq!(cues_of(&conn, "x").expect("none"), None, "never set");
        let hot = Cue {
            slot: Some(0),
            start: 32.5,
            name: " Drop ".into(),
            color: "#28e214".into(),
            main: false,
        };
        let memory = Cue {
            slot: None,
            start: 1.0,
            name: String::new(),
            color: String::new(),
            main: true,
        };
        set_cues(&mut conn, 1, &[memory.clone(), hot.clone()]).expect("set");
        let kept = cues_of(&conn, "x").expect("cues").expect("set");
        assert_eq!(kept[0].name, "Drop", "hot cues first, names trimmed");
        assert_eq!(kept[1], memory);

        // A tag write changes the fingerprint but not the audio; the cues stay.
        upsert(&mut conn, &[track_with("/a.mp3", "f2", "x", None)]).expect("upsert");
        assert_eq!(cues_of(&conn, "x").expect("cues").map(|c| c.len()), Some(2));

        set_cues(&mut conn, 1, &[]).expect("clear");
        assert_eq!(
            cues_of(&conn, "x").expect("cues"),
            Some(Vec::new()),
            "cleared, not unset"
        );
    }

    #[test]
    fn saved_rules_with_tag_names_become_uids_and_keep_working() {
        let mut conn = open(Path::new(":memory:")).expect("db");
        upsert(&mut conn, &[track("/a.mp3", "fp-a", None)]).expect("upsert");
        let id: i64 = conn
            .query_row("SELECT id FROM tracks", [], |r| r.get(0))
            .expect("id");
        tag_tracks(&mut conn, "Genre/House", &[id]).expect("tag");
        conn.execute(
            "INSERT INTO smart_playlists (name, rules, uid) VALUES ('Old', ?1, 'u')",
            params![r#"{"allTags":["genre/house"],"anyTags":["Ghost"],"noneTags":[]}"#],
        )
        .expect("legacy row");
        convert_smart_rules(&conn).expect("convert");
        let stored: String = conn
            .query_row("SELECT rules FROM smart_playlists", [], |r| r.get(0))
            .expect("rules");
        let parsed: crate::smart::Rules = serde_json::from_str(&stored).expect("json");
        assert!(crate::smart::is_uid(&parsed.all_tags[0]), "{stored}");
        assert_eq!(
            parsed.any_tags,
            ["Ghost"],
            "a name that is no tag stays as it was"
        );
        let shown = smart_playlists(&conn).expect("list").remove(0);
        assert_eq!(shown.rules.all_tags, ["Genre/House"]);
        // Converting again changes nothing.
        convert_smart_rules(&conn).expect("again");
        let again: String = conn
            .query_row("SELECT rules FROM smart_playlists", [], |r| r.get(0))
            .expect("rules");
        assert_eq!(again, stored);
    }

    fn kept(bpm: Option<f64>) -> crate::anlz::Stored {
        crate::anlz::Stored {
            grid_bpm: bpm,
            first_beat: 0.1,
            bar_offset: 0,
            duration: 2.0,
            detail: vec![0x5f; 300],
        }
    }

    #[test]
    fn audio_analysed_without_a_waveform_is_analysed_again() {
        let mut conn = open(Path::new(":memory:")).expect("db");
        upsert(&mut conn, &[track("/a.mp3", "x", None)]).expect("upsert");
        // BPM and key from before the waveform was kept in the database.
        conn.execute(
            "INSERT INTO analysis (audio_fp, bpm, version, analyzed_at) VALUES ('x', 120, ?1, 1)",
            params![crate::analysis::VERSION],
        )
        .expect("row");
        assert!(!list(&conn).expect("list")[0].analyzed);
        assert_eq!(analysis_jobs(&conn, None, false).expect("jobs").len(), 1);
        crate::anlz::save(&conn, "x", &kept(Some(120.0))).expect("save");
        assert!(list(&conn).expect("list")[0].analyzed);
        assert!(analysis_jobs(&conn, None, false).expect("jobs").is_empty());
    }

    #[test]
    fn analysis_survives_a_retag() {
        let mut conn = open(Path::new(":memory:")).expect("db");
        upsert(&mut conn, &[track_with("/a.mp3", "f1", "x", None)]).expect("upsert");
        let found = Ok((
            Analysis {
                bpm: Some(124.0),
                key: None,
            },
            kept(Some(124.0)),
        ));
        store_analysis(&conn, "x", &found, 1, false).expect("store");
        assert!(list(&conn).expect("list")[0].analyzed);
        // A retag: new whole-file fingerprint, same audio.
        upsert(&mut conn, &[track_with("/a.mp3", "f2", "x", None)]).expect("retag");
        assert_eq!(
            crate::anlz::load(&conn, "x").expect("kept").grid_bpm,
            Some(124.0)
        );
        assert!(list(&conn).expect("list")[0].analyzed, "still joins");
        assert!(analysis_jobs(&conn, None, false).expect("jobs").is_empty());
    }

    #[test]
    fn duplicates_are_present_tracks_with_the_same_audio() {
        let mut conn = open(Path::new(":memory:")).expect("db");
        upsert(
            &mut conn,
            &[
                track("/a.mp3", "x", None),
                track_with("/a copy.mp3", "other", "x", None),
                track("/b.mp3", "y", None),
                track_with("/gone.mp3", "g", "y", None),
                track_with("/c.mp3", "c1", "", None),
                track_with("/d.mp3", "d1", "", None),
            ],
        )
        .expect("upsert");
        mark_missing(&mut conn, &[4], 1).expect("missing");
        let groups = duplicate_groups(&conn).expect("groups");
        assert_eq!(
            groups.len(),
            1,
            "a missing copy and unreadable audio do not count"
        );
        assert_eq!(groups[0].audio_fp, "x");
        let paths: Vec<&str> = groups[0].tracks.iter().map(|t| t.path.as_str()).collect();
        assert_eq!(paths, ["/a copy.mp3", "/a.mp3"]);
    }

    #[test]
    fn playlists_list_one_entry_per_audio() {
        let mut conn = open(Path::new(":memory:")).expect("db");
        upsert(
            &mut conn,
            &[
                track("/a.mp3", "x", None),
                track_with("/a copy.mp3", "other", "x", None),
                track("/b.mp3", "y", None),
            ],
        )
        .expect("upsert");
        let pl = create_playlist(&conn, "P", None).expect("playlist");
        add_to_playlist(&mut conn, pl, &[2, 1, 3]).expect("add");
        let names: Vec<String> = playlist_tracks(&conn, pl)
            .expect("tracks")
            .into_iter()
            .map(|t| t.path)
            .collect();
        assert_eq!(names, ["/a copy.mp3", "/b.mp3"]);
        assert_eq!(list_playlists(&conn).expect("lists")[0].track_count, 2);
    }

    #[test]
    fn old_analysis_and_cues_are_rekeyed_through_their_tracks() {
        let dir = std::env::temp_dir().join(format!("manplay-rekey-{}", std::process::id()));
        std::fs::create_dir_all(&dir).expect("dir");
        let path = dir.join("library.db");
        {
            // A database from before `audio_fp` keyed the analysis.
            let conn = open(&path).expect("db");
            conn.execute_batch(
                "DROP TABLE analysis; DROP TABLE cues;
                 CREATE TABLE analysis (fingerprint TEXT PRIMARY KEY, bpm REAL, musical_key TEXT,
                     error TEXT, version INTEGER NOT NULL, analyzed_at INTEGER NOT NULL);
                 CREATE TABLE cues (id INTEGER PRIMARY KEY, fingerprint TEXT NOT NULL, slot INTEGER,
                     start REAL NOT NULL, name TEXT NOT NULL DEFAULT '', color TEXT NOT NULL DEFAULT '');
                 INSERT INTO analysis VALUES ('f-a', 120, 'Am', NULL, 3, 5), ('f-orphan', 90, NULL, NULL, 3, 5);
                 INSERT INTO cues (fingerprint, slot, start) VALUES ('f-a', 0, 1.5), ('f-orphan', 1, 2.0);",
            )
            .expect("old shape");
            let mut conn = conn;
            let mut a = track_with("/a.mp3", "f-a", "", None);
            a.audio_fp = None;
            upsert(&mut conn, &[a]).expect("upsert");
        }
        let mut conn = open(&path).expect("migrates");
        assert!(table_exists(&conn, "analysis_legacy").expect("legacy"));
        assert!(table_exists(&conn, "cues_legacy").expect("legacy"));
        // Not fingerprinted yet: nothing maps, the old rows wait.
        rekey_legacy(&mut conn).expect("rekey");
        assert!(table_exists(&conn, "analysis_legacy").expect("legacy"));
        assert_eq!(analysis_results(&conn, None).expect("results").len(), 0);

        set_audio_fps(&mut conn, &[(1, "audio-a".into())]).expect("fps");
        rekey_legacy(&mut conn).expect("rekey");
        let t = &list(&conn).expect("list")[0];
        assert_eq!(t.bpm, Some(120.0), "analysis follows the audio");
        let cues = cues_of(&conn, "audio-a").expect("cues");
        assert_eq!(
            cues, None,
            "cues_edited was never set before, so they stay unset"
        );
        let n: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM cues WHERE audio_fp = 'audio-a'",
                [],
                |r| r.get(0),
            )
            .expect("count");
        assert_eq!(n, 1, "the cue moved; the orphan's did not");
        let all: i64 = conn
            .query_row("SELECT COUNT(*) FROM analysis", [], |r| r.get(0))
            .expect("count");
        assert_eq!(all, 1, "the row without a track is dropped");
        assert!(!table_exists(&conn, "analysis_legacy").expect("gone"));
        assert!(!table_exists(&conn, "cues_legacy").expect("gone"));
        assert_eq!(
            get_setting(&conn, SETTING_AUDIO_FP_VERSION).expect("setting"),
            Some(crate::audioprint::VERSION.to_string())
        );
        drop(conn);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn hand_edits_survive_reanalysis_unless_replaced() {
        let mut conn = open(Path::new(":memory:")).expect("db");
        upsert(&mut conn, &[track("/a.mp3", "x", None)]).expect("upsert");
        // Typed before any analysis: kept in a row that still counts as not analysed.
        set_tempo_key(&conn, 1, Some(Some(126.0)), None).expect("edit");
        let jobs = analysis_jobs(&conn, None, false).expect("jobs");
        assert_eq!(jobs.len(), 1, "still analysed");
        let found = Ok((
            Analysis {
                bpm: Some(128.0),
                key: Some("Am".into()),
            },
            kept(Some(128.0)),
        ));
        store_analysis(&conn, "x", &found, 1, false).expect("store");
        let t = &list(&conn).expect("list")[0];
        assert_eq!((t.bpm, t.key.as_deref()), (Some(126.0), Some("Am")));
        assert_eq!(
            t.edited,
            Edited {
                bpm: true,
                key: false,
                grid: false
            }
        );

        let mut hand = kept(Some(126.0));
        hand.first_beat = 0.3;
        hand.detail = vec![1; 10];
        crate::anlz::save(&conn, "x", &hand).expect("grid");
        mark_grid_edited(&conn, 1).expect("grid");
        store_analysis(&conn, "x", &found, 2, false).expect("again");
        let now = crate::anlz::load(&conn, "x").expect("kept");
        assert_eq!(
            (now.grid_bpm, now.first_beat),
            (Some(126.0), 0.3),
            "hand grid stays"
        );
        assert_eq!(now.detail, kept(None).detail, "waveform is new");

        store_analysis(&conn, "x", &found, 2, true).expect("replace");
        let t = &list(&conn).expect("list")[0];
        assert_eq!(t.bpm, Some(128.0));
        assert_eq!(
            crate::anlz::load(&conn, "x").expect("kept").grid_bpm,
            Some(128.0)
        );
        assert_eq!(t.edited, Edited::default(), "replacing forgets the edits");
    }

    #[test]
    fn analysis_follows_content_and_falls_back_to_tags() {
        let mut conn = open(Path::new(":memory:")).expect("db");
        upsert(
            &mut conn,
            &[
                track("/a.mp3", "x", Some(120.0)),
                track("/copy-of-a.mp3", "x", None),
                track("/b.mp3", "y", Some(99.5)),
            ],
        )
        .expect("upsert");

        let jobs = analysis_jobs(&conn, None, false).expect("jobs");
        assert_eq!(jobs.len(), 2, "duplicates are analysed once");

        let found = Ok((
            Analysis {
                bpm: Some(128.0),
                key: Some("Am".into()),
            },
            kept(Some(128.0)),
        ));
        store_analysis(&conn, "x", &found, 1, false).expect("store");
        store_analysis(&conn, "y", &Err("bad file".into()), 1, false).expect("store");

        assert!(analysis_jobs(&conn, None, false).expect("jobs").is_empty());
        let by_id = analysis_jobs(&conn, Some(&[1]), true).expect("forced");
        assert_eq!(by_id.len(), 1);
        assert_eq!(by_id[0].path, "/a.mp3");

        let tracks = list(&conn).expect("list");
        let get = |p: &str| tracks.iter().find(|t| t.path == p).expect("track");
        assert_eq!(get("/a.mp3").bpm, Some(128.0), "detection beats the tag");
        assert_eq!(get("/copy-of-a.mp3").key.as_deref(), Some("Am"));
        assert!(get("/copy-of-a.mp3").analyzed);
        assert_eq!(
            get("/b.mp3").bpm,
            Some(99.5),
            "failed detection keeps the tag"
        );
        assert_eq!(get("/b.mp3").key.as_deref(), Some("Fm"));

        assert_eq!(analysis_results(&conn, None).expect("results").len(), 2);
        assert_eq!(
            analysis_failures(&conn).expect("failures")[0].path,
            "/b.mp3"
        );

        // Tags written into /a.mp3 changed its size and so its fingerprint, not its audio.
        upsert(&mut conn, &[track_with("/a.mp3", "x2", "x", Some(128.0))]).expect("rescan");
        let tracks = list(&conn).expect("list");
        let a = tracks.iter().find(|t| t.path == "/a.mp3").expect("a");
        assert!(a.analyzed, "analysis stays with the audio");
        assert_eq!(a.key.as_deref(), Some("Am"));
    }

    #[test]
    fn old_rekordbox_choice_becomes_the_list_of_exported_playlists() {
        let conn = open(Path::new(":memory:")).expect("db");
        let a = create_playlist(&conn, "A", None).expect("a");
        let b = create_playlist(&conn, "B", None).expect("b");
        let c = create_playlist(&conn, "C", None).expect("c");
        assert_eq!(export_selection(&conn, RB_DESTINATION).expect("none"), None);
        set_setting(
            &conn,
            LEGACY_RB_SELECTION,
            Some(&format!(
                r#"{{"excludedPlaylists":[{b}],"tags":["Genre/House"]}}"#
            )),
        )
        .expect("legacy");
        migrate_rekordbox_selection(&conn).expect("migrate");
        assert_eq!(
            export_selection(&conn, RB_DESTINATION).expect("row"),
            Some(ExportSelection {
                playlists: vec![a, c],
                tags: vec!["Genre/House".to_owned()],
                ..ExportSelection::default()
            })
        );
        assert_eq!(get_setting(&conn, LEGACY_RB_SELECTION).expect("gone"), None);

        let smart = save_smart_playlist(
            &conn,
            &crate::smart::SmartPlaylist {
                id: 0,
                name: "S".into(),
                rules: crate::smart::Rules::default(),
            },
        )
        .expect("smart")
        .id;
        let usb = ExportSelection {
            playlists: vec![b],
            tags: vec![],
            smart: vec![smart],
            usb_mode: crate::usb_export::Mode::ReplaceAll,
            usb_serato: true,
        };
        set_export_selection(&conn, "usb:1234", &usb).expect("save");
        set_export_selection(&conn, "usb:1234", &usb).expect("overwrite");
        assert_eq!(export_selection(&conn, "usb:1234").expect("row"), Some(usb));
    }

    #[test]
    fn sent_playlists_keep_who_they_were_made_for() {
        use crate::jellyfin::{PlaylistId, Visibility, push::PlaylistKey};
        let conn = open(Path::new(":memory:")).expect("db");
        let target = add_target(
            &conn,
            &NewTarget {
                tailnet: "t".to_owned(),
                machine: "nas".to_owned(),
                path: vec!["share".to_owned()],
            },
        )
        .expect("target");
        let key = PlaylistKey("playlist:u1".to_owned());
        let p1 = PlaylistId("p1".to_owned());
        let p2 = PlaylistId("p2".to_owned());
        // (step, playlist, made visible to, then recorded)
        let steps = [
            (
                "made",
                &p1,
                Some(Visibility::Everyone),
                Some(Visibility::Everyone),
            ),
            ("filled again", &p1, None, Some(Visibility::Everyone)),
            (
                "made again",
                &p2,
                Some(Visibility::OnlyMe),
                Some(Visibility::OnlyMe),
            ),
            ("another one taken over", &p1, None, None),
        ];
        for (step, id, made, recorded) in steps {
            set_jellyfin_known(&conn, target, &key, id, made.as_ref()).expect("save");
            let sent = jellyfin_known(&conn, target).expect("read");
            assert_eq!(&sent[&key].id, id, "{step}");
            assert_eq!(sent[&key].visibility, recorded, "{step}");
        }
    }

    #[test]
    fn jellyfin_settings_round_trip_and_go_with_their_destination() {
        use crate::jellyfin::{LibraryId, LibraryRef, ServerUrl, Settings, User, UserId};
        let conn = open(Path::new(":memory:")).expect("db");
        let target = add_target(
            &conn,
            &NewTarget {
                tailnet: "t".to_owned(),
                machine: "nas".to_owned(),
                path: vec!["share".to_owned()],
            },
        )
        .expect("target");
        assert_eq!(jellyfin_settings(&conn, target).expect("read"), None);
        let mut settings = Settings {
            url: ServerUrl::parse("nas:8096").expect("url"),
            server_name: "nas".to_owned(),
            user: User {
                id: UserId("u1".to_owned()),
                name: "mario".to_owned(),
            },
            library: LibraryRef {
                id: LibraryId("l1".to_owned()),
                name: "Music".to_owned(),
            },
            visibility: crate::jellyfin::Visibility::Users {
                users: vec![UserId("u2".to_owned())],
            },
        };
        save_jellyfin(&conn, target, &settings).expect("save");
        assert_eq!(
            jellyfin_settings(&conn, target).expect("read"),
            Some(settings.clone())
        );
        settings.library.name = "Sets".to_owned();
        save_jellyfin(&conn, target, &settings).expect("overwrite");
        assert_eq!(
            jellyfin_settings(&conn, target).expect("read"),
            Some(settings)
        );
        remove_target(&conn, target).expect("remove");
        assert_eq!(jellyfin_settings(&conn, target).expect("read"), None);
    }
}
