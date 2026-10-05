"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";
import { AlertTriangle, X, LogOut, Clock } from "lucide-react";
import {
  useActiveTasks,
  isBusyForNav,
  navTaskLabels,
} from "@/store/active-tasks";

/**
 * App-wide guard that warns before a navigation would terminate a running task.
 *
 *   const { confirmLeave } = useNavGuard();
 *   if (isBusyForNav() && !(await confirmLeave())) return;   // user chose Stay
 *   router.push(href);                                        // user chose Leave
 *
 * `confirmLeave()` resolves immediately to `true` when nothing is running (fast
 * path → zero false prompts). Otherwise it opens a single, portal-rendered modal
 * listing the running tasks and resolves `true` (Leave & stop — fires every
 * task's `onAbort` via the registry) or `false` (Stay). Used by `GuardedLink`
 * and `useGuardedRouter`; the render-guard handles the window-close path.
 */
interface NavGuardApi {
  confirmLeave: () => Promise<boolean>;
}

const Ctx = createContext<NavGuardApi | null>(null);

/**
 * Is the current theme dark? The editor doesn't use Tailwind's `.dark` class —
 * it applies a custom theme (`editor-starter`) via a class + `data-theme`, so a
 * portalled modal that relies on `dark:` variants would render light over the
 * dark editor. Every theme sets the `--background` CSS var, so we resolve it and
 * judge by luminance — generic across the global `.dark` theme, the editor
 * theme, and any future one. The result is force-applied as a `dark` class on
 * the modal root so its `dark:` utilities resolve correctly.
 */
function isDarkTheme(): boolean {
  if (typeof window === "undefined") return false;
  const root = document.documentElement;
  try {
    const bg = getComputedStyle(root).getPropertyValue("--background").trim();
    if (!bg) return root.classList.contains("dark");
    let r = 0, g = 0, b = 0;
    if (bg.startsWith("#")) {
      const h = bg.slice(1);
      const full = h.length === 3 ? h.split("").map((c) => c + c).join("") : h;
      r = parseInt(full.slice(0, 2), 16);
      g = parseInt(full.slice(2, 4), 16);
      b = parseInt(full.slice(4, 6), 16);
    } else {
      const m = bg.match(/\d+(\.\d+)?/g);
      if (m && m.length >= 3) [r, g, b] = m.map(Number);
    }
    return (0.299 * r + 0.587 * g + 0.114 * b) / 255 < 0.5;
  } catch {
    return root.classList.contains("dark");
  }
}

export function useNavGuard(): NavGuardApi {
  const v = useContext(Ctx);
  if (!v) throw new Error("useNavGuard must be used within NavGuardProvider");
  return v;
}

export function NavGuardProvider({ children }: { children: React.ReactNode }) {
  const [open, setOpen] = useState(false);
  const [labels, setLabels] = useState<string[]>([]);
  const resolveRef = useRef<((leave: boolean) => void) | null>(null);

  const settle = useCallback((leave: boolean) => {
    const resolve = resolveRef.current;
    resolveRef.current = null;
    setOpen(false);
    resolve?.(leave);
  }, []);

  const confirmLeave = useCallback((): Promise<boolean> => {
    if (!isBusyForNav()) return Promise.resolve(true);
    setLabels(navTaskLabels());
    setOpen(true);
    return new Promise<boolean>((resolve) => {
      resolveRef.current = resolve;
    });
  }, []);

  // If every task finishes while the modal is open, there's nothing left to
  // lose → let the navigation proceed automatically. (Renders don't count for
  // navigation, so only the task registry can flip `isBusyForNav`.)
  useEffect(() => {
    if (!open) return;
    const check = () => {
      if (!isBusyForNav()) settle(true);
    };
    return useActiveTasks.subscribe(check);
  }, [open, settle]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") settle(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, settle]);

  function leaveAndStop() {
    // Safe-terminate every task the navigation would kill (background work that
    // survives navigation keeps running).
    useActiveTasks.getState().abortAll({ navOnly: true });
    settle(true);
  }

  const modal =
    open && typeof document !== "undefined"
      ? createPortal(
          <div
            className={`fixed inset-below-titlebar z-[99999] flex items-center justify-center p-4 ${isDarkTheme() ? "dark" : ""}`}
            style={{ background: "rgba(0,0,0,0.75)", backdropFilter: "blur(12px)" }}
            onClick={(e) => {
              if (e.target === e.currentTarget) settle(false);
            }}
          >
            <div className="relative w-full max-w-md rounded-2xl overflow-hidden border border-zinc-200 dark:border-white/10 bg-white dark:bg-zinc-900/85 dark:backdrop-blur-2xl shadow-2xl dark:shadow-[0_24px_70px_rgba(0,0,0,0.6)]">
              {/* Dismiss = stay on the page (keep running) */}
              <button
                onClick={() => settle(false)}
                aria-label="Stay on this page"
                className="absolute top-3.5 right-3.5 z-10 p-1.5 rounded-lg bg-zinc-100 dark:bg-white/5 hover:bg-zinc-200 dark:hover:bg-white/10 transition-colors border-none cursor-pointer"
              >
                <X size={14} className="text-zinc-500 dark:text-zinc-400" />
              </button>

              <div className="p-7">
                {/* Icon — subtle amber glass tile (no loud gradient) */}
                <div className="flex justify-center mb-5">
                  <div className="flex items-center justify-center w-14 h-14 rounded-2xl bg-amber-500/10 border border-amber-500/20 shadow-[0_0_36px_rgba(245,158,11,0.15)]">
                    <AlertTriangle size={26} className="text-amber-500 dark:text-amber-400" strokeWidth={1.75} />
                  </div>
                </div>

                {/* Badge — subtle glass pill */}
                <div className="flex justify-center mb-3">
                  <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-[10px] font-semibold uppercase tracking-wider text-amber-700 dark:text-amber-300 bg-amber-500/10 border border-amber-500/20">
                    <span className="w-1 h-1 rounded-full bg-amber-500 dark:bg-amber-400 animate-pulse" />
                    {labels.length > 1 ? "Tasks in progress" : "Task in progress"}
                  </span>
                </div>

                <h2 className="text-[19px] font-bold text-zinc-900 dark:text-white text-center leading-tight mb-2">
                  {labels.length > 1 ? "Tasks are still running" : "A task is still running"}
                </h2>
                <p className="text-[13px] text-zinc-500 dark:text-zinc-400 text-center leading-relaxed mb-5">
                  Leaving this page will stop the work below and you&apos;ll lose its
                  progress. Stay to let it finish, or leave and stop it now.
                </p>

                {/* Running tasks list */}
                <ul className="mb-5 space-y-1.5">
                  {labels.map((l) => (
                    <li
                      key={l}
                      className="flex items-center gap-2.5 px-3.5 py-2.5 rounded-xl bg-zinc-50 dark:bg-white/[0.04] border border-zinc-200/70 dark:border-white/[0.07]"
                    >
                      <span className="w-1.5 h-1.5 rounded-full bg-amber-500 dark:bg-amber-400 shrink-0 animate-pulse" />
                      <span className="text-[13px] font-medium text-zinc-700 dark:text-zinc-200 truncate">
                        {l}
                      </span>
                    </li>
                  ))}
                </ul>

                {/* Actions — brand-violet glass primary (safe) + red glass destructive */}
                <div className="flex flex-col gap-2">
                  {/* Safe, recommended action — visually primary (Esc + the X also stay) */}
                  <button
                    onClick={() => settle(false)}
                    className="w-full h-11 rounded-xl text-[13.5px] font-semibold text-violet-700 dark:text-white flex items-center justify-center gap-2 cursor-pointer border border-violet-500/25 dark:border-violet-400/30 bg-violet-500/10 dark:bg-violet-500/25 dark:backdrop-blur-md transition-colors hover:bg-violet-500/20 dark:hover:bg-violet-500/35"
                  >
                    <Clock size={16} />
                    Stay on this page
                  </button>
                  {/* Destructive action — de-emphasised, in the app's red danger language */}
                  <button
                    onClick={leaveAndStop}
                    className="w-full h-10 rounded-xl text-[13px] font-medium text-red-600 dark:text-red-300 flex items-center justify-center gap-2 cursor-pointer border border-red-500/20 bg-red-500/10 dark:backdrop-blur-md transition-colors hover:bg-red-500/20"
                  >
                    <LogOut size={15} />
                    {labels.length > 1 ? "Leave & stop tasks" : "Leave & stop task"}
                  </button>
                </div>
              </div>
            </div>
          </div>,
          document.body,
        )
      : null;

  return (
    <Ctx.Provider value={{ confirmLeave }}>
      {children}
      {modal}
    </Ctx.Provider>
  );
}
