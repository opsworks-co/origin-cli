/**
 * Which of the session's commits belong to the turn whose baseline is `baseline`?
 *
 * A turn's committed work is every session commit that DESCENDS from the turn's
 * baseline — landed after the turn began. `git merge-base --is-ancestor A A`
 * answers yes, so a baseline that is itself one of the session's commits (the
 * previous turn committed, and the next prompt's shadow is that commit) passed
 * the ancestry test and the previous turn's whole commit was re-sent as the
 * current turn's work. Prod bc4a1438 (vodka): turn 3 committed b7f2dfd1, turn 4
 * asked a question, and the heartbeat published b7f2dfd1's 1,227 lines onto
 * turn 4 every five minutes with a fresh stamp.
 */
export function commitLandedInTurn(
  baseline: string | null | undefined,
  sha: string,
  isAncestor: (ancestor: string, descendant: string) => boolean,
): boolean {
  const isHex = (s: string) => /^[a-fA-F0-9]{7,40}$/.test(s);
  if (!isHex(sha)) return false;
  // No baseline to scope by: every session commit is the turn's, as before.
  if (!baseline || !isHex(baseline)) return true;
  const a = baseline.toLowerCase();
  const b = sha.toLowerCase();
  // The baseline itself — abbreviated on either side — is the turn's START,
  // not its work.
  if (a === b || a.startsWith(b) || b.startsWith(a)) return false;
  return isAncestor(baseline, sha);
}

/**
 * Has Stop already closed the turn at `promptIndex`? A closed turn's capture
 * is final: the Stop that closed it took the turn's diff from the ledger and
 * stamped it. Re-deriving the same turn from a shadow baseline afterwards can
 * only replace an observed capture with a reconstructed one — and it did, with
 * a newer stamp each tick, so the reconstruction always won.
 */
export function turnIsClosed(
  state: { lastClosedTurnIndex?: number | null },
  promptIndex: number,
): boolean {
  const closed = state.lastClosedTurnIndex;
  return Number.isInteger(closed as number) && (closed as number) >= promptIndex;
}
