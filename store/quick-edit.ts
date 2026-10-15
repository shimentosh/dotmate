"use client";

import { create } from "zustand";
import { storageKey } from "@/brand.config";
import { logDebug, logWarn } from "@/lib/log";
import { toast, toastError, toastSuccess } from "@/lib/toast";
import { humanizeError } from "@/lib/error/app-error";
import { useActiveTasks } from "@/store/active-tasks";
import { useRenderJobs } from "@/store/render-jobs";
import {
  CANCELLED, cancelRender, onRenderProgress, pickVideos, probeVideo, renderVideo, stageMusic,
  type VideoInfo,
} from "@/lib/quick-edit-api";

/**
 * Quick Edit — the picked videos, the shared edit settings and the parallel render
 * queue. Module-level (zustand) on purpose, like Batch Clips: the queue lives
 * outside the page, so a 100-video batch keeps running — and keeps reporting to the
 * Render Dock — while the user visits other tools.
 */

export const QUICK_EDIT_HREF = "/tools/quick-edit";
const TASK_ID = "quick-edit-render";
const JOB_ID = "quick-edit";
const SETTINGS_KEY = storageKey("pref:quickEdit.settings");

export type VideoStatus = "probing" | "ready" | "error";
export type RenderStatus = "idle" | "queued" | "rendering" | "done" | "failed";

export interface QeVideo {
  id: string;
  path: string;
  name: string;
  size: number;
  status: VideoStatus;
  error?: string;
  info?: VideoInfo;
  /** Included in the next render. */
  checked: boolean;
  render: RenderStatus;
  /** 0..1 while rendering. */
  progress: number;
  outputPath?: string;
  renderError?: string;
}

export interface QeSettings {
  /** Percent: music 0–300, original audio 0–200. */
  musicVolume: number;
  originalVolume: number;
  /** Seconds. */
  musicOffset: number;
  fadeIn: number;
  fadeOut: number;
  /** Appended to each output's name. */
  suffix: string;
  /** Videos rendered at once. */
  parallel: number;
}

export const MAX_PARALLEL = 4;

/** Stream copy is mostly disk-bound, so a few at once pays off without starving the machine. */
function defaultParallel(): number {
  const cores = typeof navigator !== "undefined" ? navigator.hardwareConcurrency || 4 : 4;
  return Math.max(2, Math.min(MAX_PARALLEL - 1, Math.floor(cores / 4)));
}

const DEFAULT_SETTINGS: QeSettings = {
  musicVolume: 100,
  originalVolume: 100,
  musicOffset: 0,
  fadeIn: 1,
  fadeOut: 2,
  suffix: "_edit",
  parallel: 0, // 0 = not chosen yet → defaultParallel() on load
};

function loadSettings(): QeSettings {
  let saved: Partial<QeSettings> = {};
  try {
    const raw = localStorage.getItem(SETTINGS_KEY);
    if (raw) saved = JSON.parse(raw) as Partial<QeSettings>;
  } catch (e) { logDebug("quick-edit", "no saved settings", e); }
  const s = { ...DEFAULT_SETTINGS, ...saved };
  if (!s.parallel) s.parallel = defaultParallel();
  return s;
}

function saveSettings(s: QeSettings) {
  try { localStorage.setItem(SETTINGS_KEY, JSON.stringify(s)); } catch (e) { logDebug("quick-edit", "settings not saved", e); }
}

interface QuickEditStore {
  videos: QeVideo[];
  /** The video in the preview player. */
  activeId: string | null;
  music: File | null;
  /** Blob URL of `music` for the preview player. */
  musicUrl: string | null;
  settings: QeSettings;
  settingsLoaded: boolean;
  outputDir: string | null;
  running: boolean;
  stopping: boolean;

  loadSettings: () => void;
  importVideos: () => Promise<void>;
  removeVideo: (id: string) => void;
  clearVideos: () => void;
  setActive: (id: string) => void;
  toggleChecked: (id: string) => void;
  setAllChecked: (checked: boolean) => void;
  setMusic: (file: File | null) => void;
  setSetting: <K extends keyof QeSettings>(key: K, value: QeSettings[K]) => void;
  chooseOutputDir: () => Promise<string | null>;
  /** Render every checked video that isn't done yet. */
  start: () => Promise<void>;
  /** Mark finished videos as not rendered, then start. */
  renderAgain: () => Promise<void>;
  stop: () => void;
}

let seq = 0;
const newId = () => `qe_${Date.now().toString(36)}_${(seq++).toString(36)}`;

/** Render ids currently in flight — what Stop cancels. */
const inFlight = new Map<string, string>(); // videoId → render id

export const useQuickEdit = create<QuickEditStore>()((set, get) => {
  const patch = (id: string, p: Partial<QeVideo>) =>
    set((s) => ({ videos: s.videos.map((v) => (v.id === id ? { ...v, ...p } : v)) }));

  /** True when the current settings would change nothing in the output. */
  const isNoop = () => !get().music && get().settings.originalVolume === 100;

  return {
    videos: [],
    activeId: null,
    music: null,
    musicUrl: null,
    settings: DEFAULT_SETTINGS,
    settingsLoaded: false,
    outputDir: null,
    running: false,
    stopping: false,

    loadSettings: () => {
      if (!get().settingsLoaded) set({ settings: loadSettings(), settingsLoaded: true });
    },

    importVideos: async () => {
      const picked = await pickVideos();
      if (!picked.length) return;
      const known = new Set(get().videos.map((v) => v.path));
      const fresh: QeVideo[] = picked
        .filter((p) => !known.has(p.path))
        .map((p) => ({ id: newId(), ...p, status: "probing", checked: true, render: "idle", progress: 0 }));
      const skipped = picked.length - fresh.length;
      if (skipped) toast({ title: `${skipped} already in the list` });
      if (!fresh.length) return;
      set((s) => ({ videos: [...s.videos, ...fresh], activeId: s.activeId ?? fresh[0].id }));

      // Probe a few at a time — each is a short ffmpeg run.
      const queue = [...fresh];
      const worker = async () => {
        for (let v = queue.shift(); v; v = queue.shift()) {
          try {
            const info = await probeVideo(v.path);
            patch(v.id, { status: "ready", info });
          } catch (e) {
            logWarn("quick-edit", `probe failed for ${v.name}`, e);
            patch(v.id, { status: "error", checked: false, error: humanizeError(e) });
          }
        }
      };
      await Promise.all(Array.from({ length: 4 }, worker));
    },

    removeVideo: (id) => {
      if (inFlight.has(id)) return;
      set((s) => {
        const videos = s.videos.filter((v) => v.id !== id);
        const activeId = s.activeId === id ? (videos[0]?.id ?? null) : s.activeId;
        return { videos, activeId };
      });
    },

    clearVideos: () => {
      if (get().running) return;
      set({ videos: [], activeId: null });
    },

    setActive: (id) => set({ activeId: id }),

    toggleChecked: (id) =>
      set((s) => ({ videos: s.videos.map((v) => (v.id === id && v.status === "ready" ? { ...v, checked: !v.checked } : v)) })),

    setAllChecked: (checked) =>
      set((s) => ({ videos: s.videos.map((v) => (v.status === "ready" ? { ...v, checked } : v)) })),

    setMusic: (music) => {
      const old = get().musicUrl;
      if (old) URL.revokeObjectURL(old);
      set({ music, musicUrl: music ? URL.createObjectURL(music) : null });
    },

    setSetting: (key, value) => {
      const settings = { ...get().settings, [key]: value };
      set({ settings });
      saveSettings(settings);
    },

    chooseOutputDir: async () => {
      const { chooseDownloadDir } = await import("@/lib/native-download");
      const dir = await chooseDownloadDir();
      if (dir) set({ outputDir: dir });
      return dir;
    },

    renderAgain: async () => {
      set((s) => ({ videos: s.videos.map((v) => (v.checked && v.render === "done" ? { ...v, render: "idle", outputPath: undefined } : v)) }));
      await get().start();
    },

    stop: () => {
      if (!get().running) return;
      set({ stopping: true });
      for (const renderId of inFlight.values()) void cancelRender(renderId);
    },

    start: async () => {
      if (get().running) return;
      if (isNoop()) {
        toastError("Add background music or change the original volume first.", "Nothing to change");
        return;
      }
      const targets = get().videos.filter((v) => v.checked && v.status === "ready" && v.render !== "done");
      if (!targets.length) {
        toast({ title: "Every selected video is already rendered" });
        return;
      }
      const outputDir = get().outputDir ?? (await get().chooseOutputDir());
      if (!outputDir) return;

      set({ running: true, stopping: false });
      for (const v of targets) patch(v.id, { render: "queued", progress: 0, renderError: undefined });

      useActiveTasks.getState().begin({
        id: TASK_ID, label: "Quick Edit render", kind: "tools", keepsRunningOnNav: true,
        onAbort: () => get().stop(),
      });
      const rj = useRenderJobs.getState();
      rj.startJob({ id: JOB_ID, label: "Quick Edit", kind: "quick-edit", href: QUICK_EDIT_HREF, total: targets.length });

      const total = targets.length;
      let done = 0;
      let failed = 0;
      let haltMessage: string | null = null;
      const reportDock = () => {
        const live = get().videos.filter((v) => v.render === "rendering").reduce((n, v) => n + v.progress, 0);
        useRenderJobs.getState().setProgress(JOB_ID, ((done + failed + live) / total) * 100, {
          current: Math.min(total, done + failed + 1), total,
        });
      };

      let unlisten: (() => void) | null = null;
      try {
        // Music is shared by every render — stage it once.
        const { music, settings } = get();
        const musicPath = music ? await stageMusic(music) : null;

        unlisten = await onRenderProgress((renderId, progress) => {
          for (const [videoId, rid] of inFlight) {
            if (rid === renderId) { patch(videoId, { progress }); break; }
          }
          reportDock();
        });

        const queue = [...targets];
        const worker = async () => {
          for (let v = queue.shift(); v && !get().stopping && !haltMessage; v = queue.shift()) {
            const renderId = newId();
            inFlight.set(v.id, renderId);
            patch(v.id, { render: "rendering", progress: 0 });
            try {
              const outputPath = await renderVideo({
                id: renderId,
                input: v.path,
                outputDir,
                musicPath,
                musicVolume: settings.musicVolume / 100,
                originalVolume: settings.originalVolume / 100,
                musicOffset: settings.musicOffset,
                fadeIn: settings.fadeIn,
                fadeOut: settings.fadeOut,
                suffix: settings.suffix,
              });
              patch(v.id, { render: "done", progress: 1, outputPath });
              done++;
            } catch (e) {
              if (String(e) === CANCELLED) {
                patch(v.id, { render: "idle", progress: 0 });
              } else {
                const msg = humanizeError(e);
                logWarn("quick-edit", `render failed for ${v.name}`, e);
                patch(v.id, { render: "failed", progress: 0, renderError: msg });
                failed++;
                // Every following video would fail the same way — stop and say why.
                if (/disk space|permission/i.test(msg)) haltMessage = msg;
              }
            } finally {
              inFlight.delete(v.id);
              reportDock();
            }
          }
        };
        await Promise.all(Array.from({ length: Math.max(1, Math.min(MAX_PARALLEL, settings.parallel)) }, worker));
      } catch (e) {
        haltMessage = humanizeError(e);
        logWarn("quick-edit", "render batch failed", e);
      } finally {
        unlisten?.();
        const stopped = get().stopping;
        // Anything still queued didn't run.
        set((s) => ({
          running: false,
          stopping: false,
          videos: s.videos.map((v) => (v.render === "queued" || v.render === "rendering" ? { ...v, render: "idle", progress: 0 } : v)),
        }));
        useActiveTasks.getState().end(TASK_ID);

        const jobs = useRenderJobs.getState();
        const folder = outputDir.split(/[\\/]/).filter(Boolean).pop() ?? outputDir;
        if (haltMessage) {
          jobs.failJob(JOB_ID, haltMessage);
          toastError(haltMessage, "Render stopped");
        } else if (stopped) {
          jobs.cancelJob(JOB_ID);
          toast({ title: `Render stopped · ${done} saved` });
        } else {
          jobs.finishJob(JOB_ID, { label: `Quick Edit · ${done} video${done === 1 ? "" : "s"}`, outputPath: outputDir });
          if (failed) toastError(`${done} saved to “${folder}”, ${failed} failed. Render again to retry them.`, "Finished with errors");
          else toastSuccess(`${done} video${done === 1 ? "" : "s"} saved to “${folder}”.`, "Render complete");
        }
      }
    },
  };
});
