/**
 * The amend/rebase rescue judges "HEAD cannot reach it" from the tree it runs
 * in. Run from a sibling worktree, that is not evidence of anything: the
 * session's own tree may still stand on the commit.
 *
 * Session fd13f970 (2026-09-17): a subagent's post-commit in worktree B ran the
 * rescue for the parent session, whose turns 0 and 1 had committed in worktree
 * A. B was cut from a main holding the squash of A's PR, so both commits were
 * folded into the squash and turn 1 lost its commit. The end-to-end version is
 * capture-e2e-sibling-worktree-commit-keeps-closed-turns.test.ts; this pins the
 * rule against real git, fast.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { __testRescueCommitShas } from '../commands/hooks.js';

let tmp = '';
let repo = '';
let wtA = '';
let wtB = '';
const git = (cwd: string, ...args: string[]) =>
  execFileSync('git', args, { cwd, encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] }).toString().trim();
const write = (tree: string, f: string, c: string) => fs.writeFileSync(path.join(tree, f), c);

beforeEach(() => {
  tmp = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'origin-rescue-sibling-')));
  repo = path.join(tmp, 'repo');
  fs.mkdirSync(repo);
  git(repo, 'init', '-q', '-b', 'main');
  git(repo, 'config', 'user.email', 't@t.t'); git(repo, 'config', 'user.name', 'T');
  git(repo, 'config', 'commit.gpgsign', 'false');
  write(repo, 'base.txt', 'base\n'); git(repo, 'add', '-A'); git(repo, 'commit', '-qm', 'base');
  wtA = path.join(tmp, 'a');
  git(repo, 'worktree', 'add', '-q', '-b', 'fix/a', wtA);
});
afterEach(() => { try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {} });

/** Two commits in A, their PR squash-merged on main, and B cut from that main. */
function squashedBranchAndSibling() {
  const start = git(wtA, 'rev-parse', 'HEAD');
  write(wtA, 'f.ts', 'export const f = 1;\n'); git(wtA, 'add', '-A'); git(wtA, 'commit', '-qm', 'test: f');
  const first = git(wtA, 'rev-parse', 'HEAD');
  write(wtA, 'f.ts', 'export const f = 2;\n'); write(wtA, 'g.ts', 'export const g = 1;\n');
  git(wtA, 'add', '-A'); git(wtA, 'commit', '-qm', 'fix: f and g');
  const second = git(wtA, 'rev-parse', 'HEAD');
  git(repo, 'merge', '-q', '--squash', 'fix/a'); git(repo, 'commit', '-qm', 'fix: f and g (#1)');
  const squash = git(repo, 'rev-parse', 'HEAD');
  wtB = path.join(tmp, 'b');
  git(repo, 'worktree', 'add', '-q', '-b', 'pr-2', wtB, squash);
  write(wtB, 'h.ts', 'export const h = 1;\n'); git(wtB, 'add', '-A'); git(wtB, 'commit', '-qm', 'fix: h');
  const sibling = git(wtB, 'rev-parse', 'HEAD');
  const state: any = {
    sessionCommitShas: [first, second, sibling], repoPath: wtA, sessionTag: 'test', headShaAtStart: start,
    discoveredWorkTrees: [{ path: wtB, sha: squash, promptIndex: 2 }],
    commitTurns: [
      { sha: first, turnId: 't_zero', at: '2026-09-17T14:00:00Z', via: 'post-commit' },
      { sha: second, turnId: 't_one', at: '2026-09-17T14:10:00Z', via: 'post-commit' },
      { sha: sibling, turnId: 't_six', at: '2026-09-17T15:30:00Z', via: 'post-commit' },
    ],
  };
  return { first, second, squash, sibling, state };
}

describe('the rescue, run from a sibling worktree', () => {
  it('keeps commits the session\'s own tree still stands on', () => {
    const { first, second, sibling, state } = squashedBranchAndSibling();
    expect(__testRescueCommitShas(wtB, state), 'A\'s commits were folded into the squash from B\'s view').toEqual([first, second, sibling]);
    expect(state.rewrittenCommits || []).toEqual([]);
    expect(state.commitTurns.map((c: any) => [c.sha, c.turnId])).toEqual([
      [first, 't_zero'], [second, 't_one'], [sibling, 't_six'],
    ]);
  });

  it('still folds them once no tree of the session stands on them', () => {
    const { first, second, squash, sibling, state } = squashedBranchAndSibling();
    // A moves onto main: the branch commits are left on no HEAD.
    git(wtA, 'checkout', '-q', '--detach', squash);
    __testRescueCommitShas(wtB, state);
    expect(state.rewrittenCommits).toEqual(expect.arrayContaining([
      { from: first, to: squash }, { from: second, to: squash },
    ]));
    expect(state.sessionCommitShas).toEqual([squash, sibling]);
  });
});

// A sibling tree standing on a commit is only an answer to the SHAPE rungs —
// "same parent", "a run whose end state is a reachable commit's tree". Where
// git itself records the rewrite (the amend reflog, the same patch, the same
// tree), the pair holds wherever the rescue runs from: 50fa02ef's rule is that
// only git proves a rewrite, and refusing its proof here would keep a dead sha
// on the session and lose the turn's commit patch at the next Stop.
describe('what git PROVES still outranks a sibling tree', () => {
  it('pairs an amend in the session\'s own tree, though a sibling stands on the original', () => {
    const start = git(wtA, 'rev-parse', 'HEAD');
    write(wtA, 'f.ts', 'export const f = 1;\n'); git(wtA, 'add', '-A'); git(wtA, 'commit', '-qm', 'feat: f');
    const original = git(wtA, 'rev-parse', 'HEAD');
    // The subagent's worktree is cut from the branch tip, so it reaches it.
    wtB = path.join(tmp, 'b');
    git(repo, 'worktree', 'add', '-q', '--detach', wtB, original);
    write(wtA, 'g.ts', 'export const g = 1;\n');
    git(wtA, 'add', '-A'); git(wtA, 'commit', '-q', '--amend', '-m', 'feat: f and g');
    const amended = git(wtA, 'rev-parse', 'HEAD');

    const state: any = {
      sessionCommitShas: [original, amended], repoPath: wtA, sessionTag: 'test', headShaAtStart: start,
      discoveredWorkTrees: [{ path: wtB, sha: original, promptIndex: 1 }],
      commitTurns: [
        { sha: original, turnId: 't_zero', at: '2026-09-17T14:00:00Z', via: 'post-commit' },
        { sha: amended, turnId: 't_zero', at: '2026-09-17T14:01:00Z', via: 'post-commit' },
      ],
    };
    expect(__testRescueCommitShas(wtA, state), 'the amend went unpaired and the dead sha stayed on the session').toEqual([amended]);
    expect(state.rewrittenCommits).toEqual([{ from: original, to: amended }]);
  });

  it('pairs a rebase in the subagent\'s own tree, though the home tree stands on the original', () => {
    const start = git(wtA, 'rev-parse', 'HEAD');
    write(wtA, 'f.ts', 'export const f = 1;\n'); git(wtA, 'add', '-A'); git(wtA, 'commit', '-qm', 'feat: f');
    const original = git(wtA, 'rev-parse', 'HEAD');
    // The subagent works on a copy of the same commit; main then moves.
    wtB = path.join(tmp, 'b');
    git(repo, 'worktree', 'add', '-q', '--detach', wtB, original);
    write(repo, 'main.txt', 'moved\n'); git(repo, 'add', '-A'); git(repo, 'commit', '-qm', 'chore: main moves');
    git(wtB, 'rebase', '-q', 'main');
    const rebased = git(wtB, 'rev-parse', 'HEAD');
    expect(rebased).not.toBe(original);

    const state: any = {
      // Both are recorded: post-commit saved the original, the rebase's copy
      // came back from the reflog — A is still standing on the original.
      sessionCommitShas: [original, rebased], repoPath: wtB, sessionTag: 'test', headShaAtStart: start,
      discoveredWorkTrees: [{ path: wtA, sha: original, promptIndex: 1 }],
      commitTurns: [
        { sha: original, turnId: 't_zero', at: '2026-09-17T14:00:00Z', via: 'post-commit' },
        { sha: rebased, turnId: 't_zero', at: '2026-09-17T14:05:00Z', via: 'post-commit' },
      ],
    };
    expect(__testRescueCommitShas(wtB, state), 'the rebase went unpaired — the same work is owned twice').toEqual([rebased]);
    expect(state.rewrittenCommits).toEqual([{ from: original, to: rebased }]);
  });

  it('folds a reset-squash whose run a sibling sits in the MIDDLE of', () => {
    const start = git(wtA, 'rev-parse', 'HEAD');
    const shas: string[] = [];
    for (const n of [0, 1, 2]) {
      write(wtA, `f${n}.ts`, `export const f${n} = ${n};\n`);
      git(wtA, 'add', '-A'); git(wtA, 'commit', '-qm', `feat: f${n}`);
      shas.push(git(wtA, 'rev-parse', 'HEAD'));
    }
    // The subagent's worktree sits on the MIDDLE commit of the run.
    wtB = path.join(tmp, 'b');
    git(repo, 'worktree', 'add', '-q', '--detach', wtB, shas[1]);
    // `git reset --soft` + one commit: the run's end state, as one commit.
    git(wtA, 'reset', '-q', '--soft', start); git(wtA, 'commit', '-qm', 'feat: f0 f1 f2');
    const squash = git(wtA, 'rev-parse', 'HEAD');

    const state: any = {
      sessionCommitShas: [...shas], repoPath: wtA, sessionTag: 'test', headShaAtStart: start,
      discoveredWorkTrees: [{ path: wtB, sha: shas[1], promptIndex: 1 }],
      commitTurns: shas.map((sha, i) => ({ sha, turnId: `t_${i}`, at: `2026-09-17T14:0${i}:00Z`, via: 'post-commit' })),
    };
    expect(__testRescueCommitShas(wtA, state), 'the run was stranded by the sibling sitting inside it').toEqual([squash]);
    expect(state.rewrittenCommits).toEqual(expect.arrayContaining(
      shas.map((sha) => ({ from: sha, to: squash })),
    ));
  });
});

// A Claude Code sub-agent with worktree isolation works in a harness-created
// `.claude/worktrees/agent-*` checkout that no shell command ever names, so it
// never reaches `discoveredWorkTrees` — the list this guard first read. #1708
// added `writeTrees` (trees the session was OBSERVED writing in) for exactly
// that gap, and the guard reads it for the same reason: the sub-agent's commits
// live only in that tree, and from the parent's tree they look orphaned.
describe('a sub-agent worktree no shell command ever named', () => {
  /** Two commits in the sub-agent's tree, and one in A with their end tree. */
  function subagentRunAndLookalike() {
    const start = git(wtA, 'rev-parse', 'HEAD');
    wtB = path.join(repo, '.claude', 'worktrees', 'agent-abcef6fcf97c94ffe');
    git(repo, 'worktree', 'add', '-q', '--detach', wtB, start);
    write(wtB, 'x1.ts', 'export const x1 = 1;\n'); git(wtB, 'add', '-A'); git(wtB, 'commit', '-qm', 'feat: x1');
    const x1 = git(wtB, 'rev-parse', 'HEAD');
    write(wtB, 'x2.ts', 'export const x2 = 2;\n'); git(wtB, 'add', '-A'); git(wtB, 'commit', '-qm', 'feat: x2');
    const x2 = git(wtB, 'rev-parse', 'HEAD');
    // A lands the same end state in one commit on the same parent — the shape
    // the squash rung is looking for.
    write(wtA, 'x1.ts', 'export const x1 = 1;\n'); write(wtA, 'x2.ts', 'export const x2 = 2;\n');
    git(wtA, 'add', '-A'); git(wtA, 'commit', '-qm', 'feat: x1 and x2');
    const lookalike = git(wtA, 'rev-parse', 'HEAD');
    expect(git(wtA, 'rev-parse', `${lookalike}^{tree}`)).toBe(git(wtB, 'rev-parse', `${x2}^{tree}`));
    const state: any = {
      sessionCommitShas: [x1, x2, lookalike], repoPath: wtA, sessionTag: 'test', headShaAtStart: start,
      // The harness made the worktree, so no Bash command named it: nothing
      // here, and the write trees are the only record that it exists.
      discoveredWorkTrees: [],
      commitTurns: [
        { sha: x1, turnId: 't_six', at: '2026-09-17T15:30:00Z', via: 'post-commit' },
        { sha: x2, turnId: 't_six', at: '2026-09-17T15:31:00Z', via: 'post-commit' },
        { sha: lookalike, turnId: 't_one', at: '2026-09-17T15:40:00Z', via: 'post-commit' },
      ],
    };
    return { x1, x2, lookalike, state };
  }

  it('keeps the sub-agent\'s commits, which only that tree stands on', () => {
    const { x1, x2, lookalike, state } = subagentRunAndLookalike();
    state.writeTrees = [{ path: wtB, at: new Date().toISOString(), files: ['x1.ts', 'x2.ts'] }];
    expect(
      __testRescueCommitShas(wtA, state),
      'the sub-agent\'s commits were folded into A\'s look-alike — its worktree was invisible',
    ).toEqual([x1, x2, lookalike]);
    expect(state.rewrittenCommits || []).toEqual([]);
    expect(state.commitTurns.map((c: any) => c.turnId)).toEqual(['t_six', 't_six', 't_one']);
  });

  it('keeps them on a write-tree entry old enough to have expired', () => {
    const { x1, x2, lookalike, state } = subagentRunAndLookalike();
    // Past WRITE_TREE_MAX_AGE_MS. Age says when the session last WROTE there;
    // the question here is whether that checkout still holds the commit today,
    // and it does.
    state.writeTrees = [{
      path: wtB,
      at: new Date(Date.now() - 5 * 60 * 60 * 1000).toISOString(),
      files: ['x1.ts', 'x2.ts'],
    }];
    expect(__testRescueCommitShas(wtA, state)).toEqual([x1, x2, lookalike]);
    expect(state.rewrittenCommits || []).toEqual([]);
  });

  it('folds them once that worktree is gone', () => {
    const { x1, x2, lookalike, state } = subagentRunAndLookalike();
    state.writeTrees = [{ path: wtB, at: new Date().toISOString(), files: ['x1.ts', 'x2.ts'] }];
    git(repo, 'worktree', 'remove', '--force', wtB);
    const removed = wtB;
    wtB = '';
    expect(fs.existsSync(removed)).toBe(false);
    expect(__testRescueCommitShas(wtA, state)).toEqual([lookalike]);
    expect(state.rewrittenCommits).toEqual(expect.arrayContaining([
      { from: x1, to: lookalike }, { from: x2, to: lookalike },
    ]));
  });
});
