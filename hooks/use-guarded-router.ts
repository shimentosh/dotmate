"use client";

import { useCallback } from "react";
import { useRouter } from "next/navigation";
import { useNavGuard } from "@/contexts/nav-guard-context";
import { isBusyForNav } from "@/store/active-tasks";

/**
 * Guarded wrapper over `useRouter` for the `router.push/replace/back` sites that
 * Next's `<Link onNavigate>` can't intercept (topbar back/breadcrumb/notification,
 * editor back button). Each method warns first when a kill-on-nav task is running
 * and only navigates if the user chooses "Leave & stop".
 *
 *   const nav = useGuardedRouter();
 *   nav.push("/dashboard");
 */
export function useGuardedRouter() {
  const router = useRouter();
  const { confirmLeave } = useNavGuard();

  const push = useCallback(
    async (href: string) => {
      if (isBusyForNav() && !(await confirmLeave())) return;
      router.push(href);
    },
    [router, confirmLeave],
  );

  const replace = useCallback(
    async (href: string) => {
      if (isBusyForNav() && !(await confirmLeave())) return;
      router.replace(href);
    },
    [router, confirmLeave],
  );

  const back = useCallback(async () => {
    if (isBusyForNav() && !(await confirmLeave())) return;
    router.back();
  }, [router, confirmLeave]);

  return { push, replace, back };
}
