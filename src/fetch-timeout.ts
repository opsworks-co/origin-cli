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

/**
 * Timeout for a call the server answers with an LLM.
 *
 * 8s is sized for the small request/response the hook budget allows. A model
 * round trip is not that — the server has to prompt a provider and wait, and it
 * routinely takes tens of seconds. So these aborted essentially every time:
 * `memory brief refresh error (non-fatal) {"message":"This operation was
 * aborted"}` was the single largest source of aborts in this machine's hook log
 * (20 of them), and every one wasted the provider call the server had already
 * paid for.
 *
 * Safe to be generous because no LLM call runs inside a budgeted AGENT hook —
 * maybeRefreshMemoryBrief runs at session-END, post-COMMIT and backfill (its own
 * comment says so), and the summary runs at session end. Both are already
 * best-effort: on failure the caller falls back to the heuristic summary or
 * simply leaves the brief unchanged.
 */
export const LLM_CALL_TIMEOUT_MS = 60_000;

/**
 * Timeout for a call whose BODY is the payload — sized from how big it is.
 *
 * `DEFAULT_FETCH_TIMEOUT_MS` is documented above as sized for "the small
 * request/response an agent hook's ~10s budget allows". `updateSession` is not
 * that: it carries a session's ENTIRE state — every prompt diff, all editsJson,
 * commit attribution, the transcript — and it grows monotonically as the
 * session runs. Past a few hundred KB it cannot finish in 8s, and because the
 * watcher rebuilds the same payload every poll, it then fails at exactly 8s
 * forever. The server's copy of the session freezes at that moment while local
 * capture goes on working perfectly, so nothing looks broken until someone
 * compares the two.
 *
 * Observed on this machine (session 1271f66c): four consecutive
 * `AbortError: This operation was aborted`, each exactly 8.0s after its payload
 * was built, while the watcher log showed the turn captured correctly with its
 * 7 files and its commit. Nothing was wrong with the capture. It just could not
 * be delivered, and the session sat 35 minutes stale.
 *
 * Deliberately NOT a blanket raise of the default. A hook that sends a large
 * body still wants to fail FAST — the agent kills it at ~10s, and a kill means
 * the durable-retry enqueue never runs, which loses the payload outright. So
 * this is opt-in per call site: the background daemons (transcript-watch,
 * codex-watch) ask for it, hooks keep the 8s fast-fail.
 *
 * The allowance covers transfer AND server processing, which is why it is far
 * more generous than raw bandwidth would suggest.
 */
export const PAYLOAD_TIMEOUT_BYTES_PER_SEC = 25_000;
export const MAX_PAYLOAD_TIMEOUT_MS = 60_000;

export function timeoutForPayload(bytes: number): number {
  if (!Number.isFinite(bytes) || bytes <= 0) return DEFAULT_FETCH_TIMEOUT_MS;
  const allowance = Math.ceil((bytes / PAYLOAD_TIMEOUT_BYTES_PER_SEC) * 1000);
  return Math.min(DEFAULT_FETCH_TIMEOUT_MS + allowance, MAX_PAYLOAD_TIMEOUT_MS);
}

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
