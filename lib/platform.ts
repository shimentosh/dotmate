import { isTauri } from "@tauri-apps/api/core";

/**
 * Platform helpers for desktop-only UI tweaks.
 *
 * These are intentionally lightweight (userAgent-based, no @tauri-apps/plugin-os
 * dependency) so they add NOTHING to the Rust/capability surface — the Windows
 * build is byte-for-byte unaffected. All callers gate UI on these at runtime, so
 * the web build and the Windows build render exactly as before.
 *
 * SSR-safe: `navigator` is undefined during server render, so these return false
 * until hydration. Read them inside an effect (mirroring the isTauri() pattern in
 * window-controls.tsx) to avoid hydration mismatches.
 */

/** True only inside the macOS Tauri desktop app. */
export function isMacOS(): boolean {
  if (!isTauri()) return false;
  if (typeof navigator === "undefined") return false;
  return /Mac/i.test(navigator.userAgent) || /Mac/i.test(navigator.platform ?? "");
}

/** True only inside the Windows Tauri desktop app. */
export function isWindows(): boolean {
  if (!isTauri()) return false;
  if (typeof navigator === "undefined") return false;
  return /Win/i.test(navigator.userAgent) || /Win/i.test(navigator.platform ?? "");
}
