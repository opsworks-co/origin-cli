// A re-attach after an idle end looked for its prior state under the WRONG
// tag and started from scratch.
//
// Session 8a06aaf6 (2026-09-09): the desktop app registered it on the primary
// checkout, Origin adopted that handshake into the worktree, and the state
// file kept the handshake's tag (2e5b67ac). The idle sweep ended it after 11h.
// The next prompt's auto-create looked under the conversation's tag
// (46012a70), found nothing, and rebuilt `state` empty: recorded commits,
// rewrite pairs, turn ids and the turn counter gone, the header's baseline
// moved to today's HEAD. The server had deduped the re-attach to the same
// session id, so the rows kept filling — from row 4, with nothing behind them.
//
// The file was there the whole time. Only its name was different.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { findPriorStateForConversation, getStatePath } from '../session-state.js';

const CONVO = '46012a70-a2aa-4728-84fa-5ed3c57d9465';
const SESSION = '8a06aaf6-5b75-437a-ab61-22be6978fe4e';

describe('findPriorStateForConversation', () => {
  let repo: string;
  const write = (tag: string, state: Record<string, unknown>) =>
    fs.writeFileSync(getStatePath(repo, tag), JSON.stringify({ sessionId: SESSION, ...state }));

  beforeEach(() => {
    repo = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'origin-prior-state-')));
    execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: repo });
  });
  afterEach(() => { try { fs.rmSync(repo, { recursive: true, force: true }); } catch { /* ignore */ } });

  it('finds an ENDED state under another tag by the conversation id', () => {
    write('2e5b67ac-7a2', {
      claudeSessionId: CONVO, status: 'ENDED', endedAt: '2026-09-09T04:36:55.459Z',
      sessionCommitShas: ['c14dd715ea3039a712bbaadd1de4eb8547b17fab'],
      rewrittenCommits: [{ from: 'a'.repeat(40), to: 'c14dd715ea3039a712bbaadd1de4eb8547b17fab' }],
      promptTurnIds: ['t_1', 't_2', 't_3'], lastClosedTurnIndex: 2,
    });
    const prior = findPriorStateForConversation(repo, [CONVO], SESSION);
    expect(prior?.sessionTag ?? prior?.sessionId).toBeTruthy();
    expect(prior?.sessionCommitShas).toEqual(['c14dd715ea3039a712bbaadd1de4eb8547b17fab']);
    expect(prior?.rewrittenCommits).toHaveLength(1);
    expect(prior?.lastClosedTurnIndex).toBe(2);
  });

  it('prefers the file the server deduped to over a mere conversation match', () => {
    write('older-tag', { sessionId: 'other-session', claudeSessionId: CONVO, endedAt: '2026-09-09T20:00:00.000Z' });
    write('right-tag', { claudeSessionId: 'different-conversation', endedAt: '2026-09-09T01:00:00.000Z' });
    const prior = findPriorStateForConversation(repo, [CONVO], SESSION);
    expect(prior?.sessionId).toBe(SESSION);
  });

  it('among conversation matches, the newest wins', () => {
    write('a', { sessionId: 's-a', claudeSessionId: CONVO, endedAt: '2026-09-08T10:00:00.000Z' });
    write('b', { sessionId: 's-b', agentSessionId: CONVO, lastStopAt: '2026-09-09T03:05:54.000Z' });
    const prior = findPriorStateForConversation(repo, [CONVO], null);
    expect(prior?.sessionId).toBe('s-b');
  });

  it('matches nothing for a local fallback id or an unrelated conversation', () => {
    write('x', { claudeSessionId: 'someone-else', endedAt: '2026-09-09T01:00:00.000Z' });
    expect(findPriorStateForConversation(repo, [CONVO], 'local-1234')).toBeNull();
    expect(findPriorStateForConversation(repo, [undefined, null], null)).toBeNull();
  });
});
