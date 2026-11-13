// A session that starts before a repo's first commit has no HEAD to record, so
// its baseline is null. captureGitState used to treat null as "start at HEAD",
// the range came out empty, and the agent's first commit was never recorded:
// session 7383ad5a (Codex) showed its root commit 60f4002 as "uncommitted".

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { execFileSync } from 'child_process';
import { captureGitState, UNBORN_START_MAX_COMMITS } from '../git-capture';

const gitIn = (dir: string, args: string[]) =>
  execFileSync('git', args, { cwd: dir, encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] }).toString().trim();

describe('captureGitState — session started on an unborn HEAD', () => {
  let dir: string;
  const commit = (file: string, body: string, msg: string) => {
    fs.writeFileSync(path.join(dir, file), body);
    gitIn(dir, ['add', '-A']);
    gitIn(dir, ['commit', '-q', '-m', msg]);
    return gitIn(dir, ['rev-parse', 'HEAD']);
  };
  beforeEach(() => {
    dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'origin-unborn-')));
    gitIn(dir, ['init', '-q']);
    gitIn(dir, ['config', 'user.email', 't@t.co']);
    gitIn(dir, ['config', 'user.name', 'T']);
    gitIn(dir, ['config', 'commit.gpgsign', 'false']);
  });
  afterEach(() => {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  it('records the first commit, with its files and line counts', () => {
    const root = commit('dup.py', 'a\nb\nc\n', 'first');
    const cap = captureGitState(dir, null);
    expect(cap.commitShas).toEqual([root]);
    expect(cap.commitDetails[0]).toMatchObject({ sha: root, filesChanged: ['dup.py'], linesAdded: 3, linesRemoved: 0 });
  });

  it('lists every commit made since, oldest first', () => {
    const a = commit('a.txt', 'a\n', 'a');
    const b = commit('b.txt', 'b\n', 'b');
    expect(captureGitState(dir, null, { committedOnly: true }).commitShas).toEqual([a, b]);
  });

  it('claims nothing when HEAD has more history than an unborn start could have made', () => {
    for (let i = 0; i <= UNBORN_START_MAX_COMMITS; i++) commit(`f${i}.txt`, `${i}\n`, `c${i}`);
    expect(captureGitState(dir, null, { committedOnly: true }).commitShas).toEqual([]);
  });

  it('leaves a recorded baseline alone', () => {
    const base = commit('a.txt', 'a\n', 'a');
    const next = commit('b.txt', 'b\n', 'b');
    expect(captureGitState(dir, base, { committedOnly: true }).commitShas).toEqual([next]);
    expect(captureGitState(dir, next, { committedOnly: true }).commitShas).toEqual([]);
  });
});
