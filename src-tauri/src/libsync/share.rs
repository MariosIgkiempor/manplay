//! Moving an item between shared, local and hidden: the context-menu actions Share, Make private
//! and Hide, and the dialog about smart playlists that use local tags.

use std::collections::{BTreeMap, BTreeSet};

use rusqlite::{Connection, OptionalExtension, params};
use serde::{Deserialize, Serialize};

use super::apply::{self, Kind, PLAYLISTS, TAGS};
use super::frac;
use super::ops::{F_POS, F_PRESENT};
use super::state;
use super::write::{Batch, new_uid};
use crate::db;
use crate::error::Error;

/// The row an action is about.
struct Item {
    id: i64,
    uid: String,
    name: String,
    scope: String,
}

fn kind_of(label: &str) -> Result<Kind, Error> {
    Kind::from_label(label).ok_or_else(|| Error::Msg(format!("Unknown kind of item: {label}.")))
}

fn item(conn: &Connection, kind: Kind, id: i64) -> Result<Item, Error> {
    conn.query_row(
        &format!(
            "SELECT id, uid, name, scope FROM {} WHERE id = ?1",
            kind.table
        ),
        params![id],
        |r| {
            Ok(Item {
                id: r.get(0)?,
                uid: r.get(1)?,
                name: r.get(2)?,
                scope: r.get(3)?,
            })
        },
    )
    .optional()?
    .ok_or_else(|| Error::Msg("That item no longer exists.".into()))
}

/// A local tag that a smart playlist's rules use.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LocalTagUse {
    /// Row id of the tag, to share it.
    pub id: i64,
    pub tag: String,
    pub songs: i64,
}

/// What sharing an item would send, for the confirmation.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SharePreview {
    pub name: String,
    /// Songs whose membership becomes visible to everyone (tags and playlists).
    pub songs: i64,
    /// Local tags the rules of a smart playlist use: each must be shared or dropped from the rules.
    pub local_tags: Vec<LocalTagUse>,
}

/// What a smart playlist's rules do with one local tag.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum TagChoice {
    /// Share the tag along with the playlist.
    Share,
    /// Take the tag out of the rules.
    Remove,
}

/// The songs (by audio) in an item, in order; for playlists with the key they sit at.
pub fn local_members(
    conn: &Connection,
    kind: Kind,
    row: i64,
) -> Result<Vec<(String, Option<String>)>, Error> {
    let mut out: Vec<(String, Option<String>)> = Vec::new();
    if kind.table == "tags" {
        let mut stmt = conn.prepare(
            "SELECT DISTINCT t.audio_fp FROM track_tags tt JOIN tracks t ON t.id = tt.track_id
             WHERE tt.tag_id = ?1 AND t.audio_fp <> '' ORDER BY t.audio_fp",
        )?;
        for fp in stmt.query_map(params![row], |r| r.get::<_, String>(0))? {
            out.push((fp?, None));
        }
    } else if kind.table == "playlists" {
        let mut stmt = conn.prepare(
            "SELECT t.audio_fp, pt.pos FROM playlist_tracks pt JOIN tracks t ON t.id = pt.track_id
             WHERE pt.playlist_id = ?1 AND t.audio_fp <> '' ORDER BY pt.position",
        )?;
        let rows = stmt.query_map(params![row], |r| Ok((r.get(0)?, r.get(1)?)))?;
        for r in rows {
            let (fp, pos): (String, Option<String>) = r?;
            if !out.iter().any(|(f, _)| *f == fp) {
                out.push((fp, pos));
            }
        }
    }
    Ok(out)
}

/// The songs a shared item has according to the registers, so also songs this library lacks.
pub fn shared_members(
    conn: &Connection,
    kind: Kind,
    uid: &str,
) -> Result<Vec<(String, Option<String>)>, Error> {
    if kind.member_entity.is_empty() {
        return Ok(Vec::new());
    }
    let mut stmt = conn.prepare(
        "SELECT id FROM op_state WHERE e = ?1 AND f = ?2 AND val = 'true' AND id >= ?3 AND id < ?4",
    )?;
    let ids: Vec<String> = stmt
        .query_map(
            params![
                kind.member_entity,
                F_PRESENT,
                format!("{uid}/"),
                format!("{uid}0")
            ],
            |r| r.get(0),
        )?
        .collect::<Result<_, _>>()?;
    let mut out: Vec<(String, Option<String>)> = Vec::new();
    for id in ids {
        if let Some((_, fp)) = id.split_once('/') {
            out.push((
                fp.to_owned(),
                state::get_str(conn, kind.member_entity, &id, F_POS)?,
            ));
        }
    }
    out.sort_by(|a, b| a.1.cmp(&b.1).then_with(|| a.0.cmp(&b.0)));
    Ok(out)
}

/// Position keys for `n` songs added after everything an item has now.
pub fn keys_after(conn: &Connection, uid: &str, n: usize) -> Result<Vec<String>, Error> {
    let last = shared_members(conn, PLAYLISTS, uid)?
        .into_iter()
        .filter_map(|(_, pos)| pos)
        .max();
    Ok(frac::spread(last.as_deref(), None, n))
}

/// Ops that make a local item shared: its name and every song in it.
fn publish(conn: &Connection, kind: Kind, it: &Item, ops: &mut Batch) -> Result<(), Error> {
    match kind.table {
        "tags" => {
            ops.tag(&it.uid, &it.name);
            for (fp, _) in local_members(conn, kind, it.id)? {
                ops.track_tag(&it.uid, &fp, true);
            }
        }
        "playlists" => {
            ops.playlist(&it.uid, &it.name);
            let members = local_members(conn, kind, it.id)?;
            let missing = members.iter().filter(|(_, p)| p.is_none()).count();
            let mut fresh = frac::spread(None, None, missing).into_iter();
            for (fp, pos) in members {
                let pos = pos
                    .or_else(|| fresh.next())
                    .unwrap_or_else(|| frac::between(None, None));
                ops.playlist_add(&it.uid, &fp, &pos);
            }
        }
        _ => {}
    }
    Ok(())
}

/// The local tags (rows) a stored rule set uses.
fn local_tags_in(
    conn: &Connection,
    rules: &crate::smart::Rules,
) -> Result<Vec<(i64, String, String)>, Error> {
    let mut seen = BTreeSet::new();
    let mut out = Vec::new();
    for uid in rules
        .all_tags
        .iter()
        .chain(&rules.any_tags)
        .chain(&rules.none_tags)
    {
        if !crate::smart::is_uid(uid) || !seen.insert(uid.clone()) {
            continue;
        }
        let row: Option<(i64, String)> = conn
            .query_row(
                "SELECT id, name FROM tags WHERE uid = ?1 AND scope = 'local'",
                params![uid],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .optional()?;
        if let Some((id, name)) = row {
            out.push((id, name, uid.clone()));
        }
    }
    Ok(out)
}

/// Refuses rules that use local tags, for a smart playlist that is (or is becoming) shared: other
/// devices cannot know those tags.
pub fn refuse_local_tags(conn: &Connection, rules: &crate::smart::Rules) -> Result<(), Error> {
    let local = local_tags_in(conn, rules)?;
    if local.is_empty() {
        return Ok(());
    }
    let names: Vec<String> = local.iter().map(|(_, n, _)| format!("“{n}”")).collect();
    Err(Error::Msg(format!(
        "A shared smart playlist cannot use local tags ({}). Share the tags or take them out of the rules.",
        names.join(", ")
    )))
}

/// The local tags (by name) in rules as the editor sees them, for the dialog shown before a
/// smart playlist is shared or saved as shared.
pub fn local_tags_of_editor_rules(
    conn: &Connection,
    rules: &crate::smart::Rules,
) -> Result<Vec<LocalTagUse>, Error> {
    let stored = db::rules_to_stored(conn, rules)?;
    let mut out = Vec::new();
    for (id, name, _) in local_tags_in(conn, &stored)? {
        out.push(LocalTagUse {
            id,
            songs: song_count(conn, TAGS, id)?,
            tag: name,
        });
    }
    Ok(out)
}

fn stored_rules(conn: &Connection, id: i64) -> Result<crate::smart::Rules, Error> {
    let raw: String = conn.query_row(
        "SELECT rules FROM smart_playlists WHERE id = ?1",
        params![id],
        |r| r.get(0),
    )?;
    Ok(serde_json::from_str(&raw).unwrap_or_default())
}

fn song_count(conn: &Connection, kind: Kind, row: i64) -> Result<i64, Error> {
    Ok(local_members(conn, kind, row)?
        .len()
        .try_into()
        .unwrap_or(i64::MAX))
}

/// What sharing the item would send: nothing leaves this device before the user has seen it.
pub fn share_preview(conn: &Connection, kind: &str, id: i64) -> Result<SharePreview, Error> {
    let kind = kind_of(kind)?;
    let it = item(conn, kind, id)?;
    let mut local_tags = Vec::new();
    let mut songs = song_count(conn, kind, id)?;
    if kind.table == "smart_playlists" {
        for (tag_id, name, _) in local_tags_in(conn, &stored_rules(conn, id)?)? {
            local_tags.push(LocalTagUse {
                id: tag_id,
                songs: song_count(conn, TAGS, tag_id)?,
                tag: name,
            });
        }
        songs = 0;
    }
    Ok(SharePreview {
        name: it.name,
        songs,
        local_tags,
    })
}

/// Makes a local item shared: its scope changes and create ops go out for it and its songs. For a
/// smart playlist, every local tag in its rules needs a choice in `tags` (by tag name).
pub fn share(
    conn: &Connection,
    kind: &str,
    id: i64,
    tags: &BTreeMap<String, TagChoice>,
) -> Result<(), Error> {
    let kind = kind_of(kind)?;
    let tx = conn.unchecked_transaction()?;
    let it = item(&tx, kind, id)?;
    if it.scope == "shared" {
        return Ok(());
    }
    let mut ops = Batch::new(&tx)?;
    if kind.table == "smart_playlists" {
        let mut rules = stored_rules(&tx, id)?;
        for (tag_id, name, uid) in local_tags_in(&tx, &rules)? {
            match tags.get(&name) {
                Some(TagChoice::Share) => share_row(&tx, TAGS, tag_id, &mut ops)?,
                Some(TagChoice::Remove) => rules = rules.without_tag(&uid),
                None => {
                    return Err(Error::Msg(format!(
                        "Choose what to do with the local tag “{name}” first."
                    )));
                }
            }
        }
        let value = db::rules_json(&rules)?;
        tx.execute(
            "UPDATE smart_playlists SET rules = ?2, scope = 'shared' WHERE id = ?1",
            params![id, value.to_string()],
        )?;
        ops.smart_playlist(&it.uid, &it.name, &value);
    } else {
        share_row(&tx, kind, id, &mut ops)?;
    }
    ops.commit(&tx)?;
    let mut touched = BTreeSet::new();
    apply::settle(&tx, &mut touched)?;
    tx.commit()?;
    Ok(())
}

fn share_row(conn: &Connection, kind: Kind, id: i64, ops: &mut Batch) -> Result<(), Error> {
    let it = item(conn, kind, id)?;
    if it.scope == "shared" {
        return Ok(());
    }
    conn.execute(
        &format!("UPDATE {} SET scope = 'shared' WHERE id = ?1", kind.table),
        params![id],
    )?;
    publish(conn, kind, &it, ops)
}

/// What making an item private takes away from others.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PrivatePreview {
    pub name: String,
    /// Names of shared smart playlists whose rules use this tag.
    pub used_by: Vec<String>,
}

fn shared_smarts_using(conn: &Connection, uid: &str) -> Result<Vec<(i64, String, String)>, Error> {
    let rows: Vec<(i64, String, String, String)> = conn
        .prepare(
            "SELECT id, uid, name, rules FROM smart_playlists
             WHERE scope = 'shared' AND instr(rules, ?1) > 0 ORDER BY name",
        )?
        .query_map(params![uid], |r| {
            Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?))
        })?
        .collect::<Result<_, _>>()?;
    Ok(rows
        .into_iter()
        .filter(|(_, _, _, rules)| {
            serde_json::from_str::<crate::smart::Rules>(rules)
                .unwrap_or_default()
                .uses_tag(uid)
        })
        .map(|(id, uid, name, _)| (id, uid, name))
        .collect())
}

pub fn private_preview(conn: &Connection, kind: &str, id: i64) -> Result<PrivatePreview, Error> {
    let kind = kind_of(kind)?;
    let it = item(conn, kind, id)?;
    let used_by = if kind.table == "tags" {
        shared_smarts_using(conn, &it.uid)?
            .into_iter()
            .map(|(_, _, name)| name)
            .collect()
    } else {
        Vec::new()
    };
    Ok(PrivatePreview {
        name: it.name,
        used_by,
    })
}

/// Makes a shared item private: everyone else loses it (a `_delete`), and this device keeps a
/// local copy under a new uid with the same songs. A tag that shared smart playlists use needs
/// `remove_rules` (the tag leaves their rules) or the call is refused.
pub fn make_private(
    conn: &Connection,
    kind: &str,
    id: i64,
    remove_rules: bool,
) -> Result<(), Error> {
    let kind = kind_of(kind)?;
    let tx = conn.unchecked_transaction()?;
    let it = item(&tx, kind, id)?;
    if it.scope != "shared" {
        return Ok(());
    }
    let mut ops = Batch::new(&tx)?;
    if kind.table == "tags" {
        let users = shared_smarts_using(&tx, &it.uid)?;
        if !users.is_empty() && !remove_rules {
            let names: Vec<String> = users.iter().map(|(_, _, n)| format!("“{n}”")).collect();
            return Err(Error::Msg(format!(
                "Shared smart playlists use “{}”: {}. Remove the rule or keep the tag shared.",
                it.name,
                names.join(", ")
            )));
        }
        for (sid, suid, _) in users {
            let rules = stored_rules(&tx, sid)?.without_tag(&it.uid);
            let value = db::rules_json(&rules)?;
            tx.execute(
                "UPDATE smart_playlists SET rules = ?2 WHERE id = ?1",
                params![sid, value.to_string()],
            )?;
            ops.smart_playlist_rules(&suid, &value);
        }
    }
    match kind.table {
        "tags" => ops.tag_deleted(&it.uid),
        "playlists" => ops.playlist_deleted(&it.uid),
        _ => ops.smart_playlist_deleted(&it.uid),
    }
    let fresh = new_uid();
    tx.execute(
        &format!(
            "UPDATE {} SET uid = ?2, scope = 'local' WHERE id = ?1",
            kind.table
        ),
        params![it.id, fresh],
    )?;
    tx.execute(
        "UPDATE clashes SET keeps = ?3 WHERE kind = ?1 AND keeps = ?2",
        params![kind.label(), it.uid, fresh],
    )?;
    tx.execute(
        "DELETE FROM clashes WHERE kind = ?1 AND held = ?2",
        params![kind.label(), it.uid],
    )?;
    if kind.table == "tags" {
        super::entities::repoint_rules(&tx, &it.uid, &fresh)?;
    }
    ops.commit(&tx)?;
    let mut touched = BTreeSet::new();
    apply::settle(&tx, &mut touched)?;
    tx.commit()?;
    Ok(())
}

/// Hides an item on this device (or shows it again). Others keep it.
pub fn set_hidden(conn: &Connection, kind: &str, id: i64, hidden: bool) -> Result<(), Error> {
    let kind = kind_of(kind)?;
    conn.execute(
        &format!("UPDATE {} SET hidden = ?2 WHERE id = ?1", kind.table),
        params![id, hidden],
    )?;
    Ok(())
}
