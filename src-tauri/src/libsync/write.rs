//! Writing ops: the one path every shared edit takes.

use rusqlite::{Connection, params};
use serde_json::{Value, json};

use super::clock;
use super::ops::{F_DELETE, F_MERGE, F_NAME, F_POS, F_PRESENT, F_RULES, FORMAT, Op, member_id};
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

/// `shared` or `local` from a caller; anything else is refused.
pub fn scope_of(label: &str) -> Result<&'static str, Error> {
    match label {
        "shared" => Ok("shared"),
        "local" => Ok("local"),
        _ => Err(Error::Msg(format!("Unknown scope: {label}."))),
    }
}

/// Sets the scope new tags and playlists get.
pub fn set_default_scope(conn: &Connection, scope: &str) -> Result<(), Error> {
    db::set_setting(conn, SETTING_DEFAULT_SCOPE, Some(scope_of(scope)?))
}

/// Whether library data is being shared: some destination holds this device's library, or the
/// library folder does. Until then no edit writes an op.
pub fn active(conn: &Connection) -> Result<bool, Error> {
    Ok(conn.query_row(
        "SELECT EXISTS (SELECT 1 FROM sync_targets WHERE libsync = 1)
             OR EXISTS (SELECT 1 FROM settings WHERE key = ?1 AND value = '1')",
        [super::membership::SETTING_IN_FOLDER],
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

    /// A deleted item was taken back: its tombstone is replaced by `false`.
    pub fn restored(&mut self, e: &'static str, uid: &str) {
        self.push(e, uid, F_DELETE, json!(false));
    }

    /// A tag was merged into another: it is gone and its uid means `into` from now on.
    pub fn tag_merged(&mut self, uid: &str, into: &str) {
        self.push("tag", uid, F_MERGE, json!(into));
    }

    pub fn playlist_merged(&mut self, uid: &str, into: &str) {
        self.push("playlist", uid, F_MERGE, json!(into));
    }

    pub fn smart_playlist_merged(&mut self, uid: &str, into: &str) {
        self.push("smart_playlist", uid, F_MERGE, json!(into));
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

    /// A smart playlist was created or changed. `rules` has tags by uid.
    pub fn smart_playlist(&mut self, uid: &str, name: &str, rules: &Value) {
        self.push("smart_playlist", uid, F_NAME, json!(name));
        self.push("smart_playlist", uid, F_RULES, rules.clone());
    }

    /// Only the name of a smart playlist changed.
    pub fn smart_playlist_name(&mut self, uid: &str, name: &str) {
        self.push("smart_playlist", uid, F_NAME, json!(name));
    }

    pub fn smart_playlist_rules(&mut self, uid: &str, rules: &Value) {
        self.push("smart_playlist", uid, F_RULES, rules.clone());
    }

    pub fn smart_playlist_deleted(&mut self, uid: &str) {
        self.push("smart_playlist", uid, F_DELETE, Value::Null);
    }

    /// A value of the Tag Database was added or removed by hand. Values compare ignoring case,
    /// so the id is lower case and the spelling travels as the `name`.
    pub fn custom_value(&mut self, field: &str, value: &str, present: bool) {
        let id = format!("{field}/{}", value.to_lowercase());
        if present {
            self.push("tag_custom", &id, F_NAME, json!(value));
        }
        self.push("tag_custom", &id, F_PRESENT, json!(present));
    }

    /// One field of a song's analysis (see the `A_*` constants).
    pub fn analysis(&mut self, audio_fp: &str, field: &'static str, val: Value) {
        if !audio_fp.is_empty() {
            self.push("analysis", audio_fp, field, val);
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
/// caller's transaction.
pub fn record(conn: &Connection, ops: &[NewOp]) -> Result<(), Error> {
    let fields: Vec<Field> = ops
        .iter()
        .map(|new| Field {
            e: new.e.to_owned(),
            id: new.id.clone(),
            f: new.f.to_owned(),
            val: new.val.clone(),
        })
        .collect();
    stamp(conn, &fields).map(|_| ())
}

/// A value for one field of one entity, before it has a clock. Unlike [`NewOp`] its entity and
/// field can be ones read from another device's op.
#[derive(Debug, Clone, PartialEq)]
pub struct Field {
    pub e: String,
    pub id: String,
    pub f: String,
    pub val: Value,
}

/// Stamps `fields` as this device's ops, appends them to the local log and the register store,
/// and returns them. The only place an op is made. Rows are not touched: the caller changes them
/// itself, or rebuilds them with `apply::materialize`.
pub fn stamp(conn: &Connection, fields: &[Field]) -> Result<Vec<Op>, Error> {
    let dev = device_id(conn)?;
    let mut hlc = clock::load(conn)?;
    let now = clock::now_ms();
    let mut stamped = Vec::with_capacity(fields.len());
    {
        let mut insert = conn.prepare_cached(
            "INSERT INTO oplog (clock, dev, e, id, f, val, uploaded) VALUES (?1, ?2, ?3, ?4, ?5, ?6, 0)",
        )?;
        for field in fields {
            let (ms, counter) = hlc.tick(now);
            let op = Op {
                v: FORMAT,
                clock: clock::format(ms, counter, &dev),
                dev: dev.clone(),
                e: field.e.clone(),
                id: field.id.clone(),
                f: field.f.clone(),
                val: field.val.clone(),
            };
            let val = serde_json::to_string(&op.val).map_err(|e| Error::Msg(e.to_string()))?;
            insert.execute(params![op.clock, op.dev, op.e, op.id, op.f, val])?;
            state::put(conn, &op)?;
            stamped.push(op);
        }
    }
    clock::save(conn, hlc)?;
    Ok(stamped)
}
