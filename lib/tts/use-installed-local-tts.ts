"use client";
import { useCallback, useEffect, useState } from "react";
import {
  LOCAL_TTS_CHANGED_EVENT, LOCAL_TTS_MODELS,
  installedLocalTtsModels, type LocalTtsModel,
} from "@/lib/tts/local-tts";

const NONE: Record<LocalTtsModel, boolean> = { kokoro: false, supertonic: false };

/**
 * Reactive map of which on-device voices are installed right now.
 *
 * A local engine (Kokoro / Supertonic) is only offered in the voice pickers once
 * it's installed in Settings → Local AI → Voice, so this drives their "ready" vs.
 * hidden state. It re-checks on the install event and on window focus, so
 * installing a voice makes it appear without a reload. Outside Tauri → all false.
 */
export function useInstalledLocalTts(): Record<LocalTtsModel, boolean> {
  const [installed, setInstalled] = useState<Record<LocalTtsModel, boolean>>(NONE);

  const refresh = useCallback(() => {
    void installedLocalTtsModels().then((next) => {
      // Only swap identity when a value actually changed.
      setInstalled((prev) =>
        LOCAL_TTS_MODELS.every((m) => prev[m] === next[m]) ? prev : next,
      );
    });
  }, []);

  useEffect(() => {
    refresh();
    window.addEventListener(LOCAL_TTS_CHANGED_EVENT, refresh);
    window.addEventListener("focus", refresh);
    return () => {
      window.removeEventListener(LOCAL_TTS_CHANGED_EVENT, refresh);
      window.removeEventListener("focus", refresh);
    };
  }, [refresh]);

  return installed;
}
