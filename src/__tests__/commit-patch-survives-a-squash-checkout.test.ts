/**
 * A turn's commit patch names the files of EVERY commit the turn made, not
 * only the ones still reachable from HEAD.
 *
 * Session 29b32c38 turn 1: five commits on two branches, each squash-merged
 * on the host, and twice `git checkout -B <new> origin/main` mid-turn. At the
 * last Stop only the final commit was an ancestor of HEAD, so the pathspec
 * shrank to that commit's one file and a 120-file turn was sent as
 * `Sessions.tsx +85/-82`. The squashed content was in HEAD the whole time.
 *
 * Driven against real git: the rule turns on ancestry and object existence.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { preferCommitPatchForCommittedTurns } from '../commit-patch-for-committed-turn.js';
import { createShadowCommit, commitDiffScopedToPrompt } from '../git-capture.js';

let repo: string;
const git = (...args: string[]) =>
  execFileSync('git', args, { cwd: repo, encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] }).toString().trim();
const write = (f: string, c: string) => {
  fs.mkdirSync(path.dirname(path.join(repo, f)), { recursive: true });
  fs.writeFileSync(path.join(repo, f), c);
};
const commitAll = (msg: string) => { git('add', '-A'); git('commit', '-qm', msg); return git('rev-parse', 'HEAD'); };

beforeEach(() => {
  repo = fs.mkdtempSync(path.join(os.tmpdir(), 'origin-squash-checkout-'));
  git('init', '-q', '-b', 'main');
  git('config', 'user.email', 't@t.t'); git('config', 'user.name', 'T');
  git('config', 'commit.gpgsign', 'false');
  write('a.ts', 'a1\n'); write('README.md', '# r\n');
  commitAll('base');
});
afterEach(() => { try { fs.rmSync(repo, { recursive: true, force: true }); } catch {} });

/** The turn: two commits on a branch, squash-merged to main, a checkout -B
 *  from main, then a third commit. Returns the state Stop would hold. */
function squashedTurn() {
  const baseline = createShadowCommit(repo, 'turn0') || git('rev-parse', 'HEAD');
  git('checkout', '-qb', 'feat');
  write('a.ts', 'a1\na2\n'); write('b.ts', 'b1\nb2\nb3\n');
  const c1 = commitAll('feat: a and b');
  write('c.ts', 'c1\n');
  const c2 = commitAll('feat: c');
  // The host squash-merges the PR; the branch commits are not ancestors of main.
  git('checkout', '-q', 'main');
  git('merge', '--squash', '-q', 'feat');
  commitAll('feat: a, b and c (#1)');
  // The turn continues from the merged main on a fresh branch.
  git('checkout', '-qB', 'feat2', 'main');
  write('d.ts', 'd1\nd2\n');
  const c3 = commitAll('fix: d');
  const state = {
    promptTurnIds: ['t_0'],
    commitTurns: [{ sha: c1, turnId: 't_0' }, { sha: c2, turnId: 't_0' }, { sha: c3, turnId: 't_0' }],
    promptShadows: [{ promptIndex: 0, shadowSha: baseline }],
    prePromptSha: null,
  };
  // What the narrowed capture looked like on prod: the last commit's file only.
  const mapping = {
    promptIndex: 0,
    filesChanged: ['d.ts'],
    diff: 'diff --git a/d.ts b/d.ts\n--- /dev/null\n+++ b/d.ts\n@@ -0,0 +1,2 @@\n+d1\n+d2\n',
    uncommittedDiff: '',
    linesAdded: 2,
    linesRemoved: 0,
  };
  return { baseline, c1, c2, c3, state, mapping };
}

describe('a turn whose commits were squash-merged and checked out from main', () => {
  it('keeps every commit\'s files in the patch, ending at the last reachable commit', () => {
    const { baseline, c1, c2, c3, state, mapping } = squashedTurn();
    expect(() => git('merge-base', '--is-ancestor', c1, 'HEAD')).toThrow();
    expect(() => git('merge-base', '--is-ancestor', c2, 'HEAD')).toThrow();
    expect(preferCommitPatchForCommittedTurns(state, [mapping], repo)).toBe(1);
    expect([...(mapping.filesChanged as string[])].sort()).toEqual(['a.ts', 'b.ts', 'c.ts', 'd.ts']);
    const expected = commitDiffScopedToPrompt(repo, baseline, c3, ['a.ts', 'b.ts', 'c.ts', 'd.ts'])!;
    expect(mapping.diff).toBe(expected.diff);
    // baseline → last commit over those files: +1 a, +3 b, +1 c, +2 d.
    expect([mapping.linesAdded, mapping.linesRemoved]).toEqual([7, 0]);
    // The patch carries every file: the ledger's "could not read" list is
    // cleared with an explicit [] so the server drops it too.
    expect((mapping as { contentUnavailableFiles?: string[] }).contentUnavailableFiles).toEqual([]);
  });

  it('still stands down when no commit of the turn is reachable and no rewrite is known', () => {
    const { c1, c2, state, mapping } = squashedTurn();
    // Only the squashed-away commits on record: nothing to end the range at.
    state.commitTurns = [{ sha: c1, turnId: 't_0' }, { sha: c2, turnId: 't_0' }];
    const before = { ...mapping };
    const log: string[] = [];
    expect(preferCommitPatchForCommittedTurns(state, [mapping], repo, { log: (e) => log.push(e) })).toBe(0);
    expect(mapping).toEqual(before);
    expect(log).toContain('commit patch declined: no commit of the turn, nor a rewrite of one, is reachable from HEAD');
  });

  it('ends the range at the recorded rewrite when the originals are gone from HEAD', () => {
    const { baseline, c1, c2, state, mapping } = squashedTurn();
    const squash = git('rev-parse', 'main');
    // Session 29b32c38: every branch commit squash-merged, tree on a branch
    // cut from main. The state's rewrittenCommits names the survivor.
    state.commitTurns = [{ sha: c1, turnId: 't_0' }, { sha: c2, turnId: 't_0' }];
    (state as { rewrittenCommits?: Array<{ from: string; to: string }> }).rewrittenCommits = [{ from: c2, to: squash }];
    // The ledger names a file inside the squash; d.ts belongs to a later commit
    // and would (rightly) read as dirty against the survivor.
    mapping.filesChanged = ['a.ts'];
    const log: Array<[string, Record<string, unknown>]> = [];
    expect(preferCommitPatchForCommittedTurns(state, [mapping], repo, { log: (e, d) => log.push([e, d]) })).toBe(1);
    expect([...(mapping.filesChanged as string[])].sort()).toEqual(['a.ts', 'b.ts', 'c.ts']);
    const expected = commitDiffScopedToPrompt(repo, baseline, squash, ['a.ts', 'b.ts', 'c.ts'])!;
    expect(mapping.diff).toBe(expected.diff);
    expect([mapping.linesAdded, mapping.linesRemoved]).toEqual([5, 0]);
    expect(log.find(([e]) => e === 'ledger diff replaced by the commit patch')?.[1]).toMatchObject({ viaRewrite: true, commits: 2 });
  });

  it('a later commit to the same files is not this turn\'s uncommitted work', () => {
    const { baseline, c1, c2, state, mapping } = squashedTurn();
    const squash = git('rev-parse', 'main');
    state.commitTurns = [{ sha: c1, turnId: 't_0' }, { sha: c2, turnId: 't_0' }];
    (state as { rewrittenCommits?: Array<{ from: string; to: string }> }).rewrittenCommits = [{ from: c2, to: squash }];
    mapping.filesChanged = ['a.ts'];
    // A later turn edits a.ts and commits it: the tree is clean against HEAD,
    // yet a.ts differs from the turn's own range end.
    write('a.ts', 'a1\na2\na3-later\n');
    commitAll('later turn: a');
    expect(preferCommitPatchForCommittedTurns(state, [mapping], repo)).toBe(1);
    expect([...(mapping.filesChanged as string[])].sort()).toEqual(['a.ts', 'b.ts', 'c.ts']);
    // The patch stops at the squash: the later line is not in it.
    expect(mapping.diff).not.toContain('a3-later');
    expect(mapping.diff).toBe(commitDiffScopedToPrompt(repo, baseline, squash, ['a.ts', 'b.ts', 'c.ts'])!.diff);
  });

  it('an uncommitted edit to one of the turn\'s files still keeps the ledger', () => {
    const { c1, c2, state, mapping } = squashedTurn();
    const squash = git('rev-parse', 'main');
    state.commitTurns = [{ sha: c1, turnId: 't_0' }, { sha: c2, turnId: 't_0' }];
    (state as { rewrittenCommits?: Array<{ from: string; to: string }> }).rewrittenCommits = [{ from: c2, to: squash }];
    mapping.filesChanged = ['a.ts'];
    write('a.ts', 'a1\na2\nstill typing\n');
    const log: string[] = [];
    expect(preferCommitPatchForCommittedTurns(state, [mapping], repo, { log: (e) => log.push(e) })).toBe(0);
    expect(log).toContain('commit patch declined: a file of the turn is dirty against its commit');
  });

  it('a commit whose object is gone cannot name files, and does not block the rest', () => {
    const { c3, state, mapping } = squashedTurn();
    state.commitTurns = [{ sha: 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeef', turnId: 't_0' }, { sha: c3, turnId: 't_0' }];
    expect(preferCommitPatchForCommittedTurns(state, [mapping], repo)).toBe(1);
    expect(mapping.filesChanged).toEqual(['d.ts']);
  });
});
