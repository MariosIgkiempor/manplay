//! Fractional indexes: strings over a base-62 alphabet that sort in byte order, so a new key can
//! always be made between two neighbours without renumbering them. Concurrent inserts at the
//! same spot get different keys by device, or tie and fall back to the track's `audio_fp`.

const DIGITS: &[u8; 62] = b"0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";
const BASE: usize = 62;

fn index(c: u8) -> usize {
    DIGITS.iter().position(|&d| d == c).unwrap_or(0)
}

/// A key strictly between `a` and `b` (`a` empty is the start, `b` `None` the end).
fn midpoint(a: &[u8], b: Option<&[u8]>) -> Vec<u8> {
    if let Some(b) = b {
        // Keep the shared prefix; `a` counts as padded with zeros.
        let mut n = 0;
        while n < b.len() && a.get(n).copied().unwrap_or(b'0') == b[n] {
            n += 1;
        }
        if n > 0 {
            let mut out = b[..n].to_vec();
            out.extend(midpoint(a.get(n..).unwrap_or(&[]), Some(&b[n..])));
            return out;
        }
    }
    let da = a.first().map_or(0, |&c| index(c));
    let db = b.and_then(|b| b.first()).map_or(BASE, |&c| index(c));
    if db - da > 1 {
        return vec![DIGITS[(da + db).div_ceil(2)]];
    }
    match b {
        Some(b) if b.len() > 1 => vec![b[0]],
        _ => {
            let mut out = vec![DIGITS[da]];
            out.extend(midpoint(a.get(1..).unwrap_or(&[]), None));
            out
        }
    }
}

/// A key between `a` and `b`. Equal or reversed neighbours (two devices made the same key) put
/// the new key after `a`.
pub fn between(a: Option<&str>, b: Option<&str>) -> String {
    let a = a.unwrap_or("");
    let b = b.filter(|b| !b.is_empty());
    let b = b.filter(|b| a < *b);
    String::from_utf8(midpoint(a.as_bytes(), b.map(str::as_bytes))).unwrap_or_default()
}

/// `n` increasing keys between `a` and `b`, spread so they stay short.
pub fn spread(a: Option<&str>, b: Option<&str>, n: usize) -> Vec<String> {
    match n {
        0 => Vec::new(),
        1 => vec![between(a, b)],
        _ => {
            let mid = between(a, b);
            let left = (n - 1) / 2;
            let mut out = spread(a, Some(&mid), left);
            out.push(mid.clone());
            out.extend(spread(Some(&mid), b, n - 1 - left));
            out
        }
    }
}
