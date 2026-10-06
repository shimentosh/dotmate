"use client";
import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Upload, Loader2, Link2, AlertCircle, CircleDot } from "lucide-react";
import { ClipEditor, type EditorClip, type PreviewRequest } from "@/components/dotmate/clip-editor";
import { ClipQueue, ExportPanel } from "@/components/dotmate/clip-queue";
import { SourceList } from "@/components/dotmate/source-list";
import { collectDrop, pickVideoFiles, type ImportItem } from "@/lib/dotmate/sources";
import { surfaceError, toastError, toastInfo } from "@/lib/toast";
import { useBatchClips, type DmClip } from "@/store/batch-clips";

const MemoEditor = memo(ClipEditor);

const ACCEPT = "video/*,.mkv,.mov,.m4v,.webm,.avi,.ts,.mts,.m2ts";

/** Batch Clips — mark many short moments across long recordings, export them all.
 *  Hosted as the default tab of the Quick Trim page. */
export function BatchClipsTool() {
  const s = useBatchClips();
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [pageDrag, setPageDrag] = useState(false);
  const [previewReq, setPreviewReq] = useState<PreviewRequest | null>(null);

  useEffect(() => { void useBatchClips.getState().hydrate(); }, []);

  /* ── Import ── */
  const importItems = useCallback(async (items: ImportItem[]) => {
    if (!items.length) return;
    try {
      const r = await useBatchClips.getState().importFiles(items);
      if (r.rejected.length) {
        toastError(r.rejected.length === 1 ? r.rejected[0] : `${r.rejected.length} files skipped`, "Not a video file");
      }
      const parts: string[] = [];
      if (r.added) parts.push(`${r.added} video${r.added === 1 ? "" : "s"} imported`);
      if (r.relinked) parts.push(`${r.relinked} reconnected`);
      if (r.skipped) parts.push(`${r.skipped} already in the list`);
      if (parts.length) toastInfo(parts.join(" · "));
    } catch (e) {
      surfaceError(e, { operation: "dotmate:import" });
    }
  }, []);

  const openImport = useCallback(async () => {
    const picked = await pickVideoFiles();
    if (picked === null) fileInputRef.current?.click(); // no File System Access → plain picker
    else await importItems(picked);
  }, [importItems]);

  const onDropFiles = useCallback((dt: DataTransfer) => {
    void collectDrop(dt).then(importItems);
  }, [importItems]);

  const reconnect = useCallback(async () => {
    const n = await useBatchClips.getState().reconnectSources();
    const still = useBatchClips.getState().sources.filter((x) => x.status === "missing").length;
    if (n) toastInfo(`${n} video${n === 1 ? "" : "s"} reconnected`);
    if (still) {
      toastInfo(`Select the ${still} missing video${still === 1 ? "" : "s"} — they reconnect by name and size.`);
      await openImport();
    }
  }, [openImport]);

  /* ── Derived ── */
  const selected = s.sources.find((x) => x.id === s.selectedSourceId) ?? null;
  const sourceNames = useMemo(() => new Map(s.sources.map((x) => [x.id, x.name])), [s.sources]);
  const { clipCounts, editorClips } = useMemo(() => {
    const counts = new Map<string, number>();
    const bySource = new Map<string, EditorClip[]>();
    s.clips.forEach((c, i) => {
      counts.set(c.sourceId, (counts.get(c.sourceId) ?? 0) + 1);
      const list = bySource.get(c.sourceId) ?? [];
      list.push({ id: c.id, number: i + 1, start: c.start, end: c.end, locked: c.status === "rendering" || c.status === "preparing" });
      bySource.set(c.sourceId, list);
    });
    return { clipCounts: counts, editorClips: bySource };
  }, [s.clips]);
  const NO_CLIPS = useMemo<EditorClip[]>(() => [], []);

  /* ── Stable callbacks for memoised children ── */
  const onSelectSource = useCallback((id: string) => {
    setPreviewReq(null);
    useBatchClips.getState().selectSource(id);
  }, []);
  const onRemoveSource = useCallback((id: string) => useBatchClips.getState().removeSource(id), []);
  const onAddClip = useCallback((r: { start: number; end: number }) => {
    const st = useBatchClips.getState();
    return st.selectedSourceId ? st.addClip(st.selectedSourceId, r.start, r.end) : { ok: false as const, reason: "invalid" as const };
  }, []);
  const onDefaultDuration = useCallback((sec: number) => useBatchClips.getState().setDefaultDuration(sec), []);
  // Queue row → open that clip in the editor (edit mode); ▶ also plays it once.
  const openClip = useCallback((clip: DmClip, play: boolean) => {
    useBatchClips.getState().selectSource(clip.sourceId);
    setPreviewReq({ clipId: clip.id, start: clip.start, end: clip.end, nonce: Date.now(), play });
  }, []);
  const onPreviewClip = useCallback((clip: DmClip) => openClip(clip, true), [openClip]);
  const onEditClip = useCallback((clip: DmClip) => openClip(clip, false), [openClip]);
  const onUpdateClip = useCallback((id: string, r: { start: number; end: number }) =>
    useBatchClips.getState().updateClip(id, r.start, r.end), []);
  const onRemoveClip = useCallback((id: string) => useBatchClips.getState().removeClip(id), []);
  const onMoveClip = useCallback((id: string, to: number) => useBatchClips.getState().moveClip(id, to), []);
  const onClearClips = useCallback(() => useBatchClips.getState().clearClips(), []);

  const startExport = () => {
    void useBatchClips.getState().startExport().catch((e) => surfaceError(e, { operation: "dotmate:export" }));
  };

  const hiddenInput = (
    <input
      ref={fileInputRef} type="file" multiple accept={ACCEPT} className="hidden"
      onChange={(e) => {
        const files = Array.from(e.target.files ?? []);
        e.target.value = "";
        void importItems(files.map((file) => ({ file })));
      }}
    />
  );

  /* ── Loading the saved session ── */
  if (!s.hydrated) {
    return (
      <>
        <div className="flex-1 flex items-center justify-center text-zinc-400">
          <Loader2 size={20} className="animate-spin" />
        </div>
      </>
    );
  }

  /* ── First run: one obvious action ── */
  if (s.sources.length === 0) {
    return (
      <>
        {hiddenInput}
        <div
          className="flex-1 flex items-center justify-center p-8"
          onDragOver={(e) => { if (e.dataTransfer.types.includes("Files")) { e.preventDefault(); setPageDrag(true); } }}
          onDragLeave={(e) => { if (!e.currentTarget.contains(e.relatedTarget as Node)) setPageDrag(false); }}
          onDrop={(e) => { e.preventDefault(); setPageDrag(false); onDropFiles(e.dataTransfer); }}
        >
          <div className={`w-full max-w-xl rounded-3xl border-2 border-dashed px-10 py-14 flex flex-col items-center text-center transition-colors ${pageDrag
            ? "border-violet-400 bg-violet-500/[0.06]" : "border-zinc-300/80 dark:border-white/12 bg-white/50 dark:bg-white/[0.02]"}`}>
            <div className="w-14 h-14 rounded-2xl flex items-center justify-center mb-5 shadow-sm"
              style={{ background: "var(--brand-gradient)" }}>
              <CircleDot size={26} className="text-white" strokeWidth={2} />
            </div>
            <h1 className="text-[24px] font-extrabold tracking-tight text-zinc-900 dark:text-white">Batch Clips</h1>
            <p className="mt-2 text-[14px] text-zinc-500 dark:text-zinc-400">Create hundreds of short clips from your recordings.</p>
            <button
              onClick={() => void openImport()}
              className="mt-7 h-11 px-6 rounded-xl text-[14px] font-bold text-white border-none cursor-pointer flex items-center gap-2 hover:opacity-90 transition-opacity shadow-sm"
              style={{ background: "var(--brand-gradient)" }}
            >
              <Upload size={16} /> Import Videos
            </button>
            <p className="mt-3 text-[11.5px] text-zinc-400">or drop them here · MP4, MOV, MKV, WebM · any length</p>
            <div className="mt-8 flex items-center gap-2 text-[11px] text-zinc-400">
              {["Import", "Mark moments", "Add clips", "Export all"].map((step, i) => (
                <span key={step} className="flex items-center gap-2">
                  {i > 0 && <span className="text-zinc-300 dark:text-zinc-600">→</span>}
                  <span className="font-semibold text-zinc-500 dark:text-zinc-400">{step}</span>
                </span>
              ))}
            </div>
            <p className="mt-6 text-[10.5px] text-zinc-400 max-w-sm">Your original files are only read, never changed or uploaded.</p>
          </div>
        </div>
      </>
    );
  }

  /* ── Workspace ── */
  return (
    <>
      {hiddenInput}
      <div className="flex flex-1 min-h-0 overflow-hidden">
        {/* Sources */}
        <aside className="w-[264px] shrink-0 flex flex-col border-r border-zinc-200 dark:border-white/8 bg-panel">
          <SourceList
            sources={s.sources}
            clipCounts={clipCounts}
            selectedId={s.selectedSourceId}
            onSelect={onSelectSource}
            onRemove={onRemoveSource}
            onImport={() => void openImport()}
            onReconnect={() => void reconnect()}
            onDropFiles={onDropFiles}
          />
        </aside>

        {/* Preview + timeline */}
        <section className="flex-1 min-w-0 flex flex-col">
          {selected?.status === "ready" && selected.file && selected.duration ? (
            <MemoEditor
              sourceId={selected.id}
              file={selected.file}
              name={selected.name}
              duration={selected.duration}
              clips={editorClips.get(selected.id) ?? NO_CLIPS}
              defaultDuration={s.defaultDuration}
              onDefaultDurationChange={onDefaultDuration}
              onAddClip={onAddClip}
              onUpdateClip={onUpdateClip}
              onRemoveClip={onRemoveClip}
              previewRequest={previewReq}
            />
          ) : (
            <div className="flex-1 flex flex-col items-center justify-center gap-3 text-center px-8">
              {!selected && <p className="text-[13px] text-zinc-500">Select a video to start clipping.</p>}
              {selected?.status === "loading" && <><Loader2 size={22} className="animate-spin text-zinc-400" /><p className="text-[13px] text-zinc-500">Reading {selected.name}…</p></>}
              {selected?.status === "missing" && (
                <>
                  <Link2 size={26} strokeWidth={1.5} className="text-amber-500" />
                  <p className="text-[13px] font-semibold text-zinc-700 dark:text-zinc-200">{selected.name} isn&apos;t connected</p>
                  <p className="text-[12px] text-zinc-500 max-w-sm">Reconnect it to preview and export its {clipCounts.get(selected.id) ?? 0} clip(s). Nothing in your queue was lost.</p>
                  <button onClick={() => void reconnect()}
                    className="mt-1 h-8 px-4 rounded-lg text-[12px] font-bold text-white bg-amber-500 hover:bg-amber-600 border-none cursor-pointer">Reconnect videos</button>
                </>
              )}
              {selected?.status === "error" && (
                <>
                  <AlertCircle size={26} strokeWidth={1.5} className="text-red-500" />
                  <p className="text-[13px] font-semibold text-zinc-700 dark:text-zinc-200">{selected.error ?? "This video can't be read"}</p>
                  <p className="text-[12px] text-zinc-500 max-w-sm">The file may be damaged or use a format this computer can&apos;t decode. Try re-exporting it as MP4 (H.264).</p>
                </>
              )}
            </div>
          )}
        </section>

        {/* Queue + export */}
        <aside className="w-[336px] shrink-0 flex flex-col border-l border-zinc-200 dark:border-white/8 bg-panel">
          <ClipQueue
            clips={s.clips}
            sourceNames={sourceNames}
            exp={s.exp}
            onPreview={onPreviewClip}
            onEdit={onEditClip}
            onRemove={onRemoveClip}
            onMove={onMoveClip}
            onClear={onClearClips}
          />
          <ExportPanel
            clips={s.clips}
            exp={s.exp}
            prefix={s.prefix}
            outputLabel={s.outputLabel}
            onPrefix={s.setPrefix}
            onChooseFolder={() => void s.chooseOutputFolder()}
            onExport={startExport}
            onStop={s.stopExport}
            onExportAgain={() => { s.resetCompleted(); startExport(); }}
          />
        </aside>
      </div>
    </>
  );
}
