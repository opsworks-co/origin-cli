/**
 * One turn, two index spaces.
 *
 * LOCAL: everything this launch recorded itself is numbered from 0 —
 * `state.prompts`, `promptTurnIds`, `promptShadows`, `liveEdits`, the
 * write-journal marks, `shellProbes`, `activeTurn.index`. `prompts` only ever
 * holds the turns THIS launch saw.
 *
 * SERVER: a PromptChange row is numbered by the turn's NATIVE position in the
 * conversation, which is what the transcript parsers emit and what
 * `completedPromptMappings` stores. A resumed, compacted or adopted
 * conversation has `promptIndexBase` earlier turns, so its local turn L is
 * server row B + L.
 *
 * The two coincide while the base is 0 — every ordinary session — which is
 * why a writer that conflates them looks correct for months. They diverge on
 * the first resume, and then a local index used as a server row aims at a row
 * that belongs to a different turn, and a server row used as a local index
 * finds nothing (no turn id, no shadow) or somebody else's.
 *
 * Prod 8a626742 (2026-09-09): resumed with base 21. The transcript numbered
 * the turn 21; the ledger looked up `promptTurnIds[21]` (nothing), the clip
 * kept only rows below `prompts.length` (row 0), post-commit sent the commit
 * under local index 0, and the heartbeat's end payload sent the saved
 * mappings at 0..2 with no turn id at all. Row 21 was created late by the one
 * writer that converted; row 2 — a chat-only turn from the day before — took
 * the next turn's commit patch; rows 22 and 23 never existed; both commits
 * rendered under the wrong turns.
 *
 * Every helper here is the identity when the base is 0 or unknown, so a
 * caller that passes it through changes nothing for an ordinary session.
 */

/** LOCAL turn number → the SERVER row it belongs to. */
export function serverRowForLocalTurn(
  localIndex: number,
  promptIndexBase: number | undefined | null,
): number {
  if (!Number.isFinite(localIndex) || localIndex < 0) return localIndex;
  const base = Number.isFinite(promptIndexBase as number) ? (promptIndexBase as number) : 0;
  return base > 0 ? base + localIndex : localIndex;
}

/**
 * SERVER row → the LOCAL turn number it corresponds to.
 *
 * Returns null when the row predates our prompt list. That is the honest
 * answer for a turn that ran before this launch adopted the conversation: we
 * never recorded a start-state or an id for it, and pretending row N is our
 * local N hands back a DIFFERENT turn's shadow or turn id.
 */
export function localTurnForServerRow(
  serverIndex: number,
  promptIndexBase: number | undefined | null,
): number | null {
  if (!Number.isFinite(serverIndex) || serverIndex < 0) return null;
  const base = Number.isFinite(promptIndexBase as number) ? (promptIndexBase as number) : 0;
  if (base <= 0) return serverIndex;
  const local = serverIndex - base;
  return local >= 0 ? local : null;
}

/**
 * The stable id for the turn at a SERVER row, read from the local-numbered
 * `promptTurnIds`. Undefined for a row this launch has no id for — one that
 * predates the launch, or a session from before ids existed; those keep the
 * positional path.
 */
export function turnIdForServerRow(
  state: { promptTurnIds?: string[]; promptIndexBase?: number | null },
  serverIndex: number,
): string | undefined {
  const local = localTurnForServerRow(serverIndex, state.promptIndexBase);
  if (local === null) return undefined;
  const id = state.promptTurnIds?.[local];
  return typeof id === 'string' && id.length > 0 ? id : undefined;
}

/** Re-number LOCAL-indexed items onto their SERVER rows. Returns the same
 *  objects, mutated — callers hand in captures they built for this purpose. */
export function rebaseToServerRows<T extends { promptIndex: number }>(
  items: T[],
  promptIndexBase: number | undefined | null,
): T[] {
  for (const it of items) {
    if (it && Number.isInteger(it.promptIndex)) {
      it.promptIndex = serverRowForLocalTurn(it.promptIndex, promptIndexBase);
    }
  }
  return items;
}
