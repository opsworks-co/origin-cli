/**
 * Two Cursor chats in sibling worktrees of the same repo share
 * `.git/origin-session-*.json`. findStateForHook used to pick the NEWEST
 * Cursor session, so chat A's Stop wrote onto chat B's row (prod: 8i6u
 * conversation e2efa52c landed on t09w session 562314d8; the first row
 * flickered out of Live as empty, then a twin appeared after prompt 2).
 */
import { describe, it, expect, vi, beforeEach, afterEach, afterAll } from 'vitest';
import fs from 'fs';
import path from 'path';
import { execFileSync } from 'child_process';

const { TEST_HOME } = vi.hoisted(() => {
  const base = process.env.TMPDIR || process.env.TMP || '/tmp';
  return { TEST_HOME: `${base.replace(/\/$/, '')}/origin-cursor-sib-${process.pid}` };
});

vi.mock('os', async (orig) => {
  const actual = (await orig()) as typeof import('os');
  const homedir = () => TEST_HOME;
  return { ...actual, default: { ...actual, homedir }, homedir };
});

import { findStateForHook, cursorIncomingChatId, stateMatchesIncomingChat } from '../commands/hooks.js';

const ENV = { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null' };

let repo: string;
let worktree: string;

function writeGitState(tag: string, state: Record<string, unknown>): void {
  fs.writeFileSync(path.join(repo, '.git', `origin-session-${tag}.json`), JSON.stringify({
    sessionTag: tag,
    agentSlug: 'cursor',
    model: 'cursor-grok-4.6-high',
    status: 'RUNNING',
    startedAt: new Date().toISOString(),
    repoPath: repo,
    ...state,
  }));
}

describe('findStateForHook — Cursor sibling worktrees', () => {
  beforeEach(() => {
    fs.rmSync(path.join(TEST_HOME, '.origin'), { recursive: true, force: true });
    fs.mkdirSync(path.join(TEST_HOME, '.origin', 'sessions'), { recursive: true });
    repo = fs.mkdtempSync(path.join(TEST_HOME, 'repo-'));
    execFileSync('git', ['init', '-q'], { cwd: repo, env: ENV });
    execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '--allow-empty', '-qm', 'i'], {
      cwd: repo, env: ENV,
    });
    repo = execFileSync('git', ['rev-parse', '--show-toplevel'], {
      cwd: repo, env: ENV, encoding: 'utf-8',
    }).trim();
    worktree = path.join(TEST_HOME, 'wt-a');
    execFileSync('git', ['worktree', 'add', '-q', worktree, '-b', `cursor/test-${process.pid}`], { cwd: repo, env: ENV });
    worktree = execFileSync('git', ['rev-parse', '--show-toplevel'], {
      cwd: worktree, env: ENV, encoding: 'utf-8',
    }).trim();
  });

  afterEach(() => {
    try { execFileSync('git', ['worktree', 'remove', '--force', worktree], { cwd: repo, env: ENV }); } catch { /* gone */ }
    fs.rmSync(repo, { recursive: true, force: true });
  });

  afterAll(() => {
    fs.rmSync(TEST_HOME, { recursive: true, force: true });
  });

  it('looks up the chat by conversation_id, not the newest Cursor row', () => {
    writeGitState('older-chat', {
      sessionId: 'sess-older',
      agentSessionId: 'chat-older',
      startedAt: '2026-09-07T23:38:00.000Z',
      repoPath: worktree,
    });
    writeGitState('newer-chat', {
      sessionId: 'sess-newer',
      agentSessionId: 'chat-newer',
      startedAt: '2026-09-07T23:46:42.000Z',
      repoPath: repo,
    });

    const found = findStateForHook(worktree, 'chat-older', 'cursor');
    expect(found?.state.sessionId).toBe('sess-older');
  });

  it('when conversation_id is missing, prefers the session whose repoPath is this worktree', () => {
    writeGitState('older-chat', {
      sessionId: 'sess-older',
      agentSessionId: 'chat-older',
      startedAt: '2026-09-07T23:38:00.000Z',
      repoPath: worktree,
    });
    writeGitState('newer-chat', {
      sessionId: 'sess-newer',
      agentSessionId: 'chat-newer',
      startedAt: '2026-09-07T23:46:42.000Z',
      repoPath: repo,
    });

    const found = findStateForHook(worktree, undefined, 'cursor');
    expect(found?.state.sessionId).toBe('sess-older');
  });
});

describe('cursorIncomingChatId / stateMatchesIncomingChat', () => {
  it('ignores a rotating session_id when conversation_id is absent', () => {
    expect(cursorIncomingChatId({ session_id: 'c49a1512-turn' })).toBe('');
    const candidate = { agentSessionId: '6f636f7d-chat' } as any;
    expect(stateMatchesIncomingChat(candidate, 'cursor', { session_id: 'c49a1512-turn' })).toBe(true);
  });

  it('detaches only when conversation_id is present and disagrees', () => {
    const candidate = { agentSessionId: '6f636f7d-chat' } as any;
    expect(stateMatchesIncomingChat(candidate, 'cursor', {
      conversation_id: 'e2efa52c-other',
      session_id: 'c49a1512-turn',
    })).toBe(false);
    expect(stateMatchesIncomingChat(candidate, 'cursor', {
      conversation_id: '6f636f7d-chat',
      session_id: 'c49a1512-turn',
    })).toBe(true);
  });
});
