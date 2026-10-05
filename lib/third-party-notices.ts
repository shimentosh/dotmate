/**
 * Third-party components shown in Settings → About. Keep in sync with
 * THIRD_PARTY_NOTICES.md at the repository root (that file is the full text,
 * including obligations).
 */
export interface Notice {
  name: string;
  license: string;
  /** How it reaches the user. */
  delivery: "bundled" | "downloaded at runtime" | "user-installed";
  url: string;
}

export const THIRD_PARTY_NOTICES: Notice[] = [
  // UI (bundled in the app)
  { name: "Next.js", license: "MIT", delivery: "bundled", url: "https://github.com/vercel/next.js" },
  { name: "React / React DOM", license: "MIT", delivery: "bundled", url: "https://github.com/facebook/react" },
  { name: "Tailwind CSS", license: "MIT", delivery: "bundled", url: "https://github.com/tailwindlabs/tailwindcss" },
  { name: "tw-animate-css", license: "MIT", delivery: "bundled", url: "https://github.com/Wombosvideo/tw-animate-css" },
  { name: "Lucide icons (lucide-react)", license: "ISC", delivery: "bundled", url: "https://github.com/lucide-icons/lucide" },
  { name: "react-icons (Font Awesome Free, Simple Icons)", license: "MIT (icons: CC BY 4.0 / CC0 1.0)", delivery: "bundled", url: "https://github.com/react-icons/react-icons" },
  { name: "Mediabunny", license: "MPL-2.0", delivery: "bundled", url: "https://github.com/Vanilagy/mediabunny" },
  { name: "fflate", license: "MIT", delivery: "bundled", url: "https://github.com/101arrowz/fflate" },
  { name: "Zustand", license: "MIT", delivery: "bundled", url: "https://github.com/pmndrs/zustand" },
  // Native shell (compiled into the app)
  { name: "Tauri + plugins (log, dialog, opener, single-instance)", license: "MIT or Apache-2.0", delivery: "bundled", url: "https://github.com/tauri-apps/tauri" },
  { name: "whisper.cpp (via whisper-rs)", license: "MIT (whisper-rs: Unlicense)", delivery: "bundled", url: "https://github.com/ggml-org/whisper.cpp" },
  { name: "sherpa-onnx (shared libraries)", license: "Apache-2.0 — contains espeak-ng (GPL-3.0)", delivery: "bundled", url: "https://github.com/k2-fsa/sherpa-onnx" },
  { name: "ONNX Runtime", license: "MIT", delivery: "bundled", url: "https://github.com/microsoft/onnxruntime" },
  { name: "ort (Rust bindings for ONNX Runtime)", license: "MIT or Apache-2.0", delivery: "bundled", url: "https://github.com/pykeio/ort" },
  { name: "Rust crates (serde, ureq, rustls, tar, bzip2, flate2, zip, …)", license: "mostly MIT / Apache-2.0 — see THIRD_PARTY_NOTICES.md", delivery: "bundled", url: "https://crates.io" },
  // Downloaded at runtime from upstream
  { name: "FFmpeg (BtbN Windows build / evermeet macOS build)", license: "GPL-3.0", delivery: "downloaded at runtime", url: "https://ffmpeg.org" },
  { name: "yt-dlp", license: "Unlicense", delivery: "downloaded at runtime", url: "https://github.com/yt-dlp/yt-dlp" },
  { name: "Whisper models (ggml, OpenAI Whisper weights)", license: "MIT", delivery: "downloaded at runtime", url: "https://huggingface.co/ggerganov/whisper.cpp" },
  { name: "Kokoro-82M (sherpa-onnx package, incl. espeak-ng data)", license: "Apache-2.0 (espeak-ng data: GPL-3.0)", delivery: "downloaded at runtime", url: "https://github.com/k2-fsa/sherpa-onnx/releases/tag/tts-models" },
  { name: "Supertonic 3 (only if this build configures a source)", license: "OpenRAIL-M", delivery: "downloaded at runtime", url: "https://huggingface.co/Supertone/supertonic-3" },
  { name: "Ollama installer", license: "MIT", delivery: "downloaded at runtime", url: "https://ollama.com" },
  // Installed by the user, used if present
  { name: "Ollama models (e.g. Llama 3.2)", license: "per model (e.g. Llama 3.2 Community License)", delivery: "user-installed", url: "https://ollama.com/library" },
  { name: "Claude Code CLI", license: "Anthropic terms", delivery: "user-installed", url: "https://claude.com/claude-code" },
  { name: "Codex CLI", license: "Apache-2.0 (service: OpenAI terms)", delivery: "user-installed", url: "https://github.com/openai/codex" },
  { name: "Gemini CLI", license: "Apache-2.0 (service: Google terms)", delivery: "user-installed", url: "https://github.com/google-gemini/gemini-cli" },
];
