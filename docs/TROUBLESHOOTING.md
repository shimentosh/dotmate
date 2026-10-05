# Troubleshooting DotMate

First stop for any problem: **Settings → General → Open logs folder**
(`%LOCALAPPDATA%\com.dotmirror.dotmate\logs\`). `errors.log` contains only
warnings and errors. Attach it when you
[open an issue](https://github.com/shimentosh/dotmate/issues/new/choose).

## Common problems

**"FFmpeg / yt-dlp not found"**
They are installed by the first-run setup. If they were deleted later, either put
`ffmpeg.exe` / `yt-dlp.exe` back into `%APPDATA%\com.dotmirror.dotmate\bin\`, have
them on your system `PATH`, or re-run setup by deleting the WebView data folder
`%LOCALAPPDATA%\com.dotmirror.dotmate\EBWebView\` (this also resets settings).

**A model or voice download is stuck**
Downloads resume — retry from Settings → Local AI. Corporate proxies or firewalls
that block GitHub or Hugging Face will block these downloads.

**Video Downloader stopped working for a site**
Sites change often. Delete `%APPDATA%\com.dotmirror.dotmate\bin\yt-dlp.exe` and
open the Video Downloader again to fetch the latest yt-dlp.

**Video Downloader asks me to sign in**
Export a `cookies.txt` from a browser where you are logged in (the tool links to
an extension) and select it in the tool.

**"No brain detected" in Script Writer**
Start Ollama (Settings → Local AI → Brain → Start), or run your CLI (Claude Code,
Codex, Gemini) once in a terminal to sign in, then press refresh.

**Stopping a CLI brain**
Stop discards the result, but the CLI process keeps running until it finishes or
reaches its 300-second timeout.

**The app does not start after installing (missing DLL)**
The four DLLs (`onnxruntime.dll`, `onnxruntime_providers_shared.dll`,
`sherpa-onnx-c-api.dll`, `sherpa-onnx-cxx-api.dll`) must be next to
`dotmate.exe`. Reinstall; if you built it yourself see
[BUILDING.md](BUILDING.md#build-troubleshooting).

**Windows SmartScreen warns about the installer**
Unsigned builds trigger SmartScreen. Click **More info → Run anyway**, or build
from source.

## Updating

- **App:** install the newer release over the old one. There is no auto-updater yet.
- **FFmpeg:** delete `bin\ffmpeg.exe` in the app-data folder to re-download it.
- **Models:** delete the folder under `models\` and reinstall from Settings.

## Backing up

There is no user database. What exists on disk:

| What | Where | Back up? |
|---|---|---|
| Settings (theme, Local AI choices, tool preferences) | `%LOCALAPPDATA%\com.dotmirror.dotmate\EBWebView\` | Yes, if you want to keep them |
| Downloaded tools and models | `%APPDATA%\com.dotmirror.dotmate\` | Optional — they can be re-downloaded |
| Temporary files | `%TEMP%\dotmate-*` | No — swept automatically after 24 h |
| Your exports | wherever you saved them | Yes |
