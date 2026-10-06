"use client";

/**
 * First-launch setup (desktop only) — the "second half of install":
 *   choose local components  →  install  →  launch.
 *
 * A constant brand rail + a dark content panel, rendered dark regardless of theme,
 * inside the frameless WindowChrome title bar.
 *
 * Always installed: FFmpeg + yt-dlp (downloaded from their upstream release
 * pages). Optional: on-device transcription (Whisper), on-device voices (Kokoro;
 * Supertonic only when this build ships a download source for it) and a local
 * LLM (Ollama + Llama 3.2).
 *
 * Gated by FirstRunGate via the `setup-done` flag. Everything here is also
 * reachable later from Settings → Local AI, so nothing is ever installed by hand.
 *
 * Repair mode (`/setup?repair=1`): FirstRunGate sends a set-up install here when
 * FFmpeg or yt-dlp has gone missing. It skips the component picker, re-downloads
 * just the essentials and returns home; if that fails (e.g. offline) the user can
 * retry or skip, so the tools that don't need them stay usable.
 */
import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { ensureFfmpeg, ensureYtdlp, isDesktop } from "@/lib/deps-local";
import { ensureWhisperModel } from "@/lib/whisper-local";
import { ensureTtsModel, ttsModelStatus } from "@/lib/tts/local-tts";
import { WindowChrome } from "@/components/layout/window-chrome";
import { BrandMark } from "@/components/brand-mark";
import { humanizeError } from "@/lib/error/app-error";
import { useClientValue } from "@/lib/use-client-value";
import { logDebug } from "@/lib/log";
import { Check, Bot, Mic, Ear } from "lucide-react";
import { brand } from "@/brand.config";
import { SETUP_DONE_KEY } from "@/components/first-run-gate";

type Step = "addons" | "installing" | "done";
type ItemStatus = "queued" | "running" | "done" | "error";
interface Item { id: string; label: string; sub: string; status: ItemStatus; pct: number }

const STEP_ORDER: Step[] = ["addons", "installing", "done"];
const RAIL_STEPS = [
  { k: "addons", label: "Components", sub: "Choose what to install" },
  { k: "installing", label: "Install", sub: "Set up components" },
  { k: "done", label: "Launch", sub: "Start using the tools" },
];

/** Install the Ollama runtime, resolving when it reports done. */
function installOllama(onLine: (line: string) => void): Promise<void> {
  return new Promise((resolve, reject) => {
    const jobId = `setup-ollama-${Date.now()}`;
    let unLine: (() => void) | undefined;
    let unDone: (() => void) | undefined;
    const cleanup = () => { unLine?.(); unDone?.(); };
    Promise.all([
      listen<{ job_id: string; line: string }>("ollama-install-line", (e) => {
        if (e.payload.job_id === jobId) onLine(e.payload.line);
      }),
      listen<{ job_id: string; code: number }>("ollama-install-done", (e) => {
        if (e.payload.job_id !== jobId) return;
        cleanup();
        if (e.payload.code === 0) resolve();
        else reject(new Error("Ollama install failed"));
      }),
    ]).then(([a, b]) => { unLine = a; unDone = b; });
    invoke("ollama_install", { jobId }).catch((e) => { cleanup(); reject(e); });
  });
}

/** Pull an Ollama model over its local HTTP API, reporting % progress. */
async function pullOllama(tag: string, onPct: (pct: number) => void): Promise<void> {
  const res = await fetch("http://127.0.0.1:11434/api/pull", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name: tag, stream: true }),
  });
  if (!res.ok || !res.body) throw new Error(`Ollama model pull failed (${res.status})`);
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    const lines = buf.split("\n");
    buf = lines.pop() || "";
    for (const ln of lines) {
      if (!ln.trim()) continue;
      try { const j = JSON.parse(ln); if (j.total && j.completed) onPct(Math.round((j.completed / j.total) * 100)); }
      catch { /* non-JSON keepalive line */ }
    }
  }
}

const BRAND = brand.accentTo, BRAND2 = brand.accentFrom;
const scrollCls =
  "[&::-webkit-scrollbar]:w-1.5 [&::-webkit-scrollbar-track]:bg-transparent [&::-webkit-scrollbar-thumb]:rounded-full [&::-webkit-scrollbar-thumb]:bg-white/20";

export default function SetupPage() {
  const router = useRouter();

  const [step, setStep] = useState<Step>("addons");
  const [wantWhisper, setWantWhisper] = useState(true);
  const [wantKokoro, setWantKokoro] = useState(true);
  const [wantSupertonic, setWantSupertonic] = useState(false);
  // Supertonic is only offered when this build has a download source for it.
  const [supertonicAvailable, setSupertonicAvailable] = useState(false);
  const [wantOllama, setWantOllama] = useState(false);
  const [items, setItems] = useState<Item[]>([]);
  const [overall, setOverall] = useState(0);
  const [log, setLog] = useState("");
  const [err, setErr] = useState("");
  const repair = useClientValue(() => new URLSearchParams(window.location.search).get("repair") === "1", false);

  useEffect(() => { if (!isDesktop()) router.replace("/"); }, [router]);
  useEffect(() => {
    if (!isDesktop() || !repair) return;
    // Deferred so the install's state updates don't run synchronously in the effect.
    const t = setTimeout(() => void runInstall({ essentialsOnly: true }), 0);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- runs once, when repair mode is known
  }, [repair]);
  useEffect(() => {
    if (!isDesktop()) return;
    ttsModelStatus("supertonic")
      .then((s) => setSupertonicAvailable(s.available))
      .catch((e) => logDebug("setup", "supertonic status check failed", e));
  }, []);

  function finish() {
    try { window.localStorage.setItem(SETUP_DONE_KEY, "1"); } catch (e) { logDebug("setup", "could not persist setup flag", e); }
    router.replace("/");
  }

  function patchItem(id: string, patch: Partial<Item>) {
    setItems((arr) => arr.map((it) => (it.id === id ? { ...it, ...patch } : it)));
  }

  async function runInstall({ essentialsOnly = false }: { essentialsOnly?: boolean } = {}) {
    setErr("");
    const plan: (Item & { essential?: boolean; run: (onPct: (pct: number) => void) => Promise<void> })[] = [
      {
        id: "core", label: "Core essentials", sub: "Media engine (FFmpeg) + tools",
        status: "queued", pct: 0, essential: true,
        run: async (p) => { await ensureFfmpeg((x) => p(Math.max(0, x.pct))); await ensureYtdlp((x) => p(Math.max(0, x.pct))); },
      },
    ];
    if (!essentialsOnly && wantWhisper) plan.push({
      id: "stt", label: "Transcription · Whisper (base)", sub: "On-device speech-to-text",
      status: "queued", pct: 0,
      run: (p) => ensureWhisperModel("base", (x) => p(Math.max(0, x.pct))),
    });
    if (!essentialsOnly && wantKokoro) plan.push({
      id: "voice", label: "On-device voice · Kokoro", sub: "Offline text-to-speech (multi-voice)",
      status: "queued", pct: 0,
      run: (p) => ensureTtsModel("kokoro", (x) => p(Math.max(0, x.pct))),
    });
    if (!essentialsOnly && supertonicAvailable && wantSupertonic) plan.push({
      id: "supertonic", label: "On-device voice · Supertonic", sub: "Offline 44.1 kHz voices",
      status: "queued", pct: 0,
      run: (p) => ensureTtsModel("supertonic", (x) => p(Math.max(0, x.pct))),
    });
    if (!essentialsOnly && wantOllama) plan.push({
      id: "llm", label: "Local LLM · Ollama + Llama 3.2", sub: "Write scripts offline",
      status: "queued", pct: 0,
      run: async (p) => {
        setLog("Installing the Ollama runtime…");
        await installOllama((line) => setLog(`Ollama: ${line}`));
        try { await invoke("ollama_serve"); } catch { /* may already be running */ }
        setLog("Downloading Llama 3.2…");
        await pullOllama("llama3.2:3b", p);
      },
    });

    setItems(plan.map(({ run: _run, essential: _essential, ...it }) => it));
    setStep("installing");
    setOverall(0);
    const n = plan.length;

    for (let i = 0; i < n; i++) {
      const task = plan[i];
      patchItem(task.id, { status: "running", pct: 0 });
      try {
        await task.run((pct) => {
          patchItem(task.id, { pct });
          setOverall(Math.round(((i + pct / 100) / n) * 100));
        });
        patchItem(task.id, { status: "done", pct: 100 });
      } catch (e) {
        patchItem(task.id, { status: "error" });
        if (task.essential) { setErr(humanizeError(e)); setStep("addons"); return; }
        logDebug("setup", `${task.id} failed (skipped)`, e);
      }
      setOverall(Math.round(((i + 1) / n) * 100));
    }
    setLog("");
    if (essentialsOnly) { finish(); return; }
    setStep("done");
  }

  const stepIdx = STEP_ORDER.indexOf(step);

  return (
    <div
      className="flex min-h-dvh items-center justify-center p-6 text-[#eef0f6]"
      style={{
        background:
          "radial-gradient(1200px 700px at 82% -10%, rgba(0,87,252,.16), transparent 60%)," +
          "radial-gradient(900px 600px at -10% 110%, rgba(61,126,253,.08), transparent 60%), #08080c",
      }}
    >
      <WindowChrome />
      <div
        className="flex w-full max-w-[900px] overflow-hidden rounded-[18px]"
        style={{ height: 580, boxShadow: "0 50px 100px -25px rgba(0,0,0,.85), 0 0 0 1px rgba(255,255,255,.07), inset 0 1px 0 rgba(255,255,255,.05)" }}
      >
        {/* ── LEFT: brand rail ── */}
        <div
          className="relative flex w-[312px] shrink-0 flex-col px-[30px] py-[34px]"
          style={{ background: "linear-gradient(165deg, #1A56E8 0%, #0B2C86 48%, #0A1636 100%)" }}
        >
          <div className="pointer-events-none absolute inset-0" style={{ background: "radial-gradient(90% 45% at 20% 0%, rgba(255,255,255,.14), transparent 60%)" }} />
          <div className="relative z-[1]">
            {/* Dark tile like the app icon: the mark's second piece is white, so it disappears on a white tile. */}
            <div className="grid h-[54px] w-[54px] place-items-center rounded-[15px]" style={{ background: "#0B1222", boxShadow: "0 12px 26px -8px rgba(0,0,0,.5), inset 0 0 0 1px rgba(255,255,255,.08)" }}>
              <BrandMark size={36} tone="light" />
            </div>
            <div className="mt-[18px] text-[22px] font-bold tracking-[.2px]">{brand.name}</div>
            <div className="mt-1.5 max-w-[210px] text-[12.5px] leading-[1.5] text-white/70">
              {brand.tagline}
            </div>
            <div className="mt-[38px] flex flex-col">
              {RAIL_STEPS.map((s, i) => (
                <RailStep key={s.k} idx={i} cur={stepIdx} label={s.label} sub={s.sub} last={i === RAIL_STEPS.length - 1} />
              ))}
            </div>
          </div>
          <div className="absolute bottom-[18px] left-[30px] z-[1] text-[11px] tracking-[.3px] text-white/55">{repair ? "Repair" : "First-run setup"}</div>
        </div>

        {/* ── RIGHT: content panel ── */}
        <div className="relative flex flex-1 flex-col" style={{ background: "linear-gradient(180deg,#121216,#0e0e11)" }}>
          {/* REPAIR: essentials missing and the re-download failed */}
          {step === "addons" && repair && (
            <>
              <div className={`flex-1 overflow-y-auto px-11 pt-10 ${scrollCls}`}>
                <div className="text-[11.5px] font-semibold uppercase tracking-[.6px]" style={{ color: BRAND2 }}>Repair</div>
                <h2 className="mt-2.5 text-[25px] font-bold">Some required tools are missing</h2>
                <p className="mt-2 max-w-[460px] text-[13.5px] text-[#9aa0b4]">
                  {brand.name} needs FFmpeg and yt-dlp for the video, audio and download tools, and couldn&apos;t download them.
                  Check your internet connection and try again. Quick Trim, Image to Video, Carousel Video and File Shuffler work without them.
                </p>
                {err && <p className="mt-4 rounded-lg px-3 py-2 text-[12.5px]" style={{ background: "rgba(239,68,68,.1)", color: "#f4b9b9" }}>{err}</p>}
              </div>
              <div className="flex items-center gap-3 px-11 pb-6 pt-3.5">
                <button onClick={finish} className="mr-auto bg-transparent text-[13px] text-[#9aa0b4] hover:text-white">Skip for now</button>
                <PrimaryBtn onClick={() => void runInstall({ essentialsOnly: true })}>Retry download</PrimaryBtn>
              </div>
            </>
          )}

          {/* COMPONENTS */}
          {step === "addons" && !repair && (
            <>
              <div className={`flex-1 overflow-y-auto px-11 pt-10 ${scrollCls}`}>
                <div className="text-[11.5px] font-semibold uppercase tracking-[.6px]" style={{ color: BRAND2 }}>Step 1 of 3</div>
                <h2 className="mt-2.5 text-[25px] font-bold">Choose local components</h2>
                <p className="mt-2 max-w-[460px] text-[13.5px] text-[#9aa0b4]">
                  On-device models that run offline and free. Turn on what you want now — or add them anytime in Settings → Local AI.
                </p>
                <div className="mt-[22px] space-y-3">
                  <OptionRow icon={<Ear size={22} />} title="Transcription"
                    desc="Whisper (base) — speech to text on this machine." size="Download ~142 MB"
                    checked={wantWhisper} onToggle={() => setWantWhisper((v) => !v)} />
                  <OptionRow icon={<Mic size={22} />} title="On-device voice · Kokoro"
                    desc="Multi-voice text to speech, offline." size="Download ~330 MB"
                    checked={wantKokoro} onToggle={() => setWantKokoro((v) => !v)} />
                  {supertonicAvailable && (
                    <OptionRow icon={<Mic size={22} />} title="On-device voice · Supertonic"
                      desc="44.1 kHz neural voices, offline. Windows only." size="Download ~360 MB · optional"
                      checked={wantSupertonic} onToggle={() => setWantSupertonic((v) => !v)} />
                  )}
                  <OptionRow icon={<Bot size={22} />} title="Local LLM"
                    desc="Ollama + Llama 3.2 — write scripts offline." size="Download ~3.5 GB · optional"
                    checked={wantOllama} onToggle={() => setWantOllama((v) => !v)} />
                </div>
                <p className="mt-4 text-[12px] text-[#75758a]">
                  FFmpeg and yt-dlp (needed by the video and audio tools) always install. Everything above is optional.
                </p>
                {err && <p className="mt-3 rounded-lg px-3 py-2 text-[12.5px]" style={{ background: "rgba(239,68,68,.1)", color: "#f4b9b9" }}>{err}</p>}
              </div>
              <div className="flex items-center gap-3 px-11 pb-6 pt-3.5">
                <span className="mr-auto" />
                <PrimaryBtn onClick={() => void runInstall()}>Install &amp; continue</PrimaryBtn>
              </div>
            </>
          )}

          {/* INSTALLING */}
          {step === "installing" && (
            <>
              <div className={`flex-1 overflow-y-auto px-11 pt-10 ${scrollCls}`}>
                <div className="text-[11.5px] font-semibold uppercase tracking-[.6px]" style={{ color: BRAND2 }}>{repair ? "Repair" : "Step 2 of 3"}</div>
                <h2 className="mt-2.5 text-[25px] font-bold">{repair ? "Restoring required tools…" : `Setting up ${brand.name}…`}</h2>
                <p className="mt-2 max-w-[460px] text-[13.5px] text-[#9aa0b4]">
                  {repair
                    ? "FFmpeg or yt-dlp went missing since the last launch, so they are downloading again. This only takes a moment."
                    : "Installing your on-device components. This runs once — then everything works offline."}
                </p>
                <div className="mt-[22px] h-[9px] overflow-hidden rounded-md bg-white/[.07]">
                  <div className="h-full rounded-md transition-all" style={{ width: `${overall}%`, background: `linear-gradient(90deg,${BRAND},${BRAND2})` }} />
                </div>
                <div className="mb-1.5 mt-1.5 flex justify-between text-[11.5px] text-[#9aa0b4]">
                  <span>{log || (overall < 100 ? "Installing…" : "Done")}</span>
                  <span className="tabular-nums">{overall}%</span>
                </div>
                <div>
                  {items.map((it) => (
                    <div key={it.id} className="flex items-center gap-3 border-t border-white/[.06] py-[11px]">
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-[12.5px] font-medium">{it.label}</span>
                        <span className="block truncate text-[10.5px] text-[#7f7f92]">{it.sub}</span>
                        <span className="mt-1.5 block h-1 overflow-hidden rounded bg-white/[.08]">
                          <span className="block h-full rounded transition-all" style={{ width: `${it.pct}%`, background: `linear-gradient(90deg,${BRAND},${BRAND2})` }} />
                        </span>
                      </span>
                      <span className="whitespace-nowrap text-[11px] tabular-nums text-[#9aa0b4]">
                        {it.status === "done" ? <span style={{ color: "#7ee7b8" }}>✓ Done</span>
                          : it.status === "error" ? <span style={{ color: "#f0c36d" }}>Skipped</span>
                          : it.status === "running" ? "Downloading…" : "Queued"}
                      </span>
                    </div>
                  ))}
                </div>
              </div>
              <div className="flex items-center px-11 pb-6 pt-3.5">
                <span className="text-[11.5px] text-[#75758a]">You can minimise this — it keeps going.</span>
              </div>
            </>
          )}

          {/* DONE */}
          {step === "done" && (
            <>
              <div className="flex flex-1 flex-col justify-center px-11 pt-10">
                <div className="grid h-16 w-16 place-items-center rounded-full text-white" style={{ background: "linear-gradient(135deg,#22c55e,#16a34a)", boxShadow: "0 10px 24px -12px rgba(34,197,94,.45)" }}>
                  <Check size={30} />
                </div>
                <div className="mt-[18px] text-[11.5px] font-semibold uppercase tracking-[.6px]" style={{ color: BRAND2 }}>All done</div>
                <h2 className="mt-2.5 text-[25px] font-bold">You&apos;re all set</h2>
                <p className="mt-2 max-w-[440px] text-[13.5px] text-[#9aa0b4]">{brand.name} is ready and everything&apos;s installed locally.</p>
              </div>
              <div className="flex items-center px-11 pb-6 pt-3.5">
                <span className="mr-auto text-[11.5px] text-[#75758a]">Opens the app.</span>
                <PrimaryBtn onClick={finish}>Open {brand.name}</PrimaryBtn>
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

/* ── rail step ── */
function RailStep({ idx, cur, label, sub, last }: { idx: number; cur: number; label: string; sub: string; last: boolean }) {
  const active = idx === cur, done = idx < cur;
  return (
    <div className="relative flex gap-[13px] pb-[26px]">
      {!last && <span className="absolute left-[13px] top-[29px] bottom-0 w-0.5" style={{ background: done ? "rgba(255,255,255,.55)" : "rgba(255,255,255,.18)" }} />}
      <span className="grid h-[27px] w-[27px] shrink-0 place-items-center rounded-full text-[11.5px] font-semibold"
        style={active ? { background: "#fff", color: BRAND, boxShadow: "0 6px 16px -4px rgba(0,0,0,.5)" }
          : done ? { background: "rgba(255,255,255,.92)", color: BRAND }
          : { background: "rgba(255,255,255,.14)", color: "rgba(255,255,255,.75)", boxShadow: "inset 0 0 0 1px rgba(255,255,255,.22)" }}>
        {done ? <Check size={13} /> : idx + 1}
      </span>
      <div>
        <b className={`block text-[13px] font-semibold leading-[1.5] ${active || done ? "text-white" : "text-white/60"}`}>{label}</b>
        <span className="text-[11px] text-white/50">{sub}</span>
      </div>
    </div>
  );
}

/* ── buttons ── */
function PrimaryBtn({ onClick, disabled, children }: { onClick: () => void; disabled?: boolean; children: React.ReactNode }) {
  return (
    <button onClick={onClick} disabled={disabled}
      className="flex items-center gap-1.5 rounded-[11px] px-6 py-3 text-[13.5px] font-semibold text-white disabled:cursor-not-allowed"
      style={disabled
        ? { background: `linear-gradient(135deg,${BRAND},${BRAND2})`, opacity: 0.45, filter: "grayscale(.5)" }
        : { background: `linear-gradient(135deg,${BRAND},${BRAND2})`, boxShadow: `0 12px 26px -10px ${BRAND}b8` }}>
      {children}
    </button>
  );
}

/* ── local-AI option (dark switch card, matches the mock) ── */
function OptionRow({ icon, title, desc, size, checked, onToggle }: {
  icon: React.ReactNode; title: string; desc: string; size: string; checked: boolean; onToggle: () => void;
}) {
  return (
    <button onClick={onToggle}
      className="flex w-full items-center gap-4 rounded-[14px] border p-4 text-left transition"
      style={checked
        ? { borderColor: "rgba(61,126,253,.55)", background: "rgba(0,87,252,.10)" }
        : { borderColor: "rgba(255,255,255,.1)", background: "rgba(255,255,255,.02)" }}>
      <span className="grid h-[46px] w-[46px] shrink-0 place-items-center rounded-[13px] text-white/90" style={{ background: "rgba(255,255,255,.05)", border: "1px solid rgba(255,255,255,.08)" }}>{icon}</span>
      <span className="min-w-0 flex-1">
        <span className="block text-[15px] font-semibold">{title}</span>
        <span className="block text-[12.5px] text-[#9aa0b4]">{desc}</span>
        <span className="mt-1 block text-[11.5px] text-[#8f8fa2] tabular-nums">{size}</span>
      </span>
      <span className="relative h-[26px] w-11 shrink-0 rounded-full transition-colors" style={{ background: checked ? BRAND : "rgba(255,255,255,.14)" }}>
        <span className="absolute top-[3px] h-5 w-5 rounded-full bg-white transition-all" style={{ left: checked ? "21px" : "3px" }} />
      </span>
    </button>
  );
}

