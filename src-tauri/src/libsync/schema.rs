//! Tables for the op log. Additive; created on every open.

use rusqlite::Connection;

use crate::error::Error;

pub fn create(conn: &Connection) -> Result<(), Error> {
    conn.execute_batch(
        "-- This device's own ops, in the order written. `uploaded` is set once a chunk holding
         -- the op is on the destination.
         CREATE TABLE IF NOT EXISTS oplog (
             clock    TEXT PRIMARY KEY,
             dev      TEXT NOT NULL,
             e        TEXT NOT NULL,
             id       TEXT NOT NULL,
             f        TEXT NOT NULL,
             val      TEXT NOT NULL,
             uploaded INTEGER NOT NULL DEFAULT 0
         );
         -- The last chunk applied from each device (this device's own: the last one uploaded).
         CREATE TABLE IF NOT EXISTS op_cursor (
             dev TEXT PRIMARY KEY,
             seq INTEGER NOT NULL
         );
         -- The winning op of every (entity, id, field), from everyone. Rows of tracks the library
         -- does not have yet wait here; `ref` is the track's audio_fp for memberships.
         CREATE TABLE IF NOT EXISTS op_state (
             e     TEXT NOT NULL,
             id    TEXT NOT NULL,
             f     TEXT NOT NULL,
             clock TEXT NOT NULL,
             val   TEXT NOT NULL,
             ref   TEXT,
             PRIMARY KEY (e, id, f)
         );
         CREATE INDEX IF NOT EXISTS op_state_ref ON op_state(e, ref);
         -- What was merged into what: tiny, and what member lookups ask for every time.
         CREATE INDEX IF NOT EXISTS op_state_merge ON op_state(e, val) WHERE f = '_merge';
         -- Ops written by a newer version of the format: kept as they came.
         CREATE TABLE IF NOT EXISTS op_unknown (
             clock TEXT PRIMARY KEY,
             op    TEXT NOT NULL
         );
         -- Two items of one kind with the same name, waiting for the user (see `clashes.rs`).
         -- `keeps` has the name in the library; `held` is shown under a held name until resolved.
         CREATE TABLE IF NOT EXISTS clashes (
             id    INTEGER PRIMARY KEY,
             kind  TEXT NOT NULL,
             name  TEXT NOT NULL,
             keeps TEXT NOT NULL,
             held  TEXT NOT NULL,
             UNIQUE (kind, held)
         );
         -- The other members of the library as the destination last listed them (names for
         -- Recently deleted). Rebuilt at every sync.
         CREATE TABLE IF NOT EXISTS libsync_devices (
             id   TEXT PRIMARY KEY,
             name TEXT NOT NULL
         );
         -- Ops from other devices whose clock is far ahead of this device's own and of everything
         -- already applied (a wrong clock over there). Kept, not applied; tried again every sync
         -- (see `skew.rs`).
         CREATE TABLE IF NOT EXISTS op_future (
             clock TEXT PRIMARY KEY,
             dev   TEXT NOT NULL,
             op    TEXT NOT NULL
         );
         -- Songs whose audio changed in place (a re-encode over the same file) and the audio they
         -- had before: offered \"Carry over tags and playlists\" (see `carry.rs`).
         CREATE TABLE IF NOT EXISTS audio_changes (
             track_id INTEGER PRIMARY KEY,
             old_fp   TEXT NOT NULL,
             new_fp   TEXT NOT NULL
         );
         -- Audio the user turned down carrying tags and playlists over from.
         CREATE TABLE IF NOT EXISTS carry_dismissed (
             old_fp TEXT PRIMARY KEY
         );
         -- What other devices' edits changed here, one line per field and sync (`batch` is the
         -- UTC ms of that sync), with the value from before so it can be taken back (see
         -- `journal.rs`). `prev` is NULL when the field had no value.
         CREATE TABLE IF NOT EXISTS op_journal (
             n      INTEGER PRIMARY KEY,
             batch  INTEGER NOT NULL,
             clock  TEXT NOT NULL,
             dev    TEXT NOT NULL,
             e      TEXT NOT NULL,
             id     TEXT NOT NULL,
             f      TEXT NOT NULL,
             val    TEXT NOT NULL,
             prev   TEXT,
             undone INTEGER NOT NULL DEFAULT 0
         );
         CREATE INDEX IF NOT EXISTS op_journal_batch ON op_journal(batch);
         -- What this device's library had for each audio when it last wrote `file` ops, so a
         -- change made here can be told from one another device made (see `files.rs`). `path` is
         -- a JSON list of the names below the library folder.
         CREATE TABLE IF NOT EXISTS file_local (
             audio_fp TEXT PRIMARY KEY,
             path     TEXT NOT NULL,
             present  INTEGER NOT NULL
         );",
    )?;
    Ok(())
}
