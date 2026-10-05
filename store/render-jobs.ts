import { create } from "zustand";

/**
 * Global render-JOB registry — the data behind the floating Render Dock
 * (components/render-dock.tsx). Pages that kick off a long render (editor export,
 * Voice-to-Video, carousel/image-to-video, bulk-voice) register a job here and
 * push progress into it. Because this is a module-level store, the job state lives
 * OUTSIDE any page component — so the dock keeps showing progress (and the finished
 * result + actions) even after the user navigates away from the page that started
 * it. The render work itself is a Tauri/Rust process or a detached async loop that
 * already survives unmount; this just makes it visible app-wide.
 *
 * NOTE: distinct from `useRenderActivity` (store/render.ts), which only counts
 * active renders for the window-close guard. This adds the user-facing job list.
 */
export type RenderJobStatus = "running" | "done" | "error" | "cancelled";

export interface RenderJob {
  id: string;
  /** Shown in the dock (project / video title). */
  label: string;
  /** Source surface — drives the icon + grouping ("editor", "voice-to-video", …). */
  kind: string;
  status: RenderJobStatus;
  /** 0..100 */
  progress: number;
  /** Optional sub-count for batch renders, e.g. "video 2 of 5". */
  current?: number;
  total?: number;
  /** Output file path (desktop) — enables Open / Show-in-folder on a finished job. */
  outputPath?: string;
  /** In-app route to jump back to the page that started the render. */
  href?: string;
  error?: string;
  startedAt: number;
  endedAt?: number;
}

interface RenderJobsStore {
  jobs: RenderJob[];
  /** Register (or reset) a running job; returns its id. */
  startJob: (j: { id?: string; label: string; kind: string; href?: string; total?: number }) => string;
  /** Update progress (0..100) and optional batch sub-count of a running job. */
  setProgress: (id: string, progress: number, sub?: { current?: number; total?: number }) => void;
  /** Mark a job finished successfully (optionally attach the output path). */
  finishJob: (id: string, patch?: { outputPath?: string; label?: string }) => void;
  /** Mark a job failed. */
  failJob: (id: string, error: string) => void;
  /** Mark a running job cancelled (user pressed Cancel). */
  cancelJob: (id: string) => void;
  /** Remove a single job from the dock. */
  removeJob: (id: string) => void;
  /** Remove all non-running (done / error / cancelled) jobs. */
  clearDone: () => void;
}

let _seq = 0;
function newId(): string { _seq += 1; return `rj_${_seq}_${Math.random().toString(36).slice(2, 8)}`; }
function now(): number { return typeof performance !== "undefined" ? Date.now() : 0; }

export const useRenderJobs = create<RenderJobsStore>()((set) => ({
  jobs: [],
  startJob: ({ id, label, kind, href, total }) => {
    const jid = id ?? newId();
    const job: RenderJob = {
      id: jid, label, kind, href, total,
      status: "running", progress: 0, startedAt: now(),
    };
    set((s) => ({
      jobs: s.jobs.some((j) => j.id === jid)
        ? s.jobs.map((j) => (j.id === jid ? job : j))
        : [job, ...s.jobs],
    }));
    return jid;
  },
  setProgress: (id, progress, sub) =>
    set((s) => ({
      jobs: s.jobs.map((j) =>
        j.id === id && j.status === "running"
          ? { ...j, progress: Math.max(0, Math.min(100, Math.round(progress))), ...(sub ?? {}) }
          : j,
      ),
    })),
  finishJob: (id, patch) =>
    set((s) => ({
      jobs: s.jobs.map((j) =>
        j.id === id ? { ...j, status: "done", progress: 100, endedAt: now(), ...(patch ?? {}) } : j,
      ),
    })),
  failJob: (id, error) =>
    set((s) => ({
      jobs: s.jobs.map((j) => (j.id === id ? { ...j, status: "error", error, endedAt: now() } : j)),
    })),
  cancelJob: (id) =>
    set((s) => ({
      jobs: s.jobs.map((j) =>
        j.id === id && j.status === "running" ? { ...j, status: "cancelled", endedAt: now() } : j,
      ),
    })),
  removeJob: (id) => set((s) => ({ jobs: s.jobs.filter((j) => j.id !== id) })),
  clearDone: () => set((s) => ({ jobs: s.jobs.filter((j) => j.status === "running") })),
}));
