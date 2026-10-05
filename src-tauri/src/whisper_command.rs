//! Tauri bridge for on-device Whisper transcription.
//!
//! The heavy lifting lives in the Tauri-free `local-whisper` crate (whisper.cpp).
//! This module is the only Tauri glue: it downloads the GGML model into the
//! app-data dir (from `sources::WHISPER_MODEL_BASE_URL`) and runs transcription,
//! streaming progress events back to the UI.

use std::path::PathBuf;
use std::time::Duration;

use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager};

/// HTTP agent with a connect + idle-read timeout. The read timeout is per-read
/// (an *idle* timeout), so a slow-but-steady multi-hundred-MB model download is
/// fine — only a hung connection (no bytes for the window) aborts. 60s because the
/// download resumes from disk on abort (see deps_command::stream_resumable), so a
/// quick failover beats a long freeze. Without this a dead CDN would hang forever.
fn http_agent() -> ureq::Agent {
    ureq::AgentBuilder::new()
        .timeout_connect(Duration::from_secs(30))
        .timeout_read(Duration::from_secs(60))
        .build()
}

/// Map a model size to its GGML filename (the download URL is
/// `<sources::WHISPER_MODEL_BASE_URL>/<filename>`).
fn model_file(size: &str) -> Result<String, String> {
    let name = match size {
        "tiny" => "ggml-tiny.bin",
        "base" => "ggml-base.bin",
        "small" => "ggml-small.bin",
        other => return Err(format!("unknown whisper model size: {other}")),
    };
    Ok(name.to_string())
}

/// `<app_data_dir>/models/whisper/ggml-<size>.bin` (a downloaded/upgraded copy).
fn model_path(app: &AppHandle, size: &str) -> Result<PathBuf, String> {
    let name = model_file(size)?;
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("no app data dir: {e}"))?
        .join("models")
        .join("whisper");
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir.join(name))
}

/// The downloaded model file. Errs when it is not downloaded yet.
fn resolve_model(app: &AppHandle, size: &str) -> Result<PathBuf, String> {
    let downloaded = model_path(app, size)?;
    if downloaded.metadata().map(|m| m.len() > 0).unwrap_or(false) {
        return Ok(downloaded);
    }
    Err(format!("whisper model '{size}' is not downloaded yet"))
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WhisperModelStatus {
    installed: bool,
    path: String,
    size_bytes: u64,
}

/// Is the chosen model already downloaded?
#[tauri::command]
pub fn whisper_model_status(app: AppHandle, size: String) -> Result<WhisperModelStatus, String> {
    let path = model_path(&app, &size)?;
    if let Some(m) = std::fs::metadata(&path).ok().filter(|m| m.len() > 0) {
        return Ok(WhisperModelStatus {
            installed: true,
            path: path.to_string_lossy().to_string(),
            size_bytes: m.len(),
        });
    }
    Ok(WhisperModelStatus {
        installed: false,
        path: path.to_string_lossy().to_string(),
        size_bytes: 0,
    })
}

#[derive(Clone, Serialize)]
struct ModelProgress {
    received: u64,
    total: u64,
    pct: i32,
}

/// Download the model once into the app-data dir, emitting `whisper_model_progress`.
/// Idempotent: returns immediately if already present. Returns the model path.
///
/// `(async)` keeps the multi-hundred-MB download off the webview main thread.
#[tauri::command(async)]
pub fn whisper_download_model(app: AppHandle, size: String) -> Result<String, String> {
    let path = model_path(&app, &size)?;
    if path.metadata().map(|m| m.len() > 0).unwrap_or(false) {
        return Ok(path.to_string_lossy().to_string());
    }
    let name = model_file(&size)?;
    let urls = vec![format!("{}/{name}", crate::sources::WHISPER_MODEL_BASE_URL)];

    // Download with resume (the shared, logged core): a dropped 148 MB pull
    // CONTINUES from the bytes already on disk instead of restarting. Emits
    // `whisper_model_progress` as bytes land.
    let mut last_pct = -1i32;
    crate::deps_command::download_resumable_fallback(
        &http_agent(),
        &urls,
        &path,
        &format!("whisper {size}"),
        |received, total| {
            let pct = if total > 0 { (received * 100 / total) as i32 } else { -1 };
            if pct != last_pct {
                last_pct = pct;
                let _ = app.emit(
                    "whisper_model_progress",
                    ModelProgress { received, total, pct },
                );
            }
        },
    )?;
    let _ = app.emit(
        "whisper_model_progress",
        ModelProgress { received: 0, total: 0, pct: 100 },
    );
    Ok(path.to_string_lossy().to_string())
}

#[derive(Clone, Serialize)]
struct TranscribeProgress {
    pct: i32,
}

/// Transcribe raw audio bytes entirely on-device. Returns the
/// `local_whisper::Transcript` JSON (serialises to the frontend's `VoiceAnalysis`).
/// Emits `transcribe_progress`.
///
/// The audio rides the RAW request body (see lib/tauri-bytes.ts) instead of a JSON
/// number array — the same transport the media store uses — so a large voiceover
/// doesn't bloat ~3.5× as a string or freeze the webview; `language` / `modelSize`
/// come in as base64 headers.
///
/// `(async)` runs the whisper.cpp transcription on Tauri's worker pool so the UI
/// stays responsive while audio is being transcribed.
#[tauri::command(async)]
pub fn transcribe_local(
    app: AppHandle,
    request: tauri::ipc::Request<'_>,
) -> Result<local_whisper::Transcript, String> {
    let language = crate::staging::header_str(&request, "language")
        .unwrap_or_else(|| "auto".into());
    let model_size = crate::staging::header_str(&request, "model-size")
        .ok_or("transcribe_local: missing model-size header")?;
    // Raw body, or a chunk-streamed staging file for a long (>24MB) voiceover — a WAV
    // that big would OOM the webview as one buffer, so invokeWithBytes streams it and
    // body_or_staged reassembles it here (see lib/tauri-bytes.ts).
    let audio = crate::staging::body_or_staged(&request)?;

    let model = resolve_model(&app, &model_size)?;

    // whisper reads from a file; the native ffmpeg decoder probes content, so no
    // extension is needed. Keep it on this machine — never uploaded. A per-process
    // unique name avoids two concurrent transcriptions clobbering one temp file.
    let dir = crate::branding::temp_dir("whisper");
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let input = dir.join(format!("input-{}.audio", crate::staging::unique_suffix()));
    std::fs::write(&input, audio).map_err(|e| e.to_string())?;

    let app_cb = app.clone();
    let mut last_pct = -1i32;
    let progress = move |pct: i32| {
        if pct != last_pct {
            last_pct = pct;
            let _ = app_cb.emit("transcribe_progress", TranscribeProgress { pct });
        }
    };

    let result = local_whisper::transcribe(
        &model.to_string_lossy(),
        &input.to_string_lossy(),
        &language,
        progress,
    )
    .map_err(|e| format!("transcription failed: {e}"));

    let _ = std::fs::remove_file(&input);
    let _ = app.emit("transcribe_progress", TranscribeProgress { pct: 100 });
    result
}
