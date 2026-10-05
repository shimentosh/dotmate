"use client";
import TopBar from "@/components/layout/topbar";
import Sidebar from "@/components/layout/sidebar";
import AppBackground from "@/components/layout/app-background";

/**
 * The app shell every tool page renders inside: title bar (TopBar) on top, the
 * tool sidebar on the left, and the page in a scrollable main area. Fixed to the
 * viewport; manages its own overflow.
 */
export default function AppLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="fixed inset-0 flex flex-col overflow-hidden bg-zinc-50 dark:bg-zinc-950">
      {/* Ambient background (the main area is transparent so it shows through) */}
      <AppBackground />
      <div className="relative z-10 flex flex-col flex-1 min-h-0 overflow-hidden">
        <TopBar />
        {/* `isolate` traps page-content z-index inside this row so the title bar's
            popovers always paint above it. */}
        <div className="relative isolate flex-1 flex overflow-hidden min-h-0">
          <Sidebar />
          {/* scrollbar-gutter: stable keeps content width steady between pages. */}
          <main className="flex-1 flex flex-col overflow-y-auto min-h-0 [scrollbar-gutter:stable]">
            {children}
          </main>
        </div>
      </div>
    </div>
  );
}
