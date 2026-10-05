# Third-party notices

DotMate is built on, bundles, or downloads the third-party components below.
Each is governed by its own licence; DotMate's own source code is MIT-licensed
(`LICENSE`), and nothing in that licence changes the terms below. This file lists every component the product **ships** (in the installer or
the static UI bundle) or **downloads at runtime**, the licence, and any
obligation a distributor must meet. It is a good-faith summary, **not legal
advice** — if you redistribute your own builds, review the flagged items below.

The Settings → About screen in the app shows a short version of this list
(`lib/third-party-notices.ts`); keep the two in sync.

> To regenerate the full transitive dependency lists before a release:
> `corepack pnpm licenses list --prod` (JavaScript) and `cargo about generate` or
> `cargo license` in `src-tauri/` (Rust — not run by this project). Include the
> resulting licence texts with the installer.

---

## 1. Components that need attention when redistributing

| Component | Why it matters |
|---|---|
| **espeak-ng** (GPL-3.0-or-later), compiled into `sherpa-onnx-c-api.dll` and shipped in the installer; its phoneme data (`espeak-ng-data/`) is also inside the downloaded Kokoro package | The installer ships a GPL-3.0 library next to `dotmate.exe`, which links it dynamically at load time. DotMate's own code is MIT, which is GPL-compatible, so the installer as a whole can be distributed under GPL-3.0 terms: include the GPL-3.0 text and point to the espeak-ng / sherpa-onnx sources (github.com/espeak-ng/espeak-ng, github.com/k2-fsa/sherpa-onnx). To ship without it, remove Kokoro TTS (`crates/tts`) and its DLLs. |
| **FFmpeg** — Gyan "essentials" static build (Windows; fallbacks gyan.dev current release, BtbN master) / evermeet static build (macOS), GPL-3.0-or-later, H.264/HEVC/AAC patent exposure | Not shipped: downloaded at runtime from the original publisher (`src-tauri/src/sources.rs`). Re-hosting it would make you the distributor. The build includes patent-encumbered codecs. |
| **yt-dlp** (Unlicense) | Licence is permissive; the risk is downloading from sites whose terms forbid it. The Video Downloader can be removed by deleting its route, the `ytdlp_*` commands in `src-tauri/src/lib.rs`, and the yt-dlp download in `deps_command.rs`. |
| **Supertonic 3** weights (OpenRAIL-M) | Hidden unless you host the archive yourself (README → Supertonic). OpenRAIL-M's use restrictions must be passed on to end users (e.g. in the EULA). |
| **Voice avatar images** (`public/voice-avatars/*.png`) and the effect preview image (`public/transition-preview-a.webp`) | **No recorded origin or licence** — they are not covered by DotMate's MIT licence. Contributions that replace them with clearly licensed artwork are welcome. |

## 2. Shipped in the installer (native)

| Component | Version (Cargo.lock) | Licence | Notes |
|---|---|---|---|
| Tauri, tauri-build, tauri-runtime-wry, wry, tao | 2.x | MIT OR Apache-2.0 | App shell |
| tauri-plugin-log / -dialog / -opener / -single-instance | 2.x | MIT OR Apache-2.0 | |
| Microsoft WebView2 (system component) | — | Microsoft terms | Not shipped; the installer may download the WebView2 bootstrapper from Microsoft |
| webview2-com, windows (windows-rs) | 0.38 / 0.61 | MIT OR Apache-2.0 | Release-build hardening |
| sherpa-onnx (Rust bindings) + sherpa-onnx-sys | 1.13.3 | Apache-2.0 | |
| `sherpa-onnx-c-api.dll`, `sherpa-onnx-cxx-api.dll` (prebuilt by k2-fsa) | 1.13.3 | Apache-2.0; **contains espeak-ng (GPL-3.0-or-later)** and piper-phonemize | See §1 |
| `onnxruntime.dll`, `onnxruntime_providers_shared.dll` (prebuilt, bundled by sherpa-onnx) | per sherpa 1.13.3 | MIT (Microsoft) | Include the ONNX Runtime licence + ThirdPartyNotices |
| whisper-rs / whisper-rs-sys | 0.16 | Unlicense | |
| whisper.cpp / ggml (compiled into the exe) | per whisper-rs-sys | MIT | |
| ort (ONNX Runtime bindings, `load-dynamic`) | 2.0.0-rc.12 | MIT OR Apache-2.0 | Only used for Supertonic |
| Supertonic reference inference code (vendored in `crates/supertonic/src/lib.rs`) | — | MIT (Supertone Inc., github.com/supertone-inc/supertonic) | Keep the MIT notice |
| ndarray, rand, rand_distr, regex, unicode-normalization, serde, serde_json, hound, anyhow, log, base64 | see Cargo.lock | MIT OR Apache-2.0 (hound: Apache-2.0) | |
| ureq, rustls, ring, webpki-roots | see Cargo.lock | MIT/Apache-2.0/ISC; ring: ISC-style + OpenSSL-derived; webpki-roots: CDLA-Permissive-2.0 or MPL-2.0 depending on version | HTTPS for runtime downloads |
| tar, bzip2 (+ libbz2 C sources), flate2 (+ miniz_oxide), zip | see Cargo.lock | MIT OR Apache-2.0 (libbz2: bzip2 licence) | Archive extraction |

## 3. Shipped in the UI bundle (JavaScript)

| Package | Licence |
|---|---|
| next, react, react-dom (runtime parts bundled into `out/`) | MIT |
| @tauri-apps/api, @tauri-apps/plugin-dialog, @tauri-apps/plugin-opener | MIT OR Apache-2.0 |
| mediabunny | **MPL-2.0** — file-level copyleft: if you modify its files you must publish those files' source; unmodified use only requires keeping the notice |
| lucide-react | ISC |
| react-icons | MIT (the Font Awesome Free icons it contains: CC BY 4.0; Simple Icons: CC0 1.0 — brand logos remain trademarks of their owners) |
| zustand | MIT |
| fflate | MIT |
| tailwindcss (compiled CSS), tw-animate-css | MIT |

## 4. Downloaded at runtime (from the original publishers)

Nothing below is contacted until the user runs the first-run setup, installs a
component in Settings → Local AI, or first uses a tool that needs it. All URLs
live in `src-tauri/src/sources.rs`.

| Component | Source | Licence / terms |
|---|---|---|
| FFmpeg (Windows: Gyan `8.1.2` essentials, then gyan.dev current / BtbN master; macOS: evermeet.cx latest) | github.com/GyanD/codexffmpeg · gyan.dev · github.com/BtbN/FFmpeg-Builds · evermeet.cx | GPL-3.0-or-later (see §1) |
| yt-dlp | github.com/yt-dlp/yt-dlp releases | Unlicense (see §1) |
| Whisper ggml models (tiny / base / small) | huggingface.co/ggerganov/whisper.cpp | MIT (OpenAI Whisper weights, converted by ggml) |
| Kokoro-82M multi-lang v1.0 (sherpa-onnx package: model, voices, tokens, lexicons, `espeak-ng-data/`) | github.com/k2-fsa/sherpa-onnx releases (`tts-models`) | Kokoro: Apache-2.0; espeak-ng data: GPL-3.0-or-later; lexicons per their sources |
| Supertonic 3 archive (only if the build configured `SUPERTONIC_ARCHIVE_URL`) | whoever built that copy | Weights: OpenRAIL-M; code/config: MIT; bundled `onnxruntime.dll`: MIT |
| Ollama installer (only if the user asks) | ollama.com | MIT |

## 5. Used if the user installs them (never shipped or downloaded by the app)

| Component | Terms |
|---|---|
| Ollama models (e.g. Llama 3.2, Qwen2.5-VL) pulled through Ollama | Each model's own licence (e.g. Llama 3.2 Community License) |
| Claude Code CLI | Anthropic's terms |
| Codex CLI | Apache-2.0 (client); OpenAI's terms for the service |
| Gemini CLI | Apache-2.0 (client); Google's terms for the service |

## 6. Operating-system fonts

The Image-to-Video / Carousel watermark text and the canvas titles render with
fonts **already installed** on the user's computer (Arial, Segoe UI, Georgia, …).
No font files are shipped or downloaded.
