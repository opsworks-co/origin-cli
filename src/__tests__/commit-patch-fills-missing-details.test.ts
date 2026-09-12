/**
 * A Commit row that landed files-only (post-commit PATCH lost) must still
 * receive `git show` of the attested sha — as a REAL row: subject, author,
 * date, files and numstat, not `0/0` and ''. The server keeps a finite line
 * count as the truth and never re-counts a row that has a patch, so a
 * rescued row sent with 0/0 read "+0/−0" forever (PR #1511 review).
 *
 * Driven against a throwaway repo: CI checks the PR out at depth 1, where
 * HEAD's `git show` is the entire tree (over the size cap) and a shallow
 * boundary commit has no numstat — this repo's HEAD proves nothing there.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execFileSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { commitMetaForSha, fillMissingCommitPatches, patchForCommitSha, sameSha } from '../git-capture.js';
import type { CommitDetailWire } from '../git-capture.js';

const ENV = { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null' };
let repo = '';
let plain = '';   // an ordinary commit: edits app.py, adds notes.md
let merge = '';   // a merge commit
const git = (...args: string[]) =>
  execFileSync('git', args, { cwd: repo, env: ENV, encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] }).toString().trim();

beforeAll(() => {
  repo = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'origin-commit-patch-')));
  git('init', '-q', '-b', 'main');
  git('config', 'user.name', 'Rescue Test'); git('config', 'user.email', 'rescue@example.com');
  git('config', 'commit.gpgsign', 'false');
  fs.writeFileSync(path.join(repo, 'app.py'), 'def main():\n    print("old")\n\n\nmain()\n');
  git('add', '-A'); git('commit', '-q', '-m', 'base');
  // The commit under test. app.py's last hunk ends on a blank context line so
  // a `.trim()` on the patch would eat it.
  fs.writeFileSync(path.join(repo, 'app.py'), 'def main():\n    print("new")\n\n\nmain()\n');
  fs.writeFileSync(path.join(repo, 'notes.md'), 'remember this\n');
  git('add', '-A'); git('commit', '-q', '-m', 'change the greeting and add a note');
  plain = git('rev-parse', 'HEAD');
  // A merge: a side branch touching another file, merged with --no-ff.
  git('checkout', '-q', '-b', 'side');
  fs.writeFileSync(path.join(repo, 'side.txt'), 'side\n');
  git('add', '-A'); git('commit', '-q', '-m', 'side work');
  git('checkout', '-q', 'main');
  git('merge', '-q', '--no-ff', '-m', 'merge side', 'side');
  merge = git('rev-parse', 'HEAD');
});
afterAll(() => { try { fs.rmSync(repo, { recursive: true, force: true }); } catch { /* best effort */ } });

describe('patchForCommitSha', () => {
  it('returns the commit\'s unified diff, stripping trailing newlines only', () => {
    const patch = patchForCommitSha(repo, plain)!;
    expect(patch).toContain('diff --git a/app.py b/app.py');
    expect(patch).toContain('+    print("new")');
    expect(patch).toContain('+remember this');
    expect(patch.endsWith('\n')).toBe(false);
    // Standard context, not the full-file walk.
    expect(patch).not.toContain('--unified=2000');
  });

  it('returns undefined for a missing object', () => {
    expect(patchForCommitSha(repo, 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeef')).toBeUndefined();
    expect(patchForCommitSha(repo, '')).toBeUndefined();
  });

  it('skips a merge commit — post-commit owns those through mergeOwnDiff', () => {
    expect(patchForCommitSha(repo, merge)).toBeUndefined();
  });
});

describe('commitMetaForSha', () => {
  it('reads subject, author, date, files and numstat', () => {
    const meta = commitMetaForSha(repo, plain)!;
    expect(meta.message).toBe('change the greeting and add a note');
    expect(meta.author).toBe('Rescue Test');
    expect(String(meta.committedAt)).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(meta.filesChanged).toEqual(['app.py', 'notes.md']);
    expect(meta.linesAdded).toBe(2);
    expect(meta.linesRemoved).toBe(1);
  });
  it('returns null for a missing object', () => {
    expect(commitMetaForSha(repo, 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeef')).toBeNull();
  });
});

describe('fillMissingCommitPatches', () => {
  it('fills a files-only detail from git show, keeping its own numstat', () => {
    const [filled] = fillMissingCommitPatches(repo, [
      { sha: plain, message: 'x', author: 'T', filesChanged: ['a'], linesAdded: 7, linesRemoved: 2 },
    ]);
    expect(filled.patch).toContain('diff --git');
    expect(filled.linesAdded).toBe(7);
    expect(filled.message).toBe('x');
  });

  it('adds an attested sha the range walk missed as a full row — never 0/0 and blank', () => {
    const filled = fillMissingCommitPatches(repo, [], [plain]);
    expect(filled).toHaveLength(1);
    expect(filled[0]).toMatchObject({
      sha: plain,
      message: 'change the greeting and add a note',
      author: 'Rescue Test',
      filesChanged: ['app.py', 'notes.md'],
      linesAdded: 2,
      linesRemoved: 1,
    });
    expect(filled[0].patch).toContain('+remember this');
  });

  it('does not re-add a sha already in hand, even abbreviated', () => {
    const details: CommitDetailWire[] = [{ sha: plain.slice(0, 10), patch: 'ALREADY' }];
    const filled = fillMissingCommitPatches(repo, details, [plain]);
    expect(filled).toHaveLength(1);
    expect(filled[0].patch).toBe('ALREADY');
  });

  it('gives an extra sha real files and numstat, not a +0 stub', () => {
    const filled = fillMissingCommitPatches(repo, [], [plain]);
    expect(filled[0].filesChanged?.length ?? 0).toBeGreaterThan(0);
    expect((filled[0].linesAdded ?? 0) + (filled[0].linesRemoved ?? 0)).toBeGreaterThan(0);
  });

  it('leaves an existing patch alone', () => {
    const [filled] = fillMissingCommitPatches(repo, [{ sha: plain, patch: 'ALREADY' }]);
    expect(filled.patch).toBe('ALREADY');
  });

  it('drops a sha that yields no patch (missing object, merge)', () => {
    expect(fillMissingCommitPatches(repo, [], ['deadbeefdeadbeefdeadbeefdeadbeefdeadbeef', merge])).toEqual([]);
  });
});

describe('sameSha', () => {
  it('matches a sha with its own abbreviation, case-insensitively, and nothing else', () => {
    expect(sameSha('ABCDEF1234', 'abcdef1')).toBe(true);
    expect(sameSha('abcdef1', 'abcdef1234')).toBe(true);
    expect(sameSha('abcdef1', 'abcdef2')).toBe(false);
    expect(sameSha('', 'abc')).toBe(false);
  });
});
