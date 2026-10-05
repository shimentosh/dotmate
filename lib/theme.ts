/**
 * Light / dark / system theme — one storage key shared by `public/theme-init.js`
 * (runs before hydration, no flash), the app layout, and Settings → General.
 */
import { storageKey } from "@/brand.config";

export type Theme = "light" | "dark" | "system";

/** Must match the key hard-coded in public/theme-init.js. */
export const THEME_KEY = storageKey("theme");

export function readTheme(): Theme {
  try {
    const t = localStorage.getItem(THEME_KEY);
    return t === "light" || t === "dark" || t === "system" ? t : "system";
  } catch {
    return "system";
  }
}

export function applyTheme(t: Theme): void {
  if (typeof window === "undefined") return;
  const dark = t === "dark" || (t === "system" && window.matchMedia("(prefers-color-scheme: dark)").matches);
  document.documentElement.classList.toggle("dark", dark);
}

export function applyStoredTheme(): void {
  applyTheme(readTheme());
}

export function saveTheme(t: Theme): void {
  try { localStorage.setItem(THEME_KEY, t); } catch { /* storage unavailable — theme still applies for this session */ }
  applyTheme(t);
}
