// ── Codex thread lookup — shared STRICT query builder ──────────────────────
// Builds the SQL used to find a Codex thread in ~/.codex/state_*.sqlite.
// Matching is STRICT by design: exact thread id when the caller has one,
// else exact `cwd = repoPath` equality — never basename LIKE, never "newest
// thread overall". Both of those historically attributed a foreign Codex
// thread's rollout to the wrong session (multi-repo users; and the heartbeat
// daemon's old `cwd LIKE '%basename%'` lookup could grab any thread whose
// cwd merely CONTAINED the repo basename and overwrite state.prompts with
// that conversation).
//
// Shared by the hook path (agents/codex.ts, commands/hooks.ts) and the
// heartbeat daemon (heartbeat.ts — a standalone process with a deliberately
// minimal import surface; this module is dependency-free) so the two can't
// drift apart again.

/** True when `threadId` is safe to inline into the by-id query. */
export function isValidCodexThreadId(threadId: string | null | undefined): threadId is string {
  return typeof threadId === 'string' && /^[A-Za-z0-9_-]+$/.test(threadId);
}

/**
 * SQL for the strict by-id lookup, or null when the id isn't usable.
 * `columns` is a caller-controlled literal (never user input).
 */
export function buildCodexThreadByIdQuery(columns: string, threadId: string | null | undefined): string | null {
  if (!isValidCodexThreadId(threadId)) return null;
  return `SELECT ${columns} FROM threads WHERE id = '${threadId}' LIMIT 1;`;
}

/** SQL for the strict exact-cwd lookup (single-quotes escaped).
 *
 * Codex is a native app and stores `cwd` in the OS-native form: on Windows
 * that's backslashes (`C:\soft\repo`), whereas Origin normalizes repoPath to
 * forward slashes (`C:/soft/repo`). A single `cwd = repoPath` comparison then
 * matches nothing on Windows — the session is created with zero prompts and
 * gets swept as an empty handshake (the real cause of Codex sessions never
 * appearing on native Windows). Match BOTH separator forms so the lookup
 * succeeds regardless of which style either side wrote. This stays STRICT on
 * path *content* (no LIKE, no basename fallback), so the multi-repo isolation
 * the exact match guarantees is preserved. */
export function buildCodexThreadByCwdQuery(columns: string, repoPath: string): string {
  const variants = new Set<string>([
    repoPath,
    repoPath.replace(/\\/g, '/'),
    repoPath.replace(/\//g, '\\'),
  ]);
  const inList = [...variants]
    .map(v => `'${v.replace(/'/g, "''")}'`)
    .join(', ');
  return `SELECT ${columns} FROM threads WHERE cwd IN (${inList}) ORDER BY updated_at DESC LIMIT 1;`;
}
