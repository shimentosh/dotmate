//! Small file-system commands: open a file in the OS default app, reveal it in the
//! file manager, copy finished downloads into a folder, save in-memory bytes to a
//! user-chosen path, and read/delete the app's own temp files.

use std::path::Path;

use tauri::AppHandle;

use crate::security;

/// Copy a set of files into `dest_dir`, preserving each file's name.
/// Used by the Video Downloader "Save all" action to gather finished
/// downloads into one user-chosen folder. Returns how many were copied;
/// missing/unreadable sources are skipped rather than aborting the batch.
/// `(async)` — copying large video files must not block the webview main thread.
#[tauri::command(async)]
pub fn copy_files(app: AppHandle, files: Vec<String>, dest_dir: String) -> Result<usize, String> {
    // Defense-in-depth: refuse traversal + protected system/autostart targets.
    security::reject_hostile_dest(&app, &dest_dir)?;
    let dest = std::path::Path::new(&dest_dir);
    std::fs::create_dir_all(dest).map_err(|e| e.to_string())?;

    let mut copied = 0usize;
    for src in &files {
        let src_path = std::path::Path::new(src);
        let Some(name) = src_path.file_name() else { continue };
        if !src_path.is_file() { continue; }
        let target = dest.join(name);
        // Don't copy a file onto itself (e.g. saving back into Downloads).
        if src_path == target { copied += 1; continue; }
        if std::fs::copy(src_path, &target).is_ok() {
            copied += 1;
        }
    }
    Ok(copied)
}

/// Write raw bytes (the request body) to a user-chosen file path (`dest-path`, a
/// base64 header — see lib/tauri-bytes.ts). The Tauri webview silently ignores a
/// programmatic `<a download>` click, so saving an IN-MEMORY blob (e.g. a freshly
/// generated voiceover) must go through the native side: the frontend opens a
/// native Save dialog, then hands the picked path + bytes here.
/// `(async)` — a large write must not block the webview main thread.
#[tauri::command(async)]
pub fn save_bytes(app: AppHandle, request: tauri::ipc::Request<'_>) -> Result<String, String> {
    let dest = crate::staging::header_str(&request, "dest-path")
        .ok_or("missing dest-path header")?;
    // Raw body, or a chunk-streamed staging file for large saves.
    let bytes = crate::staging::body_or_staged(&request)?;
    let path = std::path::PathBuf::from(&dest);
    // Defense-in-depth: validate the parent dir (absolute, no traversal, not a
    // protected system location) even though the user picked it in the OS dialog.
    let parent = path.parent().ok_or("destination has no parent directory")?;
    security::reject_hostile_dest(&app, &parent.to_string_lossy())?;
    std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    std::fs::write(&path, bytes).map_err(|e| e.to_string())?;
    Ok(path.to_string_lossy().to_string())
}

/// Read a whole app-generated file (e.g. a rendered MP4 promoted from staging)
/// back into the page as raw bytes (`Response` → an ArrayBuffer on the JS side —
/// never a JSON number array). Confined to the app's own directories so it can't
/// be used to read arbitrary files. `(async)` — never block the UI.
#[tauri::command(async)]
pub fn read_file_bytes(app: AppHandle, path: String) -> Result<tauri::ipc::Response, String> {
    let safe = security::confine_existing(&path, &security::app_managed_roots(&app))?;
    std::fs::read(&safe)
        .map(tauri::ipc::Response::new)
        .map_err(|e| e.to_string())
}

/// Delete an app temp file, ignoring "not found". Confined to the app's own
/// directories (legit callers only delete app temp files).
#[tauri::command]
pub fn delete_file(app: AppHandle, path: String) -> Result<(), String> {
    match security::confine_existing(&path, &security::app_managed_roots(&app)) {
        Ok(safe) => match std::fs::remove_file(&safe) {
            Ok(()) => Ok(()),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
            Err(e) => Err(e.to_string()),
        },
        // confine_existing errors when the file doesn't resolve; keep "not found"
        // a silent no-op so cleanup of an already-gone temp file still succeeds.
        Err(_) if !Path::new(&path).exists() => Ok(()),
        Err(e) => Err(e),
    }
}

/// Open a file (or folder) with the OS default application. Routes through the
/// opener plugin's shell-open API — NOT `cmd /C start` — so a path/file name
/// carrying cmd metacharacters (`& | ^ …`, e.g. from a downloaded video's title)
/// can never break out into command execution.
#[tauri::command]
pub fn open_file(app: AppHandle, path: String) -> Result<(), String> {
    // Shell-open EXECUTES an .exe/.bat/… — block those so this can't be an injected
    // code-execution primitive. Opening a media/document file is unaffected.
    security::confine_openable(&path)?;
    security::open_path_native(&app, &path)
}

/// Reveal a file in the OS file manager (selected/highlighted) via the opener
/// plugin (no shell, no `/select,` string-building).
#[tauri::command]
pub fn reveal_in_folder(app: AppHandle, path: String) -> Result<(), String> {
    security::reveal_path_native(&app, &path)
}
