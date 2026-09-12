// session-start publishes a provisional row BEFORE calling `session/start`, so
// a hook that fires meanwhile finds a session instead of minting one. Cursor
// is the agent that makes this ordinary: it fires sessionStart on the main
// checkout and the chat's first prompt from a linked worktree ~2s later, while
// `session/start` is still in flight. That prompt hook adopts the reservation
// — files its prompt, restamps the row onto the worktree under the real
// conversation id, starts a turn — and saves.
//
// session-start's final save then wrote ITS row over all of that: main
// checkout, the composer id, `prompts: []`, main's baseline. The only thing it
// carried across was a registered id. The next hook from the worktree found a
// row that no longer matched its chat, and the chat became two sessions.
//
// These are the pure halves of the merge session-start does instead: detect
// that the file at its tag was adopted while it was registering, and fold the
// adopter's turn and identity into the row that keeps the registered id.
import { samePath } from './paths.js';
import type { DedupCandidate } from './session-dedup.js';

export interface ReservationRow extends DedupCandidate {
  agentSessionId?: string;
  repoPath?: string;
  canonicalRepoPath?: string;
  lastCwd?: string;
  branch?: string | null;
  transcriptPath?: string;
  headShaAtStart?: string | null;
  sessionStartShadowSha?: string | null;
  sessionStartDirtyFiles?: string[];
  prePromptSha?: string | null;
  prePromptDirtyFiles?: string[];
}

/**
 * Did a concurrent hook adopt the reservation while `session/start` was in
 * flight? Any of: a prompt filed, the conversation id changed (Cursor's
 * worktree prompt carries the chat's real id, not the handshake's composer
 * id), or the row was moved onto another work tree.
 */
export function reservationAdoptedMeanwhile(ours: ReservationRow, onDisk: ReservationRow | null | undefined): boolean {
  if (!onDisk?.sessionId) return false;
  if (ours.sessionTag && onDisk.sessionTag && onDisk.sessionTag !== ours.sessionTag) return false;
  if (String(onDisk.status || '').toUpperCase() === 'ENDED') return false;
  if ((onDisk.prompts?.length || 0) > 0) return true;
  if (onDisk.agentSessionId && ours.agentSessionId && onDisk.agentSessionId !== ours.agentSessionId) return true;
  if (onDisk.claudeSessionId && ours.claudeSessionId && onDisk.claudeSessionId !== ours.claudeSessionId) return true;
  if (onDisk.repoPath && ours.repoPath && !samePath(onDisk.repoPath, ours.repoPath)) return true;
  return false;
}

/**
 * What only session-start knows about the session — everything the server
 * handed back at registration, plus the identity of THIS hook's agent. The
 * adopter's row is the live one for everything else.
 */
const REGISTRATION_FIELDS = [
  'sessionId', 'model', 'agentSlug', 'sessionTag',
  'agentSystemPrompt', 'activePolicies', 'enforcementRules', 'verboseCapture',
  'previousSessionId', 'previousSessionStartedAt',
  'syncBlock', 'budgetBlocked', 'budgetBlockReason', 'budgetWarnReason',
  'ownerOrgId', 'ownerKeyHash',
] as const;

/**
 * Fold the adopter's row into ours, keeping the registered id and the fields
 * only registration produces.
 *
 * The baseline is the subtle part. session-start captured HEAD, the dirty
 * list and a shadow commit for the tree it started on. If the adopter moved
 * the row to another tree (the worktree case), that baseline describes the
 * wrong tree: every range later taken from it spans main's HEAD to the
 * worktree's, and the branch's whole lead is credited to the session
 * (e1095412: +6431/-2115 over 8 commits before it wrote a line). So on a move
 * the adopter's baseline wins when it captured one, and when it did not the
 * caller captures a fresh one on the tree the row now lives on
 * (`needsBaseline`). On the same tree ours is the real one — the reservation
 * had none — except a per-prompt anchor the adopter already set.
 */
export function mergeAdoptedReservation<T extends ReservationRow>(
  ours: T,
  onDisk: ReservationRow,
): { movedTree: boolean; needsBaseline: boolean } {
  const movedTree = !!(onDisk.repoPath && ours.repoPath && !samePath(onDisk.repoPath, ours.repoPath));
  const keep: Partial<Record<(typeof REGISTRATION_FIELDS)[number], unknown>> = {};
  for (const k of REGISTRATION_FIELDS) {
    const v = (ours as Record<string, unknown>)[k];
    if (v !== undefined) keep[k] = v;
  }
  const ourBaseline = {
    headShaAtStart: ours.headShaAtStart,
    sessionStartShadowSha: ours.sessionStartShadowSha,
    sessionStartDirtyFiles: ours.sessionStartDirtyFiles,
    prePromptSha: ours.prePromptSha,
    prePromptDirtyFiles: ours.prePromptDirtyFiles,
  };
  Object.assign(ours, onDisk, keep);
  // The registered id always wins over a placeholder the adopter still held.
  if (typeof keep.sessionId === 'string') ours.sessionId = keep.sessionId;

  if (!movedTree) {
    ours.headShaAtStart = ourBaseline.headShaAtStart ?? onDisk.headShaAtStart ?? null;
    ours.sessionStartShadowSha = ourBaseline.sessionStartShadowSha ?? onDisk.sessionStartShadowSha ?? null;
    ours.sessionStartDirtyFiles = ourBaseline.sessionStartDirtyFiles ?? onDisk.sessionStartDirtyFiles ?? [];
    if (!onDisk.prePromptSha) {
      ours.prePromptSha = ourBaseline.prePromptSha ?? null;
      ours.prePromptDirtyFiles = ourBaseline.prePromptDirtyFiles ?? [];
    }
    return { movedTree: false, needsBaseline: false };
  }
  // Moved: main's baseline must not survive on the row, whether or not the
  // caller captures a fresh one. `Object.assign` keeps a field the adopter
  // never wrote, so clear them explicitly.
  ours.headShaAtStart = onDisk.headShaAtStart ?? null;
  ours.sessionStartShadowSha = onDisk.sessionStartShadowSha ?? null;
  ours.sessionStartDirtyFiles = onDisk.sessionStartDirtyFiles ?? [];
  ours.prePromptSha = onDisk.prePromptSha ?? null;
  ours.prePromptDirtyFiles = onDisk.prePromptDirtyFiles ?? [];
  return { movedTree: true, needsBaseline: !onDisk.headShaAtStart };
}
