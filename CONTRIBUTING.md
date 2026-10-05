# Contributing to DotMate

Thanks for helping make DotMate better! 💙 Every contribution counts — bug
reports, ideas, docs, translations, design and code.

## Ways to help

- ⭐ **Star the repo** so more creators can find it.
- 🐛 **Report bugs** with the [bug report form](https://github.com/shimentosh/dotmate/issues/new?template=bug_report.yml).
- 💡 **Suggest features** with the [feature request form](https://github.com/shimentosh/dotmate/issues/new?template=feature_request.yml).
- 💬 **Answer questions** in [Discussions](https://github.com/shimentosh/dotmate/discussions).
- 🧑‍💻 **Send a pull request** — issues labelled
  [`good first issue`](https://github.com/shimentosh/dotmate/labels/good%20first%20issue)
  are a great start.

## Development setup

Follow [docs/BUILDING.md](docs/BUILDING.md). In short:

```bash
corepack enable
pnpm install
pnpm tauri:dev     # full desktop app
pnpm dev           # UI only, in the browser
```

Read [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) to find your way around, and
its "Adding a new tool" section if you want to build one.

## Pull request checklist

1. Fork the repo and create a branch from `main`
   (`feat/carousel-watermark`, `fix/merger-audio-sync`, …).
2. Keep the change focused — one feature or fix per PR.
3. Make sure these pass:
   ```bash
   pnpm typecheck
   pnpm lint
   pnpm test
   ```
   For Rust changes, also run `cargo test` in the crate you touched.
4. Test the change in the desktop app (`pnpm tauri:dev`), not only in the browser.
5. Add screenshots or a short clip for UI changes.
6. Update the docs (`README.md`, `docs/`) if behaviour changes.
7. If you add a dependency or a download, list it in
   [`THIRD_PARTY_NOTICES.md`](THIRD_PARTY_NOTICES.md) and
   `lib/third-party-notices.ts`. Only add components whose licence allows
   redistribution.

## Code style

- Match the surrounding code: strict TypeScript, React function components,
  Tailwind classes, Zustand for shared state.
- Don't swallow errors silently — log them with `@/lib/log` or show them with
  `@/lib/toast` (the linter enforces this).
- Every `localStorage` key goes through `storageKey()` from `brand.config.ts`.
- Every download URL lives in `src-tauri/src/sources.rs`.
- DotMate is **local-first**: features must not send user data to a remote
  server. Network access from the UI is limited to `localhost`.

## Commit messages

[Conventional Commits](https://www.conventionalcommits.org/) are appreciated:

```
feat(carousel): add custom watermark
fix(merger): keep audio in sync when B-roll is shorter
docs: explain LIBCLANG_PATH
```

## Licence

By contributing, you agree that your contributions are licensed under the
[MIT License](LICENSE) of this project.

## Code of Conduct

This project follows our [Code of Conduct](CODE_OF_CONDUCT.md). Please be kind.
