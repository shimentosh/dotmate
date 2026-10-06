//! Tauri bridge for **API brains** — the user's OWN cloud AI provider (Anthropic,
//! OpenAI, Gemini, OpenRouter or any OpenAI-compatible endpoint), reached with an
//! API key they paste into Settings → API Keys. Opt-in: nothing here runs until a
//! key has been saved, and every other brain stays local.
//!
//! Why native and not `fetch`: the webview's CSP only allows `connect-src` to
//! localhost, and we want to keep it that way. Calls go out from here instead.
//!
//! ## Security model (read before extending)
//!   - **Keys are write-only from the UI.** `api_brain_save` takes a key;
//!     nothing ever returns one — `api_brain_list` reports only "configured" and the
//!     last 4 characters. Requests are built here, so the key never re-enters JS.
//!   - **Stored under `<app-data>/secrets/`**, which `security::confine_app_file`
//!     and `copy_files` refuse, so the generic file commands can't read, delete or
//!     copy it back out over IPC. File mode 0600 on Unix.
//!   - **Provider endpoints are fixed** per provider; only the "custom" provider
//!     takes a user-entered base URL (Settings only — never prompt/model output),
//!     and it must be `https://` or a loopback `http://` URL.
//!   - Errors are built from the HTTP status + the provider's error message; the
//!     key is never formatted into an error or a log line.

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Mutex;
use std::time::Duration;

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tauri::AppHandle;

use crate::security;

/// Generous: long scripts on a slow model can take minutes. The UI can Stop
/// (it discards a late answer), like CLI brains.
const DEFAULT_TIMEOUT_SECS: u64 = 300;
/// Output cap for one non-streaming call — room for a long script section.
const MAX_OUTPUT_TOKENS: u64 = 16000;
const STORE_FILE: &str = "api-brains.json";

#[derive(Clone, Copy, PartialEq)]
enum Wire {
    Anthropic,
    OpenAi,
    Gemini,
}

struct ProviderDef {
    id: &'static str,
    wire: Wire,
    /// Fixed base URL; `None` = user-supplied (custom).
    base: Option<&'static str>,
    default_model: &'static str,
}

/// The registry. Adding a provider = one entry here + (if it has a new wire
/// format) a match arm in `call_provider`. Mirrors `API_BRAINS` in lib/brain/api-brain.ts.
const PROVIDERS: &[ProviderDef] = &[
    ProviderDef { id: "anthropic",  wire: Wire::Anthropic, base: Some("https://api.anthropic.com/v1"), default_model: "claude-opus-5-5" },
    ProviderDef { id: "openai",     wire: Wire::OpenAi,    base: Some("https://api.openai.com/v1"),    default_model: "gpt-4.1-mini" },
    ProviderDef { id: "gemini",     wire: Wire::Gemini,    base: Some("https://generativelanguage.googleapis.com/v1beta"), default_model: "gemini-2.5-flash" },
    ProviderDef { id: "openrouter", wire: Wire::OpenAi,    base: Some("https://openrouter.ai/api/v1"), default_model: "openrouter/auto" },
    ProviderDef { id: "custom",     wire: Wire::OpenAi,    base: None,                                  default_model: "" },
];

/// Anthropic models that accept the server-side refusal fallback
/// (`fallbacks: "default"`); a false-positive safety decline then retries on a
/// fallback model instead of failing the user's script.
const ANTHROPIC_FALLBACK_MODELS: &[&str] = &["claude-fable-5-1", "claude-opus-5-5", "claude-opus-5", "claude-sonnet-5-5"];

fn provider(id: &str) -> Result<&'static ProviderDef, String> {
    PROVIDERS.iter().find(|p| p.id == id).ok_or_else(|| format!("Unknown provider \"{id}\""))
}

// ── Storage ─────────────────────────────────────────────────────────────────

#[derive(Serialize, Deserialize, Default, Clone)]
#[serde(rename_all = "camelCase")]
struct ProviderCfg {
    key: String,
    #[serde(default)]
    model: String,
    #[serde(default)]
    base_url: Option<String>,
}

#[derive(Serialize, Deserialize, Default)]
struct Store {
    #[serde(default)]
    providers: HashMap<String, ProviderCfg>,
}

/// Serialises read-modify-write of the store file.
static STORE_LOCK: Mutex<()> = Mutex::new(());

fn store_path(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(security::secrets_dir(app)?.join(STORE_FILE))
}

fn load_store(app: &AppHandle) -> Store {
    let Ok(path) = store_path(app) else { return Store::default() };
    std::fs::read_to_string(path)
        .ok()
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_default()
}

fn save_store(app: &AppHandle, store: &Store) -> Result<(), String> {
    let path = store_path(app)?;
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir).map_err(|e| format!("Could not create the key folder: {e}"))?;
    }
    let body = serde_json::to_string_pretty(store).map_err(|e| e.to_string())?;
    // Write-then-rename so a crash mid-write can't leave a truncated store.
    let tmp = path.with_extension("json.tmp");
    std::fs::write(&tmp, body).map_err(|e| format!("Could not save the key: {e}"))?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = std::fs::set_permissions(&tmp, std::fs::Permissions::from_mode(0o600));
    }
    std::fs::rename(&tmp, &path).map_err(|e| format!("Could not save the key: {e}"))
}

// ── Validation ──────────────────────────────────────────────────────────────

/// Custom endpoints: https anywhere, or plain http only to this machine (LM Studio,
/// llama.cpp server, …). Trailing slashes trimmed.
fn validate_base_url(raw: &str) -> Result<String, String> {
    let u = raw.trim().trim_end_matches('/').to_string();
    let lower = u.to_ascii_lowercase();
    let loopback = ["http://localhost", "http://127.0.0.1", "http://[::1]"]
        .iter()
        .any(|p| lower == *p || lower.starts_with(&format!("{p}:")) || lower.starts_with(&format!("{p}/")));
    if lower.starts_with("https://") || loopback {
        if u.chars().any(|c| c.is_whitespace() || c.is_control()) {
            return Err("The base URL contains spaces.".into());
        }
        Ok(u)
    } else {
        Err("Use an https:// URL (plain http is only allowed for localhost).".into())
    }
}

/// Model ids go into a JSON body (and, for Gemini, the URL path) — keep them to
/// the characters real model ids use.
fn validate_model(model: &str, wire: Wire) -> Result<(), String> {
    if model.is_empty() {
        return Err("Enter a model name.".into());
    }
    let ok = model.chars().all(|c| c.is_ascii_alphanumeric() || "-._:/@".contains(c))
        && !(wire == Wire::Gemini && model.contains('/'));
    if ok { Ok(()) } else { Err(format!("\"{model}\" doesn't look like a model id.")) }
}

fn key_hint(key: &str) -> String {
    let tail: String = key.chars().rev().take(4).collect::<Vec<_>>().into_iter().rev().collect();
    format!("…{tail}")
}

// ── HTTP ────────────────────────────────────────────────────────────────────

fn post_json(url: &str, headers: &[(&str, &str)], body: &Value, timeout: Duration) -> Result<Value, String> {
    let agent = ureq::AgentBuilder::new().timeout(timeout).build();
    let mut req = agent.post(url).set("content-type", "application/json");
    for (k, v) in headers {
        req = req.set(k, v);
    }
    match req.send_string(&body.to_string()) {
        Ok(resp) => {
            let text = resp.into_string().map_err(|e| format!("Couldn't read the response: {e}"))?;
            serde_json::from_str(&text).map_err(|_| "The provider sent a response that isn't JSON.".to_string())
        }
        Err(ureq::Error::Status(code, resp)) => {
            let text = resp.into_string().unwrap_or_default();
            Err(describe_http_error(code, &text))
        }
        Err(e) => Err(format!("Couldn't reach the provider — check your internet connection. ({e})")),
    }
}

/// Human message for a non-2xx: the provider's own `error.message` when it sent
/// one (all three wire formats nest it there), plus a hint for the common codes.
fn describe_http_error(code: u16, body: &str) -> String {
    let detail = serde_json::from_str::<Value>(body)
        .ok()
        .and_then(|v| v.pointer("/error/message").and_then(Value::as_str).map(str::to_string))
        .unwrap_or_default();
    let hint = match code {
        401 | 403 => "The API key was rejected — check it in Settings → API Keys.",
        404 => "Model or endpoint not found — check the model name.",
        429 => "Rate limit or quota reached on your account — wait a bit or check billing.",
        500..=599 => "The provider had a server error — try again in a moment.",
        _ => "The provider returned an error.",
    };
    let detail: String = detail.chars().take(300).collect();
    if detail.is_empty() { format!("{hint} (HTTP {code})") } else { format!("{hint} (HTTP {code}: {detail})") }
}

fn call_provider(def: &ProviderDef, cfg: &ProviderCfg, system: Option<&str>, prompt: &str, timeout: Duration) -> Result<String, String> {
    let model = if cfg.model.trim().is_empty() { def.default_model } else { cfg.model.trim() };
    validate_model(model, def.wire)?;
    let base = match def.base {
        Some(b) => b.to_string(),
        None => validate_base_url(cfg.base_url.as_deref().unwrap_or(""))?,
    };
    let key = cfg.key.as_str();
    let system = system.map(str::trim).filter(|s| !s.is_empty());

    match def.wire {
        Wire::Anthropic => {
            let mut body = json!({
                "model": model,
                "max_tokens": MAX_OUTPUT_TOKENS,
                "messages": [{ "role": "user", "content": prompt }],
            });
            if let Some(s) = system { body["system"] = json!(s); }
            let mut headers = vec![("x-api-key", key), ("anthropic-version", "2023-06-01")];
            if ANTHROPIC_FALLBACK_MODELS.contains(&model) {
                body["fallbacks"] = json!("default");
                headers.push(("anthropic-beta", "server-side-fallback-2026-07-01"));
            }
            let v = post_json(&format!("{base}/messages"), &headers, &body, timeout)?;
            if v.get("stop_reason").and_then(Value::as_str) == Some("refusal") {
                return Err("The model declined this request. Try rewording the topic.".into());
            }
            let text: String = v.get("content").and_then(Value::as_array).map(|blocks| {
                blocks.iter()
                    .filter(|b| b.get("type").and_then(Value::as_str) == Some("text"))
                    .filter_map(|b| b.get("text").and_then(Value::as_str))
                    .collect::<Vec<_>>()
                    .join("")
            }).unwrap_or_default();
            non_empty(text)
        }
        Wire::OpenAi => {
            let mut messages = Vec::new();
            if let Some(s) = system { messages.push(json!({ "role": "system", "content": s })); }
            messages.push(json!({ "role": "user", "content": prompt }));
            let body = json!({ "model": model, "messages": messages });
            let auth = format!("Bearer {key}");
            let mut headers = vec![("authorization", auth.as_str())];
            if def.id == "openrouter" {
                // OpenRouter's optional app attribution.
                headers.push(("x-title", crate::branding::APP_NAME));
            }
            let v = post_json(&format!("{base}/chat/completions"), &headers, &body, timeout)?;
            let text = v.pointer("/choices/0/message/content").and_then(Value::as_str).unwrap_or_default().to_string();
            non_empty(text)
        }
        Wire::Gemini => {
            let mut body = json!({ "contents": [{ "role": "user", "parts": [{ "text": prompt }] }] });
            if let Some(s) = system { body["systemInstruction"] = json!({ "parts": [{ "text": s }] }); }
            let url = format!("{base}/models/{model}:generateContent");
            let v = post_json(&url, &[("x-goog-api-key", key)], &body, timeout)?;
            if v.pointer("/promptFeedback/blockReason").is_some() {
                return Err("Gemini blocked this request. Try rewording the topic.".into());
            }
            let text: String = v.pointer("/candidates/0/content/parts").and_then(Value::as_array).map(|parts| {
                parts.iter().filter_map(|p| p.get("text").and_then(Value::as_str)).collect::<Vec<_>>().join("")
            }).unwrap_or_default();
            non_empty(text)
        }
    }
}

fn non_empty(text: String) -> Result<String, String> {
    if text.trim().is_empty() { Err("The model returned an empty answer — try again.".into()) } else { Ok(text) }
}

// ── Commands ────────────────────────────────────────────────────────────────

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ApiBrainStatus {
    pub id: String,
    pub configured: bool,
    /// Last 4 characters of the key ("…a1b2") — never the key itself.
    pub key_hint: Option<String>,
    /// The saved model, or the provider default.
    pub model: String,
    pub default_model: String,
    pub base_url: Option<String>,
}

fn status_of(def: &ProviderDef, cfg: Option<&ProviderCfg>) -> ApiBrainStatus {
    let configured = cfg.map(|c| !c.key.is_empty()).unwrap_or(false);
    let model = cfg.map(|c| c.model.trim().to_string()).filter(|m| !m.is_empty())
        .unwrap_or_else(|| def.default_model.to_string());
    ApiBrainStatus {
        id: def.id.to_string(),
        configured,
        key_hint: cfg.filter(|_| configured).map(|c| key_hint(&c.key)),
        model,
        default_model: def.default_model.to_string(),
        base_url: cfg.and_then(|c| c.base_url.clone()),
    }
}

/// Every provider, with whether a key is saved. Safe to call often.
#[tauri::command]
pub fn api_brain_list(app: AppHandle) -> Vec<ApiBrainStatus> {
    let store = load_store(&app);
    PROVIDERS.iter().map(|d| status_of(d, store.providers.get(d.id))).collect()
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ApiBrainSaveArgs {
    pub id: String,
    /// New key; `None`/empty keeps the saved one (so editing the model doesn't
    /// require re-pasting the key).
    pub key: Option<String>,
    pub model: Option<String>,
    pub base_url: Option<String>,
}

#[tauri::command]
pub fn api_brain_save(app: AppHandle, args: ApiBrainSaveArgs) -> Result<ApiBrainStatus, String> {
    let def = provider(&args.id)?;
    let _guard = STORE_LOCK.lock().map_err(|_| "Key store is busy — try again.".to_string())?;
    let mut store = load_store(&app);
    let mut cfg = store.providers.get(def.id).cloned().unwrap_or_default();

    if let Some(k) = args.key.as_deref().map(str::trim).filter(|k| !k.is_empty()) {
        if k.chars().any(|c| c.is_whitespace() || c.is_control()) || k.len() > 512 {
            return Err("That doesn't look like an API key.".into());
        }
        cfg.key = k.to_string();
    }
    if cfg.key.is_empty() {
        return Err("Paste an API key first.".into());
    }
    if let Some(m) = args.model.as_deref() {
        let m = m.trim();
        if !m.is_empty() { validate_model(m, def.wire)?; }
        cfg.model = m.to_string();
    }
    if def.base.is_none() {
        cfg.base_url = Some(validate_base_url(args.base_url.as_deref().unwrap_or(""))?);
        if cfg.model.trim().is_empty() {
            return Err("Enter the model name your endpoint serves.".into());
        }
    }
    store.providers.insert(def.id.to_string(), cfg);
    save_store(&app, &store)?;
    Ok(status_of(def, store.providers.get(def.id)))
}

#[tauri::command]
pub fn api_brain_remove(app: AppHandle, id: String) -> Result<(), String> {
    let def = provider(&id)?;
    let _guard = STORE_LOCK.lock().map_err(|_| "Key store is busy — try again.".to_string())?;
    let mut store = load_store(&app);
    if store.providers.remove(def.id).is_some() {
        save_store(&app, &store)?;
    }
    Ok(())
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ApiBrainRunArgs {
    pub id: String,
    pub system: Option<String>,
    pub prompt: String,
    pub timeout_secs: Option<u64>,
}

/// One turn on the user's API brain. Non-streaming: like a CLI brain, the whole
/// answer arrives at once.
#[tauri::command]
pub async fn api_brain_run(app: AppHandle, args: ApiBrainRunArgs) -> Result<String, String> {
    let def = provider(&args.id)?;
    let cfg = load_store(&app).providers.get(def.id).cloned()
        .filter(|c| !c.key.is_empty())
        .ok_or("No API key saved for this provider — add one in Settings → API Keys.")?;
    let timeout = Duration::from_secs(args.timeout_secs.unwrap_or(DEFAULT_TIMEOUT_SECS).clamp(10, 1800));
    tauri::async_runtime::spawn_blocking(move || {
        call_provider(def, &cfg, args.system.as_deref(), &args.prompt, timeout)
    })
    .await
    .map_err(|e| e.to_string())?
}

/// "Test" button: a tiny round-trip with the saved key + model. Returns the
/// model's (short) reply so the user sees it really answered.
#[tauri::command]
pub async fn api_brain_test(app: AppHandle, id: String) -> Result<String, String> {
    let def = provider(&id)?;
    let cfg = load_store(&app).providers.get(def.id).cloned()
        .filter(|c| !c.key.is_empty())
        .ok_or("Save a key first.")?;
    tauri::async_runtime::spawn_blocking(move || {
        call_provider(def, &cfg, None, "Reply with exactly: OK", Duration::from_secs(60))
            .map(|t| t.trim().chars().take(80).collect())
    })
    .await
    .map_err(|e| e.to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn base_url_rules() {
        assert_eq!(validate_base_url("https://api.example.com/v1/").unwrap(), "https://api.example.com/v1");
        assert!(validate_base_url("http://localhost:1234/v1").is_ok());
        assert!(validate_base_url("http://127.0.0.1/v1").is_ok());
        assert!(validate_base_url("http://example.com/v1").is_err());
        assert!(validate_base_url("http://localhost.evil.com/v1").is_err());
        assert!(validate_base_url("ftp://x").is_err());
    }

    #[test]
    fn model_rules() {
        assert!(validate_model("claude-opus-5-5", Wire::Anthropic).is_ok());
        assert!(validate_model("openai/gpt-4.1-mini", Wire::OpenAi).is_ok());
        assert!(validate_model("gemini-2.5-flash", Wire::Gemini).is_ok());
        assert!(validate_model("../x", Wire::Gemini).is_err());
        assert!(validate_model("a b", Wire::OpenAi).is_err());
        assert!(validate_model("", Wire::OpenAi).is_err());
    }

    #[test]
    fn hint_never_leaks_more_than_4() {
        assert_eq!(key_hint("sk-abcdef1234"), "…1234");
        assert_eq!(key_hint("ab"), "…ab");
    }

    #[test]
    fn http_error_uses_provider_message() {
        let m = describe_http_error(401, r#"{"error":{"message":"invalid x-api-key"}}"#);
        assert!(m.contains("rejected") && m.contains("invalid x-api-key"));
        assert!(describe_http_error(500, "<html>").contains("HTTP 500"));
    }
}
