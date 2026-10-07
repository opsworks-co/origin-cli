/**
 * A turn's several-branch patch counts what the turn wrote — not what a merge
 * brought in, not an earlier turn's work it only committed, and not a merge it
 * redid.
 *
 * Sessions d027b430 and c085f0af (2026-09-27):
 *   • turn 9 merged main into its PR branch and bumped the version. The row
 *     read +137/-2 beside "2 commits total +52/-6": the branch range ran across
 *     the merge and carried 89 lines of #1922 and #1926.
 *   • turn 7 committed turn 6's +426 (written, not committed, in turn 6) and
 *     read +457/-3 while turn 6 kept +426 — the same lines on two rows.
 *     It had also merged main twice with the same parents (ec4e1329, reset
 *     away; e9f9d378), and the abandoned merge stood as a second branch.
 *   • c085f0af turn 19 squash-merged a PR whose commit predates the turn; the
 *     squash was measured from its parent and read +93/-1, turn 18's work.
 *
 * Driven against real git: the rule turns on ancestry and merge parents.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { preferCommitPatchForCommittedTurns } from '../commit-patch-for-committed-turn.js';
import { createShadowCommit } from '../git-capture.js';

let repo: string;
const git = (...args: string[]) =>
  execFileSync('git', args, { cwd: repo, encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] }).toString().trim();
const write = (f: string, c: string) => {
  fs.mkdirSync(path.dirname(path.join(repo, f)), { recursive: true });
  fs.writeFileSync(path.join(repo, f), c);
};
const commitAll = (msg: string) => { git('add', '-A'); git('commit', '-qm', msg); return git('rev-parse', 'HEAD'); };
const lines = (n: number, tag: string) => Array.from({ length: n }, (_, i) => `${tag}${i}`).join('\n') + '\n';
const mapping = () => ({ promptIndex: 1, filesChanged: [] as string[], diff: '', uncommittedDiff: '', linesAdded: 0, linesRemoved: 0 });
const several = (log: Array<[string, Record<string, unknown>]>) =>
  log.find(([e]) => e === 'ledger diff replaced by the commit patches of several branches')?.[1];

beforeEach(() => {
  repo = fs.mkdtempSync(path.join(os.tmpdir(), 'origin-branch-own-work-'));
  git('init', '-q', '-b', 'main');
  git('config', 'user.email', 't@t.t'); git('config', 'user.name', 'T');
  git('config', 'commit.gpgsign', 'false');
  write('lib.ts', lines(40, 'lib')); write('package.json', '{"version":"1"}\n'); write('other.ts', 'o\n');
  commitAll('base');
});
afterEach(() => { try { fs.rmSync(repo, { recursive: true, force: true }); } catch {} });

describe("a turn's several-branch patch", () => {
  it('counts a merge by its resolution, not by what it brought in', () => {
    git('checkout', '-qb', 'fix');
    write('lib.ts', lines(40, 'lib') + 'mine\n');
    const earlier = commitAll('fix: an earlier turn');
    // Main moves on in the same file, far from the branch's edit.
    git('checkout', '-q', 'main');
    write('lib.ts', 'theirs0\ntheirs1\ntheirs2\n' + lines(40, 'lib'));
    commitAll('feat: someone else');
    git('checkout', '-q', 'fix');

    const shadow = createShadowCommit(repo, 'turn1')!;
    git('merge', '-q', '--no-edit', 'main');
    const merge = git('rev-parse', 'HEAD');
    write('package.json', '{"version":"2"}\n');
    const bump = commitAll('chore: bump');
    // The turn also committed on a second branch, so the pass goes branch by branch.
    git('checkout', '-qb', 'side', 'main');
    write('other.ts', 'o\no2\n');
    const side = commitAll('fix: side');

    const state = {
      promptTurnIds: ['t_0', 't_1'],
      commitTurns: [{ sha: earlier, turnId: 't_0' }, { sha: merge, turnId: 't_1' }, { sha: bump, turnId: 't_1' }, { sha: side, turnId: 't_1' }],
      promptShadows: [{ promptIndex: 1, shadowSha: shadow }],
      prePromptSha: null,
    };
    const pm = mapping();
    const log: Array<[string, Record<string, unknown>]> = [];
    expect(preferCommitPatchForCommittedTurns(state, [pm], repo, { log: (e, d) => log.push([e, d]) })).toBe(1);
    // package.json +1/-1 and other.ts +1. Before: lib.ts +3 as well — main's lines.
    expect([pm.linesAdded, pm.linesRemoved]).toEqual([2, 1]);
    expect(pm.diff).not.toContain('theirs');
    expect([...(pm.filesChanged as string[])].sort()).toEqual(['other.ts', 'package.json']);
    expect(several(log)).toMatchObject({ branches: 2 });
  });

  it("does not bill a turn for an earlier turn's work it only committed", () => {
    // Turn 0 writes and leaves it uncommitted; turn 1 starts with it in the tree.
    write('lib.ts', lines(40, 'lib') + lines(20, 'turn0-'));
    const shadow = createShadowCommit(repo, 'turn1')!;
    git('checkout', '-qb', 'feat');
    const shipped = commitAll('feat: turn 0 work');
    write('package.json', '{"version":"2"}\n');
    const bump = commitAll('chore: bump');
    git('checkout', '-qb', 'side', 'main');
    write('other.ts', 'o\no2\n');
    const side = commitAll('fix: side');

    const state = {
      promptTurnIds: ['t_0', 't_1'],
      commitTurns: [{ sha: shipped, turnId: 't_1' }, { sha: bump, turnId: 't_1' }, { sha: side, turnId: 't_1' }],
      promptShadows: [{ promptIndex: 1, shadowSha: shadow }],
      prePromptSha: null,
    };
    const pm = mapping();
    expect(preferCommitPatchForCommittedTurns(state, [pm], repo)).toBe(1);
    // Before: +23/-1, turn 0's twenty lines included.
    expect([pm.linesAdded, pm.linesRemoved]).toEqual([2, 1]);
    expect(pm.diff).not.toContain('turn0-');
  });

  it("does not bill a turn for an earlier turn's work it committed in a linked worktree", () => {
    // Session 9f3d6bd2 (2026-09-27): turn 0's background sub-agent wrote a test
    // in its own worktree and left it uncommitted; it committed it there during
    // turn 1. Turn 1's shadow is of the main checkout — another HEAD, without
    // the file — so the file read as new and turn 1 was sent its +139 again.
    const wt = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'origin-branch-wt-')));
    fs.rmSync(wt, { recursive: true, force: true });
    try {
      git('worktree', 'add', '-q', '-b', 'agent', wt, 'main');
      fs.writeFileSync(path.join(wt, 'agent.test.ts'), lines(30, 'turn0-'));
      // The main checkout moved on before turn 1 began: its HEAD is not the worktree's.
      git('checkout', '-qb', 'fix');
      write('lib.ts', lines(40, 'lib') + 'earlier\n');
      const earlier = commitAll('fix: an earlier turn');

      // Turn 1 begins: a shadow of each checkout.
      const shadow = createShadowCommit(repo, 'turn1')!;
      const wtShadow = createShadowCommit(wt, 'turn1-wt')!;
      const wtGit = (...args: string[]) => execFileSync('git', args, { cwd: wt, encoding: 'utf-8' }).toString().trim();
      wtGit('add', '-A'); wtGit('commit', '-qm', 'test: the sub-agent commits its file');
      const agentCommit = wtGit('rev-parse', 'HEAD');
      write('other.ts', 'o\nmine\n');
      const own = commitAll('fix: turn 1');

      const state = (withWorkTree: boolean) => ({
        promptTurnIds: ['t_0', 't_1'],
        commitTurns: [{ sha: earlier, turnId: 't_0' }, { sha: agentCommit, turnId: 't_1' }, { sha: own, turnId: 't_1' }],
        promptShadows: [{ promptIndex: 1, shadowSha: shadow }],
        ...(withWorkTree ? { promptWorkTreeShadows: [{ promptIndex: 1, path: wt, shadowSha: wtShadow }] } : {}),
        prePromptSha: null,
      });
      const before = mapping();
      preferCommitPatchForCommittedTurns(state(false), [before], repo);
      expect(before.filesChanged).toContain('agent.test.ts');

      const pm = mapping();
      expect(preferCommitPatchForCommittedTurns(state(true), [pm], repo)).toBe(1);
      expect(pm.filesChanged).toEqual(['other.ts']);
      expect([pm.linesAdded, pm.linesRemoved]).toEqual([1, 0]);
      expect(pm.diff).not.toContain('turn0-');
    } finally {
      try { git('worktree', 'remove', '--force', wt); } catch { /* */ }
    }
  });

  it("does not bill the turn that squash-merged a commit it started with", () => {
    // Session c085f0af turn 19: the PR commit was made before the turn began;
    // the turn ran `gh pr merge --squash`, and the squash was its only commit.
    git('checkout', '-qb', 'pr');
    write('lib.ts', lines(40, 'lib') + lines(30, 'earlier-'));
    commitAll('fix: an earlier turn');
    // Something unrelated is dirty, so the turn's shadow is a real shadow
    // commit on top of the PR commit — not on the squash's parent.
    write('package.json', '{"version":"dirty"}\n');
    const shadow = createShadowCommit(repo, 'turn1')!;
    git('checkout', '-q', 'main');
    git('merge', '-q', '--squash', 'pr');
    git('commit', '-qm', 'fix: squashed (#1)');
    const squash = git('rev-parse', 'HEAD');
    git('checkout', '-q', '--orphan', 'elsewhere'); git('rm', '-rqf', '.');
    write('other.ts', 'o\no2\n');
    const side = commitAll('fix: side');

    const state = {
      promptTurnIds: ['t_0', 't_1'],
      commitTurns: [{ sha: squash, turnId: 't_1' }, { sha: side, turnId: 't_1' }],
      promptShadows: [{ promptIndex: 1, shadowSha: shadow }],
      prePromptSha: null,
    };
    const pm = mapping();
    expect(preferCommitPatchForCommittedTurns(state, [pm], repo)).toBe(1);
    // other.ts only (+2, a new file on an unrelated root). Before: +32 — the
    // squash measured from its parent carried the earlier turn's thirty lines.
    expect([pm.linesAdded, pm.linesRemoved]).toEqual([2, 0]);
    expect(pm.diff).not.toContain('earlier-');
  });

  it('counts a commit and the squash the forge made of it once', () => {
    // Session 9f3d6bd2 turn 3 (#1936): the branch commit and GitHub's squash
    // of it were both the turn's; the squash sat inside the main-line range.
    const shadow = createShadowCommit(repo, 'turn1') || git('rev-parse', 'HEAD');
    git('checkout', '-qb', 'fix');
    write('lib.ts', lines(40, 'lib') + lines(12, 'fixed-'));
    const original = commitAll('fix: the change');
    git('checkout', '-q', 'main');
    // The forge squashes it onto main; the turn fetches and bumps on top.
    git('merge', '-q', '--squash', 'fix');
    git('commit', '-qm', 'fix: the change (#1)');
    const squash = git('rev-parse', 'HEAD');
    write('package.json', '{"version":"2"}\n');
    const bump = commitAll('chore(release): bump');
    git('checkout', '-q', '--orphan', 'side'); git('rm', '-rqf', '.');
    write('other.ts', 'o\no2\n');
    const side = commitAll('fix: side');
    git('checkout', '-q', 'fix');

    const state = {
      promptTurnIds: ['t_0', 't_1'],
      commitTurns: [
        { sha: original, turnId: 't_1' }, { sha: squash, turnId: 't_1' }, { sha: bump, turnId: 't_1' }, { sha: side, turnId: 't_1' },
      ],
      promptShadows: [{ promptIndex: 1, shadowSha: shadow }],
      prePromptSha: null,
    };
    const pm = mapping();
    const log: Array<[string, Record<string, unknown>]> = [];
    expect(preferCommitPatchForCommittedTurns(state, [pm], repo, { log: (e, d) => log.push([e, d]) })).toBe(1);
    // lib.ts +12 once, package.json +1/-1, other.ts +2. Before: lib.ts twice, +12 more.
    expect([pm.linesAdded, pm.linesRemoved]).toEqual([15, 1]);
    expect((pm.diff.match(/^diff --git a\/lib\.ts /gm) || []).length).toBe(1);
    expect(log.map(([e]) => e)).toContain('a commit and its forge squash are the same change — counted once');
  });

  it("stamps the union with the turn's NEWEST commit, the sha post-commit left on the row", () => {
    // Session 690e594c turn 6: the union went out under the chain holding the
    // row's stale local sha, the server's row named the turn's latest commit,
    // and every Stop was refused as "a commit patch of another commit".
    const at = (iso: string, fn: () => string) => {
      process.env.GIT_COMMITTER_DATE = iso;
      try { return fn(); } finally { delete process.env.GIT_COMMITTER_DATE; }
    };
    const shadow = createShadowCommit(repo, 'turn1') || git('rev-parse', 'HEAD');
    git('checkout', '-qb', 'older');
    write('package.json', '{"version":"2"}\n');
    const older = at('2026-09-27T21:00:00Z', () => commitAll('chore: bump'));
    git('checkout', '-q', '--orphan', 'newer'); git('rm', '-rqf', '.');
    write('other.ts', 'o\no2\n');
    const newer = at('2026-09-27T22:54:00Z', () => commitAll('fix: the real work'));

    const state = {
      promptTurnIds: ['t_0', 't_1'],
      commitTurns: [{ sha: older, turnId: 't_1' }, { sha: newer, turnId: 't_1' }],
      promptShadows: [{ promptIndex: 1, shadowSha: shadow }],
      prePromptSha: null,
    };
    const pm = { ...mapping(), commitSha: older };
    expect(preferCommitPatchForCommittedTurns(state, [pm], repo)).toBe(1);
    expect((pm as { commitSha?: string }).commitSha).toBe(newer);
  });

  it('sends a merge the turn redid with the same parents once', () => {
    // As in prod, the abandoned merge sits on the turn's own first commit.
    git('checkout', '-q', '-b', 'mainline');
    write('package.json', '{"version":"main"}\n');
    commitAll('main: bump');
    git('checkout', '-q', 'main');
    const shadow = createShadowCommit(repo, 'turn1')!;
    git('checkout', '-qb', 'fix');
    write('package.json', '{"version":"fix"}\n');
    const own = commitAll('fix: own');
    const resolve = (v: string) => {
      try { git('merge', '-q', '--no-edit', 'mainline'); } catch { /* conflict, resolved below */ }
      write('package.json', `{"version":"${v}"}\n`);
      git('add', '-A'); git('commit', '-q', '--no-edit');
      return git('rev-parse', 'HEAD');
    };
    const abandoned = resolve('first-try');
    git('reset', '-q', '--hard', own);
    const kept = resolve('second-try');
    write('lib.ts', lines(40, 'lib') + 'after\n');
    const after = commitAll('fix: after the merge');
    // An unrelated history: a sibling of main here would read as an amend of
    // `own` (same parent), which is a different rule.
    git('checkout', '-q', '--orphan', 'side'); git('rm', '-rqf', '.');
    write('other.ts', 'o\no2\n');
    const side = commitAll('fix: side');

    const state = {
      promptTurnIds: ['t_0', 't_1'],
      commitTurns: [
        { sha: own, turnId: 't_1' },
        { sha: abandoned, turnId: 't_1' }, { sha: kept, turnId: 't_1' }, { sha: after, turnId: 't_1' }, { sha: side, turnId: 't_1' },
      ],
      promptShadows: [{ promptIndex: 1, shadowSha: shadow }],
      prePromptSha: null,
    };
    const pm = mapping();
    const log: Array<[string, Record<string, unknown>]> = [];
    expect(preferCommitPatchForCommittedTurns(state, [pm], repo, { log: (e, d) => log.push([e, d]) })).toBe(1);
    expect(pm.diff).toContain('second-try');
    expect(pm.diff).not.toContain('first-try');
    expect(several(log)).toMatchObject({ branches: 2 });
  });
});
