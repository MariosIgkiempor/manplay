//! Running other programs (ffmpeg, diskutil, tailscale…).

use std::ffi::OsStr;
use std::process::Command;

/// A `Command` that, on Windows, does not flash a console window: a GUI app's children
/// otherwise each open one.
pub fn command(program: impl AsRef<OsStr>) -> Command {
    #[allow(unused_mut)] // only changed on Windows
    let mut cmd = Command::new(program);
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }
    cmd
}
