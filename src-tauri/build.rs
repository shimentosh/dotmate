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

  // macOS: the same engine links `@rpath/libsherpa-onnx-c-api.dylib` and
  // `@rpath/libonnxruntime.<ver>.dylib`. The bundle ships them in
  // `Contents/Frameworks/` (`bundle.macOS.frameworks` in tauri.macos.conf.json),
  // so the exe needs that folder on its rpath; sherpa itself only adds
  // `@loader_path` (enough for `target/<profile>/` in dev).
  if std::env::var("CARGO_CFG_TARGET_OS").as_deref() == Ok("macos") {
    println!("cargo:rustc-link-arg=-Wl,-rpath,@executable_path/../Frameworks");
    ensure_bundle_dylibs();
  }

  tauri_build::build()
}

/// Mirror the sherpa-onnx / ONNX Runtime dylibs into `<manifest>/bundle-dylibs/`
/// (gitignored), the fixed path `tauri.macos.conf.json` bundles them from. Same
/// sources as `ensure_bundle_dlls`: the Cargo profile dir, then sherpa's extracted
/// prebuilt under `<target>/sherpa-onnx-prebuilt/*/lib`.
fn ensure_bundle_dylibs() {
  use std::{env, fs, path::PathBuf};

  // Keep the ONNX Runtime version in step with sherpa-onnx's prebuilt (1.13.3 →
  // 1.24.4) and with `bundle.macOS.frameworks`.
  const DYLIBS: [&str; 2] = ["libsherpa-onnx-c-api.dylib", "libonnxruntime.1.24.4.dylib"];

  let manifest = PathBuf::from(env::var("CARGO_MANIFEST_DIR").unwrap());
  let dest_dir = manifest.join("bundle-dylibs");
  println!("cargo:rerun-if-changed=bundle-dylibs");
  let _ = fs::create_dir_all(&dest_dir);

  let out_dir = PathBuf::from(env::var("OUT_DIR").unwrap_or_default());
  let profile = env::var("PROFILE").unwrap_or_default();

  let mut sources: Vec<PathBuf> = Vec::new();
  if let Some(p) = out_dir.ancestors().find(|p| p.file_name().map(|n| n == profile.as_str()).unwrap_or(false)) {
    sources.push(p.to_path_buf());
  }
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

  for lib in DYLIBS {
    for src in &sources {
      let candidate = src.join(lib);
      if candidate.exists() {
        let _ = fs::copy(&candidate, dest_dir.join(lib));
        break;
      }
    }
  }
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
