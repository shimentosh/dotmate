//! Local (on-device) neural text-to-speech.
//!
//! Mirrors `crates/whisper` (which is *speech→text*); this is *text→speech*.
//! A Tauri-free Rust crate so it builds + tests standalone (`cargo test`), with
//! the app's `src-tauri` providing the only Tauri glue (a `tts_synthesize`
//! command). It runs **Kokoro-82M** (multi-voice, multi-language) entirely on the
//! CPU via `sherpa-onnx` (ONNX Runtime) and returns a ready-to-play 16-bit PCM
//! WAV — no Python, no Docker, no localhost server. Models live in a directory
//! the app downloads once into the app data dir; this crate only reads files.

use std::path::Path;

use anyhow::{anyhow, bail, Context, Result};
use sherpa_onnx::{
    GenerationConfig, OfflineTts, OfflineTtsConfig, OfflineTtsKokoroModelConfig,
    OfflineTtsModelConfig,
};

/// Which model family lives in the directory passed to [`synthesize`]. Selected
/// by the Tauri layer from the model id (`kokoro`), never inferred from the files
/// — the contract is explicit, like whisper's `model_size`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TtsEngine {
    /// Kokoro-82M — `model.onnx` + `voices.bin` + `tokens.txt` + `espeak-ng-data/`
    /// (+ optional `lexicon*.txt` / `dict/`). Multi-voice (speaker id selects).
    Kokoro,
}

/// First file/dir in `dir` named `name`, as an absolute path string — or `None`.
fn opt_path(dir: &Path, name: &str) -> Option<String> {
    let p = dir.join(name);
    p.exists().then(|| p.to_string_lossy().into_owned())
}

/// The model weights `.onnx`. Prefers `prefer` (e.g. `model.onnx` for Kokoro),
/// else the first `*.onnx` in the directory.
fn main_onnx(dir: &Path, prefer: Option<&str>) -> Option<String> {
    if let Some(name) = prefer {
        if let Some(p) = opt_path(dir, name) {
            return Some(p);
        }
    }
    let mut onnx: Vec<String> = std::fs::read_dir(dir)
        .ok()?
        .flatten()
        .map(|e| e.path())
        .filter(|p| p.extension().and_then(|x| x.to_str()) == Some("onnx"))
        .map(|p| p.to_string_lossy().into_owned())
        .collect();
    onnx.sort();
    onnx.into_iter().next()
}

/// Comma-joined list of `lexicon*.txt` files (Kokoro multi-lang ships per-language
/// lexicons); `None` when there are none. sherpa-onnx takes them comma-separated.
fn lexicons(dir: &Path) -> Option<String> {
    let mut v: Vec<String> = std::fs::read_dir(dir)
        .ok()?
        .flatten()
        .filter_map(|e| {
            let name = e.file_name().to_string_lossy().into_owned();
            (name.starts_with("lexicon") && name.ends_with(".txt"))
                .then(|| e.path().to_string_lossy().into_owned())
        })
        .collect();
    if v.is_empty() {
        return None;
    }
    v.sort();
    Some(v.join(","))
}

/// Encode mono f32 samples (-1.0..=1.0) to a 16-bit PCM WAV buffer.
fn encode_wav(samples: &[f32], sample_rate: i32) -> Result<Vec<u8>> {
    let spec = hound::WavSpec {
        channels: 1,
        sample_rate: sample_rate.max(1) as u32,
        bits_per_sample: 16,
        sample_format: hound::SampleFormat::Int,
    };
    let mut buf: Vec<u8> = Vec::with_capacity(44 + samples.len() * 2);
    {
        let cursor = std::io::Cursor::new(&mut buf);
        let mut writer = hound::WavWriter::new(cursor, spec).context("init WAV writer")?;
        for &s in samples {
            let clamped = s.clamp(-1.0, 1.0);
            writer
                .write_sample((clamped * i16::MAX as f32) as i16)
                .context("write WAV sample")?;
        }
        writer.finalize().context("finalize WAV")?;
    }
    Ok(buf)
}

/// Synthesize `text` to a 16-bit PCM WAV (mono), entirely on-device.
///
/// * `model_dir` — the downloaded+extracted model folder
///   (`<app_data>/models/tts/<id>/`).
/// * `engine`    — which family the folder holds (chosen by the caller).
/// * `sid`       — speaker id: the Kokoro voice index (the frontend voice list
///   owns name→index).
/// * `speed`     — 0.5..=2.0 (1.0 = normal; >1 faster). The 50..200 UI slider
///   maps to this before the call.
///
/// Returns WAV bytes the webview can play directly (the Tauri layer wraps them in
/// a Blob). Errors (rather than panics) if the model files are missing.
pub fn synthesize(
    model_dir: &str,
    engine: TtsEngine,
    text: &str,
    sid: i32,
    speed: f32,
) -> Result<Vec<u8>> {
    // Reuse a loaded engine (keyed by model dir + engine) so a batch narration doesn't
    // re-read + re-optimize the ONNX model from disk for every segment. The lock is held
    // across generation — synthesis runs sequentially per the tool.
    let key = format!("{model_dir}|{engine:?}");
    let mut guard = tts_engine_cache().lock().unwrap_or_else(|e| e.into_inner());
    if !guard.contains_key(&key) {
        guard.insert(key.clone(), load_tts(model_dir, engine)?);
    }
    let tts = guard.get(&key).expect("engine just inserted");

    let gen_cfg = GenerationConfig {
        sid: match engine {
            TtsEngine::Kokoro => sid.max(0),
        },
        speed: speed.clamp(0.5, 2.0),
        ..Default::default()
    };

    // No streaming callback — synthesis of a paragraph is sub-second to a few
    // seconds on CPU. The turbofish pins the generic callback type so `None`
    // type-checks.
    let audio = tts
        .generate_with_config::<fn(&[f32], f32) -> bool>(text, &gen_cfg, None)
        .ok_or_else(|| anyhow!("TTS generation failed"))?;

    let samples = audio.samples();
    if samples.is_empty() {
        bail!("TTS produced no audio for the given text");
    }
    encode_wav(samples, audio.sample_rate())
}

/// Cache of loaded engines keyed by "<model_dir>|<engine>".
fn tts_engine_cache() -> &'static std::sync::Mutex<std::collections::HashMap<String, OfflineTts>> {
    static CACHE: std::sync::OnceLock<std::sync::Mutex<std::collections::HashMap<String, OfflineTts>>> =
        std::sync::OnceLock::new();
    CACHE.get_or_init(|| std::sync::Mutex::new(std::collections::HashMap::new()))
}

/// Build the config for `engine` in `model_dir` and create the OfflineTts engine.
fn load_tts(model_dir: &str, engine: TtsEngine) -> Result<OfflineTts> {
    let dir = Path::new(model_dir);
    if !dir.is_dir() {
        bail!("tts model directory not found at {model_dir}");
    }

    let tokens = opt_path(dir, "tokens.txt")
        .ok_or_else(|| anyhow!("missing tokens.txt in {model_dir}"))?;
    let data_dir = opt_path(dir, "espeak-ng-data");
    let dict_dir = opt_path(dir, "dict");

    let mut model = OfflineTtsModelConfig {
        num_threads: std::thread::available_parallelism()
            .map(|n| (n.get() as i32).clamp(1, 4))
            .unwrap_or(2),
        provider: Some("cpu".to_string()),
        ..Default::default()
    };

    match engine {
        TtsEngine::Kokoro => {
            model.kokoro = OfflineTtsKokoroModelConfig {
                model: Some(
                    main_onnx(dir, Some("model.onnx"))
                        .ok_or_else(|| anyhow!("missing model.onnx in {model_dir}"))?,
                ),
                voices: Some(
                    opt_path(dir, "voices.bin")
                        .ok_or_else(|| anyhow!("missing voices.bin in {model_dir}"))?,
                ),
                tokens: Some(tokens),
                data_dir,
                dict_dir,
                lexicon: lexicons(dir),
                lang: None,
                ..Default::default()
            };
        }
    }

    let config = OfflineTtsConfig {
        model,
        ..Default::default()
    };

    OfflineTts::create(&config)
        .ok_or_else(|| anyhow!("failed to create TTS engine (check model files in {model_dir})"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn missing_dir_errors_cleanly() {
        let err = synthesize("does-not-exist-dir", TtsEngine::Kokoro, "hi", 0, 1.0).unwrap_err();
        assert!(err.to_string().contains("not found"));
    }

    #[test]
    fn wav_has_riff_header() {
        // A short silent buffer is enough to exercise the encoder without a model.
        let wav = encode_wav(&[0.0f32; 16_000], 24_000).unwrap();
        assert!(wav.len() > 44, "WAV should have a header + data");
        assert_eq!(&wav[0..4], b"RIFF");
        assert_eq!(&wav[8..12], b"WAVE");
    }

    #[test]
    fn wav_clamps_out_of_range_samples() {
        // Values outside [-1, 1] must not panic or overflow the i16 cast.
        let wav = encode_wav(&[2.0, -2.0, 0.5, -0.5], 22_050).unwrap();
        assert!(wav.len() > 44);
    }
}
