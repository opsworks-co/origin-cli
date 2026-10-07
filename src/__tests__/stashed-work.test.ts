// Work a turn stashed is not work it discarded (TODO d6000064).
//
// `git stash` puts the tree back at HEAD, which the ledger reads the same way
// as `git checkout -- <file>`: the file ends the turn at its starting bytes.
// The stash still holds the work, so the "discarded" pill ("nothing of it is
// in the working tree or in a commit") was wrong over it.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { filesHeldInStashes } from '../stashed-work.js';
import { hashContent } from '../write-journal-store.js';

let repo = '';
const git = (...a: string[]) => execFileSync('git', a, { cwd: repo, encoding: 'utf-8', stdio: 'pipe' }).trim();
const write = (f: string, c: string) => fs.writeFileSync(path.join(repo, f), c);
const hashes = (...c: string[]) => new Set(c.map((x) => hashContent(x)));

beforeEach(() => {
  repo = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'origin-stash-')));
  git('init', '-q', '-b', 'main');
  git('config', 'user.name', 'T'); git('config', 'user.email', 't@x');
  git('config', 'commit.gpgsign', 'false'); git('config', 'core.hooksPath', '/dev/null');
  write('a.ts', 'base\n'); write('b.ts', 'other\n');
  git('add', '.'); git('commit', '-qm', 'base');
});
afterEach(() => fs.rmSync(repo, { recursive: true, force: true }));

describe('filesHeldInStashes', () => {
  it('no stash at all is a definite empty answer', () => {
    expect(filesHeldInStashes(repo, 0, new Map([['a.ts', hashes('x\n')]]))).toEqual(new Set());
  });

  it('finds a file a stash holds at bytes the turn wrote', () => {
    const since = Date.now();
    write('a.ts', 'base\nthe turn\n');
    git('stash');
    expect(fs.readFileSync(path.join(repo, 'a.ts'), 'utf-8')).toBe('base\n');
    expect(filesHeldInStashes(repo, since, new Map([['a.ts', hashes('base\nthe turn\n')]]))).toEqual(new Set(['a.ts']));
  });

  it('a stash holding OTHER bytes does not vouch for the file — the stack is shared across worktrees', () => {
    const since = Date.now();
    write('a.ts', 'base\nsomeone else\n');
    git('stash');
    expect(filesHeldInStashes(repo, since, new Map([['a.ts', hashes('base\nthe turn\n')]]))).toEqual(new Set());
  });

  it('a stash made before the turn began does not count', () => {
    write('a.ts', 'base\nthe turn\n');
    git('stash');
    const later = Date.now() + 60_000;
    expect(filesHeldInStashes(repo, later, new Map([['a.ts', hashes('base\nthe turn\n')]]))).toEqual(new Set());
  });

  it('looks past a newer stash to an older one made in the same turn', () => {
    const since = Date.now();
    write('a.ts', 'base\nthe turn\n');
    git('stash');
    write('b.ts', 'other\nlater\n');
    git('stash');
    expect(filesHeldInStashes(repo, since, new Map([
      ['a.ts', hashes('base\nthe turn\n')],
      ['b.ts', hashes('other\nlater\n')],
    ]))).toEqual(new Set(['a.ts', 'b.ts']));
  });

  it('a directory git cannot read is unknown, not "none"', () => {
    expect(filesHeldInStashes(path.join(repo, 'no-such-dir'), 0, new Map([['a.ts', hashes('x\n')]]))).toBeNull();
  });
});
