"use client";
import { useState, useEffect, useRef, useCallback } from "react";
import { kvGet, kvSet } from "@/lib/kv-store";
import {
  Mic, MessageSquare, Eye, Download, CheckCircle2,
  Loader2, HardDrive, MemoryStick, Trash2, Wifi, WifiOff,
  RefreshCw, Square, AlertCircle, Play, FileText, Brain, Ear,
} from "lucide-react";
import { WhisperLocalCard } from "@/components/settings/whisper-local-card";
import { SettingsHeader } from "../settings-header";
import { logDebug, logWarn } from "@/lib/log";
import { surfaceError } from "@/lib/toast";
import {
  ttsModelStatus, downloadTtsModel, type LocalTtsModel,
} from "@/lib/tts/local-tts";
import { BrainTab } from "@/components/settings/brain-tab";
import {
  loadLocalAIConfig, saveLocalAIConfig, type LocalAIConfig,
} from "@/lib/brain/local-ai-config";

/* ─── Tauri ──────────────────────────────────────────────────────────────── */
const isTauri = typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

async function tauriInvoke<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  const { invoke } = await import("@tauri-apps/api/core");
  return invoke<T>(cmd, args);
}
async function tauriListen<T>(event: string, cb: (p: T) => void): Promise<() => void> {
  const { listen } = await import("@tauri-apps/api/event");
  return listen<T>(event, e => cb(e.payload));
}

/* ─── Config ─────────────────────────────────────────────────────────────── */
type Category = "Vision + Text" | "Voice";
type Driver    = "ollama" | "native";
/** Native engine kind — drives which Tauri bridge installs/runs the model. */
type Engine    = "tts";

interface ModelDef {
  id: string; driver: Driver;
  /** Ollama model tag (driver "ollama"). */
  ollamaName?: string;
  /** Which in-process/native engine backs this card (driver "native"). */
  engine?: Engine;
  name: string; version?: string; category: Category;
  desc: string; size: string; ram: string; tasks: string[];
}

const MODELS: ModelDef[] = [
  {
    id: "llama32", driver: "ollama", ollamaName: "llama3.2:3b",
    name: "Llama 3.2", version: "3B", category: "Vision + Text",
    desc: "Meta's fast language model — runs on CPU, no GPU needed. Great for scripts.",
    size: "2.0 GB", ram: "4 GB RAM",
    tasks: ["Scripts"],
  },
  {
    id: "qwen25vl", driver: "ollama", ollamaName: "qwen2.5vl:7b",
    name: "Qwen2.5-VL", version: "7B", category: "Vision + Text",
    desc: "Multimodal — understands images. Good for visual scripts and image-aware writing.",
    size: "4.7 GB", ram: "8 GB VRAM",
    tasks: ["Scripts"],
  },
  {
    id: "kokoro", driver: "native", engine: "tts",
    name: "Kokoro", version: "82M", category: "Voice",
    desc: "Multi-language neural voices — 53 voices, runs on CPU. One-click, on-device, free. No Docker, no Python.",
    size: "~330 MB", ram: "2 GB RAM",
    tasks: ["Voiceover"],
  },
  {
    id: "supertonic", driver: "native", engine: "tts",
    name: "Supertonic", version: "v3", category: "Voice",
    desc: "Studio-grade 44.1 kHz neural voices — on-device, free. Ten preset voices. Downloads once on first use (Windows only; offered only when this build ships a download source).",
    size: "~360 MB", ram: "2 GB RAM",
    tasks: ["Voiceover"],
  },
];

/* ─── Tabs ───────────────────────────────────────────────────────────────
   The page grew past one scannable list, so it is split by what the model DOES.
   "Brain" is the text+vision tier (CLI brains + Ollama); the rest map 1:1 onto
   the existing model categories. */
type TabId = "brain" | "voice" | "speech";
const TABS: { id: TabId; label: string; icon: React.ElementType }[] = [
  { id: "brain",  label: "Brain",  icon: Brain },
  { id: "voice",  label: "Voice",  icon: Mic },
  { id: "speech", label: "Speech", icon: Ear },
];
/** Which model-card category each tab renders. "speech" is Whisper (its own card). */
const TAB_CATEGORY: Partial<Record<TabId, Category>> = {
  brain: "Vision + Text",
  voice: "Voice",
};
/** Group heading for the card list. Under Brain the cards ARE the Ollama models,
 *  so "Vision + Text" would just restate the tab — name the driver instead. */
const CARD_GROUP_LABEL: Partial<Record<TabId, string>> = { brain: "Ollama models" };

const CAT: Record<Category, { color: string; bg: string; icon: React.ElementType }> = {
  "Vision + Text": { color: "#6366f1", bg: "#6366f115", icon: Eye },
  "Voice":         { color: "#3b82f6", bg: "#3b82f615", icon: Mic },
};
const TASK_META: Record<string, { icon: React.ElementType; label: string }> = {
  "Scripts":   { icon: FileText,  label: "Scripts"   },
  "Voiceover": { icon: Mic,       label: "Voiceover" },
};

/* ─── Persisted config ───────────────────────────────────────────────────── */
/* The shape + read/write live in @/lib/brain/local-ai-config so the pickers,
   Script Writer, the AI Director and this page all agree on one blob. */

/* ─── HTTP helpers (Ollama) ──────────────────────────────────────────────── */
async function httpPingJson(url: string): Promise<boolean> {
  try { return (await fetch(url, { signal: AbortSignal.timeout(2500) })).ok; } catch (e) { logDebug("local-ai-section", "HTTP ping failed", e); return false; }
}
async function httpListOllamaModels(url: string): Promise<string[]> {
  try { const r = await fetch(`${url}/api/tags`); const d = await r.json(); return (d.models ?? []).map((m: { name: string }) => m.name); }
  catch (e) { logWarn("local-ai-section", "Failed to list Ollama models", e); return []; }
}
async function httpDeleteOllamaModel(url: string, name: string) {
  await fetch(`${url}/api/delete`, { method: "DELETE", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name }) });
}

/* ─── Phase types ────────────────────────────────────────────────────────── */
type OllamaPhase = "checking" | "not_installed" | "not_running" | "starting" | "connected";

/* ─── Status chip (module-level to keep stable identity across renders) ──── */
function OllamaChip({ phase, ver }: { phase: OllamaPhase; ver: string }) {
  const color = phase === "connected" ? "#10b981" : phase === "starting" ? "#0057FC" : "#71717a";
  const label = phase === "connected"   ? `Ollama${ver ? ` · ${ver}` : ""}` :
                phase === "starting"    ? "Ollama starting…" :
                phase === "checking"    ? "Checking…" :
                phase === "not_running" ? "Ollama not running" : "Ollama not installed";
  return (
    <span className="inline-flex items-center gap-1.5 text-[11px] font-medium px-2 py-0.5 rounded-full border"
      style={{ color, borderColor: color + "40", background: color + "10" }}>
      {(phase === "checking" || phase === "starting") && <Loader2 size={10} className="animate-spin" />}
      {phase === "connected" && <Wifi size={10} />}
      {(phase === "not_installed" || phase === "not_running") && <WifiOff size={10} />}
      {label}
    </span>
  );
}

/* ─── Terminal panel ─────────────────────────────────────────────────────── */
type TerminalLine = { text: string; type: "out" | "err" | "cmd" | "ok" };

function TerminalPanel({
  lines, title, running, failed, onClose, onRetry,
}: {
  lines: TerminalLine[]; title: string; running: boolean;
  failed: boolean; onClose: () => void; onRetry?: () => void;
}) {
  const endRef = useRef<HTMLDivElement>(null);
  const [pos, setPos]   = useState<{ x: number; y: number } | null>(null); // null = default (top-right)
  const [size, setSize] = useState<{ w: number; h: number }>({ w: 360, h: 400 });
  const [minimized, setMinimized] = useState(false);
  const drag = useRef<{ kind: "move" | "resize"; sx: number; sy: number; ox: number; oy: number; ow: number; oh: number } | null>(null);

  useEffect(() => { if (!minimized) endRef.current?.scrollIntoView({ behavior: "smooth" }); }, [lines, minimized]);

  useEffect(() => {
    function onMove(e: MouseEvent) {
      const s = drag.current; if (!s) return;
      const dx = e.clientX - s.sx, dy = e.clientY - s.sy;
      if (s.kind === "move") {
        const startX = pos?.x ?? (window.innerWidth - size.w - 16);
        const startY = pos?.y ?? 56;
        const _ = startX; const __ = startY; void _; void __; // origins captured in s.ox/oy
        setPos({
          x: Math.max(8, Math.min(window.innerWidth - 80, s.ox + dx)),
          y: Math.max(8, Math.min(window.innerHeight - 40, s.oy + dy)),
        });
      } else {
        setSize({
          w: Math.max(260, Math.min(window.innerWidth - 24, s.ow + dx)),
          h: Math.max(140, Math.min(window.innerHeight - 80, s.oh + dy)),
        });
      }
    }
    function onUp() { drag.current = null; }
    document.addEventListener("mousemove", onMove);
    document.addEventListener("mouseup", onUp);
    return () => { document.removeEventListener("mousemove", onMove); document.removeEventListener("mouseup", onUp); };
  }, [pos, size]);

  function startDrag(kind: "move" | "resize", e: React.MouseEvent) {
    e.preventDefault();
    const startX = pos?.x ?? (window.innerWidth - size.w - 16);
    const startY = pos?.y ?? 56;
    drag.current = { kind, sx: e.clientX, sy: e.clientY, ox: startX, oy: startY, ow: size.w, oh: size.h };
    if (kind === "move" && !pos) setPos({ x: startX, y: startY });
  }

  function lineColor(t: TerminalLine["type"]) {
    if (t === "err") return "#ff6b6b";
    if (t === "ok")  return "#50fa7b";
    if (t === "cmd") return "#8be9fd";
    return "rgba(255,255,255,0.8)";
  }

  const positionStyle: React.CSSProperties = pos
    ? { left: pos.x, top: pos.y }
    : { right: 16, top: 56 };

  return (
    <div style={{
      position: "fixed", ...positionStyle,
      width: size.w, height: minimized ? "auto" : size.h,
      zIndex: 200,
      borderRadius: 10, overflow: "hidden",
      background: "#0d0d0f", border: "1px solid rgba(255,255,255,0.12)",
      boxShadow: "0 32px 80px rgba(0,0,0,0.7)",
      display: "flex", flexDirection: "column",
    }}>
      {/* Title bar - drag handle */}
      <div onMouseDown={(e) => startDrag("move", e)} style={{
        background: "#1c1c1f", padding: "7px 11px",
        display: "flex", alignItems: "center", gap: 7,
        borderBottom: minimized ? "none" : "1px solid rgba(255,255,255,0.07)",
        userSelect: "none", cursor: "move",
      }}>
        <span onClick={onClose} onMouseDown={(e) => e.stopPropagation()}
          style={{ width: 11, height: 11, borderRadius: "50%", background: "#ff5f57", cursor: "pointer", flexShrink: 0 }}
          title="Close" />
        <span onClick={() => setMinimized(m => !m)} onMouseDown={(e) => e.stopPropagation()}
          style={{ width: 11, height: 11, borderRadius: "50%", background: "#ffbd2e", cursor: "pointer", flexShrink: 0 }}
          title={minimized ? "Expand" : "Minimize"} />
        <span style={{ width: 11, height: 11, borderRadius: "50%", background: running ? "#28c840" : failed ? "#ff5f57" : "#555", flexShrink: 0 }} />
        <span style={{ flex: 1, textAlign: "center", fontSize: 10.5, color: "rgba(255,255,255,0.4)", fontFamily: "system-ui,-apple-system,sans-serif", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", padding: "0 6px" }}>
          {title}{minimized && running ? " · running…" : minimized && failed ? " · failed" : ""}
        </span>
        <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
          {failed && onRetry && (
            <button onMouseDown={(e) => e.stopPropagation()} onClick={onRetry}
              style={{ background: "none", border: "none", color: "#0057FC", cursor: "pointer", fontSize: 10, fontWeight: 600, padding: 0 }}>Retry</button>
          )}
          <button onMouseDown={(e) => e.stopPropagation()} onClick={onClose}
            style={{ background: "none", border: "none", color: "rgba(255,255,255,0.3)", cursor: "pointer", fontSize: 14, lineHeight: 1, padding: 0 }}>×</button>
        </div>
      </div>

      {/* Output */}
      {!minimized && (
        <div style={{ padding: "8px 0", flex: 1, overflowY: "auto", minHeight: 0, position: "relative" }}>
          {lines.map((l, i) => (
            <div key={i} style={{
              fontFamily: "'JetBrains Mono','Fira Code',Consolas,monospace",
              fontSize: 11, lineHeight: 1.6, color: lineColor(l.type),
              padding: "0 14px", whiteSpace: "pre-wrap", overflowWrap: "anywhere",
            }}>
              {l.type === "cmd" && <span style={{ color: "#50fa7b", marginRight: 5 }}>$</span>}
              {l.text}
            </div>
          ))}
          {running && (
            <div style={{ padding: "0 14px", display: "flex", alignItems: "center", gap: 5, marginTop: 2 }}>
              <span style={{ color: "#50fa7b", fontFamily: "monospace", fontSize: 11 }}>$</span>
              <span className="animate-pulse" style={{ display: "inline-block", width: 6, height: 12, background: "rgba(255,255,255,0.65)" }} />
            </div>
          )}
          {failed && (
            <div style={{ padding: "6px 14px 2px" }}>
              <span style={{ fontFamily: "monospace", fontSize: 11, color: "#ff6b6b" }}>✗ Process exited with error</span>
            </div>
          )}
          <div ref={endRef} />

          {/* Resize handle */}
          <div onMouseDown={(e) => { e.stopPropagation(); startDrag("resize", e); }}
            style={{
              position: "absolute", right: 0, bottom: 0,
              width: 14, height: 14, cursor: "nwse-resize",
              background: "linear-gradient(135deg, transparent 50%, rgba(255,255,255,0.18) 50%, rgba(255,255,255,0.18) 60%, transparent 60%, transparent 75%, rgba(255,255,255,0.18) 75%, rgba(255,255,255,0.18) 85%, transparent 85%)",
            }}
          />
        </div>
      )}
    </div>
  );
}

/* ─── Page ───────────────────────────────────────────────────────────────── */
export default function LocalAIPage() {
  // Client-only (rendered inside the settings modal), so read storage directly.
  const [cfg, setCfgRaw]   = useState<LocalAIConfig>(() => loadLocalAIConfig());
  const setCfg = useCallback((fn: (p: LocalAIConfig) => LocalAIConfig) => {
    setCfgRaw(prev => { const next = fn(prev); saveLocalAIConfig(next); return next; });
  }, []);

  /* ── Tabs ─────────────────────────────────────────────────────────────
     Brain / Voice / Speech. Splitting the page keeps each concern scannable. */
  const [tab, setTab] = useState<TabId>("brain");

  /* ── Ollama state ─────────────────────────────────────────────────────── */
  const [ollamaPhase, setOllamaPhase]   = useState<OllamaPhase>("checking");
  const [ollamaVer, setOllamaVer]       = useState("");
  const [installedModels, setInstalledModels] = useState<string[]>([]);

  // Persist installed Ollama model list so the UI shows correct state even when Ollama isn't running
  useEffect(() => {
    kvGet<string[]>("ollama_installed").then(v => { if (v) setInstalledModels(v); });
  }, []);
  useEffect(() => {
    kvSet("ollama_installed", installedModels);
  }, [installedModels]);

  const [ollamaInstalling, setOllamaInstalling] = useState(false);
  const [pendingOllamaPull, setPendingOllamaPull] = useState<string | null>(null);

  const [pullProgress, setPullProgress] = useState<Record<string, number>>({});
  const [pullStatus,   setPullStatus]   = useState<Record<string, string>>({});
  const [pulling,      setPulling]      = useState<Record<string, boolean>>({});

  /* ── Native model state (Kokoro / Supertonic) ─────────────────────────── */
  const [nativeInstalled, setNativeInstalled] = useState<Record<string, boolean>>({});
  // A native model is offered only when installed or downloadable on this build
  // (Supertonic has no public source — hidden unless the vendor configured one).
  const [nativeAvailable, setNativeAvailable] = useState<Record<string, boolean>>({ kokoro: true, supertonic: false });
  const [nativeInstalling, setNativeInstalling] = useState<Record<string, boolean>>({});
  const [nativeProgress, setNativeProgress]   = useState<Record<string, number>>({});

  const abortRefs    = useRef<Record<string, AbortController>>({});
  const ollamaPoll   = useRef<ReturnType<typeof setInterval> | null>(null);

  /* ── Terminal state ────────────────────────────────────────────────────── */
  const [termOpen, setTermOpen]       = useState(false);
  const [termLines, setTermLines]     = useState<TerminalLine[]>([]);
  const [termTitle, setTermTitle]     = useState("Terminal");
  const [termRunning, setTermRunning] = useState(false);
  const [termFailed, setTermFailed]   = useState(false);
  const termRetry = useRef<(() => void) | null>(null);

  function tlog(text: string, type: TerminalLine["type"] = "out") {
    setTermLines(l => [...l.slice(-500), { text, type }]);
  }
  function openTerm(title: string, retry?: () => void) {
    setTermOpen(true);
    setTermTitle(title);
    setTermLines([]);
    setTermRunning(true);
    setTermFailed(false);
    termRetry.current = retry ?? null;
  }
  function termDone(ok: boolean) {
    setTermRunning(false);
    setTermFailed(!ok);
    if (ok) tlog("Process completed successfully.", "ok");
  }

  /* ── Check Ollama ─────────────────────────────────────────────────────── */
  const checkOllama = useCallback(async () => {
    setOllamaPhase("checking");
    try {
      if (isTauri) {
        const { installed, version } = await tauriInvoke<{ installed: boolean; version: string }>("ollama_check");
        if (!installed) { setOllamaPhase("not_installed"); return; }
        setOllamaVer(version);
      }
      const ok = await httpPingJson(`${cfg.ollamaUrl}/api/tags`);
      if (!ok) { setOllamaPhase("not_running"); return; }
      const models = await httpListOllamaModels(cfg.ollamaUrl);
      setInstalledModels(models);
      setOllamaPhase("connected");
    } catch (e) { logDebug("local-ai-section", "Ollama check failed", e); setOllamaPhase("not_running"); }
  }, [cfg.ollamaUrl]);

  // Kick off the async Ollama probe (its first step marks the chip "checking").
  // eslint-disable-next-line react-hooks/set-state-in-effect
  useEffect(() => { checkOllama(); }, [checkOllama]);

  /* ── Poll when Ollama starting ────────────────────────────────────────── */
  useEffect(() => {
    if (ollamaPhase !== "starting") { if (ollamaPoll.current) clearInterval(ollamaPoll.current); return; }
    ollamaPoll.current = setInterval(async () => {
      const ok = await httpPingJson(`${cfg.ollamaUrl}/api/tags`);
      if (ok) { clearInterval(ollamaPoll.current!); const m = await httpListOllamaModels(cfg.ollamaUrl); setInstalledModels(m); setOllamaPhase("connected"); }
    }, 2000);
    return () => { if (ollamaPoll.current) clearInterval(ollamaPoll.current); };
  }, [ollamaPhase, cfg.ollamaUrl]);

  /* ── Auto-pull when Ollama connects ──────────────────────────────────── */
  useEffect(() => {
    if (ollamaPhase !== "connected" || !pendingOllamaPull) return;
    const m = MODELS.find(m => m.id === pendingOllamaPull);
    // Consume the queued pull exactly once, when Ollama comes up.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setPendingOllamaPull(null);
    if (m) pullOllamaModel(m);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ollamaPhase, pendingOllamaPull]);

  /* ── Check native models (presence on disk) ───────────────────────────── */
  const refreshNativeStatus = useCallback(async (model: ModelDef): Promise<boolean> => {
    if (!isTauri) { setNativeInstalled(s => ({ ...s, [model.id]: false })); return false; }
    try {
      const status = await ttsModelStatus(model.id as LocalTtsModel);
      setNativeInstalled(s => ({ ...s, [model.id]: status.installed }));
      setNativeAvailable(s => ({ ...s, [model.id]: status.available }));
      return status.installed;
    } catch (e) {
      logDebug("local-ai-section", `native status check failed for ${model.id}`, e);
      setNativeInstalled(s => ({ ...s, [model.id]: false }));
      return false;
    }
  }, []);

  const checkNative = useCallback(async () => {
    const natives = MODELS.filter(m => m.driver === "native");
    const present = await Promise.all(natives.map(refreshNativeStatus));
    // Auto-default task routing: when a native engine is already on disk and the
    // task has no explicit route, point it at this engine (local wins, free).
    setCfg(c => {
      const r = { ...c.taskRouting };
      let changed = false;
      natives.forEach((m, i) => {
        if (present[i]) m.tasks.forEach(t => { if (!r[t]) { r[t] = m.id; changed = true; } });
      });
      return changed ? { ...c, taskRouting: r } : c;
    });
  }, [refreshNativeStatus, setCfg]);

  // Kick off the async on-disk model check.
  // eslint-disable-next-line react-hooks/set-state-in-effect
  useEffect(() => { checkNative(); }, [checkNative]);

  /* ── Install Ollama ───────────────────────────────────────────────────── */
  async function installOllama() {
    if (!isTauri || termRunning) return;
    openTerm("Ollama Installer", installOllama);
    setOllamaInstalling(true);
    tlog("Starting Ollama installer…", "cmd");
    const jobId = `ollama-${Date.now()}`;

    const unLine = await tauriListen<{ job_id: string; line: string; stream: string }>(
      "ollama-install-line", ({ job_id, line, stream }) => {
        if (job_id !== jobId) return;
        tlog(line, stream === "stderr" ? "err" : "out");
      }
    );
    const unDone = await tauriListen<{ job_id: string; code: number }>("ollama-install-done", async ({ job_id, code }) => {
      if (job_id !== jobId) return;
      unLine(); unDone();
      setOllamaInstalling(false);
      if (code === 0) {
        tlog("Ollama installed! Starting server…", "ok");
        try { await tauriInvoke("ollama_serve"); } catch (e) { logDebug("local-ai-section", "Failed to start Ollama server after install", e); }
        setOllamaPhase("starting");
        termDone(true);
      } else {
        tlog(`Installer exited with code ${code}.`, "err");
        setPendingOllamaPull(null);
        termDone(false);
      }
    });

    try { await tauriInvoke("ollama_install", { jobId }); }
    catch (e) {
      tlog(String(e), "err");
      setOllamaInstalling(false);
      unLine(); unDone();
      termDone(false);
    }
  }

  /* ── Pull Ollama model ────────────────────────────────────────────────── */
  async function pullOllamaModel(model: ModelDef) {
    if (!model.ollamaName) return;
    const ctrl = new AbortController();
    abortRefs.current[model.id] = ctrl;
    setPulling(p => ({ ...p, [model.id]: true }));
    setPullProgress(p => ({ ...p, [model.id]: 0 }));
    setPullStatus(p => ({ ...p, [model.id]: "Connecting…" }));
    try {
      const res = await fetch(`${cfg.ollamaUrl}/api/pull`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: model.ollamaName, stream: true }),
        signal: ctrl.signal,
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const reader = res.body!.getReader();
      const dec = new TextDecoder();
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        for (const line of dec.decode(value).split("\n").filter(Boolean)) {
          try {
            const d = JSON.parse(line) as { status?: string; total?: number; completed?: number };
            if (d.status) setPullStatus(p => ({ ...p, [model.id]: d.status! }));
            if (d.total && d.completed) setPullProgress(p => ({ ...p, [model.id]: (d.completed! / d.total!) * 100 }));
          } catch (e) { logDebug("local-ai-section", "Bad JSON chunk in Ollama pull stream", e); }
        }
      }
      setInstalledModels(await httpListOllamaModels(cfg.ollamaUrl));
      setPullProgress(p => ({ ...p, [model.id]: 100 }));
      setPullStatus(p => ({ ...p, [model.id]: "Installed" }));
    } catch (err: unknown) {
      // "Failed" alone hides the cause (Ollama down, network) — surface the reason.
      if ((err as Error)?.name !== "AbortError") {
        setPullStatus(p => ({ ...p, [model.id]: "Failed" }));
        surfaceError(err, { operation: "ollama-pull" });
      }
    } finally {
      setPulling(p => ({ ...p, [model.id]: false }));
      delete abortRefs.current[model.id];
    }
  }

  /* ── Start Ollama server (non-blocking) ──────────────────────────────── */
  async function startOllama() {
    try { await tauriInvoke("ollama_serve"); } catch (e) { logDebug("local-ai-section", "Failed to start Ollama server", e); }
    setOllamaPhase("starting");
  }

  /* ── Smart Ollama install (auto-chains setup → pull) ─────────────────── */
  async function smartOllamaInstall(model: ModelDef) {
    if (ollamaPhase === "connected") { pullOllamaModel(model); return; }
    setPendingOllamaPull(model.id);
    if (!isTauri) { setOllamaPhase("not_running"); return; }
    // "checking" means we don't yet know if installed — wait, don't trigger installer
    if (ollamaPhase === "not_installed") { await installOllama(); }
    else { await startOllama(); } // not_running / starting / checking → just start the server
  }

  /* ── Install a native model (one-click: download + extract on-device) ── */
  async function installNative(model: ModelDef) {
    if (!isTauri || nativeInstalling[model.id]) return;
    setNativeInstalling(s => ({ ...s, [model.id]: true }));
    setNativeProgress(s => ({ ...s, [model.id]: 0 }));
    try {
      const onProg = (p: { pct: number }) =>
        setNativeProgress(s => ({ ...s, [model.id]: Math.max(0, p.pct) }));
      await downloadTtsModel(model.id as LocalTtsModel, onProg);
      const installed = await refreshNativeStatus(model);
      if (installed) {
        // Make this engine the default for its tasks (local wins, free).
        setCfg(c => {
          const r = { ...c.taskRouting };
          model.tasks.forEach(t => { if (!r[t]) r[t] = model.id; });
          return { ...c, taskRouting: r };
        });
      }
    } catch (e) {
      surfaceError(e, { operation: "native-model-install" });
    } finally {
      setNativeInstalling(s => ({ ...s, [model.id]: false }));
    }
  }

  function toggleTask(task: string, modelId: string) {
    setCfg(c => {
      const r = { ...c.taskRouting };
      if (r[task] === modelId) delete r[task]; else r[task] = modelId;
      return { ...c, taskRouting: r };
    });
  }

  function isOllamaInstalled(model: ModelDef) {
    return installedModels.some(n => n === model.ollamaName || n.startsWith((model.ollamaName ?? "") + ":"));
  }

  const activeRoutes = Object.entries(cfg.taskRouting)
    .map(([task, mid]) => ({ task, model: MODELS.find(m => m.id === mid) }))
    .filter(r => r.model) as { task: string; model: ModelDef }[];

  /* ─── Render ─────────────────────────────────────────────────────────── */
  return (
    <div className="flex flex-col gap-6">

        {/* Header */}
        <SettingsHeader
          title="Local AI"
          subtitle="Run AI privately on your machine — one-click install, no Docker, no internet needed once installed."
          action={
            <div className="flex items-center gap-2 shrink-0 flex-wrap justify-end mt-0.5">
              <OllamaChip phase={ollamaPhase} ver={ollamaVer} />
              <button onClick={() => { checkOllama(); checkNative(); }}
                title="Refresh"
                className="w-7 h-7 flex items-center justify-center rounded-lg hover:bg-zinc-100 dark:hover:bg-white/6 text-zinc-400 transition border-none bg-transparent cursor-pointer">
                <RefreshCw size={12} strokeWidth={1.8} />
              </button>
            </div>
          }
        />

        {/* Tab bar */}
        <div className="flex items-center gap-1 p-1 rounded-xl bg-zinc-100/70 dark:bg-white/[0.04] border border-zinc-200/60 dark:border-white/6">
          {TABS.map(({ id, label, icon: Icon }) => {
            const active = tab === id;
            return (
              <button key={id} onClick={() => setTab(id)}
                className={`flex-1 flex items-center justify-center gap-1.5 h-8 rounded-lg text-[12px] font-semibold cursor-pointer border-none transition-colors ${
                  active
                    ? "bg-white dark:bg-white/10 text-zinc-900 dark:text-zinc-100 shadow-[0_1px_3px_rgba(0,0,0,0.06)]"
                    : "bg-transparent text-zinc-500 dark:text-zinc-400 hover:text-zinc-700 dark:hover:text-zinc-200"
                }`}>
                <Icon size={12} strokeWidth={1.9} className={active ? "text-violet-500" : ""} />
                {label}
              </button>
            );
          })}
        </div>

        {/* Ollama not running banner — only where Ollama models are shown. */}
        {isTauri && tab === "brain" && ollamaPhase === "not_running" && (
          <div className="flex items-start gap-3 px-4 py-3.5 rounded-xl border border-amber-200 dark:border-amber-500/25 bg-amber-50 dark:bg-amber-500/8">
            <AlertCircle size={14} className="text-amber-500 shrink-0 mt-0.5" />
            <div className="flex-1 min-w-0">
              <p className="text-[12.5px] font-semibold text-amber-800 dark:text-amber-300">Ollama is installed but not running</p>
              <p className="text-[12px] text-amber-700 dark:text-amber-400 mt-0.5">
                Click Start to launch the Ollama server, then install a model.
              </p>
            </div>
            <button onClick={startOllama}
              className="shrink-0 flex items-center gap-1.5 h-8 px-3.5 rounded-lg text-[12px] font-semibold cursor-pointer border border-amber-300 dark:border-amber-500/40 bg-amber-100 dark:bg-amber-500/15 text-amber-700 dark:text-amber-300 hover:bg-amber-200 dark:hover:bg-amber-500/25 transition-colors">
              <Play size={11} /> Start Ollama
            </button>
          </div>
        )}

        {/* Active routing — the one place a user sees what every task resolves to. */}
        {activeRoutes.length > 0 && (
          <div className="rounded-xl border border-zinc-200 dark:border-white/8 bg-white dark:bg-white/[0.02] overflow-hidden">
            <div className="px-4 py-2.5 border-b border-zinc-100 dark:border-white/6">
              <p className="text-[10px] font-bold uppercase tracking-widest text-zinc-400">Active task routing</p>
            </div>
            <div className="divide-y divide-zinc-100 dark:divide-white/5">
              {activeRoutes.map(({ task, model }) => {
                const { color, icon: Icon } = CAT[model.category];
                const meta = TASK_META[task] ?? { icon: MessageSquare, label: task };
                const TIcon = meta.icon;
                return (
                  <div key={task} className="flex items-center justify-between px-4 py-2.5">
                    <div className="flex items-center gap-2"><TIcon size={12} className="text-zinc-400" /><span className="text-[13px] text-zinc-600 dark:text-zinc-300">{meta.label}</span></div>
                    <div className="flex items-center gap-1.5"><Icon size={11} style={{ color }} /><span className="text-[12px] font-semibold" style={{ color }}>{model.name}</span></div>
                  </div>
                );
              })}
            </div>
          </div>
        )}

        {/* ── Brain tab — CLI brains + the default-brain picker ──────────── */}
        {tab === "brain" && (
          <BrainTab cfg={cfg} setCfg={setCfg} ollamaModels={installedModels} />
        )}

        {/* ── Whisper — Voice to Text (on-device) ─────────────────────────── */}
        {tab === "speech" && <WhisperLocalCard />}

        {/* Model cards for the active tab (Speech has no Ollama/native cards). */}
        {(TAB_CATEGORY[tab] ? [TAB_CATEGORY[tab] as Category] : []).map(cat => {
          const models = MODELS.filter(m => m.category === cat && (m.driver !== "native" || nativeAvailable[m.id] !== false));
          if (models.length === 0) return null;
          const { color, icon: CatIcon } = CAT[cat];
          return (
            <div key={cat}>
              <div className="flex items-center gap-2.5 mb-3">
                <CatIcon size={13} style={{ color }} />
                <h2 className="text-[11px] font-bold uppercase tracking-widest shrink-0" style={{ color }}>{CARD_GROUP_LABEL[tab] ?? cat}</h2>
                <span className="text-[10px] font-semibold text-zinc-400 dark:text-zinc-600 tabular-nums shrink-0">{models.length}</span>
                <div className="flex-1 h-px bg-zinc-100 dark:bg-white/6" />
              </div>

              <div className="flex flex-col gap-2.5">
                {models.map(model => {
                  const catStyle  = CAT[model.category];
                  const CatEl     = catStyle.icon;
                  const isOllama  = model.driver === "ollama";
                  const isNative  = model.driver === "native";
                  const installed = isOllama ? isOllamaInstalled(model) : !!nativeInstalled[model.id];
                  const downloading = isOllama ? !!pulling[model.id] : !!nativeInstalling[model.id];
                  const pct       = isOllama ? (pullProgress[model.id] ?? 0) : (nativeProgress[model.id] ?? 0);
                  const status    = pullStatus[model.id] ?? "";
                  const isPendingOllama = pendingOllamaPull === model.id && !downloading;

                  // Button logic
                  let btn: React.ReactNode = null;
                  if (isOllama) {
                    if (!installed && !downloading && !isPendingOllama) {
                      const needsStart = ollamaPhase === "not_running" || ollamaPhase === "starting";
                      btn = (
                        <button onClick={() => smartOllamaInstall(model)}
                          className="flex items-center gap-1.5 h-8 px-3.5 rounded-lg text-[12px] font-semibold cursor-pointer border border-zinc-200 dark:border-white/10 bg-transparent text-zinc-700 dark:text-zinc-300 hover:border-violet-300 dark:hover:border-violet-500/40 hover:text-violet-600 dark:hover:text-violet-400 transition-colors">
                          {needsStart ? <Play size={11} /> : <Download size={12} />}
                          {needsStart ? "Start & Install" : "Install"}
                        </button>
                      );
                    } else if (isPendingOllama) {
                      btn = (
                        <div className="flex items-center gap-1.5 h-8 px-3.5 rounded-lg text-[12px] text-zinc-400 border border-zinc-200 dark:border-white/10">
                          <Loader2 size={11} className="animate-spin" />
                          {ollamaInstalling ? "Installing Ollama…" : ollamaPhase === "starting" ? "Starting Ollama…" : "Waiting…"}
                        </div>
                      );
                    } else if (downloading) {
                      btn = (
                        <button onClick={() => { abortRefs.current[model.id]?.abort(); setPulling(p => ({ ...p, [model.id]: false })); }}
                          className="flex items-center gap-1.5 h-8 px-3 rounded-lg text-[12px] text-zinc-400 border border-zinc-100 dark:border-white/8 cursor-pointer bg-transparent hover:text-red-500 hover:border-red-200 dark:hover:border-red-500/30 transition">
                          <Square size={10} /> Cancel
                        </button>
                      );
                    } else if (installed) {
                      btn = (
                        <button onClick={async () => {
                            await httpDeleteOllamaModel(cfg.ollamaUrl, model.ollamaName!);
                            setInstalledModels(prev => prev.filter(n => n !== model.ollamaName && !n.startsWith(model.ollamaName + ":")));
                            setCfg(c => { const r = { ...c.taskRouting }; model.tasks.forEach(t => { if (r[t] === model.id) delete r[t]; }); return { ...c, taskRouting: r }; });
                          }}
                          className="w-8 h-8 rounded-lg flex items-center justify-center text-zinc-300 dark:text-zinc-600 hover:text-red-500 dark:hover:text-red-400 hover:bg-red-50 dark:hover:bg-red-500/8 cursor-pointer border-none bg-transparent transition-colors">
                          <Trash2 size={13} />
                        </button>
                      );
                    }
                  } else if (isNative) {
                    if (!isTauri) {
                      btn = (
                        <div className="flex items-center gap-1.5 h-8 px-3 rounded-lg text-[11px] text-zinc-400 border border-zinc-200 dark:border-white/10">
                          Desktop app only
                        </div>
                      );
                    } else if (downloading) {
                      btn = (
                        <div className="flex items-center gap-1.5 h-8 px-3.5 rounded-lg text-[12px] text-zinc-400 border border-zinc-200 dark:border-white/10 tabular-nums">
                          <Loader2 size={11} className="animate-spin" />
                          {pct > 0 ? `Installing ${Math.round(pct)}%` : "Downloading…"}
                        </div>
                      );
                    } else if (!installed) {
                      btn = (
                        <button onClick={() => installNative(model)}
                          className="flex items-center gap-1.5 h-8 px-3.5 rounded-lg text-[12px] font-semibold cursor-pointer border border-zinc-200 dark:border-white/10 bg-transparent text-zinc-700 dark:text-zinc-300 hover:border-violet-300 dark:hover:border-violet-500/40 hover:text-violet-600 dark:hover:text-violet-400 transition-colors">
                          <Download size={12} /> Install
                        </button>
                      );
                    }
                  }

                  return (
                    <div key={model.id}
                      className={`rounded-xl border overflow-hidden transition-all min-w-0 ${
                        installed
                          ? "border-zinc-200 dark:border-white/10 bg-white dark:bg-white/[0.03]"
                          : "border-zinc-200 dark:border-white/8 bg-white dark:bg-white/[0.02]"
                      }`}>

                      <div className="flex items-start gap-3 p-4">
                        {/* Icon */}
                        <div className="w-9 h-9 rounded-lg flex items-center justify-center shrink-0 mt-0.5" style={{ background: catStyle.bg }}>
                          <CatEl size={16} style={{ color: catStyle.color }} />
                        </div>

                        {/* Info */}
                        <div className="flex-1 min-w-0">
                          <div className="flex items-center gap-2 mb-0.5">
                            <span className="text-[14px] font-bold text-zinc-900 dark:text-zinc-50 truncate">{model.name}</span>
                            {installed && (
                              <span className="text-[10px] font-semibold px-2 py-0.5 rounded-full flex items-center gap-1 shrink-0 bg-emerald-50 dark:bg-emerald-500/10 text-emerald-600 dark:text-emerald-400">
                                <CheckCircle2 size={9} />
                                {isOllama ? "Installed" : "Ready"}
                              </span>
                            )}
                          </div>
                          <p className="text-[12px] text-zinc-500 dark:text-zinc-400 leading-relaxed">{model.desc}</p>
                          {/* One quiet meta line — identifiers + size, no chip clutter */}
                          <div className="flex items-center gap-x-3 gap-y-1 mt-1.5 flex-wrap text-[10px] text-zinc-400 dark:text-zinc-500">
                            {model.ollamaName && <span className="font-mono">{model.ollamaName}</span>}
                            {isNative && <span>On-device</span>}
                            <span className="flex items-center gap-1"><HardDrive size={10} /> {model.size}</span>
                            <span className="flex items-center gap-1"><MemoryStick size={10} /> {model.ram}</span>
                          </div>

                          {/* Download progress (Ollama pull + native install share one bar) */}
                          {(downloading || isPendingOllama) && (
                            <div className="mt-2.5">
                              <div className="flex items-center justify-between mb-1">
                                <span className="text-[10px] text-zinc-400 truncate max-w-[240px]">
                                  {isOllama ? (status || "Downloading…") : "Downloading model…"}
                                </span>
                                {downloading && <span className="text-[10px] font-semibold text-zinc-600 dark:text-zinc-300 tabular-nums">{Math.round(pct)}%</span>}
                              </div>
                              <div className="h-1 w-full rounded-full bg-zinc-100 dark:bg-white/8 overflow-hidden">
                                <div className="h-full rounded-full transition-all duration-150"
                                  style={{ width: downloading ? `${Math.min(pct, 100)}%` : "25%", background: "linear-gradient(90deg,#3D7EFD,#0047D1)" }} />
                              </div>
                            </div>
                          )}
                        </div>

                        {/* Action button */}
                        <div className="shrink-0 flex items-center gap-1.5">
                          {btn}
                        </div>
                      </div>

                      {/* Task routing when installed */}
                      {installed && (
                        <div className="border-t border-zinc-100 dark:border-white/6 px-4 py-3 bg-zinc-50/60 dark:bg-white/[0.015]">
                          <p className="text-[10px] font-semibold uppercase tracking-widest text-zinc-400 mb-2">Use for</p>
                          <div className="flex flex-wrap gap-2">
                            {model.tasks.map(task => {
                              const meta   = TASK_META[task] ?? { icon: MessageSquare, label: task };
                              const TIcon  = meta.icon;
                              const active = cfg.taskRouting[task] === model.id;
                              return (
                                <button key={task} onClick={() => toggleTask(task, model.id)}
                                  className="flex items-center gap-1.5 h-7 px-3 rounded-full text-[11px] font-semibold cursor-pointer border transition-all"
                                  style={{
                                    background:  active ? "#0057FC14" : "transparent",
                                    borderColor: active ? "#0057FC50" : "rgba(0,0,0,0.1)",
                                    color:       active ? "#0057FC" : undefined,
                                  }}>
                                  <TIcon size={10} /> {meta.label}
                                </button>
                              );
                            })}
                          </div>
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            </div>
          );
        })}

        <p className="text-[11px] text-zinc-400 leading-relaxed pb-4">
          Everything here runs natively on your machine — one-click installs, no Docker and no Python.
          Voices (Kokoro, Supertonic) and the Whisper speech model download once from their publishers and
          then work offline; Ollama models appear automatically once pulled. Task routing is saved on this computer.
        </p>

      {termOpen && (
        <TerminalPanel
          lines={termLines}
          title={termTitle}
          running={termRunning}
          failed={termFailed}
          onClose={() => setTermOpen(false)}
          onRetry={termRetry.current ?? undefined}
        />
      )}

      {/* Floating "Show terminal" pill — appears when terminal is closed but has content */}
      {!termOpen && termLines.length > 0 && (
        <button
          onClick={() => setTermOpen(true)}
          style={{
            position: "fixed", bottom: 16, right: 16, zIndex: 200,
            display: "flex", alignItems: "center", gap: 8,
            padding: "8px 14px 8px 12px",
            background: "#0d0d0f",
            border: "1px solid rgba(255,255,255,0.12)",
            borderRadius: 999,
            boxShadow: "0 12px 32px rgba(0,0,0,0.5)",
            color: "rgba(255,255,255,0.85)",
            fontSize: 11, fontFamily: "system-ui,-apple-system,sans-serif",
            cursor: "pointer", maxWidth: 320,
          }}
          title="Reopen terminal"
        >
          <span style={{
            width: 8, height: 8, borderRadius: "50%", flexShrink: 0,
            background: termRunning ? "#28c840" : termFailed ? "#ff5f57" : "#71717a",
          }} className={termRunning ? "animate-pulse" : ""} />
          <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
            {termTitle}{termRunning ? " · running…" : termFailed ? " · failed" : " · done"}
          </span>
          <span style={{ color: "rgba(255,255,255,0.4)", fontSize: 10, marginLeft: 2 }}>Show</span>
        </button>
      )}
    </div>
  );
}
