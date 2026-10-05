//! Tauri bridge for **CLI brains** — agentic coding CLIs the user already has
//! installed (Claude Code, Codex, Gemini) used as a local LLM by Script Writer and
//! Script → Image Prompts.
//!
//! Why a Tauri command and not `fetch`: these are local *processes*, not HTTP
//! servers (unlike Ollama). The webview can't spawn one, so the whole lifecycle
//! lives here (spawn a CLI per invocation, hard timeout, drain pipes in threads so
//! a chatty child can't deadlock on a full pipe).
//!
//! It runs on the user's machine against their own CLI sign-in.
//!
//! ## Security model (read before extending)
//! We spawn a *known* binary with a *known* flag set and pass the prompt over
//! **stdin**, never through a shell. Consequences:
//!   - No `sh -c` / `cmd /c` anywhere → prompt text can never be interpreted as
//!     shell syntax, so a prompt containing `; rm -rf /` is inert.
//!   - The binary is resolved from a fixed allow-list of names (or an explicit
//!     user-chosen absolute path from Settings) — never from prompt content.
//!   - Every CLI is invoked in its **read-only / planning** mode where it has
//!     one (`--permission-mode plan`, `--approval-mode plan`, sandbox
//!     `read-only`) so a brain answering "write me a script" cannot edit the
//!     user's disk.
//!   - `cwd` is pinned to a scratch dir under app-data, so even a tool call that
//!     escapes the read-only mode has nothing of the user's to touch.
//! Keep all four properties when adding a provider.

use std::collections::HashMap;
use std::io::{Read, Write};
use std::path::PathBuf;
use std::process::{Command, Stdio};
use std::time::Duration;

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager};

#[cfg(windows)]
use std::os::windows::process::CommandExt;
#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x0800_0000;

/// How long a single brain call may run before we kill it. Agentic CLIs think for
/// a while (and may retry), so this is generous — the UI shows a cancel affordance.
const DEFAULT_TIMEOUT_SECS: u64 = 300;

/// The CLI brains we know how to drive. Adding one = a new entry here + a match
/// arm in `build_args`. The `id` is the stable value persisted in settings and
/// used as the `cli:<id>` engine id on the TS side.
const KNOWN: &[(&str, &[&str])] = &[
    // (id, candidate binary names in PATH-probe order)
    ("claude-code", &["claude"]),
    ("codex", &["codex"]),
    ("gemini", &["gemini"]),
];

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct CliBrainStatus {
    pub id: String,
    /// True when the binary resolved AND answered `--version`.
    pub found: bool,
    /// Absolute path we resolved (or the user's override), when found.
    pub path: Option<String>,
    /// First line of `--version`, for display.
    pub version: Option<String>,
    /// Why detection failed, for the settings UI.
    pub error: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CliBrainRunArgs {
    /// One of `KNOWN`'s ids.
    pub id: String,
    /// Absolute path override from Settings (skips PATH resolution).
    pub path: Option<String>,
    /// Provider-native model id (e.g. "sonnet" for claude). Optional.
    pub model: Option<String>,
    /// System / role instructions. Folded into the prompt for CLIs with no
    /// system-prompt flag.
    pub system: Option<String>,
    /// The user prompt.
    pub prompt: String,
    /// Absolute paths of images to attach (vision). Codex takes them natively via
    /// `-i`; the others are handed the paths in-prompt and read them with their
    /// own file tools.
    pub images: Option<Vec<String>>,
    pub timeout_secs: Option<u64>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CliBrainRunResult {
    pub text: String,
    /// Non-fatal stderr, surfaced for diagnostics when `text` looks wrong.
    pub stderr: String,
}

/// Resolve a brain's binary: an explicit user override wins, else the first
/// candidate name that `--version`s successfully via PATH.
///
/// SECURITY: `override_path` is the only caller-supplied value that can name a
/// binary, and it comes from a Settings file picker — never from prompt text or
/// model output.
fn resolve_bin(id: &str, override_path: Option<&str>) -> Result<String, String> {
    if let Some(p) = override_path {
        let p = p.trim();
        if !p.is_empty() {
            return if PathBuf::from(p).is_file() {
                Ok(p.to_string())
            } else {
                Err(format!("Custom path is not a file: {p}"))
            };
        }
    }
    let candidates = KNOWN
        .iter()
        .find(|(k, _)| *k == id)
        .map(|(_, c)| *c)
        .ok_or_else(|| format!("Unknown CLI brain \"{id}\""))?;

    for name in candidates {
        if probe_version(name).is_some() {
            return Ok((*name).to_string());
        }
    }
    Err(format!(
        "`{}` not found on PATH. Install it, or set the binary path in Settings → Local AI → Brain.",
        candidates.first().copied().unwrap_or(id)
    ))
}

/// `<bin> --version`, with a short timeout. `None` when it isn't runnable.
fn probe_version(bin: &str) -> Option<String> {
    let mut cmd = Command::new(bin);
    cmd.arg("--version");
    #[cfg(windows)]
    cmd.creation_flags(CREATE_NO_WINDOW);
    let out = run_with_timeout(cmd, Duration::from_secs(20), None).ok()?;
    if !out.status_ok {
        return None;
    }
    let s = out.stdout.trim();
    s.lines().next().map(|l| l.trim().to_string())
}

struct RunOut {
    status_ok: bool,
    stdout: String,
    stderr: String,
}

/// Spawn `cmd`, optionally write `stdin_data`, drain both pipes on threads, and
/// hard-kill the child if it outlives `timeout`. Draining on threads matters:
/// an agentic CLI is chatty, and a full pipe would deadlock a child we're
/// waiting on.
fn run_with_timeout(
    mut cmd: Command,
    timeout: Duration,
    stdin_data: Option<String>,
) -> Result<RunOut, String> {
    cmd.stdout(Stdio::piped()).stderr(Stdio::piped());
    cmd.stdin(if stdin_data.is_some() {
        Stdio::piped()
    } else {
        Stdio::null()
    });

    let mut child = cmd.spawn().map_err(|e| format!("failed to launch: {e}"))?;

    if let Some(data) = stdin_data {
        if let Some(mut si) = child.stdin.take() {
            // A broken pipe here just means the child already decided it had
            // enough input — not an error worth failing the whole run for.
            let _ = si.write_all(data.as_bytes());
            let _ = si.flush();
        }
    }

    let mut out = child.stdout.take();
    let mut err = child.stderr.take();
    let out_h = std::thread::spawn(move || {
        let mut b = Vec::new();
        if let Some(s) = out.as_mut() {
            let _ = s.read_to_end(&mut b);
        }
        b
    });
    let err_h = std::thread::spawn(move || {
        let mut b = Vec::new();
        if let Some(s) = err.as_mut() {
            let _ = s.read_to_end(&mut b);
        }
        b
    });

    let deadline = std::time::Instant::now() + timeout;
    let status = loop {
        match child.try_wait() {
            Ok(Some(st)) => break st,
            Ok(None) => {
                if std::time::Instant::now() >= deadline {
                    let _ = child.kill();
                    let _ = child.wait();
                    return Err(format!(
                        "The AI CLI did not finish within {}s and was stopped.",
                        timeout.as_secs()
                    ));
                }
                std::thread::sleep(Duration::from_millis(60));
            }
            Err(e) => return Err(format!("process error: {e}")),
        }
    };

    let stdout = String::from_utf8_lossy(&out_h.join().unwrap_or_default()).to_string();
    let stderr = String::from_utf8_lossy(&err_h.join().unwrap_or_default()).to_string();
    Ok(RunOut {
        status_ok: status.success(),
        stdout,
        stderr,
    })
}

/// Per-provider argv. Prompt goes over **stdin** for every provider that accepts
/// it, so it is never an argv element (no length limits, no quoting hazards).
///
/// Read-only posture per provider:
///   claude  → `--permission-mode plan`
///   gemini  → `--approval-mode plan`
///   codex   → `--sandbox read-only`
fn build_args(id: &str, a: &CliBrainRunArgs, prompt_is_stdin: bool) -> Result<Vec<String>, String> {
    let mut v: Vec<String> = Vec::new();
    match id {
        "claude-code" => {
            v.push("-p".into());
            v.push("--output-format".into());
            v.push("text".into());
            v.push("--permission-mode".into());
            v.push("plan".into());
            if let Some(s) = a.system.as_deref().filter(|s| !s.trim().is_empty()) {
                v.push("--append-system-prompt".into());
                v.push(s.to_string());
            }
            if let Some(m) = a.model.as_deref().filter(|m| !m.trim().is_empty()) {
                v.push("--model".into());
                v.push(m.to_string());
            }
            if !prompt_is_stdin {
                v.push(a.prompt.clone());
            }
        }
        "gemini" => {
            v.push("--output-format".into());
            v.push("text".into());
            v.push("--approval-mode".into());
            v.push("plan".into());
            if let Some(m) = a.model.as_deref().filter(|m| !m.trim().is_empty()) {
                v.push("--model".into());
                v.push(m.to_string());
            }
            // `-p` runs headless; it is APPENDED to stdin, so an empty `-p ""`
            // plus a stdin body still runs non-interactively.
            v.push("-p".into());
            v.push(if prompt_is_stdin {
                String::new()
            } else {
                a.prompt.clone()
            });
        }
        "codex" => {
            v.push("exec".into());
            v.push("--sandbox".into());
            v.push("read-only".into());
            if let Some(m) = a.model.as_deref().filter(|m| !m.trim().is_empty()) {
                v.push("-m".into());
                v.push(m.to_string());
            }
            // Codex is the only one with native image attachment.
            for img in a.images.iter().flatten() {
                v.push("-i".into());
                v.push(img.clone());
            }
            if prompt_is_stdin {
                // `-` makes codex read the prompt from stdin.
                v.push("-".into());
            } else {
                v.push(a.prompt.clone());
            }
        }
        other => return Err(format!("Unknown CLI brain \"{other}\"")),
    }
    Ok(v)
}

/// A scratch cwd under app-data. Pinning cwd here means a tool call that somehow
/// escapes read-only mode still has none of the user's files in reach.
fn scratch_dir(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("no app data dir: {e}"))?
        .join("brain-scratch");
    std::fs::create_dir_all(&dir).map_err(|e| format!("cannot create scratch dir: {e}"))?;
    Ok(dir)
}

/// Compose the final prompt. For providers without native image attachment we
/// name the files inline and ask the CLI to read them with its own file tool.
fn compose_prompt(id: &str, a: &CliBrainRunArgs) -> String {
    let mut p = String::new();
    // Claude takes the system prompt via a flag; the others get it inline.
    if id != "claude-code" {
        if let Some(s) = a.system.as_deref().filter(|s| !s.trim().is_empty()) {
            p.push_str(s);
            p.push_str("\n\n---\n\n");
        }
    }
    let imgs: Vec<&String> = a.images.iter().flatten().collect();
    if !imgs.is_empty() && id != "codex" {
        p.push_str("Read these local image files and use them as visual context:\n");
        for i in &imgs {
            p.push_str("- ");
            p.push_str(i);
            p.push('\n');
        }
        p.push('\n');
    }
    p.push_str(&a.prompt);
    p
}

/// `(async)` — detection spawns up to three child processes; never block the
/// webview main thread on it.
#[tauri::command]
pub async fn cli_brain_detect(
    paths: Option<HashMap<String, String>>,
) -> Result<Vec<CliBrainStatus>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        KNOWN
            .iter()
            .map(|(id, _)| {
                let over = paths.as_ref().and_then(|m| m.get(*id)).map(|s| s.as_str());
                match resolve_bin(id, over) {
                    Ok(bin) => {
                        let version = probe_version(&bin);
                        CliBrainStatus {
                            id: (*id).to_string(),
                            found: version.is_some(),
                            path: Some(bin),
                            error: if version.is_none() {
                                Some("Found the binary but `--version` failed.".into())
                            } else {
                                None
                            },
                            version,
                        }
                    }
                    Err(e) => CliBrainStatus {
                        id: (*id).to_string(),
                        found: false,
                        path: None,
                        version: None,
                        error: Some(e),
                    },
                }
            })
            .collect()
    })
    .await
    .map_err(|e| format!("detect task failed: {e}"))
}

/// `(async)` — one brain call. Blocking work runs off the main thread; the child
/// is hard-killed on timeout so a hung CLI can't tie up a Tauri worker forever.
#[tauri::command]
pub async fn cli_brain_run(
    app: AppHandle,
    args: CliBrainRunArgs,
) -> Result<CliBrainRunResult, String> {
    let cwd = scratch_dir(&app)?;
    tauri::async_runtime::spawn_blocking(move || {
        let bin = resolve_bin(&args.id, args.path.as_deref())?;
        let prompt = compose_prompt(&args.id, &args);
        // Every supported CLI reads the prompt from stdin, which keeps arbitrary
        // prompt text out of argv entirely.
        let argv = build_args(&args.id, &args, true)?;

        let mut cmd = Command::new(&bin);
        cmd.args(&argv).current_dir(&cwd);
        // Keep the child from inheriting a pager/editor that would make it block.
        cmd.env("PAGER", "cat").env("GIT_PAGER", "cat");
        #[cfg(windows)]
        cmd.creation_flags(CREATE_NO_WINDOW);

        let timeout = Duration::from_secs(args.timeout_secs.unwrap_or(DEFAULT_TIMEOUT_SECS));
        let out = run_with_timeout(cmd, timeout, Some(prompt))?;

        if !out.status_ok && out.stdout.trim().is_empty() {
            let detail = out.stderr.trim();
            return Err(if detail.is_empty() {
                format!("{bin} exited without output.")
            } else {
                // Trim so a stack-trace-sized stderr doesn't become the toast.
                let d: String = detail.chars().take(400).collect();
                format!("{bin} failed: {d}")
            });
        }
        Ok(CliBrainRunResult {
            text: out.stdout.trim().to_string(),
            stderr: out.stderr.trim().chars().take(2000).collect(),
        })
    })
    .await
    .map_err(|e| format!("brain task failed: {e}"))?
}

#[cfg(test)]
mod tests {
    use super::*;

    fn args(id: &str) -> CliBrainRunArgs {
        CliBrainRunArgs {
            id: id.into(),
            path: None,
            model: None,
            system: Some("SYS".into()),
            prompt: "hello".into(),
            images: None,
            timeout_secs: None,
        }
    }

    #[test]
    fn claude_uses_readonly_mode_and_system_flag() {
        let v = build_args("claude-code", &args("claude-code"), true).unwrap();
        assert!(v.contains(&"-p".to_string()));
        // Read-only posture is not optional — a brain must never edit the disk.
        let i = v.iter().position(|x| x == "--permission-mode").unwrap();
        assert_eq!(v[i + 1], "plan");
        let s = v.iter().position(|x| x == "--append-system-prompt").unwrap();
        assert_eq!(v[s + 1], "SYS");
        // Prompt rides on stdin, never argv.
        assert!(!v.contains(&"hello".to_string()));
    }

    #[test]
    fn gemini_and_codex_are_sandboxed() {
        let g = build_args("gemini", &args("gemini"), true).unwrap();
        let i = g.iter().position(|x| x == "--approval-mode").unwrap();
        assert_eq!(g[i + 1], "plan");

        let c = build_args("codex", &args("codex"), true).unwrap();
        assert_eq!(c[0], "exec");
        let j = c.iter().position(|x| x == "--sandbox").unwrap();
        assert_eq!(c[j + 1], "read-only");
        assert_eq!(c.last().unwrap(), "-"); // stdin marker
    }

    #[test]
    fn codex_attaches_images_natively_others_inline() {
        let mut a = args("codex");
        a.images = Some(vec!["C:/tmp/a.png".into()]);
        let c = build_args("codex", &a, true).unwrap();
        let i = c.iter().position(|x| x == "-i").unwrap();
        assert_eq!(c[i + 1], "C:/tmp/a.png");
        // codex gets images via argv, so they must NOT be duplicated in the prompt
        assert!(!compose_prompt("codex", &a).contains("C:/tmp/a.png"));

        let mut b = args("claude-code");
        b.images = Some(vec!["C:/tmp/b.png".into()]);
        assert!(compose_prompt("claude-code", &b).contains("C:/tmp/b.png"));
    }

    #[test]
    fn system_prompt_is_inlined_only_where_there_is_no_flag() {
        // claude has --append-system-prompt, so the prompt body stays clean
        assert!(!compose_prompt("claude-code", &args("claude-code")).contains("SYS"));
        assert!(compose_prompt("gemini", &args("gemini")).contains("SYS"));
        assert!(compose_prompt("codex", &args("codex")).contains("SYS"));
    }

    #[test]
    fn unknown_provider_is_rejected() {
        assert!(build_args("bogus", &args("bogus"), true).is_err());
        assert!(resolve_bin("bogus", None).is_err());
    }

    #[test]
    fn explicit_path_must_exist() {
        assert!(resolve_bin("claude-code", Some("/no/such/binary-xyz")).is_err());
    }
}
