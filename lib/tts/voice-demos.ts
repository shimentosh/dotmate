/**
 * Bundled voice-preview demo clips.
 *
 * Every on-device voice ships a short, pre-rendered sample at
 * `public/voice-demos/<provider>/<id>.mp3`. Because `public/` is copied into the
 * static export bundled in the installer, these clips ship with the app and are
 * served at `/voice-demos/...` — offline and instant.
 *
 * The voice pickers play the bundled clip instead of synthesizing on every click
 * (which can trigger a model download the first time). A voice with no bundled
 * demo falls back to on-device synthesis.
 *
 * `manifest.json` maps `provider -> { voiceId -> relative path }` using the EXACT
 * voiceId the UI sends to the engine, so lookups never need slug logic here.
 */
import { useEffect, useState } from "react";

export type VoiceDemoManifest = Record<string, Record<string, string>>;

let cache: VoiceDemoManifest | null = null;
let inflight: Promise<VoiceDemoManifest> | null = null;

/** Load (and memoise) the bundled voice-demo manifest. Never rejects — a missing
 *  or malformed manifest resolves to `{}` so callers just fall back to synthesis. */
export function loadVoiceDemos(): Promise<VoiceDemoManifest> {
  if (cache) return Promise.resolve(cache);
  if (!inflight) {
    inflight = fetch("/voice-demos/manifest.json")
      .then((r) => (r.ok ? r.json() : {}))
      .catch(() => ({}))
      .then((m: VoiceDemoManifest) => (cache = m && typeof m === "object" ? m : {}));
  }
  return inflight;
}

/** The bundled demo URL for a (provider, voiceId), or null if none was rendered. */
export function voiceDemoUrl(
  manifest: VoiceDemoManifest | null,
  provider: string,
  voiceId: string,
): string | null {
  const rel = manifest?.[provider]?.[voiceId];
  return rel ? `/voice-demos/${rel}` : null;
}

/** React hook: the bundled voice-demo manifest (null until loaded). Shares the
 *  one module-level fetch across every picker. */
export function useVoiceDemos(): VoiceDemoManifest | null {
  const [manifest, setManifest] = useState<VoiceDemoManifest | null>(cache);
  useEffect(() => {
    let alive = true;
    void loadVoiceDemos().then((m) => { if (alive) setManifest(m); });
    return () => { alive = false; };
  }, []);
  return manifest;
}
