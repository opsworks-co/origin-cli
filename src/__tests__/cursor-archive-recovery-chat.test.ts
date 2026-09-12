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

  it('still honours repo and agent filters', () => {
    const wrongRepo = s({ sessionId: 'wrongrepo', repoPath: '/other', agentSessionId: 'chat-B' });
    const wrongAgent = s({ sessionId: 'codex', model: 'gpt-5', agentSlug: 'codex', agentSessionId: 'chat-B' });
    const got = selectRecoverableArchiveSession([wrongRepo, wrongAgent], { ...base, incomingChatId: 'chat-B' });
    expect(got).toBeNull();
  });

  // Prod 2026-09-08: the heartbeat retired Cursor session 49b1c722 after 20
  // idle minutes (23:04); the user kept typing in the same chat (7b2b1608) at
  // 23:13; recovery skipped the ENDED archive, the prompt auto-created twin
  // c1e361a4, and Cursor's transcript replay copied the first session's
  // prompts into it. An archive that NAMES this chat is the agent's own id —
  // the one case an ended row is a resume, not a guess.
  it('THE FIX: resumes THIS chat\'s ENDED archive', () => {
    const ended = s({ sessionId: 'ended', status: 'ENDED', endedAt: startedAt(5_000), agentSessionId: 'chat-B' });
    const got = selectRecoverableArchiveSession([ended], { ...base, incomingChatId: 'chat-B' });
    expect(got?.sessionId).toBe('ended');
  });

  it('positive identity also outranks the age cap (a chat reopened the next day)', () => {
    const old = s({ sessionId: 'old', startedAt: startedAt(48 * 60 * 60 * 1000), agentSessionId: 'chat-B' });
    const got = selectRecoverableArchiveSession([old], { ...base, incomingChatId: 'chat-B' });
    expect(got?.sessionId).toBe('old');
  });

  it('an ENDED or too-old archive with NO chat id is still not recovered (a guess stays a guess)', () => {
    const endedNoId = s({ sessionId: 'ended-noid', status: 'ENDED', endedAt: startedAt(5_000), agentSessionId: undefined });
    const oldNoId = s({ sessionId: 'old-noid', startedAt: startedAt(48 * 60 * 60 * 1000), agentSessionId: undefined });
    const got = selectRecoverableArchiveSession([endedNoId, oldNoId], { ...base, incomingChatId: 'chat-B' });
    expect(got).toBeNull();
  });

  it('never resurrects a row the user archived or deleted on the web', () => {
    // The heartbeat stamps serverTerminal when it drops a session because the
    // server reported it archived / gone (dropLocalSessionAndExit).
    const archived = s({ sessionId: 'archived', status: 'ENDED', endedAt: startedAt(5_000), agentSessionId: 'chat-B', serverTerminal: true });
    const got = selectRecoverableArchiveSession([archived], { ...base, incomingChatId: 'chat-B' });
    expect(got).toBeNull();
  });

  it('picks the freshest eligible same-chat candidate', () => {
    const older = s({ sessionId: 'older', agentSessionId: 'chat-B', startedAt: startedAt(120_000) });
    const newer = s({ sessionId: 'newer', agentSessionId: 'chat-B', startedAt: startedAt(20_000) });
    const got = selectRecoverableArchiveSession([older, newer], { ...base, incomingChatId: 'chat-B' });
    expect(got?.sessionId).toBe('newer');
  });
});
