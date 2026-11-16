//! Writing ops: the one path every shared edit takes.

use rusqlite::{Connection, params};
use serde_json::{Value, json};

use super::clock;
use super::ops::{F_DELETE, F_NAME, F_POS, F_PRESENT, FORMAT, Op, member_id};
use super::state;
use crate::db;
use crate::error::Error;

const SETTING_DEVICE_ID: &str = "device_id";
const SETTING_DEFAULT_SCOPE: &str = "default_scope";

/// A fresh time-ordered UUID for a tag, playlist or smart playlist.
pub fn new_uid() -> String {
    uuid::Uuid::now_v7().to_string()
}

/// This device's ID, made on first use.
pub fn device_id(conn: &Connection) -> Result<String, Error> {
    if let Some(id) = db::get_setting(conn, SETTING_DEVICE_ID)? {
        return Ok(id);
    }
    let id = new_uid();
    db::set_setting(conn, SETTING_DEVICE_ID, Some(&id))?;
    Ok(id)
}

/// Scope for new tags and playlists: `shared` unless the library default says `local`.
pub fn default_scope(conn: &Connection) -> Result<&'static str, Error> {
    Ok(
        if db::get_setting(conn, SETTING_DEFAULT_SCOPE)?.as_deref() == Some("local") {
            "local"
        } else {
            "shared"
        },
    )
}

/// Whether library data is being shared: some destination has it switched on. Until then no
/// edit writes an op.
pub fn active(conn: &Connection) -> Result<bool, Error> {
    Ok(conn.query_row(
        "SELECT EXISTS (SELECT 1 FROM sync_targets WHERE libsync = 1)",
        [],
        |r| r.get(0),
    )?)
}

/// An op before it has a clock.
#[derive(Debug, Clone)]
pub struct NewOp {
    pub e: &'static str,
    pub id: String,
    pub f: &'static str,
    pub val: Value,
}

/// Ops collected by one edit, written together with it. Does nothing when library data is not
/// being shared, so callers never check.
pub struct Batch {
    on: bool,
    ops: Vec<NewOp>,
}

impl Batch {
    pub fn new(conn: &Connection) -> Result<Self, Error> {
        Ok(Self {
            on: active(conn)?,
            ops: Vec::new(),
        })
    }

    pub fn is_on(&self) -> bool {
        self.on
    }

    /// How many ops are waiting to be written.
    pub fn len(&self) -> usize {
        self.ops.len()
    }

    fn push(&mut self, e: &'static str, id: &str, f: &'static str, val: Value) {
        if self.on {
            self.ops.push(NewOp {
                e,
                id: id.to_owned(),
                f,
                val,
            });
        }
    }

    /// A tag was created or renamed (`name` is the full path).
    pub fn tag(&mut self, uid: &str, name: &str) {
        self.push("tag", uid, F_NAME, json!(name));
    }

    pub fn tag_deleted(&mut self, uid: &str) {
        self.push("tag", uid, F_DELETE, Value::Null);
    }

    pub fn track_tag(&mut self, tag_uid: &str, audio_fp: &str, present: bool) {
        if !audio_fp.is_empty() {
            self.push(
                "track_tag",
                &member_id(tag_uid, audio_fp),
                F_PRESENT,
                json!(present),
            );
        }
    }

    pub fn playlist(&mut self, uid: &str, name: &str) {
        self.push("playlist", uid, F_NAME, json!(name));
    }

    pub fn playlist_deleted(&mut self, uid: &str) {
        self.push("playlist", uid, F_DELETE, Value::Null);
    }

    /// A song joined a playlist at `pos`.
    pub fn playlist_add(&mut self, playlist_uid: &str, audio_fp: &str, pos: &str) {
        if !audio_fp.is_empty() {
            let id = member_id(playlist_uid, audio_fp);
            self.push("playlist_track", &id, F_PRESENT, json!(true));
            self.push("playlist_track", &id, F_POS, json!(pos));
        }
    }

    pub fn playlist_remove(&mut self, playlist_uid: &str, audio_fp: &str) {
        if !audio_fp.is_empty() {
            self.push(
                "playlist_track",
                &member_id(playlist_uid, audio_fp),
                F_PRESENT,
                json!(false),
            );
        }
    }

    /// Writes the ops. Call inside the transaction of the edit they describe.
    pub fn commit(self, conn: &Connection) -> Result<(), Error> {
        if self.ops.is_empty() {
            return Ok(());
        }
        record(conn, &self.ops)
    }
}

/// Stamps `ops`, appends them to the local log and applies them to the register store, in the
/// caller's transaction. The only place an op is made.
pub fn record(conn: &Connection, ops: &[NewOp]) -> Result<(), Error> {
    let dev = device_id(conn)?;
    let mut hlc = clock::load(conn)?;
    let now = clock::now_ms();
    {
        let mut insert = conn.prepare_cached(
            "INSERT INTO oplog (clock, dev, e, id, f, val, uploaded) VALUES (?1, ?2, ?3, ?4, ?5, ?6, 0)",
        )?;
        for new in ops {
            let (ms, counter) = hlc.tick(now);
            let op = Op {
                v: FORMAT,
                clock: clock::format(ms, counter, &dev),
                dev: dev.clone(),
                e: new.e.to_owned(),
                id: new.id.clone(),
                f: new.f.to_owned(),
                val: new.val.clone(),
            };
            let val = serde_json::to_string(&op.val).map_err(|e| Error::Msg(e.to_string()))?;
            insert.execute(params![op.clock, op.dev, op.e, op.id, op.f, val])?;
            state::put(conn, &op)?;
        }
    }
    clock::save(conn, hlc)
}
