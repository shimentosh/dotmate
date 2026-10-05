"use client";

/**
 * DotMate export engine — cuts one clip out of a source video with Mediabunny
 * (WebCodecs), the same in-app engine Quick Trim and the Studio tools use.
 *
 * Quality: the clip is re-encoded (arbitrary, frame-accurate in/out points can't be
 * stream-copied) at the source's own resolution, aspect ratio, rotation and frame
 * timing — nothing is resized or resampled. Video goes to H.264 (HEVC when the
 * frame is too large for H.264) at a bitrate scaled to resolution × frame rate;
 * audio is kept and re-encoded to AAC 256 kbps. This is high quality, not lossless.
 *
 * Memory: the source File is read lazily in small ranges (BlobSource), never loaded
 * whole, and the original file is only ever read. Output streams to the target.
 */

import type { Input, InputVideoTrack, Target } from "mediabunny";
import { logDebug } from "@/lib/log";
import { targetVideoBitrate } from "./format";

export interface OpenedSource {
  input: Input;
  video: InputVideoTrack | null;
  /** Average frame rate measured from the first packets (0 when unknown). */
  fps: number;
}

/** Open a source for repeated clipping. Call `closeSource` when the batch is done. */
export async function openSource(file: File): Promise<OpenedSource> {
  const { Input, BlobSource, ALL_FORMATS } = await import("mediabunny");
  const input = new Input({ formats: ALL_FORMATS, source: new BlobSource(file) });
  const video = await input.getPrimaryVideoTrack();
  let fps = 0;
  if (video) {
    try { fps = (await video.computePacketStats(120)).averagePacketRate; } catch (e) { logDebug("dotmate", "frame rate unknown — bitrate assumes 30 fps", e); }
  }
  return { input, video, fps };
}

export function closeSource(src: OpenedSource): void {
  try { src.input.dispose(); } catch (e) { logDebug("dotmate", "source already disposed", e); }
}

/** Errors the batch runner reacts to (stop the batch vs. fail one clip). */
export type ClipErrorKind = "unsupported" | "source-unreadable" | "disk-full" | "no-permission" | "cancelled" | "failed";

export class ClipExportError extends Error {
  constructor(readonly kind: ClipErrorKind, readonly userMessage: string, cause?: unknown) {
    super(userMessage);
    this.name = "ClipExportError";
    if (cause !== undefined) (this as { cause?: unknown }).cause = cause;
  }
}

/** Map whatever the browser/encoder threw to a short message a user can act on. */
export function classifyError(err: unknown): ClipExportError {
  if (err instanceof ClipExportError) return err;
  const name = (err as { name?: string })?.name ?? "";
  const msg = String((err as { message?: string })?.message ?? err ?? "");
  if (name === "ConversionCanceledError" || name === "AbortError") {
    return new ClipExportError("cancelled", "Stopped", err);
  }
  if (name === "QuotaExceededError" || /quota|disk (is )?full|not enough space|no space/i.test(msg)) {
    return new ClipExportError("disk-full", "Not enough free disk space in the output folder.", err);
  }
  if (name === "NotAllowedError" || name === "SecurityError") {
    return new ClipExportError("no-permission", "No permission to write to the output folder.", err);
  }
  if (name === "NotFoundError" || name === "NotReadableError") {
    return new ClipExportError("source-unreadable", "The source video can't be read — it may have been moved, renamed or deleted.", err);
  }
  if (/unsupported|not supported|codec|decod/i.test(msg)) {
    return new ClipExportError("unsupported", "This video's format can't be exported on this computer.", err);
  }
  return new ClipExportError("failed", "This clip couldn't be exported.", err);
}

export interface RenderClipOptions {
  source: OpenedSource;
  start: number;
  end: number;
  target: Target;
  /** True for small outputs: write the moov box up front (web-optimised MP4). */
  fastStartInMemory: boolean;
  onProgress?: (p: number) => void;
  signal?: AbortSignal;
}

/** Encode `[start, end)` of the source into `target` as an MP4. */
export async function renderClip(opts: RenderClipOptions): Promise<void> {
  const { source, start, end, target, onProgress, signal } = opts;
  const mb = await import("mediabunny");
  if (!source.video) {
    throw new ClipExportError("unsupported", "This file has no video track that can be read.");
  }

  // Encodability is checked on the coded frame size — rotation stays metadata.
  const w = source.video.codedWidth;
  const h = source.video.codedHeight;
  let codec: "avc" | "hevc" | null = null;
  for (const c of ["avc", "hevc"] as const) {
    if (await mb.canEncodeVideo(c, { width: w, height: h, bitrate: targetVideoBitrate(w, h, source.fps, c) })) {
      codec = c;
      break;
    }
  }
  if (!codec) {
    throw new ClipExportError("unsupported", `This computer can't encode ${w}×${h} video.`);
  }

  const output = new mb.Output({
    format: new mb.Mp4OutputFormat({ fastStart: opts.fastStartInMemory ? "in-memory" : false }),
    target,
  });

  const conversion = await mb.Conversion.init({
    input: source.input,
    output,
    trim: { start, end },
    tracks: "primary",
    video: {
      codec,
      bitrate: targetVideoBitrate(w, h, source.fps, codec),
      forceTranscode: true,
    },
    audio: { codec: "aac", bitrate: 256_000 },
    showWarnings: false,
  });

  if (!conversion.isValid) {
    throw new ClipExportError("unsupported", "This video's format can't be exported on this computer.");
  }

  const onAbort = () => { void conversion.cancel(); };
  signal?.addEventListener("abort", onAbort);
  if (onProgress) conversion.onProgress = (p) => onProgress(Math.min(1, Math.max(0, p)));
  try {
    if (signal?.aborted) throw new ClipExportError("cancelled", "Stopped");
    await conversion.execute();
  } catch (err) {
    try { await output.cancel(); } catch (e) { logDebug("dotmate", "output already finalized or cancelled", e); }
    throw classifyError(err);
  } finally {
    signal?.removeEventListener("abort", onAbort);
  }
}
