"use client";
import { useState, useRef, useCallback, useEffect } from "react";
import AppLayout from "@/components/layout/app-layout";
import {
  Upload, X, Copy, Download, Check, AlertCircle,
  Loader2, Square, Circle, Globe2, FileAudio, Sparkles, ChevronDown,
  RefreshCw, Clock, Cpu,
} from "lucide-react";
import { apiWhisperStatus, type TranscribeResult, type WhisperStatus } from "@/lib/whisper-api";
import { getVoiceTranscript } from "@/lib/transcript-store";
import { getWhisperModel, WHISPER_MODELS } from "@/lib/whisper-local";
import { openSettings } from "@/lib/open-settings";
import { logDebug, logWarn } from "@/lib/log";
import { humanizeError } from "@/lib/error/app-error";
import { saveBlobToDisk } from "@/lib/save-file";
import { surfaceError } from "@/lib/toast";

/* ─── Constants ──────────────────────────────────────────────────────────── */
const LANGUAGES = [
  { value: "auto", label: "Auto-detect" },
  { value: "en",   label: "English"     },
  { value: "es",   label: "Spanish"     },
  { value: "fr",   label: "French"      },
  { value: "de",   label: "German"      },
  { value: "it",   label: "Italian"     },
  { value: "pt",   label: "Portuguese"  },
  { value: "ja",   label: "Japanese"    },
  { value: "ko",   label: "Korean"      },
  { value: "zh",   label: "Chinese"     },
  { value: "ar",   label: "Arabic"      },
  { value: "ru",   label: "Russian"     },
  { value: "hi",   label: "Hindi"       },
];

const ACCEPT = ".mp3,.wav,.ogg,.m4a,.flac,.webm,.aac,.wma,.opus,.mp4,.mov";

/* ─── Helpers ────────────────────────────────────────────────────────────── */
function fmtDuration(s: number) {
  const m = Math.floor(s / 60);
  const sec = Math.floor(s % 60);
  return `${m}:${String(sec).padStart(2, "0")}`;
}

function fmtSize(b: number) {
  return b < 1_048_576 ? `${(b / 1024).toFixed(0)} KB` : `${(b / 1_048_576).toFixed(1)} MB`;
}

function wordsCount(text: string) {
  return text.trim() ? text.trim().split(/\s+/).length : 0;
}

/* ─── Sub-components ─────────────────────────────────────────────────────── */
function LangSelect({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const selected = LANGUAGES.find(l => l.value === value) ?? LANGUAGES[0];

  useEffect(() => {
    function onOutside(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    }
    if (open) document.addEventListener("mousedown", onOutside);
    return () => document.removeEventListener("mousedown", onOutside);
  }, [open]);

  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        onClick={() => setOpen(o => !o)}
        className="flex items-center gap-2 h-9 pl-2.5 pr-2 rounded-xl text-[12.5px] font-medium cursor-pointer font-[inherit] border transition-all
          bg-zinc-50 dark:bg-white/5 border-zinc-200 dark:border-white/10
          text-zinc-700 dark:text-zinc-200 hover:border-zinc-300 dark:hover:border-white/20"
      >
        <Globe2 size={13} className="text-zinc-400 shrink-0" />
        <span>{selected.label}</span>
        <ChevronDown size={11} className={`text-zinc-400 transition-transform duration-150 ${open ? "rotate-180" : ""}`} />
      </button>

      {open && (
        <div className="absolute top-full left-0 mt-1.5 z-50 min-w-[140px] rounded-xl border border-zinc-200 dark:border-white/10 bg-white dark:bg-zinc-900 shadow-lg dark:shadow-black/40 overflow-hidden py-1">
          {LANGUAGES.map(l => (
            <button
              key={l.value}
              type="button"
              onClick={() => { onChange(l.value); setOpen(false); }}
              className={`w-full text-left px-3 py-1.5 text-[12.5px] font-medium cursor-pointer border-none transition-colors font-[inherit]
                ${l.value === value
                  ? "bg-violet-50 dark:bg-violet-500/10 text-violet-600 dark:text-violet-400"
                  : "text-zinc-700 dark:text-zinc-200 hover:bg-zinc-50 dark:hover:bg-white/6"
                }`}
            >
              {l.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

/* ─── Main page ──────────────────────────────────────────────────────────── */
export default function SpeechToTextPage() {
  const [file,        setFile]        = useState<File | null>(null);
  const [language,    setLanguage]    = useState("auto");
  const [status,      setStatus]      = useState<"idle" | "uploading" | "transcribing" | "done" | "error">("idle");
  const [progress,    setProgress]    = useState(0);
  const [result,      setResult]      = useState<TranscribeResult | null>(null);
  const [error,       setError]       = useState<string | null>(null);
  const [copied,      setCopied]      = useState(false);
  const [dragging,    setDragging]    = useState(false);
  const [svcStatus,   setSvcStatus]   = useState<WhisperStatus | null>(null);

  // The on-device Whisper model (chosen in Settings -> Local AI -> Speech).
  const [modelLabel,  setModelLabel]  = useState("");
  useEffect(() => {
    const refresh = () => {
      const size = getWhisperModel();
      setModelLabel(WHISPER_MODELS.find(m => m.size === size)?.label ?? size);
    };
    refresh();
    window.addEventListener("focus", refresh);
    return () => window.removeEventListener("focus", refresh);
  }, []);

  // Mic recording state
  const [recording,   setRecording]   = useState(false);
  const [recSeconds,  setRecSeconds]  = useState(0);
  const recorderRef  = useRef<MediaRecorder | null>(null);
  const chunksRef    = useRef<Blob[]>([]);
  const recTimerRef  = useRef<ReturnType<typeof setInterval> | null>(null);

  const fileRef = useRef<HTMLInputElement>(null);

  /* Poll service status */
  useEffect(() => {
    const check = () => apiWhisperStatus().then(setSvcStatus).catch((e) => { logDebug("voice-to-text", "whisper status check failed", e); setSvcStatus({ running: false }); });
    check();
    const t = setInterval(check, 15_000);
    return () => clearInterval(t);
  }, []);

  /* ── File handling ── */
  const pickFile = useCallback((f: File) => {
    setFile(f); setResult(null); setError(null); setStatus("idle");
  }, []);

  function onDrop(e: React.DragEvent) {
    e.preventDefault(); setDragging(false);
    const f = e.dataTransfer.files[0];
    if (f) pickFile(f);
  }

  function onInputChange(e: React.ChangeEvent<HTMLInputElement>) {
    const f = e.target.files?.[0];
    if (f) pickFile(f);
  }

  /* ── Mic recording ── */
  async function startRecording() {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const mime = MediaRecorder.isTypeSupported("audio/webm") ? "audio/webm" : "audio/ogg";
      const rec = new MediaRecorder(stream, { mimeType: mime });
      chunksRef.current = [];
      rec.ondataavailable = e => { if (e.data.size > 0) chunksRef.current.push(e.data); };
      rec.onstop = () => {
        const blob = new Blob(chunksRef.current, { type: mime });
        const recorded = new File([blob], `recording-${Date.now()}.${mime === "audio/webm" ? "webm" : "ogg"}`, { type: mime });
        stream.getTracks().forEach(t => t.stop());
        pickFile(recorded);
      };
      rec.start(100);
      recorderRef.current = rec;
      setRecording(true);
      setRecSeconds(0);
      recTimerRef.current = setInterval(() => setRecSeconds(s => s + 1), 1000);
    } catch (e) {
      logWarn("voice-to-text", "microphone access failed", e);
      setError(humanizeError(e, { operation: "access microphone" }));
    }
  }

  function stopRecording() {
    recorderRef.current?.stop();
    recorderRef.current = null;
    if (recTimerRef.current) { clearInterval(recTimerRef.current); recTimerRef.current = null; }
    setRecording(false);
  }

  /* ── Transcribe (on-device Whisper) ── */
  async function transcribe() {
    if (!file) return;
    setStatus("transcribing"); setProgress(0); setError(null); setResult(null);

    // transcript-store runs whisper.cpp on this machine (downloads the model once).
    const src = URL.createObjectURL(file);
    try {
      const a = await getVoiceTranscript(src, {
        language: language === "auto" ? "auto" : language,
        force: true,
        onProgress: (p) => setProgress(Math.round(p.pct)),
      });
      setResult({
        text: a.text,
        duration: a.duration,
        language: language === "auto" ? "auto" : language,
        model: a.model ?? "Local Whisper",
      });
      setStatus("done");
    } catch (e) {
      logWarn("voice-to-text", "transcription failed", e);
      setError(humanizeError(e, { operation: "transcribe" }));
      setStatus("error");
    } finally {
      URL.revokeObjectURL(src);
    }
  }

  /* ── Copy ── */
  function copyText() {
    if (!result?.text) return;
    navigator.clipboard.writeText(result.text).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    });
  }

  function downloadTxt() {
    if (!result?.text) return;
    const blob = new Blob([result.text], { type: "text/plain" });
    void saveBlobToDisk(blob, `transcript-${Date.now()}.txt`).catch(e => surfaceError(e, { operation: "save transcript" }));
  }

  function reset() {
    setFile(null); setResult(null); setError(null); setStatus("idle"); setProgress(0);
    if (fileRef.current) fileRef.current.value = "";
  }

  const busy = status === "uploading" || status === "transcribing";

  return (
    <AppLayout>
      <div className="flex flex-col h-full min-h-0 overflow-hidden">

        {/* ── Top bar (Text-to-Voice style): language + record (left) · status (right) ── */}
        <div className="flex items-center justify-between gap-3 px-5 py-2.5 border-b border-zinc-200 dark:border-white/8 shrink-0">
          <div className="flex items-center gap-2">
            <LangSelect value={language} onChange={setLanguage} />
            {!recording ? (
              <button
                onClick={startRecording}
                disabled={busy}
                className="flex items-center gap-1.5 h-9 px-3 rounded-xl text-[12px] font-semibold cursor-pointer font-[inherit] border transition-all disabled:opacity-40
                  bg-zinc-50 dark:bg-white/4 border-zinc-200 dark:border-white/10
                  text-zinc-600 dark:text-zinc-300 hover:border-purple-300 dark:hover:border-purple-500/40 hover:text-purple-500"
              >
                <Circle size={10} className="text-red-400 fill-red-400" />Record
              </button>
            ) : (
              <button
                onClick={stopRecording}
                className="flex items-center gap-1.5 h-9 px-3 rounded-xl text-[12px] font-semibold cursor-pointer font-[inherit] border transition-all animate-pulse
                  bg-red-50 dark:bg-red-500/10 border-red-200 dark:border-red-500/30 text-red-500"
              >
                <Square size={10} className="fill-red-500" />Stop · {fmtDuration(recSeconds)}
              </button>
            )}
          </div>

          {/* Simple service status — just Online / Offline */}
          <div className="flex items-center gap-2 px-3 py-1.5 rounded-full border border-zinc-200 dark:border-white/8 bg-white dark:bg-white/3">
            <span className={`w-1.5 h-1.5 rounded-full shrink-0 ${svcStatus?.running ? "bg-emerald-500" : "bg-zinc-400"}`} />
            <span className="text-[11.5px] font-semibold text-zinc-700 dark:text-zinc-200">{svcStatus?.running ? "Online" : "Offline"}</span>
            {!svcStatus?.running && (
              <button onClick={() => openSettings("local-ai")} className="text-[10.5px] font-semibold text-zinc-400 hover:text-violet-500 transition-colors bg-transparent border-none cursor-pointer p-0 font-[inherit]">Setup →</button>
            )}
          </div>
        </div>

        {/* ── Split: fixed left settings panel + scrollable result/main ── */}
        <div className="relative flex flex-1 min-h-0">

          {/* LEFT: fixed settings panel */}
          {/* Transparent so the ambient AppBackground gradient shows through (the
              border-r still separates it from the result area). */}
          <div className="w-96 shrink-0 flex flex-col border-r border-zinc-200 dark:border-white/8 overflow-hidden order-1">
            {/* overflow-x-hidden: `overflow-y-auto` forces the x-axis to `auto` too
                (CSS spec), which can surface a stray horizontal scrollbar. */}
            <div className="flex-1 overflow-y-auto overflow-x-hidden px-5 py-5 space-y-4">

              {/* Audio input */}
              <div className="bg-white dark:bg-white/3 border border-zinc-200 dark:border-white/8 rounded-2xl overflow-hidden">
                <div className="flex items-center gap-2 px-4 py-3 border-b border-zinc-100 dark:border-white/6">
                  <FileAudio size={13} className="text-violet-500" />
                  <span className="text-[13px] font-semibold text-zinc-800 dark:text-zinc-100">Audio</span>
                </div>
                <div
                  onDragOver={e => { e.preventDefault(); setDragging(true); }}
                  onDragLeave={() => setDragging(false)}
                  onDrop={onDrop}
                  onClick={() => !file && fileRef.current?.click()}
                  className={`relative flex flex-col items-center justify-center gap-3 px-5 py-8 transition-all ${
                    file ? "cursor-default" : "cursor-pointer"
                  } ${dragging ? "bg-violet-50/60 dark:bg-violet-500/5" : "bg-transparent"}`}
                >
                  <input ref={fileRef} type="file" accept={ACCEPT} className="hidden" onChange={onInputChange} />

                  {file ? (
                    <div className="flex items-center gap-3 w-full">
                      <div className="w-10 h-10 rounded-xl bg-purple-50 dark:bg-purple-500/10 border border-purple-200 dark:border-purple-500/20 flex items-center justify-center shrink-0">
                        <FileAudio size={16} className="text-purple-500" />
                      </div>
                      <div className="flex-1 min-w-0">
                        <p className="text-[13px] font-semibold text-zinc-800 dark:text-zinc-100 truncate">{file.name}</p>
                        <p className="text-[11px] text-zinc-400 mt-0.5">{fmtSize(file.size)}</p>
                      </div>
                      <button
                        onClick={e => { e.stopPropagation(); reset(); }}
                        className="w-7 h-7 rounded-lg flex items-center justify-center text-zinc-400 hover:text-red-400 hover:bg-red-50 dark:hover:bg-red-500/10 transition-all cursor-pointer border-none bg-transparent"
                      >
                        <X size={14} />
                      </button>
                    </div>
                  ) : (
                    <>
                      <div className={`w-12 h-12 rounded-2xl flex items-center justify-center border-2 border-dashed transition-all ${
                        dragging ? "border-violet-400 bg-violet-50 dark:bg-violet-500/10" : "border-zinc-200 dark:border-white/10"
                      }`}>
                        <Upload size={20} className={dragging ? "text-violet-500" : "text-zinc-300 dark:text-zinc-600"} />
                      </div>
                      <div className="text-center">
                        <p className="text-[12.5px] font-semibold text-zinc-600 dark:text-zinc-300">Drop an audio file or click to browse</p>
                        <p className="text-[10.5px] text-zinc-400 mt-1">MP3, WAV, OGG, M4A, FLAC, WebM, AAC, OPUS, MP4 · Max 500 MB</p>
                      </div>
                    </>
                  )}
                </div>
              </div>

              {/* Engine — no overflow-hidden so the picker dropdown isn't clipped */}
              <div className="bg-white dark:bg-white/3 border border-zinc-200 dark:border-white/8 rounded-2xl">
                <div className="flex items-center gap-2 px-4 py-3 border-b border-zinc-100 dark:border-white/6">
                  <Sparkles size={13} className="text-violet-500" />
                  <span className="text-[13px] font-semibold text-zinc-800 dark:text-zinc-100">Engine</span>
                </div>
                <div className="p-4 flex items-center gap-3">
                  <div className="w-9 h-9 rounded-xl bg-violet-50 dark:bg-violet-500/10 border border-violet-200 dark:border-violet-500/20 flex items-center justify-center shrink-0">
                    <Cpu size={15} className="text-violet-500" />
                  </div>
                  <div className="flex-1 min-w-0">
                    <p className="text-[13px] font-semibold text-zinc-800 dark:text-zinc-100">On-device Whisper</p>
                    <p className="text-[11px] text-zinc-400 truncate">{modelLabel || "—"} · free, offline</p>
                  </div>
                  <button onClick={() => openSettings("local-ai")}
                    className="h-7 px-2.5 rounded-lg text-[11px] font-semibold cursor-pointer font-[inherit] border border-zinc-200 dark:border-white/10 bg-zinc-50 dark:bg-white/4 text-zinc-600 dark:text-zinc-300 hover:border-zinc-300 dark:hover:border-white/20 transition-all shrink-0">
                    Change
                  </button>
                </div>
              </div>

            </div>

            {/* Pinned footer: Transcribe action */}
            <div className="shrink-0 border-t border-zinc-200 dark:border-white/8 px-4 py-3 bg-zinc-50/70 dark:bg-zinc-900 flex flex-col gap-2.5">
              {busy && (
                <div>
                  <div className="w-full h-1.5 rounded-full bg-zinc-100 dark:bg-white/6 overflow-hidden">
                    <div
                      className="h-full rounded-full transition-all duration-300"
                      style={{
                        width: status === "transcribing" ? "100%" : `${progress}%`,
                        background: "linear-gradient(90deg,#3D7EFD,#0047D1)",
                        animation: status === "transcribing" ? "pulse 1.5s ease-in-out infinite" : undefined,
                      }}
                    />
                  </div>
                  <p className="text-[10.5px] text-zinc-400 mt-1.5 text-center">
                    {status === "uploading" ? `Uploading… ${Math.round(progress)}%` : "Transcribing — this may take a moment…"}
                  </p>
                </div>
              )}
              {status === "error" && error && (
                <div className="flex items-start gap-2 px-3 py-2 rounded-lg border border-red-200 dark:border-red-500/25 bg-red-50 dark:bg-red-500/8">
                  <AlertCircle size={12} className="text-red-500 shrink-0 mt-0.5" />
                  <p className="text-[11px] text-red-600 dark:text-red-400 leading-relaxed flex-1">{error}</p>
                </div>
              )}
              <button
                onClick={transcribe}
                disabled={!file || busy || !svcStatus?.running}
                className="w-full h-11 flex items-center justify-center gap-2 rounded-xl text-[14px] font-bold text-white cursor-pointer font-[inherit] border-none transition-all disabled:opacity-40 disabled:cursor-not-allowed"
                style={{ background: "linear-gradient(135deg,#0047D1 0%,#0057FC 100%)", boxShadow: file ? "0 4px 20px rgba(0,71,209,0.28)" : "none" }}
              >
                {busy
                  ? <><Loader2 size={16} className="animate-spin" />Transcribing…</>
                  : <><Sparkles size={15} />Transcribe Audio</>}
              </button>
            </div>
          </div>

          {/* RIGHT: result / empty state */}
          <div className="flex-1 min-w-0 overflow-y-auto order-2">
            {result && status === "done" ? (
              <div className="px-8 py-6">
                <div className="bg-white dark:bg-white/[0.03] border border-zinc-200 dark:border-white/8 rounded-2xl overflow-hidden max-w-3xl">

                  {/* Result header */}
                  <div className="flex items-center gap-3 px-4 py-3 border-b border-zinc-100 dark:border-white/6 flex-wrap">
                    <div className="flex items-center gap-1.5 px-2.5 py-1 rounded-full bg-emerald-50 dark:bg-emerald-500/10 border border-emerald-200 dark:border-emerald-500/20">
                      <Check size={10} className="text-emerald-500" strokeWidth={2.5} />
                      <span className="text-[11px] font-semibold text-emerald-600 dark:text-emerald-400">Transcribed</span>
                    </div>
                    <div className="flex items-center gap-3 text-[11px] text-zinc-400 dark:text-zinc-500">
                      <span className="flex items-center gap-1"><Clock size={10} />{fmtDuration(result.duration)}</span>
                      <span>{wordsCount(result.text)} words</span>
                      <span className="uppercase font-semibold">{result.language}</span>
                    </div>
                    <div className="flex-1" />
                    <div className="flex items-center gap-1.5">
                      <button onClick={copyText}
                        className="flex items-center gap-1.5 h-7 px-2.5 rounded-lg text-[11px] font-semibold cursor-pointer font-[inherit] border border-zinc-200 dark:border-white/10 bg-zinc-50 dark:bg-white/4 text-zinc-600 dark:text-zinc-300 hover:border-zinc-300 dark:hover:border-white/20 transition-all">
                        {copied ? <Check size={10} className="text-emerald-500" /> : <Copy size={10} />}
                        {copied ? "Copied" : "Copy"}
                      </button>
                      <button onClick={downloadTxt}
                        className="flex items-center gap-1.5 h-7 px-2.5 rounded-lg text-[11px] font-semibold cursor-pointer font-[inherit] border border-zinc-200 dark:border-white/10 bg-zinc-50 dark:bg-white/4 text-zinc-600 dark:text-zinc-300 hover:border-zinc-300 dark:hover:border-white/20 transition-all">
                        <Download size={10} />TXT
                      </button>
                      <button onClick={reset}
                        className="flex items-center gap-1.5 h-7 px-2.5 rounded-lg text-[11px] font-semibold cursor-pointer font-[inherit] border border-zinc-200 dark:border-white/10 bg-zinc-50 dark:bg-white/4 text-zinc-600 dark:text-zinc-300 hover:border-red-200 dark:hover:border-red-500/30 hover:text-red-500 transition-all">
                        <RefreshCw size={10} />New
                      </button>
                    </div>
                  </div>

                  {/* Transcript text */}
                  <div className="p-4">
                    <textarea
                      readOnly
                      value={result.text}
                      rows={14}
                      className="w-full resize-none bg-transparent border-none outline-none text-[14px] leading-relaxed text-zinc-700 dark:text-zinc-200 font-[inherit]"
                    />
                  </div>

                  {/* Meta footer */}
                  <div className="flex items-center gap-4 px-4 py-2.5 border-t border-zinc-100 dark:border-white/6 bg-zinc-50/60 dark:bg-white/[0.02] flex-wrap">
                    <span className="text-[11px] text-zinc-400">Model: <strong className="text-zinc-600 dark:text-zinc-300">{result.model}</strong></span>
                    <span className="text-[11px] text-zinc-400">Language: <strong className="text-zinc-600 dark:text-zinc-300 uppercase">{result.language}</strong></span>
                    <span className="text-[11px] text-zinc-400">Duration: <strong className="text-zinc-600 dark:text-zinc-300">{fmtDuration(result.duration)}</strong></span>
                  </div>
                </div>
              </div>
            ) : (
              <div className="h-full flex flex-col items-center justify-center text-center gap-3 px-8 py-6">
                <div className="w-14 h-14 rounded-2xl bg-zinc-100 dark:bg-white/5 flex items-center justify-center">
                  <FileAudio size={24} className="text-zinc-300 dark:text-zinc-600" />
                </div>
                <div>
                  <p className="text-[14px] font-semibold text-zinc-500 dark:text-zinc-400">Your transcript will appear here</p>
                  <p className="text-[12px] text-zinc-400 dark:text-zinc-500 mt-1">Upload or record audio, then Transcribe. The first run downloads the Whisper model.</p>
                </div>
              </div>
            )}
          </div>
        </div>
      </div>
    </AppLayout>
  );
}
