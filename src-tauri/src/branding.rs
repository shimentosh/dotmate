//! Product identity used by the native side (tray tooltip, dialog titles, temp and
//! log file names). Rebranding: edit these together with `brand.config.ts` and
//! the literal names in `tauri.conf.json`.

/// Display name (tray tooltip / menu, dialog titles, log banner).
pub const APP_NAME: &str = "DotMate";

/// Prefix for the app's `%TEMP%` scratch dirs (`<temp>/<prefix>-export`, …).
pub const TEMP_PREFIX: &str = "dotmate";

/// Env var that re-enables devtools + the WebView2 context menu in a release
/// build (for diagnosing packaged-build-only issues). Unset for normal users.
#[cfg_attr(debug_assertions, allow(dead_code))] // read only by Windows release builds
pub const DEVTOOLS_ENV: &str = "DOTMATE_DEVTOOLS";

/// `<temp>/<prefix>-<name>` — one of the app's temp scratch dirs.
pub fn temp_dir(name: &str) -> std::path::PathBuf {
    std::env::temp_dir().join(format!("{TEMP_PREFIX}-{name}"))
}
