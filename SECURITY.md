# Security Policy

## Supported versions

Security fixes are made for the **latest release** of DotMate.

## Reporting a vulnerability

**Please do not open a public issue for security problems.**

Report privately through
[GitHub Security Advisories](https://github.com/shimentosh/dotmate/security/advisories/new)
or by email to **hello@shimantoneer.com**. Please include:

- what the issue is and its impact;
- steps to reproduce (a proof of concept if possible);
- the DotMate version and Windows version.

We aim to reply within **3 working days** and to ship a fix as quickly as the
severity requires. We are happy to credit you in the release notes.

## Scope

Especially interesting areas:

- the Tauri command surface in `src-tauri/src/` (path confinement in
  `security.rs`, file operations in `fs_command.rs`);
- the CLI brain runner (`cli_brain_command.rs`);
- downloads and archive extraction (`deps_command.rs`, `tts_command.rs`,
  `whisper_command.rs`);
- the Content-Security-Policy in `src-tauri/tauri.conf.json`.

Vulnerabilities in third-party tools that DotMate downloads (FFmpeg, yt-dlp,
Ollama) should be reported to those projects.
