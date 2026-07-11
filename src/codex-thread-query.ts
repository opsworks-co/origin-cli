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

/** SQL for the strict exact-cwd lookup (single-quotes escaped). */
export function buildCodexThreadByCwdQuery(columns: string, repoPath: string): string {
  const exactCwd = repoPath.replace(/'/g, "''");
  return `SELECT ${columns} FROM threads WHERE cwd = '${exactCwd}' ORDER BY updated_at DESC LIMIT 1;`;
}
