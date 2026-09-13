/** A per-turn row the CLI sends on Stop. */
export type StopTurnRow = { promptIndex: number; [k: string]: unknown };

/**
 * Fold Stop payloads the way the server does: last write wins per promptIndex.
 *
 * The CLI sends two shapes: a FULL payload carrying every turn captured so
 * far, and a SINGLE-TURN payload carrying only the turn that just closed.
 * Both are correct on the wire. Taking `payloads[payloads.length - 1]`
 * therefore returned ONE row whenever the single-turn send landed last —
 * #1561, ~40% of runs on macOS and every run on the slower Windows runner.
 *
 * Observed sequence on a failing run, as [promptIndex, linesAdded]:
 *
 *   [[0,2]] [[0,2]] [[1,2]] [[0,2],[1,2]] … [[0,2],[1,2],[2,0],[3,1]] [[4,1]]
 *                                                                      ^ last
 *
 * Folding is the only reading that does not depend on which send happens to
 * be last. Accepts either `{ promptChanges }` bodies or already-extracted
 * row arrays, so each harness can pass what it already collects.
 */
export function foldStopRows(
  payloads: Array<{ promptChanges?: StopTurnRow[] } | StopTurnRow[] | null | undefined>,
): StopTurnRow[] {
  const byIndex = new Map<number, StopTurnRow>();
  for (const p of payloads) {
    const rows = Array.isArray(p) ? p : p?.promptChanges;
    if (!Array.isArray(rows)) continue;
    for (const r of rows) {
      if (r && typeof r.promptIndex === 'number') byIndex.set(r.promptIndex, r);
    }
  }
  return [...byIndex.values()].sort((a, b) => a.promptIndex - b.promptIndex);
}
