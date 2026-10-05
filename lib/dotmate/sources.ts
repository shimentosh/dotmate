"use client";

/**
 * DotMate source helpers: which files count as videos, reading a video's
 * duration/size without loading it, and the File System Access permission calls
 * (not yet in TypeScript's DOM lib) used to reopen sources in a later session.
 */
import { logDebug } from "@/lib/log";

const VIDEO_EXTS = new Set(["mp4", "m4v", "mov", "webm", "mkv", "avi", "ts", "mts", "m2ts", "3gp", "wmv", "flv"]);

export function isVideoFile(f: File): boolean {
  if (f.type.startsWith("video/")) return true;
  const ext = f.name.split(".").pop()?.toLowerCase() ?? "";
  return VIDEO_EXTS.has(ext);
}

export interface VideoMeta { duration: number; width: number; height: number }

/** Duration + display size via a metadata-only <video> load (reads the header, not the file). */
function probeWithElement(file: File): Promise<VideoMeta> {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const v = document.createElement("video");
    const done = (fn: () => void) => { clearTimeout(timer); v.removeAttribute("src"); v.load(); URL.revokeObjectURL(url); fn(); };
    const timer = setTimeout(() => done(() => reject(new Error("metadata timeout"))), 20_000);
    v.preload = "metadata";
    v.muted = true;
    v.onloadedmetadata = () => {
      const meta = { duration: v.duration, width: v.videoWidth, height: v.videoHeight };
      done(() => (Number.isFinite(meta.duration) && meta.duration > 0 ? resolve(meta) : reject(new Error("no duration"))));
    };
    v.onerror = () => done(() => reject(new Error("unplayable")));
    v.src = url;
  });
}

/** Fallback for containers the preview element can't open (reads the index only). */
async function probeWithDemuxer(file: File): Promise<VideoMeta> {
  const { Input, BlobSource, ALL_FORMATS } = await import("mediabunny");
  const input = new Input({ formats: ALL_FORMATS, source: new BlobSource(file) });
  try {
    const track = await input.getPrimaryVideoTrack();
    if (!track) throw new Error("no video track");
    const duration = await input.computeDuration();
    return { duration, width: track.displayWidth, height: track.displayHeight };
  } finally {
    input.dispose();
  }
}

/**
 * Whether the first bytes look like a video container we can demux (MP4/MOV, MKV/WebM,
 * AVI, MPEG-TS, FLV, ASF). Keeps damaged/foreign files away from the demuxer, which
 * otherwise leaves an unhandled internal rejection behind on garbage input.
 */
async function looksLikeVideoContainer(file: File): Promise<boolean> {
  const b = new Uint8Array(await file.slice(0, 400).arrayBuffer());
  const ascii = (o: number, s: string) => [...s].every((c, i) => b[o + i] === c.charCodeAt(0));
  if (ascii(4, "ftyp") || ascii(4, "moov") || ascii(4, "mdat") || ascii(4, "free") || ascii(4, "wide")) return true; // ISO BMFF / QuickTime
  if (b[0] === 0x1a && b[1] === 0x45 && b[2] === 0xdf && b[3] === 0xa3) return true; // Matroska / WebM
  if (ascii(0, "RIFF") && ascii(8, "AVI ")) return true;
  if (ascii(0, "FLV")) return true;
  if (b[0] === 0x30 && b[1] === 0x26 && b[2] === 0xb2 && b[3] === 0x75) return true; // ASF / WMV
  if (b[0] === 0x47 && b[188] === 0x47) return true; // MPEG-TS
  if (b[4] === 0x47 && b[196] === 0x47) return true; // M2TS (4-byte timecode prefix)
  return false;
}

/** Read a video's duration and size. Throws a user-facing message when it can't. */
export async function probeVideo(file: File): Promise<VideoMeta> {
  try {
    return await probeWithElement(file);
  } catch (e) {
    logDebug("dotmate", `preview element could not read ${file.name}; trying the demuxer`, e);
  }
  if (!(await looksLikeVideoContainer(file))) throw new Error("Unsupported or damaged video");
  try {
    return await probeWithDemuxer(file);
  } catch (e) {
    logDebug("dotmate", `demuxer could not read ${file.name}`, e);
    throw new Error("Unsupported or damaged video");
  }
}

type PermissionMode = { mode: "read" | "readwrite" };
type PermissionedHandle = {
  queryPermission?: (d: PermissionMode) => Promise<PermissionState>;
  requestPermission?: (d: PermissionMode) => Promise<PermissionState>;
};

/** Whether we may use a stored handle; with `ask`, prompts (needs a user gesture). */
export async function ensurePermission(
  handle: FileSystemHandle,
  mode: "read" | "readwrite",
  ask: boolean,
): Promise<boolean> {
  const h = handle as unknown as PermissionedHandle;
  try {
    if ((await h.queryPermission?.({ mode })) === "granted") return true;
    if (ask && h.requestPermission) return (await h.requestPermission({ mode })) === "granted";
  } catch (e) {
    logDebug("dotmate", "permission check failed", e);
  }
  return false;
}

export function hasOpenFilePicker(): boolean {
  return typeof window !== "undefined" && "showOpenFilePicker" in window;
}

export function hasDirectoryPicker(): boolean {
  return typeof window !== "undefined" && "showDirectoryPicker" in window;
}

export interface ImportItem { file: File; handle?: FileSystemFileHandle }

/**
 * Open the system file picker for videos. Uses `showOpenFilePicker` where available
 * (the handles let a later session reopen the files); null when the user cancels or
 * the picker isn't available (callers fall back to an <input type="file">).
 */
export async function pickVideoFiles(): Promise<ImportItem[] | null> {
  if (!hasOpenFilePicker()) return null;
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const handles: FileSystemFileHandle[] = await (window as any).showOpenFilePicker({
      multiple: true,
      excludeAcceptAllOption: false,
      types: [{ description: "Videos", accept: { "video/*": [".mp4", ".m4v", ".mov", ".webm", ".mkv", ".avi", ".ts", ".mts"] } }],
    });
    return await Promise.all(handles.map(async (handle) => ({ file: await handle.getFile(), handle })));
  } catch (e) {
    logDebug("dotmate", "file picker cancelled", e);
    return [];
  }
}

/**
 * Collect dropped files, with handles where the browser offers them. Must be called
 * synchronously inside the drop handler — the DataTransfer empties after it returns.
 */
export function collectDrop(dt: DataTransfer): Promise<ImportItem[]> {
  type WithHandle = DataTransferItem & { getAsFileSystemHandle?: () => Promise<FileSystemHandle | null> };
  // Pair each File with its handle per item — both are read synchronously here.
  const pending = Array.from(dt.items)
    .filter((i) => i.kind === "file")
    .map((i) => ({
      file: i.getAsFile(),
      handle: (i as WithHandle).getAsFileSystemHandle?.().catch(() => null) ?? Promise.resolve(null),
    }))
    .filter((p): p is { file: File; handle: Promise<FileSystemHandle | null> } => p.file !== null);
  if (pending.length === 0) return Promise.resolve(Array.from(dt.files).map((file) => ({ file })));
  return Promise.all(
    pending.map(async ({ file, handle }) => {
      const h = await handle;
      return { file, handle: h && h.kind === "file" ? (h as FileSystemFileHandle) : undefined };
    }),
  );
}
