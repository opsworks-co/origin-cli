/**
 * `chatOnly` is a marker for a row that shows NOTHING — set by the producers
 * that build an empty row (a question turn, the safety net, a gap fill, the
 * shadow pass's blank()) so the next prompt's retroactive capture does not
 * pour leftover working-tree dirt into it.
 *
 * It is a claim about the row, not about the turn, and it was allowed to
 * outlive the row it described: the shadow pass blanked c085f0af row 16 at
 * one Stop (chatOnly, turnWindowCaptured), the ledger refilled it at the next
 * (3 files, +48/-4, diffSource ledger) and left the marks in place. The state
 * file then carried `chatOnly: true` beside 5 KB of diff for a day. The server
 * ignores the flag, so the page was right; every local reader that takes the
 * flag for "emptied" — mergePromptMappings, a verifier rule — was not.
 *
 * Two guards: every fill drops the marks it contradicts (capture-from-ledger,
 * the commit-patch pass, the shadow window), and the state pick asks the row
 * rather than the flag.
 */

export interface RowContent {
  filesChanged?: unknown;
  diff?: string | null;
  uncommittedDiff?: string | null;
  contentUnavailableFiles?: unknown;
}

/** Does this row show any work at all — a file, a diff, or a declared cut? */
export function rowShowsWork(pm: RowContent): boolean {
  if (Array.isArray(pm.filesChanged) && pm.filesChanged.length > 0) return true;
  if ((pm.diff || '').trim()) return true;
  if ((pm.uncommittedDiff || '').trim()) return true;
  if (Array.isArray(pm.contentUnavailableFiles) && pm.contentUnavailableFiles.length > 0) return true;
  return false;
}

/**
 * The `chatOnly` field for the state round-trip: carried only while the row
 * is actually empty. A flag that survived a fill is dropped here, whatever
 * set it, so the saved row can never say "nothing" beside something.
 */
export function chatOnlyStateFlag(pm: RowContent & { chatOnly?: boolean }): { chatOnly: true } | Record<string, never> {
  return pm.chatOnly === true && !rowShowsWork(pm) ? { chatOnly: true } : {};
}
