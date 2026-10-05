import { create } from "zustand";

/**
 * Global registry of long-running, **kill-on-navigation** tasks (transcription,
 * TTS, downloads, merges, renders, script generation…). Each running task
 * registers via `useRegisterTask` (hooks/use-register-task.ts); the in-app
 * navigation guard (GuardedLink / useGuardedRouter) reads `isBusyForNav()` and
 * warns before leaving a page that would terminate the work, and the window-close
 * guard (render-guard.tsx) reads `isBusyForClose()`.
 */
export interface ActiveTask {
  /** Stable per component instance (a `useId()` from the registration hook). */
  id: string;
  /** Human label shown in the warning modal, e.g. "Transcribing audio". */
  label: string;
  kind?: "editor" | "studio" | "tools";
  /**
   * Best-effort SAFE terminate, fired when the user chooses "Leave & stop":
   * set an abort ref, call `AbortController.abort()`, invoke a cancel command,
   * flip a cancel flag, etc. Omit when the work can't be cancelled — it then
   * just abandons on unmount.
   */
  onAbort?: () => void;
  /**
   * The work lives outside the page (a module-level runner) and survives in-app
   * navigation — only closing the window would kill it. Such tasks don't trigger
   * the "leave this page?" warning, but still trigger the window-close guard.
   */
  keepsRunningOnNav?: boolean;
}

interface ActiveTasksStore {
  tasks: ActiveTask[];
  /** Add or replace by id (a re-register with a fresh `onAbort`/`label` updates). */
  begin: (t: ActiveTask) => void;
  update: (id: string, patch: Partial<ActiveTask>) => void;
  end: (id: string) => void;
  /**
   * Fire `onAbort()` (try/catch) then clear. Window close aborts everything; "Leave &
   * stop" passes `{ navOnly: true }` so background work that survives navigation
   * (`keepsRunningOnNav`) keeps going.
   */
  abortAll: (opts?: { navOnly?: boolean }) => void;
}

export const useActiveTasks = create<ActiveTasksStore>()((set, get) => ({
  tasks: [],
  begin: (t) =>
    set((s) => ({ tasks: [...s.tasks.filter((x) => x.id !== t.id), t] })),
  update: (id, patch) =>
    set((s) => ({
      tasks: s.tasks.map((x) => (x.id === id ? { ...x, ...patch } : x)),
    })),
  end: (id) =>
    set((s) =>
      s.tasks.some((x) => x.id === id)
        ? { tasks: s.tasks.filter((x) => x.id !== id) }
        : s,
    ),
  abortAll: (opts) => {
    const hit = (t: ActiveTask) => !opts?.navOnly || !t.keepsRunningOnNav;
    for (const t of get().tasks.filter(hit)) {
      try {
        t.onAbort?.();
      } catch {
        /* best-effort cancel — never block the navigation */
      }
    }
    set((s) => ({ tasks: s.tasks.filter((t) => !hit(t)) }));
  },
}));

/** True when an IN-APP navigation would terminate running work. */
export function isBusyForNav(): boolean {
  return useActiveTasks.getState().tasks.some((t) => !t.keepsRunningOnNav);
}

/** True when closing the window (process exit) would kill work. */
export function isBusyForClose(): boolean {
  return useActiveTasks.getState().tasks.length > 0;
}

/** Deduped labels of the running tasks (shown in the nav warning). */
export function navTaskLabels(): string[] {
  return Array.from(new Set(useActiveTasks.getState().tasks.filter((t) => !t.keepsRunningOnNav).map((t) => t.label)));
}

/** Deduped labels of everything a window close would kill. Used by the window-close guard. */
export function activeTaskLabels(): string[] {
  return Array.from(new Set(useActiveTasks.getState().tasks.map((t) => t.label)));
}
