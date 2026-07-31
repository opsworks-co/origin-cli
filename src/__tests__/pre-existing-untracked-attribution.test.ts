/**
 * filesChangedSinceShadow — "a read-only turn reported +210 lines across 18
 * files it never touched".
 *
 * The heartbeat strips pre-existing working-tree dirt out of a prompt's diff by
 * asking "has this session actually touched this file since it started?". That
 * question was answered with `git diff <sessionStartShadow> --name-only`, which
 * is wrong for UNTRACKED files: the shadow commit snapshots them (staged via
 * `git add -A`), but a plain `git diff <commit>` compares the commit against the
 * INDEX, where an untracked file does not exist. Git therefore reports it as a
 * DELETION, the file looks "touched", it survives the strip set, and the
 * untracked-append then renders it fully-added onto whatever prompt happened to
 * be in flight.
 *
 * Tracked dirt was never affected — it genuinely matches the shadow — which is
 * the signature of the bug: affected turns showed additions but zero deletions.
 *
 * Drives a real temp git repo so the git plumbing is exercised end-to-end.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { createShadowCommit, filesChangedSinceShadow } from '../git-capture.js';

function git(repo: string, args: string[]): string {
  return execFileSync('git', args, { cwd: repo, encoding: 'utf-8', windowsHide: true }).trim();
}

describe('filesChangedSinceShadow', () => {
  let repo: string;
  let shadow: string;

  beforeEach(() => {
    repo = fs.mkdtempSync(path.join(os.tmpdir(), 'origin-untracked-'));
    git(repo, ['init', '-q']);
    git(repo, ['config', 'user.email', 'test@test.dev']);
    git(repo, ['config', 'user.name', 'Test']);
    git(repo, ['config', 'commit.gpgsign', 'false']);

    // Committed baseline.
    fs.writeFileSync(path.join(repo, 'tracked.txt'), 'a\nb\nc\n');
    git(repo, ['add', '.']);
    git(repo, ['commit', '-q', '-m', 'base']);

    // Pre-existing dirt left by an earlier agent/user, BEFORE this session:
    // one tracked modification and two untracked files.
    fs.writeFileSync(path.join(repo, 'tracked.txt'), 'a\nb\nc\nprior edit\n');
    fs.writeFileSync(path.join(repo, 'kartoshka'), 'row 1\nrow 2\nrow 3\n');
    fs.writeFileSync(path.join(repo, 'rows.txt'), 'x\ny\n');

    // Session start snapshots the whole dirty tree.
    shadow = createShadowCommit(repo, 'start-test')!;
    expect(shadow).toBeTruthy();
  });

  // Documents the exact git behaviour the fix exists to avoid. If this ever
  // stops holding, the helper below is no longer load-bearing.
  it('the naive `git diff <shadow> --name-only` form reports untracked dirt as touched', () => {
    const naive = git(repo, ['diff', shadow, '--name-only']).split('\n').filter(Boolean);
    // Phantom deletions: present in the shadow tree, absent from the index.
    expect(naive.sort()).toEqual(['kartoshka', 'rows.txt']);
    // The genuinely-dirty TRACKED file is correctly absent — additions without
    // deletions is what this asymmetry looked like on the dashboard.
    expect(naive).not.toContain('tracked.txt');
  });

  it('reports nothing touched when the session has changed nothing', () => {
    expect(filesChangedSinceShadow(repo, shadow)).toEqual([]);
  });

  it('reports only what actually changed after the shadow', () => {
    fs.appendFileSync(path.join(repo, 'kartoshka'), 'row 4\n');   // edit pre-existing untracked
    fs.writeFileSync(path.join(repo, 'brand-new.txt'), 'hello\n'); // create new untracked
    fs.appendFileSync(path.join(repo, 'tracked.txt'), 'session edit\n');

    expect(filesChangedSinceShadow(repo, shadow).sort())
      .toEqual(['brand-new.txt', 'kartoshka', 'tracked.txt']);
    // rows.txt was dirty at session start and untouched since — must stay out.
    expect(filesChangedSinceShadow(repo, shadow)).not.toContain('rows.txt');
  });

  it('returns [] for a missing or malformed shadow so callers fall back', () => {
    expect(filesChangedSinceShadow(repo, '')).toEqual([]);
    expect(filesChangedSinceShadow(repo, 'not-a-sha')).toEqual([]);
    expect(filesChangedSinceShadow(repo, 'a'.repeat(40))).toEqual([]);
  });
});
