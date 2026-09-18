/**
 * A hook that saves a state it read BEFORE post-commit recorded a commit does
 * not erase the commit.
 *
 * The global post-commit hook forks Origin into the background, so the agent's
 * next tool hook runs beside it. Session 6c21a6d8 (2026-09-16), turn 1: each
 * commit was logged `recorded commit on session` (totalForSession 1, 1, 2)
 * while the Claude PostToolUse next to it had loaded the file ~200ms earlier
 * and wrote it back. The turn ended owning none of its three commits, and its
 * row on the page was empty.
 *
 * Driven through the real saveSessionState and state files.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import {
  applyRewritePairsToState, getStatePath, keepCommitRecordsSavedMeanwhile, saveSessionState, type SessionState,
} from '../session-state.js';

const TAG = 'b3a0005f-93e';
const SESSION = '6c21a6d8-ba93-479e-87d7-40e5cd4257b4';
const A = '6af8dfdd2968aa88e772e8a77bb994a589a4f7a5';
const B = 'b7b5c652f855ce01631c4a4fd8be7cf3b042d55c';
const REWRITE_OF_B = '1977fd00600000000000000000000000000000aa';

let repo: string;

const read = (): SessionState => JSON.parse(fs.readFileSync(getStatePath(repo, TAG), 'utf-8'));
const copy = (): SessionState => JSON.parse(JSON.stringify(read()));

beforeEach(() => {
  repo = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'stale-save-')));
  execFileSync('git', ['init', '-q', '-b', 'main', repo], { stdio: 'pipe' });
  saveSessionState({
    sessionId: SESSION, sessionTag: TAG, repoPath: repo, startedAt: '2026-09-16T02:44:00.010Z',
    prompts: ['start reviewing and merging open PR'], promptTurnIds: ['t_1'],
    sessionCommitShas: [], commitTurns: [],
  } as unknown as SessionState, repo, TAG);
});

afterEach(() => { fs.rmSync(repo, { recursive: true, force: true }); });

/** What post-commit does: record the sha, attest the running turn, save. */
function postCommitRecords(sha: string) {
  const s = copy();
  s.sessionCommitShas = [...(s.sessionCommitShas || []), sha];
  s.commitTurns = [...(s.commitTurns || []), { sha, turnId: 't_1', at: new Date().toISOString(), via: 'post-commit' } as any];
  saveSessionState(s, repo, TAG);
}

describe('a tool hook that read the state before post-commit saved', () => {
  it('keeps the commit and its turn attestation', () => {
    const toolHook = copy(); // PostToolUse loads…
    postCommitRecords(A); // …the backgrounded post-commit records and saves…
    toolHook.prompts = [...toolHook.prompts!]; // …the tool hook does its own work…
    (toolHook as any).lastToolCall = 'toolu_018ghyAscdVkcrdSM6QhcsiC';
    saveSessionState(toolHook, repo, TAG); // …and saves its stale copy.

    const after = read();
    expect(after.sessionCommitShas).toEqual([A]);
    expect(after.commitTurns?.map((c) => [c.sha, c.turnId])).toEqual([[A, 't_1']]);
    expect((after as any).lastToolCall, 'the tool hook\'s own write still lands').toBe('toolu_018ghyAscdVkcrdSM6QhcsiC');
  });

  it('keeps every commit across a run of commits and stale saves', () => {
    for (const sha of [A, B]) {
      const toolHook = copy();
      postCommitRecords(sha);
      saveSessionState(toolHook, repo, TAG);
    }
    expect(read().sessionCommitShas).toEqual([A, B]);
    expect(read().commitTurns).toHaveLength(2);
  });

  it('does not bring back a commit the other process folded onto its rewrite', () => {
    postCommitRecords(B);
    const stale = copy(); // still holds B
    const rescue = copy();
    expect(applyRewritePairsToState(rescue, [{ from: B, to: REWRITE_OF_B }])).toBe(true);
    saveSessionState(rescue, repo, TAG);
    saveSessionState(stale, repo, TAG);

    const after = read();
    expect(after.sessionCommitShas).toEqual([REWRITE_OF_B]);
    expect(after.commitTurns?.map((c) => c.sha)).toEqual([REWRITE_OF_B]);
    expect(after.rewrittenCommits).toEqual([{ from: B, to: REWRITE_OF_B }]);
  });
});

describe('a squash across turns recorded by another process', () => {
  // The rescue runs in a backgrounded post-commit. What each turn made is
  // written down at fold time and nowhere else — the fold then replaces the
  // originals with the squash — so a stale save that dropped it would put the
  // earliest turn back on the whole squash (session c98599c8 turn 12).
  it('keeps what each turn made', () => {
    const s = copy();
    s.promptTurnIds = ['t_1', 't_2'];
    s.sessionCommitShas = [A, B];
    s.commitTurns = [
      { sha: A, turnId: 't_1', at: '2026-09-18T12:56:23.000Z', via: 'post-commit' },
      { sha: B, turnId: 't_2', at: '2026-09-18T13:36:24.000Z', via: 'post-commit' },
    ];
    saveSessionState(s, repo, TAG);
    const stale = copy();
    const rescue = copy();
    applyRewritePairsToState(rescue, [{ from: A, to: REWRITE_OF_B }, { from: B, to: REWRITE_OF_B }]);
    saveSessionState(rescue, repo, TAG);
    saveSessionState(stale, repo, TAG);

    const after = read();
    expect(after.commitTurns?.map((c) => [c.sha, c.turnId])).toEqual([[REWRITE_OF_B, 't_1']]);
    expect(after.preSquashCommitTurns?.map((c) => [c.sha, c.turnId, c.squash])).toEqual([
      [A, 't_1', REWRITE_OF_B], [B, 't_2', REWRITE_OF_B],
    ]);
  });
});

describe('keepCommitRecordsSavedMeanwhile', () => {
  it('takes nothing from another session\'s file at the same address', () => {
    const state = { sessionId: 'new-session', sessionCommitShas: [] } as any;
    expect(keepCommitRecordsSavedMeanwhile(state, { sessionId: SESSION, sessionCommitShas: [A] })).toBeNull();
    expect(state.sessionCommitShas).toEqual([]);
  });

  it('treats a short and a full sha as the same commit', () => {
    const state = { sessionId: SESSION, sessionCommitShas: [A] } as any;
    expect(keepCommitRecordsSavedMeanwhile(state, { sessionId: SESSION, sessionCommitShas: [A.slice(0, 8)] })).toBeNull();
    expect(state.sessionCommitShas).toEqual([A]);
  });
});
