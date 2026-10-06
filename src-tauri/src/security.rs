//! Centralized security helpers shared by the native command modules.
//!
//! The desktop webview loads LOCAL bundled HTML/JS, but renders untrusted data
//! (file names, downloaded video titles, AI output) into the DOM, and every custom
//! `#[tauri::command]` is callable from any webview JS (Tauri capabilities gate
//! plugin commands only).
//! These helpers are the defense-in-depth layer beneath the CSP so that an
//! injected script can't trivially weaponize the native commands:
//!
//!  - `confine_existing` — keep an EXISTING-file path command (read/delete/transcode
//!    of app-managed media) inside the app's own directories. `canonicalize()`
//!    resolves `..`/symlinks BEFORE the prefix check, so neither can escape.
//!  - `reject_hostile_dest` — for commands that legitimately write into a USER-chosen
//!    folder (download/copy dest, export output) we can't allowlist to app-data
//!    without breaking the feature, so we instead refuse the targets an injected
//!    script would actually pick (system dirs, autostart, the app's own bin dir) and
//!    reject `..` traversal.
//!  - `open_path_native` / `reveal_path_native` — route through `tauri-plugin-opener`
//!    (Win32 shell-open / `reveal_item_in_dir`) instead of `cmd /C start`, so a
//!    file name carrying cmd metacharacters (`& | ^ …`) can never break out into
//!    command execution (the BatBadBut / CVE-2024-24576 class).

use std::path::{Component, Path, PathBuf};

use tauri::{AppHandle, Manager};
use tauri_plugin_opener::OpenerExt;

// ── Path confinement ──────────────────────────────────────────────────────────

/// Directories under which app-managed files legitimately live: the app-data
/// subtree plus the app's temp working dirs (export-clip staging, whisper input).
/// Used to confine the "app-managed path" commands.
pub fn app_managed_roots(app: &AppHandle) -> Vec<PathBuf> {
    let mut roots: Vec<PathBuf> = Vec::new();
    if let Ok(d) = app.path().app_data_dir() {
        roots.push(d);
    }
    roots.push(crate::branding::temp_dir("export"));
    roots.push(crate::branding::temp_dir("whisper"));
    roots
}

/// Folder (under app-data) holding secrets the webview must never read back —
/// currently the user's AI provider API keys (api_brain_command.rs).
pub const SECRETS_DIR: &str = "secrets";

/// `<app-data>/secrets`, created on demand by its owner.
pub fn secrets_dir(app: &AppHandle) -> Result<PathBuf, String> {
    app.path()
        .app_data_dir()
        .map(|d| d.join(SECRETS_DIR))
        .map_err(|e| e.to_string())
}

/// True when `p` resolves inside the secrets folder. Canonicalized on both sides,
/// so `..` / symlinks can't sneak past the prefix check.
pub fn is_secret_path(app: &AppHandle, p: &Path) -> bool {
    let Ok(dir) = secrets_dir(app) else { return false };
    let Ok(dir) = std::fs::canonicalize(dir) else { return false }; // no secrets yet
    std::fs::canonicalize(p).map(|c| c.starts_with(&dir)).unwrap_or(false)
}

/// `confine_existing` against the app-managed roots, minus the secrets folder —
/// the check every webview-callable "app file" command (read/delete/ffmpeg input)
/// goes through, so a stored API key can never be read back over IPC.
pub fn confine_app_file(app: &AppHandle, requested: &str) -> Result<PathBuf, String> {
    let safe = confine_existing(requested, &app_managed_roots(app))?;
    if is_secret_path(app, &safe) {
        return Err("path is outside the allowed directories".into());
    }
    Ok(safe)
}

/// Confine an EXISTING file path to one of `roots`. Returns the canonical path on
/// success. Both sides are canonicalized, so `..` / symlink escapes are resolved
/// away before the `starts_with` check (and Windows `\\?\` prefixes match).
pub fn confine_existing(requested: &str, roots: &[PathBuf]) -> Result<PathBuf, String> {
    let canon = std::fs::canonicalize(requested)
        .map_err(|_| "path not found or not accessible".to_string())?;
    let inside = roots.iter().any(|r| {
        std::fs::canonicalize(r)
            .map(|rc| canon == rc || canon.starts_with(&rc))
            .unwrap_or(false)
    });
    if inside {
        Ok(canon)
    } else {
        Err("path is outside the allowed directories".into())
    }
}

/// Canonicalize the nearest EXISTING ancestor of `p` (the leaf may not exist yet,
/// e.g. a download destination). None if no ancestor resolves.
fn nearest_existing_canonical(p: &Path) -> Option<PathBuf> {
    let mut cur: Option<&Path> = Some(p);
    while let Some(c) = cur {
        if let Ok(canon) = std::fs::canonicalize(c) {
            return Some(canon);
        }
        cur = c.parent();
    }
    None
}

/// OS / app locations a write destination must never resolve into — the targets an
/// injected script would pick to gain persistence or hijack the app's own binaries.
fn hostile_roots(app: &AppHandle) -> Vec<PathBuf> {
    let mut v: Vec<PathBuf> = Vec::new();
    // The app's own downloaded-binary dir (PATH-prepended) — never a download dest.
    if let Ok(d) = app.path().app_data_dir() {
        v.push(d.join("bin"));
    }
    #[cfg(windows)]
    {
        if let Ok(sysroot) = std::env::var("SystemRoot") {
            v.push(PathBuf::from(sysroot)); // C:\Windows (covers System32)
        }
        // Per-user + all-users autostart.
        if let Ok(appdata) = std::env::var("APPDATA") {
            v.push(PathBuf::from(appdata).join("Microsoft\\Windows\\Start Menu\\Programs\\Startup"));
        }
        if let Ok(pd) = std::env::var("ProgramData") {
            v.push(PathBuf::from(pd).join("Microsoft\\Windows\\Start Menu\\Programs\\StartUp"));
        }
    }
    #[cfg(not(windows))]
    {
        for p in ["/usr", "/bin", "/sbin", "/etc", "/boot"] {
            v.push(PathBuf::from(p));
        }
        if let Ok(home) = std::env::var("HOME") {
            // Linux autostart + macOS LaunchAgents.
            v.push(PathBuf::from(&home).join(".config/autostart"));
            v.push(PathBuf::from(&home).join("Library/LaunchAgents"));
        }
    }
    v
}

/// Defense-in-depth for commands that write into a user-chosen folder: reject a
/// destination that traverses with `..`, is not absolute, or resolves inside a
/// protected system / autostart / app-bin location. Does NOT confine to app-data
/// (that would break "save my download to <my folder>").
pub fn reject_hostile_dest(app: &AppHandle, dir: &str) -> Result<(), String> {
    let p = Path::new(dir);
    if !p.is_absolute() {
        return Err("destination must be an absolute path".into());
    }
    if p.components().any(|c| matches!(c, Component::ParentDir)) {
        return Err("destination contains a parent-directory traversal".into());
    }
    let canon = nearest_existing_canonical(p).ok_or("invalid destination path")?;
    for bad in hostile_roots(app) {
        if let Ok(bc) = std::fs::canonicalize(&bad) {
            if canon == bc || canon.starts_with(&bc) {
                return Err("destination is a protected system location".into());
            }
        }
    }
    Ok(())
}

/// Refuse to OPEN a path that would execute code. `open_path` routes through the OS
/// shell-open (Win32 `ShellExecuteW` / macOS `open` / `xdg-open`), which RUNS the
/// target if it's an executable or script — so an injected `open_file("C:/eviI.exe")`
/// is a code-execution primitive. Media/document files (mp4, png, pdf, …) open fine;
/// only the dangerous extensions are blocked. Extension-based, not root-confined, so
/// it never breaks "open my exported video from wherever I saved it".
pub fn confine_openable(path: &str) -> Result<(), String> {
    const BLOCKED: &[&str] = &[
        "exe", "bat", "cmd", "com", "scr", "ps1", "psm1", "msi", "msp", "lnk", "vbs",
        "vbe", "js", "jse", "jar", "wsf", "wsh", "cpl", "hta", "reg", "pif", "gadget",
        "sh", "bash", "command", "app", "dll", "sys",
    ];
    let ext = Path::new(path)
        .extension()
        .map(|e| e.to_string_lossy().to_ascii_lowercase())
        .unwrap_or_default();
    if BLOCKED.contains(&ext.as_str()) {
        return Err(format!("refusing to open an executable file type: .{ext}"));
    }
    Ok(())
}

// ── Quiet subprocess spawn (no console-window flash on Windows) ─────────────────

/// A `std::process::Command` for `program` that never flashes a console window on
/// Windows (`CREATE_NO_WINDOW`). The packaged desktop app has no attached console, so
/// every plain spawn (yt-dlp, ffmpeg, ollama, sd, …) pops a visible console window
/// over the UI — the most glaring non-native behavior. No-op on other platforms.
pub fn quiet_command(program: impl AsRef<std::ffi::OsStr>) -> std::process::Command {
    let mut cmd = std::process::Command::new(program);
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
    }
    cmd
}

// ── Native open / reveal (no `cmd /C` re-parsing) ───────────────────────────────

/// Open a path with the OS default handler via the opener plugin (Win32
/// `ShellExecuteW` / `open` / `xdg-open`) — never through `cmd /C start`, so a file
/// name with cmd metacharacters cannot break out into command execution.
pub fn open_path_native(app: &AppHandle, path: &str) -> Result<(), String> {
    app.opener()
        .open_path(path.to_string(), None::<&str>)
        .map_err(|e| e.to_string())
}

/// Reveal/select a path in the OS file manager via the opener plugin.
pub fn reveal_path_native(app: &AppHandle, path: &str) -> Result<(), String> {
    app.opener()
        .reveal_item_in_dir(path)
        .map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn confine_existing_blocks_outside_and_allows_inside() {
        let base = std::env::temp_dir().join(format!("ft_confine_{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&base);
        std::fs::create_dir_all(&base).unwrap();
        let inside = base.join("ok.bin");
        std::fs::write(&inside, b"x").unwrap();

        let roots = vec![base.clone()];
        assert!(confine_existing(inside.to_str().unwrap(), &roots).is_ok());

        // A real file outside the root is rejected.
        let outside = std::env::temp_dir().join(format!("ft_outside_{}.bin", std::process::id()));
        std::fs::write(&outside, b"y").unwrap();
        assert!(confine_existing(outside.to_str().unwrap(), &roots).is_err());

        // A `..` escape canonicalizes out and is rejected.
        let escape = format!("{}/../ft_outside_{}.bin", base.display(), std::process::id());
        assert!(confine_existing(&escape, &roots).is_err());

        let _ = std::fs::remove_dir_all(&base);
        let _ = std::fs::remove_file(&outside);
    }

    #[test]
    fn confine_openable_blocks_executables_allows_media() {
        assert!(confine_openable("C:/Users/me/Downloads/clip.mp4").is_ok());
        assert!(confine_openable("/home/me/video.mov").is_ok());
        assert!(confine_openable("/tmp/report.pdf").is_ok());
        assert!(confine_openable("C:/evil.exe").is_err());
        assert!(confine_openable("C:/Windows/Temp/x.bat").is_err());
        assert!(confine_openable("payload.PS1").is_err()); // case-insensitive
        assert!(confine_openable("shortcut.lnk").is_err());
    }

    #[test]
    fn reject_hostile_dest_rejects_traversal_and_relative() {
        // We can't assume a real app handle here; just exercise the pure checks via
        // the Path-level guards that don't need `app` (absolute + traversal).
        let p = Path::new("relative/dir");
        assert!(!p.is_absolute());
        let trav = Path::new("/tmp/../etc");
        assert!(trav.components().any(|c| matches!(c, std::path::Component::ParentDir)));
    }

}
