"use client";

import { useEffect, useId, useRef } from "react";
import { useActiveTasks } from "@/store/active-tasks";

export interface RegisterTaskMeta {
  /** Human label shown in the "leave?" warning modal, e.g. "Bulk Voice". */
  label: string;
  kind?: "editor" | "studio" | "tools";
  /** Best-effort safe cancel fired on "Leave & stop" (abortRef / abort() / stop_download / flag). */
  onAbort?: () => void;
}

/**
 * Register a long-running, **kill-on-navigation** task in the global registry
 * (`store/active-tasks.ts`) while `running` is true. One line per task site:
 *
 *   useRegisterTask(generating, {
 *     label: "Bulk Voice", kind: "tools",
 *     onAbort: () => { cancelRef.current = true },
 *   });
 *
 * The navigation guard reads the registry and warns before leaving. The task
 * auto-deregisters when `running` flips false AND on unmount (so "Leave →
 * page unmounts → registry clears" stays correct). `meta` is read through a ref
 * so a new `onAbort`/`label` closure each render doesn't thrash begin/end.
 */
export function useRegisterTask(running: boolean, meta: RegisterTaskMeta): void {
  const id = useId();
  const metaRef = useRef(meta);
  // Keep the ref current. Declared first so it runs before the effects below.
  useEffect(() => { metaRef.current = meta; });

  useEffect(() => {
    const { begin, end } = useActiveTasks.getState();
    if (running) begin({ id, ...metaRef.current });
    else end(id);
    return () => end(id);
  }, [running, id]);

  // Keep label/onAbort fresh while running, without re-firing begin/end.
  useEffect(() => {
    if (running) useActiveTasks.getState().update(id, { ...metaRef.current });
  });
}
