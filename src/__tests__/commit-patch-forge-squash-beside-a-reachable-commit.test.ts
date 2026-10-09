/**
 * A turn whose work is split: part reached HEAD as a squash the forge made of
 * its branch, part is a commit the turn made on HEAD itself.
 *
 * Live session 353eb15f turn 6 (2026-10-08). A sub-agent wrote the feature in
 * its own worktree and committed it there (2f550462, 5d48361a — 12 files,
 * +857/-13). The PR was squash-merged on GitHub as 3b224fd2, and the turn then
 * committed the version bump 26ee73ae on main. The page read "+3 -3" for the
 * turn beside "3 commits net +860/-16".
 *
 * The branch chain stood `carried` — its content is in HEAD, through the squash
 * — and `carried` only counted when none of the turn was reachable. The bump
 * was, so the single range ran shadow → bump, met the squash inside it as a
 * commit the turn did not make, measured the feature's files from after it,
 * and kept the bump's two files.
 *
 * Driven against real git: the rule turns on refs, ancestry and patch ids.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { preferCommitPatchForCommittedTurns, pathsInDiff } from '../commit-patch-for-committed-turn.js';
import { createShadowCommit } from '../git-capture.js';
import { inheritedBaselineForTurn, inheritedFileSourcesForTurn } from '../commands/hooks.js';

let repo: string;
const git = (...args: string[]) =>
  execFileSync('git', args, { cwd: repo, encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] }).toString().trim();
const write = (f: string, c: string) => {
  fs.mkdirSync(path.dirname(path.join(repo, f)), { recursive: true });
  fs.writeFileSync(path.join(repo, f), c);
};
const commitAll = (msg: string, env: Record<string, string> = {}) => {
  git('add', '-A');
  execFileSync('git', ['commit', '-qm', msg], {
    cwd: repo, encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env, ...env },
  });
  return git('rev-parse', 'HEAD');
};
/** A squash-merge done on GitHub: your authorship, GitHub's committer line. */
const BY_GITHUB = { GIT_COMMITTER_NAME: 'GitHub', GIT_COMMITTER_EMAIL: 'noreply@github.com' };
/** The resolvers Stop hands the pass: a commit in the window the turn did not make is inherited. */
const stopDeps = (state: any, log?: (e: string, d: Record<string, unknown>) => void) => ({
  inheritedBaseline: (shadow: string, local: number) => inheritedBaselineForTurn(repo, state, shadow, local),
  inheritedFiles: (shadow: string, local: number, files: string[], end: string) =>
    inheritedFileSourcesForTurn(repo, state, shadow, local, files, end),
  ...(log ? { log } : {}),
});
const row = () => ({
  promptIndex: 0, filesChanged: ['version.txt'] as string[], diff: '', uncommittedDiff: '',
  linesAdded: 1, linesRemoved: 1, commitSha: null as string | null,
});

beforeEach(() => {
  repo = fs.mkdtempSync(path.join(os.tmpdir(), 'origin-forge-squash-beside-'));
  git('init', '-q', '-b', 'main');
  git('config', 'user.email', 't@t.t'); git('config', 'user.name', 'T');
  git('config', 'commit.gpgsign', 'false');
  write('memory.ts', 'export const a = 1;\n');
  write('version.txt', '1.0.0\n');
  write('other.ts', 'other\n');
  commitAll('base');
});
afterEach(() => { try { fs.rmSync(repo, { recursive: true, force: true }); } catch {} });

/**
 * The 353eb15f shape. The turn STARTS on the previous turn's PR branch (its
 * shadow sits off main, as bcc33818 did), a sub-agent branches from main and
 * commits twice, the forge squashes both PRs onto main, and the turn moves to
 * main and commits the bump there.
 */
function subAgentBranchSquashedThenBump(opts: { keepBranch: boolean }) {
  const baseMain = git('rev-parse', 'HEAD');
  git('checkout', '-qb', 'prev-pr');
  write('prev.ts', 'earlier turn\n');
  const prev = commitAll('fix: an earlier turn');
  const baseline = createShadowCommit(repo, 'turn0') || prev;

  // The sub-agent's worktree branch, cut from main: two commits.
  git('checkout', '-q', baseMain);
  git('checkout', '-qb', 'agent-wt');
  write('memory.ts', 'export const a = 1;\nexport const addTodo = 2;\n');
  write('tools.ts', 'tool one\ntool two\n');
  const feature = commitAll('feat: memory write tools');
  write('tools.ts', 'tool one\ntool two\ntool three\n');
  const followUp = commitAll('fix: list open todos');

  // Someone else lands on main meanwhile — not the turn's, must not be billed —
  // and the forge squashes the earlier turn's PR.
  git('checkout', '-q', 'main');
  write('other.ts', 'other\nsomeone else\n');
  commitAll('another session');
  write('prev.ts', 'earlier turn\n');
  commitAll('fix: an earlier turn (#2247)', BY_GITHUB);

  // GitHub squash-merges the PR: same content, one new commit, not the turn's.
  write('memory.ts', 'export const a = 1;\nexport const addTodo = 2;\n');
  write('tools.ts', 'tool one\ntool two\ntool three\n');
  const squash = commitAll('feat: memory write tools (#2248)', BY_GITHUB);
  if (!opts.keepBranch) git('branch', '-qD', 'agent-wt');

  // The turn's own commit on main.
  write('version.txt', '1.0.1\n');
  const bump = commitAll('chore(release): 1.0.1');

  const state = {
    promptTurnIds: ['t_0'],
    commitTurns: [
      { sha: feature, turnId: 't_0' },
      { sha: followUp, turnId: 't_0' },
      { sha: bump, turnId: 't_0' },
    ],
    promptShadows: [{ promptIndex: 0, shadowSha: baseline }],
    prePromptSha: null,
  };
  return { feature, followUp, squash, bump, state };
}

describe('a turn split between a forge squash and a commit on HEAD', () => {
  it('counts the squashed branch AND the bump — not just the bump', () => {
    const { bump, state } = subAgentBranchSquashedThenBump({ keepBranch: true });
    const r = row();
    const log: Array<[string, Record<string, unknown>]> = [];
    expect(preferCommitPatchForCommittedTurns(state, [r], repo, stopDeps({ ...state, repoPath: repo }, (e, d) => log.push([e, d])))).toBe(1);
    // memory.ts +1, tools.ts +3 (created, then grown), version.txt +1/-1.
    expect([r.linesAdded, r.linesRemoved]).toEqual([5, 1]);
    expect([...r.filesChanged].sort()).toEqual(['memory.ts', 'tools.ts', 'version.txt']);
    expect(pathsInDiff(r.diff).sort()).toEqual(['memory.ts', 'tools.ts', 'version.txt']);
    // The newest commit of the turn stays the row's stamp.
    expect(r.commitSha).toBe(bump);
    expect(log.map(([e]) => e)).toContain('turn commits on HEAD plus a branch the forge squashed in — sending each chain\'s own patch');
  });

  it('does the same after the branch is deleted', () => {
    const { state } = subAgentBranchSquashedThenBump({ keepBranch: false });
    const r = row();
    expect(preferCommitPatchForCommittedTurns(state, [r], repo, stopDeps({ ...state, repoPath: repo }))).toBe(1);
    expect([r.linesAdded, r.linesRemoved]).toEqual([5, 1]);
  });

  it('never bills the squash itself, nor another session\'s commit in the range', () => {
    const { state } = subAgentBranchSquashedThenBump({ keepBranch: true });
    const r = row();
    preferCommitPatchForCommittedTurns(state, [r], repo, stopDeps({ ...state, repoPath: repo }));
    expect(r.filesChanged).not.toContain('other.ts');
    // tools.ts once: one section, not the chain's and the squash's.
    expect(r.diff.match(/^diff --git a\/tools\.ts/gm)?.length).toBe(1);
  });

  // The line this must not cross: a commit reset away and REDONE on HEAD also
  // reads `carried` — its content is in HEAD — but what put it there is the
  // turn's own redo, not a forge squash. Both counted would bill it twice.
  it('does not count a reset-and-redone commit twice', () => {
    const baseMain = git('rev-parse', 'HEAD');
    const baseline = createShadowCommit(repo, 'turn0') || baseMain;
    git('checkout', '-qb', 'try');
    write('memory.ts', 'export const a = 1;\nredo me\n');
    const first = commitAll('first try');
    git('checkout', '-q', 'main');
    write('memory.ts', 'export const a = 1;\nredo me\n');
    const redo = commitAll('second try');
    write('version.txt', '1.0.1\n');
    const bump = commitAll('bump');
    const state = {
      promptTurnIds: ['t_0'],
      commitTurns: [{ sha: first, turnId: 't_0' }, { sha: redo, turnId: 't_0' }, { sha: bump, turnId: 't_0' }],
      promptShadows: [{ promptIndex: 0, shadowSha: baseline }],
      prePromptSha: null,
    };
    const r = row();
    const log: Array<[string, Record<string, unknown>]> = [];
    preferCommitPatchForCommittedTurns(state, [r], repo, stopDeps({ ...state, repoPath: repo }, (e, d) => log.push([e, d])));
    expect(log.map(([e]) => e)).not.toContain('turn commits on HEAD plus a branch the forge squashed in — sending each chain\'s own patch');
    // memory.ts once (+1), version.txt (+1/-1).
    expect([r.linesAdded, r.linesRemoved]).toEqual([2, 1]);
  });
});
