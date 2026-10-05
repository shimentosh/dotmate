# Changelog

All notable changes to DotMate are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses
[Semantic Versioning](https://semver.org/).

## [Unreleased]

## [0.1.1] — 2026-10-05

### Added

- **macOS builds** for Apple Silicon and Intel (`.dmg`), and a Windows **`.msi`**
  installer next to the `.exe`.
- **Self-repair on launch:** if FFmpeg or yt-dlp has gone missing, DotMate
  downloads them again automatically. When offline you can retry or skip — the
  tools that don't need them keep working.

## [0.1.0] — 2026-10-05

First open-source release. 🎉

### Added

- **Video:** Quick Trim, Clip Merger, Image to Video, Carousel Video (18
  transitions), File Shuffler.
- **Audio & voice:** Audio Toolkit, AI Voiceover and Bulk Voice (Kokoro, optional
  Supertonic), Speech to Text (whisper.cpp).
- **Writing:** Script Writer and Script to Image Prompts with Ollama or the
  Claude Code / Codex / Gemini CLIs.
- **Download:** Video Downloader powered by yt-dlp.
- First-run setup, Settings (General / Local AI / About), render dock, task
  guard, minimise to tray, light and dark themes.

[Unreleased]: https://github.com/shimentosh/dotmate/compare/v0.1.1...HEAD
[0.1.1]: https://github.com/shimentosh/dotmate/compare/v0.1.0...v0.1.1
[0.1.0]: https://github.com/shimentosh/dotmate/releases/tag/v0.1.0
