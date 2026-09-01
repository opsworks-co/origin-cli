// One state file per server session.
//
// The server's session-start dedup ladder can return an EXISTING sessionId for
// what the CLI treated as a NEW conversation — Codex fires session-start on
// every launch and its per-turn thread id rotates, so the CLI mints a fresh
// tag while the server matches the still-live session. If the CLI then writes a
// second tagged state file, ONE server session ends up with TWO local state
// files, each carrying its own prompts[] / promptShadows.
//
// That silently breaks capture: the new file's turn numbering restarts at 0 and
// collides with indices the first file already recorded. Server-side promptText
// is append-only (first write wins), so the re-sent indices keep the OLD text
// and the genuinely-new turns are dropped — user-visible as "it stopped
// capturing" (Codex on Windows), with findStateForHook logging candidateCount:2
// and two tags for one sessionId.
//
// These are pure so they can be unit-tested; commands/hooks.ts wires them in.

/** Minimal shape we need — the real SessionState is a superset. */
export interface DedupCandidate {
  sessionId?: string;
  sessionTag?: string;
  claudeSessionId?: string;
  status?: string;
  prompts?: string[];
  promptShadows?: Array<{ promptIndex: number; shadowSha: string; capturedAt: string }>;
  promptStartedAt?: number[];
  // Everything else a turn accumulates. These were NOT carried before, so a
  // carry-forward restored the prompt LIST while dropping the per-turn work
  // recorded against it — the mappings a Stop had already built, the stable
  // turn ids the server keys rows on, and the live edit ledger.
  completedPromptMappings?: unknown[];
  promptTurnIds?: string[];
  promptResponses?: string[];
  liveEdits?: unknown[];
  lastClosedTurnIndex?: number;
  promptIndexBase?: number;
}

/**
 * Find a state file that belongs to the SAME server session but was written
 * under a different tag — i.e. the duplicate this launch is about to create.
 * Returns null when there's nothing to merge (the normal case).
 */
export function findDuplicateStateForSession<T extends DedupCandidate>(
  sessions: T[],
  sessionId: string,
  currentTag: string,
): T | null {
  if (!sessionId || !currentTag) return null;
  for (const s of sessions) {
    if (s?.sessionId === sessionId && s.sessionTag && s.sessionTag !== currentTag) return s;
  }
  return null;
}

/**
 * Carry the duplicate's accumulated turn state onto the incoming state so turn
 * numbering CONTINUES instead of restarting at 0.
 *
 * Only ever grows: a shorter/emptier duplicate never overwrites richer incoming
 * state. Baselines (headShaAtStart etc.) are deliberately NOT copied — those
 * belong to this launch. Mutates and returns `state` for convenience.
 */
export function carryForwardTurnState<T extends DedupCandidate>(state: T, dup: DedupCandidate): T {
  if (Array.isArray(dup.prompts) && dup.prompts.length > (state.prompts?.length || 0)) {
    state.prompts = dup.prompts;
  }
  if (Array.isArray(dup.promptShadows) && dup.promptShadows.length > (state.promptShadows?.length || 0)) {
    state.promptShadows = dup.promptShadows;
  }
  if (Array.isArray(dup.promptStartedAt) && dup.promptStartedAt.length > (state.promptStartedAt?.length || 0)) {
    state.promptStartedAt = dup.promptStartedAt;
  }
  // Carrying `prompts` alone restores the NUMBERING but not the work recorded
  // against it: the mappings Stop already built, the turn ids the server keys
  // rows on, and the live ledger would all restart empty while the indices
  // continued — so the resumed turn re-sends indices whose content is gone.
  if (Array.isArray(dup.completedPromptMappings)
      && dup.completedPromptMappings.length > (state.completedPromptMappings?.length || 0)) {
    state.completedPromptMappings = dup.completedPromptMappings;
  }
  if (Array.isArray(dup.promptTurnIds) && dup.promptTurnIds.length > (state.promptTurnIds?.length || 0)) {
    state.promptTurnIds = dup.promptTurnIds;
  }
  if (Array.isArray(dup.promptResponses) && dup.promptResponses.length > (state.promptResponses?.length || 0)) {
    state.promptResponses = dup.promptResponses;
  }
  if (Array.isArray(dup.liveEdits) && dup.liveEdits.length > (state.liveEdits?.length || 0)) {
    state.liveEdits = dup.liveEdits;
  }
  if (Number.isInteger(dup.lastClosedTurnIndex as number)
      && (dup.lastClosedTurnIndex as number) > (state.lastClosedTurnIndex ?? -1)) {
    state.lastClosedTurnIndex = dup.lastClosedTurnIndex;
  }
  // Restoring `prompts` restores the LOCAL numbering; this restores the offset
  // that turns it into a SERVER row. Both or neither — carrying the list while
  // dropping the base is worse than carrying nothing, because the numbering
  // then looks healthy while every retroactive capture aims one whole base
  // short. An already-adopted session (Copilot's join gap makes the base 1)
  // whose resume SUCCEEDS would otherwise file its newest turn on the previous
  // turn's row — the corruption this offset exists to prevent, in the one path
  // where the state file survived and the transcript seed therefore never runs.
  if (Number.isInteger(dup.promptIndexBase as number)
      && (dup.promptIndexBase as number) > (state.promptIndexBase ?? 0)) {
    state.promptIndexBase = dup.promptIndexBase;
  }
  return state;
}

/**
 * When several candidate state files turn out to be the SAME server session,
 * keep the one that actually holds the turns.
 *
 * The merge guards above close the duplicate at its source, but they are two
 * processes racing: session-start and the user-prompt-submit auto-create both
 * call startSession, the server hands both the same sessionId, and each scans
 * for the other just before saving. Interleave those four steps unluckily and
 * both files still land.
 *
 * That leaves the reader to choose, and the choice was arbitrary — candidates
 * are ordered by `startedAt`, which for two files minted seconds apart says
 * nothing about which one the prompts went into. Picking wrong is not a
 * degraded read, it is a dead one: session eebcce84 picked the empty file and
 * every `after-file-edit` aborted "no current prompt" for the whole session.
 *
 * Scoped deliberately to candidates that share a sessionId — this re-ranks
 * copies of one session and can never promote a DIFFERENT session over the
 * agent/cwd matching that selected this list. Entries with no sessionId pass
 * through untouched, and relative order is preserved so every existing
 * tiebreak still decides everything else.
 */
export function preferRicherSameSessionState<T extends DedupCandidate>(matching: T[]): T[] {
  if (matching.length < 2) return matching;
  const richness = (s: T) => [
    (s.prompts?.length || 0),
    (s.completedPromptMappings?.length || 0),
    (s.promptShadows?.length || 0),
  ];
  const best = new Map<string, T>();
  for (const s of matching) {
    const id = s?.sessionId;
    if (!id) continue;
    const cur = best.get(id);
    if (!cur) { best.set(id, s); continue; }
    const [ap, am, ash] = richness(s);
    const [bp, bm, bsh] = richness(cur);
    if (ap > bp || (ap === bp && (am > bm || (am === bm && ash > bsh)))) best.set(id, s);
  }
  return matching.filter((s) => !s?.sessionId || best.get(s.sessionId) === s);
}

/**
 * The state file already written under THIS tag, when it belongs to the same
 * live conversation.
 *
 * Claude Code fires SessionStart again for a conversation it already started —
 * on resume, on context compaction, on re-attach (`input.source` says which).
 * The tag is derived from the conversation id, so that second start computes
 * the SAME tag and `saveSessionState` overwrites the file in place. Nothing
 * treated it as a duplicate: findDuplicateStateForSession only looks for a
 * DIFFERENT tag holding the same sessionId.
 *
 * The earlier dedup guard in handleSessionStart is supposed to catch this, but
 * it is a heuristic scan gated on file mtime freshness, and when it misses the
 * entire prompt history is destroyed. With `prompts` back to length 1 every
 * later capture stamps index 0: prod session 0c65017f had 6 prompts in its
 * transcript and 1 in state, +399/-24 across 9 files filed under prompt 1,
 * and prompts 2-5 recording nothing at all.
 */
export function findSameTagStateForResume<T extends DedupCandidate>(
  sessions: T[],
  sessionTag: string,
  claudeSessionId?: string,
): T | null {
  if (!sessionTag) return null;
  for (const s of sessions) {
    if (s?.sessionTag !== sessionTag) continue;
    if (String(s.status || '').toUpperCase() === 'ENDED') continue;
    // Same tag but a different conversation would mean a tag collision; don't
    // graft one conversation's turns onto another.
    if (claudeSessionId && s.claudeSessionId && s.claudeSessionId !== claudeSessionId) continue;
    return s;
  }
  return null;
}
