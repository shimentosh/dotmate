# Building DotMate from source

This guide covers everything needed to run DotMate in development and to build the
Windows installer yourself. For how the code is organised, see
[ARCHITECTURE.md](ARCHITECTURE.md).

- [Prerequisites](#prerequisites)
- [Quick start](#quick-start)
- [Checks](#checks)
- [Building the installer](#building-the-installer)
- [Environment variables](#environment-variables)
- [Optional: Supertonic voices](#optional-supertonic-voices)
- [Reproducible / privacy-friendly builds](#reproducible--privacy-friendly-builds)
- [Rebranding a fork](#rebranding-a-fork)
- [Updating dependencies](#updating-dependencies)
- [macOS status](#macos-status)
- [Build troubleshooting](#build-troubleshooting)

## Prerequisites

| Tool | Version / notes |
|---|---|
| Windows | 10 or 11, x64 |
| [Node.js](https://nodejs.org) | 20 or newer |
| pnpm | 9.15.4 via Corepack — run `corepack enable` once (or prefix commands with `corepack pnpm`) |
| [Rust](https://rustup.rs) | stable, MSVC toolchain (`x86_64-pc-windows-msvc`) |
| [Visual Studio 2022 Build Tools](https://visualstudio.microsoft.com/visual-cpp-build-tools/) | "Desktop development with C++" workload + Windows SDK |
| [CMake](https://cmake.org/download/) | whisper.cpp is compiled from source |
| [LLVM](https://github.com/llvm/llvm-project/releases) | libclang for whisper-rs bindgen; set `LIBCLANG_PATH` if it is not found |
| Disk | ~10 GB free for the Rust `target` folder |

The first Rust build needs internet: `sherpa-onnx-sys` downloads its prebuilt
Windows libraries from the k2-fsa GitHub releases.

## Quick start

```bash
git clone https://github.com/shimentosh/dotmate.git
cd dotmate
corepack enable
pnpm install
pnpm tauri:dev        # starts `next dev` on :3000 and the Tauri shell
```

`pnpm dev` runs only the UI in a normal browser at <http://localhost:3000>. That is
handy for UI work; anything that needs the native side (FFmpeg tools, downloads,
Whisper, TTS, CLI brains, saving files) shows a "runs in the desktop app" message
there.

## Checks

```bash
pnpm typecheck     # tsc --noEmit
pnpm lint          # eslint
pnpm test          # vitest
```

Rust unit tests: `cargo test` in `src-tauri/` and in each `crates/*` folder.

## Building the installer

PowerShell:

```powershell
pnpm install
$env:CARGO_BUILD_JOBS = "2"
$env:LIBCLANG_PATH = "C:/Program Files/LLVM/bin"
pnpm tauri:build
```

Git Bash:

```bash
pnpm install
CARGO_BUILD_JOBS=2 LIBCLANG_PATH="C:/Program Files/LLVM/bin" pnpm tauri:build
```

`tauri:build`:

1. runs `pnpm build` (`scripts/build-static.mjs` → `next build` with
   `output: "export"` → `out/`);
2. compiles `src-tauri` and `crates/*` in release mode;
3. copies the four sherpa-onnx / ONNX Runtime DLLs into `src-tauri/bundle-dlls/`
   (`build.rs`);
4. produces `<target>/release/bundle/nsis/DotMate_<version>_x64-setup.exe`.

The NSIS hook `src-tauri/installer.nsh` makes sure those DLLs end up next to
`dotmate.exe` — the exe will not start without them.

A release build produces a ~12 MB installer and a ~21 MB executable.

> **Low RAM?** On machines with 16 GB RAM or less, set `CARGO_BUILD_JOBS=2`; the
> default parallelism can exhaust the paging file while linking. If `next build`
> itself runs out of memory, close other apps or run
> `NODE_OPTIONS=--max-semi-space-size=2 pnpm build`.

### Code signing

Signing is not configured. To sign, set `bundle.windows.certificateThumbprint`
or `bundle.windows.signCommand` in `src-tauri/tauri.conf.json`
([Tauri docs](https://v2.tauri.app/distribute/sign/windows/)).

### Releases via GitHub Actions

Pushing a tag such as `v0.1.0` runs
[`.github/workflows/release.yml`](../.github/workflows/release.yml), which builds the
installer on a Windows runner and attaches it to a **draft** GitHub Release. Review
the draft, then publish it.

## Environment variables

DotMate reads no `.env` file. [`.env.example`](../.env.example) documents the
process-environment variables it uses; all are optional.

| Variable | When | Effect |
|---|---|---|
| `SUPERTONIC_ARCHIVE_URL` | Rust **build time** (`option_env!` in `sources.rs`) | Enables Supertonic voices by pointing at a self-hosted archive. Empty → Supertonic hidden. |
| `CARGO_BUILD_JOBS` | build | Limit parallel compile jobs (use `2` on low-RAM machines). |
| `CARGO_TARGET_DIR` | build | Put the Rust build output elsewhere (e.g. another drive). |
| `LIBCLANG_PATH` | build | Location of libclang for whisper-rs. |
| `DOTMATE_DEVTOOLS` | runtime, release build | `1` re-enables DevTools and the WebView2 context menu for diagnosis. |
| `FFMPEG_PATH` | runtime | Explicit ffmpeg binary. The app sets it to its downloaded copy at start-up; set it yourself only to use your own ffmpeg. |

## Optional: Supertonic voices

Supertonic 3 has no public download in the layout the app needs, so
`SUPERTONIC_ARCHIVE_URL` is empty by default and Supertonic is hidden everywhere.
To offer it in your own build:

1. `node src-tauri/scripts/fetch-supertonic-assets.mjs` — mirrors `onnx/` and
   `voice_styles/` from Hugging Face `Supertone/supertonic-3` into
   `src-tauri/supertonic-staging/` (gitignored).
2. Put the Windows `onnxruntime.dll` that matches the `ort` version in
   `src-tauri/Cargo.lock` (ort 2.0.0-rc.12 → ONNX Runtime ~1.22, from the
   microsoft/onnxruntime releases) next to them, or set `ONNXRUNTIME_DLL_URL`
   before step 1.
3. `bash src-tauri/scripts/pack-supertonic-archive.sh` →
   `src-tauri/dist-assets/supertonic-3.tar.gz`.
4. Host that file somewhere you control and build with
   `SUPERTONIC_ARCHIVE_URL=https://your-host/supertonic-3.tar.gz pnpm tauri:build`.

The archive contains a **Windows** ONNX Runtime DLL, so it only works in Windows
builds. The weights are **OpenRAIL-M**: include the licence and pass its use
restrictions on to your users.

## Reproducible / privacy-friendly builds

Release builds embed absolute source and build-folder paths (Rust panic
locations, whisper.cpp's C sources). To keep your folder and user names out of a
build you distribute, build in a neutral folder and remap the paths, e.g. in Git
Bash:

```bash
export CARGO_TARGET_DIR='C:\build\dotmate-target'
export RUSTFLAGS="--remap-path-prefix=$USERPROFILE\\.cargo=/cargo --remap-path-prefix=$USERPROFILE\\.rustup=/rustup --remap-path-prefix=$(pwd -W | tr / '\\\\')=/build --remap-path-prefix=$CARGO_TARGET_DIR=/target"
```

## Rebranding a fork

The product identity lives in:

- [`brand.config.ts`](../brand.config.ts) — name, tagline, colours, credits;
- [`src-tauri/src/branding.rs`](../src-tauri/src/branding.rs) — native name, temp-dir prefix;
- the literal names in `src-tauri/tauri.conf.json` / `tauri.macos.conf.json`
  (`productName`, `mainBinaryName`, `identifier`, window titles);
- `public/splashscreen.html` and the home-page hero;
- the icons: `pnpm tauri icon src-tauri/icon-source.svg -o src-tauri/icons`.

Use your own reverse-DNS `identifier` — it also names the app-data folder.
Please keep the MIT copyright notice and credit to the original authors.

## Updating dependencies

- JavaScript: `pnpm update` (keep `next` at 16.2.x unless you re-test).
- Rust: `cargo update` in `src-tauri` — re-test `ort`, `sherpa-onnx` and
  `whisper-rs` bumps deliberately. Keep the `sherpa-onnx` version in
  `src-tauri/Cargo.toml` in lockstep with `crates/tts/Cargo.toml`.
- FFmpeg: `FFMPEG_ZIP_URLS` in `src-tauri/src/sources.rs` pins Gyan's versioned
  build first, with "current release" fallbacks. Keep a **versioned** URL first —
  branch-pinned "latest" links can disappear.

## macOS status

macOS configuration exists (`tauri.macos.conf.json`, native traffic lights,
standard app menu) but nothing has been built or tested on a Mac yet, and:

- No sherpa-onnx / ONNX Runtime dylibs are bundled for macOS, so Kokoro TTS is
  expected to fail to load.
- The Supertonic archive is Windows-only (it packs `onnxruntime.dll`).
- Video Downloader cancel uses Windows `taskkill`; it does nothing on macOS.
- The macOS FFmpeg source (evermeet.cx) is an x86_64 build (Rosetta 2 on Apple
  Silicon).
- WKWebView has no File System Access API; tools fall back to Save dialogs.
- WebCodecs AAC encoding in WKWebView is unverified.
- The Ollama "Install" button runs Ollama's Linux install script; on macOS install
  the Ollama app from ollama.com instead.

Pull requests that close any of these gaps are very welcome.

## Build troubleshooting

| Problem | Fix |
|---|---|
| Build fails in `whisper-rs` / bindgen | Install CMake and LLVM and set `LIBCLANG_PATH`. |
| Linker runs out of memory | `CARGO_BUILD_JOBS=2`. |
| `next build`: "JavaScript heap out of memory" | Free RAM, or `NODE_OPTIONS=--max-semi-space-size=2`. |
| Installed app does not start (missing DLL) | The four DLLs listed in `tauri.windows.conf.json` must sit next to `dotmate.exe`. Delete `src-tauri/bundle-dlls/` and rebuild. |
| `sherpa-onnx-sys` download fails | The first build needs access to github.com (k2-fsa releases). |

For problems with the installed app, see [TROUBLESHOOTING.md](TROUBLESHOOTING.md).
