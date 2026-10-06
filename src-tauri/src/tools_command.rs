//! Local ffmpeg utility commands (Clip Merger, Audio Toolkit). The frontend writes
//! its input files to temp (via `export_save_clip`) and passes the paths here; we
//! shell out to the downloaded ffmpeg (`FFMPEG_PATH`, else `ffmpeg` on PATH) and
//! return the finished bytes — nothing is uploaded.

use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};

#[cfg(windows)]
use std::os::windows::process::CommandExt;
#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x0800_0000;

/// The ffmpeg binary — same resolution as crates/whisper.
fn ffmpeg_bin() -> String {
    std::env::var(crate::deps_command::FFMPEG_ENV).unwrap_or_else(|_| "ffmpeg".to_string())
}

fn ffmpeg_command() -> Command {
    let mut c = Command::new(ffmpeg_bin());
    #[cfg(windows)]
    c.creation_flags(CREATE_NO_WINDOW);
    c
}

/// Run ffmpeg with the given args; return the tail of stderr on failure.
fn run_ffmpeg(args: &[String]) -> Result<(), String> {
    let out = ffmpeg_command()
        .args(args)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::piped())
        .output()
        .map_err(|e| format!("failed to launch ffmpeg: {e}"))?;
    if !out.status.success() {
        let err = String::from_utf8_lossy(&out.stderr);
        let tail = err.lines().rev().take(8).collect::<Vec<_>>();
        let tail = tail.into_iter().rev().collect::<Vec<_>>().join("\n");
        return Err(format!("ffmpeg failed: {tail}"));
    }
    Ok(())
}

/// Probe a clip's DISPLAYED WxH by parsing `ffmpeg -i` stderr (ffprobe isn't
/// bundled). Phone footage is often stored landscape with a 90° rotation flag;
/// ffmpeg auto-rotates while filtering, so the flag is applied here too.
/// Falls back to 1080x1920 (portrait) like the old server default.
fn probe_resolution(path: &str) -> (u32, u32) {
    let out = ffmpeg_command()
        .args(["-hide_banner", "-protocol_whitelist", "file", "-i", path])
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::piped())
        .output();
    match out {
        Ok(o) => parse_probe(&String::from_utf8_lossy(&o.stderr)).unwrap_or((1080, 1920)),
        Err(_) => (1080, 1920),
    }
}

/// The first video stream's WxH from `ffmpeg -i` output, swapped when the stream
/// carries a quarter-turn rotation (`rotate: 90` or `displaymatrix: rotation of -90.00`).
fn parse_probe(stderr: &str) -> Option<(u32, u32)> {
    let mut lines = stderr.lines();
    let (w, h) = lines.by_ref().find(|l| l.contains("Video:")).and_then(parse_wxh)?;
    // Rotation metadata follows its stream line, before the next stream starts.
    let rotated = lines
        .take_while(|l| !l.trim_start().starts_with("Stream #"))
        .filter_map(|l| {
            let l = l.trim();
            let v = l
                .strip_prefix("rotate")
                .and_then(|r| r.split(':').nth(1))
                .or_else(|| l.split("rotation of").nth(1))?;
            v.trim().trim_end_matches("degrees").trim().parse::<f32>().ok()
        })
        .next()
        .map(|deg| (deg.abs().round() as i32) % 180 == 90)
        .unwrap_or(false);
    Some(if rotated { (h, w) } else { (w, h) })
}

/// Largest short side a merge will output (4K). Anything above is scaled down.
const MAX_SHORT_SIDE: u32 = 2160;

/// Output frame size for a merge. Resolution is never thrown away: the short side
/// is the LARGEST short side among the inputs, so a 1080p B-roll is never squeezed
/// into a 720p main clip's frame. The shape comes from `aspect` ("9:16", "16:9",
/// "1:1", "4:5") or, for "auto"/anything else, from the main clip.
fn merge_target_size(dims: &[(u32, u32)], aspect: &str, main_index: usize) -> (u32, u32) {
    let short = dims
        .iter()
        .map(|&(w, h)| w.min(h))
        .max()
        .unwrap_or(1080)
        .clamp(16, MAX_SHORT_SIDE);
    let (aw, ah) = aspect
        .split_once(':')
        .and_then(|(a, b)| Some((a.trim().parse::<u32>().ok()?, b.trim().parse::<u32>().ok()?)))
        .filter(|&(a, b)| a > 0 && b > 0)
        .unwrap_or_else(|| dims.get(main_index).or(dims.first()).copied().unwrap_or((1080, 1920)));
    // libx264 + yuv420p need even dimensions.
    let even = |v: f64| ((v / 2.0).round() as u32).max(8) * 2;
    if aw <= ah {
        (even(short as f64), even(short as f64 * ah as f64 / aw as f64))
    } else {
        (even(short as f64 * aw as f64 / ah as f64), even(short as f64))
    }
}

/// Probe every clip and resolve the merge output size (see `merge_target_size`).
fn resolve_merge_size(clip_paths: &[String], aspect: Option<&str>, main_index: Option<usize>) -> (u32, u32) {
    let dims: Vec<(u32, u32)> = clip_paths.iter().map(|p| probe_resolution(p)).collect();
    merge_target_size(&dims, aspect.unwrap_or("auto"), main_index.unwrap_or(0))
}

/// Find a `<w>x<h>` token (e.g. "1920x1080") in a line of ffmpeg output.
fn parse_wxh(line: &str) -> Option<(u32, u32)> {
    for tok in line.split(|c: char| c == ' ' || c == ',' || c == '[' || c == ']') {
        let t = tok.trim();
        if let Some(idx) = t.find('x') {
            let (a, b) = t.split_at(idx);
            let b = &b[1..];
            if let (Ok(w), Ok(h)) = (a.parse::<u32>(), b.parse::<u32>()) {
                if w >= 16 && h >= 16 && w <= 8192 && h <= 8192 {
                    return Some((w, h));
                }
            }
        }
    }
    None
}

fn make_temp_dir(prefix: &str) -> Result<PathBuf, String> {
    let nanos = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    let dir = std::env::temp_dir().join(format!("{}-{prefix}-{nanos}", crate::branding::TEMP_PREFIX));
    std::fs::create_dir_all(&dir).map_err(|e| format!("temp dir: {e}"))?;
    Ok(dir)
}

fn cleanup(dir: &Path) {
    let _ = std::fs::remove_dir_all(dir);
}

fn s(v: &str) -> String {
    v.to_string()
}

/// Push a local input as `-protocol_whitelist file -i <path>`. The whitelist
/// (belt-and-suspenders with `confine_existing` on the caller side) refuses every
/// ffmpeg input protocol except local files, so `-i` can never reach the network
/// (http/https) or auxiliary readers even if confinement is somehow bypassed.
fn push_input(args: &mut Vec<String>, path: &str) {
    args.push(s("-protocol_whitelist"));
    args.push(s("file"));
    args.push(s("-i"));
    args.push(s(path));
}

/// Confine ONE caller-supplied ffmpeg input path to the app-managed roots (app-data +
/// the export/whisper temp dirs where the frontend stages merge inputs via
/// `export_save_clip`). Rejects traversal / arbitrary on-disk files / non-file URLs
/// before the path reaches ffmpeg.
fn confine_one(app: &tauri::AppHandle, path: &str) -> Result<String, String> {
    crate::security::confine_app_file(app, path).map(|pb| pb.to_string_lossy().to_string())
}

/// Confine a list of caller-supplied ffmpeg input paths (see `confine_one`).
fn confine_inputs(app: &tauri::AppHandle, paths: &[String]) -> Result<Vec<String>, String> {
    paths.iter().map(|p| confine_one(app, p)).collect()
}

/// Short side of the memory-saving fallback encode.
const LEAN_SHORT_SIDE: u32 = 1080;

/// One encode attempt of `ffmpeg_merge_videos`.
struct Encode {
    w: u32,
    h: u32,
    crf: &'static str,
    preset: &'static str,
    /// Fewer threads, a short look-ahead and fewer reference frames: a fraction of
    /// the default encoder memory, for machines that ran out.
    lean: bool,
}

/// ffmpeg args that normalise every clip to `enc.w`×`enc.h` + 30fps (+ stereo
/// 44.1k audio when `with_audio`) and concat them into `dest`.
fn concat_args(clip_paths: &[String], enc: &Encode, with_audio: bool, dest: &Path) -> Vec<String> {
    let (tw, th) = (enc.w, enc.h);
    let n = clip_paths.len();
    // Lanczos keeps upscaled clips sharp (the default bicubic softens them).
    let mut parts: Vec<String> = Vec::new();
    for i in 0..n {
        parts.push(format!(
            "[{i}:v]scale={tw}:{th}:force_original_aspect_ratio=decrease:flags=lanczos,\
             pad={tw}:{th}:(ow-iw)/2:(oh-ih)/2,setsar=1,fps=30,format=yuv420p[v{i}]"
        ));
        if with_audio {
            parts.push(format!(
                "[{i}:a]aresample=44100,aformat=sample_fmts=fltp:channel_layouts=stereo[a{i}]"
            ));
        }
    }
    let seg: String = (0..n)
        .map(|i| if with_audio { format!("[v{i}][a{i}]") } else { format!("[v{i}]") })
        .collect();
    let a = if with_audio { 1 } else { 0 };
    let outs = if with_audio { "[v][a]" } else { "[v]" };
    let filter = format!("{};{seg}concat=n={n}:v=1:a={a}{outs}", parts.join(";"));

    let mut args: Vec<String> = vec![s("-y")];
    for p in clip_paths {
        if enc.lean {
            // Per-input decoder threads; all inputs stay open for the whole concat.
            args.extend([s("-threads"), s("2")]);
        }
        push_input(&mut args, p);
    }
    if enc.lean {
        args.extend([s("-filter_complex_threads"), s("1")]);
    }
    args.extend([s("-filter_complex"), filter, s("-map"), s("[v]")]);
    if with_audio {
        args.extend([s("-map"), s("[a]")]);
    }
    args.extend([s("-c:v"), s("libx264"), s("-crf"), s(enc.crf), s("-preset"), s(enc.preset)]);
    if enc.lean {
        args.extend([s("-threads"), s("2"), s("-x264-params"), s("rc-lookahead=10:ref=2")]);
    }
    if with_audio {
        args.extend([s("-c:a"), s("aac"), s("-b:a"), s("192k")]);
    }
    args.extend([s("-movflags"), s("+faststart"), dest.to_string_lossy().to_string()]);
    args
}

/// Scale `w`×`h` down so its short side is at most `max_short` (even dimensions).
fn cap_short_side(w: u32, h: u32, max_short: u32) -> (u32, u32) {
    let short = w.min(h);
    if short <= max_short {
        return (w, h);
    }
    let k = max_short as f64 / short as f64;
    let even = |v: f64| ((v / 2.0).round() as u32).max(8) * 2;
    (even(w as f64 * k), even(h as f64 * k))
}

/// ffmpeg failed because the machine ran out of memory (or libx264 could not
/// allocate its buffers, which it reports as a generic external-library error).
fn is_resource_error(err: &str) -> bool {
    const SIGNS: [&str; 5] = [
        "Cannot allocate memory",
        "Generic error in an external library",
        "Could not open encoder",
        "Error while opening encoder",
        "out of memory",
    ];
    SIGNS.iter().any(|sig| err.contains(sig))
}

/// A short, actionable message instead of ffmpeg's raw stderr tail.
fn friendly_merge_error(err: &str) -> String {
    if is_resource_error(err) {
        "Not enough free memory to render this merge, even at 1080p. Close other apps, \
         set Parallel jobs to 1 or Render quality to Fast, and try again."
            .into()
    } else if err.contains("Invalid data found") || err.contains("moov atom not found") {
        "One of the clips can't be read — it may be damaged or still downloading.".into()
    } else {
        err.to_string()
    }
}

/// Concatenate 2+ video clips (+ optional looped background music) into one MP4.
/// `(async)` — the ffmpeg subprocess wait must not block the webview main thread.
#[tauri::command(async)]
pub fn ffmpeg_merge_videos(
    app: tauri::AppHandle,
    clip_paths: Vec<String>,
    music_path: Option<String>,
    music_volume: f32,
    quality: String,
    // Output shape: "auto" (the main clip's) | "9:16" | "16:9" | "1:1" | "4:5".
    aspect: Option<String>,
    // Which of `clip_paths` is the main clip — the "auto" aspect follows it.
    main_index: Option<usize>,
) -> Result<tauri::ipc::Response, String> {
    if clip_paths.len() < 2 {
        return Err("Need at least 2 clips to merge.".into());
    }
    // Confine every caller-supplied input to app-managed dirs BEFORE it reaches ffmpeg
    // (SSRF / arbitrary-read hardening — an injected script could otherwise point `-i`
    // at any local file or an internal URL). Legit inputs are staged into the export
    // temp dir via export_save_clip, which is an app-managed root.
    let clip_paths = confine_inputs(&app, &clip_paths)?;
    let music_path = match music_path.as_deref() {
        Some(p) => Some(confine_one(&app, p)?),
        None => None,
    };
    let (crf, preset) = match quality.as_str() {
        "balanced" => ("23", "fast"),
        "fast" => ("28", "veryfast"),
        _ => ("18", "slow"),
    };
    let vol = music_volume.clamp(0.0, 1.0);

    let dir = make_temp_dir("merge")?;
    let out_path = dir.join("merged.mp4");
    let concat_path = dir.join("concat.mp4");
    // When mixing music we write the concat step to a temp file first.
    let concat_dest = if music_path.is_some() { &concat_path } else { &out_path };

    let (tw, th) = resolve_merge_size(&clip_paths, aspect.as_deref(), main_index);

    // Encode, stepping down when the machine runs out of memory instead of failing:
    // a 4K target with `-preset slow` and 2+ parallel jobs can need several GB, and
    // libx264 then fails to open ("Generic error in an external library") or a
    // decoder reports "Cannot allocate memory". Each rung uses less memory: first
    // the same size with a lean encoder, then capped to 1080p.
    let (lw, lh) = cap_short_side(tw, th, LEAN_SHORT_SIDE);
    let mut rungs = vec![
        Encode { w: tw, h: th, crf, preset, lean: false },
        Encode { w: tw, h: th, crf, preset: "veryfast", lean: true },
    ];
    if (lw, lh) != (tw, th) {
        rungs.push(Encode { w: lw, h: lh, crf, preset: "veryfast", lean: true });
    }

    let mut last_err = String::new();
    let mut encoded = false;
    for (i, enc) in rungs.iter().enumerate() {
        if i > 0 {
            log::warn!("merge: retrying at {}x{} with lean settings after: {last_err}", enc.w, enc.h);
        }
        // With audio first; if a clip has no audio stream, video-only at the same rung.
        let mut res = run_ffmpeg(&concat_args(&clip_paths, enc, true, concat_dest));
        if let Err(e) = &res {
            if !is_resource_error(e) {
                res = run_ffmpeg(&concat_args(&clip_paths, enc, false, concat_dest));
            }
        }
        match res {
            Ok(()) => {
                encoded = true;
                break;
            }
            Err(e) => {
                let resource = is_resource_error(&e);
                last_err = e;
                if !resource {
                    break;
                }
            }
        }
    }
    if !encoded {
        cleanup(&dir);
        log::warn!("merge failed: {last_err}");
        return Err(friendly_merge_error(&last_err));
    }

    // Mix background music (optional): loop it, apply volume, amix with clip audio.
    if let Some(mp) = music_path.as_ref() {
        let mut mix_args: Vec<String> = vec![s("-y")];
        push_input(&mut mix_args, concat_path.to_string_lossy().as_ref());
        push_input(&mut mix_args, mp);
        mix_args.extend([
            s("-filter_complex"),
            format!(
                "[1:a]volume={vol},aloop=loop=-1:size=2e+09[bgm];\
                 [0:a][bgm]amix=inputs=2:duration=first:dropout_transition=2[aout]"
            ),
            s("-map"), s("0:v"), s("-map"), s("[aout]"),
            s("-c:v"), s("copy"), s("-c:a"), s("aac"), s("-b:a"), s("192k"),
            s("-movflags"), s("+faststart"),
            out_path.to_string_lossy().to_string(),
        ]);
        if run_ffmpeg(&mix_args).is_err() {
            // Concat had no audio track → mux the music as the sole audio.
            let mut mux_args: Vec<String> = vec![s("-y")];
            push_input(&mut mux_args, concat_path.to_string_lossy().as_ref());
            push_input(&mut mux_args, mp);
            mux_args.extend([
                s("-map"), s("0:v"), s("-map"), s("1:a"),
                s("-filter:a"), format!("volume={vol}"),
                s("-c:v"), s("copy"), s("-c:a"), s("aac"), s("-b:a"), s("192k"),
                s("-shortest"), s("-movflags"), s("+faststart"),
                out_path.to_string_lossy().to_string(),
            ]);
            if let Err(e) = run_ffmpeg(&mux_args) {
                cleanup(&dir);
                return Err(e);
            }
        }
    }

    let bytes = match std::fs::read(&out_path) {
        Ok(b) => b,
        Err(e) => {
            cleanup(&dir);
            return Err(format!("read output: {e}"));
        }
    };
    cleanup(&dir);
    Ok(tauri::ipc::Response::new(bytes))
}

/// Concatenate 1+ audio files (optionally looped) into one mp3/wav.
/// `(async)` — the ffmpeg subprocess wait must not block the webview main thread.
#[tauri::command(async)]
pub fn ffmpeg_merge_audio(
    app: tauri::AppHandle,
    clip_paths: Vec<String>,
    format: String,
    // Optional: repeat the whole ordered sequence this many times (looping a track
    // into a long mix). Defaults to 1 (plain merge, unchanged behaviour).
    loops: Option<u32>,
) -> Result<tauri::ipc::Response, String> {
    let loops = loops.unwrap_or(1).max(1) as usize;
    let n = clip_paths.len();
    let total = n * loops;
    if n == 0 {
        return Err("Add at least one audio file.".into());
    }
    // Confine every caller-supplied input to app-managed dirs before ffmpeg sees it
    // (SSRF / arbitrary-read hardening — see ffmpeg_merge_videos).
    let clip_paths = confine_inputs(&app, &clip_paths)?;
    // total >= 1 is guaranteed (n>=1, loops>=1). A single file looped once is a
    // valid (re-encode) output; the page enforces "≥2 files" for plain merges.
    let fmt = if format == "wav" { "wav" } else { "mp3" };
    let dir = make_temp_dir("audiomerge")?;
    let out_path = dir.join(format!("merged.{fmt}"));

    // filter_complex: for loops==1 keep the simple concat; otherwise normalise +
    // asplit each input into `loops` copies (decoded once, duplicated in-graph) and
    // concat the sequence loop-by-loop. The output streams to disk so a multi-hour
    // loop stays bounded by input size, not output size.
    let filter = if loops == 1 {
        let concat_in: String = (0..n).map(|i| format!("[{i}:a]")).collect();
        format!("{concat_in}concat=n={n}:v=0:a=1[out]")
    } else {
        let mut parts: Vec<String> = Vec::with_capacity(n);
        for i in 0..n {
            let labels: String = (0..loops).map(|l| format!("[a{i}_{l}]")).collect();
            // normalise sample rate + channel layout so the copies concat cleanly
            parts.push(format!(
                "[{i}:a]aresample=44100,aformat=channel_layouts=stereo,asplit={loops}{labels}"
            ));
        }
        let mut concat_in = String::new();
        for l in 0..loops {
            for i in 0..n {
                concat_in.push_str(&format!("[a{i}_{l}]"));
            }
        }
        format!("{};{concat_in}concat=n={total}:v=0:a=1[out]", parts.join(";"))
    };

    let mut args: Vec<String> = vec![s("-y")];
    for p in &clip_paths {
        push_input(&mut args, p);
    }
    args.push(s("-filter_complex"));
    args.push(filter);
    if fmt == "wav" {
        args.extend(["-map", "[out]", "-c:a", "pcm_s16le", "-ar", "44100"].iter().map(|x| s(x)));
    } else {
        args.extend(
            ["-map", "[out]", "-c:a", "libmp3lame", "-q:a", "2", "-ar", "44100"]
                .iter()
                .map(|x| s(x)),
        );
    }
    args.push(out_path.to_string_lossy().to_string());

    if let Err(e) = run_ffmpeg(&args) {
        cleanup(&dir);
        return Err(e);
    }
    let bytes = match std::fs::read(&out_path) {
        Ok(b) => b,
        Err(e) => {
            cleanup(&dir);
            return Err(format!("read output: {e}"));
        }
    };
    cleanup(&dir);
    Ok(tauri::ipc::Response::new(bytes))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn never_shrinks_below_the_sharpest_clip() {
        // 720p main + 1080p B-roll → 1080-wide portrait, not 720.
        assert_eq!(merge_target_size(&[(720, 1280), (1080, 1920)], "auto", 0), (1080, 1920));
        // Landscape B-roll still counts by its short side.
        assert_eq!(merge_target_size(&[(720, 1280), (1920, 1080)], "auto", 0), (1080, 1920));
    }

    #[test]
    fn auto_follows_the_main_clip_not_the_first() {
        assert_eq!(merge_target_size(&[(1920, 1080), (1080, 1920)], "auto", 1), (1080, 1920));
    }

    #[test]
    fn presets_set_the_shape() {
        let d = [(1080, 1920), (1080, 1920)];
        assert_eq!(merge_target_size(&d, "16:9", 0), (1920, 1080));
        assert_eq!(merge_target_size(&d, "1:1", 0), (1080, 1080));
        assert_eq!(merge_target_size(&d, "4:5", 0), (1080, 1350));
    }

    #[test]
    fn caps_at_4k_and_stays_even() {
        assert_eq!(merge_target_size(&[(4320, 7680)], "auto", 0), (2160, 3840));
        let (w, h) = merge_target_size(&[(721, 1283)], "auto", 0);
        assert!(w % 2 == 0 && h % 2 == 0);
    }

    #[test]
    fn caps_short_side_for_the_lean_retry() {
        assert_eq!(cap_short_side(2160, 3840, 1080), (1080, 1920));
        assert_eq!(cap_short_side(3840, 2160, 1080), (1920, 1080));
        assert_eq!(cap_short_side(720, 1280, 1080), (720, 1280));
    }

    #[test]
    fn spots_out_of_memory_failures() {
        assert!(is_resource_error("[dec:h264] Error while opening decoder: Cannot allocate memory"));
        assert!(is_resource_error("Task finished with error code: -542398533 (Generic error in an external library)"));
        assert!(!is_resource_error("Stream specifier ':a' in filtergraph description matches no streams."));
    }

    #[test]
    fn probe_applies_rotation() {
        let out = "  Stream #0:0[0x1](und): Video: h264 (High), yuv420p, 1920x1080, 30 fps\n      Side data:\n        displaymatrix: rotation of -90.00 degrees\n  Stream #0:1: Audio: aac\n";
        assert_eq!(parse_probe(out), Some((1080, 1920)));
        let plain = "  Stream #0:0: Video: h264, yuv420p(tv), 1080x1920 [SAR 1:1 DAR 9:16], 30 fps\n";
        assert_eq!(parse_probe(plain), Some((1080, 1920)));
    }
}
