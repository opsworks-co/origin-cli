import fs from 'fs';
import os from 'os';
import path from 'path';
import { execFileSync } from 'child_process';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { recordManualSessionEnd } from '../manual-session-end.js';
import { pickActiveSessionForCommit } from '../commands/hooks/git-hooks.js';

/**
 * The commit #1918 was written for was NOT made in a tree with no live
 * session. prepare-commit-msg for 12b4e4eaa (PR #1911, 2026-09-26 15:18Z)
 * logged "skip: the only live session shows no evidence for the staged files
 * {session: b300fdf0, why: no open turn and no recorded turn touched any
 * committed file}" — a quiet sibling conversation in the same worktree was in
 * the pool, so the lone-session branch returned before the manual-end fallback
 * ran, and the commit still went out without a trailer.
 *
 * The session ended by hand whose turn is still running ranks as a session
 * with a turn OPEN: below a live session at work on these files now, above a
 * live session whose only claim is a finished turn, or none.
 */
const ENDED = 'ab123456-0000-4000-8000-00000000003b';
const CONVERSATION = 'conversation-ended-mid-turn';
let repo: string;

const git = (...args: string[]) => execFileSync('git', args, { cwd: repo, encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] }).trim();
const endedState = () => ({
  sessionId: ENDED, sessionTag: 'ended', claudeSessionId: CONVERSATION, agentSessionId: CONVERSATION,
  agentSlug: 'claude-code', model: 'claude-opus-5', repoPath: repo, lastCwd: repo,
  startedAt: new Date(Date.now() - 600_000).toISOString(), status: 'ENDED', endedAt: new Date().toISOString(),
  prompts: ['fix it', 'merge and release it yourself'], promptTurnIds: ['t_1', 't_2'],
  completedPromptMappings: [{ promptIndex: 0, filesChanged: ['other.txt'] }, { promptIndex: 1, filesChanged: [] }],
});
const liveState = (id: string, tag: string, over: Record<string, unknown> = {}) => ({
  sessionId: id, sessionTag: tag, claudeSessionId: `conversation-${tag}`, agentSessionId: `conversation-${tag}`,
  agentSlug: 'claude-code', model: 'claude-opus-5', repoPath: repo, lastCwd: repo, status: 'RUNNING',
  startedAt: new Date(Date.now() - 300_000).toISOString(), headShaAtStart: git('rev-parse', 'HEAD'),
  prompts: ["check what's in here"],
  completedPromptMappings: [{ promptIndex: 0, filesChanged: [] }], lastClosedTurnIndex: 0,
  ...over,
});
const writeLive = (state: Record<string, unknown>) =>
  fs.writeFileSync(path.join(repo, '.git', `origin-session-${state.sessionTag}.json`), JSON.stringify(state), { mode: 0o600 });
const endedByHand = () => {
  const dir = path.join(os.homedir(), '.origin', 'sessions');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `${ENDED.slice(0, 12)}.json`), JSON.stringify(endedState()));
  recordManualSessionEnd(endedState());
};

beforeEach(() => {
  fs.rmSync(path.join(os.homedir(), '.origin', 'manual-session-ends'), { recursive: true, force: true });
  fs.rmSync(path.join(os.homedir(), '.origin', 'sessions'), { recursive: true, force: true });
  repo = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ended-vs-quiet-')));
  git('init', '-q', '-b', 'main');
  git('config', 'user.email', 't@t.t'); git('config', 'user.name', 'T'); git('config', 'commit.gpgsign', 'false');
  fs.writeFileSync(path.join(repo, 'f.txt'), 'base\n'); git('add', '-A'); git('commit', '-qm', 'base');
  // The ended turn's fix, staged.
  fs.writeFileSync(path.join(repo, 'f.txt'), 'base\nfixed\n'); git('add', '-A');
});
afterEach(() => fs.rmSync(repo, { recursive: true, force: true }));

describe('a commit after a manual end, with a live session in the tree', () => {
  it('the incident: a quiet live session refused for lack of evidence no longer blocks the ended turn', () => {
    writeLive(liveState('b300fdf0-0000-4000-8000-000000000001', 'quiet'));
    endedByHand();
    expect(pickActiveSessionForCommit(repo, { afterManualEnd: true })?.sessionId).toBe(ENDED);
    // The control: without the marker the quiet session is still refused.
    fs.rmSync(path.join(os.homedir(), '.origin', 'manual-session-ends'), { recursive: true, force: true });
    expect(pickActiveSessionForCommit(repo, { afterManualEnd: true })).toBeNull();
  });

  it('is still only offered to a caller that asked', () => {
    writeLive(liveState('b300fdf0-0000-4000-8000-000000000001', 'quiet'));
    endedByHand();
    expect(pickActiveSessionForCommit(repo)).toBeNull();
  });

  it('a live session with a turn open is at work now and keeps the commit', () => {
    writeLive(liveState('b300fdf0-0000-4000-8000-000000000001', 'busy', {
      activeTurn: { index: 0, turnId: 't0', promptText: "check what's in here", openedAt: new Date().toISOString() },
    }));
    endedByHand();
    expect(pickActiveSessionForCommit(repo, { afterManualEnd: true })?.sessionId).toBe('b300fdf0-0000-4000-8000-000000000001');
  });

  it('a live session whose FINISHED turn touched the staged file yields to the turn still running', () => {
    writeLive(liveState('b300fdf0-0000-4000-8000-000000000001', 'earlier', {
      completedPromptMappings: [{ promptIndex: 0, filesChanged: ['f.txt'] }],
    }));
    endedByHand();
    expect(pickActiveSessionForCommit(repo, { afterManualEnd: true })?.sessionId).toBe(ENDED);
    // Without the marker that finished turn is the best evidence there is.
    fs.rmSync(path.join(os.homedir(), '.origin', 'manual-session-ends'), { recursive: true, force: true });
    expect(pickActiveSessionForCommit(repo, { afterManualEnd: true })?.sessionId).toBe('b300fdf0-0000-4000-8000-000000000001');
  });

  it('several quiet live sessions, none mid-turn: the ended turn outranks the tie-breaking guesses', () => {
    writeLive(liveState('b300fdf0-0000-4000-8000-000000000001', 'quiet-a'));
    writeLive(liveState('c400fdf0-0000-4000-8000-000000000002', 'quiet-b'));
    endedByHand();
    expect(pickActiveSessionForCommit(repo, { afterManualEnd: true })?.sessionId).toBe(ENDED);
  });

  it('a live session mid-turn in ANOTHER worktree does not take the commit from the turn ended by hand in this one', () => {
    // 2026-09-27 14:02Z, commit 9d583342: the conversation in
    // `vigorous-rubin-91647c` had been ended by hand for a release and went on
    // to commit. The only live session was d027b430, home
    // `capturing-corruption-33d0db`, mid-turn — and it got the trailer.
    const wt = path.join(repo, '.claude', 'worktrees');
    git('commit', '-qm', 'staged base');
    git('worktree', 'add', '-q', '-b', 'vigorous', path.join(wt, 'vigorous-rubin-91647c'));
    git('worktree', 'add', '-q', '-b', 'capturing', path.join(wt, 'capturing-corruption-33d0db'));
    const vigorous = fs.realpathSync(path.join(wt, 'vigorous-rubin-91647c'));
    const capturing = fs.realpathSync(path.join(wt, 'capturing-corruption-33d0db'));
    writeLive(liveState('d027b430-0000-4000-8000-000000000003', 'neighbour', {
      repoPath: capturing, lastCwd: capturing,
      activeTurn: { index: 0, turnId: 't0', promptText: 'merge and release it yourself', openedAt: new Date().toISOString() },
    }));
    const ended = { ...endedState(), repoPath: vigorous, lastCwd: vigorous };
    const dir = path.join(os.homedir(), '.origin', 'sessions');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, `${ENDED.slice(0, 12)}.json`), JSON.stringify(ended));
    recordManualSessionEnd(ended);
    fs.writeFileSync(path.join(vigorous, 'f.txt'), 'base\nfixed\nagain\n');
    execFileSync('git', ['add', '-A'], { cwd: vigorous, stdio: 'pipe' });
    expect(pickActiveSessionForCommit(vigorous, { afterManualEnd: true })?.sessionId).toBe(ENDED);
    // Without the marker nobody owns this tree: no trailer beats the neighbour's.
    fs.rmSync(path.join(os.homedir(), '.origin', 'manual-session-ends'), { recursive: true, force: true });
    expect(pickActiveSessionForCommit(vigorous, { afterManualEnd: true })).toBeNull();
  });

  it('several live sessions with one mid-turn: the existing rules decide, not the ended turn', () => {
    writeLive(liveState('b300fdf0-0000-4000-8000-000000000001', 'quiet-a'));
    writeLive(liveState('c400fdf0-0000-4000-8000-000000000002', 'busy-b', {
      activeTurn: { index: 0, turnId: 't0', promptText: "check what's in here", openedAt: new Date().toISOString() },
    }));
    endedByHand();
    expect(pickActiveSessionForCommit(repo, { afterManualEnd: true })?.sessionId).not.toBe(ENDED);
  });
});
