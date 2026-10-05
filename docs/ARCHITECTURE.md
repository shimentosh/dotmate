# DotMate architecture

DotMate is a [Tauri 2](https://tauri.app) desktop app. The UI is a
[Next.js 16](https://nextjs.org) site exported as static files and loaded into
WebView2; heavy or privileged work happens in Rust.

```
dotmate/
├── app/                 Next.js App Router pages (static export → out/)
│   ├── page.tsx         home gallery
│   ├── setup/           first-run downloader
│   ├── tools/           quick-trim, merger, audio-merger, file-shuffler,
│   │                    video-downloader, video-trimmer (redirect), bulk-voice
│   └── video-studio/    image-to-video, carousel-to-video, voice-to-text,
│                        text-to-voice, script-writer, script-to-image-prompts
├── components/          app shell, settings, tool widgets, toaster, render dock/guard
├── lib/                 Tauri bridges (tauri-invoke, tauri-bytes, save-file,
│                        deps-local, tts/, brain/), stores, errors, logging
├── store/ hooks/ contexts/   task registry, render jobs, navigation guard
├── public/              splash page, theme script, voice demos + avatars
├── crates/
│   ├── tts/             local-tts        — Kokoro via sherpa-onnx (shared DLLs)
│   ├── supertonic/      supertonic-tts   — Supertonic 3 via ort (load-dynamic)
│   └── whisper/         local-whisper    — whisper.cpp via whisper-rs
├── src-tauri/           Tauri 2 shell (crate `dotmate`)
│   └── src/
│       ├── lib.rs               app setup, yt-dlp + Ollama commands, tray, logs
│       ├── sources.rs           ALL download URLs (upstream publishers only)
│       ├── deps_command.rs      FFmpeg / yt-dlp download + resumable downloader
│       ├── tools_command.rs     FFmpeg merge (video, audio)
│       ├── whisper_command.rs   model download + transcription
│       ├── tts_command.rs       Kokoro / Supertonic download + synthesis
│       ├── cli_brain_command.rs Claude Code / Codex / Gemini CLI runner
│       ├── staging.rs           raw-body IPC, chunked uploads, temp clip sink
│       ├── fs_command.rs        open / reveal / copy / save / read / delete
│       ├── security.rs          path confinement, no-shell open/reveal
│       └── branding.rs          product name, temp-dir prefix
├── brand.config.ts      the one place the product's visible identity lives
└── docs/                documentation + the GitHub Pages website
```

## Where each tool does its work

| Tool | Engine | Runs in |
|---|---|---|
| Quick Trim, Image to Video, Carousel Video | WebCodecs via [Mediabunny](https://github.com/Vanilagy/mediabunny) | WebView |
| File Shuffler | [fflate](https://github.com/101arrowz/fflate) | WebView |
| Clip Merger, Audio Toolkit | FFmpeg | Rust → FFmpeg process |
| Video Downloader | yt-dlp + FFmpeg | Rust → yt-dlp process |
| Speech to Text | whisper.cpp (`crates/whisper`) | Rust, in-process |
| AI Voiceover, Bulk Voice | Kokoro / Supertonic (`crates/tts`, `crates/supertonic`) | Rust, in-process |
| Script Writer, Script to Image Prompts | Ollama (HTTP on localhost) or a CLI | WebView → Ollama, or Rust → CLI process |

## Key design decisions

- **No server, no cloud.** The only HTTP calls from the WebView go to a local
  Ollama (`http://localhost:11434` by default, configurable). The CSP in
  `src-tauri/tauri.conf.json` allows `http://localhost:*` and
  `http://127.0.0.1:*` and nothing else remote.
- **All downloads in Rust.** FFmpeg, yt-dlp, models and the Ollama installer are
  fetched from the URLs in `src-tauri/src/sources.rs` into the app-data folder
  (`%APPDATA%\com.dotmirror.dotmate\` → `bin\`, `models\whisper\`,
  `models\tts\kokoro\`, `models\supertonic\`). Downloads resume after a dropped
  connection.
- **Big files never sit in the WebView.** They cross the IPC bridge as raw
  bodies or in 8 MB chunks (`lib/tauri-bytes.ts`, `staging.rs`), and video export
  streams to disk (`lib/mp4-disk-writer.ts`).
- **Hardened native surface.** `security.rs` confines file operations to
  user-chosen paths and opens/reveals files without a shell. CLI brains run in
  read-only / plan modes inside a scratch folder with the prompt on stdin.
- **State is tiny.** Settings live in `localStorage` under the `free-tools:`
  prefix (kept for compatibility). There is no database.
- **Logs** go to `%LOCALAPPDATA%\com.dotmirror.dotmate\logs\` (main log plus a
  warnings/errors-only `errors.log`).

## Adding a new tool

1. Create the page under `app/tools/<name>/page.tsx` or
   `app/video-studio/<name>/page.tsx`.
2. Add its route to `ROUTES` and `NAV` in [`lib/routes.ts`](../lib/routes.ts).
3. Add a card to [`components/tool-gallery.tsx`](../components/tool-gallery.tsx).
4. If it needs native code, add a `#[tauri::command]` in `src-tauri/src/` and
   register it in `lib.rs`; call it through `lib/tauri-invoke.ts`.
5. If it downloads anything, put the URL in `sources.rs` and add the component
   to [`THIRD_PARTY_NOTICES.md`](../THIRD_PARTY_NOTICES.md) and
   `lib/third-party-notices.ts`.
