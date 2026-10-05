"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import { storageKey } from "@/brand.config";

/**
 * usePreference — a drop-in replacement for useState that remembers the value on
 * this machine (localStorage). Works for any JSON-serialisable value.
 *
 *   const [model, setModel] = usePreference("scriptWriter.model", "");
 *
 * The FIRST render is always the fallback (server and client agree, so hydration
 * never mismatches); the stored value is adopted in a post-mount effect.
 * Use the same `key` across surfaces to share a choice.
 */
// Stop TS from pinning T to the fallback's literal type so callers that don't
// pass an explicit type argument get the widened type (e.g. string, not "").
type NoInferX<T> = [T][T extends unknown ? 0 : never];

/** The raw localStorage key a preference is stored under. */
export function preferenceStorageKey(key: string): string {
  return storageKey(`pref:${key}`);
}

export function usePreference<T = string>(
  key: string,
  fallback: NoInferX<T>,
): [T, (v: T | ((prev: T) => T)) => void] {
  const lsKey = preferenceStorageKey(key);
  const fb = fallback as T;

  const [value, setValue] = useState<T>(fb);
  // Mirrors `value`; updated alongside every setValue below.
  const valueRef = useRef(value);

  useEffect(() => {
    let local: T = fb;
    try {
      const raw = localStorage.getItem(lsKey);
      if (raw != null) {
        try { local = JSON.parse(raw) as T; } catch { local = raw as unknown as T; }
      }
    } catch { /* storage unavailable — keep the fallback */ }
    if (!Object.is(local, valueRef.current)) {
      valueRef.current = local;
      setValue(local);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [lsKey]);

  const set = useCallback((v: T | ((prev: T) => T)) => {
    const next = typeof v === "function" ? (v as (prev: T) => T)(valueRef.current) : v;
    valueRef.current = next;
    setValue(next);
    try { localStorage.setItem(lsKey, JSON.stringify(next)); } catch { /* storage unavailable — value still applies this session */ }
  }, [lsKey]);

  return [value, set];
}
