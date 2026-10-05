"use client";
import { useRef, useState } from "react";
import {
  Shuffle, Upload, X, FolderDown, Download, CheckCircle,
  RefreshCw, ArrowRight, FileVideo, Info, Loader2,
} from "lucide-react";
import { zip } from "fflate";
import AppLayout from "@/components/layout/app-layout";
import { StudioToolHeader } from "@/components/tools/studio-tool-header";
import { FieldLabel, ToggleSwitch, SectionTitle } from "@/components/tools/ui";
import { logDebug } from "@/lib/log";
import { saveBlobToDisk } from "@/lib/save-file";
import { surfaceError } from "@/lib/toast";
import { humanizeError } from "@/lib/error/app-error";
import { useClientValue } from "@/lib/use-client-value";

const ACCENT = "#3D7EFD";

interface Item {
  id: string;
  file: File;
  code: string; // random code at the current length
}

/** How the new filename is built. */
type NameStyle = "random" | "prepend" | "keep";

const STYLES: { id: NameStyle; label: string; hint: string }[] = [
  { id: "random",  label: "Random",        hint: "q8z3m1.mp4" },
  { id: "prepend", label: "Random + name", hint: "q8z3m1-yourname.mp4" },
  { id: "keep",    label: "Keep name",     hint: "yourname.mp4 (reorder only)" },
];

/* ── helpers ───────────────────────────────────────────────────────────────── */

const CHARS = "abcdefghijklmnopqrstuvwxyz0123456789";

function randomCode(len: number): string {
  const buf = new Uint32Array(len);
  crypto.getRandomValues(buf);
  let out = "";
  for (let i = 0; i < len; i++) out += CHARS[buf[i] % CHARS.length];
  return out;
}

/** Generate `n` codes guaranteed unique against `taken`. */
function uniqueCodes(n: number, len: number, taken = new Set<string>()): string[] {
  const out: string[] = [];
  for (let i = 0; i < n; i++) {
    let c = randomCode(len);
    while (taken.has(c)) c = randomCode(len);
    taken.add(c);
    out.push(c);
  }
  return out;
}

/** Crypto-seeded Fisher–Yates shuffle (returns a new array). */
function shuffle<T>(arr: T[]): T[] {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const r = new Uint32Array(1);
    crypto.getRandomValues(r);
    const j = r[0] % (i + 1);
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function extOf(name: string): string {
  const dot = name.lastIndexOf(".");
  return dot > 0 ? name.slice(dot) : "";
}

function fmtSize(b: number): string {
  if (b < 1024 * 1024) return `${(b / 1024).toFixed(1)} KB`;
  if (b < 1024 * 1024 * 1024) return `${(b / (1024 * 1024)).toFixed(1)} MB`;
  return `${(b / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

function fmtName(name: string, max = 34): string {
  if (name.length <= max) return name;
  const ext = extOf(name);
  return name.slice(0, max - ext.length - 1) + "…" + ext;
}

/** Build the final name for every item, guaranteeing no two collide. */
function buildNames(items: Item[], style: NameStyle, prefix: string): Map<string, string> {
  const used = new Set<string>();
  const map = new Map<string, string>();
  for (const it of items) {
    const ext  = extOf(it.file.name);
    const base = it.file.name.slice(0, it.file.name.length - ext.length);
    let name =
      style === "random"  ? `${prefix}${it.code}${ext}`
    : style === "prepend" ? `${prefix}${it.code}-${base}${ext}`
    : /* keep */            `${prefix}${base}${ext}`;
    // de-dupe (only "keep" can collide — same original name twice)
    while (used.has(name.toLowerCase())) {
      name = `${prefix}${base || it.code}-${randomCode(4)}${ext}`;
    }
    used.add(name.toLowerCase());
    map.set(it.id, name);
  }
  return map;
}

const DAY = 86_400_000;

/* ── page ──────────────────────────────────────────────────────────────────── */

export default function FileShufflerPage() {
  const [items,    setItems]    = useState<Item[]>([]);
  const [style,    setStyle]    = useState<NameStyle>("random");
  const [prefix,   setPrefix]   = useState("");
  const [len,      setLen]      = useState(8);
  const [randDates, setRandDates] = useState(true);
  const [dragging, setDragging] = useState(false);

  const [busy,     setBusy]     = useState(false);
  const [progress, setProgress] = useState(0);
  const [phase,    setPhase]    = useState("");
  const [done,     setDone]     = useState<string | null>(null);
  const [err,      setErr]      = useState<string | null>(null);

  const canFolder = useClientValue(() => "showDirectoryPicker" in window, false);
  const inputRef = useRef<HTMLInputElement>(null);

  const names = buildNames(items, style, prefix);
  const newName = (it: Item) => names.get(it.id) ?? it.file.name;
  const totalBytes = items.reduce((s, i) => s + i.file.size, 0);

  function reset() { setDone(null); setErr(null); }

  function addFiles(files: File[]) {
    if (!files.length) return;
    setItems(prev => {
      const taken = new Set(prev.map(i => i.code));
      const codes = uniqueCodes(files.length, len, taken);
      const next = files.map((file, i) => ({ id: crypto.randomUUID(), file, code: codes[i] }));
      return shuffle([...prev, ...next]); // mix new files into the existing order
    });
    reset();
  }

  function reshuffle() {
    setItems(prev => {
      const codes = uniqueCodes(prev.length, len);
      return shuffle(prev.map((it, i) => ({ ...it, code: codes[i] })));
    });
    reset();
  }

  function changeLen(n: number) {
    setLen(n);
    setItems(prev => {
      const codes = uniqueCodes(prev.length, n);
      return prev.map((it, i) => ({ ...it, code: codes[i] })); // keep order, new codes
    });
    reset();
  }

  function remove(id: string) {
    setItems(prev => prev.filter(i => i.id !== id));
    reset();
  }

  function clearAll() { setItems([]); reset(); }

  function onDrop(e: React.DragEvent) {
    e.preventDefault();
    setDragging(false);
    addFiles(Array.from(e.dataTransfer.files));
  }

  /* ── export: save straight to a folder (low memory, best for big batches) ──── */
  async function saveToFolder() {
    if (!items.length || busy) return;
    reset();
    let dir: FileSystemDirectoryHandle;
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      dir = await (window as any).showDirectoryPicker({ mode: "readwrite" });
    } catch (e) {
      logDebug("file-shuffler", "Folder picker cancelled or unavailable", e);
      return; // user cancelled the picker
    }
    setBusy(true);
    setProgress(0);
    try {
      for (let i = 0; i < items.length; i++) {
        setPhase(`Writing ${i + 1} of ${items.length}`);
        setProgress(Math.round((i / items.length) * 100));
        const handle = await dir.getFileHandle(newName(items[i]), { create: true });
        const w = await handle.createWritable();
        await w.write(items[i].file); // streamed to disk by the browser
        await w.close();
      }
      setProgress(100);
      setDone(`Saved ${items.length} renamed files to your chosen folder.`);
    } catch (e: unknown) {
      setErr(humanizeError(e));
    } finally {
      setBusy(false);
    }
  }

  /* ── export: download everything as one ZIP ────────────────────────────────── */
  async function downloadZip() {
    if (!items.length || busy) return;
    reset();
    setBusy(true);
    setProgress(0);
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const data: Record<string, [Uint8Array, any]> = {};
      for (let i = 0; i < items.length; i++) {
        setPhase(`Reading ${i + 1} of ${items.length}`);
        setProgress(Math.round((i / items.length) * 80));
        const buf = new Uint8Array(await items[i].file.arrayBuffer());
        const mtime = randDates
          ? new Date(Date.now() - Math.floor(Math.random() * 90 * DAY))
          : undefined;
        data[newName(items[i])] = [buf, { level: 0, mtime }]; // level 0 = store (video won't compress)
      }

      setPhase("Packaging ZIP");
      setProgress(85);
      const out: Uint8Array = await new Promise((resolve, reject) =>
        zip(data, {}, (e, d) => (e ? reject(e) : resolve(d))),
      );

      const zipBlob = new Blob([out as BlobPart], { type: "application/zip" });
      // Native Save dialog on desktop (the webview ignores `<a download>`).
      await saveBlobToDisk(zipBlob, `shuffled-${items.length}-files.zip`)
        .catch(e => surfaceError(e, { operation: "save zip" }));

      setProgress(100);
      setDone(`Packaged ${items.length} renamed files into a ZIP.`);
    } catch (e: unknown) {
      setErr(humanizeError(e));
    } finally {
      setBusy(false);
    }
  }

  const bigBatch = totalBytes > 1.5 * 1024 * 1024 * 1024;

  return (
    <AppLayout>
      <div className="flex flex-col h-full min-h-0 overflow-hidden">
        <StudioToolHeader
          icon={Shuffle}
          title="File Shuffler"
          accent={ACCENT}
          backHref="/tools"
          backLabel="Tools"
          description={items.length > 0
            ? `Randomly rename & reorder · ${items.length} files · ${fmtSize(totalBytes)}`
            : "Randomly rename & reorder a batch of files — runs in your browser, nothing uploaded."}
        />

        <div className="flex flex-1 min-h-0">
          {/* ── LEFT — controls ── */}
          {/* Glassy/translucent so the app's ambient background shows through —
              seamless with the (transparent) queue panel on the right. */}
          <div className="w-[324px] shrink-0 flex flex-col border-r border-zinc-200 dark:border-white/8 bg-white/55 dark:bg-zinc-900/40 backdrop-blur-xl overflow-hidden">
            <div className="flex-1 overflow-y-auto px-5 py-4 space-y-5">

              {/* Upload */}
              <div>
                <SectionTitle>Upload</SectionTitle>
                <div
                  onDrop={onDrop}
                  onDragOver={e => { e.preventDefault(); setDragging(true); }}
                  onDragLeave={() => setDragging(false)}
                  onClick={() => inputRef.current?.click()}
                  className={`flex flex-col items-center justify-center gap-2 rounded-xl border-2 border-dashed cursor-pointer transition-all py-7 ${
                    dragging ? "border-violet-400 bg-violet-500/5"
                      : "border-zinc-300 dark:border-white/20 bg-zinc-50/80 dark:bg-white/[0.04] hover:border-violet-400/50 dark:hover:border-white/14"
                  }`}
                >
                  <div className="w-10 h-10 rounded-xl flex items-center justify-center" style={{ background: `${ACCENT}12`, border: `1px solid ${ACCENT}22` }}>
                    <Upload size={17} strokeWidth={1.6} style={{ color: ACCENT }} />
                  </div>
                  <p className="text-[12.5px] font-semibold text-zinc-600 dark:text-zinc-400">Drop files or <span style={{ color: ACCENT }}>browse</span></p>
                  <p className="text-[10.5px] text-zinc-400 dark:text-zinc-500 text-center px-3">Any file type — add as many as you like</p>
                  <input ref={inputRef} type="file" multiple className="hidden"
                    onChange={e => { addFiles(Array.from(e.target.files ?? [])); e.target.value = ""; }} />
                </div>
              </div>

              {/* Naming */}
              <div>
                <SectionTitle>Naming</SectionTitle>
                <FieldLabel>Name style</FieldLabel>
                <div className="flex gap-1.5 mb-3">
                  {STYLES.map(s => {
                    const active = style === s.id;
                    return (
                      <button key={s.id} onClick={() => { setStyle(s.id); reset(); }}
                        className={`flex-1 flex flex-col items-start gap-0.5 px-2.5 py-2 rounded-lg border text-left transition-all cursor-pointer min-w-0 ${
                          active ? "border-transparent" : "bg-white dark:bg-white/5 border-zinc-200 dark:border-white/10 hover:border-zinc-300 dark:hover:border-white/20"
                        }`}
                        style={active ? { background: ACCENT } : {}}>
                        <span className={`text-[11.5px] font-semibold ${active ? "text-white" : "text-zinc-700 dark:text-zinc-300"}`}>{s.label}</span>
                        <span className={`text-[9px] font-mono truncate max-w-full ${active ? "text-white/75" : "text-zinc-400 dark:text-zinc-500"}`}>{s.hint}</span>
                      </button>
                    );
                  })}
                </div>

                <FieldLabel>Name prefix (optional)</FieldLabel>
                <input value={prefix}
                  onChange={e => { setPrefix(e.target.value.replace(/[\\/:*?"<>|]/g, "")); reset(); }}
                  placeholder="e.g. clip-"
                  className="w-full h-9 px-3 mb-3 rounded-lg text-[13px] outline-none bg-white dark:bg-white/5 border border-zinc-200 dark:border-white/10 text-zinc-900 dark:text-zinc-100 focus:border-violet-500/60 focus:ring-1 focus:ring-violet-500/10 transition-all" />

                <FieldLabel>Random code length</FieldLabel>
                <div className="flex gap-1.5">
                  {[6, 8, 10, 12].map(n => (
                    <button key={n} onClick={() => changeLen(n)} disabled={style === "keep"}
                      className={`flex-1 h-9 rounded-lg text-[12.5px] font-semibold border transition-all cursor-pointer tabular-nums disabled:opacity-40 disabled:cursor-not-allowed ${
                        len === n && style !== "keep" ? "text-white border-transparent"
                          : "bg-white dark:bg-white/5 text-zinc-500 dark:text-zinc-400 border-zinc-200 dark:border-white/10 hover:border-zinc-300 dark:hover:border-white/20"
                      }`}
                      style={len === n && style !== "keep" ? { background: ACCENT } : {}}>
                      {n}
                    </button>
                  ))}
                </div>
                {style === "keep" && (
                  <p className="text-[10.5px] text-zinc-400 dark:text-zinc-500 mt-2 leading-snug">
                    Original names are kept — only the order{randDates ? " and dates are" : " is"} shuffled. Duplicates get a short random suffix.
                  </p>
                )}
              </div>

              {/* Options */}
              <div>
                <SectionTitle>Options</SectionTitle>
                <div className="flex items-center justify-between gap-3 px-3 py-2.5 rounded-xl border border-zinc-200 dark:border-white/8 bg-zinc-50 dark:bg-white/3">
                  <div className="min-w-0">
                    <p className="text-[12px] font-semibold text-zinc-700 dark:text-zinc-300">Randomize file dates</p>
                    <p className="text-[10px] text-zinc-400 dark:text-zinc-500 leading-snug">Spreads dates over the last 90 days (ZIP only).</p>
                  </div>
                  <ToggleSwitch checked={randDates} onChange={v => { setRandDates(v); reset(); }} />
                </div>
              </div>
            </div>

            {/* Bottom bar */}
            <div className="px-5 py-4 border-t border-zinc-100 dark:border-white/8 shrink-0 space-y-2.5">
              {busy ? (
                <div>
                  <div className="flex items-center justify-between mb-1.5">
                    <span className="text-[11px] text-zinc-500 dark:text-zinc-400 flex items-center gap-1.5">
                      <Loader2 size={11} className="animate-spin" style={{ color: ACCENT }} /> {phase || "Working…"}
                    </span>
                    <span className="text-[11px] font-bold tabular-nums" style={{ color: ACCENT }}>{progress}%</span>
                  </div>
                  <div className="h-1.5 rounded-full bg-zinc-100 dark:bg-white/8 overflow-hidden">
                    <div className="h-full rounded-full transition-all duration-300 ease-out" style={{ width: `${progress}%`, background: "linear-gradient(90deg,#3D7EFD,#0047D1)" }} />
                  </div>
                </div>
              ) : (
                <>
                  <div className="flex gap-2">
                    {canFolder && (
                      <button onClick={saveToFolder} disabled={!items.length}
                        className="flex-1 h-10 rounded-xl text-[13px] font-bold text-white cursor-pointer border-none flex items-center justify-center gap-2 disabled:opacity-40 disabled:cursor-not-allowed hover:opacity-90 transition-opacity"
                        style={{ background: "linear-gradient(135deg,#3D7EFD,#0047D1)" }}>
                        <FolderDown size={14} /> Save to folder
                      </button>
                    )}
                    <button onClick={downloadZip} disabled={!items.length}
                      className={`h-10 rounded-xl text-[13px] font-bold cursor-pointer flex items-center justify-center gap-2 disabled:opacity-40 disabled:cursor-not-allowed transition-all ${
                        canFolder
                          ? "px-5 bg-white dark:bg-white/5 text-zinc-700 dark:text-zinc-200 border border-zinc-200 dark:border-white/10 hover:border-zinc-300"
                          : "flex-1 text-white border-none hover:opacity-90"
                      }`}
                      style={!canFolder ? { background: "linear-gradient(135deg,#3D7EFD,#0047D1)" } : {}}>
                      <Download size={14} /> ZIP
                    </button>
                  </div>
                  {canFolder && items.length > 0 && (
                    <p className="flex items-start gap-1.5 text-[10px] text-zinc-400 dark:text-zinc-500 leading-snug">
                      <Info size={11} className="shrink-0 mt-px" />
                      <span><b>Save to folder</b> is best for large batches.{bigBatch && " Over 1.5 GB — avoid ZIP (loads into memory)."}</span>
                    </p>
                  )}
                </>
              )}
            </div>
          </div>

          {/* ── RIGHT — preview ── */}
          <div className="flex-1 flex flex-col overflow-hidden">
            {/* Toolbar */}
            <div className="flex items-center justify-between px-5 py-3 border-b border-zinc-200 dark:border-white/8 bg-white/70 dark:bg-white/[0.03] shrink-0 gap-4">
              <div className="flex items-center gap-2 min-w-0">
                <Shuffle size={13} style={{ color: ACCENT }} />
                <span className="text-[12px] font-semibold text-zinc-700 dark:text-zinc-300 truncate">
                  {items.length > 0 ? `${items.length} file${items.length !== 1 ? "s" : ""} · ${fmtSize(totalBytes)}` : "No files yet"}
                </span>
              </div>
              {items.length > 0 && !busy && (
                <div className="flex items-center gap-3 shrink-0">
                  <button onClick={reshuffle} className="flex items-center gap-1.5 text-[11.5px] font-semibold bg-transparent border-none cursor-pointer transition-colors" style={{ color: ACCENT }}>
                    <RefreshCw size={11} /> Reshuffle
                  </button>
                  <button onClick={clearAll} className="text-[11.5px] text-zinc-400 dark:text-zinc-500 hover:text-red-500 bg-transparent border-none cursor-pointer transition-colors">Clear</button>
                </div>
              )}
            </div>

            {/* Body */}
            {items.length === 0 ? (
              <div className="flex-1 flex flex-col items-center justify-center gap-3 p-5 text-center">
                <div className="w-16 h-16 rounded-2xl bg-zinc-100 dark:bg-white/5 border border-zinc-200 dark:border-white/8 flex items-center justify-center">
                  <Shuffle size={24} strokeWidth={1.4} className="text-zinc-400" />
                </div>
                <p className="text-[14px] font-semibold text-zinc-500 dark:text-zinc-400">Nothing to shuffle yet</p>
                <p className="text-[12px] text-zinc-400 dark:text-zinc-600 max-w-xs">
                  Add files on the left — they&apos;re reordered and renamed instantly. Preview each old → new name here before exporting.
                </p>
              </div>
            ) : (
              <div className="flex-1 overflow-y-auto p-5 space-y-3">
                {done && (
                  <div className="rounded-xl border border-emerald-200 dark:border-emerald-500/20 bg-emerald-50 dark:bg-emerald-500/8 px-4 py-3 flex items-center gap-2">
                    <CheckCircle size={14} className="text-emerald-500 shrink-0" />
                    <p className="text-[12.5px] font-medium text-emerald-700 dark:text-emerald-400">{done}</p>
                  </div>
                )}
                {err && (
                  <div className="rounded-xl border border-red-200 dark:border-red-500/20 bg-red-50 dark:bg-red-500/8 px-4 py-3">
                    <p className="text-[12.5px] font-medium text-red-600 dark:text-red-400">{err}</p>
                  </div>
                )}

                <div className="rounded-xl border border-zinc-200 dark:border-white/8 bg-white dark:bg-zinc-900 overflow-hidden divide-y divide-zinc-100 dark:divide-white/[0.05]">
                  {items.map((it, idx) => (
                    <div key={it.id} className="flex items-center gap-3 px-4 py-2.5 group hover:bg-zinc-50 dark:hover:bg-white/[0.03] transition-colors">
                      <span className="text-[11px] font-bold text-zinc-400 dark:text-zinc-600 w-5 tabular-nums text-right shrink-0">{idx + 1}</span>
                      <FileVideo size={13} className="text-zinc-300 dark:text-zinc-600 shrink-0" />
                      <div className="flex items-center gap-2 flex-1 min-w-0">
                        <span className="text-[11.5px] text-zinc-400 dark:text-zinc-500 truncate max-w-[40%] line-through decoration-zinc-300 dark:decoration-zinc-700">{fmtName(it.file.name, 22)}</span>
                        <ArrowRight size={11} className="text-zinc-300 dark:text-zinc-600 shrink-0" />
                        <span className="text-[12px] font-semibold text-zinc-800 dark:text-zinc-200 font-mono truncate">{newName(it)}</span>
                      </div>
                      <span className="text-[10.5px] text-zinc-400 dark:text-zinc-500 shrink-0 tabular-nums">{fmtSize(it.file.size)}</span>
                      <button onClick={() => remove(it.id)}
                        className="w-6 h-6 flex items-center justify-center rounded-md text-zinc-400 dark:text-zinc-600 hover:text-red-500 dark:hover:text-red-400 hover:bg-red-50 dark:hover:bg-red-500/8 bg-transparent border-none cursor-pointer transition-colors opacity-0 group-hover:opacity-100">
                        <X size={12} />
                      </button>
                    </div>
                  ))}
                </div>
                <button onClick={() => inputRef.current?.click()} className="text-[11.5px] text-zinc-400 dark:text-zinc-500 hover:text-zinc-600 dark:hover:text-zinc-300 bg-transparent border-none cursor-pointer transition-colors">
                  + Add more files
                </button>
              </div>
            )}
          </div>
        </div>
      </div>
    </AppLayout>
  );
}
