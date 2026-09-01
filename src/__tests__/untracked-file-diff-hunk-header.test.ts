/**
 * An untracked file's synthesized diff block needs a real `@@` hunk header.
 *
 * `git diff HEAD` doesn't show untracked files, so the watcher renders them
 * itself as fully-added blocks. Those blocks carried no `@@` line — and the
 * canonical counter (countDiffAddRemove) is hunk-aware on purpose: it ignores
 * everything before the first `@@`, because in the file-header section a
 * leading `+`/`-` is not a diff op. So the untracked half of a capture scored
 * +0/-0 on every server surface that measures the diff, while the tracked
 * blocks beside it (real git output) counted normally.
 *
 * agy session 65953fe2: the capture held 8 untracked new files (+1922) and 2
 * modified tracked ones (+59/-77). The session header read exactly +59/-77.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { execFileSync } from 'child_process';
import { realCaptureFilesDiff } from '../transcript-watch.js';

const gitIn = (dir: string, args: string[]) =>
  execFileSync('git', args, { cwd: dir, encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] }).toString().trim();

// The same hunk-aware rule the API's countDiffAddRemove applies.
function countInHunks(diff: string): { added: number; removed: number } {
  let added = 0, removed = 0, inHunk = false;
  for (const line of diff.split('\n')) {
    if (line.startsWith('@@')) { inHunk = true; continue; }
    if (line.startsWith('diff --git ')) { inHunk = false; continue; }
    if (!inHunk) continue;
    if (line[0] === '+') added++;
    else if (line[0] === '-') removed++;
  }
  return { added, removed };
}

describe('realCaptureFilesDiff', () => {
  let dir: string;

  beforeEach(() => {
    dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'origin-untracked-')));
    gitIn(dir, ['init', '-q']);
    gitIn(dir, ['config', 'user.email', 't@t.co']);
    gitIn(dir, ['config', 'user.name', 'T']);
    gitIn(dir, ['config', 'commit.gpgsign', 'false']);
    fs.writeFileSync(path.join(dir, 'tracked.txt'), 'a\nb\n');
    gitIn(dir, ['add', '-A']);
    gitIn(dir, ['commit', '-q', '-m', 'start']);
  });

  afterEach(() => {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ }
  });

  it('gives an untracked file a hunk header a hunk-aware counter can read', () => {
    fs.writeFileSync(path.join(dir, 'new.txt'), 'one\ntwo\nthree\n');
    const r = realCaptureFilesDiff(dir, ['new.txt']);
    expect(r.filesChanged).toEqual(['new.txt']);
    expect(r.linesAdded).toBe(3);
    expect(r.diff).toContain('@@ -0,0 +1,3 @@');
    expect(countInHunks(r.diff)).toEqual({ added: 3, removed: 0 });
  });

  it('counts the untracked and tracked halves of one capture alike', () => {
    fs.writeFileSync(path.join(dir, 'tracked.txt'), 'a\nB\n');
    fs.writeFileSync(path.join(dir, 'new.txt'), 'one\ntwo\n');
    const r = realCaptureFilesDiff(dir, ['tracked.txt', 'new.txt']);
    // 1 changed line in the tracked file + 2 new lines in the untracked one.
    expect(countInHunks(r.diff)).toEqual({ added: 3, removed: 1 });
    expect(r.linesAdded).toBe(3);
    expect(r.linesRemoved).toBe(1);
  });

  it('reports nothing for a file that matches HEAD', () => {
    const r = realCaptureFilesDiff(dir, ['tracked.txt']);
    expect(r.filesChanged).toEqual([]);
    expect(r.diff).toBe('');
  });
});
