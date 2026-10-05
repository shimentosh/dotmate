//! Supertonic 3 on-device neural TTS — the ONNX inference engine.
//!
//! Tauri-free + standalone-testable (mirrors crates/tts / crates/whisper). The
//! Tauri bridge (src-tauri/src/tts_command.rs) calls `synthesize()` after
//! `set_runtime_dylib()` points `ort` at the downloaded `onnxruntime.dll`.
//!
//! The pipeline + tokenizer/normaliser below are VENDORED (lightly adapted to a
//! library) from the official Supertonic reference at
//! github.com/supertone-inc/supertonic (rust/src/helper.rs), which is MIT-licensed.
//! The model WEIGHTS are OpenRAIL-M (downloaded separately, never bundled).
//!
//! Assets in `onnx_dir` (from the downloaded Supertonic archive):
//!   tts.json · unicode_indexer.json ·
//!   duration_predictor.onnx · text_encoder.onnx · vector_estimator.onnx · vocoder.onnx
//! Voice styles: per-voice JSON ({ style_ttl, style_dp }) under voice_styles/.

use anyhow::{bail, Context, Result};
use hound::{SampleFormat, WavSpec, WavWriter};
use ndarray::{Array, Array3};
use rand_distr::{Distribution, Normal};
use regex::Regex;
use serde::{Deserialize, Serialize};
use std::fs::File;
use std::io::{BufReader, Cursor};
use std::path::Path;
use unicode_normalization::UnicodeNormalization;

use ort::{session::Session, value::Value};

// 32 supported language codes (wrapped as <lang>…</lang> tags before tokenising).
pub const AVAILABLE_LANGS: &[&str] = &[
    "en", "ko", "ja", "ar", "bg", "cs", "da", "de", "el", "es", "et", "fi", "fr", "hi", "hr", "hu",
    "id", "it", "lt", "lv", "nl", "pl", "pt", "ro", "ru", "sk", "sl", "sv", "tr", "uk", "vi", "na",
];

pub fn is_valid_lang(lang: &str) -> bool {
    AVAILABLE_LANGS.contains(&lang)
}

/// Point `ort` (built with `load-dynamic`) at a specific `onnxruntime.dll`/`.so`.
/// Call once before `synthesize()`. The desktop bridge passes the bundled DLL path.
pub fn set_runtime_dylib(path: &str) {
    std::env::set_var("ORT_DYLIB_PATH", path);
}

// ============================================================================
// Config + voice-style structures
// ============================================================================

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Config {
    pub ae: AEConfig,
    pub ttl: TTLConfig,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AEConfig {
    pub sample_rate: i32,
    pub base_chunk_size: i32,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TTLConfig {
    pub chunk_compress_factor: i32,
    pub latent_dim: i32,
}

pub fn load_cfgs<P: AsRef<Path>>(onnx_dir: P) -> Result<Config> {
    let cfg_path = onnx_dir.as_ref().join("tts.json");
    let file = File::open(cfg_path)?;
    let cfgs: Config = serde_json::from_reader(BufReader::new(file))?;
    Ok(cfgs)
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct VoiceStyleData {
    pub style_ttl: StyleComponent,
    pub style_dp: StyleComponent,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct StyleComponent {
    pub data: Vec<Vec<Vec<f32>>>,
    pub dims: Vec<usize>,
    #[serde(rename = "type")]
    pub dtype: String,
}

// ============================================================================
// Unicode text processor (the tokenizer)
// ============================================================================

pub struct UnicodeProcessor {
    indexer: Vec<i64>,
}

impl UnicodeProcessor {
    pub fn new<P: AsRef<Path>>(unicode_indexer_json_path: P) -> Result<Self> {
        let file = File::open(unicode_indexer_json_path)?;
        let indexer: Vec<i64> = serde_json::from_reader(BufReader::new(file))?;
        Ok(UnicodeProcessor { indexer })
    }

    pub fn call(
        &self,
        text_list: &[String],
        lang_list: &[String],
    ) -> Result<(Vec<Vec<i64>>, Array3<f32>)> {
        let mut processed_texts: Vec<String> = Vec::new();
        for (text, lang) in text_list.iter().zip(lang_list.iter()) {
            processed_texts.push(preprocess_text(text, lang)?);
        }

        let text_ids_lengths: Vec<usize> =
            processed_texts.iter().map(|t| t.chars().count()).collect();
        let max_len = *text_ids_lengths.iter().max().unwrap_or(&0);

        let mut text_ids = Vec::new();
        for text in &processed_texts {
            let mut row = vec![0i64; max_len];
            let unicode_vals = text_to_unicode_values(text);
            for (j, &val) in unicode_vals.iter().enumerate() {
                row[j] = if val < self.indexer.len() { self.indexer[val] } else { -1 };
            }
            text_ids.push(row);
        }

        let text_mask = get_text_mask(&text_ids_lengths);
        Ok((text_ids, text_mask))
    }
}

/// Regexes for `preprocess_text`, compiled ONCE for the process (not on every chunk).
/// Supertonic synthesizes many short chunks per narration, and rebuilding ~10 regexes
/// per call dwarfed the actual string work. (OnceLock, not LazyLock, to keep the crate's
/// declared MSRV 1.77.2.)
struct PpRegex {
    emoji: Regex,
    space_comma: Regex,
    space_dot: Regex,
    space_excl: Regex,
    space_q: Regex,
    space_semi: Regex,
    space_colon: Regex,
    space_apos: Regex,
    ws: Regex,
    ends_punct: Regex,
}
fn pp_regex() -> &'static PpRegex {
    static RE: std::sync::OnceLock<PpRegex> = std::sync::OnceLock::new();
    RE.get_or_init(|| PpRegex {
        emoji: Regex::new(r"[\x{1F600}-\x{1F64F}\x{1F300}-\x{1F5FF}\x{1F680}-\x{1F6FF}\x{1F700}-\x{1F77F}\x{1F780}-\x{1F7FF}\x{1F800}-\x{1F8FF}\x{1F900}-\x{1F9FF}\x{1FA00}-\x{1FA6F}\x{1FA70}-\x{1FAFF}\x{2600}-\x{26FF}\x{2700}-\x{27BF}\x{1F1E6}-\x{1F1FF}]+").unwrap(),
        space_comma: Regex::new(r" ,").unwrap(),
        space_dot: Regex::new(r" \.").unwrap(),
        space_excl: Regex::new(r" !").unwrap(),
        space_q: Regex::new(r" \?").unwrap(),
        space_semi: Regex::new(r" ;").unwrap(),
        space_colon: Regex::new(r" :").unwrap(),
        space_apos: Regex::new(r" '").unwrap(),
        ws: Regex::new(r"\s+").unwrap(),
        ends_punct: Regex::new(r#"[.!?;:,'"\u{201C}\u{201D}\u{2018}\u{2019})\]}\u{2026}\u{3002}\u{300D}\u{300F}\u{3011}\u{3009}\u{300B}\u{203A}\u{00BB}]$"#).unwrap(),
    })
}

pub fn preprocess_text(text: &str, lang: &str) -> Result<String> {
    let re = pp_regex();
    let mut text: String = text.nfkd().collect();

    // Remove emojis (wide Unicode range).
    text = re.emoji.replace_all(&text, "").to_string();

    let replacements = [
        ("\u{2013}", "-"), ("\u{2011}", "-"), ("\u{2014}", "-"), ("_", " "),
        ("\u{201C}", "\""), ("\u{201D}", "\""), ("\u{2018}", "'"), ("\u{2019}", "'"),
        ("\u{00B4}", "'"), ("`", "'"), ("[", " "), ("]", " "), ("|", " "), ("/", " "),
        ("#", " "), ("\u{2192}", " "), ("\u{2190}", " "),
    ];
    for (from, to) in &replacements {
        text = text.replace(from, to);
    }

    let special_symbols = ["\u{2665}", "\u{2606}", "\u{2661}", "\u{00A9}", "\\"];
    for symbol in &special_symbols {
        text = text.replace(symbol, "");
    }

    let expr_replacements = [("@", " at "), ("e.g.,", "for example, "), ("i.e.,", "that is, ")];
    for (from, to) in &expr_replacements {
        text = text.replace(from, to);
    }

    text = re.space_comma.replace_all(&text, ",").to_string();
    text = re.space_dot.replace_all(&text, ".").to_string();
    text = re.space_excl.replace_all(&text, "!").to_string();
    text = re.space_q.replace_all(&text, "?").to_string();
    text = re.space_semi.replace_all(&text, ";").to_string();
    text = re.space_colon.replace_all(&text, ":").to_string();
    text = re.space_apos.replace_all(&text, "'").to_string();

    while text.contains("\"\"") { text = text.replace("\"\"", "\""); }
    while text.contains("''") { text = text.replace("''", "'"); }
    while text.contains("``") { text = text.replace("``", "`"); }

    text = re.ws.replace_all(&text, " ").to_string();
    text = text.trim().to_string();

    if !text.is_empty() && !re.ends_punct.is_match(&text) {
        text.push('.');
    }

    if !is_valid_lang(lang) {
        bail!("Invalid language: {}. Available: {:?}", lang, AVAILABLE_LANGS);
    }

    text = format!("<{}>{}</{}>", lang, text, lang);
    Ok(text)
}

pub fn text_to_unicode_values(text: &str) -> Vec<usize> {
    text.chars().map(|c| c as usize).collect()
}

pub fn length_to_mask(lengths: &[usize], max_len: Option<usize>) -> Array3<f32> {
    let bsz = lengths.len();
    let max_len = max_len.unwrap_or_else(|| *lengths.iter().max().unwrap_or(&0));
    let mut mask = Array3::<f32>::zeros((bsz, 1, max_len));
    for (i, &len) in lengths.iter().enumerate() {
        for j in 0..len.min(max_len) {
            mask[[i, 0, j]] = 1.0;
        }
    }
    mask
}

pub fn get_text_mask(text_ids_lengths: &[usize]) -> Array3<f32> {
    let max_len = *text_ids_lengths.iter().max().unwrap_or(&0);
    length_to_mask(text_ids_lengths, Some(max_len))
}

/// Sample a masked Gaussian latent for the diffusion init.
pub fn sample_noisy_latent(
    duration: &[f32],
    sample_rate: i32,
    base_chunk_size: i32,
    chunk_compress: i32,
    latent_dim: i32,
) -> (Array3<f32>, Array3<f32>) {
    let bsz = duration.len();
    let max_dur = duration.iter().fold(0.0f32, |a, &b| a.max(b));
    let wav_len_max = (max_dur * sample_rate as f32) as usize;
    let wav_lengths: Vec<usize> =
        duration.iter().map(|&d| (d * sample_rate as f32) as usize).collect();

    let chunk_size = (base_chunk_size * chunk_compress) as usize;
    let latent_len = (wav_len_max + chunk_size - 1) / chunk_size;
    let latent_dim_val = (latent_dim * chunk_compress) as usize;

    let mut noisy_latent = Array3::<f32>::zeros((bsz, latent_dim_val, latent_len));
    let normal = Normal::new(0.0, 1.0).unwrap();
    let mut rng = rand::thread_rng();
    for b in 0..bsz {
        for d in 0..latent_dim_val {
            for t in 0..latent_len {
                noisy_latent[[b, d, t]] = normal.sample(&mut rng);
            }
        }
    }

    let latent_lengths: Vec<usize> =
        wav_lengths.iter().map(|&len| (len + chunk_size - 1) / chunk_size).collect();
    let latent_mask = length_to_mask(&latent_lengths, Some(latent_len));

    for b in 0..bsz {
        for d in 0..latent_dim_val {
            for t in 0..latent_len {
                noisy_latent[[b, d, t]] *= latent_mask[[b, 0, t]];
            }
        }
    }
    (noisy_latent, latent_mask)
}

// ============================================================================
// WAV encode (→ bytes, not a file)
// ============================================================================

pub fn encode_wav(audio_data: &[f32], sample_rate: i32) -> Result<Vec<u8>> {
    let spec = WavSpec {
        channels: 1,
        sample_rate: sample_rate as u32,
        bits_per_sample: 16,
        sample_format: SampleFormat::Int,
    };
    let mut cursor = Cursor::new(Vec::<u8>::new());
    {
        let mut writer = WavWriter::new(&mut cursor, spec)?;
        for &sample in audio_data {
            let clamped = sample.max(-1.0).min(1.0);
            writer.write_sample((clamped * 32767.0) as i16)?;
        }
        writer.finalize()?;
    }
    Ok(cursor.into_inner())
}

// ============================================================================
// Text chunking (long input → ≤max_len pieces, abbreviation-aware)
// ============================================================================

const MAX_CHUNK_LENGTH: usize = 300;

const ABBREVIATIONS: &[&str] = &[
    "Dr.", "Mr.", "Mrs.", "Ms.", "Prof.", "Sr.", "Jr.", "St.", "Ave.", "Rd.", "Blvd.", "Dept.",
    "Inc.", "Ltd.", "Co.", "Corp.", "etc.", "vs.", "i.e.", "e.g.", "Ph.D.",
];

pub fn chunk_text(text: &str, max_len: Option<usize>) -> Vec<String> {
    let max_len = max_len.unwrap_or(MAX_CHUNK_LENGTH);
    let text = text.trim();
    if text.is_empty() {
        return vec![String::new()];
    }

    let para_re = Regex::new(r"\n\s*\n").unwrap();
    let paragraphs: Vec<&str> = para_re.split(text).collect();
    let mut chunks = Vec::new();

    for para in paragraphs {
        let para = para.trim();
        if para.is_empty() {
            continue;
        }
        if para.len() <= max_len {
            chunks.push(para.to_string());
            continue;
        }

        let sentences = split_sentences(para);
        let mut current = String::new();
        let mut current_len = 0;
        for sentence in sentences {
            let sentence = sentence.trim();
            if sentence.is_empty() {
                continue;
            }
            let sentence_len = sentence.len();
            if sentence_len > max_len {
                if !current.is_empty() {
                    chunks.push(current.trim().to_string());
                    current.clear();
                    current_len = 0;
                }
                let parts: Vec<&str> = sentence.split(',').collect();
                for part in parts {
                    let part = part.trim();
                    if part.is_empty() {
                        continue;
                    }
                    let part_len = part.len();
                    if part_len > max_len {
                        let words: Vec<&str> = part.split_whitespace().collect();
                        let mut word_chunk = String::new();
                        let mut word_chunk_len = 0;
                        for word in words {
                            let word_len = word.len();
                            if word_chunk_len + word_len + 1 > max_len && !word_chunk.is_empty() {
                                chunks.push(word_chunk.trim().to_string());
                                word_chunk.clear();
                                word_chunk_len = 0;
                            }
                            if !word_chunk.is_empty() {
                                word_chunk.push(' ');
                                word_chunk_len += 1;
                            }
                            word_chunk.push_str(word);
                            word_chunk_len += word_len;
                        }
                        if !word_chunk.is_empty() {
                            chunks.push(word_chunk.trim().to_string());
                        }
                    } else {
                        if current_len + part_len + 1 > max_len && !current.is_empty() {
                            chunks.push(current.trim().to_string());
                            current.clear();
                            current_len = 0;
                        }
                        if !current.is_empty() {
                            current.push_str(", ");
                            current_len += 2;
                        }
                        current.push_str(part);
                        current_len += part_len;
                    }
                }
                continue;
            }
            if current_len + sentence_len + 1 > max_len && !current.is_empty() {
                chunks.push(current.trim().to_string());
                current.clear();
                current_len = 0;
            }
            if !current.is_empty() {
                current.push(' ');
                current_len += 1;
            }
            current.push_str(sentence);
            current_len += sentence_len;
        }
        if !current.is_empty() {
            chunks.push(current.trim().to_string());
        }
    }

    if chunks.is_empty() {
        vec![String::new()]
    } else {
        chunks
    }
}

fn split_sentences(text: &str) -> Vec<String> {
    let re = Regex::new(r"([.!?])\s+").unwrap();
    let matches: Vec<_> = re.find_iter(text).collect();
    if matches.is_empty() {
        return vec![text.to_string()];
    }
    let mut sentences = Vec::new();
    let mut last_end = 0;
    for m in matches {
        let before_punc = &text[last_end..m.start()];
        let mut is_abbrev = false;
        for abbrev in ABBREVIATIONS {
            let combined = format!("{}{}", before_punc.trim(), &text[m.start()..m.start() + 1]);
            if combined.ends_with(abbrev) {
                is_abbrev = true;
                break;
            }
        }
        if !is_abbrev {
            sentences.push(text[last_end..m.end()].to_string());
            last_end = m.end();
        }
    }
    if last_end < text.len() {
        sentences.push(text[last_end..].to_string());
    }
    if sentences.is_empty() {
        vec![text.to_string()]
    } else {
        sentences
    }
}

// ============================================================================
// ONNX inference (ort)
// ============================================================================

pub struct Style {
    pub ttl: Array3<f32>,
    pub dp: Array3<f32>,
}

pub struct TextToSpeech {
    cfgs: Config,
    text_processor: UnicodeProcessor,
    dp_ort: Session,
    text_enc_ort: Session,
    vector_est_ort: Session,
    vocoder_ort: Session,
    pub sample_rate: i32,
}

impl TextToSpeech {
    fn _infer(
        &mut self,
        text_list: &[String],
        lang_list: &[String],
        style: &Style,
        total_step: usize,
        speed: f32,
    ) -> Result<(Vec<f32>, Vec<f32>)> {
        let bsz = text_list.len();

        let (text_ids, text_mask) = self.text_processor.call(text_list, lang_list)?;

        let text_ids_array = {
            let shape = (bsz, text_ids[0].len());
            let mut flat = Vec::new();
            for row in &text_ids {
                flat.extend_from_slice(row);
            }
            Array::from_shape_vec(shape, flat)?
        };

        let text_ids_value = Value::from_array(text_ids_array)?;
        let text_mask_value = Value::from_array(text_mask.clone())?;
        let style_dp_value = Value::from_array(style.dp.clone())?;

        // 1) Duration predictor.
        let dp_outputs = self.dp_ort.run(ort::inputs! {
            "text_ids" => &text_ids_value,
            "style_dp" => &style_dp_value,
            "text_mask" => &text_mask_value
        })?;
        let (_, duration_data) = dp_outputs["duration"].try_extract_tensor::<f32>()?;
        let mut duration: Vec<f32> = duration_data.to_vec();
        for dur in duration.iter_mut() {
            *dur /= speed;
        }

        // 2) Text encoder.
        let style_ttl_value = Value::from_array(style.ttl.clone())?;
        let text_enc_outputs = self.text_enc_ort.run(ort::inputs! {
            "text_ids" => &text_ids_value,
            "style_ttl" => &style_ttl_value,
            "text_mask" => &text_mask_value
        })?;
        let (text_emb_shape, text_emb_data) =
            text_enc_outputs["text_emb"].try_extract_tensor::<f32>()?;
        let text_emb = Array3::from_shape_vec(
            (text_emb_shape[0] as usize, text_emb_shape[1] as usize, text_emb_shape[2] as usize),
            text_emb_data.to_vec(),
        )?;

        // 3) Diffusion latent init.
        let (mut xt, latent_mask) = sample_noisy_latent(
            &duration,
            self.sample_rate,
            self.cfgs.ae.base_chunk_size,
            self.cfgs.ttl.chunk_compress_factor,
            self.cfgs.ttl.latent_dim,
        );
        let total_step_array = Array::from_elem(bsz, total_step as f32);

        // 4) Denoising loop (vector estimator).
        for step in 0..total_step {
            let current_step_array = Array::from_elem(bsz, step as f32);
            let xt_value = Value::from_array(xt.clone())?;
            let text_emb_value = Value::from_array(text_emb.clone())?;
            let latent_mask_value = Value::from_array(latent_mask.clone())?;
            let text_mask_value2 = Value::from_array(text_mask.clone())?;
            let current_step_value = Value::from_array(current_step_array)?;
            let total_step_value = Value::from_array(total_step_array.clone())?;

            let vector_est_outputs = self.vector_est_ort.run(ort::inputs! {
                "noisy_latent" => &xt_value,
                "text_emb" => &text_emb_value,
                "style_ttl" => &style_ttl_value,
                "latent_mask" => &latent_mask_value,
                "text_mask" => &text_mask_value2,
                "current_step" => &current_step_value,
                "total_step" => &total_step_value
            })?;
            let (denoised_shape, denoised_data) =
                vector_est_outputs["denoised_latent"].try_extract_tensor::<f32>()?;
            xt = Array3::from_shape_vec(
                (denoised_shape[0] as usize, denoised_shape[1] as usize, denoised_shape[2] as usize),
                denoised_data.to_vec(),
            )?;
        }

        // 5) Vocoder → waveform.
        let final_latent_value = Value::from_array(xt)?;
        let vocoder_outputs =
            self.vocoder_ort.run(ort::inputs! { "latent" => &final_latent_value })?;
        let (_, wav_data) = vocoder_outputs["wav_tts"].try_extract_tensor::<f32>()?;
        Ok((wav_data.to_vec(), duration))
    }

    pub fn call(
        &mut self,
        text: &str,
        lang: &str,
        style: &Style,
        total_step: usize,
        speed: f32,
        silence_duration: f32,
    ) -> Result<(Vec<f32>, f32)> {
        let max_len = if lang == "ko" || lang == "ja" { 120 } else { 300 };
        let chunks = chunk_text(text, Some(max_len));

        let mut wav_cat: Vec<f32> = Vec::new();
        let mut dur_cat: f32 = 0.0;
        for (i, chunk) in chunks.iter().enumerate() {
            let (wav, duration) =
                self._infer(&[chunk.clone()], &[lang.to_string()], style, total_step, speed)?;
            let dur = duration[0];
            let wav_len = (self.sample_rate as f32 * dur) as usize;
            let wav_chunk = &wav[..wav_len.min(wav.len())];
            if i == 0 {
                wav_cat.extend_from_slice(wav_chunk);
                dur_cat = dur;
            } else {
                let silence_len = (silence_duration * self.sample_rate as f32) as usize;
                wav_cat.extend(std::iter::repeat(0.0f32).take(silence_len));
                wav_cat.extend_from_slice(wav_chunk);
                dur_cat += silence_duration + dur;
            }
        }
        Ok((wav_cat, dur_cat))
    }
}

/// Load one voice style JSON ({ style_ttl, style_dp }) into ttl/dp arrays (bsz=1).
pub fn load_voice_style(voice_style_paths: &[String]) -> Result<Style> {
    let bsz = voice_style_paths.len();
    let first_file =
        File::open(&voice_style_paths[0]).context("Failed to open voice style file")?;
    let first_data: VoiceStyleData = serde_json::from_reader(BufReader::new(first_file))?;

    let (ttl_dim1, ttl_dim2) = (first_data.style_ttl.dims[1], first_data.style_ttl.dims[2]);
    let (dp_dim1, dp_dim2) = (first_data.style_dp.dims[1], first_data.style_dp.dims[2]);

    let mut ttl_flat = vec![0.0f32; bsz * ttl_dim1 * ttl_dim2];
    let mut dp_flat = vec![0.0f32; bsz * dp_dim1 * dp_dim2];

    for (i, path) in voice_style_paths.iter().enumerate() {
        let file = File::open(path).context("Failed to open voice style file")?;
        let data: VoiceStyleData = serde_json::from_reader(BufReader::new(file))?;

        let ttl_offset = i * ttl_dim1 * ttl_dim2;
        let mut idx = 0;
        for batch in &data.style_ttl.data {
            for row in batch {
                for &val in row {
                    ttl_flat[ttl_offset + idx] = val;
                    idx += 1;
                }
            }
        }
        let dp_offset = i * dp_dim1 * dp_dim2;
        idx = 0;
        for batch in &data.style_dp.data {
            for row in batch {
                for &val in row {
                    dp_flat[dp_offset + idx] = val;
                    idx += 1;
                }
            }
        }
    }

    Ok(Style {
        ttl: Array3::from_shape_vec((bsz, ttl_dim1, ttl_dim2), ttl_flat)?,
        dp: Array3::from_shape_vec((bsz, dp_dim1, dp_dim2), dp_flat)?,
    })
}

/// Load the 4 ONNX sessions + config + tokenizer from `onnx_dir` (CPU).
pub fn load_text_to_speech(onnx_dir: &str) -> Result<TextToSpeech> {
    let cfgs = load_cfgs(onnx_dir)?;
    let sample_rate = cfgs.ae.sample_rate;

    let dp_ort = Session::builder()?.commit_from_file(format!("{}/duration_predictor.onnx", onnx_dir))?;
    let text_enc_ort = Session::builder()?.commit_from_file(format!("{}/text_encoder.onnx", onnx_dir))?;
    let vector_est_ort = Session::builder()?.commit_from_file(format!("{}/vector_estimator.onnx", onnx_dir))?;
    let vocoder_ort = Session::builder()?.commit_from_file(format!("{}/vocoder.onnx", onnx_dir))?;

    let text_processor = UnicodeProcessor::new(format!("{}/unicode_indexer.json", onnx_dir))?;

    Ok(TextToSpeech {
        cfgs,
        text_processor,
        dp_ort,
        text_enc_ort,
        vector_est_ort,
        vocoder_ort,
        sample_rate,
    })
}

// ============================================================================
// Public entry — the bridge calls this (after set_runtime_dylib).
// ============================================================================

/// Synthesize `text` (in `lang`) with the voice at `voice_style_path`, returning a
/// 44.1 kHz 16-bit mono WAV. `speed` ~0.5..2.0, `total_step` = diffusion steps (8 default).
/// Cache of loaded engines keyed by `onnx_dir`, so a batch narration reuses the 4 ONNX
/// sessions instead of re-reading + re-optimizing them from disk for EVERY segment. The
/// lock is held across inference — TTS runs sequentially per the tool, and a Session
/// isn't Sync, so serialized access is required anyway.
fn tts_engine_cache() -> &'static std::sync::Mutex<std::collections::HashMap<String, TextToSpeech>> {
    static CACHE: std::sync::OnceLock<std::sync::Mutex<std::collections::HashMap<String, TextToSpeech>>> =
        std::sync::OnceLock::new();
    CACHE.get_or_init(|| std::sync::Mutex::new(std::collections::HashMap::new()))
}

pub fn synthesize(
    onnx_dir: &str,
    voice_style_path: &str,
    text: &str,
    lang: &str,
    speed: f32,
    total_step: usize,
) -> Result<Vec<u8>> {
    let style = load_voice_style(&[voice_style_path.to_string()])?;
    let mut guard = tts_engine_cache().lock().unwrap_or_else(|e| e.into_inner());
    if !guard.contains_key(onnx_dir) {
        let engine = load_text_to_speech(onnx_dir)?;
        guard.insert(onnx_dir.to_string(), engine);
    }
    let tts = guard.get_mut(onnx_dir).expect("engine just inserted");
    let (wav, dur) = tts.call(text, lang, &style, total_step.max(1), speed, 0.3)?;
    let n = (tts.sample_rate as f32 * dur) as usize;
    let trimmed = &wav[..n.min(wav.len())];
    encode_wav(trimmed, tts.sample_rate)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn preprocess_wraps_lang_and_adds_period() {
        let out = preprocess_text("hello world", "en").unwrap();
        assert_eq!(out, "<en>hello world.</en>");
    }

    #[test]
    fn preprocess_rejects_unknown_lang() {
        assert!(preprocess_text("hi", "zz").is_err());
    }

    #[test]
    fn chunking_keeps_short_text_whole() {
        assert_eq!(chunk_text("Short one.", None), vec!["Short one.".to_string()]);
    }

    #[test]
    fn wav_header_is_riff() {
        let bytes = encode_wav(&[0.0, 0.5, -0.5], 44100).unwrap();
        assert_eq!(&bytes[0..4], b"RIFF");
        assert_eq!(&bytes[8..12], b"WAVE");
    }
}
