//! Local (on-device) Whisper transcription.
//!
//! A Tauri-free Rust crate so it builds + tests standalone (`cargo test`), with
//! the app's `src-tauri` providing the only Tauri glue (a `transcribe_local`
//! command). It decodes audio with the `ffmpeg` CLI (env `FFMPEG_PATH`, else
//! `ffmpeg` on PATH), runs whisper.cpp via `whisper-rs` on the CPU, and returns
//! text + sentence segments + **per-word timestamps** in the JSON shape the
//! frontend's `VoiceAnalysis` expects (camelCase).

use std::path::Path;
use std::process::Command;

use anyhow::{anyhow, bail, Context, Result};
use serde::Serialize;
use whisper_rs::{FullParams, SamplingStrategy, WhisperContext, WhisperContextParameters};

/// Per-word timestamp (seconds). Matches the web app's `VoiceAnalysis.words[]`.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Word {
    pub word: String,
    pub start: f64,
    pub end: f64,
}

/// Sentence-level segment (seconds). Matches `VoiceAnalysis.segments[]`.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Segment {
    pub start: f64,
    pub end: f64,
    pub text: String,
}

/// Full transcript — serialises 1:1 to the frontend `VoiceAnalysis` interface.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Transcript {
    pub text: String,
    pub duration: f64,
    pub word_count: usize,
    pub words_per_second: f64,
    pub segment_count: usize,
    pub segments: Vec<Segment>,
    pub words: Vec<Word>,
    pub model: String,
}

/// Resolve the ffmpeg binary: `FFMPEG_PATH` (set by the app to its downloaded
/// copy), else `ffmpeg` on PATH.
fn ffmpeg_bin() -> String {
    std::env::var("FFMPEG_PATH").unwrap_or_else(|_| "ffmpeg".to_string())
}

/// Decode any audio/video file to the mono 16 kHz f32 PCM whisper.cpp needs.
fn decode_pcm(audio_path: &str) -> Result<Vec<f32>> {
    let ffmpeg = ffmpeg_bin();
    let out = Command::new(&ffmpeg)
        .args([
            "-nostdin",
            "-i", audio_path,
            "-vn",            // ignore any video stream
            "-ac", "1",       // mono
            "-ar", "16000",   // 16 kHz
            "-f", "f32le",    // raw 32-bit float little-endian
            "-",
        ])
        .output()
        .map_err(|e| anyhow!("failed to launch ffmpeg ('{ffmpeg}'): {e}"))?;

    if !out.status.success() {
        bail!(
            "ffmpeg could not decode {audio_path}: {}",
            String::from_utf8_lossy(&out.stderr)
        );
    }

    let pcm: Vec<f32> = out
        .stdout
        .chunks_exact(4)
        .map(|b| f32::from_le_bytes([b[0], b[1], b[2], b[3]]))
        .collect();

    if pcm.is_empty() {
        bail!("ffmpeg produced no audio samples for {audio_path}");
    }
    Ok(pcm)
}

/// whisper.cpp renders its control tokens as `[_BEG_]`, `[_TT_123]`, etc.
fn is_special_token(text: &str) -> bool {
    text.starts_with("[_") || (text.starts_with('[') && text.ends_with(']'))
}

/// Cache of loaded whisper models keyed by path, so a batch of segments reuses the model
/// instead of re-loading it from disk each call.
fn whisper_ctx_cache() -> &'static std::sync::Mutex<std::collections::HashMap<String, WhisperContext>> {
    static CACHE: std::sync::OnceLock<std::sync::Mutex<std::collections::HashMap<String, WhisperContext>>> =
        std::sync::OnceLock::new();
    CACHE.get_or_init(|| std::sync::Mutex::new(std::collections::HashMap::new()))
}

/// Transcribe `audio_path` with the model at `model_path`.
///
/// * `language` — BCP-ish code (`"en"`, `"hi"`, …) or `"auto"`/empty to detect.
/// * `progress` — called with 0..=100 as whisper.cpp decodes (best-effort).
pub fn transcribe<F: FnMut(i32) + 'static>(
    model_path: &str,
    audio_path: &str,
    language: &str,
    mut progress: F,
) -> Result<Transcript> {
    if !Path::new(model_path).exists() {
        bail!("whisper model not found at {model_path}");
    }

    let pcm = decode_pcm(audio_path)?;
    let duration = pcm.len() as f64 / 16_000.0;

    // Cache the loaded model (WhisperContext) by path so a batch of segments doesn't
    // re-load + re-optimize the model from disk for each one. A fresh per-call `state`
    // holds this transcription's results; the lock is held across inference (on-device
    // transcription runs sequentially anyway).
    let mut guard = whisper_ctx_cache().lock().unwrap_or_else(|e| e.into_inner());
    if !guard.contains_key(model_path) {
        let ctx = WhisperContext::new_with_params(model_path, WhisperContextParameters::default())
            .context("failed to load whisper model")?;
        guard.insert(model_path.to_string(), ctx);
    }
    let ctx = guard.get(model_path).expect("model just inserted");
    let mut state = ctx.create_state().context("failed to create whisper state")?;

    let mut params = FullParams::new(SamplingStrategy::Greedy { best_of: 1 });
    let threads = std::thread::available_parallelism()
        .map(|n| (n.get() as i32).clamp(1, 8))
        .unwrap_or(4);
    params.set_n_threads(threads);
    params.set_translate(false);
    let lang = if language.is_empty() { "auto" } else { language };
    params.set_language(Some(lang));
    params.set_print_special(false);
    params.set_print_progress(false);
    params.set_print_realtime(false);
    params.set_print_timestamps(false);
    params.set_token_timestamps(true); // needed for per-word timing

    params.set_progress_callback_safe(move |p: i32| progress(p));

    state
        .full(params, &pcm)
        .context("whisper transcription failed")?;

    let n_segments = state.full_n_segments();
    let mut segments: Vec<Segment> = Vec::with_capacity(n_segments.max(0) as usize);
    let mut words: Vec<Word> = Vec::new();
    let mut full_text = String::new();

    for i in 0..n_segments {
        let seg = match state.get_segment(i) {
            Some(s) => s,
            None => continue,
        };
        let seg_text = seg.to_str().unwrap_or("").to_string();
        let seg_t0 = seg.start_timestamp() as f64 / 100.0;
        let seg_t1 = seg.end_timestamp() as f64 / 100.0;
        let trimmed = seg_text.trim();
        if !trimmed.is_empty() {
            if !full_text.is_empty() {
                full_text.push(' ');
            }
            full_text.push_str(trimmed);
            segments.push(Segment {
                start: seg_t0,
                end: seg_t1,
                text: trimmed.to_string(),
            });
        }

        // Build words by merging sub-word tokens: a new word starts on a token
        // whose text begins with a space (whisper's BPE word-boundary marker).
        let n_tokens = seg.n_tokens();
        let mut cur = String::new();
        let mut cur_start = 0.0f64;
        let mut cur_end = 0.0f64;
        for j in 0..n_tokens {
            let tok = match seg.get_token(j) {
                Some(t) => t,
                None => continue,
            };
            let tok_text = match tok.to_str() {
                Ok(t) => t.to_string(),
                Err(_) => continue,
            };
            if is_special_token(&tok_text) {
                continue;
            }
            let data = tok.token_data();
            let t0 = data.t0 as f64 / 100.0;
            let t1 = data.t1 as f64 / 100.0;

            let starts_word = tok_text.starts_with(' ');
            if starts_word && !cur.trim().is_empty() {
                words.push(Word {
                    word: cur.trim().to_string(),
                    start: cur_start,
                    end: cur_end,
                });
                cur.clear();
            }
            if cur.is_empty() {
                cur_start = t0;
            }
            cur.push_str(&tok_text);
            cur_end = t1;
        }
        if !cur.trim().is_empty() {
            words.push(Word {
                word: cur.trim().to_string(),
                start: cur_start,
                end: cur_end,
            });
        }
    }

    let word_count = words.len();
    let words_per_second = if duration > 0.0 {
        word_count as f64 / duration
    } else {
        0.0
    };
    let model = Path::new(model_path)
        .file_name()
        .map(|n| n.to_string_lossy().to_string())
        .unwrap_or_else(|| model_path.to_string());

    Ok(Transcript {
        text: full_text,
        duration,
        word_count,
        words_per_second,
        segment_count: segments.len(),
        segments,
        words,
        model,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn special_token_detection() {
        assert!(is_special_token("[_BEG_]"));
        assert!(is_special_token("[_TT_120]"));
        assert!(!is_special_token(" hello"));
        assert!(!is_special_token("world"));
    }

    #[test]
    fn missing_model_errors_cleanly() {
        let err = transcribe("does-not-exist.bin", "x.wav", "auto", |_| {}).unwrap_err();
        assert!(err.to_string().contains("model not found"));
    }
}
