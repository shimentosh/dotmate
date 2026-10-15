//! Quick Edit — lay background music under many videos (and/or change the
//! original audio's volume), one output per video.
//!
//! Unlike the merge commands this reads the user's ORIGINAL files in place: they are
//! picked in a native dialog here (`quick_edit_pick_videos`), so their paths are
//! trusted (`security::grant_user_file`) and nothing is copied to temp. The output is
//! written straight into the chosen folder — no bytes cross the IPC bridge.
//!
//! Only the audio changes, so the video stream is copied (`-c:v copy`): no quality
//! loss and a render takes seconds. A video whose codec can't go into MP4 as-is is
//! re-encoded to H.264 instead. Progress streams as `quick-edit://progress` events
//! and a running render can be stopped with `quick_edit_cancel`.

use std::collections::{HashMap, HashSet};
use std::io::{BufRead, BufReader, Read};
use std::path::{Path, PathBuf};
use std::process::{Child, Stdio};
use std::sync::{Arc, Mutex, OnceLock};

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Manager};
use tauri_plugin_dialog::DialogExt;

use crate::security;
use crate::tools_command::{confine_one, ffmpeg_command, parse_probe, push_input, s};

const VIDEO_EXTS: [&str; 10] = ["mp4", "m4v", "mov", "mkv", "webm", "avi", "ts", "mts", "m2ts", "wmv"];
const PROGRESS_EVENT: &str = "quick-edit://progress";
/// Error string the frontend recognises as "stopped by the user".
const CANCELLED: &str = "cancelled";

/// Most a gain may boost: music 300%, original audio 200%.
const MAX_MUSIC_GAIN: f32 = 3.0;
const MAX_ORIGINAL_GAIN: f32 = 2.0;

// ── Pick + probe ──────────────────────────────────────────────────────────────

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PickedVideo {
    path: String,
    name: String,
    size: u64,
}

/// Native multi-select video picker. Each picked file is granted for ffmpeg input
/// and for the asset protocol (the preview player streams it from disk).
#[tauri::command(async)]
pub fn quick_edit_pick_videos(app: AppHandle) -> Result<Vec<PickedVideo>, String> {
    let picked = app
        .dialog()
        .file()
        .set_title("Choose videos")
        .add_filter("Videos", &VIDEO_EXTS)
        .blocking_pick_files();
    let Some(files) = picked else { return Ok(Vec::new()) };

    let mut out = Vec::new();
    for f in files {
        let Ok(path) = f.into_path() else { continue };
        let Ok(canon) = std::fs::canonicalize(&path) else { continue };
        if !canon.is_file() || security::is_secret_path(&app, &canon) {
            continue;
        }
        if let Err(e) = app.asset_protocol_scope().allow_file(&canon) {
            log::warn!("quick-edit: preview access for {} failed: {e}", canon.display());
        }
        security::grant_user_file(canon.clone());
        out.push(PickedVideo {
            name: canon.file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or_default(),
            size: std::fs::metadata(&canon).map(|m| m.len()).unwrap_or(0),
            path: canon.to_string_lossy().to_string(),
        });
    }
    Ok(out)
}

#[derive(Serialize, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct VideoInfo {
    /// Seconds; 0 when ffmpeg didn't report it.
    duration: f64,
    width: u32,
    height: u32,
    has_audio: bool,
    video_codec: String,
    /// The first audio track is mono (upmixed without the usual -3 dB).
    #[serde(skip)]
    mono_audio: bool,
}

/// Duration, displayed size, audio presence and video codec from `ffmpeg -i`.
#[tauri::command(async)]
pub fn quick_edit_probe(app: AppHandle, path: String) -> Result<VideoInfo, String> {
    let input = security::confine_user_or_app_file(&app, &path)?;
    probe(&input)
}

fn probe(input: &Path) -> Result<VideoInfo, String> {
    parse_info(&probe_stderr(input)?).ok_or_else(|| "This file has no video that can be read.".into())
}

/// `ffmpeg -i <file>` stream listing (ffprobe isn't bundled).
fn probe_stderr(input: &Path) -> Result<String, String> {
    let out = ffmpeg_command()
        .args(["-hide_banner", "-protocol_whitelist", "file", "-i"])
        .arg(input)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::piped())
        .output()
        .map_err(|e| format!("failed to launch ffmpeg: {e}"))?;
    Ok(String::from_utf8_lossy(&out.stderr).into_owned())
}

/// Whether the first audio stream is mono.
fn first_audio_is_mono(stderr: &str) -> bool {
    stderr
        .lines()
        .find(|l| l.contains("Stream #") && l.contains("Audio:"))
        .is_some_and(|l| l.split(',').any(|f| f.trim() == "mono"))
}

fn parse_info(stderr: &str) -> Option<VideoInfo> {
    let (width, height) = parse_probe(stderr)?;
    let duration = stderr
        .lines()
        .find_map(|l| l.trim().strip_prefix("Duration:"))
        .and_then(|rest| rest.split(',').next())
        .and_then(|t| parse_clock(t.trim()))
        .unwrap_or(0.0);
    let video_codec = stderr
        .lines()
        .find_map(|l| l.split("Video:").nth(1))
        .and_then(|rest| rest.split([' ', ',']).find(|t| !t.is_empty()))
        .unwrap_or("")
        .to_string();
    let has_audio = stderr.lines().any(|l| l.contains("Stream #") && l.contains("Audio:"));
    let mono_audio = first_audio_is_mono(stderr);
    Some(VideoInfo { duration, width, height, has_audio, video_codec, mono_audio })
}

/// `HH:MM:SS.cc` → seconds (None for `N/A`).
fn parse_clock(t: &str) -> Option<f64> {
    let mut secs = 0.0;
    for part in t.split(':') {
        secs = secs * 60.0 + part.parse::<f64>().ok()?;
    }
    Some(secs)
}

// ── Render ────────────────────────────────────────────────────────────────────

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct QuickEditJob {
    /// Caller's id — tags progress events and is what `quick_edit_cancel` takes.
    id: String,
    input: String,
    output_dir: String,
    /// Staged (app-managed) music file; None = only change the original volume.
    music_path: Option<String>,
    /// Linear gains: music 0–3, original 0–2.
    music_volume: f32,
    original_volume: f32,
    /// Seconds into the music where it starts.
    music_offset: f64,
    fade_in: f64,
    fade_out: f64,
    /// Appended to the input's name, e.g. "_edit" → `clip_edit.mp4`.
    suffix: String,
}

#[derive(Serialize, Clone)]
struct ProgressPayload<'a> {
    id: &'a str,
    /// 0..1
    progress: f64,
}

/// Render one video. Returns the finished file's path.
#[tauri::command(async)]
pub fn quick_edit_render(app: AppHandle, job: QuickEditJob) -> Result<String, String> {
    take_cancel(&job.id); // a stale flag from an earlier run of the same id
    let input = security::confine_user_or_app_file(&app, &job.input)?;
    let music = match job.music_path.as_deref() {
        Some(p) => Some(confine_one(&app, p)?),
        None => None,
    };
    security::reject_hostile_dest(&app, &job.output_dir)?;
    let dir = PathBuf::from(&job.output_dir);
    std::fs::create_dir_all(&dir).map_err(|e| format!("Can't create the output folder: {e}"))?;

    let info = probe(&input)?;
    let stem = input.file_stem().map(|n| n.to_string_lossy().to_string()).unwrap_or_else(|| "video".into());
    let dest = unique_path(&dir, &format!("{stem}{}", clean_suffix(&job.suffix)), "mp4");
    if dest == input {
        return Err("The output would overwrite the original.".into());
    }
    let partial = dir.join(format!(
        ".{}.{}.part",
        dest.file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or_default(),
        crate::staging::unique_suffix()
    ));

    let plan = Plan {
        input: input.to_string_lossy().to_string(),
        music: music.map(|path| Music {
            mono: probe_stderr(Path::new(&path)).map(|e| first_audio_is_mono(&e)).unwrap_or(false),
            path,
            gain: job.music_volume.clamp(0.0, MAX_MUSIC_GAIN),
            offset: job.music_offset.max(0.0),
            fade_in: job.fade_in.max(0.0),
            fade_out: job.fade_out.max(0.0),
        }),
        original_gain: job.original_volume.clamp(0.0, MAX_ORIGINAL_GAIN),
        has_audio: info.has_audio,
        mono_audio: info.mono_audio,
        duration: info.duration,
        hevc: info.video_codec == "hevc",
    };

    // Copy the video stream first; if MP4 can't hold it as-is, re-encode.
    let mut res = run_with_progress(&app, &job.id, &plan.args(VideoMode::Copy, &partial), info.duration);
    if matches!(&res, Err(e) if e != CANCELLED) {
        log::warn!("quick-edit: stream copy failed for {stem}, re-encoding: {}", res.as_ref().unwrap_err());
        res = run_with_progress(&app, &job.id, &plan.args(VideoMode::Encode, &partial), info.duration);
    }
    take_cancel(&job.id);
    if let Err(e) = res {
        let _ = std::fs::remove_file(&partial);
        return Err(e);
    }
    // Two parallel jobs can race for the same name — re-pick it at the last moment.
    let dest = if dest.exists() { unique_path(&dir, &format!("{stem}{}", clean_suffix(&job.suffix)), "mp4") } else { dest };
    std::fs::rename(&partial, &dest).map_err(|e| {
        let _ = std::fs::remove_file(&partial);
        format!("Couldn't save the output: {e}")
    })?;
    Ok(dest.to_string_lossy().to_string())
}

/// Stop a running render (no-op when it already finished).
#[tauri::command]
pub fn quick_edit_cancel(id: String) {
    cancelled().lock().unwrap_or_else(|e| e.into_inner()).insert(id.clone());
    if let Some(child) = running().lock().unwrap_or_else(|e| e.into_inner()).get(&id) {
        let _ = child.lock().unwrap_or_else(|e| e.into_inner()).kill();
    }
}

fn running() -> &'static Mutex<HashMap<String, Arc<Mutex<Child>>>> {
    static R: OnceLock<Mutex<HashMap<String, Arc<Mutex<Child>>>>> = OnceLock::new();
    R.get_or_init(Default::default)
}

fn cancelled() -> &'static Mutex<HashSet<String>> {
    static C: OnceLock<Mutex<HashSet<String>>> = OnceLock::new();
    C.get_or_init(Default::default)
}

fn is_cancelled(id: &str) -> bool {
    cancelled().lock().unwrap_or_else(|e| e.into_inner()).contains(id)
}

fn take_cancel(id: &str) -> bool {
    cancelled().lock().unwrap_or_else(|e| e.into_inner()).remove(id)
}

/// Run ffmpeg (args must include `-progress pipe:1`), emitting progress for `id`.
fn run_with_progress(app: &AppHandle, id: &str, args: &[String], duration: f64) -> Result<(), String> {
    if is_cancelled(id) {
        return Err(CANCELLED.into());
    }
    let mut child = ffmpeg_command()
        .args(args)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| format!("failed to launch ffmpeg: {e}"))?;
    let stdout = child.stdout.take().ok_or("ffmpeg stdout unavailable")?;
    let mut stderr = child.stderr.take().ok_or("ffmpeg stderr unavailable")?;
    // Drain stderr on its own thread so a chatty ffmpeg can't block on a full pipe.
    let err_reader = std::thread::spawn(move || {
        let mut buf = String::new();
        let _ = stderr.read_to_string(&mut buf);
        buf
    });

    let child = Arc::new(Mutex::new(child));
    running().lock().unwrap_or_else(|e| e.into_inner()).insert(id.to_string(), child.clone());
    // A cancel that landed between the check above and registering the child.
    if is_cancelled(id) {
        let _ = child.lock().unwrap_or_else(|e| e.into_inner()).kill();
    }

    let mut last = -1.0_f64;
    for line in BufReader::new(stdout).lines().map_while(Result::ok) {
        let Some(us) = line.strip_prefix("out_time_us=").and_then(|v| v.trim().parse::<f64>().ok()) else { continue };
        if duration <= 0.0 {
            continue;
        }
        let p = (us / 1_000_000.0 / duration).clamp(0.0, 1.0);
        if p - last >= 0.005 {
            last = p;
            let _ = app.emit(PROGRESS_EVENT, ProgressPayload { id, progress: p });
        }
    }

    running().lock().unwrap_or_else(|e| e.into_inner()).remove(id);
    let status = child.lock().unwrap_or_else(|e| e.into_inner()).wait().map_err(|e| e.to_string())?;
    let err = err_reader.join().unwrap_or_default();
    if is_cancelled(id) {
        return Err(CANCELLED.into());
    }
    if !status.success() {
        let tail: Vec<&str> = err.lines().rev().take(6).collect();
        let tail = tail.into_iter().rev().collect::<Vec<_>>().join("\n");
        return Err(friendly_error(&tail));
    }
    let _ = app.emit(PROGRESS_EVENT, ProgressPayload { id, progress: 1.0 });
    Ok(())
}

fn friendly_error(err: &str) -> String {
    if err.contains("No space left") {
        "Not enough free disk space in the output folder.".into()
    } else if err.contains("Permission denied") {
        "No permission to write to the output folder.".into()
    } else if err.contains("Invalid data found") || err.contains("moov atom not found") {
        "This video can't be read — it may be damaged or still downloading.".into()
    } else if err.trim().is_empty() {
        "ffmpeg stopped unexpectedly.".into()
    } else {
        format!("ffmpeg failed: {err}")
    }
}

/// Keep a file-name suffix to safe characters (no separators, no traversal).
fn clean_suffix(raw: &str) -> String {
    let s: String = raw
        .chars()
        .filter(|c| c.is_alphanumeric() || matches!(c, '_' | '-' | ' ' | '.'))
        .take(40)
        .collect();
    let s = s.trim_matches('.').to_string();
    if s.is_empty() { "_edit".into() } else { s }
}

/// `<dir>/<base>.<ext>`, or `<base> (2).<ext>` … when taken.
fn unique_path(dir: &Path, base: &str, ext: &str) -> PathBuf {
    let first = dir.join(format!("{base}.{ext}"));
    if !first.exists() {
        return first;
    }
    (2..10_000)
        .map(|n| dir.join(format!("{base} ({n}).{ext}")))
        .find(|p| !p.exists())
        .unwrap_or(first)
}

// ── ffmpeg arguments (pure — unit-tested) ─────────────────────────────────────

struct Music {
    path: String,
    mono: bool,
    gain: f32,
    offset: f64,
    fade_in: f64,
    fade_out: f64,
}

struct Plan {
    input: String,
    music: Option<Music>,
    original_gain: f32,
    has_audio: bool,
    mono_audio: bool,
    /// Seconds (0 = unknown).
    duration: f64,
    hevc: bool,
}

#[derive(Clone, Copy, PartialEq)]
enum VideoMode {
    Copy,
    Encode,
}

const STEREO: &str = "aformat=sample_fmts=fltp:sample_rates=48000:channel_layouts=stereo";
/// Mono → both channels at full level. A plain `aformat` upmix spreads it at -3 dB
/// per channel, which plays back noticeably quieter than the original.
const MONO_UP: &str = "pan=stereo|c0=c0|c1=c0,";

fn to_stereo(mono: bool) -> String {
    format!("{}{STEREO}", if mono { MONO_UP } else { "" })
}
/// Catches peaks a boosted gain or the mix would push past full scale. `level=0`
/// stops it from also auto-raising quiet audio.
const LIMITER: &str = "alimiter=limit=0.97:level=0";

impl Plan {
    fn keeps_original(&self) -> bool {
        self.has_audio && self.original_gain > 0.0
    }

    /// The `-filter_complex` graph ending in `[aout]`, or None for a silent output.
    fn audio_filter(&self) -> Option<String> {
        let orig = format!("[0:a]{},volume={:.3}", to_stereo(self.mono_audio), self.original_gain);
        let Some(m) = &self.music else {
            if !self.keeps_original() {
                return None;
            }
            // A plain cut needs no limiter; a boost does.
            let limit = if self.original_gain > 1.0 { format!(",{LIMITER}") } else { String::new() };
            return Some(format!("{orig}{limit}[aout]"));
        };

        let mut bgm = format!("[1:a]{},volume={:.3}", to_stereo(m.mono), m.gain);
        if m.fade_in > 0.0 {
            bgm.push_str(&format!(",afade=t=in:st=0:d={:.3}", m.fade_in));
        }
        if m.fade_out > 0.0 && self.duration > 0.0 {
            let d = m.fade_out.min(self.duration);
            bgm.push_str(&format!(",afade=t=out:st={:.3}:d={d:.3}", self.duration - d));
        }
        Some(if self.keeps_original() {
            // normalize=0: amix would otherwise divide every input by the input
            // count, quietly halving both the music and the original audio.
            format!(
                "{orig}[a0];{bgm}[bgm];[a0][bgm]amix=inputs=2:duration=first:dropout_transition=0:normalize=0,{LIMITER}[aout]"
            )
        } else {
            format!("{bgm},{LIMITER}[aout]")
        })
    }

    fn args(&self, mode: VideoMode, dest: &Path) -> Vec<String> {
        let mut a: Vec<String> = ["-y", "-hide_banner", "-nostats", "-loglevel", "error", "-progress", "pipe:1"]
            .iter()
            .map(|x| s(x))
            .collect();
        push_input(&mut a, &self.input);
        if let Some(m) = &self.music {
            // Loop the music for as long as the video runs.
            a.extend([s("-stream_loop"), s("-1")]);
            if m.offset > 0.0 {
                a.extend([s("-ss"), format!("{:.3}", m.offset)]);
            }
            push_input(&mut a, &m.path);
        }

        let filter = self.audio_filter();
        a.extend([s("-map"), s("0:v:0")]);
        match &filter {
            Some(f) => a.extend([s("-filter_complex"), f.clone(), s("-map"), s("[aout]")]),
            None => a.push(s("-an")),
        }

        match mode {
            VideoMode::Copy => {
                a.extend([s("-c:v"), s("copy")]);
                if self.hevc {
                    // Apple players only accept HEVC in MP4 with the hvc1 tag.
                    a.extend([s("-tag:v"), s("hvc1")]);
                }
            }
            VideoMode::Encode => a.extend(
                ["-c:v", "libx264", "-crf", "18", "-preset", "fast", "-pix_fmt", "yuv420p"].iter().map(|x| s(x)),
            ),
        }
        if filter.is_some() {
            a.extend([s("-c:a"), s("aac"), s("-b:a"), s("192k")]);
        }
        // The looped music is endless; without the original track to end the mix,
        // stop at the video's length.
        if self.music.is_some() && !self.keeps_original() {
            if self.duration > 0.0 {
                a.extend([s("-t"), format!("{:.3}", self.duration)]);
            } else {
                a.push(s("-shortest"));
            }
        }
        a.extend([s("-map_metadata"), s("0"), s("-movflags"), s("+faststart"), s("-f"), s("mp4")]);
        a.push(dest.to_string_lossy().to_string());
        a
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn plan(music: bool, has_audio: bool, original_gain: f32) -> Plan {
        Plan {
            input: "in.mp4".into(),
            music: music.then(|| Music { path: "m.mp3".into(), mono: false, gain: 2.5, offset: 0.0, fade_in: 1.0, fade_out: 2.0 }),
            original_gain,
            has_audio,
            mono_audio: false,
            duration: 10.0,
            hevc: false,
        }
    }

    #[test]
    fn mix_keeps_full_volume_and_limits_peaks() {
        let f = plan(true, true, 1.0).audio_filter().unwrap();
        assert!(f.contains("normalize=0"));
        assert!(f.contains("volume=2.500"));
        assert!(f.contains("afade=t=in:st=0:d=1.000"));
        assert!(f.contains("afade=t=out:st=8.000:d=2.000"));
        assert!(f.ends_with("alimiter=limit=0.97:level=0[aout]"));
    }

    #[test]
    fn music_only_when_video_is_silent_or_muted() {
        for p in [plan(true, false, 1.0), plan(true, true, 0.0)] {
            let f = p.audio_filter().unwrap();
            assert!(!f.contains("[0:a]") && !f.contains("amix"));
            let a = p.args(VideoMode::Copy, Path::new("o.mp4"));
            assert!(a.windows(2).any(|w| w[0] == "-t" && w[1] == "10.000"));
        }
    }

    #[test]
    fn volume_only_edit() {
        assert_eq!(plan(false, true, 0.5).audio_filter().unwrap(), format!("[0:a]{STEREO},volume=0.500[aout]"));
        assert!(plan(false, true, 1.5).audio_filter().unwrap().contains("alimiter"));
        let mono = Plan { mono_audio: true, ..plan(false, true, 1.0) };
        assert!(mono.audio_filter().unwrap().starts_with("[0:a]pan=stereo|c0=c0|c1=c0,"));
        assert!(plan(false, false, 1.0).audio_filter().is_none());
        assert!(plan(false, true, 0.0).args(VideoMode::Copy, Path::new("o.mp4")).contains(&s("-an")));
    }

    #[test]
    fn copy_mode_never_reencodes_video() {
        let a = plan(true, true, 1.0).args(VideoMode::Copy, Path::new("o.mp4"));
        assert!(a.windows(2).any(|w| w[0] == "-c:v" && w[1] == "copy"));
        assert!(a.windows(2).any(|w| w[0] == "-stream_loop" && w[1] == "-1"));
        let e = plan(true, true, 1.0).args(VideoMode::Encode, Path::new("o.mp4"));
        assert!(e.contains(&s("libx264")));
    }

    #[test]
    fn suffix_is_sanitised() {
        assert_eq!(clean_suffix("_edit"), "_edit");
        assert_eq!(clean_suffix("../../x"), "x");
        assert_eq!(clean_suffix("a/b\\c"), "abc");
        assert_eq!(clean_suffix(""), "_edit");
    }

    #[test]
    fn parses_ffmpeg_info() {
        let out = "Input #0, mov,mp4,m4a,3gp,3g2,mj2, from 'in.mp4':\n  Duration: 00:01:02.50, start: 0.000000, bitrate: 929 kb/s\n  Stream #0:0[0x1](und): Video: hevc (Main) (hvc1 / 0x31637668), yuv420p, 1920x1080, 30 fps\n  Stream #0:1[0x2](und): Audio: aac (LC), 44100 Hz, stereo\n";
        assert_eq!(
            parse_info(out),
            Some(VideoInfo { duration: 62.5, width: 1920, height: 1080, has_audio: true, video_codec: "hevc".into(), mono_audio: false })
        );
        assert!(first_audio_is_mono("  Stream #0:0: Audio: mp3 (mp3float), 44100 Hz, mono, fltp, 64 kb/s"));
        assert_eq!(parse_clock("N/A"), None);
    }
}
