/**
 * Local exports record (desktop). Rendered videos are written to a file on the
 * user's machine (Downloads); this keeps a small local list of them in
 * localStorage and opens / reveals them — fully on-device.
 */
import { invoke, isTauri } from "@tauri-apps/api/core";
import { logDebug } from "@/lib/log";
import { storageKey } from "@/brand.config";

export interface LocalExport {
  id: string;
  title: string;
  path: string;          // absolute file path on this machine
  createdAt: number;     // epoch ms
  width: number;
  height: number;
  durationFrames: number;
  fps: number;
}

const KEY = storageKey("local-exports");
const MAX = 200;

/** Available only in the desktop app (where file open/reveal work). */
export function localExportsAvailable(): boolean {
  return isTauri();
}

export function listLocalExports(): LocalExport[] {
  if (typeof window === "undefined") return [];
  try {
    const arr = JSON.parse(window.localStorage.getItem(KEY) || "[]");
    return Array.isArray(arr) ? (arr as LocalExport[]) : [];
  } catch {
    return [];
  }
}

export function addLocalExport(e: Omit<LocalExport, "id" | "createdAt">): LocalExport {
  const rec: LocalExport = {
    id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    createdAt: Date.now(),
    ...e,
  };
  const all = [rec, ...listLocalExports()].slice(0, MAX);
  try { window.localStorage.setItem(KEY, JSON.stringify(all)); } catch (e) { logDebug("local-exports", "failed to persist export list", e); }
  return rec;
}

export function removeLocalExport(id: string): void {
  const all = listLocalExports().filter((e) => e.id !== id);
  try { window.localStorage.setItem(KEY, JSON.stringify(all)); } catch (e) { logDebug("local-exports", "failed to persist export list after remove", e); }
}

/** Open the exported file in the OS default player. */
export function openLocalExport(path: string): Promise<void> {
  return invoke("open_file", { path });
}

/** Reveal the exported file in the OS file manager. */
export function revealLocalExport(path: string): Promise<void> {
  return invoke("reveal_in_folder", { path });
}
