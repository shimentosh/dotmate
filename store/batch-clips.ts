"use client";

import { create } from "zustand";
import { logDebug, logWarn } from "@/lib/log";
import { toast, toastError, toastSuccess } from "@/lib/toast";
import { useActiveTasks } from "@/store/active-tasks";
import { useRenderJobs } from "@/store/render-jobs";
import { DEFAULT_CLIP_SECONDS, cleanPrefix, clipFileName, roundMs, targetVideoBitrate, uniqueFileName } from "@/lib/dotmate/format";
import { classifyError, closeSource, openSource, renderClip, type OpenedSource } from "@/lib/dotmate/export-engine";
import { folderSink, pickOutputFolder, type ClipSink } from "@/lib/dotmate/output";
import { loadSession, saveSession, type PersistedSession } from "@/lib/dotmate/persist";
import { ensurePermission, isVideoFile, probeVideo, type ImportItem } from "@/lib/dotmate/sources";

/**
 * Batch Clips — sources, the clip queue and the batch export runner.
 *
 * Module-level (zustand) on purpose: the export loop and its state live outside the
 * page, so a 500-clip export keeps running — and keeps reporting to the Render
 * Dock — while the user visits other tools. The session (clip times, order, default
 * length, prefix, file/folder handles) is saved to IndexedDB so it survives a restart.
 */

export const BATCH_CLIPS_HREF = "/tools/quick-trim";
const SESSION_KEY = "intro-batch"; // original key — keeps saved sessions
const TASK_ID = "dotmate-intro-batch-export";
const JOB_ID = "dotmate-intro-batch";

export type SourceStatus = "loading" | "ready" | "missing" | "error";

export interface DmSource {
  id: string;
  name: string;
  size: number;
  lastModified: number;
  duration: number | null;
  width: number;
  height: number;
  status: SourceStatus;
  error?: string;
  /** In-memory only. A File is a reference to the file on disk — never a copy. */
  file?: File;
  handle?: FileSystemFileHandle;
}

export type ClipStatus = "waiting" | "preparing" | "rendering" | "completed" | "failed";

export interface DmClip {
  id: string;
  sourceId: string;
  start: number;
  end: number;
  status: ClipStatus;
  error?: string;
  outputName?: string;
}

export interface ExportState {
  running: boolean;
  stopping: boolean;
  currentClipId: string | null;
  /** 0..1 progress of the clip being rendered. */
  progress: number;
}

export interface ImportSummary { added: number; relinked: number; skipped: number; rejected: string[] }

export type AddClipResult = { ok: true; number: number } | { ok: false; reason: "duplicate" | "invalid" };

export type UpdateClipResult = { ok: true } | { ok: false; reason: "locked" | "duplicate" | "invalid" };

interface IntroBatchState {
  hydrated: boolean;
  sources: DmSource[];
  clips: DmClip[];
  selectedSourceId: string | null;
  defaultDuration: number;
  prefix: string;
  outputLabel: string | null;
  exp: ExportState;

  hydrate: () => Promise<void>;
  importFiles: (items: ImportItem[]) => Promise<ImportSummary>;
  removeSource: (id: string) => void;
  selectSource: (id: string) => void;
  reconnectSources: () => Promise<number>;

  addClip: (sourceId: string, start: number, end: number) => AddClipResult;
  /** Change an added clip's in/out points. A finished clip goes back to "waiting". */
  updateClip: (id: string, start: number, end: number) => UpdateClipResult;
  removeClip: (id: string) => void;
  moveClip: (id: string, toIndex: number) => void;
  clearClips: () => void;
  setDefaultDuration: (sec: number) => void;
  setPrefix: (prefix: string) => void;

  chooseOutputFolder: () => Promise<boolean>;
  startExport: () => Promise<void>;
  stopExport: () => void;
  /** Mark finished clips as waiting again so Export All renders them once more. */
  resetCompleted: () => void;
}

/* ─── Module-level runtime (not React state) ──────────────────────────────── */

let sink: ClipSink | null = null;
let outDirHandle: FileSystemDirectoryHandle | null = null;
let abortCtl: AbortController | null = null;
let hydrating: Promise<void> | null = null;
let saveTimer: ReturnType<typeof setTimeout> | null = null;

const uid = () => (typeof crypto !== "undefined" && "randomUUID" in crypto
  ? crypto.randomUUID()
  : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`);

const IDLE: ExportState = { running: false, stopping: false, currentClipId: null, progress: 0 };

export const useBatchClips = create<IntroBatchState>()((set, get) => {
  const patchClip = (id: string, patch: Partial<DmClip>) =>
    set((s) => ({ clips: s.clips.map((c) => (c.id === id ? { ...c, ...patch } : c)) }));
  const patchSource = (id: string, patch: Partial<DmSource>) =>
    set((s) => ({ sources: s.sources.map((x) => (x.id === id ? { ...x, ...patch } : x)) }));

  async function loadMeta(ids: string[]) {
    for (const id of ids) {
      const src = get().sources.find((s) => s.id === id);
      if (!src?.file) continue;
      try {
        const meta = await probeVideo(src.file);
        patchSource(id, { status: "ready", duration: meta.duration, width: meta.width, height: meta.height, error: undefined });
      } catch (e) {
        patchSource(id, { status: "error", error: e instanceof Error ? e.message : "Unsupported or damaged video" });
      }
    }
  }

  return {
    hydrated: false,
    sources: [],
    clips: [],
    selectedSourceId: null,
    defaultDuration: DEFAULT_CLIP_SECONDS,
    prefix: "clip",
    outputLabel: null,
    exp: IDLE,

    hydrate: () => {
      if (get().hydrated) return Promise.resolve();
      hydrating ??= (async () => {
        const saved = await loadSession(SESSION_KEY);
        if (saved) {
          const sources = await Promise.all(saved.sources.map(async (p): Promise<DmSource> => {
            let file: File | undefined;
            // Reopen silently when the browser still remembers the permission.
            if (p.handle && (await ensurePermission(p.handle, "read", false))) {
              try {
                const f = await p.handle.getFile();
                if (f.size === p.size) file = f;
              } catch (e) { logDebug("dotmate", `${p.name} moved or deleted — stays missing`, e); }
            }
            return { ...p, file, status: file ? "ready" : "missing" };
          }));
          outDirHandle = saved.outDir ?? null;
          sink = null; // re-verified (permission) when the next export starts
          set({
            sources,
            clips: saved.clips.map((c) => ({ ...c })),
            selectedSourceId: saved.selectedSourceId,
            defaultDuration: saved.defaultDuration || DEFAULT_CLIP_SECONDS,
            prefix: saved.prefix || "clip",
            outputLabel: outDirHandle?.name ?? null,
          });
        }
        set({ hydrated: true });
        useBatchClips.subscribe((s, prev) => {
          if (s.sources !== prev.sources || s.clips !== prev.clips || s.selectedSourceId !== prev.selectedSourceId
            || s.defaultDuration !== prev.defaultDuration || s.prefix !== prev.prefix || s.outputLabel !== prev.outputLabel) {
            scheduleSave();
          }
        });
      })();
      return hydrating;
    },

    importFiles: async (items) => {
      const summary: ImportSummary = { added: 0, relinked: 0, skipped: 0, rejected: [] };
      const fresh: DmSource[] = [];
      const relinkedIds: string[] = [];
      let sources = [...get().sources];

      for (const { file, handle } of items) {
        if (!isVideoFile(file)) { summary.rejected.push(file.name); continue; }
        const same = sources.find((s) => s.name === file.name && s.size === file.size);
        if (same && same.file) { summary.skipped++; continue; }
        if (same) {
          // A source from an earlier session whose file was disconnected — relink it.
          sources = sources.map((s) => (s.id === same.id
            ? { ...s, file, handle: handle ?? s.handle, status: s.duration ? "ready" : "loading", error: undefined } : s));
          if (!same.duration) relinkedIds.push(same.id);
          summary.relinked++;
          continue;
        }
        const src: DmSource = {
          id: uid(), name: file.name, size: file.size, lastModified: file.lastModified,
          duration: null, width: 0, height: 0, status: "loading", file, handle,
        };
        sources.push(src);
        fresh.push(src);
        summary.added++;
      }

      set((s) => ({
        sources,
        selectedSourceId: s.selectedSourceId && sources.some((x) => x.id === s.selectedSourceId)
          ? s.selectedSourceId
          : (fresh[0]?.id ?? sources[0]?.id ?? null),
      }));
      await loadMeta([...fresh.map((s) => s.id), ...relinkedIds]);
      return summary;
    },

    removeSource: (id) => {
      const { exp } = get();
      if (exp.running && get().clips.some((c) => c.sourceId === id && c.id === exp.currentClipId)) return;
      set((s) => {
        const sources = s.sources.filter((x) => x.id !== id);
        return {
          sources,
          clips: s.clips.filter((c) => c.sourceId !== id),
          selectedSourceId: s.selectedSourceId === id ? (sources[0]?.id ?? null) : s.selectedSourceId,
        };
      });
    },

    selectSource: (id) => set({ selectedSourceId: id }),

    reconnectSources: async () => {
      let n = 0;
      for (const s of get().sources) {
        if (s.status !== "missing" || !s.handle) continue;
        if (!(await ensurePermission(s.handle, "read", true))) continue;
        try {
          const file = await s.handle.getFile();
          patchSource(s.id, { file, status: "ready", size: file.size, error: undefined });
          n++;
        } catch (e) {
          logWarn("dotmate", `could not reopen ${s.name}`, e);
        }
      }
      return n;
    },

    addClip: (sourceId, start, end) => {
      const src = get().sources.find((s) => s.id === sourceId);
      if (!src || !src.duration || end - start <= 0) return { ok: false, reason: "invalid" };
      const s0 = roundMs(start), e0 = roundMs(end);
      const dup = get().clips.some((c) => c.sourceId === sourceId && Math.abs(c.start - s0) < 0.01 && Math.abs(c.end - e0) < 0.01);
      if (dup) return { ok: false, reason: "duplicate" };
      const clip: DmClip = { id: uid(), sourceId, start: s0, end: e0, status: "waiting" };
      set((s) => ({ clips: [...s.clips, clip] }));
      return { ok: true, number: get().clips.length };
    },

    updateClip: (id, start, end) => {
      const clip = get().clips.find((c) => c.id === id);
      if (!clip) return { ok: false, reason: "invalid" };
      if (clip.status === "rendering" || clip.status === "preparing") return { ok: false, reason: "locked" };
      const src = get().sources.find((s) => s.id === clip.sourceId);
      const s0 = roundMs(Math.max(0, start));
      const e0 = roundMs(Math.min(end, src?.duration ?? end));
      if (e0 - s0 <= 0) return { ok: false, reason: "invalid" };
      if (s0 === clip.start && e0 === clip.end) return { ok: true };
      const dup = get().clips.some((c) => c.id !== id && c.sourceId === clip.sourceId
        && Math.abs(c.start - s0) < 0.01 && Math.abs(c.end - e0) < 0.01);
      if (dup) return { ok: false, reason: "duplicate" };
      // Edited after export → the file on disk no longer matches; export it again.
      patchClip(id, clip.status === "completed" || clip.status === "failed"
        ? { start: s0, end: e0, status: "waiting", outputName: undefined, error: undefined }
        : { start: s0, end: e0 });
      return { ok: true };
    },

    removeClip: (id) => {
      if (get().exp.currentClipId === id) return;
      set((s) => ({ clips: s.clips.filter((c) => c.id !== id) }));
    },

    moveClip: (id, toIndex) => set((s) => {
      const from = s.clips.findIndex((c) => c.id === id);
      if (from < 0) return s;
      const clips = [...s.clips];
      const [c] = clips.splice(from, 1);
      clips.splice(Math.max(0, Math.min(clips.length, toIndex)), 0, c);
      return { clips };
    }),

    clearClips: () => {
      if (get().exp.running) return;
      set({ clips: [] });
    },

    setDefaultDuration: (sec) => {
      if (!Number.isFinite(sec)) return;
      set({ defaultDuration: Math.min(600, Math.max(0.1, roundMs(sec))) });
    },

    setPrefix: (prefix) => set({ prefix }),

    chooseOutputFolder: async () => {
      const picked = await pickOutputFolder();
      if (!picked) return false;
      sink = picked.sink;
      outDirHandle = picked.handle ?? null;
      set({ outputLabel: picked.sink.label });
      return true;
    },

    startExport: async () => {
      if (get().exp.running) return;
      if (!get().clips.some((c) => c.status !== "completed")) return;

      // Re-verify the remembered folder inside this click (permission prompts need
      // a user gesture), otherwise ask for one.
      if (!sink && outDirHandle) {
        if (await ensurePermission(outDirHandle, "readwrite", true)) sink = folderSink(outDirHandle);
      }
      if (!sink && !(await get().chooseOutputFolder())) return;
      await runExport();
    },

    stopExport: () => {
      if (!get().exp.running) return;
      set((s) => ({ exp: { ...s.exp, stopping: true } }));
      abortCtl?.abort();
    },

    resetCompleted: () => {
      if (get().exp.running) return;
      set((s) => ({ clips: s.clips.map((c) => (c.status === "completed" ? { ...c, status: "waiting", outputName: undefined } : c)) }));
    },
  };

  /* ─── Batch runner ──────────────────────────────────────────────────────── */

  async function runExport() {
    const out = sink;
    if (!out) return;
    abortCtl = new AbortController();
    const signal = abortCtl.signal;
    set({ exp: { running: true, stopping: false, currentClipId: null, progress: 0 } });

    // Background work: the window-close guard warns, in-app navigation doesn't.
    useActiveTasks.getState().begin({
      id: TASK_ID, label: "Batch Clips export", kind: "tools", keepsRunningOnNav: true,
      onAbort: () => abortCtl?.abort(),
    });
    const jobs = useRenderJobs.getState();
    jobs.startJob({ id: JOB_ID, label: "Batch Clips", kind: "dotmate", href: BATCH_CLIPS_HREF });

    const attempted = new Set<string>();
    const opened = new Map<string, OpenedSource>();
    let done = 0;
    let failed = 0;
    let haltMessage: string | null = null;
    let lastTick = 0;

    try {
      while (!signal.aborted) {
        // Pick the next clip each round, so clips added (or removed) during the
        // export are honoured. Earlier failures are retried once per run.
        const clip = get().clips.find((c) => (c.status === "waiting" || c.status === "failed") && !attempted.has(c.id));
        if (!clip) break;
        attempted.add(clip.id);

        const all = get().clips;
        const position = all.findIndex((c) => c.id === clip.id) + 1;
        const remaining = all.filter((c) => !attempted.has(c.id) && c.status !== "completed").length;
        const total = attempted.size + remaining;
        useRenderJobs.getState().setProgress(JOB_ID, ((attempted.size - 1) / total) * 100, { current: attempted.size, total });

        patchClip(clip.id, { status: "preparing", error: undefined });
        set((s) => ({ exp: { ...s.exp, currentClipId: clip.id, progress: 0 } }));

        const src = get().sources.find((s) => s.id === clip.sourceId);
        if (!src?.file) {
          patchClip(clip.id, { status: "failed", error: "Source video isn't connected — re-import it, then export again." });
          failed++;
          continue;
        }

        let opened_: OpenedSource | undefined;
        try {
          opened_ = opened.get(src.id);
          if (!opened_) {
            // Keep one source open at a time — queues are usually grouped by video.
            for (const o of opened.values()) closeSource(o);
            opened.clear();
            opened_ = await openSource(src.file);
            opened.set(src.id, opened_);
          }

          const name = await uniqueFileName(clipFileName(get().prefix, position, Math.max(all.length, total)), (n) => out.exists(n));
          const w = opened_.video?.codedWidth ?? src.width;
          const h = opened_.video?.codedHeight ?? src.height;
          const estBytes = ((targetVideoBitrate(w, h, opened_.fps) + 256_000) / 8) * (clip.end - clip.start) * 1.2;
          const file = await out.open(name, estBytes);
          patchClip(clip.id, { status: "rendering", outputName: name });
          try {
            await renderClip({
              source: opened_,
              start: clip.start,
              end: Math.min(clip.end, src.duration ?? clip.end),
              target: file.target,
              fastStartInMemory: file.fastStartInMemory,
              signal,
              onProgress: (p) => {
                const now = performance.now();
                if (now - lastTick < 100 && p < 1) return;
                lastTick = now;
                set((s) => ({ exp: { ...s.exp, progress: p } }));
                useRenderJobs.getState().setProgress(JOB_ID, ((attempted.size - 1 + p) / total) * 100);
              },
            });
            await file.commit();
          } catch (err) {
            await file.discard();
            throw err;
          }
          patchClip(clip.id, { status: "completed", error: undefined });
          done++;
        } catch (err) {
          const e = classifyError(err);
          if (e.kind === "cancelled") {
            patchClip(clip.id, { status: "waiting", outputName: undefined });
            break;
          }
          logWarn("dotmate", `clip ${position} (${src.name} ${clip.start}-${clip.end}) failed`, err);
          patchClip(clip.id, { status: "failed", error: e.userMessage, outputName: undefined });
          failed++;
          if (e.kind === "source-unreadable") {
            for (const o of opened.values()) closeSource(o);
            opened.clear();
            patchSource(src.id, { file: undefined, status: "missing" });
          }
          if (e.kind === "disk-full" || e.kind === "no-permission") {
            // Every following clip would fail the same way — stop and say why.
            haltMessage = e.userMessage;
            if (e.kind === "no-permission") sink = null;
            break;
          }
        }
        // Let the UI breathe between clips.
        await new Promise((r) => setTimeout(r, 0));
      }
    } finally {
      for (const o of opened.values()) closeSource(o);
      const stopped = signal.aborted;
      abortCtl = null;
      set({ exp: IDLE });
      useActiveTasks.getState().end(TASK_ID);

      const rj = useRenderJobs.getState();
      if (haltMessage) rj.failJob(JOB_ID, haltMessage);
      else if (stopped) rj.cancelJob(JOB_ID);
      else rj.finishJob(JOB_ID, { label: `Batch Clips · ${done} clip${done === 1 ? "" : "s"} exported` });

      const where = out.label ? ` to “${out.label}”` : "";
      if (haltMessage) toastError(haltMessage, "Export stopped");
      else if (stopped) toast({ title: `Export stopped · ${done} exported` });
      else if (failed > 0) toastError(`${done} exported${where}, ${failed} failed. Fix or retry the failed clips.`, "Export finished with errors");
      else if (done > 0) toastSuccess(`${done} clip${done === 1 ? "" : "s"} exported${where}.`, "Export complete");
    }
  }
});

/* ─── Persistence ─────────────────────────────────────────────────────────── */

function scheduleSave() {
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    saveTimer = null;
    const s = useBatchClips.getState();
    const session: PersistedSession = {
      v: 1,
      sources: s.sources.map(({ id, name, size, lastModified, duration, width, height, handle }) =>
        ({ id, name, size, lastModified, duration, width, height, handle })),
      // An in-flight clip resumes as waiting next session.
      clips: s.clips.map(({ id, sourceId, start, end, status, error, outputName }) => ({
        id, sourceId, start, end, error, outputName,
        status: status === "completed" || status === "failed" ? status : "waiting",
      })),
      selectedSourceId: s.selectedSourceId,
      defaultDuration: s.defaultDuration,
      prefix: cleanPrefix(s.prefix),
      outDir: outDirHandle ?? undefined,
    };
    void saveSession(SESSION_KEY, session);
  }, 400);
}
