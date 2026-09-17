/**
 * A turn's commit stays on its row after the branch it was made on is gone.
 *
 * Session 674d384a turn 1 (2026-09-17): `git checkout -B pr-1701 origin/<pr>`,
 * one commit (+11/-3, two files, Origin-Session trailer), push, `git checkout
 * <original branch>`, `git branch -D pr-1701` — then Stop. Post-commit had
 * sent the right row. Stop found nothing of the turn reachable from HEAD, no
 * LOCAL branch holding the commit, a clean tree, and sent {f:0, a:0, r:0,
 * c:null} over it. The header's +11/-3 against a +0/-0 turn then failed the
 * release gate (header_exceeds_turns, header_file_unclaimed_by_turns).
 *
 * The attestation in `commitTurns` is post-commit's, trailer-disambiguated,
 * and `git show <sha>` works whether or not any ref reaches the object. What
 * has to be told apart is the one shape that also sits on no branch and must
 * NOT be sent: an amended-away original, whose replacement is another commit
 * of the same turn with the same parents.
 *
 * Driven against real git: the rule turns on refs, ancestry and parents.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { preferCommitPatchForCommittedTurns, pathsInDiff } from '../commit-patch-for-committed-turn.js';
import { createShadowCommit } from '../git-capture.js';

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
const sectionsFor = (diff: string, file: string) =>
  (diff.match(new RegExp(`^diff --git a/${file.replace('.', '\\.')} b/`, 'gm')) || []).length;
/** The row Stop rebuilt for a turn whose tree equals its pre-prompt tree. */
const emptyRow = () => ({ promptIndex: 0, filesChanged: [] as string[], diff: '', uncommittedDiff: '', linesAdded: 0, linesRemoved: 0, commitSha: null as string | null });

beforeEach(() => {
  repo = fs.mkdtempSync(path.join(os.tmpdir(), 'origin-deleted-branch-'));
  git('init', '-q', '-b', 'main');
  git('config', 'user.email', 't@t.t'); git('config', 'user.name', 'T');
  git('config', 'commit.gpgsign', 'false');
  write('a.ts', 'a1\n'); write('b.ts', 'b1\n'); write('c.ts', 'c1\n');
  commitAll('base');
});
afterEach(() => { try { fs.rmSync(repo, { recursive: true, force: true }); } catch {} });

/** The 674d384a shape: a PR branch cut from a foreign tip, one commit on it,
 *  back to the original branch, PR branch deleted. Leaves HEAD on `work`. */
function commitOnBranchThenDeleteIt() {
  git('checkout', '-qb', 'work');
  write('c.ts', 'c1\nwork in progress\n');
  const workTip = commitAll('earlier turn');
  const baseline = createShadowCommit(repo, 'turn0') || workTip;
  // The PR's own tip, as `origin/<pr>` would be: not on our line of history.
  git('checkout', '-qb', 'pr-tip', 'main');
  write('a.ts', 'a1\npr author\n');
  const prTip = commitAll('the PR as its author left it');
  git('checkout', '-qB', 'pr-1701', 'pr-tip');
  write('a.ts', 'a1\npr author\nreview fix\n'); write('b.ts', 'b1\nreview fix\n');
  const fix = commitAll('fix(review): the majority rule matches paths');
  git('checkout', '-q', 'work');
  git('branch', '-qD', 'pr-1701', 'pr-tip');
  const state = {
    promptTurnIds: ['t_0'],
    commitTurns: [{ sha: fix, turnId: 't_0' }],
    promptShadows: [{ promptIndex: 0, shadowSha: baseline }],
    prePromptSha: null,
  };
  return { workTip, baseline, prTip, fix, state };
}

describe('a commit whose branch was deleted before Stop', () => {
  it('is not reachable, not on any branch, and its object still exists', () => {
    const { fix } = commitOnBranchThenDeleteIt();
    expect(() => git('merge-base', '--is-ancestor', fix, 'HEAD')).toThrow();
    expect(git('for-each-ref', '--contains', fix, '--format=%(refname)')).toBe('');
    expect(git('cat-file', '-t', fix)).toBe('commit');
  });

  it('stays on the turn with its patch, from its own parent', () => {
    const { prTip, fix, state } = commitOnBranchThenDeleteIt();
    const row = emptyRow();
    const log: Array<[string, Record<string, unknown>]> = [];
    expect(preferCommitPatchForCommittedTurns(state, [row], repo, { log: (e, d) => log.push([e, d]) })).toBe(1);
    // +1 on a.ts, +1 on b.ts: the commit, not the range from the shadow (which
    // would also bill the turn for the PR author's line).
    expect([row.linesAdded, row.linesRemoved]).toEqual([2, 0]);
    expect([...row.filesChanged].sort()).toEqual(['a.ts', 'b.ts']);
    expect(pathsInDiff(row.diff).sort()).toEqual(['a.ts', 'b.ts']);
    expect(row.diff).toContain('+review fix');
    expect(row.diff).not.toContain('+pr author');
    expect(row.commitSha).toBe(fix);
    expect((row as { commitPatch?: boolean }).commitPatch).toBe(true);
    expect(row.uncommittedDiff).toBe('');
    const numstat = execFileSync('git', ['apply', '--numstat'], { cwd: repo, encoding: 'utf8', input: row.diff });
    expect(numstat).toContain('1\t0\ta.ts');
    expect(numstat).toContain('1\t0\tb.ts');
    expect(log.find(([e]) => e === 'ledger diff replaced by the commit patches of several branches')?.[1])
      .toMatchObject({ branches: 1, stranded: 1, commits: [fix.slice(0, 8)] });
    expect(log.map(([e]) => e)).not.toContain('commit patch declined: no commit of the turn, nor a rewrite of one, is reachable from HEAD');
    expect(git('rev-parse', `${fix}^1`)).toBe(prTip);
  });

  it('tells the resolver it applied, not that it declined', () => {
    const { state } = commitOnBranchThenDeleteIt();
    const row = emptyRow();
    const seen: Array<{ outcome: string }> = [];
    preferCommitPatchForCommittedTurns(state, [row], repo, { observe: (_i, o) => seen.push(o as { outcome: string }) });
    expect(seen).toMatchObject([{ source: 'commit-patch', outcome: 'applied', added: 2, removed: 0 }]);
  });

  it('a remote-tracking branch holding the commit is enough on its own', () => {
    const { fix, state } = commitOnBranchThenDeleteIt();
    // The push landed; the local branch is gone. No sibling rule needed.
    git('update-ref', 'refs/remotes/origin/fix/overlap-evidence-majority', fix);
    const row = emptyRow();
    expect(preferCommitPatchForCommittedTurns(state, [row], repo)).toBe(1);
    expect([row.linesAdded, row.linesRemoved]).toEqual([2, 0]);
  });

  it('is sent beside the turn\'s commit that HEAD does reach', () => {
    const { fix, state } = commitOnBranchThenDeleteIt();
    // Back on `work`, the same turn commits again — this one HEAD holds.
    write('c.ts', 'c1\nwork in progress\nand more\n');
    const onHead = commitAll('more work');
    state.commitTurns.push({ sha: onHead, turnId: 't_0' });
    const row = emptyRow();
    expect(preferCommitPatchForCommittedTurns(state, [row], repo)).toBe(1);
    expect([row.linesAdded, row.linesRemoved]).toEqual([3, 0]);
    expect([...row.filesChanged].sort()).toEqual(['a.ts', 'b.ts', 'c.ts']);
    expect(sectionsFor(row.diff, 'c.ts')).toBe(1);
    expect([fix, onHead]).toContain(row.commitSha);
  });

  it('an amended-away original that HEAD replaced is still not a branch', () => {
    const { state } = commitOnBranchThenDeleteIt();
    git('checkout', '-q', 'main');
    const baseline = createShadowCommit(repo, 'turn1') || git('rev-parse', 'HEAD');
    git('checkout', '-qb', 'amended');
    write('c.ts', 'c1\nfirst try\n');
    const original = commitAll('fix: c');
    write('c.ts', 'c1\nfirst try\nsecond try\n');
    git('add', '-A');
    git('commit', '--amend', '--no-edit', '-q');
    const replacement = git('rev-parse', 'HEAD');
    // Post-commit attested both; post-rewrite never mapped them.
    const amendState = {
      promptTurnIds: ['t_1'],
      commitTurns: [{ sha: original, turnId: 't_1' }, { sha: replacement, turnId: 't_1' }],
      promptShadows: [{ promptIndex: 0, shadowSha: baseline }],
      prePromptSha: null,
    };
    const row = emptyRow();
    const log: string[] = [];
    expect(preferCommitPatchForCommittedTurns(amendState, [row], repo, { log: (e) => log.push(e) })).toBe(1);
    expect([row.linesAdded, row.linesRemoved]).toEqual([2, 0]);
    expect(sectionsFor(row.diff, 'c.ts')).toBe(1);
    expect(row.commitSha).toBe(replacement);
    expect(log).toContain('ledger diff replaced by the commit patch');
    expect(log).not.toContain('ledger diff replaced by the commit patches of several branches');
    void state;
  });

  it('an amend pair on a deleted branch counts once, as its replacement', () => {
    git('checkout', '-qb', 'work');
    const baseline = createShadowCommit(repo, 'turn0') || git('rev-parse', 'HEAD');
    git('checkout', '-qb', 'pr-x');
    write('c.ts', 'c1\nfirst try\n');
    const original = commitAll('fix: c', { GIT_COMMITTER_DATE: '2026-09-17T16:20:00Z' });
    write('c.ts', 'c1\nfirst try\nsecond try\n');
    git('add', '-A');
    execFileSync('git', ['commit', '--amend', '--no-edit', '-q'], {
      cwd: repo, stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env, GIT_COMMITTER_DATE: '2026-09-17T16:21:00Z' },
    });
    const replacement = git('rev-parse', 'HEAD');
    git('checkout', '-q', 'work');
    git('branch', '-qD', 'pr-x');
    const state = {
      promptTurnIds: ['t_0'],
      commitTurns: [{ sha: original, turnId: 't_0' }, { sha: replacement, turnId: 't_0' }],
      promptShadows: [{ promptIndex: 0, shadowSha: baseline }],
      prePromptSha: null,
    };
    const row = emptyRow();
    const log: Array<[string, Record<string, unknown>]> = [];
    expect(preferCommitPatchForCommittedTurns(state, [row], repo, { log: (e, d) => log.push([e, d]) })).toBe(1);
    expect([row.linesAdded, row.linesRemoved]).toEqual([2, 0]);
    expect(sectionsFor(row.diff, 'c.ts')).toBe(1);
    expect(row.commitSha).toBe(replacement);
    expect(log.find(([e]) => e === 'ledger diff replaced by the commit patches of several branches')?.[1])
      .toMatchObject({ branches: 1, stranded: 1, commits: [replacement.slice(0, 8)] });
  });

  it('a dirty file of the turn still keeps the ledger', () => {
    const { state } = commitOnBranchThenDeleteIt();
    write('b.ts', 'b1\nstill typing\n');
    const row = { ...emptyRow(), filesChanged: ['b.ts'] };
    const before = { ...row };
    const log: string[] = [];
    expect(preferCommitPatchForCommittedTurns(state, [row], repo, { log: (e) => log.push(e) })).toBe(0);
    expect(row).toEqual(before);
    expect(log).toContain('commit patch declined: a file of the turn is dirty against its commit');
  });
});
