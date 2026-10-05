use std::collections::HashMap;
use std::io::{BufRead, BufReader};
use std::process::{Command, Stdio};
use std::sync::{Arc, Mutex};
use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager, State};

/// Product identity used by the native side (tray, log banner, temp dir names).
mod branding;
/// EVERY download URL in one place (upstream sources only).
mod sources;
/// Raw-body IPC helpers, chunk-streamed staging, the temp clip sink, temp sweep.
mod staging;
/// On-device Whisper transcription (crates/whisper).
mod whisper_command;
/// On-device neural TTS (Kokoro via crates/tts; Supertonic via crates/supertonic).
mod tts_command;
/// Open / reveal / copy / save / read / delete files.
mod fs_command;
/// First-run downloads (ffmpeg, yt-dlp) + the shared resumable downloader.
mod deps_command;
/// CLI brains — the user's own Claude Code / Codex / Gemini CLI driven as a local LLM.
mod cli_brain_command;
/// Local ffmpeg utility ops (video/audio merge) — on-device, no server.
mod tools_command;
/// Shared security helpers: path confinement + no-shell native open/reveal.
mod security;

/* ─── State ──────────────────────────────────────────────────────────────────── */

// Maps download-id → child PID (for cancellation via taskkill)
type DownloadMap = Arc<Mutex<HashMap<String, u32>>>;

/* ─── Event payloads ─────────────────────────────────────────────────────────── */

#[derive(Clone, Serialize)]
struct ProgressPayload {
    id: String,
    percent: f32,
    speed: String,
    eta: String,
    filename: String,
    current_item: u32,
    total_items: u32,
}

#[derive(Clone, Serialize)]
struct CompletePayload {
    id: String,
    output_dir: String,
}

#[derive(Clone, Serialize)]
struct ErrorPayload {
    id: String,
    message: String,
}

/* ─── Progress parser ────────────────────────────────────────────────────────── */

fn parse_progress(line: &str) -> Option<(f32, String, String)> {
    // [download]  45.2% of  123.45MiB at  1.23MiB/s ETA 00:42
    if !line.contains("[download]") || !line.contains('%') {
        return None;
    }

    let percent = line.split('%').next()?
        .split_whitespace().last()?
        .parse::<f32>().ok()?;

    let speed = if let Some(i) = line.find(" at ") {
        line[i + 4..].split_whitespace().next().unwrap_or("").to_string()
    } else {
        String::new()
    };

    let eta = if let Some(i) = line.find("ETA ") {
        line[i + 4..].split_whitespace().next().unwrap_or("").to_string()
    } else {
        String::new()
    };

    Some((percent, speed, eta))
}

/* ─── Commands ───────────────────────────────────────────────────────────────── */

/// Check whether yt-dlp is installed and return its version string.
/// `(async)` — runs the `yt-dlp --version` subprocess off the main thread.
#[tauri::command(async)]
fn ytdlp_check() -> Result<String, String> {
    let out = Command::new("yt-dlp")
        .arg("--version")
        .output()
        .map_err(|_| "yt-dlp not found. Please install it: https://github.com/yt-dlp/yt-dlp#installation".to_string())?;
    Ok(String::from_utf8_lossy(&out.stdout).trim().to_string())
}

/// Append `--cookies <path>` when the user has selected a cookies.txt for auth.
/// YouTube increasingly blocks anonymous requests ("Sign in to confirm you're not
/// a bot"); a cookies.txt from a logged-in session gets past that and unlocks full
/// playlists. Empty/blank paths are ignored, so this is a no-op when unset.
fn apply_cookies(args: &mut Vec<String>, cookies_path: &Option<String>) {
    if let Some(p) = cookies_path {
        if !p.trim().is_empty() {
            args.push("--cookies".into());
            args.push(p.clone());
        }
    }
}

/// Fetch single-video metadata as JSON string.
/// `(async)` — the yt-dlp network call blocks; keep it off the main thread.
#[tauri::command(async)]
fn ytdlp_fetch_info(url: String, cookies_path: Option<String>) -> Result<String, String> {
    let mut args: Vec<String> = vec![
        "--dump-json".into(),
        "--no-playlist".into(),
        "--no-warnings".into(),
        "--skip-download".into(),
    ];
    apply_cookies(&mut args, &cookies_path);
    args.push(url);

    let out = Command::new("yt-dlp")
        .args(&args)
        .output()
        .map_err(|e| format!("Failed to run yt-dlp: {}", e))?;

    if out.status.success() {
        Ok(String::from_utf8_lossy(&out.stdout).to_string())
    } else {
        Err(String::from_utf8_lossy(&out.stderr).to_string())
    }
}

/// Whitelist the ONLY yt-dlp flags the downloader UI legitimately passes as
/// `extra_args`, validating each flag's value. Every custom `#[tauri::command]` is
/// callable from any webview JS, and these args are appended BEFORE the `--` fence,
/// so an un-validated `extra_args` was command execution waiting to happen (e.g.
/// `--exec`, `--postprocessor-args`, `--paths`). Fail-closed: an unrecognized flag —
/// or a value that could itself be read as a flag (leading `-`) or contains
/// unexpected characters — rejects the whole download.
fn sanitize_ytdlp_extra_args(extra: Vec<String>) -> Result<Vec<String>, String> {
    // A value must never begin with `-` (yt-dlp would treat it as a new flag) and is
    // restricted to the characters the corresponding feature actually uses.
    fn value_ok(v: &str, allowed: fn(char) -> bool) -> bool {
        !v.is_empty() && !v.starts_with('-') && v.chars().all(allowed)
    }
    let mut out: Vec<String> = Vec::new();
    let mut it = extra.into_iter();
    while let Some(flag) = it.next() {
        match flag.as_str() {
            // Boolean flag, no value.
            "--force-keyframes-at-cuts" => out.push(flag),
            // Playlist range, e.g. "1-10", "1,3,5-8".
            "--playlist-items" => {
                let v = it.next().ok_or("--playlist-items needs a value")?;
                if !value_ok(&v, |c| c.is_ascii_digit() || matches!(c, ',' | '-' | ':')) {
                    return Err("invalid --playlist-items value".into());
                }
                out.push(flag);
                out.push(v);
            }
            // Time/section spec, e.g. "*00:01:00-00:02:00", "*10-inf".
            "--download-sections" => {
                let v = it.next().ok_or("--download-sections needs a value")?;
                if !value_ok(&v, |c| {
                    c.is_ascii_alphanumeric() || matches!(c, '*' | ':' | '.' | ',' | '-')
                }) {
                    return Err("invalid --download-sections value".into());
                }
                out.push(flag);
                out.push(v);
            }
            other => return Err(format!("unsupported download option: {other}")),
        }
    }
    Ok(out)
}

/// Start a download job. Streams progress events to the frontend.
/// `format_code`: yt-dlp format selector, e.g. "bestvideo+bestaudio/best"
/// `extra_args`: optional extra yt-dlp flags, e.g. ["--playlist-items", "1-10"]
#[tauri::command]
fn ytdlp_start(
    app: AppHandle,
    state: State<'_, DownloadMap>,
    id: String,
    urls: Vec<String>,
    output_dir: String,
    format_code: String,
    merge_format: String,
    extra_args: Vec<String>,
    cookies_path: Option<String>,
) -> Result<(), String> {
    // Confine the destination like the other user-folder writers (download/copy/export):
    // reject `..`, non-absolute paths, and system / autostart / app-bin locations, so a
    // script can't aim the download at (say) the Startup folder.
    security::reject_hostile_dest(&app, &output_dir)?;
    // Only the flags the UI actually uses are allowed, values validated. Rejects
    // anything that could smuggle command execution (--exec, --paths, …).
    let extra_args = sanitize_ytdlp_extra_args(extra_args)?;

    // Forward-slash output template — yt-dlp accepts `/` on every platform, so this
    // works on the intended macOS build too (the old hard-coded `\` broke it there).
    let out_dir = output_dir.trim_end_matches(['/', '\\']);
    let mut args: Vec<String> = vec![
        "--newline".into(),
        "--progress".into(),
        "--no-warnings".into(),
        "--no-part".into(),
        "-o".into(),
        format!("{}/%(playlist_index)02d-%(title)s.%(ext)s", out_dir),
        "-f".into(),
        format_code,
    ];

    // Output container / audio extract
    if merge_format == "mp3" || merge_format == "m4a" || merge_format == "aac" {
        args.push("-x".into());
        args.push("--audio-format".into());
        args.push(merge_format.clone());
    } else {
        args.push("--merge-output-format".into());
        args.push(merge_format);
    }

    apply_cookies(&mut args, &cookies_path);
    args.extend(extra_args);
    // `--` ends option parsing: a URL (or extra_arg) beginning with `-` can no
    // longer be misread as a yt-dlp flag (e.g. smuggling --exec / a post-processor).
    args.push("--".into());
    args.extend(urls);

    let mut child = security::quiet_command("yt-dlp")
        .args(&args)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| format!("Failed to start yt-dlp: {}. Is yt-dlp in PATH?", e))?;

    let pid = child.id();

    // Store PID for cancellation
    {
        let mut map = state.lock().unwrap_or_else(|e| e.into_inner());
        map.insert(id.clone(), pid);
    }

    let map_arc   = state.inner().clone();
    let app_clone = app.clone();
    let id_clone  = id.clone();
    let output_dir_clone = output_dir.clone();

    std::thread::spawn(move || {
        // Stdio::piped() above guarantees Some, but handle None gracefully rather
        // than panicking the worker thread (which would silently kill the download).
        let (stdout, stderr) = match (child.stdout.take(), child.stderr.take()) {
            (Some(o), Some(e)) => (o, e),
            _ => {
                let _ = app_clone.emit("ytdlp_error", ErrorPayload {
                    id: id_clone.clone(),
                    message: "Couldn't read yt-dlp output.".into(),
                });
                return;
            }
        };

        // Drain stderr on its OWN thread, concurrently with stdout. yt-dlp writes a
        // lot to stderr (format/throttle/auth notices — far more once cookies get it
        // past the bot wall). If we read stdout to completion FIRST, a full stderr
        // pipe (~64KB) blocks yt-dlp mid-write, it stops emitting stdout, and we
        // deadlock — the download freezes at 0%. Reading both at once prevents that.
        let stderr_buf = std::sync::Arc::new(std::sync::Mutex::new(String::new()));
        let stderr_buf_t = stderr_buf.clone();
        let stderr_thread = std::thread::spawn(move || {
            for line in BufReader::new(stderr).lines().flatten() {
                if !line.is_empty() {
                    if let Ok(mut b) = stderr_buf_t.lock() {
                        b.push_str(&line);
                        b.push('\n');
                    }
                }
            }
        });

        let mut current_file = String::new();
        let mut current_item: u32 = 0;
        let mut total_items: u32  = 1;

        // Read stdout
        for line in BufReader::new(stdout).lines().flatten() {
            if line.contains("[download] Downloading item") {
                // "[download] Downloading item 3 of 12" — 6 tokens. Read via .get() so a
                // malformed/short line can NEVER panic this stdout-reader thread (a panic
                // here would skip child.wait() and never emit ytdlp_complete/error, freezing
                // the download card). The old `parts.len() >= 5` guard indexed parts[5],
                // which needs len >= 6.
                let parts: Vec<&str> = line.split_whitespace().collect();
                current_item = parts.get(3).and_then(|s| s.parse().ok()).unwrap_or(current_item);
                total_items  = parts.get(5).and_then(|s| s.parse().ok()).unwrap_or(total_items);
                // Emit during the (often long) playlist prepare phase so the card
                // shows "item X of Y" advancing instead of a static "Preparing…".
                let _ = app_clone.emit("ytdlp_progress", ProgressPayload {
                    id: id_clone.clone(),
                    percent: 0.0,
                    speed: String::new(),
                    eta: String::new(),
                    filename: current_file.clone(),
                    current_item,
                    total_items,
                });
            } else if line.contains("[download] Destination:") {
                current_file = line
                    .trim_start_matches("[download] Destination:")
                    .trim()
                    .to_string();
                let _ = app_clone.emit("ytdlp_progress", ProgressPayload {
                    id: id_clone.clone(),
                    percent: 0.0,
                    speed: String::new(),
                    eta: String::new(),
                    filename: current_file.clone(),
                    current_item,
                    total_items,
                });
            } else if let Some((pct, spd, eta)) = parse_progress(&line) {
                let _ = app_clone.emit("ytdlp_progress", ProgressPayload {
                    id: id_clone.clone(),
                    percent: pct,
                    speed: spd,
                    eta,
                    filename: current_file.clone(),
                    current_item,
                    total_items,
                });
            } else if line.contains("[Merger]") || line.contains("Deleting original file") {
                let _ = app_clone.emit("ytdlp_progress", ProgressPayload {
                    id: id_clone.clone(),
                    percent: 99.0,
                    speed: "merging…".into(),
                    eta: String::new(),
                    filename: current_file.clone(),
                    current_item,
                    total_items,
                });
            }
        }

        // stdout hit EOF — the process is finishing; join the stderr drainer now.
        let _ = stderr_thread.join();
        let stderr_buf = stderr_buf.lock().map(|b| b.clone()).unwrap_or_default();

        // Remove from active map
        let was_cancelled = {
            let mut map = map_arc.lock().unwrap_or_else(|e| e.into_inner());
            map.remove(&id_clone).is_none()
        };

        // Wait for process
        match child.wait() {
            Ok(status) if status.success() => {
                let _ = app_clone.emit("ytdlp_complete", CompletePayload {
                    id: id_clone.clone(),
                    output_dir: output_dir_clone,
                });
            }
            _ if was_cancelled => {
                let _ = app_clone.emit("ytdlp_error", ErrorPayload {
                    id: id_clone.clone(),
                    message: "Cancelled".into(),
                });
            }
            _ => {
                let msg = if stderr_buf.is_empty() {
                    "Download failed.".to_string()
                } else {
                    stderr_buf.lines()
                        .filter(|l| l.contains("ERROR") || l.contains("error"))
                        .last()
                        .unwrap_or("Download failed.")
                        .to_string()
                };
                let _ = app_clone.emit("ytdlp_error", ErrorPayload {
                    id: id_clone.clone(),
                    message: msg,
                });
            }
        }
    });

    Ok(())
}

/// Cancel an active download by killing its process.
///
/// NOTE: this uses Windows `taskkill` (kills yt-dlp and its ffmpeg children). On
/// macOS/Linux there is no `taskkill`, so cancel fails there (known gap).
#[tauri::command]
fn ytdlp_cancel(
    state: State<'_, DownloadMap>,
    id: String,
) -> Result<(), String> {
    let pid = {
        let mut map = state.lock().unwrap_or_else(|e| e.into_inner());
        map.remove(&id)
    };
    if let Some(pid) = pid {
        // Windows: force-kill the process tree (quiet_command → no console-window flash)
        security::quiet_command("taskkill")
            .args(["/F", "/T", "/PID", &pid.to_string()])
            .spawn()
            .map_err(|e| e.to_string())?;
    }
    Ok(())
}

/* ─── Process streaming helper ─────────────────────────────────────────────── */

/// Spawn a child process and stream its output to the frontend via Tauri events.
/// Emits per-line on `line_event` with payload { job_id, line, stream } and a
/// final `done_event` with payload { job_id, code }.
fn stream_child(
    app: AppHandle,
    mut child: std::process::Child,
    job_id: String,
    line_event: String,
    done_event: String,
) {
    let stdout = child.stdout.take();
    let stderr = child.stderr.take();

    std::thread::spawn(move || {
        if let Some(err) = stderr {
            let app2 = app.clone();
            let jid2 = job_id.clone();
            let evt2 = line_event.clone();
            std::thread::spawn(move || {
                for line in BufReader::new(err).lines().flatten() {
                    let _ = app2.emit(&evt2, serde_json::json!({
                        "job_id": jid2, "line": line, "stream": "stderr",
                    }));
                }
            });
        }
        if let Some(out) = stdout {
            for line in BufReader::new(out).lines().flatten() {
                let _ = app.emit(&line_event, serde_json::json!({
                    "job_id": job_id, "line": line, "stream": "stdout",
                }));
            }
        }
        let code = child.wait().ok().and_then(|s| s.code()).unwrap_or(-1);
        let _ = app.emit(&done_event, serde_json::json!({
            "job_id": job_id, "code": code,
        }));
    });
}

/* ─── Ollama commands ────────────────────────────────────────────────────────── */

#[derive(Serialize)]
struct OllamaCheckResult {
    installed: bool,
    version: String,
}

/// Full paths where Ollama installs its binary, by OS — checked when `ollama`
/// isn't on the (GUI) process PATH: a GUI app may not inherit a freshly-updated
/// PATH, and on macOS it usually has no /usr/local/bin.
fn ollama_bin_candidates() -> Vec<String> {
    let mut v: Vec<String> = Vec::new();
    #[cfg(windows)]
    {
        if let Ok(local) = std::env::var("LOCALAPPDATA") {
            v.push(format!("{}\\Programs\\Ollama\\ollama.exe", local));
            v.push(format!("{}\\Ollama\\ollama.exe", local));
        }
        for var in ["ProgramFiles", "ProgramW6432", "ProgramFiles(x86)"] {
            if let Ok(p) = std::env::var(var) {
                v.push(format!("{}\\Ollama\\ollama.exe", p));
            }
        }
    }
    #[cfg(target_os = "macos")]
    {
        v.push("/usr/local/bin/ollama".to_string());
        v.push("/opt/homebrew/bin/ollama".to_string());
        v.push("/Applications/Ollama.app/Contents/Resources/ollama".to_string());
    }
    #[cfg(all(unix, not(target_os = "macos")))]
    {
        v.push("/usr/local/bin/ollama".to_string());
        v.push("/usr/bin/ollama".to_string());
        v.push("/snap/bin/ollama".to_string());
        if let Ok(home) = std::env::var("HOME") {
            v.push(format!("{}/.local/bin/ollama", home));
        }
    }
    v
}

/// Resolve the `ollama` executable: a known install path that exists on disk
/// (robust even when the GUI process didn't inherit Ollama's bin on PATH),
/// otherwise the bare PATH name.
fn ollama_bin() -> String {
    for p in ollama_bin_candidates() {
        if std::path::Path::new(&p).exists() {
            return p;
        }
    }
    "ollama".to_string()
}

/// Check whether the ollama CLI is available (PATH or a known install location).
/// Time-boxed so a wedged call never freezes the Local AI page.
// `(async)` — output_with_timeout blocks up to 5s; keep it off the main thread.
#[tauri::command(async)]
fn ollama_check() -> OllamaCheckResult {
    let bin = ollama_bin();
    match output_with_timeout(&bin, &["--version"], 5) {
        Some(o) if o.status.success() => OllamaCheckResult {
            installed: true,
            version: String::from_utf8_lossy(&o.stdout).trim().to_string(),
        },
        _ => OllamaCheckResult { installed: false, version: String::new() },
    }
}

/// Start `ollama serve` in the background (non-blocking). The frontend polls
/// the HTTP API to detect when it's ready.
#[tauri::command]
fn ollama_serve() -> Result<(), String> {
    // Resolve the binary (PATH or known install dir) so serve works even when the
    // GUI process didn't inherit Ollama's bin on PATH. Spawning the exe directly
    // also handles install paths with spaces (e.g. Program Files) correctly.
    security::quiet_command(ollama_bin())
        .arg("serve")
        .stdout(Stdio::null()).stderr(Stdio::null()).stdin(Stdio::null())
        .spawn()
        .map(|_| ())
        .map_err(|e| format!("Failed to start ollama serve: {}", e))
}

/// Download and install the Ollama runtime from ollama.com (URLs: sources.rs).
/// Streams output via ollama-install-line / ollama-install-done events.
#[tauri::command]
fn ollama_install(app: AppHandle, job_id: String) -> Result<(), String> {
    #[cfg(windows)]
    let spawn_res = {
        let script = format!(
            "$ErrorActionPreference = 'Stop'; \
             $f = [System.IO.Path]::Combine($env:TEMP, \"OllamaSetup-$(Get-Random).exe\"); \
             Write-Host 'Downloading Ollama installer...'; \
             Invoke-WebRequest '{url}' -OutFile $f -UseBasicParsing; \
             Write-Host 'Running installer (this may take a minute)...'; \
             Start-Process -Wait -FilePath $f -ArgumentList '/S'; \
             Remove-Item $f -Force -ErrorAction SilentlyContinue; \
             Write-Host 'Ollama installed.'",
            url = sources::OLLAMA_WINDOWS_INSTALLER_URL,
        );
        security::quiet_command("powershell")
            .args(["-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", &script])
            .stdout(Stdio::piped()).stderr(Stdio::piped()).stdin(Stdio::null())
            .spawn()
    };

    // NOTE: Ollama's install.sh supports Linux only; on macOS it exits with an
    // error (users install the Ollama.app from ollama.com instead).
    #[cfg(not(windows))]
    let spawn_res = Command::new("bash")
        .args(["-c", &format!("curl -fsSL {} | sh", sources::OLLAMA_INSTALL_SCRIPT_URL)])
        .stdout(Stdio::piped()).stderr(Stdio::piped()).stdin(Stdio::null())
        .spawn();

    let child = spawn_res.map_err(|e| format!("Failed to start installer: {}", e))?;
    stream_child(app, child, job_id, "ollama-install-line".into(), "ollama-install-done".into());
    Ok(())
}

/* ─── Process helper (time-boxed subprocess) ───────────────────────────────── */

/// Run a command but give up after `secs` seconds. Prevents a hung CLI from
/// blocking the app (used by `ollama_check`). On timeout the child is left to
/// finish in the background and we return None — the caller treats that as
/// "not available".
fn output_with_timeout_env(
    program: &str, args: &[&str], envs: &[(&str, &str)], secs: u64,
) -> Option<std::process::Output> {
    let program = program.to_string();
    let owned: Vec<String> = args.iter().map(|s| s.to_string()).collect();
    let envs: Vec<(String, String)> = envs.iter().map(|(k, v)| (k.to_string(), v.to_string())).collect();
    let (tx, rx) = std::sync::mpsc::channel();
    std::thread::spawn(move || {
        let mut cmd = Command::new(&program);
        cmd.args(&owned);
        for (k, v) in &envs { cmd.env(k, v); }
        let out = cmd
            .stdout(Stdio::piped()).stderr(Stdio::piped()).stdin(Stdio::null())
            .output();
        let _ = tx.send(out);
    });
    rx.recv_timeout(std::time::Duration::from_secs(secs)).ok().and_then(|r| r.ok())
}

fn output_with_timeout(program: &str, args: &[&str], secs: u64) -> Option<std::process::Output> {
    output_with_timeout_env(program, args, &[], secs)
}

/* ─── Startup splash handoff ─────────────────────────────────────────────────── */

/// Reveal the main window and dismiss the startup splash window. The main window
/// launches hidden (visible:false) behind the tiny, instantly-loading splash
/// window (label "splashscreen", src public/splashscreen.html) so a loader shows
/// the moment the app launches — covering the whole heavy Next.js/WebView boot
/// (15–20s in dev) instead of a blank window. Idempotent + safe to call anytime;
/// driven from three places so the app can never get stuck behind the splash:
///   1. `on_page_load` — the instant the main window's document finishes loading,
///   2. the `app_ready` command — once the React app mounts (backup),
///   3. a `setup()` fallback timer — last resort if the frontend never signals.
fn show_main_dismiss_splash(app: &AppHandle) {
    if let Some(main) = app.get_webview_window("main") {
        let _ = main.show();
        let _ = main.set_focus();
    }
    if let Some(splash) = app.get_webview_window("splashscreen") {
        let _ = splash.close();
    }
}

/// Frontend signal that the main-window app has mounted — reveal it + drop the
/// splash. Backup to the Rust `on_page_load` trigger (see `show_main_dismiss_splash`).
#[tauri::command]
fn app_ready(app: AppHandle) {
    show_main_dismiss_splash(&app);
}

/* ─── System tray ────────────────────────────────────────────────────────────── */

/// Show + focus the main window — used by the tray (left-click / "Show") to bring
/// the app back after "minimize to tray" (components/render-guard.tsx).
#[cfg(desktop)]
fn reveal_main_window(app: &AppHandle) {
    if let Some(w) = app.get_webview_window("main") {
        let _ = w.show();
        let _ = w.unminimize();
        let _ = w.set_focus();
    }
}

/// Build the system-tray icon. It exists so the "Minimize to system tray" close
/// option has a way back: left-click (or the Show item) reveals the window while a
/// task keeps running in the background; Quit exits. Requires the `tray-icon`
/// feature on the tauri crate (Cargo.toml).
#[cfg(desktop)]
fn build_tray(app: &AppHandle) -> tauri::Result<()> {
    use tauri::menu::{MenuBuilder, MenuItemBuilder};
    use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};

    let show = MenuItemBuilder::with_id("show", format!("Show {}", branding::APP_NAME)).build(app)?;
    let quit = MenuItemBuilder::with_id("quit", "Quit").build(app)?;
    let menu = MenuBuilder::new(app).items(&[&show, &quit]).build()?;

    let mut builder = TrayIconBuilder::with_id("main-tray")
        .tooltip(branding::APP_NAME)
        .menu(&menu)
        .show_menu_on_left_click(false)
        .on_menu_event(|app, event| match event.id().as_ref() {
            "show" => reveal_main_window(app),
            // The native tray menu bypasses the frontend close guard, so a running
            // task is abandoned here (same as the original behaviour for tool tasks).
            "quit" => app.exit(0),
            _ => {}
        })
        .on_tray_icon_event(|tray, event| {
            if let TrayIconEvent::Click {
                button: MouseButton::Left,
                button_state: MouseButtonState::Up,
                ..
            } = event
            {
                reveal_main_window(tray.app_handle());
            }
        });

    if let Some(icon) = app.default_window_icon().cloned() {
        builder = builder.icon(icon);
    }

    builder.build(app)?;
    Ok(())
}

/// Bridge a WEBVIEW (frontend) error into the native log so it lands in BOTH the
/// main app log and the focused `errors.log`. The frontend's log sink
/// (`lib/log.ts` → `lib/error-log-forwarder.ts`) forwards its error-level entries
/// here. Logged at `error` level under the `webview` target; strings are clipped
/// so the webview can't bloat the file with an unbounded message. Logs never
/// leave the machine.
#[tauri::command]
fn log_client_error(scope: String, message: String, detail: Option<String>) {
    fn clip(s: &str, n: usize) -> String {
        s.chars().take(n).collect()
    }
    let scope = clip(&scope, 120);
    let message = clip(&message, 2000);
    match detail {
        Some(d) if !d.is_empty() => {
            log::error!(target: "webview", "[{}] {} | {}", scope, message, clip(&d, 4000))
        }
        _ => log::error!(target: "webview", "[{}] {}", scope, message),
    }
}

/// Open the app's log FOLDER in the OS file manager (Settings → General →
/// Diagnostics). Returns the resolved path so the UI can also show it.
///   Windows → %LOCALAPPDATA%\<identifier>\logs
#[tauri::command]
fn open_logs_dir(app: AppHandle) -> Result<String, String> {
    let dir = app
        .path()
        .app_log_dir()
        .map_err(|e| format!("could not resolve the log folder: {e}"))?;
    // The folder may not exist yet if nothing has logged this session; create it so
    // the open always succeeds and the tester lands somewhere real.
    let _ = std::fs::create_dir_all(&dir);
    let path = dir.to_string_lossy().to_string();
    security::open_path_native(&app, &path)?;
    Ok(path)
}

/* ─── App entry ──────────────────────────────────────────────────────────────── */

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let downloads: DownloadMap = Arc::new(Mutex::new(HashMap::new()));

    tauri::Builder::default()
        // single-instance MUST be the first plugin: a second launch focuses the
        // running window instead of starting another copy.
        .plugin(tauri_plugin_single_instance::init(|app, _argv, _cwd| {
            if let Some(w) = app.get_webview_window("main") {
                let _ = w.show();
                let _ = w.unminimize();
                let _ = w.set_focus();
            }
        }))
        // Opener: open external URLs / files / folders with the OS default handler.
        .plugin(tauri_plugin_opener::init())
        // Native dialogs (folder pickers, Save dialogs).
        .plugin(tauri_plugin_dialog::init())
        .manage(downloads)
        // Splash handoff: the main window loads hidden behind the instantly-shown
        // splash window; the moment its document finishes loading, swap them.
        .on_page_load(|webview, payload| {
            if webview.label() == "main" {
                if let tauri::webview::PageLoadEvent::Finished = payload.event() {
                    show_main_dismiss_splash(webview.app_handle());
                }
            }
        })
        .setup(|app| {
            // Diagnostics logging (debug AND release). Default targets are [Stdout,
            // LogDir] — the LogDir target writes the main app log in the OS log dir.
            // A second target writes ONLY warnings + errors to `errors.log`, the
            // focused file the Settings → Diagnostics button points users at.
            app.handle().plugin(
                tauri_plugin_log::Builder::default()
                    .level(log::LevelFilter::Info)
                    .max_file_size(5_000_000)
                    .target(
                        tauri_plugin_log::Target::new(tauri_plugin_log::TargetKind::LogDir {
                            file_name: Some("errors".into()),
                        })
                        .filter(|md| md.level() <= log::Level::Warn),
                    )
                    .build(),
            )?;
            // Self-identifying banner at the top of each session's error log.
            log::warn!(
                target: "session",
                "── {} v{} · {} {} · session start ──",
                branding::APP_NAME,
                app.package_info().version,
                std::env::consts::OS,
                std::env::consts::ARCH,
            );

            // System tray — the return path for "minimize to tray" when the user
            // closes the window while a task runs (components/render-guard.tsx).
            #[cfg(desktop)]
            {
                if let Err(e) = build_tray(app.handle()) {
                    log::warn!("failed to build system tray: {e}");
                }
            }

            // Production hardening: packaged builds strip the WebView2 default
            // right-click menu (Back / Refresh / Save as / Print / Inspect…) and force
            // devtools off. Debug builds keep both. Opt-in escape hatch for diagnosing
            // packaged-build-only issues: launch with DOTMATE_DEVTOOLS=1.
            #[cfg(all(windows, not(debug_assertions)))]
            {
                let debug_ui = std::env::var(branding::DEVTOOLS_ENV).map(|v| v == "1").unwrap_or(false);
                for window in app.webview_windows().values() {
                    let _ = window.with_webview(move |webview| unsafe {
                        if let Ok(core) = webview.controller().CoreWebView2() {
                            if let Ok(settings) = core.Settings() {
                                let _ = settings.SetAreDefaultContextMenusEnabled(debug_ui.into());
                                let _ = settings.SetAreDevToolsEnabled(debug_ui.into());
                            }
                        }
                    });
                }
            }

            // macOS: install the standard app menu so Cmd+Q / Cmd+W / Cmd+C/V/X/A
            // behave like a normal Mac app. Windows keeps its custom in-window chrome.
            #[cfg(target_os = "macos")]
            {
                let menu = tauri::menu::Menu::default(app.handle())?;
                app.set_menu(menu)?;
            }

            // Downloaded tools (ffmpeg, yt-dlp) live in the app-data bin dir. Prepend it
            // to PATH so `Command::new("ffmpeg"|"yt-dlp")` resolves them, and point the
            // whisper crate + ffmpeg tools at ffmpeg via FFMPEG_PATH. Do ALL env
            // mutations HERE, BEFORE any thread is spawned below — `set_var` is a
            // process-global write that data-races with a concurrent env read.
            if let Ok(bin) = deps_command::bin_dir(app.handle()) {
                let sep = if cfg!(windows) { ";" } else { ":" };
                let prev = std::env::var("PATH").unwrap_or_default();
                std::env::set_var("PATH", format!("{}{}{}", bin.display(), sep, prev));
                let ff = bin.join(if cfg!(windows) { "ffmpeg.exe" } else { "ffmpeg" });
                if ff.exists() {
                    std::env::set_var(deps_command::FFMPEG_ENV, &ff);
                }
            }

            // Startup hygiene: sweep stale temp scratch (>24h) left by a crashed or
            // force-quit run. Best-effort, off the UI path.
            std::thread::spawn(staging::sweep_temp);

            // Splash safety net: if the frontend never signals ready, force the main
            // window visible + drop the splash after a generous timeout.
            {
                let h = app.handle().clone();
                std::thread::spawn(move || {
                    std::thread::sleep(std::time::Duration::from_secs(30));
                    if h.get_webview_window("splashscreen").is_some() {
                        show_main_dismiss_splash(&h);
                    }
                });
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            app_ready,
            log_client_error,
            open_logs_dir,
            ytdlp_check,
            ytdlp_fetch_info,
            ytdlp_start,
            ytdlp_cancel,
            ollama_check,
            ollama_serve,
            ollama_install,
            tts_command::tts_model_status,
            tts_command::tts_download_model,
            tts_command::tts_synthesize,
            cli_brain_command::cli_brain_detect,
            cli_brain_command::cli_brain_run,
            staging::export_save_clip,
            staging::stage_append,
            staging::stage_discard,
            staging::stage_promote,
            tools_command::ffmpeg_merge_videos,
            tools_command::ffmpeg_merge_audio,
            whisper_command::whisper_model_status,
            whisper_command::whisper_download_model,
            whisper_command::transcribe_local,
            deps_command::ffmpeg_status,
            deps_command::ffmpeg_download,
            deps_command::ytdlp_status,
            deps_command::ytdlp_download,
            fs_command::open_file,
            fs_command::reveal_in_folder,
            fs_command::copy_files,
            fs_command::save_bytes,
            fs_command::read_file_bytes,
            fs_command::delete_file,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

#[cfg(test)]
mod tests {
    use super::sanitize_ytdlp_extra_args;

    #[test]
    fn ytdlp_extra_args_allow_known_flags() {
        let ok = sanitize_ytdlp_extra_args(vec![
            "--playlist-items".into(),
            "1-10".into(),
            "--download-sections".into(),
            "*00:01:00-00:02:00".into(),
            "--force-keyframes-at-cuts".into(),
        ])
        .unwrap();
        assert_eq!(ok.len(), 5);
    }

    #[test]
    fn ytdlp_extra_args_reject_injection() {
        // Unknown flag → rejected (this is the --exec/--paths command-exec class).
        assert!(sanitize_ytdlp_extra_args(vec!["--exec".into(), "calc".into()]).is_err());
        assert!(sanitize_ytdlp_extra_args(vec!["--paths".into(), "C:/x".into()]).is_err());
        // Missing value → rejected.
        assert!(sanitize_ytdlp_extra_args(vec!["--playlist-items".into()]).is_err());
        // A value that starts with `-` (would be read as a flag) → rejected.
        assert!(sanitize_ytdlp_extra_args(vec!["--playlist-items".into(), "-5".into()]).is_err());
        // Junk characters in a value → rejected.
        assert!(sanitize_ytdlp_extra_args(vec![
            "--download-sections".into(),
            "*00:01;calc".into(),
        ])
        .is_err());
    }
}
