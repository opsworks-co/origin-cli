// fetch() with a hard client-side timeout.
//
// The CLI's network calls run inside agent hooks that enforce a wall-clock
// budget (Codex kills a hook after 10s). A bare `fetch` to a slow or
// unreachable server hangs until the OS TCP timeout (tens of seconds) — long
// past that budget — so the agent kills the whole hook and reports "hook timed
// out after 10s", and the capture's durable-retry enqueue (which only runs on a
// clean throw) never gets to execute.
//
// A client-side timeout turns the hang into a fast AbortError, which callers
// already handle (network errors were always possible): the auth-status probe
// records "unreachable" and the durable queue enqueues the payload for retry.
// telemetry.ts and version-check.ts already do this inline; this is the shared
// version for the hook-critical api.ts / heartbeat.ts fetches.
export const DEFAULT_FETCH_TIMEOUT_MS = 8000;

export function fetchWithTimeout(
  url: string,
  opts: RequestInit = {},
  timeoutMs: number = DEFAULT_FETCH_TIMEOUT_MS,
): Promise<Response> {
  // A caller-supplied signal means the caller owns cancellation — respect it
  // rather than layering a second controller on top.
  if (opts.signal) return fetch(url, opts);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  // Don't let a pending timeout keep the process alive on its own.
  if (typeof (timer as { unref?: () => void }).unref === 'function') {
    (timer as { unref: () => void }).unref();
  }
  return fetch(url, { ...opts, signal: controller.signal }).finally(() => clearTimeout(timer));
}
