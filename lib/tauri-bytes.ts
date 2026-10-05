/**
 * Raw-bytes IPC helpers — move media bytes across the Tauri bridge as a RAW request
 * body / response, NOT as a JSON number array.
 *
 * Passing a `Uint8Array` nested in an invoke's args object makes Tauri 2 JSON-encode
 * it as an array of decimal numbers — ~3.5× the file size AS A STRING, plus the full
 * ArrayBuffer copy and the intermediate number array. For a large clip that freezes
 * or OOMs the webview (and, because the write could then fail silently, LOSES media).
 * Tauri 2 accepts an `ArrayBuffer`/`Uint8Array` as the invoke args (sent as a raw
 * request body) with metadata in `headers`; the Rust command reads `request.body()`
 * and `request.headers()`. Byte reads come back via `tauri::ipc::Response` as an
 * `ArrayBuffer` (not a number array). This module is the ONE place that encoding lives.
 */

/** UTF-8-safe base64 so a Unicode id/filename survives an ASCII-only HTTP header. */
function b64(s: string): string {
  return btoa(unescape(encodeURIComponent(s)));
}

// Above this size a Blob is chunk-STREAMED to a staging temp file instead of crossing the
// bridge as one buffer — the fix for the WebView2 renderer OOM (black screen) on large
// media. Below it, the single-buffer fast path is unchanged (thumbnails, small audio, JSON).
const STREAM_THRESHOLD = 24 * 1024 * 1024; // 24 MB
const STREAM_CHUNK = 8 * 1024 * 1024; //  8 MB per chunk → ~8 MB peak webview heap

/** Random staging token (no crypto needed — it only namespaces a temp file). */
function stageToken(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

/**
 * Invoke `cmd` sending `data` as a RAW request body, with `headers` carrying the
 * metadata (base64-encoded so Unicode values are header-safe). The Rust command must
 * take a `tauri::ipc::Request<'_>`. Returns the command's result (a `string` by
 * default; pass the type param when the command returns a JSON object). Throws on
 * failure (callers surface it — never swallow a media write failure).
 */
export async function invokeWithBytes<T = string>(
  cmd: string,
  data: Blob | ArrayBuffer | Uint8Array,
  headers: Record<string, string> = {},
): Promise<T> {
  const { invoke } = await import("@tauri-apps/api/core");
  const encoded: Record<string, string> = {};
  for (const [k, v] of Object.entries(headers)) encoded[k] = b64(v);

  // Large Blob → chunk-STREAM it to a staging temp file so the webview never holds the
  // whole file as one ArrayBuffer (a 500MB import otherwise spikes the renderer heap
  // ~1.5GB → WebView2 OOM → black screen). The Rust sink reads the assembled file via
  // `body_or_staged` (keyed by the `stage-token` header). Only reads one CHUNK at a time.
  if (data instanceof Blob && data.size > STREAM_THRESHOLD) {
    const token = stageToken();
    try {
      let seq = 0;
      for (let off = 0; off < data.size; off += STREAM_CHUNK) {
        const chunk = await data.slice(off, Math.min(off + STREAM_CHUNK, data.size)).arrayBuffer();
        await invoke("stage_append", chunk, { headers: { token: b64(token), seq: b64(String(seq)) } });
        seq++;
      }
      // Final call: no body — the command pulls the staged file via the stage-token header.
      return await invoke<T>(cmd, new Uint8Array(0), { headers: { ...encoded, "stage-token": b64(token) } });
    } catch (e) {
      // Best-effort: drop the partial staging file so it doesn't linger until the sweep.
      try { await invoke("stage_discard", { token }); } catch { /* swept after 24h anyway */ }
      throw e;
    }
  }

  // Tauri 2 accepts an ArrayBuffer OR a Uint8Array directly as the raw args — no need
  // to normalize to ArrayBuffer (which tripped over Uint8Array.buffer being an
  // ArrayBufferLike that may be a SharedArrayBuffer). Only a Blob needs reading.
  const body: ArrayBuffer | Uint8Array = data instanceof Blob ? await data.arrayBuffer() : data;
  return await invoke<T>(cmd, body, { headers: encoded });
}

/**
 * Invoke `cmd` (which returns `tauri::ipc::Response`) and read the raw bytes back as a
 * `Uint8Array` (the response is an `ArrayBuffer` on the JS side — no number array).
 */
export async function invokeForBytes(
  cmd: string,
  args?: Record<string, unknown>,
): Promise<Uint8Array> {
  const { invoke } = await import("@tauri-apps/api/core");
  const buf = await invoke<ArrayBuffer>(cmd, args);
  return new Uint8Array(buf);
}
