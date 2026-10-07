// The heartbeat's in-flight row for the OPEN turn starts from `git diff HEAD`
// plus untracked files, which is everything dirty in the checkout. Two kinds of
// section in it are not the open turn's:
//
//   - a file that has not moved since the turn began (the turn's start shadow
//     holds the same bytes): an earlier turn's uncommitted work, or anything
//     else that was already lying there;
//   - a file another live session in this checkout claims and we do not.
//
// Only ever narrows. A section whose file name cannot be read is kept, and a
// turn-start read that failed (null) narrows nothing.

const SECTION_FILE = /^diff --git a\/(.*?) b\//;

export function scopeUncommittedToOpenTurn(
  uncommittedDiff: string,
  scope: {
    /** Files that differ between the turn's start shadow and the live tree; null when unknown. */
    changedSinceTurnStart: readonly string[] | null;
    /** Repo-relative files other live sessions claim and this one does not. */
    claimedByOthers: readonly string[];
  },
): string {
  if (!uncommittedDiff) return uncommittedDiff;
  const moved = scope.changedSinceTurnStart ? new Set(scope.changedSinceTurnStart) : null;
  const theirs = new Set(scope.claimedByOthers);
  if (!moved && theirs.size === 0) return uncommittedDiff;
  const kept: string[] = [];
  let dropped = false;
  for (const part of uncommittedDiff.split(/(?=^diff --git )/m)) {
    const file = part.match(SECTION_FILE)?.[1];
    if (file && ((moved && !moved.has(file)) || theirs.has(file))) { dropped = true; continue; }
    kept.push(part);
  }
  return dropped ? kept.join('').trim() : uncommittedDiff;
}

interface NarrowingState {
  promptShadows?: Array<{ promptIndex: number; shadowSha: string; cutAfterTurnStart?: boolean }>;
  turnEndShadows?: Array<{ promptIndex: number; shadowSha: string }>;
  sessionStartShadowSha?: string | null;
}

/**
 * The tree the open turn (LOCAL index) started from, for narrowing its
 * in-flight diff — or null when that is not known, and nothing is narrowed.
 *
 * The turn's own shadow, unless it was cut after the turn had begun writing
 * (`cutAfterTurnStart`): Cursor adopting a prompt its hooks never announced
 * cuts one AFTER the edit that revealed it, and the Codex heartbeat cuts one
 * when it notices the prompt. A file written before the cut and not since is
 * identical in that shadow and the live tree, so narrowing against it dropped
 * the turn's own file from the tick — and when that was its only file, the
 * tick returned before the ledger could put it back (TODO f7406e7e).
 *
 * For such a turn the tree the PREVIOUS turn's Stop closed on is where this
 * one began; the first turn began at the session-start shadow. With neither,
 * do not narrow: a tick row that over-reports until Stop replaces it is
 * recoverable, a file dropped from it is not.
 */
export function openTurnNarrowingBase(state: NarrowingState, localTurn: number): string | null {
  const own = (state.promptShadows || []).find((s) => s.promptIndex === localTurn);
  if (!own?.shadowSha) return null;
  if (!own.cutAfterTurnStart) return own.shadowSha;
  if (localTurn === 0) return state.sessionStartShadowSha || null;
  const prevEnd = (state.turnEndShadows || []).find((s) => s.promptIndex === localTurn - 1);
  return prevEnd?.shadowSha || null;
}

