"use client";

import { useEffect, useRef, useState } from "react";
import { AlertCircle } from "lucide-react";
import { logDebug } from "@/lib/log";
import { previewUrl } from "@/lib/quick-edit-api";
import type { QeSettings } from "@/store/quick-edit";

/**
 * Live preview of the Quick Edit mix — no render needed. The video streams from
 * disk (asset protocol); its audio and the music each go through their own Web
 * Audio gain, so a volume above 100% is heard exactly as it will render. A
 * compressor stands in for the render's limiter. The music follows the video's
 * play / pause / seek, offset and fades.
 */
export function PreviewPlayer({
  path, name, musicUrl, settings, duration,
}: {
  path: string;
  name: string;
  /** Blob URL of the music file (null = none). */
  musicUrl: string | null;
  settings: QeSettings;
  /** Seconds (0 = unknown) — needed for the fade-out. */
  duration: number;
}) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const musicRef = useRef<HTMLAudioElement>(null);
  const graph = useRef<{ ctx: AudioContext; orig: GainNode; music: GainNode } | null>(null);
  const settingsRef = useRef(settings);
  const durationRef = useRef(duration);
  // Tied to the path, so picking another video clears it.
  const [failedPath, setFailedPath] = useState<string | null>(null);
  const failed = failedPath === path;

  useEffect(() => { settingsRef.current = settings; durationRef.current = duration; });

  // Web Audio graph — built on first play (browsers block audio before a gesture).
  // A media element can be wired into a graph only once, so it lives as long as the player.
  const ensureGraph = () => {
    if (graph.current || !videoRef.current || !musicRef.current) return graph.current;
    try {
      const ctx = new AudioContext();
      const limiter = ctx.createDynamicsCompressor();
      limiter.threshold.value = -1;
      limiter.knee.value = 0;
      limiter.ratio.value = 20;
      limiter.attack.value = 0.003;
      limiter.release.value = 0.05;
      limiter.connect(ctx.destination);
      const orig = ctx.createGain();
      const musicGain = ctx.createGain();
      ctx.createMediaElementSource(videoRef.current).connect(orig).connect(limiter);
      ctx.createMediaElementSource(musicRef.current).connect(musicGain).connect(limiter);
      graph.current = { ctx, orig, music: musicGain };
    } catch (e) {
      logDebug("quick-edit", "preview audio graph unavailable — plain playback", e);
    }
    return graph.current;
  };

  useEffect(() => () => { void graph.current?.ctx.close(); graph.current = null; }, []);

  // Where the music should be for video time `t` (it loops past its own end).
  const musicTimeFor = (t: number) => {
    const m = musicRef.current;
    const at = settingsRef.current.musicOffset + t;
    return m && Number.isFinite(m.duration) && m.duration > 0 ? at % m.duration : at;
  };

  const syncMusic = (force = false) => {
    const v = videoRef.current;
    const m = musicRef.current;
    if (!v || !m || !musicUrl) return;
    const want = musicTimeFor(v.currentTime);
    if (force || Math.abs(m.currentTime - want) > 0.15) {
      try { m.currentTime = want; } catch (e) { logDebug("quick-edit", "music seek failed", e); }
    }
    m.playbackRate = v.playbackRate;
    if (v.paused) m.pause();
    else void m.play().catch((e) => logDebug("quick-edit", "music play blocked", e));
  };

  // Gains follow the sliders and the fades every frame while playing.
  useEffect(() => {
    let raf = 0;
    const tick = () => {
      const g = graph.current;
      const v = videoRef.current;
      if (g && v) {
        const s = settingsRef.current;
        const t = v.currentTime;
        const d = durationRef.current;
        let fade = 1;
        if (s.fadeIn > 0 && t < s.fadeIn) fade = Math.min(fade, t / s.fadeIn);
        if (s.fadeOut > 0 && d > 0 && t > d - s.fadeOut) fade = Math.min(fade, Math.max(0, (d - t) / s.fadeOut));
        g.orig.gain.value = s.originalVolume / 100;
        g.music.gain.value = musicUrl ? (s.musicVolume / 100) * fade : 0;
        if (!v.paused && musicUrl) syncMusic();
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [musicUrl]);

  // A new music file or start point while playing → jump it into place.
  useEffect(() => { syncMusic(true); }, [musicUrl, settings.musicOffset]); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <div className="flex-1 min-h-0 flex flex-col items-center justify-center gap-3 p-5 bg-zinc-950/[0.03] dark:bg-black/30">
      {failed && (
        <div className="flex flex-col items-center gap-2 text-center max-w-sm">
          <AlertCircle size={26} strokeWidth={1.5} className="text-amber-500" />
          <p className="text-[13px] font-semibold text-zinc-700 dark:text-zinc-200">Preview can&apos;t play {name}</p>
          <p className="text-[12px] text-zinc-500">This computer&apos;s player doesn&apos;t support its format. Rendering still works — ffmpeg reads it directly.</p>
        </div>
      )}
      {/* One element for every video (only the src changes): a media element can join
          the audio graph only once. */}
      <video
        ref={videoRef}
        src={previewUrl(path)}
        crossOrigin="anonymous"
        controls
        playsInline
        preload="metadata"
        className={`max-w-full max-h-full min-h-0 rounded-xl bg-black shadow-sm ${failed ? "hidden" : ""}`}
        onPlay={() => { const g = ensureGraph(); void g?.ctx.resume(); syncMusic(true); }}
        onPause={() => musicRef.current?.pause()}
        onSeeked={() => syncMusic(true)}
        onRateChange={() => syncMusic()}
        onEnded={() => musicRef.current?.pause()}
        onEmptied={() => musicRef.current?.pause()}
        onError={() => setFailedPath(path)}
      />
      <audio ref={musicRef} src={musicUrl ?? undefined} preload="auto" className="hidden" />
    </div>
  );
}
