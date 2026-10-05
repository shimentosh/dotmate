"use client";

/**
 * DotMate session persistence. The clip queue can hold hundreds of entries and the
 * File System Access handles to the source videos / output folder can't be JSON'd,
 * so this uses IndexedDB (structured clone keeps the handles) rather than the
 * app's usual localStorage. Only REFERENCES are stored — never video bytes.
 */
import { storageKey } from "@/brand.config";
import { logDebug } from "@/lib/log";

const DB_NAME = storageKey("dotmate");
const STORE = "sessions";
const VERSION = 1;

export interface PersistedSource {
  id: string;
  name: string;
  size: number;
  lastModified: number;
  duration: number | null;
  width: number;
  height: number;
  /** Chromium only — lets the next session reopen the file without re-importing. */
  handle?: FileSystemFileHandle;
}

export interface PersistedClip {
  id: string;
  sourceId: string;
  start: number;
  end: number;
  status: "waiting" | "completed" | "failed";
  error?: string;
  outputName?: string;
}

export interface PersistedSession {
  v: 1;
  sources: PersistedSource[];
  clips: PersistedClip[];
  selectedSourceId: string | null;
  defaultDuration: number;
  prefix: string;
  outDir?: FileSystemDirectoryHandle;
}

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, VERSION);
    req.onupgradeneeded = () => {
      if (!req.result.objectStoreNames.contains(STORE)) req.result.createObjectStore(STORE);
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

export async function loadSession(key: string): Promise<PersistedSession | null> {
  if (typeof indexedDB === "undefined") return null;
  try {
    const db = await openDb();
    try {
      return await new Promise<PersistedSession | null>((resolve, reject) => {
        const req = db.transaction(STORE, "readonly").objectStore(STORE).get(key);
        req.onsuccess = () => {
          const v = req.result as PersistedSession | undefined;
          resolve(v && v.v === 1 ? v : null);
        };
        req.onerror = () => reject(req.error);
      });
    } finally {
      db.close();
    }
  } catch (e) {
    logDebug("dotmate", "could not load the saved session", e);
    return null;
  }
}

export async function saveSession(key: string, session: PersistedSession): Promise<void> {
  if (typeof indexedDB === "undefined") return;
  try {
    const db = await openDb();
    try {
      await new Promise<void>((resolve, reject) => {
        const tx = db.transaction(STORE, "readwrite");
        tx.objectStore(STORE).put(session, key);
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
      });
    } finally {
      db.close();
    }
  } catch (e) {
    // A failed save only loses resume-later convenience; the session itself is intact.
    logDebug("dotmate", "could not save the session", e);
  }
}
