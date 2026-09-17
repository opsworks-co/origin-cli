import { expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { captureGitState } from '../git-capture.js';

it('does not attach the absorbed branch patch to a clean merge commit', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'origin-merge-patch-'));
  const git = (...args: string[]) => execFileSync('git', args, { cwd: dir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  try {
    git('init', '-q', '-b', 'main');
    git('config', 'user.name', 'Test');
    git('config', 'user.email', 'test@example.com');
    git('config', 'commit.gpgsign', 'false');
    git('config', 'core.hooksPath', path.join(dir, 'no-hooks'));
    fs.writeFileSync(path.join(dir, 'base.txt'), 'base\n');
    git('add', '.'); git('commit', '-qm', 'base');
    const baseline = git('rev-parse', 'HEAD');
    git('checkout', '-qb', 'other');
    fs.writeFileSync(path.join(dir, 'foreign.txt'), 'foreign one\nforeign two\n');
    git('add', '.'); git('commit', '-qm', 'other');
    git('checkout', '-q', 'main');
    git('merge', '--no-ff', 'other', '-m', 'clean-merge');
    const sha = git('rev-parse', 'HEAD');
    const merge = captureGitState(dir, baseline).commitDetails.find(c => c.sha === sha)!;
    expect(merge.filesChanged).toEqual([]);
    expect([merge.linesAdded, merge.linesRemoved]).toEqual([0, 0]);
    expect(merge.patch || '').toBe('');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
}, 30_000);

it('keeps a conflict resolution without the cleanly absorbed files', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'origin-merge-resolution-'));
  const git = (...args: string[]) => execFileSync('git', args, { cwd: dir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  try {
    git('init', '-q', '-b', 'main');
    git('config', 'user.name', 'Test');
    git('config', 'user.email', 'test@example.com');
    git('config', 'commit.gpgsign', 'false');
    git('config', 'core.hooksPath', path.join(dir, 'no-hooks'));
    fs.writeFileSync(path.join(dir, 'common.txt'), 'base\n');
    git('add', '.'); git('commit', '-qm', 'base');
    git('checkout', '-qb', 'other');
    fs.writeFileSync(path.join(dir, 'common.txt'), 'theirs\n');
    fs.writeFileSync(path.join(dir, 'foreign.txt'), 'absorbed\n');
    git('add', '.'); git('commit', '-qm', 'other');
    git('checkout', '-q', 'main');
    fs.writeFileSync(path.join(dir, 'common.txt'), 'ours\n');
    git('add', '.'); git('commit', '-qm', 'ours');
    const baseline = git('rev-parse', 'HEAD');
    expect(() => git('merge', '--no-ff', 'other')).toThrow();
    fs.writeFileSync(path.join(dir, 'common.txt'), 'resolved\n');
    git('add', '.'); git('commit', '-qm', 'resolve');
    const sha = git('rev-parse', 'HEAD');
    const merge = captureGitState(dir, baseline).commitDetails.find(c => c.sha === sha)!;
    expect(merge.filesChanged).toEqual(['common.txt']);
    expect([merge.linesAdded, merge.linesRemoved]).toEqual([1, 1]);
    expect(merge.patch).toContain('-ours\n+resolved');
    expect(merge.patch).not.toContain('foreign.txt');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
}, 30_000);
