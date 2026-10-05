//! First-launch dependency downloads (ffmpeg, yt-dlp) + the shared resumable
//! download primitive every other downloader (Whisper, TTS models) uses.
//!
//! Heavy external tools are NOT bundled in the installer — they download once from
//! their upstream release pages (URLs: `sources.rs`) into `<app_data>/bin/`, so
//! users never install anything by hand. `lib.rs` `setup()` prepends that dir to
//! `PATH` and points `FFMPEG_PATH` at the binary, so the whisper crate + the local
//! ffmpeg tools (which resolve ffmpeg via that env / PATH) and the yt-dlp commands
//! just work.

use std::io::{Read, Write};
use std::path::PathBuf;
use std::time::Duration;

use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager};

use crate::sources::{FFMPEG_ZIP_URLS, YTDLP_URL};

/// HTTP agent with connect + idle-read timeouts. Downloads the ffmpeg / yt-dlp
/// binaries on first launch; without a timeout a slow release host would hang
/// the app on first run. Idle-read (per-read) so a steady large download isn't
/// aborted — only a genuinely silent connection is. Kept at 60s because downloads are
/// now RESUMABLE (see `stream_resumable`): an over-eager abort just resumes from the
/// bytes already on disk, so failing over fast is strictly better than a long freeze.
fn http_agent() -> ureq::Agent {
    ureq::AgentBuilder::new()
        .timeout_connect(Duration::from_secs(30))
        .timeout_read(Duration::from_secs(60))
        .build()
}


/// Env var pointing at the downloaded ffmpeg binary (read by crates/whisper and
/// tools_command.rs; falls back to `ffmpeg` on PATH when unset).
pub const FFMPEG_ENV: &str = "FFMPEG_PATH";

pub(crate) fn exe_name(stem: &str) -> String {
    if cfg!(windows) { format!("{stem}.exe") } else { stem.to_string() }
}

/// Mark a freshly-downloaded binary executable (no-op on Windows, where the
/// `.exe` extension is what makes it runnable).
pub(crate) fn make_executable(path: &std::path::Path) {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        if let Ok(meta) = std::fs::metadata(path) {
            let mut perms = meta.permissions();
            perms.set_mode(0o755);
            let _ = std::fs::set_permissions(path, perms);
        }
    }
    #[cfg(not(unix))]
    let _ = path;
}

/// `<app_data>/bin` — where downloaded tool binaries live. Created if missing.
pub fn bin_dir(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("no app data dir: {e}"))?
        .join("bin");
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir)
}

fn ffmpeg_path(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(bin_dir(app)?.join(exe_name("ffmpeg")))
}

fn ytdlp_path(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(bin_dir(app)?.join(exe_name("yt-dlp")))
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BinStatus {
    installed: bool,
    path: String,
    size_bytes: u64,
}

fn status_of(path: &PathBuf) -> BinStatus {
    let meta = std::fs::metadata(path).ok();
    BinStatus {
        installed: meta.as_ref().map(|m| m.len() > 0).unwrap_or(false),
        path: path.to_string_lossy().to_string(),
        size_bytes: meta.map(|m| m.len()).unwrap_or(0),
    }
}

#[derive(Clone, Serialize)]
struct DownloadProgress {
    received: u64,
    total: u64,
    pct: i32,
}

/// Parse the total length out of a `Content-Range: bytes START-END/TOTAL` header.
fn content_range_total(h: &str) -> Option<u64> {
    h.rsplit('/').next().and_then(|s| s.trim().parse::<u64>().ok())
}

/// Parse the START offset out of a `Content-Range: bytes START-END/TOTAL` header.
fn content_range_start(h: &str) -> Option<u64> {
    h.split_whitespace()
        .nth(1) // "START-END/TOTAL"
        .and_then(|r| r.split('-').next())
        .and_then(|s| s.trim().parse::<u64>().ok())
}

/// Stream one `url` into `part`, RESUMING from the file's current length via an HTTP
/// `Range` request when it already holds bytes — a dropped multi-hundred-MB download
/// continues instead of restarting from zero (the root cause of "stuck at 80%" on a
/// flaky connection). Appends on a `206`; if the server ignores the range and replies
/// `200`, restarts cleanly (truncates). Calls `on_progress(received, total)` as bytes
/// arrive. On success returns the final byte count; on a mid-stream / connect error it
/// returns `Err` and LEAVES `part` on disk so the caller can resume. `total` is 0 when
/// the server sends no length.
///
/// This is the ONE download primitive shared by ffmpeg/yt-dlp (via
/// `download_with_progress_fallback`), the TTS models, and Whisper — get it right once.
pub(crate) fn stream_resumable<F: FnMut(u64, u64)>(
    agent: &ureq::Agent,
    url: &str,
    part: &PathBuf,
    mut on_progress: F,
) -> Result<u64, String> {
    let have: u64 = std::fs::metadata(part).map(|m| m.len()).unwrap_or(0);
    let mut req = agent.get(url);
    if have > 0 {
        req = req.set("Range", &format!("bytes={have}-"));
    }
    let resp = match req.call() {
        Ok(r) => r,
        // A stale/over-long `.part` (>= total) yields 416 — drop it so the next attempt
        // re-downloads cleanly from zero instead of wedging.
        Err(ureq::Error::Status(416, _)) => {
            let _ = std::fs::remove_file(part);
            return Err("range not satisfiable (cleared stale partial)".to_string());
        }
        Err(e) => return Err(format!("request failed: {e}")),
    };

    // 206 → the server honoured the resume; append. Anything else (200) → start clean.
    let resumed = resp.status() == 206;
    if resumed {
        // Guard against a server resuming at the WRONG offset (a broken proxy) — splicing a
        // mismatched body would silently corrupt the file. Drop & restart if it doesn't line up.
        let start = resp.header("Content-Range").and_then(content_range_start);
        if start != Some(have) {
            let _ = std::fs::remove_file(part);
            return Err(format!("resume offset mismatch (wanted {have}, got {start:?})"));
        }
    }
    let total: u64 = if resumed {
        resp.header("Content-Range").and_then(content_range_total).unwrap_or(0)
    } else {
        resp.header("Content-Length").and_then(|s| s.parse::<u64>().ok()).unwrap_or(0)
    };
    let mut received: u64 = if resumed { have } else { 0 };
    let mut out = if resumed {
        std::fs::OpenOptions::new().append(true).open(part).map_err(|e| e.to_string())?
    } else {
        std::fs::File::create(part).map_err(|e| e.to_string())? // truncate → clean restart
    };

    let mut reader = resp.into_reader();
    let mut buf = vec![0u8; 1 << 16];
    on_progress(received, total);
    loop {
        let n = reader.read(&mut buf).map_err(|e| e.to_string())?;
        if n == 0 {
            break;
        }
        out.write_all(&buf[..n]).map_err(|e| e.to_string())?;
        received += n as u64;
        on_progress(received, total);
    }
    out.flush().map_err(|e| e.to_string())?;
    drop(out);
    // A truncated read LEAVES `part` in place (do NOT delete) so the next attempt resumes
    // from `received` rather than re-downloading everything.
    if total > 0 && received != total {
        return Err(format!("incomplete: {received}/{total} bytes"));
    }
    Ok(received)
}

/// Download `urls` into `dest`, RESUMING across attempts: a dropped connection or a
/// stalled source continues from the bytes already on disk instead of restarting, and
/// the next source is tried with that partial preserved. ONE per-CALL `.part` (unique,
/// so concurrent downloads of the same `dest` never collide) is reused across every
/// attempt. `on_progress(received, total)` streams progress; each attempt logs its
/// source + resume offset (log target `"download"`) so a "stuck at X%" report becomes
/// diagnosable from the user's log file. Renames to `dest` once complete. `what` labels
/// the logs (e.g. "whisper base"). Errs only if every source is exhausted with no progress.
pub(crate) fn download_resumable_fallback<F: FnMut(u64, u64)>(
    agent: &ureq::Agent,
    urls: &[String],
    dest: &PathBuf,
    what: &str,
    mut on_progress: F,
) -> Result<u64, String> {
    if urls.is_empty() {
        return Err("no download source available".to_string());
    }
    let part = dest.with_extension(format!("{}.part", crate::staging::unique_suffix()));
    let _ = std::fs::remove_file(&part); // this call starts fresh (no stale partial)
    let max_attempts = (urls.len() * 3).max(6);
    let mut best: u64 = 0;
    let mut idle_cycle = 0usize; // attempts since the byte count last advanced
    let mut last = "no download source available".to_string();
    for attempt in 0..max_attempts {
        let url = &urls[attempt % urls.len()];
        let have = std::fs::metadata(&part).map(|m| m.len()).unwrap_or(0);
        log::info!(target: "download",
            "{what}: attempt {}/{} from {url} (resume @ {have} bytes)", attempt + 1, max_attempts);
        match stream_resumable(agent, url, &part, &mut on_progress) {
            Ok(n) => match std::fs::rename(&part, dest) {
                Ok(()) => {
                    log::info!(target: "download", "{what}: complete ({n} bytes)");
                    return Ok(n);
                }
                Err(e) => {
                    let _ = std::fs::remove_file(&part);
                    return Err(format!("failed to save {what}: {e}"));
                }
            },
            Err(e) => {
                let now = std::fs::metadata(&part).map(|m| m.len()).unwrap_or(0);
                log::warn!(target: "download",
                    "{what}: attempt {} via {url} stopped at {now} bytes: {e}", attempt + 1);
                last = format!("{e} (source: {url})");
                if now > best {
                    best = now;
                    idle_cycle = 0;
                } else {
                    idle_cycle += 1;
                    // A full cycle over every source with ZERO new bytes ⇒ genuinely stuck
                    // (all 404 / all dead), not a transient drop — stop instead of spinning.
                    if idle_cycle >= urls.len() {
                        break;
                    }
                }
            }
        }
    }
    let _ = std::fs::remove_file(&part);
    Err(last)
}

/// The download-candidate list for one source (empty when the URL is blank).
pub(crate) fn candidates(url: &str) -> Vec<String> {
    let u = url.trim();
    if u.is_empty() { Vec::new() } else { vec![u.to_string()] }
}

/// Try each URL in order with RESUME across attempts, emitting `event` (a
/// `DownloadProgress`) as bytes arrive. A transient drop retries without discarding
/// the bytes already on disk. Thin wrapper over `download_resumable_fallback` — the
/// shared, logged, resumable core. Used by ffmpeg and yt-dlp.
pub(crate) fn download_with_progress_fallback(
    app: &AppHandle,
    urls: &[String],
    dest: &PathBuf,
    event: &str,
) -> Result<(), String> {
    // Label the download logs after the progress event (e.g. "ffmpeg_download_progress"
    // → "ffmpeg").
    let what = event.trim_end_matches("_progress").trim_end_matches("_download");
    let mut last_pct = -1i32;
    download_resumable_fallback(&http_agent(), urls, dest, what, |received, total| {
        let pct = if total > 0 { (received * 100 / total) as i32 } else { -1 };
        if pct != last_pct {
            last_pct = pct;
            let _ = app.emit(event, DownloadProgress { received, total, pct });
        }
    })
    .map(|_| ())
}

// ── ffmpeg ──────────────────────────────────────────────────────────────────

#[tauri::command(async)]
pub fn ffmpeg_status(app: AppHandle) -> Result<BinStatus, String> {
    Ok(status_of(&ffmpeg_path(&app)?))
}

/// Download a static ffmpeg build and extract just `ffmpeg(.exe)` into `bin/`.
/// Idempotent. Emits `ffmpeg_download_progress`. Returns the ffmpeg path.
/// Sources: `sources::FFMPEG_ZIP_URLS`, tried in order (Gyan builds on Windows, evermeet on macOS).
/// `(async)` — download + zip-extract must not block the webview main thread.
#[tauri::command(async)]
pub fn ffmpeg_download(app: AppHandle) -> Result<String, String> {
    let dest = ffmpeg_path(&app)?;
    if dest.metadata().map(|m| m.len() > 0).unwrap_or(false) {
        std::env::set_var(FFMPEG_ENV, &dest);
        return Ok(dest.to_string_lossy().to_string());
    }

    // 1) download the archive (progress streamed to the UI).
    let zip_path = bin_dir(&app)?.join("ffmpeg-download.zip");
    let urls: Vec<String> = FFMPEG_ZIP_URLS.iter().map(|u| u.to_string()).collect();
    download_with_progress_fallback(&app, &urls, &zip_path, "ffmpeg_download_progress")?;

    // 2) extract only bin/ffmpeg(.exe) — nothing here uses ffprobe.
    let file = std::fs::File::open(&zip_path).map_err(|e| e.to_string())?;
    let mut archive = zip::ZipArchive::new(std::io::BufReader::new(file))
        .map_err(|e| format!("ffmpeg archive open failed: {e}"))?;
    // Match by basename so both layouts work: Windows `…/bin/ffmpeg.exe` and the
    // macOS evermeet zip's root-level `ffmpeg`.
    let want = exe_name("ffmpeg");
    let mut extracted = false;
    for i in 0..archive.len() {
        let mut entry = archive.by_index(i).map_err(|e| e.to_string())?;
        let name = entry.name().replace('\\', "/");
        let base = name.rsplit('/').next().unwrap_or(name.as_str());
        if base == want {
            // Per-call-unique `.part` (like the download primitive) so concurrent extracts
            // don't clobber one temp file; the atomic rename publishes a whole binary.
            let part = dest.with_extension(format!("{}.part", crate::staging::unique_suffix()));
            let mut out = std::fs::File::create(&part).map_err(|e| e.to_string())?;
            std::io::copy(&mut entry, &mut out).map_err(|e| e.to_string())?;
            out.flush().map_err(|e| e.to_string())?;
            drop(out);
            std::fs::rename(&part, &dest).map_err(|e| e.to_string())?;
            make_executable(&dest);
            extracted = true;
            break;
        }
    }
    let _ = std::fs::remove_file(&zip_path);
    if !extracted {
        return Err("ffmpeg binary not found inside the downloaded archive".into());
    }

    // Point whisper + the ffmpeg tools at it for THIS session (no restart needed).
    std::env::set_var(FFMPEG_ENV, &dest);
    let _ = app.emit(
        "ffmpeg_download_progress",
        DownloadProgress { received: 0, total: 0, pct: 100 },
    );
    Ok(dest.to_string_lossy().to_string())
}

// ── yt-dlp ──────────────────────────────────────────────────────────────────

#[tauri::command(async)]
pub fn ytdlp_status(app: AppHandle) -> Result<BinStatus, String> {
    Ok(status_of(&ytdlp_path(&app)?))
}

/// Download the yt-dlp binary into `bin/` (a single exe — no archive) from
/// `sources::YTDLP_URL` (the yt-dlp GitHub release). Idempotent. Emits
/// `ytdlp_download_progress`. The downloaded copy is found by the `ytdlp_*`
/// commands because `bin/` is on PATH (see lib.rs setup).
/// `(async)` — keep the network download off the webview main thread.
#[tauri::command(async)]
pub fn ytdlp_download(app: AppHandle) -> Result<String, String> {
    let dest = ytdlp_path(&app)?;
    if dest.metadata().map(|m| m.len() > 0).unwrap_or(false) {
        return Ok(dest.to_string_lossy().to_string());
    }
    let urls = candidates(YTDLP_URL);
    download_with_progress_fallback(&app, &urls, &dest, "ytdlp_download_progress")?;
    make_executable(&dest);
    let _ = app.emit(
        "ytdlp_download_progress",
        DownloadProgress { received: 0, total: 0, pct: 100 },
    );
    Ok(dest.to_string_lossy().to_string())
}

#[cfg(test)]
mod tests {
    use super::{content_range_start, content_range_total};

    #[test]
    fn parses_content_range_total_and_start() {
        // Real HF/GitHub shape: "bytes START-END/TOTAL".
        assert_eq!(content_range_total("bytes 0-0/147951465"), Some(147951465));
        assert_eq!(content_range_start("bytes 0-0/147951465"), Some(0));
        // A mid-file resume (what a dropped download re-requests).
        assert_eq!(content_range_total("bytes 59000000-147951464/147951465"), Some(147951465));
        assert_eq!(content_range_start("bytes 59000000-147951464/147951465"), Some(59000000));
    }

    #[test]
    fn rejects_unparseable_content_range() {
        // Unknown total ("*") ⇒ None, so completeness can't be falsely asserted.
        assert_eq!(content_range_total("bytes 0-0/*"), None);
        assert_eq!(content_range_start("garbage"), None);
        assert_eq!(content_range_total(""), None);
    }
}
