/**
 * Open a URL in the system browser. `window.open` is swallowed inside the Tauri
 * webview, so use the opener plugin there; outside Tauri fall back to a new tab.
 */
import { isTauri } from "@tauri-apps/api/core";
import { logDebug } from "@/lib/log";

export async function openExternal(url: string): Promise<void> {
  if (typeof window === "undefined") return;
  if (isTauri()) {
    try {
      const { openUrl } = await import("@tauri-apps/plugin-opener");
      await openUrl(url);
      return;
    } catch (e) {
      logDebug("open-external", "tauri opener failed, falling back to window.open", e);
    }
  }
  window.open(url, "_blank", "noopener,noreferrer");
}
