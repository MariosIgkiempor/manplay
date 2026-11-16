//! Library data shared between devices: tags, playlists, smart playlists, analysis and the
//! Tag Database's hand-made values. Waveforms are files (`waveforms.rs`).
//!
//! Every edit to a shared item is also written as an *op*: one `(entity, id, field, value)` line
//! stamped with a hybrid logical clock. Each device uploads its new ops to the destination as an
//! immutable chunk (`.manplay/log/<device>/<seq>.jsonl.gz`) and replays everyone else's. The
//! winner of each `(entity, id, field)` is the op with the highest clock, so replay order never
//! matters. See `docs/plans/shared-library/02-op-log.md`.

pub mod apply;
pub mod clashes;
pub mod clock;
pub mod entities;
pub mod frac;
pub mod ops;
pub mod remote;
pub mod schema;
pub mod seed;
pub mod share;
pub mod state;
pub mod waveforms;
pub mod write;

pub use remote::{ChunkRef, ChunkStore, run};
pub use write::{Batch, default_scope, new_uid};

#[cfg(test)]
mod tests;
