/**
 * Work a turn wrote and then put back before it ended.
 *
 * Session b300fdf0 turn 10 (2026-09-26): the agent edited
 * `antigravity-transcript.ts`, found the same fix already merged as #1907,
 * ran `git checkout --` on the file and closed the turn with no commit. The
 * ledger resolved the file to netZero — the tree held the turn's baseline —
 * and the row went out with no files. The server kept the +46/-6 an earlier
 * capture had landed, and the page read "uncommitted": the same pill as a
 * turn whose work is still sitting dirty in the tree, which is what the user
 * read it as ("where did they go?").
 *
 * The signal is the intersection of two things the Stop already knows:
 *
 *   • `netZero` — files whose journal history the ledger resolved to the same
 *     bytes at the turn's end as at its start. On its own this is mostly
 *     NOISE: a branch switch rewrites a hundred files and the fast-forward
 *     brings them back within a second.
 *   • `authored` — files the turn's own hands wrote, on authoring evidence
 *     (a tool call, an edit hook, a command naming the file). A file the turn
 *     only received from a checkout never appears here.
 *
 * A file in both was written by the turn and is not in the tree. It is
 * discarded unless something the turn made still holds it: a commit (a turn
 * that commits on a branch and then switches back to main leaves the tree at
 * its baseline too) or a stash (`git stash` puts the tree back the same way —
 * stashed-work.ts). `committedFiles` is read lazily, because answering it
 * costs git reads and most turns have no candidate.
 *
 * Returns null when the answer is UNKNOWN — no authoring evidence at all, or
 * a commit of the turn that could not be read — so the caller leaves the
 * row's field alone instead of clearing a verdict an earlier Stop reached.
 */
export function discardedWorkForTurn(
  netZero: readonly string[],
  authored: ReadonlySet<string> | null | undefined,
  /** Files a commit or a stash of the turn holds; null when they could not be read. */
  committedFiles: () => ReadonlySet<string> | null,
): string[] | null {
  if (netZero.length === 0) return [];
  if (!authored) return null;
  const candidates = netZero.filter((f) => authored.has(f));
  if (candidates.length === 0) return [];
  const committed = committedFiles();
  if (committed === null) return null;
  return candidates.filter((f) => !committed.has(f));
}
