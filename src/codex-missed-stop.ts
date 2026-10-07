/**
 * A Codex turn whose Stop hook never fired still gets its row (TODO 6d70bb43).
 *
 * Rows come from Stop: submit sends only the prompt text, and the heartbeat
 * only the session's prompt list. Codex fires no Stop for a turn that ends in
 * an error — its usage limit is the one seen (a7bd7e32, 2026-09-18: 22 prompts,
 * 21 rows; the last turn ran 20 commands and ended "You've hit your usage
 * limit"). A later prompt's Stop re-derives every turn, so only the LAST turn
 * of a chat is lost for good.
 *
 * The rollout records the end (`task_complete`). When that end is older than
 * Codex's own Stop timeout and the turn is still open, no Stop is coming: the
 * heartbeat runs the Stop hook for it, once.
 */

/** Codex's Stop timeout (enable.ts gives Stop 600 s). Past it, no Stop is still running. */
export const CODEX_MISSED_STOP_GRACE_MS = 11 * 60 * 1000;

export function codexTurnMissingItsStop(input: {
  lastTurnEnd?: { at: number; promptCount: number } | null;
  /** Prompts in the rollout now. */
  rolloutPrompts: number;
  /** `state.prompts.length`. */
  statePrompts: number;
  lastClosedTurnIndex?: number | null;
  now: number;
  /** Local turn indexes this process already ran a Stop for. */
  alreadyRan: ReadonlySet<number>;
  graceMs?: number;
}): number | null {
  const end = input.lastTurnEnd;
  if (!end || !Number.isFinite(end.at) || end.promptCount <= 0) return null;
  // A prompt after the end means a turn is running; its own Stop covers the rest.
  if (end.promptCount !== input.rolloutPrompts) return null;
  if (input.now - end.at < (input.graceMs ?? CODEX_MISSED_STOP_GRACE_MS)) return null;
  const last = input.statePrompts - 1;
  if (last < 0) return null;
  const closed = Number.isInteger(input.lastClosedTurnIndex) ? (input.lastClosedTurnIndex as number) : -1;
  if (closed >= last) return null;
  if (input.alreadyRan.has(last)) return null;
  return last;
}
