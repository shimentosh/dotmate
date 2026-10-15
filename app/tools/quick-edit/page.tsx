"use client";
import { useCallback, useEffect } from "react";
import { Upload, Wand2 } from "lucide-react";
import AppLayout from "@/components/layout/app-layout";
import { EditPanel } from "@/components/quick-edit/edit-panel";
import { PreviewPlayer } from "@/components/quick-edit/preview-player";
import { VideoList } from "@/components/quick-edit/video-list";
import { surfaceError } from "@/lib/toast";
import { useQuickEdit } from "@/store/quick-edit";

/**
 * Quick Edit — pick many videos, lay one background track under all of them (or
 * just turn their audio up/down), hear it live, render them all in parallel.
 * State and the render queue live in store/quick-edit.ts.
 */
export default function QuickEditPage() {
  const s = useQuickEdit();

  useEffect(() => { useQuickEdit.getState().loadSettings(); }, []);

  const importVideos = useCallback(() => {
    void useQuickEdit.getState().importVideos().catch((e) => surfaceError(e, { operation: "quick-edit:import" }));
  }, []);
  const onSelect = useCallback((id: string) => useQuickEdit.getState().setActive(id), []);
  const onToggle = useCallback((id: string) => useQuickEdit.getState().toggleChecked(id), []);
  const onRemove = useCallback((id: string) => useQuickEdit.getState().removeVideo(id), []);
  const start = () => { void s.start().catch((e) => surfaceError(e, { operation: "quick-edit:render" })); };
  const renderAgain = () => { void s.renderAgain().catch((e) => surfaceError(e, { operation: "quick-edit:render" })); };

  const active = s.videos.find((v) => v.id === s.activeId) ?? null;

  if (s.videos.length === 0) {
    return (
      <AppLayout>
        <div className="flex-1 flex items-center justify-center p-8">
          <div className="w-full max-w-xl rounded-3xl border-2 border-dashed border-zinc-300/80 dark:border-white/12 bg-white/50 dark:bg-white/[0.02] px-10 py-14 flex flex-col items-center text-center">
            <div className="w-14 h-14 rounded-2xl flex items-center justify-center mb-5 shadow-sm" style={{ background: "var(--brand-gradient)" }}>
              <Wand2 size={26} className="text-white" strokeWidth={2} />
            </div>
            <h1 className="text-[24px] font-extrabold tracking-tight text-zinc-900 dark:text-white">Quick Edit</h1>
            <p className="mt-2 text-[14px] text-zinc-500 dark:text-zinc-400">Add background music to many videos at once, or turn their audio up.</p>
            <button onClick={importVideos}
              className="mt-7 h-11 px-6 rounded-xl text-[14px] font-bold text-white border-none cursor-pointer flex items-center gap-2 hover:opacity-90 transition-opacity shadow-sm"
              style={{ background: "var(--brand-gradient)" }}>
              <Upload size={16} /> Choose Videos
            </button>
            <p className="mt-3 text-[11.5px] text-zinc-400">MP4, MOV, MKV, WebM · select as many as you like</p>
            <div className="mt-8 flex items-center gap-2 text-[11px] text-zinc-400">
              {["Choose videos", "Pick music", "Preview", "Render all"].map((step, i) => (
                <span key={step} className="flex items-center gap-2">
                  {i > 0 && <span className="text-zinc-300 dark:text-zinc-600">→</span>}
                  <span className="font-semibold text-zinc-500 dark:text-zinc-400">{step}</span>
                </span>
              ))}
            </div>
            <p className="mt-6 text-[10.5px] text-zinc-400 max-w-sm">Your videos are read in place — never changed, copied or uploaded.</p>
          </div>
        </div>
      </AppLayout>
    );
  }

  return (
    <AppLayout>
      <div className="flex flex-1 min-h-0 overflow-hidden">
        <aside className="w-[280px] shrink-0 flex flex-col border-r border-zinc-200 dark:border-white/8 bg-panel">
          <VideoList
            videos={s.videos}
            activeId={s.activeId}
            running={s.running}
            onSelect={onSelect}
            onToggle={onToggle}
            onToggleAll={s.setAllChecked}
            onRemove={onRemove}
            onAdd={importVideos}
            onClear={s.clearVideos}
          />
        </aside>

        <section className="flex-1 min-w-0 flex flex-col">
          {active ? (
            <>
              <PreviewPlayer
                path={active.path}
                name={active.name}
                musicUrl={s.musicUrl}
                settings={s.settings}
                duration={active.info?.duration ?? 0}
              />
              <div className="shrink-0 px-5 h-10 flex items-center gap-2 border-t border-zinc-200 dark:border-white/8 bg-panel">
                <p className="text-[12px] font-semibold text-zinc-700 dark:text-zinc-200 truncate">{active.name}</p>
                {active.info && !active.info.hasAudio && (
                  <span className="shrink-0 text-[10.5px] px-1.5 py-0.5 rounded-md bg-zinc-100 dark:bg-white/5 text-zinc-500">No audio — music only</span>
                )}
              </div>
            </>
          ) : (
            <div className="flex-1 flex items-center justify-center text-[13px] text-zinc-500">Select a video to preview.</div>
          )}
        </section>

        <aside className="w-[320px] shrink-0 flex flex-col border-l border-zinc-200 dark:border-white/8 bg-panel">
          <EditPanel
            music={s.music}
            settings={s.settings}
            videos={s.videos}
            outputDir={s.outputDir}
            running={s.running}
            stopping={s.stopping}
            onMusic={s.setMusic}
            onSetting={s.setSetting}
            onChooseFolder={() => void s.chooseOutputDir()}
            onStart={start}
            onStop={s.stop}
            onRenderAgain={renderAgain}
          />
        </aside>
      </div>
    </AppLayout>
  );
}
