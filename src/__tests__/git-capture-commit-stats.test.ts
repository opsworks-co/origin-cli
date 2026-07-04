// Per-commit line stats regression.
//
// Symptom: a Commit row's additions/deletions were always NULL for local repos
// and RUNNING sessions, so commit pages showed no line stats and the session's
// "AI authored" metric had nothing to aggregate (rendered "—"). Cause: the CLI
// never computed per-commit line counts — only the API's on-demand GitHub/GitLab
// backfill did, which never runs for local/running sessions. git-capture now
// computes them via --numstat and ships them in CommitInfo.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { execFileSync } from 'child_process';
import { captureGitState } from '../git-capture';

const gitIn = (dir: string, args: string[]) =>
  execFileSync('git', args, { cwd: dir, encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] }).toString();

describe('captureGitState — per-commit line stats', () => {
  let dir: string;
  beforeEach(() => {
    dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'origin-gc-')));
    gitIn(dir, ['init', '-q']);
    gitIn(dir, ['config', 'user.email', 't@t.co']);
    gitIn(dir, ['config', 'user.name', 'T']);
    gitIn(dir, ['config', 'commit.gpgsign', 'false']);
    fs.writeFileSync(path.join(dir, 'seed.txt'), 'seed\n');
    gitIn(dir, ['add', '-A']);
    gitIn(dir, ['commit', '-q', '-m', 'seed']);
  });
  afterEach(() => {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  it('populates linesAdded/linesRemoved on each commitDetails entry', () => {
    const headBefore = gitIn(dir, ['rev-parse', 'HEAD']).trim();
    fs.writeFileSync(path.join(dir, 'a.txt'), 'l1\nl2\n');        // new file: +2
    fs.writeFileSync(path.join(dir, 'seed.txt'), 'changed\n');    // modify: +1 / -1
    gitIn(dir, ['add', '-A']);
    gitIn(dir, ['commit', '-q', '-m', 'work']);

    const res = captureGitState(dir, headBefore);
    expect(res.commitDetails.length).toBe(1);
    const c = res.commitDetails[0];
    expect(c.linesAdded).toBe(3);
    expect(c.linesRemoved).toBe(1);
    expect(c.filesChanged.sort()).toEqual(['a.txt', 'seed.txt']);
  }, 30_000);

  it('sums line counts across multiple commits', () => {
    const headBefore = gitIn(dir, ['rev-parse', 'HEAD']).trim();
    fs.writeFileSync(path.join(dir, 'a.txt'), 'x\n');             // +1
    gitIn(dir, ['add', '-A']);
    gitIn(dir, ['commit', '-q', '-m', 'c1']);
    fs.writeFileSync(path.join(dir, 'b.txt'), 'y\nz\n');          // +2
    gitIn(dir, ['add', '-A']);
    gitIn(dir, ['commit', '-q', '-m', 'c2']);

    const res = captureGitState(dir, headBefore);
    expect(res.commitDetails.length).toBe(2);
    const total = res.commitDetails.reduce((s, c) => s + c.linesAdded, 0);
    expect(total).toBe(3);
    for (const c of res.commitDetails) {
      expect(typeof c.linesAdded).toBe('number');
      expect(typeof c.linesRemoved).toBe('number');
    }
  }, 30_000);
});
