//! When the shared library syncs on its own: at launch, when the window comes back, a little
//! after the last edit, and every few minutes. A sync that fails is tried again sooner at first
//! and then less and less often, so a destination that is away is not hammered.

use std::time::Duration;

use rusqlite::Connection;

use super::clock;
use crate::db;
use crate::error::Error;

/// How often the library syncs when nothing else asks for it.
pub const EVERY: Duration = Duration::from_secs(5 * 60);
/// How long after the last edit it is sent, so a run of edits goes as one chunk.
pub const AFTER_EDIT: Duration = Duration::from_secs(30);
/// The shortest time between two syncs, whatever asks.
pub const MIN_GAP: Duration = Duration::from_secs(10);
/// The wait after the first failure; doubled for each one after it.
pub const FIRST_RETRY: Duration = Duration::from_secs(60);
/// The longest wait between tries while the destination keeps failing.
pub const LONGEST_RETRY: Duration = Duration::from_secs(30 * 60);
/// How often the worker looks whether a sync is due.
pub const TICK: Duration = Duration::from_secs(5);

const SETTING_AUTO: &str = "libsync_auto";

/// Whether the shared library syncs on its own. On unless switched off.
pub fn enabled(conn: &Connection) -> Result<bool, Error> {
    Ok(db::get_setting(conn, SETTING_AUTO)?.as_deref() != Some("0"))
}

pub fn set_enabled(conn: &Connection, on: bool) -> Result<(), Error> {
    db::set_setting(conn, SETTING_AUTO, Some(if on { "1" } else { "0" }))
}

/// How long ago this device's newest edit that has not been sent was made; `None` when
/// everything is sent.
pub fn unsent_age(conn: &Connection, now_ms: i64) -> Result<Option<Duration>, Error> {
    let newest: Option<String> =
        conn.query_row("SELECT MAX(clock) FROM oplog WHERE uploaded = 0", [], |r| {
            r.get(0)
        })?;
    Ok(newest
        .as_deref()
        .and_then(clock::parse)
        .map(|(ms, _)| Duration::from_millis(u64::try_from(now_ms - ms).unwrap_or(0))))
}

/// What the worker knows when it decides whether to sync now.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct Moment {
    /// Time since the last sync was tried; `None` before the first one.
    pub since_last: Option<Duration>,
    /// See [`unsent_age`].
    pub unsent_age: Option<Duration>,
    /// Something asked for a sync now: the window came back, or the user did.
    pub asked: bool,
}

/// The syncs that failed in a row, which is what spaces the next tries.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct Pace {
    failures: u32,
}

impl Pace {
    pub fn succeeded(&mut self) {
        self.failures = 0;
    }

    pub fn failed(&mut self) {
        self.failures = self.failures.saturating_add(1);
    }

    /// The time between two syncs when nothing asks for one.
    pub fn interval(self) -> Duration {
        match self.failures {
            0 => EVERY,
            n => FIRST_RETRY
                .saturating_mul(2_u32.saturating_pow(n - 1))
                .min(LONGEST_RETRY),
        }
    }

    /// Whether to sync at `moment`.
    pub fn due(self, moment: Moment) -> bool {
        let Some(since_last) = moment.since_last else {
            return true;
        };
        if since_last < MIN_GAP {
            return false;
        }
        if moment.asked || since_last >= self.interval() {
            return true;
        }
        // Edits wait for the retry time while the destination is failing.
        self.failures == 0
            && since_last >= AFTER_EDIT
            && moment.unsent_age.is_some_and(|age| age >= AFTER_EDIT)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const fn secs(n: u64) -> Duration {
        Duration::from_secs(n)
    }

    fn moment(since_last: u64, unsent_age: Option<u64>, asked: bool) -> Moment {
        Moment {
            since_last: Some(secs(since_last)),
            unsent_age: unsent_age.map(secs),
            asked,
        }
    }

    #[test]
    fn the_first_sync_runs_at_once() {
        assert!(Pace::default().due(Moment::default()));
    }

    #[test]
    fn when_a_sync_is_due() {
        let healthy = Pace::default();
        let mut failing = Pace::default();
        failing.failed();
        failing.failed();
        // (pace, since the last try, age of the newest unsent edit, asked, due)
        let cases = [
            ("nothing to do yet", healthy, 120, None, false, false),
            ("the round comes up", healthy, 300, None, false, true),
            ("an edit has settled", healthy, 45, Some(31), false, true),
            (
                "an edit is still fresh",
                healthy,
                45,
                Some(10),
                false,
                false,
            ),
            (
                "an edit right after a sync",
                healthy,
                15,
                Some(40),
                false,
                false,
            ),
            ("the window came back", healthy, 20, None, true, true),
            ("asked twice in a row", healthy, 5, None, true, false),
            ("failing, edit waits", failing, 60, Some(60), false, false),
            ("failing, retry time is up", failing, 120, None, false, true),
            ("failing, but asked", failing, 15, None, true, true),
        ];
        for (name, pace, since_last, unsent, asked, due) in cases {
            assert_eq!(pace.due(moment(since_last, unsent, asked)), due, "{name}");
        }
    }

    #[test]
    fn retries_slow_down_and_stop_at_the_longest_wait() {
        let mut pace = Pace::default();
        let mut waits = Vec::new();
        for _ in 0..8 {
            pace.failed();
            waits.push(pace.interval().as_secs());
        }
        assert_eq!(waits, [60, 120, 240, 480, 960, 1800, 1800, 1800]);
        pace.succeeded();
        assert_eq!(pace.interval(), EVERY);
    }
}
