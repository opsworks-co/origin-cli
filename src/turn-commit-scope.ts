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
/**
 * Stop marked `promptIndex` closed and then died before its row went out.
 *
 * Stop marks the turn closed on disk BEFORE it sends (markTurnClosedOnDisk),
 * so no heartbeat tick can out-stamp its row — and the heartbeat then leaves a
 * closed turn alone. A Stop killed in between (Codex's hook timeout, a crash)
 * left the row at the last pre-Stop tick until the next prompt or session end
 * (Origin TODO 00ced3dc).
 *
 * Abandoned only when ALL hold: Stop marked THIS turn, never recorded sending
 * its row, never finished (the turn is still the active one — closeTurn clears
 * it), and the mark is older than any Stop is allowed to run. A Stop that is
 * merely slow is still inside that window and keeps the heartbeat silent.
 */
export function stopAbandonedTurn(
  state: {
    stopClosing?: { turn?: number; at?: number } | null;
    stopSentTurnIndex?: number | null;
    activeTurn?: { index?: number } | null;
  },
  promptIndex: number,
  now: number = Date.now(),
): boolean {
  const mark = state.stopClosing;
  if (!mark || mark.turn !== promptIndex || !Number.isFinite(mark.at as number)) return false;
  if (Number.isInteger(state.stopSentTurnIndex as number) && (state.stopSentTurnIndex as number) >= promptIndex) return false;
  if (state.activeTurn?.index !== promptIndex) return false;
  return now - (mark.at as number) > STOP_ABANDONED_AFTER_MS;
}

/**
 * The last turn, when its Stop closed it and then died before sending — the
 * turn stopAbandonedTurn cannot see.
 *
 * stopAbandonedTurn hands a killed Stop's turn back to the heartbeat's diff
 * tick only while that turn is still `activeTurn`. A chat-only turn never sets
 * `activeTurn` (no tool hook opens it), and the tick re-sends a diff row, not
 * usage. Prod fb6968b3: the last turn ("can i close this session?") — Stop
 * exited 1 between markTurnClosedOnDisk and markStopSentOnDisk, so the row
 * kept no usage and the session's totals missed that reply, for good: a later
 * prompt's Stop would have re-sent every turn, but there was none, and the
 * heartbeat's idle end sends no tokens.
 *
 * Returns the local turn to run Stop for again: Stop marked it closed and
 * never recorded sending it, it is the last prompt (a later one's Stop covers
 * it), nothing has opened another turn, the mark is older than any Stop may
 * run, and this process has not already tried it.
 */
export function closedTurnLeftUnsent(
  state: {
    stopClosing?: { turn?: number; at?: number } | null;
    stopSentTurnIndex?: number | null;
    activeTurn?: { index?: number } | null;
    prompts?: unknown[];
  },
  alreadyRan: ReadonlySet<number>,
  now: number = Date.now(),
): number | null {
  const mark = state.stopClosing;
  if (!mark || !Number.isInteger(mark.turn) || !Number.isFinite(mark.at as number)) return null;
  const turn = mark.turn as number;
  if (Number.isInteger(state.stopSentTurnIndex as number) && (state.stopSentTurnIndex as number) >= turn) return null;
  if ((state.prompts?.length ?? 0) - 1 !== turn) return null;
  if (state.activeTurn && state.activeTurn.index !== turn) return null;
  if (now - (mark.at as number) <= STOP_ABANDONED_AFTER_MS) return null;
  if (alreadyRan.has(turn)) return null;
  return turn;
}

// Longer than any Stop hook may run: Codex's is registered with 600 s
// (enable.ts CODEX_STOP_HOOK_TIMEOUT_SEC), plus a minute of slack.
export const STOP_ABANDONED_AFTER_MS = 11 * 60_000;

export function turnIsClosed(
  state: { lastClosedTurnIndex?: number | null },
  promptIndex: number,
): boolean {
  const closed = state.lastClosedTurnIndex;
  return Number.isInteger(closed as number) && (closed as number) >= promptIndex;
}
