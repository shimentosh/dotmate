import { describe, it, expect } from "vitest";
import { normalizeError, humanizeError, ErrorCode, isAppError } from "./app-error";

describe("normalizeError", () => {
  it("maps a 'Failed to fetch' TypeError to NetworkOffline (retryable, no raw message)", () => {
    const e = normalizeError(new TypeError("Failed to fetch"));
    expect(e.code).toBe(ErrorCode.NetworkOffline);
    expect(e.retryable).toBe(true);
    expect(e.userMessage).not.toMatch(/failed to fetch/i);
  });

  it("maps WebKit's 'Load failed' to NetworkOffline (cross-engine)", () => {
    expect(normalizeError(new TypeError("Load failed")).code).toBe(ErrorCode.NetworkOffline);
  });

  it("maps a bare AbortError to Canceled (external/user abort — NOT a timeout)", () => {
    // A caller/unmount abort surfaces as a bare AbortError ("The operation was aborted").
    // It must NOT be classified as a retryable network timeout (that retried cancelled
    // GETs through backoff and surfaced "This took too long").
    const e = normalizeError(new DOMException("The operation was aborted", "AbortError"));
    expect(e.code).toBe(ErrorCode.Canceled);
    expect(e.retryable).toBe(false);
  });

  it("maps a TimeoutError (AbortSignal.timeout) to NetworkTimeout (retryable)", () => {
    const e = normalizeError(new DOMException("timed out", "TimeoutError"));
    expect(e.code).toBe(ErrorCode.NetworkTimeout);
    expect(e.retryable).toBe(true);
  });

  it("treats an explicit cancel as Canceled (low, not retryable)", () => {
    const e = normalizeError(new DOMException("user cancelled", "AbortError"));
    expect(e.code).toBe(ErrorCode.Canceled);
    expect(e.retryable).toBe(false);
  });

  it("prefers a known HTTP status over incidental message text", () => {
    // A 5xx whose body text happens to say "no longer available" must be a retryable
    // ServerError, not MediaUnavailable; a 400 saying "timeout" must be InvalidInput,
    // not a retryable NetworkTimeout. (Status mapping runs before content heuristics.)
    const s = normalizeError(new Error("resource is no longer available"), { statusCode: 503 });
    expect(s.code).toBe(ErrorCode.ServerError);
    expect(s.retryable).toBe(true);
    const b = normalizeError(new Error("upstream timeout"), { statusCode: 400 });
    expect(b.code).toBe(ErrorCode.InvalidInput);
  });

  it("maps QuotaExceededError to StorageFull", () => {
    expect(normalizeError(new DOMException("quota", "QuotaExceededError")).code).toBe(ErrorCode.StorageFull);
  });

  it("maps a revoked-blob / local-media message to MediaUnavailable", () => {
    expect(normalizeError(new Error("blob:abc123 no longer available")).code).toBe(ErrorCode.MediaUnavailable);
    expect(normalizeError(new Error("local-media://xyz could not be read")).code).toBe(ErrorCode.MediaUnavailable);
  });

  it("maps HTTP status codes from context", () => {
    expect(normalizeError(new Error("x"), { statusCode: 401 }).code).toBe(ErrorCode.AuthExpired);
    expect(normalizeError(new Error("x"), { statusCode: 403 }).code).toBe(ErrorCode.AuthDenied);
    expect(normalizeError(new Error("x"), { statusCode: 402 }).code).toBe(ErrorCode.PaymentRequired);
    expect(normalizeError(new Error("x"), { statusCode: 404 }).code).toBe(ErrorCode.NotFound);
    expect(normalizeError(new Error("x"), { statusCode: 429 }).code).toBe(ErrorCode.RateLimited);
    const server = normalizeError(new Error("x"), { statusCode: 503 });
    expect(server.code).toBe(ErrorCode.ServerError);
    expect(server.retryable).toBe(true);
  });

  it("maps a Tauri string error to TauriError", () => {
    const e = normalizeError("encoder not found", { operation: "tauri:export_video" });
    expect(e.code).toBe(ErrorCode.TauriError);
  });

  it("is idempotent and merges context", () => {
    const first = normalizeError(new Error("boom"), { operation: "a" });
    const second = normalizeError(first, { url: "/x" });
    expect(isAppError(second)).toBe(true);
    expect(second.code).toBe(first.code);
    expect(second.context).toMatchObject({ operation: "a", url: "/x" });
  });

  it("falls back to Unknown with a non-empty user message", () => {
    const e = normalizeError({});
    expect(e.code).toBe(ErrorCode.Unknown);
    expect(e.userMessage.length).toBeGreaterThan(0);
  });
});

describe("humanizeError", () => {
  it("returns a humane string, never the raw network error", () => {
    expect(humanizeError(new TypeError("Failed to fetch"))).toMatch(/connection|reach/i);
  });
});
