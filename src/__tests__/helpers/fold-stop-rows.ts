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
 *
 * "The way the server does" includes two rules the PATCH handler applies
 * (routes/mcp.ts) that a plain last-write fold did not:
 *
 *   1. A row captured EARLIER than the one already held cannot replace it
 *      (`isStaleCapture`: `capturedAt` older than the stored capture).
 *   2. A row that omits `editsJson` keeps the one already stored
 *      (`pcEditsJson !== null && …`).
 *
 * Without them the fold read a heartbeat's in-flight resend — stamped before
 * Stop, carrying no `editsJson`, but delivered after Stop on a loaded runner —
 * as the turn's final row. Real-binary turn 4 then kept its files and diff and
 * lost its edit evidence: "turn 4's own write is missing from its evidence",
 * on native Windows only, and only under the full suite's load. The journal
 * and Stop's own payload were both correct (E2E_DUMP of main's run
 * 34765915421); the server would have kept Stop's row.
 */
export function foldStopRows(
  payloads: Array<{ promptChanges?: StopTurnRow[] } | StopTurnRow[] | null | undefined>,
): StopTurnRow[] {
  const byIndex = new Map<number, StopTurnRow>();
  for (const p of payloads) {
    const rows = Array.isArray(p) ? p : p?.promptChanges;
    if (!Array.isArray(rows)) continue;
    for (const r of rows) {
      if (!r || typeof r.promptIndex !== 'number') continue;
      const prev = byIndex.get(r.promptIndex);
      if (!prev) { byIndex.set(r.promptIndex, r); continue; }
      if (typeof r.capturedAt === 'number' && typeof prev.capturedAt === 'number' && r.capturedAt < prev.capturedAt) {
        continue;
      }
      byIndex.set(r.promptIndex, r.editsJson == null && prev.editsJson != null ? { ...r, editsJson: prev.editsJson } : r);
    }
  }
  return [...byIndex.values()].sort((a, b) => a.promptIndex - b.promptIndex);
}
