/**
 * A turn that only runs `git commit` gets the commit attested to it — session
 * df8cc9aa turn 6 committed turn 4's work, and a turn like it was recorded
 * with "(no active turn)". See runningTurnIsCommitting;
 * capture-e2e-committing-turn-keeps-its-commit.test.ts runs it through the
 * built binary.
 */
import { describe, it, expect } from 'vitest';
import { closedTurnIsCommittingAfterItsStop, runningTurnIsCommitting } from '../commands/hooks/post-commit.js';
import { preferCommitPatchForCommittedTurns } from '../commit-patch-for-committed-turn.js';

describe('runningTurnIsCommitting', () => {
  const submitted = '2026-10-01T22:50:00.000Z';
  const state = (calls: Array<{ toolName?: string; startedAt?: string; endedAt?: string; prompt?: string }>) => ({
    promptSubmittedAt: ['2026-10-01T22:00:00.000Z', submitted],
    subagents: calls,
  });
  const call = (command: string, over: Record<string, string> = {}) => ({
    toolName: 'Bash', startedAt: '2026-10-01T22:58:00.000Z', prompt: JSON.stringify({ command }), ...over,
  });

  it('an open shell call of the running turn that commits', () => {
    expect(runningTurnIsCommitting(state([call('git add -A && git commit -m fix')]), 1)).toBe(true);
    expect(runningTurnIsCommitting(state([call('git -c core.hooksPath=/h commit -q -m x')]), 1)).toBe(true);
  });

  it('not a call that has ended, began before the prompt, or does not commit', () => {
    expect(runningTurnIsCommitting(state([call('git commit -m x', { endedAt: '2026-10-01T22:58:05.000Z' })]), 1)).toBe(false);
    expect(runningTurnIsCommitting(state([call('git commit -m x', { startedAt: '2026-10-01T22:40:00.000Z' })]), 1)).toBe(false);
    expect(runningTurnIsCommitting(state([call('git status && git log --oneline')]), 1)).toBe(false);
    expect(runningTurnIsCommitting(state([call('echo "commit message"')]), 1)).toBe(false);
  });

  it('nothing without the running prompt\'s submit time', () => {
    expect(runningTurnIsCommitting({ subagents: [call('git commit -m x')] }, 1)).toBe(false);
  });
});

// df8cc9aa turn 27: a background task re-invoked the agent after the turn's
// Stop and it made the turn's second commit with no prompt in between.
describe('closedTurnIsCommittingAfterItsStop', () => {
  const stoppedAt = Date.parse('2026-10-02T20:05:36.000Z');
  const state = (calls: Array<{ toolName?: string; startedAt?: string; endedAt?: string; prompt?: string }>, over: Record<string, unknown> = {}) => ({
    promptSubmittedAt: ['2026-10-02T18:00:00.000Z', '2026-10-02T18:48:58.000Z'],
    lastTurnClosedAt: stoppedAt,
    subagents: calls,
    ...over,
  });
  const call = (command: string, startedAt: string, over: Record<string, string> = {}) => ({
    toolName: 'Bash', startedAt, prompt: JSON.stringify({ command }), ...over,
  });

  it('an open committing call started after the Stop', () => {
    expect(closedTurnIsCommittingAfterItsStop(state([call('git add a b && git commit -m x', '2026-10-02T20:06:28.000Z')]), 1)).toBe(true);
  });

  it('not a committing call the turn started before its Stop', () => {
    expect(closedTurnIsCommittingAfterItsStop(state([call('git commit -m x', '2026-10-02T19:00:00.000Z')]), 1)).toBe(false);
  });

  it('not a finished call, a call that does not commit, or a Stop that never ran', () => {
    expect(closedTurnIsCommittingAfterItsStop(state([call('git commit -m x', '2026-10-02T20:06:28.000Z', { endedAt: '2026-10-02T20:07:08.000Z' })]), 1)).toBe(false);
    expect(closedTurnIsCommittingAfterItsStop(state([call('gh pr view 2083', '2026-10-02T20:06:28.000Z')]), 1)).toBe(false);
    expect(closedTurnIsCommittingAfterItsStop(state([call('git commit -m x', '2026-10-02T20:06:28.000Z')], { lastTurnClosedAt: undefined }), 1)).toBe(false);
  });
});

describe('the committing turn keeps its commit stamp (via preferCommitPatchForCommittedTurns)', () => {
  const A = 'a'.repeat(40);
  const B = 'b'.repeat(40);
  const SQUASH = 'c'.repeat(40);
  const rows = () => [
    { promptIndex: 0, filesChanged: ['src/scope.ts'], diff: 'D0', commitSha: null as string | null },
    { promptIndex: 1, filesChanged: [] as string[], diff: '', commitSha: null as string | null },
    { promptIndex: 2, filesChanged: [] as string[], diff: '', commitSha: null as string | null },
  ];

  it('stamps the git-only turn that ran the commit; its content and the author\'s stay as they are', () => {
    const r = rows();
    preferCommitPatchForCommittedTurns({ promptTurnIds: ['t0', 't1', 't2'], commitTurns: [{ sha: A, turnId: 't1' }] }, r as any, '/nonexistent-repo');
    expect(r[1].commitSha).toBe(A);
    expect(r[1].filesChanged).toEqual([]);
    expect(r[1].diff).toBe('');
    expect(r[0]).toMatchObject({ commitSha: null, diff: 'D0' });
    expect(r[2].commitSha).toBeNull();
  });

  it('a commit a rewrite replaced is stamped as its survivor', () => {
    const r = rows();
    preferCommitPatchForCommittedTurns({
      promptTurnIds: ['t0', 't1', 't2'], commitTurns: [{ sha: B, turnId: 't1' }],
      foldedCommitTurns: [{ sha: A, turnId: 't1' }], rewrittenCommits: [{ from: A, to: B }],
    }, r as any, '/nonexistent-repo');
    expect(r[1].commitSha).toBe(B);
  });

  // df8cc9aa: turn 6's commit → squashed with turns 2–3's into ea924069, attested to turn 2.
  it('a commit a forge squash folded with another turn\'s is stamped with the squash', () => {
    const r = rows();
    preferCommitPatchForCommittedTurns({
      promptTurnIds: ['t0', 't1', 't2'], commitTurns: [{ sha: SQUASH, turnId: 't0' }],
      preSquashCommitTurns: [{ sha: B, turnId: 't2', squash: SQUASH }], rewrittenCommits: [{ from: B, to: SQUASH }],
    }, r as any, '/nonexistent-repo');
    expect(r[2].commitSha).toBe(SQUASH);
    expect(r[1].commitSha).toBeNull();
  });

  it('never replaces a stamp, and never stamps a row that names files', () => {
    const r = rows();
    r[1].commitSha = B;
    preferCommitPatchForCommittedTurns({ promptTurnIds: ['t0', 't1', 't2'], commitTurns: [{ sha: A, turnId: 't1' }, { sha: A, turnId: 't0' }] }, r as any, '/nonexistent-repo');
    expect(r[1].commitSha).toBe(B);
    expect(r[0].commitSha).toBeNull();
  });
});
