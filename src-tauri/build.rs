fn main() {
  // The on-device TTS engine (sherpa-onnx, `shared` mode) needs four DLLs next to
  // the exe. They are declared as `bundle.resources` in `tauri.windows.conf.json`
  // at `bundle-dlls/*.dll`. sherpa-onnx-sys's build script downloads them and
  // copies them into the Cargo PROFILE dir (`<target>/<profile>/`), which moves
  // around (CARGO_TARGET_DIR, debug vs release) — so mirror them into the fixed,
  // gitignored `bundle-dlls/` folder here, BEFORE tauri_build::build() validates
  // that every declared resource exists.
  #[cfg(target_os = "windows")]
  ensure_bundle_dlls();

  tauri_build::build()
}

/// Copy the sherpa-onnx / ONNX Runtime DLLs into `<manifest>/bundle-dlls/`.
/// Sources, in priority order: the current Cargo profile dir (derived from
/// OUT_DIR, so it honours CARGO_TARGET_DIR), then every extracted sherpa prebuilt
/// under `<target>/sherpa-onnx-prebuilt/*/lib`.
#[cfg(target_os = "windows")]
fn ensure_bundle_dlls() {
  use std::{env, fs, path::PathBuf};

  const DLLS: [&str; 4] = [
    "onnxruntime.dll",
    "onnxruntime_providers_shared.dll",
    "sherpa-onnx-c-api.dll",
    "sherpa-onnx-cxx-api.dll",
  ];

  let manifest = PathBuf::from(env::var("CARGO_MANIFEST_DIR").unwrap());
  let dest_dir = manifest.join("bundle-dlls");
  println!("cargo:rerun-if-changed=bundle-dlls");
  let _ = fs::create_dir_all(&dest_dir);

  let out_dir = PathBuf::from(env::var("OUT_DIR").unwrap_or_default());
  let profile = env::var("PROFILE").unwrap_or_default();

  let mut sources: Vec<PathBuf> = Vec::new();
  // <target>/<profile> — found by walking up from OUT_DIR.
  if let Some(p) = out_dir.ancestors().find(|p| p.file_name().map(|n| n == profile.as_str()).unwrap_or(false)) {
    sources.push(p.to_path_buf());
  }
  // <target>/sherpa-onnx-prebuilt/<version>/lib — same target-dir rule sherpa uses.
  let target_dir = env::var("CARGO_TARGET_DIR").map(PathBuf::from).ok().or_else(|| {
    out_dir
      .ancestors()
      .find(|p| p.file_name().map(|n| n == "target").unwrap_or(false))
      .map(|p| p.to_path_buf())
  });
  if let Some(t) = target_dir {
    if let Ok(entries) = fs::read_dir(t.join("sherpa-onnx-prebuilt")) {
      for entry in entries.flatten() {
        sources.push(entry.path().join("lib"));
      }
    }
  }

  for dll in DLLS {
    for src in &sources {
      let candidate = src.join(dll);
      if candidate.exists() {
        let _ = fs::copy(&candidate, dest_dir.join(dll));
        break;
      }
    }
  }
}
