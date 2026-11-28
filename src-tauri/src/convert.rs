//! Turning songs into the library's format: MP3 at 320 kbps with ffmpeg (bundled with the app),
//! for import folders set to convert AAC; and names that are safe as files on every system.

use std::path::{Path, PathBuf};

/// Makes `name` safe as a single path component on macOS, Windows and Linux.
pub fn sanitize(name: &str, fallback: &str) -> String {
    let cleaned: String = name
        .chars()
        .map(|c| match c {
            '/' | '\\' | ':' | '*' | '?' | '"' | '<' | '>' | '|' => '_',
            c if c.is_control() => '_',
            c => c,
        })
        .collect();
    let trimmed: String = cleaned
        .trim()
        .trim_start_matches('.')
        .trim_end_matches(['.', ' '])
        .chars()
        .take(120)
        .collect();
    let trimmed = trimmed.trim_end_matches(['.', ' ']).to_owned();
    if trimmed.is_empty() {
        fallback.to_owned()
    } else if is_reserved(&trimmed) {
        format!("{trimmed}_")
    } else {
        trimmed
    }
}

/// Names Windows keeps for devices (`CON`, `NUL`, `COM1`…), which no file or folder may have
/// there, even with an extension. Avoided everywhere so a library can move to a Windows PC.
fn is_reserved(name: &str) -> bool {
    let stem = name
        .split('.')
        .next()
        .unwrap_or(name)
        .trim_end()
        .to_ascii_uppercase();
    matches!(stem.as_str(), "CON" | "PRN" | "AUX" | "NUL")
        || (stem.len() == 4
            && (stem.starts_with("COM") || stem.starts_with("LPT"))
            && stem.as_bytes()[3].is_ascii_digit()
            && stem.as_bytes()[3] != b'0')
}

/// The ffmpeg bundled with the app (a sidecar next to the executable), else one installed on the
/// system. The system search also covers Homebrew, since apps launched from Finder get a minimal
/// PATH.
pub fn find_ffmpeg() -> Option<PathBuf> {
    let name = format!("ffmpeg{}", std::env::consts::EXE_SUFFIX);
    // Tests run from `target/<profile>/deps`; the sidecar is copied to `target/<profile>`.
    let bundled = std::env::current_exe().ok().into_iter().flat_map(|exe| {
        exe.ancestors()
            .skip(1)
            .take(2)
            .map(Path::to_path_buf)
            .collect::<Vec<_>>()
    });
    let fixed: &[&str] = if cfg!(target_os = "macos") {
        &[
            "/opt/homebrew/bin",
            "/usr/local/bin",
            "/opt/local/bin",
            "/usr/bin",
        ]
    } else {
        &[]
    };
    let from_path = std::env::var_os("PATH")
        .map(|p| std::env::split_paths(&p).collect::<Vec<_>>())
        .unwrap_or_default();
    bundled
        .chain(fixed.iter().map(PathBuf::from))
        .chain(from_path)
        .map(|d| d.join(&name))
        .find(|p| p.is_file())
        .or_else(fetched_for_tests)
}

/// In tests, the ffmpeg `pnpm install` fetched into `binaries/` (named for the platform, e.g.
/// `ffmpeg-aarch64-apple-darwin`), for when no build has copied it next to the test binary, as
/// on CI.
#[cfg(test)]
fn fetched_for_tests() -> Option<PathBuf> {
    let binaries = Path::new(env!("CARGO_MANIFEST_DIR")).join("binaries");
    std::fs::read_dir(binaries)
        .ok()?
        .filter_map(|entry| entry.ok().map(|entry| entry.path()))
        .find(|path| {
            let name = path.file_name().unwrap_or_default().to_string_lossy();
            name.starts_with("ffmpeg-")
                && Path::new(&*name)
                    .extension()
                    .is_none_or(|extension| extension == std::env::consts::EXE_EXTENSION)
        })
}

#[cfg(not(test))]
fn fetched_for_tests() -> Option<PathBuf> {
    None
}

/// Arguments for a highest-quality (320 kbps CBR) MP3 with tags and cover art carried over.
pub fn ffmpeg_args(src: &Path, out: &Path) -> Vec<std::ffi::OsString> {
    let mut args: Vec<std::ffi::OsString> = Vec::new();
    let mut push = |s: &str| args.push(s.into());
    for a in ["-nostdin", "-y", "-v", "error", "-i"] {
        push(a);
    }
    args.push(src.into());
    let mut push = |s: &str| args.push(s.into());
    for a in [
        "-map",
        "0:a:0",
        "-map",
        "0:v:0?",
        "-map_metadata",
        "0",
        "-c:a",
        "libmp3lame",
        "-b:a",
        "320k",
        "-c:v",
        "copy",
        "-id3v2_version",
        "3",
        "-write_id3v1",
        "1",
        "-f",
        "mp3",
    ] {
        push(a);
    }
    args.push(out.into());
    args
}

/// Converts `src` to MP3 at `dest`, through a temporary file beside it so `dest` only ever holds
/// a whole song. The error is ffmpeg's own last line.
pub fn to_mp3(ffmpeg: &Path, src: &Path, dest: &Path) -> Result<(), String> {
    let dir = dest.parent().ok_or("no destination folder")?;
    let tmp = dir.join(format!(".manplay-{}.tmp", std::process::id()));
    let out = crate::process::command(ffmpeg)
        .args(ffmpeg_args(src, &tmp))
        .output()
        .map_err(|e| format!("could not run ffmpeg: {e}"))?;
    if !out.status.success() {
        let _ = std::fs::remove_file(&tmp);
        let msg = String::from_utf8_lossy(&out.stderr);
        let last = msg.lines().rev().find(|l| !l.trim().is_empty());
        return Err(last.unwrap_or("ffmpeg failed").trim().to_owned());
    }
    std::fs::rename(&tmp, dest).map_err(|e| {
        let _ = std::fs::remove_file(&tmp);
        format!("save {}: {e}", dest.display())
    })
}

#[cfg(test)]
#[allow(clippy::expect_used, clippy::unwrap_used)] // tests: panicking is the failure mode
mod tests {
    use super::*;

    #[test]
    fn tests_find_the_ffmpeg_pnpm_install_fetched() {
        let ffmpeg = fetched_for_tests().expect("run pnpm install to fetch ffmpeg");
        let ran = crate::process::command(&ffmpeg)
            .arg("-version")
            .output()
            .expect("ffmpeg runs");
        assert!(ran.status.success());
    }

    #[test]
    fn avoids_windows_device_names() {
        assert_eq!(sanitize("CON", "x"), "CON_");
        assert_eq!(sanitize("nul", "x"), "nul_");
        assert_eq!(sanitize("COM1", "x"), "COM1_");
        assert_eq!(sanitize("Console", "x"), "Console");
        assert_eq!(sanitize("COM0", "x"), "COM0");
        assert_eq!(sanitize("a: b?", "x"), "a_ b_");
    }
    #[test]
    fn sanitize_replaces_path_characters_and_trims() {
        assert_eq!(sanitize("AC/DC", "x"), "AC_DC");
        assert_eq!(sanitize("What?: Why", "x"), "What__ Why");
        assert_eq!(sanitize("..hidden.", "x"), "hidden");
        assert_eq!(sanitize("  ", "Unknown"), "Unknown");
    }
}
