import type { SettingsSection } from "@/components/settings/settings-modal";
import { storageKey } from "@/brand.config";

/**
 * Open the settings modal at a section from anywhere in the app. The TopBar
 * renders the single <SettingsModal> and listens for this event, so any
 * component (sidebar, tool pages, …) can open it without prop-drilling.
 */
export const OPEN_SETTINGS_EVENT = storageKey("open-settings");

export function openSettings(section: SettingsSection = "local-ai"): void {
  if (typeof window !== "undefined") {
    window.dispatchEvent(new CustomEvent<SettingsSection>(OPEN_SETTINGS_EVENT, { detail: section }));
  }
}
