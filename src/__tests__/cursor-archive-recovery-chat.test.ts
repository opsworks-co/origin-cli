// Regression: on user-prompt-submit for a NEW Cursor chat, the detach nulls the
// live state to force a fresh session — but the archive-recovery step used to
// re-select the SAME old chat's archived session (matched by repo + recency,
// ignoring conversation_id), undoing the detach and gluing the new chat's prompt
// onto the prior session. Prod: conversation 047e67ca's prompt landed on session
// 67d97041 (chat 21a72a0e), and no new session spawned. selectRecoverableArchiveSession
// now refuses a DIFFERENT chat's session.
import { describe, it, expect } from 'vitest';
import { selectRecoverableArchiveSession } from '../commands/hooks.js';

const REPO = '/Users/x/Documents/origin-demo-1';
const NOW = 1_000_000_000_000;
const startedAt = (agoMs: number) => new Date(NOW - agoMs).toISOString();
const s = (over: any) => ({
  sessionId: 'sess-' + Math.random().toString(36).slice(2, 8),
  startedAt: startedAt(60_000),
  repoPath: REPO,
  model: 'cursor-grok-4.5-high-fast',
  status: 'RUNNING',
  ...over,
});
const base = { repoPath: REPO, canonicalRepoPath: REPO, agentSlug: 'cursor', nowMs: NOW, maxAgeMs: 24 * 60 * 60 * 1000 };

describe('selectRecoverableArchiveSession (Cursor per-chat recovery)', () => {
  it('does NOT recover a session belonging to a DIFFERENT chat (the bug)', () => {
    const prior = s({ sessionId: 'old', agentSessionId: 'chat-A', status: 'COMPLETED' });
    const got = selectRecoverableArchiveSession([prior], { ...base, incomingChatId: 'chat-B' });
    expect(got).toBeNull(); // → caller auto-creates a fresh session for chat-B
  });

  it('recovers THIS chat\'s own archived session', () => {
    const mine = s({ sessionId: 'mine', agentSessionId: 'chat-B' });
    const other = s({ sessionId: 'other', agentSessionId: 'chat-A', startedAt: startedAt(10_000) });
    const got = selectRecoverableArchiveSession([other, mine], { ...base, incomingChatId: 'chat-B' });
    expect(got?.sessionId).toBe('mine');
  });

  it('adopts a candidate with no recorded chat id (legacy archive, best-effort)', () => {
    const legacy = s({ sessionId: 'legacy', agentSessionId: undefined });
    const got = selectRecoverableArchiveSession([legacy], { ...base, incomingChatId: 'chat-B' });
    expect(got?.sessionId).toBe('legacy');
  });

  it('still honours repo, age, agent, and ENDED filters', () => {
    const wrongRepo = s({ sessionId: 'wrongrepo', repoPath: '/other', agentSessionId: 'chat-B' });
    const tooOld = s({ sessionId: 'old', startedAt: startedAt(48 * 60 * 60 * 1000), agentSessionId: 'chat-B' });
    const ended = s({ sessionId: 'ended', status: 'ENDED', endedAt: startedAt(5_000), agentSessionId: 'chat-B' });
    const wrongAgent = s({ sessionId: 'codex', model: 'gpt-5', agentSlug: 'codex', agentSessionId: 'chat-B' });
    const got = selectRecoverableArchiveSession([wrongRepo, tooOld, ended, wrongAgent], { ...base, incomingChatId: 'chat-B' });
    expect(got).toBeNull();
  });

  it('picks the freshest eligible same-chat candidate', () => {
    const older = s({ sessionId: 'older', agentSessionId: 'chat-B', startedAt: startedAt(120_000) });
    const newer = s({ sessionId: 'newer', agentSessionId: 'chat-B', startedAt: startedAt(20_000) });
    const got = selectRecoverableArchiveSession([older, newer], { ...base, incomingChatId: 'chat-B' });
    expect(got?.sessionId).toBe('newer');
  });
});
