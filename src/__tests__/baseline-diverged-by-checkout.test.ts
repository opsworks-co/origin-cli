// A `git checkout` mid-turn must not make the branch delta the turn's work.
//
// Reported on session a6ad8379. Turn 6 read three files and merged a PR — it
// authored nothing — and was credited +229/-9 across 3 files, byte-for-byte
// another agent's commit that a `git checkout` had pulled into the tree. Turn 5
// showed -443 against commits totalling -22.
//
// `origin verify-capture` reported ZERO contradictions for that session, which
// is the point: the row's counts agree with its own diff. The diff is what is
// wrong, and no self-consistency check can see that. Only a test that moves
// HEAD the way the agent did will.
//
// Real git throughout: the defect lives in what `merge-base --is-ancestor` and
// `git diff <commit>` do to a baseline on another branch, which a mock cannot
// reproduce.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { captureGitState, createShadowCommit, SHADOW_IDENTITY_EMAIL } from '../git-capture.js';

let repo: string;

const git = (args: string[], cwd = repo) =>
  execFileSync('git', args, { cwd, encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();

const write = (rel: string, body: string) => {
  const abs = path.join(repo, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, body);
};

beforeEach(() => {
  repo = fs.mkdtempSync(path.join(os.tmpdir(), 'origin-diverge-'));
  git(['init', '--quiet', '-b', 'main']);
  // A fixture identity, never the machine's — a repo test that inherits the
  // real gitconfig behaves differently on every box.
  git(['config', 'user.name', 'Test']);
  git(['config', 'user.email', 'test@example.com']);
  git(['config', 'commit.gpgsign', 'false']);
  write('shared.ts', 'export const a = 1;\n');
  git(['add', '-A']);
  git(['commit', '--quiet', '-m', 'base']);
});

afterEach(() => {
  try { fs.rmSync(repo, { recursive: true, force: true }); } catch { /* best effort */ }
});

describe('a baseline left on another branch by `git checkout`', () => {
  /**
   * The real topology from session a6ad8379, which is what makes the baseline
   * DIVERGED rather than merely behind:
   *
   *     C0 ──── theirs      (branch `other`, cut before main advanced)
   *      └───── mine        (main; the turn's baseline is HERE)
   *
   * `other` does not contain the baseline, so the baseline is not an ancestor
   * of HEAD once it is checked out. A branch cut FROM the baseline would still
   * contain it and is a different case, handled by foreign-commit filtering.
   */
  const divergeAndCheckout = () => {
    const forkPoint = git(['rev-parse', 'HEAD']);
    git(['checkout', '--quiet', '-b', 'other', forkPoint]);
    write('theirs.ts', Array.from({ length: 40 }, (_, i) => `export const x${i} = ${i};`).join('\n') + '\n');
    git(['add', '-A']);
    git(['commit', '--quiet', '-m', 'work by someone else']);

    // main advances past the fork point — this is the turn's baseline.
    git(['checkout', '--quiet', 'main']);
    write('mainline.ts', 'export const m = 1;\n');
    git(['add', '-A']);
    git(['commit', '--quiet', '-m', 'mainline moves on']);
    const baseline = git(['rev-parse', 'HEAD']);

    // Mid-turn the agent checks the other branch out — what reviewing a PR
    // locally does.
    git(['checkout', '--quiet', 'other']);
    expect(() => git(['merge-base', '--is-ancestor', baseline, 'HEAD'])).toThrow();
    return baseline;
  };

  it('does not report the other branch\'s work as this turn\'s', () => {
    const baseline = divergeAndCheckout();   // and the turn authors nothing

    const cap = captureGitState(repo, baseline);

    // The 40 lines belong to the other branch's commit, not to this turn.
    expect(cap.workingTreeDiff).not.toContain('theirs.ts');
    // Nor does the baseline's own file come back as a deletion — that is the
    // -443 half of the report.
    expect(cap.workingTreeDiff).not.toContain('mainline.ts');
    expect(cap.workingTreeDiff.trim()).toBe('');
    expect(cap.baselineIsShadow).toBe(false);

    // The fields Stop ACTUALLY reads when the baseline is not a shadow. The
    // first cut of this fix cleaned `workingTreeDiff` only, and the consumer
    // never looks at it in this case — it reads `committedDiff` (which was
    // still `<baseline>..HEAD`, the other branch's commits) plus the combined
    // `diff`. A test on the wrong field was green while the leak stood.
    expect(cap.committedDiff).not.toContain('theirs.ts');
    expect(cap.committedDiff.trim()).toBe('');
    expect(cap.diff).not.toContain('theirs.ts');
    expect(cap.diff).not.toContain('mainline.ts');
  });

  it('still captures edits the turn genuinely made after the checkout', () => {
    // The fix must not become "a checkout blinds the turn".
    const baseline = divergeAndCheckout();
    write('mine.ts', 'export const mine = 1;\n');   // the turn's own work
    write('shared.ts', 'export const a = 2;\n');    // and an edit to an existing file

    const cap = captureGitState(repo, baseline);

    expect(cap.workingTreeDiff).toContain('mine.ts');
    expect(cap.workingTreeDiff).toContain('shared.ts');
    expect(cap.workingTreeDiff).not.toContain('theirs.ts');
    expect(cap.workingTreeDiff).not.toContain('mainline.ts');
  });

  it('leaves a genuine shadow baseline on the tree-to-tree path', () => {
    // A shadow is dangling too, so it is also "not an ancestor of HEAD" — the
    // exact ambiguity the fix resolves. It must keep its old behaviour: the
    // uncommitted work since the shadow IS the turn's work.
    write('dirty.ts', 'export const d = 1;\n');
    const shadow = createShadowCommit(repo, 'test-tag');
    expect(shadow).toBeTruthy();
    expect(git(['log', '-1', '--format=%ae', shadow as string])).toBe(SHADOW_IDENTITY_EMAIL);

    write('after.ts', 'export const after = 1;\n');
    const cap = captureGitState(repo, shadow as string);

    expect(cap.baselineIsShadow).toBe(true);
    expect(cap.workingTreeDiff).toContain('after.ts');
  });

  it('does not trust a shadow whose parent was left on the abandoned branch', () => {
    // This is the prompt-18 topology: a dirty-turn shadow was made on one
    // branch, then the active worktree switched to a branch based elsewhere.
    // The shadow identity alone is not proof its tree is a valid baseline.
    const fork = git(['rev-parse', 'HEAD']);
    git(['checkout', '--quiet', '-b', 'other', fork]);
    write('theirs.ts', 'export const theirs = true;\n');
    git(['add', '-A']);
    git(['commit', '--quiet', '-m', 'other branch work']);
    git(['checkout', '--quiet', 'main']);
    write('mainline.ts', 'export const mainline = true;\n');
    git(['add', '-A']);
    git(['commit', '--quiet', '-m', 'main branch work']);
    write('dirty.ts', 'export const dirty = true;\n');
    const shadow = createShadowCommit(repo, 'old-branch-turn');
    expect(shadow).toBeTruthy();
    git(['reset', '--hard', '--quiet']);
    git(['clean', '-fdq']);
    git(['checkout', '--quiet', 'other']);

    const cap = captureGitState(repo, shadow as string);

    expect(cap.baselineIsShadow).toBe(false);
    expect(cap.diff.trim()).toBe('');
    expect(cap.workingTreeDiff.trim()).toBe('');
    expect(cap.commitDetails).toEqual([]);
  });

  it('is unaffected on the ordinary path where the baseline is an ancestor', () => {
    const baseline = git(['rev-parse', 'HEAD']);
    write('mine.ts', 'export const mine = 1;\n');
    git(['add', '-A']);
    git(['commit', '--quiet', '-m', 'my own commit']);
    write('later.ts', 'export const later = 1;\n');

    const cap = captureGitState(repo, baseline);

    expect(cap.baselineIsShadow).toBe(false);
    // Both the commit made during the turn and the uncommitted edit are the
    // turn's, and the baseline is on HEAD's line, so nothing changes here.
    expect(cap.workingTreeDiff).toContain('mine.ts');
    expect(cap.workingTreeDiff).toContain('later.ts');
  });
});
