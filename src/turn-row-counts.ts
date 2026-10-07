// The line counts a re-sent turn row carries.
//
// A stored mapping's counts are the producer's measurement — git's numstat
// for a commit patch, the ledger's for a ledger row — and they can exceed
// what the row's TEXT holds, because the text is cut at the wire budget and
// the counts are not. Re-sending a row must not replace them with a count of
// the cut text: prod c085f0af turn 2 (2026-09-26) was lowered from +729/-175
// to +81/-1 on every prompt by the submit hook's fire-and-forget update,
// which spread the stored row (commitPatch and all) and recounted its lines.
//
// Recounting stays for a mapping that never carried counts — the shape the
// server used to see from the heartbeat (session 1ea7a947).
export function rowLineCounts(pm: {
  diff?: string | null;
  linesAdded?: number | null;
  linesRemoved?: number | null;
}): { linesAdded: number; linesRemoved: number } {
  if (typeof pm.linesAdded === 'number' && Number.isFinite(pm.linesAdded)
    && typeof pm.linesRemoved === 'number' && Number.isFinite(pm.linesRemoved)) {
    return { linesAdded: pm.linesAdded, linesRemoved: pm.linesRemoved };
  }
  const dl = (pm.diff || '').split('\n');
  return {
    linesAdded: dl.filter((l) => l.startsWith('+') && !l.startsWith('+++')).length,
    linesRemoved: dl.filter((l) => l.startsWith('-') && !l.startsWith('---')).length,
  };
}
