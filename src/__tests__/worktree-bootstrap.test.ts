/**
 * Cursor starts on the main checkout, then moves into a linked worktree
 * with a new conversation id. The empty main row is the same session —
 * sibling worktrees and a second chat in the same checkout are not.
 */

import { describe, it, expect } from 'vitest';
import { hookModuleSource } from './helpers/hooks-source.js';
import {
  WORKTREE_BOOTSTRAP_MAX_AGE_MS,
  isEmptyWorktreeBootstrap,
  pickWorktreeBootstrap,
  restampWorktreeBootstrap,
} from '../worktree-bootstrap.js';

const NOW = 1_700_000_000_000;
const iso = (msAgo: number) => new Date(NOW - msAgo).toISOString();
const MAIN = '/Users/x/origin';
const WT = '/Users/x/.cursor/worktrees/origin/4kfq';
const WT_B = '/Users/x/.cursor/worktrees/origin/ag5w';

const bootstrapOpts = (over: Record<string, unknown> = {}) => ({
  promptCount: 0,
  startedAt: iso(11_000),
  priorWorkingRoot: MAIN,
  priorCanonicalRoot: MAIN,
  incomingWorkingRoot: WT,
  incomingCanonicalRoot: MAIN,
  nowMs: NOW,
  ...over,
});

describe('isEmptyWorktreeBootstrap', () => {
  it('adopts an empty main-checkout handshake into a linked worktree', () => {
    expect(isEmptyWorktreeBootstrap(bootstrapOpts())).toBe(true);
  });

  it('does NOT adopt once the handshake has a prompt (real work)', () => {
    expect(isEmptyWorktreeBootstrap(bootstrapOpts({ promptCount: 1 }))).toBe(false);
  });

  it('does NOT adopt a stale handshake', () => {
    expect(isEmptyWorktreeBootstrap(bootstrapOpts({
      startedAt: iso(WORKTREE_BOOTSTRAP_MAX_AGE_MS + 1_000),
    }))).toBe(false);
  });

  it('does NOT adopt a second chat in the SAME checkout', () => {
    // New Cursor chat in the repo you already have open — the detach must still fire.
    expect(isEmptyWorktreeBootstrap(bootstrapOpts({
      incomingWorkingRoot: MAIN,
      incomingCanonicalRoot: MAIN,
    }))).toBe(false);
  });

  it('does NOT fold two sibling worktrees together', () => {
    // Best-of-N / two Cursor agents: prior is already a worktree, not main.
    expect(isEmptyWorktreeBootstrap(bootstrapOpts({
      priorWorkingRoot: WT,
      priorCanonicalRoot: MAIN,
      incomingWorkingRoot: WT_B,
      incomingCanonicalRoot: MAIN,
    }))).toBe(false);
  });

  it('does NOT adopt across different repos', () => {
    expect(isEmptyWorktreeBootstrap(bootstrapOpts({
      incomingCanonicalRoot: '/Users/x/other',
    }))).toBe(false);
  });
});

describe('pickWorktreeBootstrap', () => {
  it('picks the newest empty main handshake', () => {
    const older = { sessionId: 'old', prompts: [], startedAt: iso(40_000), repoPath: MAIN, canonicalRepoPath: MAIN };
    const newer = { sessionId: 'new', prompts: [], startedAt: iso(8_000), repoPath: MAIN, canonicalRepoPath: MAIN };
    const picked = pickWorktreeBootstrap([older, newer], WT, MAIN, NOW);
    expect(picked?.sessionId).toBe('new');
  });

  it('returns null when nothing is a handshake', () => {
    const busy = { sessionId: 'busy', prompts: ['hi'], startedAt: iso(5_000), repoPath: MAIN, canonicalRepoPath: MAIN };
    expect(pickWorktreeBootstrap([busy], WT, MAIN, NOW)).toBeNull();
  });
});

describe('restampWorktreeBootstrap', () => {
  it('moves identity onto the worktree and the new conversation id', () => {
    const state = {
      agentSessionId: 'composer-c127271b',
      repoPath: MAIN,
      canonicalRepoPath: MAIN,
      lastCwd: MAIN,
      branch: 'main',
    };
    restampWorktreeBootstrap(state, {
      agentSessionId: 'chat-92da3ef0',
      lastCwd: WT,
      repoPath: WT,
      canonicalRepoPath: MAIN,
      branch: 'cursor/c127271b',
    });
    expect(state.agentSessionId).toBe('chat-92da3ef0');
    expect(state.repoPath).toBe(WT);
    expect(state.lastCwd).toBe(WT);
    expect(state.canonicalRepoPath).toBe(MAIN);
    expect(state.branch).toBe('cursor/c127271b');
  });

  it('replaces the handshake baseline with the worktree\'s when one is handed in', () => {
    // e1095412: adopted with main's headShaAtStart (b766fba4) into a worktree
    // at be32ca2f0; its first Stop credited it the fourteen commits between.
    const state = {
      repoPath: MAIN, canonicalRepoPath: MAIN, lastCwd: MAIN, branch: 'main',
      headShaAtStart: 'b766fba4', sessionStartShadowSha: 'd33eac52',
      prePromptSha: 'd33eac52', prePromptDirtyFiles: [] as string[],
      sessionStartDirtyFiles: ['AGENTS.md', 'CLAUDE.md', 'GEMINI.md'],
    };
    restampWorktreeBootstrap(state, {
      lastCwd: WT, repoPath: WT, canonicalRepoPath: MAIN, branch: 'claude/x',
      baseline: {
        headShaAtStart: 'be32ca2f', sessionStartShadowSha: null,
        prePromptSha: 'be32ca2f', prePromptDirtyFiles: ['notes.md'], sessionStartDirtyFiles: ['notes.md'],
      },
    });
    expect(state.headShaAtStart).toBe('be32ca2f');
    expect(state.sessionStartShadowSha).toBeNull();
    expect(state.prePromptSha).toBe('be32ca2f');
    expect(state.prePromptDirtyFiles).toEqual(['notes.md']);
    expect(state.sessionStartDirtyFiles).toEqual(['notes.md']);
  });

  it('leaves the baseline alone when none is handed in', () => {
    const state = { repoPath: MAIN, canonicalRepoPath: MAIN, lastCwd: MAIN, headShaAtStart: 'b766fba4' };
    restampWorktreeBootstrap(state, { lastCwd: WT, repoPath: WT, canonicalRepoPath: MAIN });
    expect(state.headShaAtStart).toBe('b766fba4');
  });
});

describe('wiring', () => {
  it('is consulted from the Cursor detach, the race re-lookup, and session-start', () => {
    const ups = hookModuleSource('user-prompt-submit');
    expect(ups).toContain('adopting empty worktree-bootstrap session');
    expect(ups).toContain('racedIsBootstrap');
    const start = hookModuleSource('session-start');
    expect(start).toContain('adopting empty worktree-bootstrap session');
  });
});
