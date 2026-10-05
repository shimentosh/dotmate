//! Tauri bridge for on-device neural TTS.
//!
//! Mirrors `whisper_command.rs`: resolves/downloads the model into the app-data
//! dir and runs synthesis, streaming download progress back to the UI. The heavy
//! lifting lives in the Tauri-free crates (`local-tts` = Kokoro over sherpa-onnx,
//! `supertonic-tts` = Supertonic 3 over `ort`) — this module is the only Tauri
//! glue. No Docker, no Python, no localhost server: a model downloads once, then
//! every call runs in-process and returns ready-to-play WAV bytes.
//!
//! Kokoro is sherpa-onnx's own redistribution (bundling espeak-ng data + tokens),
//! a `.tar.bz2` with a single top-level folder we strip on extract. It lands in
//! `<app_data>/models/tts/kokoro/`. Download URLs live in `sources.rs`.

use std::path::PathBuf;
use std::time::Duration;

use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager};

use local_tts::TtsEngine;

use crate::sources::{KOKORO_ARCHIVE_URL, SUPERTONIC_ARCHIVE_URL};

/// HTTP agent with a connect + idle-read timeout (per-read, so a steady
/// hundreds-of-MB download isn't aborted — only a silent connection). 60s because
/// downloads now resume from disk (see deps_command::stream_resumable), so a fast
/// failover beats a long freeze. Same shape as whisper_command.rs / deps_command.rs.
fn http_agent() -> ureq::Agent {
    ureq::AgentBuilder::new()
        .timeout_connect(Duration::from_secs(30))
        .timeout_read(Duration::from_secs(60))
        .build()
}

struct TtsModelSpec {
    engine: TtsEngine,
    /// `.tar.bz2` archive (one top-level folder, stripped on extract).
    url: &'static str,
    /// A file that must exist inside the model dir once installed.
    sentinel: &'static str,
}

/// id → engine + archive URL + sentinel file. The sherpa-onnx model:
///  * `kokoro` — Kokoro-82M multi-lang v1.0 (53 voices; sid picks the voice).
fn model_spec(id: &str) -> Result<TtsModelSpec, String> {
    match id {
        "kokoro" => Ok(TtsModelSpec {
            engine: TtsEngine::Kokoro,
            url: KOKORO_ARCHIVE_URL,
            sentinel: "model.onnx",
        }),
        other => Err(format!("unknown tts model: {other}")),
    }
}

/// `<app_data>/models/tts/<id>/` — the per-model directory (created if missing).
fn model_dir(app: &AppHandle, id: &str) -> Result<PathBuf, String> {
    // Validate the id first so an unknown id can't create a stray directory.
    model_spec(id)?;
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("no app data dir: {e}"))?
        .join("models")
        .join("tts")
        .join(id);
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir)
}

// ── Supertonic 3 (ort/ONNX Runtime) — separate engine from sherpa ───────────────
// The assets are NOT bundled: a single .tar.gz (onnx/ + voice_styles/ + the
// version-matched onnxruntime library) downloads on first use into
// <app_data>/models/supertonic/. There is no public source for that archive, so
// `sources::SUPERTONIC_ARCHIVE_URL` is empty by default and Supertonic reports
// itself unavailable (the UI hides it) unless the vendor set a URL at build time.

#[cfg(target_os = "windows")]
const ORT_DLL: &str = "onnxruntime.dll";
#[cfg(target_os = "macos")]
const ORT_DLL: &str = "libonnxruntime.dylib";
#[cfg(all(unix, not(target_os = "macos")))]
const ORT_DLL: &str = "libonnxruntime.so";

/// `<app_data>/models/supertonic/` — where the downloaded bundle is extracted.
fn supertonic_download_dir(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("no app data dir: {e}"))?
        .join("models")
        .join("supertonic");
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    // Strip the Windows \\?\ verbatim prefix — the ONNX Runtime builds child paths
    // with forward slashes, which are invalid inside a verbatim path. No-op elsewhere.
    Ok(strip_verbatim_prefix(dir))
}

/// Resolve the downloaded Supertonic assets. Errs when they are not installed yet
/// (the caller should download first).
fn supertonic_assets_dir(app: &AppHandle) -> Result<PathBuf, String> {
    let d = supertonic_download_dir(app)?;
    if d.join("onnx").join("vocoder.onnx").metadata().map(|m| m.len() > 0).unwrap_or(false) {
        return Ok(d);
    }
    Err("Supertonic voices are not downloaded yet".to_string())
}

/// Remove a Windows `\\?\` (verbatim) prefix so paths joined with `/` still resolve.
fn strip_verbatim_prefix(p: PathBuf) -> PathBuf {
    let s = p.to_string_lossy();
    if let Some(rest) = s.strip_prefix(r"\\?\UNC\") {
        PathBuf::from(format!(r"\\{rest}"))
    } else if let Some(rest) = s.strip_prefix(r"\\?\") {
        PathBuf::from(rest)
    } else {
        p
    }
}

/// In-process Supertonic synth → WAV bytes. `voice` is a style id ("M1".."F5").
fn supertonic_synthesize(app: &AppHandle, text: &str, voice: &str, speed: f32) -> Result<Vec<u8>, String> {
    let base = supertonic_assets_dir(app)?;
    // Keep alnum only so a voice id can't escape into a path; default to F1.
    let vid: String = voice.chars().filter(|c| c.is_ascii_alphanumeric()).collect();
    let vid = if vid.is_empty() { "F1".to_string() } else { vid };
    let voice_json = base.join("voice_styles").join(format!("{vid}.json"));
    if !voice_json.exists() {
        return Err(format!("Supertonic voice '{vid}' not found"));
    }
    let dll = base.join(ORT_DLL);
    if !dll.exists() {
        return Err("the Supertonic ONNX Runtime library is missing".to_string());
    }
    // Point ort (load-dynamic) at the runtime shipped in the archive, then run the
    // 4-model pipeline.
    supertonic_tts::set_runtime_dylib(&dll.to_string_lossy());
    supertonic_tts::synthesize(
        &base.join("onnx").to_string_lossy(),
        &voice_json.to_string_lossy(),
        text,
        "en",
        speed,
        8, // diffusion steps (Supertonic default)
    )
    .map_err(|e| format!("Supertonic synthesis failed: {e}"))
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TtsModelStatus {
    installed: bool,
    /// Usable on this build: installed, or a download source is configured.
    available: bool,
    path: String,
    size_bytes: u64,
}

/// Is the model already downloaded (sentinel present & non-empty), and can it be?
#[tauri::command]
pub fn tts_model_status(app: AppHandle, model: String) -> Result<TtsModelStatus, String> {
    // Supertonic: "installed" once its downloaded assets resolve; "available" only
    // when installed or a download URL was configured at build time.
    if model == "supertonic" {
        let resolved = supertonic_assets_dir(&app);
        let installed = resolved.is_ok();
        let path = resolved
            .ok()
            .or_else(|| supertonic_download_dir(&app).ok())
            .map(|p| p.to_string_lossy().to_string())
            .unwrap_or_default();
        let available = installed || !SUPERTONIC_ARCHIVE_URL.trim().is_empty();
        return Ok(TtsModelStatus { installed, available, path, size_bytes: 0 });
    }
    let spec = model_spec(&model)?;
    let dir = model_dir(&app, &model)?;
    let sentinel = dir.join(spec.sentinel);
    let meta = std::fs::metadata(&sentinel).ok();
    Ok(TtsModelStatus {
        installed: meta.as_ref().map(|m| m.len() > 0).unwrap_or(false),
        available: true,
        path: dir.to_string_lossy().to_string(),
        size_bytes: meta.map(|m| m.len()).unwrap_or(0),
    })
}

#[derive(Clone, Serialize)]
struct ModelProgress {
    received: u64,
    total: u64,
    pct: i32,
}

/// Download + extract the model once into the app-data dir, emitting
/// `tts_model_progress`. Idempotent: returns immediately if already present.
/// Returns the model directory path.
///
/// `(async)` keeps the ~330 MB download + tar.bz2 extract off the webview thread.
///
/// A multi-file archive is extracted into a FRESH temp sibling dir, validated, then
/// atomically renamed into place — so an interrupted extract (disk full / crash / AV lock)
/// after the sentinel is written but before its siblings can NEVER leave a partial model
/// that the sentinel-only "installed" check treats as complete and never re-downloads.
fn unique_tmp_suffix() -> String {
    use std::sync::atomic::{AtomicU64, Ordering};
    static N: AtomicU64 = AtomicU64::new(0);
    format!("{}-{}", std::process::id(), N.fetch_add(1, Ordering::Relaxed))
}

#[tauri::command(async)]
pub fn tts_download_model(app: AppHandle, model: String) -> Result<String, String> {
    // Supertonic: a vendor-hosted .tar.gz bundle (see sources.rs).
    if model == "supertonic" {
        if let Ok(p) = supertonic_assets_dir(&app) {
            return Ok(p.to_string_lossy().to_string()); // already present
        }
        if SUPERTONIC_ARCHIVE_URL.trim().is_empty() {
            return Err("Supertonic voices are not available in this build (no download source configured).".to_string());
        }
        let dir = supertonic_download_dir(&app)?;
        // Extract into a fresh temp sibling dir, validate ALL required pieces, then swap it
        // into place (atomic publish — see unique_tmp_suffix).
        let parent = dir.parent().ok_or("bad supertonic dir")?;
        let tmp_dir = parent.join(format!(".supertonic.tmp-{}", unique_tmp_suffix()));
        let _ = std::fs::remove_dir_all(&tmp_dir);
        std::fs::create_dir_all(&tmp_dir).map_err(|e| e.to_string())?;
        let archive = tmp_dir.join("supertonic-3.tar.gz");
        // download_to_file_fallback uses a per-call unique `.part`, so two concurrent
        // downloads never share one temp file and interleave into a corrupt archive.
        let urls = crate::deps_command::candidates(SUPERTONIC_ARCHIVE_URL);
        let received = match download_to_file_fallback(&app, &urls, &archive, "supertonic") {
            Ok(n) => n,
            Err(e) => { let _ = std::fs::remove_dir_all(&tmp_dir); return Err(e); }
        };
        // Strips the single `supertonic-3/` folder → tmp/{onnx,voice_styles,<dll>}.
        let extracted = extract_tar_gz_stripped(&archive, &tmp_dir);
        let _ = std::fs::remove_file(&archive);
        if let Err(e) = extracted { let _ = std::fs::remove_dir_all(&tmp_dir); return Err(e); }
        // Validate EVERYTHING supertonic_synthesize needs (vocoder + runtime dll + at least
        // one voice), not just the sentinel — so a truncated archive can't publish an
        // "installed" but unusable model.
        let complete = tmp_dir.join("onnx").join("vocoder.onnx").metadata().map(|m| m.len() > 0).unwrap_or(false)
            && tmp_dir.join(ORT_DLL).exists()
            && std::fs::read_dir(tmp_dir.join("voice_styles")).map(|mut it| it.next().is_some()).unwrap_or(false);
        if !complete {
            let _ = std::fs::remove_dir_all(&tmp_dir);
            return Err("Supertonic archive extracted incomplete (missing vocoder / runtime / voices)".to_string());
        }
        // Atomic publish: drop any prior partial dir, rename the validated temp into place.
        let _ = std::fs::remove_dir_all(&dir);
        if let Err(e) = std::fs::rename(&tmp_dir, &dir) {
            let _ = std::fs::remove_dir_all(&tmp_dir);
            return Err(format!("failed to install Supertonic: {e}"));
        }
        let _ = app.emit(
            "tts_model_progress",
            ModelProgress { received, total: received, pct: 100 },
        );
        return Ok(dir.to_string_lossy().to_string());
    }
    let spec = model_spec(&model)?;
    let dir = model_dir(&app, &model)?;
    let sentinel = dir.join(spec.sentinel);
    if sentinel.metadata().map(|m| m.len() > 0).unwrap_or(false) {
        return Ok(dir.to_string_lossy().to_string());
    }

    // Extract into a fresh temp sibling dir, validate the sentinel there, then atomically
    // rename it into place (see unique_tmp_suffix) — a partial extract never poisons `dir`.
    let parent = dir.parent().ok_or("bad model dir")?;
    let tmp_dir = parent.join(format!(".{model}.tmp-{}", unique_tmp_suffix()));
    let _ = std::fs::remove_dir_all(&tmp_dir);
    std::fs::create_dir_all(&tmp_dir).map_err(|e| e.to_string())?;

    // 1) Stream the tarball (the upstream sherpa-onnx release) to a .part file with
    // progress, then atomic-rename. download_to_file_fallback uses a per-call unique
    // `.part` so concurrent downloads never corrupt one temp file.
    let archive = tmp_dir.join("download.tar.bz2");
    let urls = crate::deps_command::candidates(spec.url);
    let received = match download_to_file_fallback(&app, &urls, &archive, &model) {
        Ok(n) => n,
        Err(e) => { let _ = std::fs::remove_dir_all(&tmp_dir); return Err(e); }
    };

    // 2) Extract, stripping the single leading folder (e.g. `kokoro-multi-lang-v1_0/`).
    let extracted = extract_tar_bz2_stripped(&archive, &tmp_dir);
    let _ = std::fs::remove_file(&archive);
    if let Err(e) = extracted { let _ = std::fs::remove_dir_all(&tmp_dir); return Err(e); }

    if !tmp_dir.join(spec.sentinel).metadata().map(|m| m.len() > 0).unwrap_or(false) {
        let _ = std::fs::remove_dir_all(&tmp_dir);
        return Err(format!(
            "model '{model}' extracted but '{}' is missing",
            spec.sentinel
        ));
    }
    // Atomic publish.
    let _ = std::fs::remove_dir_all(&dir);
    if let Err(e) = std::fs::rename(&tmp_dir, &dir) {
        let _ = std::fs::remove_dir_all(&tmp_dir);
        return Err(format!("failed to install model '{model}': {e}"));
    }
    let _ = app.emit(
        "tts_model_progress",
        ModelProgress { received, total: received, pct: 100 },
    );
    Ok(dir.to_string_lossy().to_string())
}

/// Stream one of `urls` (with resume + source fallback) into `dest`, emitting
/// `tts_model_progress`. The last 2% of the bar is reserved for the post-download tar
/// extraction, so download progress maps to 0–98%. `what` labels the download logs.
/// Returns the byte count. Delegates to the shared resumable downloader — a dropped
/// 360 MB pull now continues from disk instead of restarting (see
/// deps_command::stream_resumable / download_resumable_fallback).
fn download_to_file_fallback(app: &AppHandle, urls: &[String], dest: &PathBuf, what: &str) -> Result<u64, String> {
    let mut last_pct = -1i32;
    crate::deps_command::download_resumable_fallback(&http_agent(), urls, dest, what, |received, total| {
        let pct = if total > 0 { ((received * 98) / total) as i32 } else { -1 };
        if pct != last_pct {
            last_pct = pct;
            let _ = app.emit("tts_model_progress", ModelProgress { received, total, pct });
        }
    })
}

/// Unpack a `.tar.bz2` into `dest`, dropping the archive's single top-level dir
/// (the sherpa model tarballs). See `extract_tar_stripped`.
fn extract_tar_bz2_stripped(archive: &PathBuf, dest: &PathBuf) -> Result<(), String> {
    let file = std::fs::File::open(archive).map_err(|e| e.to_string())?;
    let decoder = bzip2::read::BzDecoder::new(std::io::BufReader::new(file));
    extract_tar_stripped(decoder, dest)
}

/// Unpack a `.tar.gz` into `dest`, dropping the single top-level dir (the
/// vendor-hosted Supertonic bundle). See `extract_tar_stripped`.
fn extract_tar_gz_stripped(archive: &PathBuf, dest: &PathBuf) -> Result<(), String> {
    let file = std::fs::File::open(archive).map_err(|e| e.to_string())?;
    let decoder = flate2::read::GzDecoder::new(std::io::BufReader::new(file));
    extract_tar_stripped(decoder, dest)
}

/// Unpack a tar stream into `dest`, dropping the archive's single top-level
/// directory so files land directly in `dest` (`<folder>/model.onnx` →
/// `dest/model.onnx`). Skips entries that escape `dest` (path-traversal guard).
fn extract_tar_stripped<R: std::io::Read>(reader: R, dest: &PathBuf) -> Result<(), String> {
    let mut tar = tar::Archive::new(reader);
    for entry in tar.entries().map_err(|e| format!("tar open failed: {e}"))? {
        let mut entry = entry.map_err(|e| e.to_string())?;
        let path = entry.path().map_err(|e| e.to_string())?.into_owned();
        // Strip the first component (the top-level folder).
        let stripped: PathBuf = path.components().skip(1).collect();
        if stripped.as_os_str().is_empty() {
            continue;
        }
        // Reject any entry that would escape dest via `..`.
        if stripped
            .components()
            .any(|c| matches!(c, std::path::Component::ParentDir))
        {
            continue;
        }
        let out_path = dest.join(&stripped);
        if let Some(parent) = out_path.parent() {
            std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
        }
        entry.unpack(&out_path).map_err(|e| e.to_string())?;
    }
    Ok(())
}

/// Synthesize `text` to WAV bytes entirely on-device. Guards that the model is
/// downloaded first. `voice` is the Kokoro speaker id as a string (e.g. "3") or a
/// Supertonic style id ("M1".."F5"). `speed` is 0.5..=2.0 (already mapped from
/// the UI slider).
///
/// `(async)` runs synthesis on Tauri's worker pool so the UI stays responsive.
#[tauri::command(async)]
pub fn tts_synthesize(
    app: AppHandle,
    model: String,
    text: String,
    voice: String,
    speed: f32,
) -> Result<Vec<u8>, String> {
    // Supertonic is a separate (ort) engine on its own downloaded assets — route it out.
    if model == "supertonic" {
        return supertonic_synthesize(&app, &text, &voice, speed);
    }
    let spec = model_spec(&model)?;
    let dir = model_dir(&app, &model)?;
    if !dir.join(spec.sentinel).metadata().map(|m| m.len() > 0).unwrap_or(false) {
        return Err(format!("tts model '{model}' is not downloaded yet"));
    }
    let sid = voice.trim().parse::<i32>().unwrap_or(0);
    local_tts::synthesize(&dir.to_string_lossy(), spec.engine, &text, sid, speed)
        .map_err(|e| format!("tts synthesis failed: {e}"))
}
