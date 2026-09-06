/**
 * A rebase must not make the session count its own work twice.
 *
 * `rescueAmendedCommitShas` matched a rewritten commit by SAME PARENT, which
 * is what `git commit --amend` preserves. A rebase moves the branch onto a new
 * base, so every rewritten commit has a different parent, the match found
 * nothing, and the orphan stayed in the list while the rewritten copy was
 * recorded separately.
 *
 * Measured on prod session 92e45049: three rebases onto a moving main turned
 * 4 real commits into 14 rows — four of them sharing one patch-id. The page
 * then rendered a turn reading +46/-14 above "2 commits total +313/-13",
 * because those badges were work already counted under earlier turns.
 *
 * Driven against REAL git. A rebase is exactly the operation whose parent
 * rewriting is the thing under test; a stubbed git would test the stub.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { __testRescueCommitShas } from '../commands/hooks.js';

let repo: string;
const git = (...args: string[]) =>
  execFileSync('git', args, { cwd: repo, encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] }).toString().trim();
const head = () => git('rev-parse', 'HEAD');
const write = (f: string, c: string) => fs.writeFileSync(path.join(repo, f), c);

beforeEach(() => {
  repo = fs.mkdtempSync(path.join(os.tmpdir(), 'origin-rebase-'));
  git('init', '-q', '-b', 'main');
  // A fixture identity — a global gitconfig must not decide whether this passes.
  git('config', 'user.email', 't@t.t'); git('config', 'user.name', 'T');
  git('config', 'commit.gpgsign', 'false');
  write('base.txt', 'base\n'); git('add', '-A'); git('commit', '-qm', 'base');
});
afterEach(() => { try { fs.rmSync(repo, { recursive: true, force: true }); } catch {} });

describe('rebase-rewritten session commits', () => {
  it('collapses the orphan onto its rewrite instead of counting both', () => {
    const baseSha = head();
    git('checkout', '-q', '-b', 'feature');
    write('a.txt', 'mine\n'); git('add', '-A'); git('commit', '-qm', 'feat: my work');
    const original = head();

    // main moves underneath, then we rebase onto it — the real sequence.
    git('checkout', '-q', 'main');
    write('other.txt', 'theirs\n'); git('add', '-A'); git('commit', '-qm', 'someone else');
    git('checkout', '-q', 'feature');
    git('rebase', '-q', 'main');
    const rewritten = head();
    expect(rewritten).not.toBe(original);
    expect(baseSha).toBeTruthy();

    // Both got recorded: post-commit saw the original, the later capture saw
    // the rewrite. This is the bug's exact input.
    const state: any = { sessionCommitShas: [original, rewritten], repoPath: repo, sessionTag: 'test' };
    expect(__testRescueCommitShas(repo, state)).toEqual([rewritten]);
  });

  it('collapses a rebase that also re-bumped a version file (patch-id moves)', () => {
    // This repo re-bumps packages/cli/package.json when resolving the rebase
    // conflict, so the rewrite is NOT patch-identical. Subject + changed-path
    // set is what identifies it.
    git('checkout', '-q', '-b', 'feature');
    write('a.txt', 'mine\n'); write('version.txt', 'v1\n');
    git('add', '-A'); git('commit', '-qm', 'feat: my work');
    const original = head();

    git('checkout', '-q', 'main');
    write('other.txt', 'theirs\n'); git('add', '-A'); git('commit', '-qm', 'someone else');
    git('checkout', '-q', 'feature');
    git('rebase', '-q', 'main');
    // Re-bump, as a conflict resolution would.
    write('version.txt', 'v2\n');
    git('add', '-A'); git('commit', '-q', '--amend', '--no-edit');
    const rewritten = head();

    const state: any = { sessionCommitShas: [original, rewritten], repoPath: repo, sessionTag: 'test' };
    expect(__testRescueCommitShas(repo, state)).toEqual([rewritten]);
  });

  it('does NOT collapse two genuinely different commits', () => {
    // Guard against over-merging: different subjects, different files.
    git('checkout', '-q', '-b', 'feature');
    write('a.txt', 'one\n'); git('add', '-A'); git('commit', '-qm', 'feat: first');
    const first = head();
    write('b.txt', 'two\n'); git('add', '-A'); git('commit', '-qm', 'feat: second');
    const second = head();

    const state: any = { sessionCommitShas: [first, second], repoPath: repo, sessionTag: 'test' };
    expect(__testRescueCommitShas(repo, state)).toEqual([first, second]);
  });

  it('collapses an exact repeat of the same sha', () => {
    git('checkout', '-q', '-b', 'feature');
    write('a.txt', 'one\n'); git('add', '-A'); git('commit', '-qm', 'feat: first');
    const only = head();
    const state: any = { sessionCommitShas: [only, only], repoPath: repo, sessionTag: 'test' };
    expect(__testRescueCommitShas(repo, state)).toEqual([only]);
  });

  it('keeps an orphan that has no rewrite among our commits', () => {
    // A commit we made and then reset away, with nothing replacing it, is not
    // something the rescue may silently drop — losing real work is worse than
    // one stale entry.
    git('checkout', '-q', '-b', 'feature');
    write('a.txt', 'one\n'); git('add', '-A'); git('commit', '-qm', 'feat: first');
    const orphan = head();
    git('reset', '-q', '--hard', 'HEAD~1');
    const state: any = { sessionCommitShas: [orphan], repoPath: repo, sessionTag: 'test' };
    expect(__testRescueCommitShas(repo, state)).toEqual([orphan]);
  });

  it('never maps our orphan onto ANOTHER session\'s commit', () => {
    // The pre-existing amend rescue matched on same-parent alone. After a
    // rebase the commit sitting on the orphan's old parent is the one main
    // moved forward by — someone else's work — so the rescue substituted it
    // and credited this session with a commit it never made. Same-parent is
    // necessary, not sufficient.
    git('checkout', '-q', '-b', 'feature');
    write('a.txt', 'mine\n'); git('add', '-A'); git('commit', '-qm', 'feat: my work');
    const orphan = head();

    git('checkout', '-q', 'main');
    write('other.txt', 'theirs\n'); git('add', '-A'); git('commit', '-qm', 'someone else');
    const foreign = head();
    git('checkout', '-q', 'feature');
    git('rebase', '-q', 'main');

    // The rewrite is deliberately NOT recorded. Since #1369 the rescue searches
    // the BRANCH, so it now finds that rewrite — which is correct. What must
    // never happen is mapping onto `foreign`, the commit that merely inherited
    // the orphan's old parent.
    const rewritten = head();
    const state: any = { sessionCommitShas: [orphan], repoPath: repo, sessionTag: 'test' };
    const out = __testRescueCommitShas(repo, state);
    expect(out).not.toContain(foreign);
    expect(out).toEqual([rewritten]);
  });
});

/**
 * The rewrite a rebase produces was never RECORDED by the session — it only
 * ever recorded the pre-rebase sha. #1360 searched for the replacement among
 * `sessionCommitShas`, so the pool it looked in contained nothing but other
 * orphans and it could never find one.
 *
 * Prod a77105c0: 6 of its 7 recorded commits orphaned by rebases, and the
 * rescue collapsed nothing. Those orphans' patches kept being concatenated into
 * the session diff — five blocks for one version bump, +12/-12 of pure
 * re-count, on a header of +824/-22.
 */
describe('rescue finds a rewrite the session never recorded', () => {
  it('maps the orphan onto the rebased commit sitting on the branch', () => {
    const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'origin-reb2-'));
    const git = (...a: string[]) =>
      execFileSync('git', a, { cwd: repo, encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] }).toString().trim();
    git('init', '-q', '-b', 'main');
    git('config', 'user.email', 't@t.t'); git('config', 'user.name', 'T');
    git('config', 'commit.gpgsign', 'false');
    fs.writeFileSync(path.join(repo, 'base.txt'), 'base\n');
    git('add', '-A'); git('commit', '-qm', 'base');
    const start = git('rev-parse', 'HEAD');

    git('checkout', '-q', '-b', 'feature');
    fs.writeFileSync(path.join(repo, 'a.ts'), 'mine\n');
    git('add', '-A'); git('commit', '-qm', 'feat: my work');
    const preRebase = git('rev-parse', 'HEAD');

    git('checkout', '-q', 'main');
    fs.writeFileSync(path.join(repo, 'other.txt'), 'theirs\n');
    git('add', '-A'); git('commit', '-qm', 'someone else');
    git('checkout', '-q', 'feature');
    git('rebase', '-q', 'main');
    const postRebase = git('rev-parse', 'HEAD');
    expect(postRebase).not.toBe(preRebase);

    // Only the PRE-rebase sha was ever recorded — the situation #1360 missed.
    const state: any = {
      sessionCommitShas: [preRebase], repoPath: repo, sessionTag: 'test',
      headShaAtStart: start,
    };
    expect(__testRescueCommitShas(repo, state)).toEqual([postRebase]);
  });

  it('does not map two orphans onto the same rewrite', () => {
    // After a rebase the mapping is 1:1. Collapsing two orphans onto one commit
    // would silently delete a real one.
    const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'origin-reb3-'));
    const git = (...a: string[]) =>
      execFileSync('git', a, { cwd: repo, encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] }).toString().trim();
    git('init', '-q', '-b', 'main');
    git('config', 'user.email', 't@t.t'); git('config', 'user.name', 'T');
    git('config', 'commit.gpgsign', 'false');
    fs.writeFileSync(path.join(repo, 'base.txt'), 'base\n');
    git('add', '-A'); git('commit', '-qm', 'base');
    const start = git('rev-parse', 'HEAD');

    git('checkout', '-q', '-b', 'feature');
    fs.writeFileSync(path.join(repo, 'a.ts'), 'one\n');
    git('add', '-A'); git('commit', '-qm', 'feat: A');
    const orphanA = git('rev-parse', 'HEAD');
    fs.writeFileSync(path.join(repo, 'b.ts'), 'two\n');
    git('add', '-A'); git('commit', '-qm', 'feat: B');
    const orphanB = git('rev-parse', 'HEAD');

    git('checkout', '-q', 'main');
    fs.writeFileSync(path.join(repo, 'other.txt'), 'theirs\n');
    git('add', '-A'); git('commit', '-qm', 'someone else');
    git('checkout', '-q', 'feature');
    git('rebase', '-q', 'main');

    const state: any = {
      sessionCommitShas: [orphanA, orphanB], repoPath: repo, sessionTag: 'test',
      headShaAtStart: start,
    };
    const out = __testRescueCommitShas(repo, state);
    expect(out).toHaveLength(2);
    expect(new Set(out).size).toBe(2);
    // Both resolved to real, reachable commits.
    for (const sha of out) {
      expect(() => execFileSync('git', ['merge-base', '--is-ancestor', sha, 'HEAD'],
        { cwd: repo, stdio: ['pipe', 'pipe', 'pipe'] })).not.toThrow();
    }
  });

  it('leaves an orphan alone when the branch holds no rewrite of it', () => {
    // Reset-away work with no replacement anywhere must not be dropped, and
    // must not be mapped onto an unrelated commit.
    const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'origin-reb4-'));
    const git = (...a: string[]) =>
      execFileSync('git', a, { cwd: repo, encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] }).toString().trim();
    git('init', '-q', '-b', 'main');
    git('config', 'user.email', 't@t.t'); git('config', 'user.name', 'T');
    git('config', 'commit.gpgsign', 'false');
    fs.writeFileSync(path.join(repo, 'base.txt'), 'base\n');
    git('add', '-A'); git('commit', '-qm', 'base');
    const start = git('rev-parse', 'HEAD');
    fs.writeFileSync(path.join(repo, 'gone.ts'), 'x\n');
    git('add', '-A'); git('commit', '-qm', 'feat: discarded');
    const orphan = git('rev-parse', 'HEAD');
    git('reset', '-q', '--hard', start);

    const state: any = {
      sessionCommitShas: [orphan], repoPath: repo, sessionTag: 'test', headShaAtStart: start,
    };
    expect(__testRescueCommitShas(repo, state)).toEqual([orphan]);
  });
});

// A squash by `git reset --soft HEAD~N` + one commit fires no hook and matches
// neither rung of the rescue — the new commit is the UNION of the orphans.
// Prod vodka 944f7048: two commits, reset, one commit; the page counted four
// commits for two and the turn chip summed the orphans on top of the squash.
describe('reset-and-recommit squash', () => {
  it('collapses the whole orphan run onto the single commit that replaced it', () => {
    write('a.txt', 'one\n'); git('add', '-A'); git('commit', '-qm', 'first');
    const first = head();
    write('b.txt', 'two\n'); git('add', '-A'); git('commit', '-qm', 'second');
    const second = head();
    git('reset', '-q', '--soft', 'HEAD~2');
    git('commit', '-qm', 'first and second, squashed');
    const squash = head();
    expect(squash).not.toBe(first);
    expect(squash).not.toBe(second);

    const state: any = { sessionCommitShas: [first, second, squash], repoPath: repo, sessionTag: 'test' };
    expect(__testRescueCommitShas(repo, state)).toEqual([squash]);
    expect(state.rewrittenCommits.map((r: any) => [r.from, r.to])).toEqual([[first, squash], [second, squash]]);
  });

  it('does not collapse an orphan onto a commit that ends in a different tree', () => {
    write('a.txt', 'one\n'); git('add', '-A'); git('commit', '-qm', 'first');
    const first = head();
    git('reset', '-q', '--soft', 'HEAD~1');
    write('a.txt', 'one, revised\n'); git('add', '-A'); git('commit', '-qm', 'first, revised');
    const revised = head();
    // Same parent, different tree: the amend rung may still match by subject +
    // files (it does not here — the subject changed), and the squash rung must
    // not claim it, because the orphan's content was not carried over intact.
    const state: any = { sessionCommitShas: [first, revised], repoPath: repo, sessionTag: 'test' };
    const out = __testRescueCommitShas(repo, state);
    expect(out).toContain(revised);
  });
});
