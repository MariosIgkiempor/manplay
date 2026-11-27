//! Two items of one kind with the same name: one of them yours (or both shared by different
//! devices). The name stays with one, the other is shown under a held name until the user
//! combines them or renames one. Detected when ops are applied (`apply::materialize_item`).

use std::collections::BTreeSet;

use rusqlite::{Connection, OptionalExtension, params};
use serde::{Deserialize, Serialize};

use super::apply::{self, Kind, Row, find};
use super::ops::F_NAME;
use super::share::{keys_after, local_members, shared_members};
use super::state;
use super::write::{Batch, active};
use crate::db;
use crate::error::Error;

/// After a local edit that may have freed a name: a held item whose name is free takes it.
pub fn refresh(conn: &Connection) -> Result<(), Error> {
    if count(conn)? == 0 {
        return Ok(());
    }
    let mut touched = BTreeSet::new();
    apply::settle(conn, &mut touched)?;
    for id in touched {
        apply::renumber(conn, id)?;
    }
    Ok(())
}

/// How many clashes wait for the user.
pub fn count(conn: &Connection) -> Result<i64, Error> {
    Ok(conn.query_row("SELECT COUNT(*) FROM clashes", [], |r| r.get(0))?)
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ClashSide {
    pub uid: String,
    /// Row id in the library, to open or rename it.
    pub id: i64,
    /// `local` (only here) or `shared`.
    pub scope: String,
    /// The name it shows under now.
    pub name: String,
    /// Songs in it (tags and playlists).
    pub songs: i64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Clash {
    pub id: i64,
    /// `tag`, `playlist` or `smart_playlist`.
    pub kind: String,
    /// The name both want.
    pub name: String,
    /// The one that has the name.
    pub keeps: ClashSide,
    /// The one shown under a held name.
    pub held: ClashSide,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum Choice {
    Combine,
    RenameKeeps,
    RenameHeld,
}

/// What combining sends and removes, for the confirmation.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CombinePreview {
    /// A local item is being folded into a shared one: its songs become visible to everyone.
    pub shares_local: bool,
    pub songs: i64,
    pub name: String,
}

struct Loaded {
    kind: Kind,
    name: String,
    keeps: Row,
    held: Row,
}

fn load(conn: &Connection, id: i64) -> Result<Loaded, Error> {
    let found: Option<(String, String, String, String)> = conn
        .query_row(
            "SELECT kind, name, keeps, held FROM clashes WHERE id = ?1",
            params![id],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)),
        )
        .optional()?;
    let gone = || Error::Msg("That clash is already settled.".into());
    let (kind, name, keeps, held) = found.ok_or_else(gone)?;
    let kind = Kind::from_label(&kind).ok_or_else(gone)?;
    let keeps = find(conn, kind, "uid", &keeps)?.ok_or_else(gone)?;
    let held = find(conn, kind, "uid", &held)?.ok_or_else(gone)?;
    Ok(Loaded {
        kind,
        name,
        keeps,
        held,
    })
}

fn side(conn: &Connection, kind: Kind, row: &Row) -> Result<ClashSide, Error> {
    let songs = if kind.table == "smart_playlists" {
        0
    } else {
        i64::try_from(local_members(conn, kind, row.id)?.len()).unwrap_or(i64::MAX)
    };
    Ok(ClashSide {
        uid: row.uid.clone(),
        id: row.id,
        scope: row.scope.clone(),
        name: row.name.clone(),
        songs,
    })
}

/// Every clash waiting, tags first.
pub fn list(conn: &Connection) -> Result<Vec<Clash>, Error> {
    let ids: Vec<i64> = conn
        .prepare("SELECT id FROM clashes ORDER BY kind DESC, name COLLATE NOCASE, id")?
        .query_map([], |r| r.get(0))?
        .collect::<Result<_, _>>()?;
    let mut out = Vec::new();
    for id in ids {
        let Ok(c) = load(conn, id) else {
            continue;
        };
        out.push(Clash {
            id,
            kind: c.kind.label().to_owned(),
            name: c.name.clone(),
            keeps: side(conn, c.kind, &c.keeps)?,
            held: side(conn, c.kind, &c.held)?,
        });
    }
    Ok(out)
}

pub fn combine_preview(conn: &Connection, id: i64) -> Result<CombinePreview, Error> {
    let c = load(conn, id)?;
    let local = [&c.keeps, &c.held].into_iter().find(|r| r.scope == "local");
    Ok(CombinePreview {
        shares_local: local.is_some(),
        songs: match local {
            Some(r) if c.kind.table != "smart_playlists" => {
                i64::try_from(local_members(conn, c.kind, r.id)?.len()).unwrap_or(i64::MAX)
            }
            _ => 0,
        },
        name: c.name,
    })
}

/// Settles a clash. `new_name` is for the two renames.
pub fn resolve(
    conn: &Connection,
    id: i64,
    choice: Choice,
    new_name: Option<&str>,
) -> Result<(), Error> {
    let tx = conn.unchecked_transaction()?;
    let c = load(&tx, id)?;
    match choice {
        Choice::Combine => combine(&tx, &c)?,
        Choice::RenameKeeps => rename(&tx, &c, &c.keeps, new_name)?,
        Choice::RenameHeld => rename(&tx, &c, &c.held, new_name)?,
    }
    let mut touched = BTreeSet::new();
    apply::settle(&tx, &mut touched)?;
    for p in touched {
        apply::renumber(&tx, p)?;
    }
    tx.commit()?;
    Ok(())
}

fn need_sharing(conn: &Connection) -> Result<(), Error> {
    if active(conn)? {
        Ok(())
    } else {
        Err(Error::Msg(
            "Library data is not being shared, so there is nothing to settle with.".into(),
        ))
    }
}

fn combine(conn: &Connection, c: &Loaded) -> Result<(), Error> {
    need_sharing(conn)?;
    match (c.keeps.scope.as_str(), c.held.scope.as_str()) {
        ("local", "shared") => fold_local(conn, c.kind, &c.keeps, &c.held)?,
        ("shared", "shared") => merge_shared(conn, c.kind, &c.held, &c.keeps)?,
        _ => return Err(Error::Msg("Those two cannot be combined.".into())),
    }
    // The clash entry goes when `settle` lets the held item take the name (or it is merged away).
    Ok(())
}

/// Writes ops adding `songs` (audio, key) of one item to `target`, skipping songs it already has.
/// Playlist songs go after everything already there, in their order.
fn add_songs(
    conn: &Connection,
    kind: Kind,
    target: &str,
    songs: &[(String, Option<String>)],
    ops: &mut Batch,
) -> Result<(), Error> {
    let have: BTreeSet<String> = shared_members(conn, kind, target)?
        .into_iter()
        .map(|(fp, _)| fp)
        .collect();
    let fresh: Vec<&(String, Option<String>)> =
        songs.iter().filter(|(fp, _)| !have.contains(fp)).collect();
    if kind.table == "tags" {
        for (fp, _) in fresh {
            ops.track_tag(target, fp, true);
        }
    } else if kind.table == "playlists" {
        let keys = keys_after(conn, target, fresh.len())?;
        for ((fp, _), key) in fresh.into_iter().zip(keys) {
            ops.playlist_add(target, fp, &key);
        }
    }
    Ok(())
}

/// A local item becomes part of a shared one: its songs are shared on it, its row goes, and
/// smart playlists that used it use the shared one.
fn fold_local(conn: &Connection, kind: Kind, local: &Row, into: &Row) -> Result<(), Error> {
    let mut ops = Batch::new(conn)?;
    let songs = local_members(conn, kind, local.id)?;
    add_songs(conn, kind, &into.uid, &songs, &mut ops)?;
    if kind.table == "tags" {
        db::repoint_smart_rules(conn, &local.uid, &into.uid, &mut ops)?;
    }
    ops.commit(conn)?;
    conn.execute(
        &format!("DELETE FROM {} WHERE id = ?1", kind.table),
        params![local.id],
    )?;
    conn.execute(
        "UPDATE clashes SET keeps = ?3 WHERE kind = ?1 AND keeps = ?2",
        params![kind.label(), local.uid, into.uid],
    )?;
    let mut touched = BTreeSet::new();
    if kind.table != "smart_playlists" {
        for (fp, _) in &songs {
            apply::materialize_member(conn, kind, &into.uid, fp, &mut touched)?;
        }
    }
    for p in touched {
        apply::renumber(conn, p)?;
    }
    Ok(())
}

/// Two shared items become one: every song of `from` is added to `into`, `from` is merged into
/// it (every device repoints memberships and smart playlist rules), and the row goes.
fn merge_shared(conn: &Connection, kind: Kind, from: &Row, into: &Row) -> Result<(), Error> {
    let mut ops = Batch::new(conn)?;
    let songs = shared_members(conn, kind, &from.uid)?;
    add_songs(conn, kind, &into.uid, &songs, &mut ops)?;
    match kind.table {
        "tags" => {
            ops.tag_merged(&from.uid, &into.uid);
            db::repoint_smart_rules(conn, &from.uid, &into.uid, &mut ops)?;
        }
        "playlists" => ops.playlist_merged(&from.uid, &into.uid),
        _ => ops.smart_playlist_merged(&from.uid, &into.uid),
    }
    ops.commit(conn)?;
    let mut touched = BTreeSet::new();
    apply::merged(conn, kind, &from.uid, &mut touched)?;
    for p in touched {
        apply::renumber(conn, p)?;
    }
    Ok(())
}

/// Renames one side of a clash. Tags carry the levels below them: renaming `House` also renames
/// `House/Deep` of the same side. A shared item gets a name op (everyone gets the new name); a
/// local one is renamed here only.
fn rename(conn: &Connection, c: &Loaded, row: &Row, new_name: Option<&str>) -> Result<(), Error> {
    let raw = new_name.unwrap_or_default().trim();
    let new = if c.kind.table == "tags" {
        db::normalize_tag(raw)
    } else {
        raw.to_owned()
    };
    if new.is_empty() {
        return Err(Error::Msg("Type a new name.".into()));
    }
    if new.eq_ignore_ascii_case(&c.name) {
        return Err(Error::Msg("Pick a name that is different.".into()));
    }
    let shared = row.scope == "shared";
    if shared {
        need_sharing(conn)?;
    }
    // (row, uid, real name) of everything that moves.
    let mut moving: Vec<(i64, String, String)> = vec![(row.id, row.uid.clone(), c.name.clone())];
    if c.kind.table == "tags" {
        let prefix = format!("{}/", c.name.to_lowercase());
        let mut stmt = conn.prepare(
            "SELECT id, COALESCE(uid, ''), name FROM tags WHERE scope = ?1 AND id <> ?2",
        )?;
        let others: Vec<(i64, String, String)> = stmt
            .query_map(params![row.scope, row.id], |r| {
                Ok((r.get(0)?, r.get(1)?, r.get(2)?))
            })?
            .collect::<Result<_, _>>()?;
        for (id, uid, name) in others {
            let real = if shared {
                state::get_str(conn, "tag", &uid, F_NAME)?.unwrap_or(name)
            } else {
                name
            };
            if real.to_lowercase().starts_with(&prefix) {
                moving.push((id, uid, real));
            }
        }
    }
    let mut ops = Batch::new(conn)?;
    let mut shared_uids = Vec::new();
    for (id, uid, real) in &moving {
        let target = format!("{new}{}", &real[c.name.len()..]);
        if conn
            .query_row(
                &format!(
                    "SELECT 1 FROM {} WHERE name = ?1 AND id <> ?2 AND scope = 'local'",
                    c.kind.table
                ),
                params![target, id],
                |_| Ok(()),
            )
            .optional()?
            .is_some()
            && c.kind.table != "smart_playlists"
        {
            return Err(Error::Msg(format!("“{target}” already exists here.")));
        }
        if shared {
            match c.kind.table {
                "tags" => ops.tag(uid, &target),
                "playlists" => ops.playlist(uid, &target),
                _ => ops.smart_playlist_name(uid, &target),
            }
            shared_uids.push(uid.clone());
        } else {
            conn.execute(
                &format!("UPDATE {} SET name = ?1 WHERE id = ?2", c.kind.table),
                params![target, id],
            )?;
        }
    }
    ops.commit(conn)?;
    let mut touched = BTreeSet::new();
    for uid in shared_uids {
        apply::materialize_item(conn, c.kind, &uid, &mut touched)?;
    }
    for p in touched {
        apply::renumber(conn, p)?;
    }
    Ok(())
}
