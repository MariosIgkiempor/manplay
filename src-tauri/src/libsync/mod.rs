//! Library data shared between devices: tags, playlists, smart playlists, analysis and the
//! Tag Database's hand-made values. Waveforms are files (`waveforms.rs`).
//!
//! Every edit to a shared item is also written as an *op*: one `(entity, id, field, value)` line
//! stamped with a hybrid logical clock. Each device uploads its new ops to the destination as an
//! immutable chunk (`.manplay/log/<device>/<seq>.jsonl.gz`) and replays everyone else's. The
//! winner of each `(entity, id, field)` is the op with the highest clock, so replay order never
//! matters. See `docs/plans/shared-library/02-op-log.md`.

pub mod apply;
pub mod auto;
pub mod brake;
pub mod carry;
pub mod clashes;
pub mod clock;
pub mod compact;
pub mod covers;
pub mod entities;
pub mod files;
pub mod folder;
pub mod frac;
pub mod identity;
pub mod journal;
pub mod membership;
pub mod ops;
pub mod recent;
pub mod remap;
pub mod remote;
pub mod schema;
pub mod seed;
pub mod share;
pub mod skew;
pub mod snapshot;
pub mod song_tags;
pub mod state;
pub mod waveforms;
pub mod write;

#[cfg(test)]
pub use remote::run;
pub use remote::{ChunkRef, ChunkStore};
pub use write::{Batch, default_scope, new_uid, scope_of, set_default_scope};

#[cfg(test)]
mod tests;
