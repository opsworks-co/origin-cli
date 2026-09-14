import type { JournalEntry } from './write-journal.js';

export interface RecoveryState {
  promptTurnIds?: string[];
  promptShadows?: Array<{ promptIndex: number; promptStartedAt?: number }>;
}

/** Read-time boundaries only: never rewrite the journal or mint wire identities. */
export function recoverJournalTurns(entries: JournalEntry[], state: RecoveryState): {
  entries: JournalEntry[]; turnIds: string[];
} {
  const turnIds = [...(state.promptTurnIds || [])];
  const unchanged = { entries, turnIds };
  // Position remains authoritative. If clocks went backwards, timestamp-based
  // insertion cannot locate a trustworthy slot; keep the existing fallback.
  if (entries.some((e, i) => !Number.isFinite(e.at) || (i > 0 && e.at < entries[i - 1].at))) return unchanged;
  const starts = (state.promptShadows || [])
    .filter(s => Number.isInteger(s.promptIndex) && s.promptIndex >= 0
      && Number.isFinite(s.promptStartedAt) && s.promptStartedAt! > 0)
    .map(s => ({ local: s.promptIndex, at: s.promptStartedAt! }))
    .sort((a, b) => a.local - b.local);
  // Equal/contradictory prompt times cannot establish which prompt owns a write.
  if (starts.some((s, i) => i > 0 && (s.local === starts[i - 1].local || s.at <= starts[i - 1].at))) return unchanged;
  const marked = new Set(entries.flatMap(e => e.kind === 'turn' ? [e.turnId] : []));
  const recovered: JournalEntry[] = [];
  for (const { local, at } of starts) {
    const id = turnIds[local];
    if (id && marked.has(id)) continue; // Never move a real hook/reclaim mark.
    // A real mark's position can disagree with transcript time. Do not insert
    // a missing prompt on the wrong side of a known sibling's mark.
    if (entries.some(e => {
      if (e.kind !== 'turn') return false;
      const sibling = turnIds.indexOf(e.turnId);
      return e.at === at || (sibling >= 0 && (sibling < local ? e.at > at : e.at < at));
    })) continue;
    let lookup = id || `recovered-ledger-turn-${local}`;
    while (!id && (marked.has(lookup) || turnIds.includes(lookup))) lookup = `_${lookup}`;
    turnIds[local] = lookup;
    recovered.push({ kind: 'turn', turnId: lookup, at });
  }
  if (!recovered.length) return unchanged;
  // Merge without reordering or removing real entries, including checkout fences.
  const merged: JournalEntry[] = [];
  let next = 0;
  for (const entry of entries) {
    while (next < recovered.length && recovered[next].at <= entry.at) merged.push(recovered[next++]);
    merged.push(entry);
  }
  merged.push(...recovered.slice(next));
  return { entries: merged, turnIds };
}
