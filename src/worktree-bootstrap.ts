// Cursor (and Claude Code) start a session on the MAIN checkout, then the
// harness moves the agent into a linked worktree. Origin's first session-start
// lands on `main`; the worktree's first prompt carries a NEW conversation id,
// and the chat-id detach mints a twin row. After ~30s the empty main row is
// swept, which looks like the two sessions "merged".
//
// These helpers recognise that bootstrap: an EMPTY, young session whose
// working tree IS the canonical checkout, and an incoming cwd that is a
// linked worktree of the SAME repo. Two real chats in sibling worktrees do
// not match — the prior is already not the main checkout.

import { samePath } from './paths.js';

/** How long a main-checkout handshake may still be the worktree's session. */
export const WORKTREE_BOOTSTRAP_MAX_AGE_MS = 2 * 60 * 1000;

export interface WorktreeBootstrapCandidate {
  prompts?: unknown[];
  startedAt?: string;
  repoPath?: string;
  canonicalRepoPath?: string;
}

export function isEmptyWorktreeBootstrap(opts: {
  promptCount: number;
  startedAt?: string;
  priorWorkingRoot?: string;
  priorCanonicalRoot?: string;
  incomingWorkingRoot?: string;
  incomingCanonicalRoot?: string;
  nowMs: number;
  maxAgeMs?: number;
}): boolean {
  if (opts.promptCount > 0) return false;
  const started = opts.startedAt ? Date.parse(opts.startedAt) : NaN;
  if (!Number.isFinite(started)) return false;
  const age = opts.nowMs - started;
  if (age < 0 || age > (opts.maxAgeMs ?? WORKTREE_BOOTSTRAP_MAX_AGE_MS)) return false;

  const priorWorking = opts.priorWorkingRoot;
  const priorCanonical = opts.priorCanonicalRoot || priorWorking;
  const incomingWorking = opts.incomingWorkingRoot;
  const incomingCanonical = opts.incomingCanonicalRoot || incomingWorking;
  if (!priorWorking || !priorCanonical || !incomingWorking || !incomingCanonical) return false;

  // Prior started in the primary checkout, not already in a worktree.
  if (!samePath(priorWorking, priorCanonical)) return false;
  // Incoming is a linked worktree of that repo.
  if (samePath(incomingWorking, incomingCanonical)) return false;
  if (!samePath(priorCanonical, incomingCanonical)) return false;
  return true;
}

/** Newest empty main-checkout handshake that this worktree should adopt. */
export function pickWorktreeBootstrap<T extends WorktreeBootstrapCandidate>(
  candidates: T[],
  incomingWorkingRoot: string,
  incomingCanonicalRoot: string,
  nowMs: number,
): T | null {
  let best: T | null = null;
  let bestStarted = -1;
  for (const s of candidates) {
    if (!isEmptyWorktreeBootstrap({
      promptCount: s.prompts?.length || 0,
      startedAt: s.startedAt,
      priorWorkingRoot: s.repoPath,
      priorCanonicalRoot: s.canonicalRepoPath || s.repoPath,
      incomingWorkingRoot,
      incomingCanonicalRoot,
      nowMs,
    })) continue;
    const started = s.startedAt ? Date.parse(s.startedAt) : 0;
    if (started >= bestStarted) {
      best = s;
      bestStarted = started;
    }
  }
  return best;
}

/**
 * What session-start records about the tree a session begins on. Taken from
 * the tree the session will actually work in — see restampWorktreeBootstrap.
 */
export interface SessionStartBaseline {
  headShaAtStart: string | null;
  sessionStartShadowSha: string | null;
  prePromptSha: string | null;
  prePromptDirtyFiles: string[];
  sessionStartDirtyFiles: string[];
}

/**
 * Move a handshake session onto the worktree it actually runs in.
 *
 * Identity AND baseline. The handshake was registered on the main checkout,
 * so its `headShaAtStart` and session-start shadow describe THAT tree. The
 * worktree is on another branch: every range this session later takes from
 * its baseline — the trailer fallback in `ownedRangeCommitShas`, the
 * session-level `captureGitState` — then spans main's HEAD to the worktree's,
 * and everything the branch is ahead by is credited to the session.
 *
 * Session e1095412 (2026-09-08): bootstrapped on main at b766fba4, adopted
 * into a worktree already at be32ca2f0 — fourteen commits ahead. Its first
 * Stop, two minutes in and before it had written a line, stored a header of
 * +6431/-2115 over 8 commits with `authoredSource: trailer`. Nothing in the
 * session had run a checkout; the baseline had simply never been the tree.
 *
 * The caller reads the baseline from the worktree (session-start's own
 * assembly, `captureSessionStartBaseline`) and hands it in; this stays a pure
 * restamp so the rule is testable without git.
 */
export function restampWorktreeBootstrap<T extends {
  agentSessionId?: string;
  claudeSessionId?: string;
  lastCwd?: string;
  repoPath?: string;
  canonicalRepoPath?: string;
  branch?: string | null;
  headShaAtStart?: string | null;
  sessionStartShadowSha?: string | null;
  prePromptSha?: string | null;
  prePromptDirtyFiles?: string[];
  sessionStartDirtyFiles?: string[];
}>(state: T, onto: {
  agentSessionId?: string;
  claudeSessionId?: string;
  lastCwd: string;
  repoPath: string;
  canonicalRepoPath: string;
  branch?: string | null;
  baseline?: SessionStartBaseline | null;
}): T {
  if (onto.agentSessionId) state.agentSessionId = onto.agentSessionId;
  if (onto.claudeSessionId) state.claudeSessionId = onto.claudeSessionId;
  state.lastCwd = onto.lastCwd;
  state.repoPath = onto.repoPath;
  state.canonicalRepoPath = onto.canonicalRepoPath;
  if (onto.branch) state.branch = onto.branch;
  if (onto.baseline) {
    state.headShaAtStart = onto.baseline.headShaAtStart;
    state.sessionStartShadowSha = onto.baseline.sessionStartShadowSha;
    state.prePromptSha = onto.baseline.prePromptSha;
    state.prePromptDirtyFiles = [...onto.baseline.prePromptDirtyFiles];
    state.sessionStartDirtyFiles = [...onto.baseline.sessionStartDirtyFiles];
  }
  return state;
}
