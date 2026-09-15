/**
 * A merge is credited with what it RESOLVED, not with every file both branches
 * happened to change. Driven against real git.
 *
 * Session c5487aa9 merged main into #1642 (47ffa773). #1640 and #1642 had each
 * added an import to stop.ts and session-end.ts, and git merged those files on
 * its own; only package.json and its lockfile conflicted. All four differ from
 * both parents, so all four were credited to the merge: the turn read 4 files,
 * +18/-3, for a +3/-3 version-bump resolution.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { mergeOwnDiff } from '../history-backfill.js';

let repo: string;
const git = (...args: string[]) =>
  execFileSync('git', args, { cwd: repo, encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] }).trim();
const write = (f: string, c: string) => fs.writeFileSync(path.join(repo, f), c);
// Twenty lines, so edits at 2 and 17 sit in separate hunks and merge cleanly.
const source = (changes: Record<number, string> = {}) =>
  Array.from({ length: 20 }, (_, i) => changes[i] ?? `line ${i}`).join('\n') + '\n';

function branch(name: string, files: Record<string, string>): void {
  git('checkout', '-q', 'main');
  git('checkout', '-qb', name);
  for (const [f, c] of Object.entries(files)) write(f, c);
  git('add', '-A');
  git('commit', '-qm', name);
}

/** Merge `theirs` into `ours`, let `resolve` finish it, commit. */
function merge(resolve: () => void = () => {}): string {
  git('checkout', '-q', 'ours');
  try { git('merge', '-q', '--no-ff', '--no-commit', 'theirs'); } catch { /* a conflict is the point of some cases */ }
  resolve();
  git('add', '-A');
  git('commit', '-qm', 'merge theirs');
  return git('rev-parse', 'HEAD');
}

beforeEach(() => {
  repo = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'origin-merge-own-')));
  git('init', '-q', '-b', 'main');
  git('config', 'user.email', 'me@example.com');
  git('config', 'user.name', 'Me');
  git('config', 'commit.gpgsign', 'false');
  write('stop.ts', source());
  write('package.json', '{ "version": "1" }\n');
  git('add', '-A');
  git('commit', '-qm', 'base');
});
afterEach(() => { try { fs.rmSync(repo, { recursive: true, force: true }); } catch { /* best effort */ } });

describe('mergeOwnDiff', () => {
  it('credits the conflict it resolved, not the file git merged on its own', () => {
    branch('theirs', { 'stop.ts': source({ 2: 'import theirs' }), 'package.json': '{ "version": "2" }\n' });
    branch('ours', { 'stop.ts': source({ 17: 'import ours' }), 'package.json': '{ "version": "3" }\n' });
    const sha = merge(() => write('package.json', '{ "version": "4" }\n'));

    const own = mergeOwnDiff(repo, sha)!;
    expect(own.filesChanged).toEqual(['package.json']);
    expect(own.diff).toContain('"version": "4"');
    expect(own.diff).not.toContain('import theirs');
  });

  it('credits nothing for a merge git made entirely on its own', () => {
    branch('theirs', { 'stop.ts': source({ 2: 'import theirs' }) });
    branch('ours', { 'stop.ts': source({ 17: 'import ours' }) });
    const sha = merge();

    expect(mergeOwnDiff(repo, sha)).toEqual({ diff: '', filesChanged: [] });
  });

  it('still credits a file the merger changed beyond what git merged', () => {
    branch('theirs', { 'stop.ts': source({ 2: 'import theirs' }) });
    branch('ours', { 'stop.ts': source({ 17: 'import ours' }) });
    const sha = merge(() => write('stop.ts', source({ 2: 'import theirs', 10: 'fixed while merging', 17: 'import ours' })));

    const own = mergeOwnDiff(repo, sha)!;
    expect(own.filesChanged).toEqual(['stop.ts']);
    expect(own.diff).toContain('+fixed while merging');
  });
});
