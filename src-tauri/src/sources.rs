//! EVERY download URL the app uses, in one place, so a vendor can repoint them.
//!
//! All defaults are the ORIGINAL publishers' release locations — nothing is
//! re-hosted. Nothing here is fetched until the user runs the first-run setup or
//! installs a component from Settings → Local AI (or first uses a tool that needs
//! it). To mirror a file on your own host, change the constant and rebuild.
//!
//! Licences of what these URLs deliver are listed in THIRD_PARTY_NOTICES.md
//! (FFmpeg: GPL-3.0 builds; yt-dlp: Unlicense; Whisper ggml: MIT; Kokoro package:
//! Apache-2.0 incl. GPL-3.0 espeak-ng data; Supertonic: OpenRAIL-M; Ollama: MIT).

// ── FFmpeg (static build; only `ffmpeg(.exe)` is extracted) ─────────────────────
// Windows: tried in order until one downloads. A pinned, versioned build first —
// its URL never changes — then two "current" links in case that release is ever
// removed. Each zip holds bin/ffmpeg.exe and bin/ffprobe.exe (GPL-3.0 builds).
// (A branch-pinned "latest" asset such as BtbN's ffmpeg-n7.1-latest-… disappears
// when the publisher rotates branches, which is why it is not used.)
#[cfg(windows)]
pub const FFMPEG_ZIP_URLS: &[&str] = &[
    // Gyan's build on GitHub — tag 8.1.2 is permanent.
    "https://github.com/GyanD/codexffmpeg/releases/download/8.1.2/ffmpeg-8.1.2-essentials_build.zip",
    // gyan.dev — always redirects to the current release.
    "https://www.gyan.dev/ffmpeg/builds/ffmpeg-release-essentials.zip",
    // BtbN — rolling master build (stable file name).
    "https://github.com/BtbN/FFmpeg-Builds/releases/download/latest/ffmpeg-master-latest-win64-gpl.zip",
];
// macOS: evermeet.cx latest release (a zip holding a single `ffmpeg`, no ffprobe).
// NOTE: an x86_64 build — native on Intel, Rosetta 2 on Apple Silicon. Not tested
// by this project.
#[cfg(target_os = "macos")]
pub const FFMPEG_ZIP_URLS: &[&str] = &["https://evermeet.cx/ffmpeg/getrelease/zip"];
// Linux: not a supported target. BtbN ships a .tar.xz here, which the zip
// extractor in deps_command.rs cannot open.
#[cfg(not(any(windows, target_os = "macos")))]
pub const FFMPEG_ZIP_URLS: &[&str] =
    &["https://github.com/BtbN/FFmpeg-Builds/releases/download/latest/ffmpeg-master-latest-linux64-gpl.tar.xz"];

// ── yt-dlp (single self-contained executable) ──────────────────────────────────
#[cfg(windows)]
pub const YTDLP_URL: &str = "https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp.exe";
#[cfg(target_os = "macos")]
pub const YTDLP_URL: &str = "https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp_macos";
#[cfg(not(any(windows, target_os = "macos")))]
pub const YTDLP_URL: &str = "https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp";

// ── Whisper (ggml models for whisper.cpp) ──────────────────────────────────────
/// `<base>/ggml-<size>.bin` for size in tiny | base | small.
pub const WHISPER_MODEL_BASE_URL: &str = "https://huggingface.co/ggerganov/whisper.cpp/resolve/main";

// ── Kokoro TTS (sherpa-onnx's redistribution: model + voices + espeak-ng data) ──
pub const KOKORO_ARCHIVE_URL: &str =
    "https://github.com/k2-fsa/sherpa-onnx/releases/download/tts-models/kokoro-multi-lang-v1_0.tar.bz2";

// ── Supertonic 3 TTS ───────────────────────────────────────────────────────────
/// There is NO public archive for Supertonic in the layout the app needs
/// (onnx/ + voice_styles/ + a version-matched onnxruntime library in ONE
/// .tar.gz), so this is EMPTY by default and Supertonic is hidden in the UI.
/// A vendor who wants it builds the archive with
/// `src-tauri/scripts/pack-supertonic-archive.sh`, hosts it, and sets the URL at
/// BUILD time:  `SUPERTONIC_ARCHIVE_URL=https://… pnpm tauri:build`.
/// The archive packs a Windows `onnxruntime.dll`, so it only works on Windows.
/// The weights are OpenRAIL-M: the use restrictions must flow down to end users.
pub const SUPERTONIC_ARCHIVE_URL: &str = match option_env!("SUPERTONIC_ARCHIVE_URL") {
    Some(url) => url,
    None => "",
};

// ── Ollama (optional local LLM runtime, installed on request) ──────────────────
#[cfg(windows)]
pub const OLLAMA_WINDOWS_INSTALLER_URL: &str = "https://ollama.com/download/OllamaSetup.exe";
/// macOS/Linux: Ollama's official install script (piped to `sh`).
#[cfg(not(windows))]
pub const OLLAMA_INSTALL_SCRIPT_URL: &str = "https://ollama.com/install.sh";
