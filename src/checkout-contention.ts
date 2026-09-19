// Who else is writing into this working tree right now.
//
// Everything else in capture narrows a guess. This is the one thing that
// cannot be narrowed: when two agents write into ONE checkout, no observation
// available to us says which of them wrote a given byte. Tool hooks cover the
// agent that has them, and the write journal covers the rest — but the journal
// records THAT a file changed, never WHICH process changed it, and no
// filesystem API on macOS or Windows reports the writing process without
// elevated privileges.
//
// So the honest move is not a better heuristic. It is to notice the situation,
// say so, and stop presenting contested attribution with the same confidence
// as uncontested attribution. A turn captured while three agents shared a tree
// is a different kind of claim from one captured alone, and until now the two
// rendered identically.
//
// The fix that removes the ambiguity entirely — one worktree per session — is
// something Origin can offer and assist with, but cannot impose: the agent is
// already running in a directory of the user's choosing, and a hook cannot
// relocate it.
import fs from 'fs';
import { listActiveSessions, type SessionState } from './session-state.js';
import { samePath } from './paths.js';

export interface ContentionPeer {
  sessionId: string;
  agentSlug?: string;
  /** Working tree the peer is writing in. */
  workTree: string;
}

export interface ContentionReport {
  /** True when at least one other live session shares this working tree. */
  contested: boolean;
  peers: ContentionPeer[];
}

export interface PeerSession {
  sessionId: string;
  agentSlug?: string;
  repoPath?: string;
  lastCwd?: string;
  status?: string;
  /** Epoch ms of the peer's last observed activity. */
  lastSeenMs?: number;
  /** See `neverRanATurn`. */
  neverRanATurn?: boolean;
}

/**
 * This launch of the session has not run a turn: no prompt, no open turn, no
 * recorded edit, no captured row.
 *
 * The Claude desktop app, reusing a worktree for a new conversation, first
 * RESUMES the conversation that last lived there — a SessionStart with
 * `source: resume` and nothing after it — and only then starts the new one.
 * Origin re-registers the old conversation (prompts: []), its state file is
 * fresh and not ENDED, and the new session's first prompt found "another live
 * session writing in this checkout". Session ad95e766 carried that mark from
 * its first prompt (14:09:34Z, peer 274a6cd2, resumed 14:06:56Z and never
 * prompted): ledger AND turn window declined on every Stop for three hours,
 * and every row came from the fallback path.
 *
 * A session that never ran a turn has written nothing, so it is not a rival
 * for any byte. The moment it takes a prompt it stops matching, and the live
 * check at the next capture sees it. Anything not provably this shape — a
 * state without a `prompts` array — still counts.
 */
export function neverRanATurn(state: {
  prompts?: unknown; activeTurn?: unknown; liveEdits?: unknown;
  completedPromptMappings?: unknown; writeTrees?: unknown;
}): boolean {
  if (!Array.isArray(state.prompts) || state.prompts.length > 0) return false;
  if (state.activeTurn) return false;
  const some = (v: unknown) => Array.isArray(v) && v.length > 0;
  return !some(state.liveEdits) && !some(state.completedPromptMappings) && !some(state.writeTrees);
}

/**
 * How recently a peer must have been seen to count as sharing the tree.
 *
 * A session that ended, or that has been idle for a long while, is not writing
 * anything now, and treating it as a rival would flag every repo that has ever
 * been used by two agents.
 */
export const PEER_ACTIVE_WINDOW_MS = 10 * 60 * 1000;

/**
 * Other live sessions writing into `workTree`.
 *
 * Deliberately conservative in one direction: a peer is only counted when we
 * can see it is recent AND in the same tree. Missing a peer costs a warning we
 * do not show; inventing one costs the user's trust in every warning after it.
 */
export function detectContention(
  self: Pick<SessionState, 'sessionId'>,
  workTree: string,
  peers: readonly PeerSession[],
  now: number = Date.now(),
): ContentionReport {
  const found: ContentionPeer[] = [];
  if (!workTree) return { contested: false, peers: found };

  for (const p of peers) {
    if (!p || !p.sessionId || p.sessionId === self.sessionId) continue;
    if (String(p.status || '').toUpperCase() === 'ENDED') continue;
    if (typeof p.lastSeenMs === 'number' && now - p.lastSeenMs > PEER_ACTIVE_WINDOW_MS) continue;
    if (p.neverRanATurn) continue;

    // A peer contends only if it writes in the SAME tree. A sibling working in
    // its own worktree of the same repo is not a rival — that separation is
    // exactly the fix being recommended.
    const peerTree = p.lastCwd || p.repoPath || '';
    if (!peerTree || !samePath(peerTree, workTree)) continue;

    found.push({ sessionId: p.sessionId, agentSlug: p.agentSlug, workTree: peerTree });
  }
  return { contested: found.length > 0, peers: found };
}

/**
 * Re-check contention at the moment a capture is about to be claimed.
 *
 * The prompt hook records a historical list of rivals for the UI, but that
 * list cannot decide whether a later capture is safe: the other session may
 * have ended, or a new one may have started after the prompt.  Ledger capture
 * needs the live answer.  It is deliberately separate from the historical
 * note so callers can decline an unprovable claim without making the session
 * permanently ineligible for journal capture.
 */
export function detectLiveContention(
  self: Pick<SessionState, 'sessionId'>,
  workTree: string,
  sessions: readonly SessionState[] = listActiveSessions(workTree),
  now: number = Date.now(),
): ContentionReport {
  const peers: PeerSession[] = sessions.map((p) => ({
    sessionId: p.sessionId,
    agentSlug: p.agentSlug,
    repoPath: p.repoPath,
    lastCwd: p.lastCwd,
    status: p.status,
    lastSeenMs: peerLastActivityMs(p as unknown as Record<string, unknown>, (() => {
      try { return fs.statSync((p as SessionState & { __statePath?: string }).__statePath || '').mtimeMs; } catch { return undefined; }
    })()),
    neverRanATurn: neverRanATurn(p),
  }));
  return detectContention(self, workTree, peers, now);
}

/**
 * When a peer was last ACTIVE, from what it recorded about its own turns.
 *
 * The state file's mtime is not that. Anything that saves the file refreshes
 * it, and not everything that saves it is the session: post-commit stamps the
 * new `branch` on every session listed for the tree, so session 274a6cd2 —
 * whose last own activity was 14:06Z — had its state rewritten by its
 * neighbour's commits at 14:37Z and 16:03Z, and each rewrite made it "seen"
 * again for ten minutes. A dead session in a shared checkout stays a rival for
 * as long as the living one keeps committing.
 *
 * So: the newest timestamp the peer's OWN hooks wrote — a prompt, an open
 * turn, a Stop, an edit, a sub-agent, a write in a tree. A state that carries none
 * of them (agents whose producers do not record turn times) keeps the mtime,
 * exactly as before.
 */
export function peerLastActivityMs(state: Record<string, unknown>, mtimeMs: number | undefined): number | undefined {
  const seen: number[] = [];
  const note = (v: unknown) => {
    const ms = typeof v === 'number' ? v : typeof v === 'string' ? Date.parse(v) : NaN;
    if (Number.isFinite(ms) && ms > 0) seen.push(ms);
  };
  const each = (list: unknown, ...keys: string[]) => {
    if (!Array.isArray(list)) return;
    for (const item of list) {
      if (item && typeof item === 'object') for (const k of keys) note((item as Record<string, unknown>)[k]);
      else note(item);
    }
  };
  note(state.currentTurnStartedAt);
  note(state.lastTurnClosedAt);
  note(state.lastStopAt);
  note((state.activeTurn as { openedAt?: unknown } | null | undefined)?.openedAt);
  each(state.promptSubmittedAt);
  each(state.promptShadows, 'capturedAt');
  each(state.turnEndShadows, 'capturedAt');
  each(state.liveEdits, 'capturedAt');
  each(state.subagents, 'startedAt', 'endedAt');
  each(state.writeTrees, 'at');
  if (seen.length === 0) return mtimeMs;
  const own = Math.max(...seen);
  // Never later than the file says it was last written.
  return typeof mtimeMs === 'number' ? Math.min(own, mtimeMs) : own;
}

/** One line for the user, or null when there is nothing to say. */
export function contentionAdvice(report: ContentionReport): string | null {
  if (!report.contested) return null;
  const n = report.peers.length;
  const who = report.peers
    .map((p) => p.agentSlug || 'agent')
    .filter((v, i, a) => a.indexOf(v) === i)
    .join(', ');
  return `${n} other session${n === 1 ? '' : 's'} (${who}) ${n === 1 ? 'is' : 'are'} writing in this same checkout. `
    + 'File attribution between them cannot be proven — give each session its own '
    + 'git worktree to make it exact.';
}
