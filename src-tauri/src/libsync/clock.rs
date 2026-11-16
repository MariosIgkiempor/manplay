//! Hybrid logical clock. A clock string is `<UTC ms, 15 digits>-<counter, 4 digits>-<device>`;
//! strings compare in time order, and the device ID breaks ties between devices.

use rusqlite::Connection;

use crate::db;
use crate::error::Error;

const SETTING_HLC: &str = "hlc";
/// The counter has four digits; past this the millisecond moves on instead.
const MAX_COUNTER: u32 = 9999;

/// The newest `(ms, counter)` this device has made or seen.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct Hlc {
    ms: i64,
    counter: u32,
}

impl Hlc {
    /// The next stamp: later than every earlier one, even if the wall clock stood still or went back.
    pub fn tick(&mut self, now_ms: i64) -> (i64, u32) {
        if now_ms > self.ms {
            self.ms = now_ms;
            self.counter = 0;
        } else if self.counter >= MAX_COUNTER {
            self.ms += 1;
            self.counter = 0;
        } else {
            self.counter += 1;
        }
        (self.ms, self.counter)
    }

    /// Takes in a clock read from another device, so the next stamp is later than it.
    pub fn observe(&mut self, clock: &str) {
        if let Some((ms, counter)) = parse(clock)
            && (ms, counter) > (self.ms, self.counter)
        {
            self.ms = ms;
            self.counter = counter;
        }
    }
}

pub fn format(ms: i64, counter: u32, device: &str) -> String {
    format!("{ms:015}-{counter:04}-{device}")
}

/// `(ms, counter)` of a clock string.
pub fn parse(clock: &str) -> Option<(i64, u32)> {
    let mut parts = clock.splitn(3, '-');
    let ms = parts.next()?.parse().ok()?;
    let counter = parts.next()?.parse().ok()?;
    Some((ms, counter))
}

pub fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .ok()
        .and_then(|d| i64::try_from(d.as_millis()).ok())
        .unwrap_or(0)
}

pub fn load(conn: &Connection) -> Result<Hlc, Error> {
    let raw = db::get_setting(conn, SETTING_HLC)?.unwrap_or_default();
    let mut hlc = Hlc::default();
    if let Some((ms, counter)) = raw.split_once(':')
        && let (Ok(ms), Ok(counter)) = (ms.parse(), counter.parse())
    {
        hlc = Hlc { ms, counter };
    }
    Ok(hlc)
}

pub fn save(conn: &Connection, hlc: Hlc) -> Result<(), Error> {
    db::set_setting(
        conn,
        SETTING_HLC,
        Some(&format!("{}:{}", hlc.ms, hlc.counter)),
    )
}
