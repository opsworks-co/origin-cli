// captureGitState's opt-in narrowing (TODO 1cd8f80e): Stop's two session-level
// calls built a whole-range diff and eight-process details for every commit in
// session-start..HEAD and read a fraction of it — 12 s and 10 s of an 84 s Stop.
// Each option must drop only the work, never change what the caller reads.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execFileSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { captureGitState } from '../git-capture.js';

let repo = '';
let base = '';
const git = (...a: string[]) => execFileSync('git', a, { cwd: repo, encoding: 'utf-8', stdio: 'pipe' }).trim();
const write = (f: string, t: string) => { fs.mkdirSync(path.dirname(path.join(repo, f)), { recursive: true }); fs.writeFileSync(path.join(repo, f), t); };

beforeAll(() => {
  repo = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'origin-narrow-')));
  git('init', '-q', '-b', 'main'); git('config', 'user.name', 'T'); git('config', 'user.email', 't@x');
  git('config', 'commit.gpgsign', 'false'); git('config', 'core.hooksPath', '/dev/null');
  write('keep.ts', 'a\n'); write('old-name.ts', 'r1\nr2\nr3\nr4\n'); git('add', '-A'); git('commit', '-qm', 'base');
  base = git('rev-parse', 'HEAD');
  write('keep.ts', 'a\nb\n'); git('commit', '-qam', 'edit');
  git('mv', 'old-name.ts', 'new-name.ts'); git('commit', '-qm', 'rename');
  git('checkout', '-qb', 'side'); write('side.ts', 's\n'); git('add', '-A'); git('commit', '-qm', 'side');
  git('checkout', '-q', 'main'); write('keep.ts', 'a\nb\nc\n'); git('commit', '-qam', 'main again');
  git('merge', '-q', '--no-edit', 'side');
  write('dirty.ts', 'x\n');
});
afterAll(() => fs.rmSync(repo, { recursive: true, force: true }));

describe('captureGitState narrowing options', () => {
  it('commitDetailsFor builds details only for the commits it accepts; the range list is untouched', () => {
    const full = captureGitState(repo, base, { fullContext: true });
    const keep = full.commitShas[1];
    const narrow = captureGitState(repo, base, { fullContext: true, commitDetailsFor: (sha) => sha === keep });
    expect(narrow.commitShas).toEqual(full.commitShas);
    expect(narrow.commitDetails).toEqual(full.commitDetails.filter((d) => d.sha === keep));
  });

  it('skipCommittedDiff drops only the range diff; the uncommitted side is the same', () => {
    const full = captureGitState(repo, base, { fullContext: true });
    const skip = captureGitState(repo, base, { fullContext: true, skipCommittedDiff: true });
    expect(full.committedDiff).not.toBe('');
    expect(skip.committedDiff).toBe('');
    expect(skip.uncommittedDiff).toBe(full.uncommittedDiff);
    expect(skip.headAfter).toBe(full.headAfter);
  });

  it("'files' details list the same files per commit as full details — a rename's two paths, a merge's resolution", () => {
    const full = captureGitState(repo, base, { committedOnly: true });
    const files = captureGitState(repo, base, { committedOnly: true, commitDetailsLevel: 'files' });
    expect(files.commitShas).toEqual(full.commitShas);
    expect(files.commitDetails.map((d) => [d.sha, [...d.filesChanged].sort()]))
      .toEqual(full.commitDetails.map((d) => [d.sha, [...d.filesChanged].sort()]));
    const rename = files.commitDetails.find((d) => d.filesChanged.includes('new-name.ts'));
    expect(rename?.filesChanged.sort()).toEqual(['new-name.ts', 'old-name.ts']);
    expect(files.diff).toBe(full.diff);
  });
});
