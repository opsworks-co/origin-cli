/**
 * A turn that checks out a new branch and restores already-captured work
 * did not write that work again.
 *
 * Session 06a44883 prompt 3 is the case. Prompt 2 wrote the patch (uncommitted).
 * Prompt 3 was "commit if not yet and open PR": stash, `git checkout -b` from
 * a newer main, restore the stash, version-bump, commit. Capture stored
 * prompt 2's whole patch as prompt 3's uncommitted +370/−23.
 *
 * The per-prompt shadow already held those files. After the checkout,
 * `git log shadow..HEAD` listed main's intervening commits, so the old
 * `commitShas.length === 0` gate refused to rewrite `uncommittedDiff`, and
 * `git diff HEAD` of the restored tree became the turn.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { captureGitState, createShadowCommit } from '../git-capture.js';

let repo: string;

const git = (args: string[], cwd = repo) =>
  execFileSync('git', args, { cwd, encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();

const write = (rel: string, body: string) => {
  const abs = path.join(repo, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, body);
};

beforeEach(() => {
  repo = fs.mkdtempSync(path.join(os.tmpdir(), 'origin-reclaim-'));
  git(['init', '--quiet', '-b', 'main']);
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

describe('a checkout must not reclaim an earlier turn\'s uncommitted work', () => {
  const earlierTurnLeavesWorkThenChecksOut = () => {
    // Prompt 2: write files, do not commit. Shadow is the turn-3 baseline.
    write('wip.ts', 'the previous turn\n');
    write('shared.ts', 'export const a = 1;\nexport const prev = 2;\n');
    const shadow = createShadowCommit(repo, 'prompt-2-end');
    expect(shadow).toBeTruthy();

    git(['stash', 'push', '-u', '-q', '-m', 'prompt-2']);
    write('later.ts', 'main moved on\n');
    git(['add', '-A']);
    git(['commit', '--quiet', '-m', 'mainline moves']);
    git(['checkout', '--quiet', '-b', 'feature']);
    git(['stash', 'pop', '-q']);
    return shadow as string;
  };

  it('does not store the restored stash as this turn\'s uncommitted diff', () => {
    const shadow = earlierTurnLeavesWorkThenChecksOut();
    const cap = captureGitState(repo, shadow, { fullContext: true });

    // after-file-edit stores `uncommittedDiff` (Cursor has no Stop). The
    // combined `diff` field can still mention checked-out commits; that is
    // a different producer.
    expect(cap.uncommittedDiff).not.toContain('wip.ts');
    expect(cap.uncommittedDiff).not.toContain('prev = 2');
    expect(cap.uncommittedDiff).not.toContain('later.ts');
    expect(cap.uncommittedDiff.trim()).toBe('');
  });

  it('still captures an edit this turn made after the restore', () => {
    const shadow = earlierTurnLeavesWorkThenChecksOut();
    write('mine.ts', 'export const mine = 1;\n');
    write('shared.ts', 'export const a = 1;\nexport const prev = 2;\nexport const mine = 3;\n');

    const cap = captureGitState(repo, shadow, { fullContext: true });

    expect(cap.uncommittedDiff).toContain('mine.ts');
    expect(cap.uncommittedDiff).toContain('mine = 3');
    expect(cap.uncommittedDiff).not.toContain('wip.ts');
    expect(cap.uncommittedDiff).not.toContain('later.ts');
  });
});
