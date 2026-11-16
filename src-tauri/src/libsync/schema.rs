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
         -- Ops written by a newer version of the format: kept as they came.
         CREATE TABLE IF NOT EXISTS op_unknown (
             clock TEXT PRIMARY KEY,
             op    TEXT NOT NULL
         );",
    )?;
    Ok(())
}
