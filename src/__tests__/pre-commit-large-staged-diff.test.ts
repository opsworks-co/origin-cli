/**
 * The pre-commit secret scan read the staged diff in one `git diff --cached`
 * with a 10 MB buffer and no timeout. A bigger diff threw, the catch returned,
 * and the commit went through with NOTHING scanned — one large staged file
 * (a fixture, a lockfile, a dump) switched the scan off for every other file,
 * including the one holding a key.
 *
 * readStagedDiff falls back to one diff per file when the whole read fails, so
 * only the oversized file goes unscanned — and it is named, not skipped
 * silently.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { parseStagedDiffLines, readStagedDiff } from '../commands/hooks/git-hooks.js';

let repo = '';
const git = (...a: string[]) => execFileSync('git', a, { cwd: repo, encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] }).toString().trim();
const write = (f: string, c: string | Buffer) => fs.writeFileSync(path.join(repo, f), c);
// Assembled at runtime so this file doesn't trip the very scan it tests.
const KEY_LINE = 'aws_access_key_id = ' + ['AKIA', 'IOSFODNN7EXAMPLE'].join('');

beforeEach(() => {
  repo = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'origin-large-staged-')));
  git('init', '-q', '-b', 'main');
  git('config', 'user.email', 't@example.com');
  git('config', 'user.name', 'T');
  write('README.md', 'hi\n');
  git('add', 'README.md');
  git('commit', '-q', '-m', 'base');
});

afterEach(() => {
  fs.rmSync(repo, { recursive: true, force: true });
});

describe('readStagedDiff', () => {
  it('reads a normal commit in one diff with nothing unscanned', () => {
    write('config.env', KEY_LINE + '\n');
    git('add', 'config.env');

    const r = readStagedDiff(repo);
    expect(r.unscanned).toEqual([]);
    expect(r.files).toEqual(['config.env']);
    expect(r.diff).toContain(KEY_LINE);
  });

  it('one oversized file no longer turns the scan off for the rest — it is named instead', () => {
    // 64 KB buffer stands in for the real 10 MB one.
    write('big.txt', 'x'.repeat(100) + '\n'.repeat(1) + ('y'.repeat(99) + '\n').repeat(2000));
    write('a[1].env', KEY_LINE + '\n'); // glob chars: must be taken literally
    write('blob.bin', Buffer.alloc(200_000, 0)); // binary: git prints no bytes
    git('add', 'big.txt', 'a[1].env', 'blob.bin');

    const r = readStagedDiff(repo, { maxBuffer: 64 * 1024 });
    expect(r.unscanned).toEqual([{ file: 'big.txt', reason: expect.stringContaining('larger than') }]);
    expect(r.files.sort()).toEqual(['a[1].env', 'big.txt', 'blob.bin']);

    const added = parseStagedDiffLines(r.diff);
    expect(added).toContainEqual({ file: 'a[1].env', line: 1, content: KEY_LINE });
    expect(r.diff).toContain('Binary files');
  });

  it('nothing staged reads as empty, not as an error', () => {
    expect(readStagedDiff(repo)).toEqual({ diff: '', files: [], unscanned: [] });
  });
});
