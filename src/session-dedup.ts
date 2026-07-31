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
  prompts?: string[];
  promptShadows?: Array<{ promptIndex: number; shadowSha: string; capturedAt: string }>;
  promptStartedAt?: number[];
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
  return state;
}
