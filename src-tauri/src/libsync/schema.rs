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
         );",
    )?;
    Ok(())
}
