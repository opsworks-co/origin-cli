/**
 * Which of the session's commits did the OPEN turn make?
 *
 * The heartbeat stamps its in-flight row with that commit, and the server
 * fills a null sha from the first stamp it sees, so a wrong answer sticks.
 *
 * The rule it replaces: the first own commit after `prePromptSha` in
 * `sessionCommitShas`, and — when `prePromptSha` was not an own commit, which
 * it usually is not (it is HEAD at submit, often the pre-session base) — EVERY
 * own commit, so the session's FIRST commit. A turn Cursor never announced
 * keeps the previous turn's `prePromptSha`, so a heartbeat tick during it
 * stamped the previous turn's commit on it: capture-e2e-cursor-binary, turn 3's
 * "add helper" on turn 4's row, whenever a tick landed inside turn 4 (TODO
 * 0b224406; the golden failed a third of the time on main).
 *
 * Now, in order:
 *   1. a commit post-commit ATTESTED to this turn's id — the hook saw it made;
 *   2. an own commit that DESCENDS from the turn's start (strictly), or was
 *      made at or after the prompt's recorded start time;
 *   3. otherwise none — the server's read-time pass decides, as the heartbeat
 *      always said it would when no new commit had happened yet.
 *
 * The turn's start is the caller's best answer for the commit the turn began
 * from: the time-based baseline, else the turn's shadow resolved to the commit
 * it was cut on, else `prePromptSha`.
 */
export interface TurnCommitInputs {
  /** The session's own commits, oldest first. */
  ownCommits: readonly string[];
  /** Commits post-commit attested to this turn's id, in attestation order. */
  attested: readonly string[];
  /** The commit the turn began from; null when unknown. */
  start: string | null;
  /** Epoch ms the prompt was submitted; 0 when not recorded. */
  promptStartedAt: number;
  /** Is `anc` an ancestor of (or equal to) `desc`? */
  isAncestor: (anc: string, desc: string) => boolean;
  /** Committer time in ms; null when unknown. */
  commitTime: (sha: string) => number | null;
}

export function commitMadeByOpenTurn(i: TurnCommitInputs): string | null {
  const own = new Set(i.ownCommits);
  const attested = i.attested.find((sha) => own.has(sha));
  if (attested) return attested;
  for (const sha of i.ownCommits) {
    const descends = !!i.start && sha !== i.start && i.isAncestor(i.start, sha);
    if (descends) return sha;
    if (i.promptStartedAt > 0) {
      const at = i.commitTime(sha);
      const alreadyThere = !!i.start && i.isAncestor(sha, i.start);
      if (at !== null && at >= i.promptStartedAt && !alreadyThere) return sha;
    }
  }
  return null;
}
