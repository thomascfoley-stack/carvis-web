/**
 * Client-side failure reporting.
 *
 * Half of this app runs in the browser — the recogniser, the audio pipeline,
 * the orb — and every failure there used to be invisible. The server's
 * `failures` table already collects backend defects; this is the missing half,
 * pooled into the same bucket so one query answers "what is broken".
 *
 * Deliberately cheap and deliberately quiet:
 *  - fire-and-forget; a failed report must never surface to the user or throw
 *  - deduplicated, so a loop cannot post the same line hundreds of times
 *  - capped per page load, so a pathological state cannot flood the table
 *  - no payloads, only a node name and a short message; the server redacts
 *    again on arrival, because a message can contain a provider's echo of a key
 */

const seen = new Map<string, number>();
let sent = 0;

/** Past this we stop: something is wrong with the reporter, not the app. */
const MAX_PER_PAGE = 40;
/** The same failure more than once a minute is noise, not new information. */
const REPEAT_MS = 60_000;

export function reportClientFailure(node: string, message: string): void {
  if (typeof window === "undefined") return;
  if (sent >= MAX_PER_PAGE) return;

  const key = `${node} ${message}`.slice(0, 300);
  const now = Date.now();
  const last = seen.get(key);
  if (last && now - last < REPEAT_MS) return;
  seen.set(key, now);
  if (seen.size > 200) seen.clear();
  sent++;

  try {
    const body = JSON.stringify({
      node: String(node).slice(0, 64),
      message: String(message).slice(0, 400),
      ua: navigator.userAgent.slice(0, 160),
    });
    // sendBeacon survives the page going away, which is exactly when the most
    // interesting failures happen. fetch is the fallback for older browsers.
    if (navigator.sendBeacon?.(("/api/failures"), new Blob([body], { type: "application/json" }))) {
      return;
    }
    void fetch("/api/failures", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body,
      keepalive: true,
    }).catch(() => undefined);
  } catch {
    /* telemetry must never break the thing it is watching */
  }
}

/**
 * Catch what no component thought to handle. Without this an exception in a
 * render path or an unawaited rejection simply vanished.
 */
export function installGlobalReporter(): () => void {
  if (typeof window === "undefined") return () => {};

  const onError = (e: ErrorEvent) =>
    reportClientFailure("client.uncaught", `${e.message} @ ${e.filename}:${e.lineno}`);
  const onRejection = (e: PromiseRejectionEvent) =>
    reportClientFailure("client.unhandled", String((e.reason as Error)?.message ?? e.reason));

  window.addEventListener("error", onError);
  window.addEventListener("unhandledrejection", onRejection);
  return () => {
    window.removeEventListener("error", onError);
    window.removeEventListener("unhandledrejection", onRejection);
  };
}
