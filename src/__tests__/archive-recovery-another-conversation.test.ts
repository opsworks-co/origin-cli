// Prod 2026-10-02, session 17e0004b: the heartbeat ended a live Claude Code
// conversation two minutes in (its local- id was unregistered, see
// heartbeat-liveness.test.ts). Its own archive carried `serverTerminal`, so the
// next Stop skipped it — and recovered the freshest OTHER archive in the same
// worktree: a 7-second Claude session (d6e43ccf) from 20 minutes earlier. That
// stranger took prompts 1–3 and the commit made in prompt 2.
//
// A Claude Code / Devin / Copilot session id is stable per conversation, so an
// archive that names a different one is proof it is someone else's.
import { describe, it, expect } from 'vitest';
import { archiveIsAnotherConversation, selectRecoverableArchiveSession } from '../commands/hooks.js';

const REPO = '/Users/x/code/origin/.claude/worktrees/keen-mccarthy';
const NOW = 1_790_000_000_000;
const ago = (ms: number) => new Date(NOW - ms).toISOString();
const base = { repoPath: REPO, canonicalRepoPath: REPO, nowMs: NOW, maxAgeMs: 24 * 60 * 60 * 1000 };

describe('archiveIsAnotherConversation', () => {
  it('a stable-id agent with two different ids is two conversations', () => {
    expect(archiveIsAnotherConversation('claude-code', '5d36a65b', 'd6e43ccf')).toBe(true);
    expect(archiveIsAnotherConversation('devin', 'a', 'b')).toBe(true);
    expect(archiveIsAnotherConversation('copilot', 'a', 'b')).toBe(true);
  });

  it('the same id, or an unknown id on either side, decides nothing', () => {
    expect(archiveIsAnotherConversation('claude-code', '5d36a65b', '5d36a65b')).toBe(false);
    expect(archiveIsAnotherConversation('claude-code', '5d36a65b', undefined)).toBe(false);
    expect(archiveIsAnotherConversation('claude-code', '', 'd6e43ccf')).toBe(false);
  });

  it('agents whose stdin id rotates are left to their own rules', () => {
    expect(archiveIsAnotherConversation('codex', 'turn-2', 'turn-1')).toBe(false);
    expect(archiveIsAnotherConversation('cursor', 'a', 'b')).toBe(false);
    expect(archiveIsAnotherConversation(undefined, 'a', 'b')).toBe(false);
  });
});

describe('selectRecoverableArchiveSession — never a stranger Claude conversation', () => {
  const stranger = {
    sessionId: 'local-9b70c47a', claudeSessionId: 'd6e43ccf', agentSlug: 'claude-code',
    repoPath: REPO, startedAt: ago(20 * 60_000), status: 'RUNNING',
  };

  it('the 2026-10-02 replay: the only live archive is another conversation → nothing recovered', () => {
    const got = selectRecoverableArchiveSession([stranger], { ...base, agentSlug: 'claude-code', incomingChatId: '5d36a65b' });
    expect(got).toBeNull();
  });

  it('still recovers this conversation\'s own archive', () => {
    const mine = { ...stranger, sessionId: 'local-4f7a0e8a', claudeSessionId: '5d36a65b', agentSessionId: '5d36a65b', startedAt: ago(60_000) };
    const got = selectRecoverableArchiveSession([stranger, mine], { ...base, agentSlug: 'claude-code', incomingChatId: '5d36a65b' });
    expect(got?.sessionId).toBe('local-4f7a0e8a');
  });
});

describe('Stop runs the same guard', () => {
  it('stop.ts archive recovery checks archiveIsAnotherConversation before adopting', async () => {
    const fs = await import('fs');
    const path = await import('path');
    const src = fs.readFileSync(path.join(__dirname, '..', 'commands', 'hooks', 'stop.ts'), 'utf8');
    const recovery = src.slice(src.indexOf('Recover from archive if .git state file is missing'));
    expect(recovery.indexOf('archiveIsAnotherConversation(agentSlug, incomingChatId, chatId)')).toBeGreaterThan(0);
    expect(recovery.indexOf('archiveIsAnotherConversation(')).toBeLessThan(recovery.indexOf('recovered session from archive'));
  });
});
