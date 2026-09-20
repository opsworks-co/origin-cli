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
