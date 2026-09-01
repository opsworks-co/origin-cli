/**
 * A turn that only REBASED must not be billed the work it moved.
 *
 * Session b0c86852 turn 3 ran `git fetch`, `git rebase origin/main`, a push and
 * a PR merge. It authored nothing, and its transcript mapping said so — empty,
 * correctly. It rendered as 3 files, +77/-1, carrying commit f9f7557d.
 *
 * The chain, straight out of hooks.log:
 *
 *   23:24:44.297  dropped concurrent session commits {"dropped":["aab018ef"]}
 *   23:24:44.326  dropped empty current-prompt mapping — git shows work
 *                 (shell-edit turn) {"promptIndex":2}
 *   23:24:44.377  synthesized current prompt mapping (safety net)
 *                 {"promptIndex":2,"commitSha":"f9f7557d"}
 *
 * The rebase rewrote turn 1's commit 21bd0037 into f9f7557d. That new sha was
 * born inside turn 3's window, so `baseline..HEAD` reported a diff. The
 * "transcript empty but git shows work" rule reads that as a shell-edit turn,
 * threw away the honest empty mapping, and let the safety net re-derive turn
 * 1's +99/-11 onto turn 3 under the rewritten sha.
 *
 * `commitTurns` is what makes it answerable: it holds the pre-rebase entry
 * (21bd0037, turn 1) next to the rewrite (f9f7557d, turn 3). Git has forgotten
 * the first; we have not.
 *
 * Driven against REAL git, for the reason rebase-duplicate-commits gives: a
 * rebase is the operation under test, and a stubbed git would test the stub.
 * On the real b0c86852 pair the patch-ids DIFFER — rebasing onto a new base
 * moved them — and only subject + changed-path set still match, so a test that
 * faked the rewrite would have missed which branch of `isRewriteOf` carries it.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import {
  __testWindowIsRebaseOfEarlierTurns as rebaseWindow,
  windowIsRebaseOfEarlierTurns,
} from '../commands/hooks.js';

let repo: string;
const git = (...args: string[]) =>
  execFileSync('git', args, { cwd: repo, encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] }).toString().trim();
const head = () => git('rev-parse', 'HEAD');
const write = (f: string, c: string) => fs.writeFileSync(path.join(repo, f), c);

beforeEach(() => {
  repo = fs.mkdtempSync(path.join(os.tmpdir(), 'origin-rebase-bill-'));
  git('init', '-q', '-b', 'main');
  // A fixture identity — a global gitconfig must not decide whether this passes.
  git('config', 'user.email', 't@t.t'); git('config', 'user.name', 'T');
  git('config', 'commit.gpgsign', 'false');
  write('base.txt', 'base\n'); git('add', '-A'); git('commit', '-qm', 'base');
});
afterEach(() => { try { fs.rmSync(repo, { recursive: true, force: true }); } catch {} });

/** The exact b0c86852 sequence: turn 1 commits, main moves, turn 3 rebases. */
function rebaseSequence() {
  git('checkout', '-q', '-b', 'feature');
  write('mine.txt', 'my work\n');
  git('add', '-A'); git('commit', '-qm', 'fix: my work');
  const turn1Sha = head();

  git('checkout', '-q', 'main');
  write('theirs.txt', 'another PR\n');
  git('add', '-A'); git('commit', '-qm', 'fix: someone else');
  git('checkout', '-q', 'feature');
  git('rebase', '-q', 'main');

  return { turn1Sha, rewritten: head() };
}

describe('a turn whose whole window is a rebase', () => {
  it('recognises the rewrite as an earlier turn\'s commit', () => {
    const { turn1Sha, rewritten } = rebaseSequence();
    expect(rewritten).not.toBe(turn1Sha);

    // What state holds at turn 3's Stop: post-commit filed the pre-rebase sha
    // under turn 1 and the rewrite under turn 3.
    const commitTurns = [
      { sha: turn1Sha, turnId: 't_turn1' },
      { sha: rewritten, turnId: 't_turn3' },
    ];

    expect(rebaseWindow(repo, [rewritten], commitTurns, 't_turn3')).toBe(true);
  });

  it('still recognises it when the rebase re-bumps a version file', () => {
    // The real shape. Resolving this repo's version conflict re-writes
    // package.json during the rebase, so the rewrite is NOT patch-id identical
    // to the original — b0c86852's pair hashed 508e7c13 vs 28fef1eb. Subject
    // plus changed-path set is what still holds.
    git('checkout', '-q', '-b', 'feature');
    write('mine.txt', 'my work\n');
    write('version.txt', '1.0.1\n');
    git('add', '-A'); git('commit', '-qm', 'fix: my work');
    const turn1Sha = head();

    git('checkout', '-q', 'main');
    write('version.txt', '1.0.2\n');
    git('add', '-A'); git('commit', '-qm', 'fix: someone else bumped too');
    git('checkout', '-q', 'feature');
    // Conflicts on version.txt; resolve it forward, as a human would.
    try { git('rebase', '-q', 'main'); } catch { /* expected conflict */ }
    write('version.txt', '1.0.3\n');
    git('add', '-A');
    execFileSync('git', ['-c', 'core.editor=true', 'rebase', '--continue'], {
      cwd: repo, stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, GIT_EDITOR: 'true' },
    });
    const rewritten = head();

    const patchIdsDiffer =
      execFileSync('git', ['show', turn1Sha], { cwd: repo, encoding: 'utf-8' }) !==
      execFileSync('git', ['show', rewritten], { cwd: repo, encoding: 'utf-8' });
    expect(patchIdsDiffer).toBe(true); // the content really did move

    expect(rebaseWindow(
      repo, [rewritten],
      [{ sha: turn1Sha, turnId: 't_turn1' }, { sha: rewritten, turnId: 't_turn3' }],
      't_turn3',
    )).toBe(true);
  });

  it('does NOT excuse a window holding genuinely new work', () => {
    const { turn1Sha, rewritten } = rebaseSequence();
    // The turn rebased AND then committed something of its own. All-or-nothing:
    // one unexplained commit means the turn really authored, and its capture
    // must stand.
    write('new.txt', 'authored this turn\n');
    git('add', '-A'); git('commit', '-qm', 'fix: brand new work');
    const newSha = head();

    expect(rebaseWindow(
      repo, [rewritten, newSha],
      [{ sha: turn1Sha, turnId: 't_turn1' }],
      't_turn3',
    )).toBe(false);
  });

  it('does not let a commit explain itself via its own turn', () => {
    const { rewritten } = rebaseSequence();
    // post-commit files the rewrite under the turn the rebase ran in. If
    // same-turn entries counted, that row alone would excuse any commit.
    expect(rebaseWindow(
      repo, [rewritten],
      [{ sha: rewritten, turnId: 't_turn3' }],
      't_turn3',
    )).toBe(false);
  });
});

describe('windowIsRebaseOfEarlierTurns guards', () => {
  const yes = () => true;

  it('an empty window explains nothing', () => {
    // No commits means no rebase to find. Answering true here would silence a
    // turn for a reason that was never established.
    expect(windowIsRebaseOfEarlierTurns(yes, [], [{ sha: 'a', turnId: 't1' }], 't2'))
      .toBe(false);
  });

  it('needs a prior turn to match against', () => {
    expect(windowIsRebaseOfEarlierTurns(yes, ['b'], [], 't2')).toBe(false);
  });

  it('ignores blank shas on both sides', () => {
    expect(windowIsRebaseOfEarlierTurns(yes, ['  '], [{ sha: 'a', turnId: 't1' }], 't2'))
      .toBe(false);
    expect(windowIsRebaseOfEarlierTurns(yes, ['b'], [{ sha: '', turnId: 't1' }], 't2'))
      .toBe(false);
  });

  it('requires EVERY window commit to be explained', () => {
    const onlyB = (_p: string, c: string) => c === 'b';
    expect(windowIsRebaseOfEarlierTurns(onlyB, ['b'], [{ sha: 'a', turnId: 't1' }], 't2'))
      .toBe(true);
    expect(windowIsRebaseOfEarlierTurns(onlyB, ['b', 'c'], [{ sha: 'a', turnId: 't1' }], 't2'))
      .toBe(false);
  });
});
