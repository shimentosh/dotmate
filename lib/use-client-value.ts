"use client";
import { useSyncExternalStore } from "react";

const noopSubscribe = () => () => {};

/**
 * Read a value that only exists in the browser (feature detection, `isTauri()`,
 * platform) without a hydration mismatch: the static HTML is rendered with
 * `serverValue`, the client renders `getClientValue()`. The value is read once
 * per render and must be stable (a primitive).
 */
export function useClientValue<T>(getClientValue: () => T, serverValue: T): T {
  return useSyncExternalStore(noopSubscribe, getClientValue, () => serverValue);
}
