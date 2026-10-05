//! Raw-body IPC helpers + chunk-streamed staging for large media, and the temp
//! "clip" sink the local ffmpeg tools read their inputs from.
//!
//! Passing a large blob across the Tauri bridge as ONE buffer makes the WebView2
//! renderer materialize the whole file in its heap (a 500 MB file spikes ~1.5 GB
//! and can OOM-kill the webview). Instead the JS side (lib/tauri-bytes.ts,
//! lib/mp4-disk-writer.ts) streams big blobs here in small chunks
//! (`stage_append`) into a staging temp FILE; the target sink command then reads
//! the assembled file via `body_or_staged`. A command that receives no
//! `stage-token` header behaves exactly as a plain raw-body command.

use base64::Engine;

use crate::branding;

/// Base64-decode a raw-IPC request header (see lib/tauri-bytes.ts) → String. Values
/// are base64 so a Unicode id/filename survives an ASCII-only HTTP header.
pub(crate) fn header_str(request: &tauri::ipc::Request<'_>, key: &str) -> Option<String> {
    let raw = request.headers().get(key)?.to_str().ok()?;
    let bytes = base64::engine::general_purpose::STANDARD.decode(raw).ok()?;
    String::from_utf8(bytes).ok()
}

/// The raw body bytes of a request sent via `invokeWithBytes` — an error if the caller
/// sent JSON instead (which would defeat the whole point: no JSON number arrays).
pub(crate) fn raw_body<'a>(request: &'a tauri::ipc::Request<'_>) -> Result<&'a [u8], String> {
    match request.body() {
        tauri::ipc::InvokeBody::Raw(b) => Ok(b),
        tauri::ipc::InvokeBody::Json(_) => Err("expected a raw request body".into()),
    }
}

/// `<temp>/<prefix>-stage` — where chunk-streamed uploads assemble. Swept by
/// `sweep_temp` (24h) like the other temp scratch dirs.
pub(crate) fn stage_dir() -> Result<std::path::PathBuf, String> {
    let dir = branding::temp_dir("stage");
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir)
}

/// Sanitize a client-supplied stage token to a safe file stem so it can never escape
/// the staging dir.
fn safe_stage_token(token: &str) -> String {
    let cleaned: String = token
        .chars()
        .map(|c| if c.is_ascii_alphanumeric() || c == '-' || c == '_' { c } else { '_' })
        .collect();
    if cleaned.is_empty() { "stage".into() } else { cleaned }
}

/// The staging temp-file path for a token (`<stage dir>/<token>.part`).
pub(crate) fn staged_path_for(token: &str) -> Result<std::path::PathBuf, String> {
    Ok(stage_dir()?.join(format!("{}.part", safe_stage_token(token))))
}

/// Append one chunk of a chunk-streamed upload. `seq=0` TRUNCATES/creates the file so a
/// reused token starts clean; later chunks append. Bytes ride the RAW body; `token`/`seq`
/// are base64 headers (see lib/tauri-bytes.ts). `(async)` — off the webview main thread.
#[tauri::command(async)]
pub fn stage_append(request: tauri::ipc::Request<'_>) -> Result<(), String> {
    use std::io::Write;
    let token = header_str(&request, "token").ok_or("stage_append: missing token header")?;
    let seq: u64 = header_str(&request, "seq").and_then(|s| s.parse().ok()).unwrap_or(0);
    let bytes = raw_body(&request)?;
    let path = staged_path_for(&token)?;
    let mut f = std::fs::OpenOptions::new()
        .create(true)
        .write(true)
        .append(seq != 0)   // seq 0 → fresh (truncate); later chunks append
        .truncate(seq == 0)
        .open(&path)
        .map_err(|e| e.to_string())?;
    f.write_all(bytes).map_err(|e| e.to_string())?;
    Ok(())
}

/// Discard a staged upload (best-effort) — called by the JS side if a chunk stream
/// fails partway, so a partial `.part` doesn't linger until the 24h sweep.
#[tauri::command(async)]
pub fn stage_discard(token: String) -> Result<(), String> {
    if let Ok(p) = staged_path_for(&token) {
        let _ = std::fs::remove_file(p);
    }
    Ok(())
}

/// Promote a completed staged file into the export temp dir under `file_name`, returning
/// its absolute path. Used by the disk-streamed MP4 encoder (lib/mp4-disk-writer.ts): the
/// encoder streams the MP4 straight to `<stage>/<token>.part` (so the whole file never sits
/// in the webview heap), then promotes it to a stable, `read_file_bytes`-readable path. The
/// move is a rename on the same volume (copy+remove across volumes).
#[tauri::command(async)]
pub fn stage_promote(token: String, file_name: String) -> Result<String, String> {
    let staged = staged_path_for(&token)?;
    let dir = branding::temp_dir("export");
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let safe = std::path::Path::new(&file_name)
        .file_name()
        .map(|n| n.to_string_lossy().to_string())
        .filter(|n| !n.is_empty())
        .unwrap_or_else(|| format!("{}.mp4", safe_stage_token(&token)));
    let dest = dir.join(&safe);
    if std::fs::rename(&staged, &dest).is_err() {
        std::fs::copy(&staged, &dest).map_err(|e| e.to_string())?;
        let _ = std::fs::remove_file(&staged);
    }
    Ok(dest.to_string_lossy().to_string())
}

/// Read a sink command's bytes, transparently supporting the chunk-streamed path: with a
/// `stage-token` header the bytes were streamed to a staging temp file (stage_append) —
/// read that file and delete it; otherwise the bytes ride the RAW body.
pub(crate) fn body_or_staged(request: &tauri::ipc::Request<'_>) -> Result<Vec<u8>, String> {
    if let Some(token) = header_str(request, "stage-token") {
        let path = staged_path_for(&token)?;
        let bytes = std::fs::read(&path).map_err(|e| format!("staged read failed: {e}"))?;
        let _ = std::fs::remove_file(&path);
        Ok(bytes)
    } else {
        Ok(raw_body(request)?.to_vec())
    }
}

/// A per-process-monotonic suffix (`<pid>-<seq>`) for temp/`.part` file names, so two
/// concurrent writers in the same process never clobber each other's temp file.
pub(crate) fn unique_suffix() -> String {
    use std::sync::atomic::{AtomicU64, Ordering};
    static SEQ: AtomicU64 = AtomicU64::new(0);
    format!("{}-{}", std::process::id(), SEQ.fetch_add(1, Ordering::Relaxed))
}

/// Write a browser-local file's bytes to a temp file so the local ffmpeg tools
/// (tools_command.rs) can read it from disk — nothing is uploaded. Returns the
/// absolute path. `(async)` — a large write must never freeze the UI.
#[tauri::command(async)]
pub fn export_save_clip(request: tauri::ipc::Request<'_>) -> Result<String, String> {
    // Bytes ride the RAW body (or a chunk-streamed staging file for large inputs —
    // body_or_staged handles both); the file name is a header.
    let file_name = header_str(&request, "file-name").unwrap_or_else(|| "clip.bin".into());
    let bytes = body_or_staged(&request)?;
    // Keep only a safe basename (defend against path traversal in file_name).
    let safe = std::path::Path::new(&file_name)
        .file_name()
        .map(|n| n.to_string_lossy().to_string())
        .filter(|n| !n.is_empty())
        .unwrap_or_else(|| "clip.bin".into());
    let dir = branding::temp_dir("export");
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    // Unique per call so two inputs with the same name (or two concurrent tools)
    // never overwrite each other.
    let path = dir.join(format!("{}-{safe}", unique_suffix()));
    std::fs::write(&path, bytes).map_err(|e| e.to_string())?;
    Ok(path.to_string_lossy().to_string())
}

/// Best-effort startup hygiene: delete stale files in the app's `%TEMP%` scratch
/// dirs (export/merge inputs, whisper audio, staging) older than 24h. A crashed or
/// force-quit run can leave large temp files behind. Never fails the launch.
pub fn sweep_temp() {
    let cutoff = std::time::Duration::from_secs(24 * 3600);
    let now = std::time::SystemTime::now();
    for name in ["export", "whisper", "stage"] {
        let dir = branding::temp_dir(name);
        let Ok(rd) = std::fs::read_dir(&dir) else { continue };
        for entry in rd.flatten() {
            let Ok(meta) = entry.metadata() else { continue };
            if !meta.is_file() {
                continue;
            }
            let stale = meta
                .modified()
                .ok()
                .and_then(|m| now.duration_since(m).ok())
                .map(|age| age > cutoff)
                .unwrap_or(false);
            if stale {
                let _ = std::fs::remove_file(entry.path());
            }
        }
    }
}
