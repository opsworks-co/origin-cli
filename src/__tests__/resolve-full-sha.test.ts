// Agents print a SHORT sha in their commit output (`[branch 73df467]`). The
// server matches a prompt's commitSha against the session's own commit rows, so
// a 7-char value matches nothing: the row looks like it carries some other
// session's commit, becomes eligible for reassignment, and the turn ends up
// reading `uncommitted` beside the commit it just made (session f7e315db).
//
// The session's commit list expands it only when the watcher's walk already saw
// that commit — and it hasn't precisely when this matters, because the watcher
// joined after the commit landed. So ask the repo.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { resolveFullSha } from '../transcript-watch.js';

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf-8', windowsHide: true });
}

describe('resolveFullSha', () => {
  let dir: string;
  let full: string;

  beforeEach(() => {
    dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'origin-sha-')));
    git(dir, 'init', '-q');
    git(dir, 'config', 'user.email', 't@t.co');
    git(dir, 'config', 'user.name', 'T');
    fs.writeFileSync(path.join(dir, 'a.txt'), 'x\n');
    git(dir, 'add', '-A');
    git(dir, 'commit', '-qm', 'one');
    full = git(dir, 'rev-parse', 'HEAD').trim();
  });
  afterEach(() => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ } });

  it('expands the short sha an agent printed to the full one', () => {
    expect(resolveFullSha(dir, full.slice(0, 7))).toBe(full);
  });

  it('accepts a sha that is already full', () => {
    expect(resolveFullSha(dir, full)).toBe(full);
  });

  it('returns null for a prefix this repo does not have — never a guess', () => {
    expect(resolveFullSha(dir, 'deadbee')).toBeNull();
  });

  it('returns null for input that is not a sha at all', () => {
    expect(resolveFullSha(dir, 'HEAD')).toBeNull();
    expect(resolveFullSha(dir, '')).toBeNull();
    expect(resolveFullSha(dir, 'zzzzzzz')).toBeNull();
  });
});
