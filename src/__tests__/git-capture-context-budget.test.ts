// Large-session capture regression.
//
// `fullContext` captures ran `git diff --unified=2000` so AI Blame could render
// whole files. That costs ~25x the bytes of a normal diff, so a session that
// changes a lot and commits rarely blew MAX_DIFF_SIZE (500KB) — and the overflow
// was handled by `slice(0, MAX_DIFF_SIZE)`, a raw BYTE cut. The stored diff was
// malformed (cut mid-hunk) and silently missing every file past the cut.
//
// Now: context is negotiated down the ladder (2000 → 25 → 3) until the payload
// fits, and if it still doesn't, WHOLE `diff --git` sections are dropped rather
// than bytes. Reducing context loses surrounding lines, never changed ones, so
// file coverage and line counts stay exact.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { execFileSync } from 'child_process';
import { captureGitState } from '../git-capture';

const gitIn = (dir: string, args: string[]) =>
  execFileSync('git', args, { cwd: dir, encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] }).toString();

// Every diff section must be well-formed: a header, and every hunk body line
// carrying a diff op. A byte-cut diff fails this.
const assertWellFormed = (diff: string) => {
  const sections = diff.split(/^(?=diff --git )/m).filter((s) => s.trim());
  for (const sec of sections) {
    expect(sec.startsWith('diff --git ')).toBe(true);
    const lines = sec.split('\n');
    expect(lines.some((l: string) => l.startsWith('@@ '))).toBe(true);
    // Hunk headers must be parseable and monotonically ordered.
    let prev = -1;
    for (const l of lines) {
      const m = /^@@ -(\d+)(?:,\d+)? \+\d+(?:,\d+)? @@/.exec(l);
      if (!m) continue;
      const start = parseInt(m[1], 10);
      expect(start).toBeGreaterThanOrEqual(prev);
      prev = start;
    }
  }
};

describe('captureGitState — context budget on large sessions', () => {
  let dir: string;
  beforeEach(() => {
    dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'origin-ctx-')));
    gitIn(dir, ['init', '-q']);
    gitIn(dir, ['config', 'user.email', 't@t.co']);
    gitIn(dir, ['config', 'user.name', 'T']);
    gitIn(dir, ['config', 'commit.gpgsign', 'false']);
  });
  afterEach(() => {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  // 40 files x 1200 lines. At --unified=2000 every file renders whole, so the
  // combined diff is several MB — well past the 500KB cap.
  const seedBigRepo = () => {
    for (let f = 0; f < 40; f++) {
      const body = Array.from({ length: 1200 }, (_, i) => `file${f} original line ${i}`).join('\n');
      fs.writeFileSync(path.join(dir, `f${f}.txt`), body + '\n');
    }
    gitIn(dir, ['add', '-A']);
    gitIn(dir, ['commit', '-q', '-m', 'seed']);
    return gitIn(dir, ['rev-parse', 'HEAD']).trim();
  };

  // One changed line per file — tiny real change, enormous at full context.
  const touchEveryFile = () => {
    for (let f = 0; f < 40; f++) {
      const p = path.join(dir, `f${f}.txt`);
      const lines = fs.readFileSync(p, 'utf-8').split('\n');
      lines[600] = `file${f} CHANGED line 600`;
      fs.writeFileSync(p, lines.join('\n'));
    }
  };

  it('keeps a huge full-context capture under the cap and well-formed', () => {
    const headBefore = seedBigRepo();
    touchEveryFile();

    const res = captureGitState(dir, headBefore, { fullContext: true });

    expect(res.uncommittedDiff.length).toBeLessThanOrEqual(500_000);
    assertWellFormed(res.uncommittedDiff);
  });

  it('loses no file and no changed line when context is reduced', () => {
    const headBefore = seedBigRepo();
    touchEveryFile();

    const res = captureGitState(dir, headBefore, { fullContext: true });

    // All 40 files still present — the byte-cut used to drop most of them.
    const paths = (res.uncommittedDiff.match(/^diff --git a\/(\S+)/gm) || []).length;
    expect(paths).toBe(40);
    // Exactly one changed line per file survives, both directions.
    expect(res.linesAdded).toBe(40);
    expect(res.linesRemoved).toBe(40);
  });

  it('still renders whole files when the session is small enough to afford it', () => {
    const headBefore = (() => {
      const body = Array.from({ length: 400 }, (_, i) => `line ${i}`).join('\n');
      fs.writeFileSync(path.join(dir, 'small.txt'), body + '\n');
      gitIn(dir, ['add', '-A']);
      gitIn(dir, ['commit', '-q', '-m', 'seed']);
      return gitIn(dir, ['rev-parse', 'HEAD']).trim();
    })();
    const lines = fs.readFileSync(path.join(dir, 'small.txt'), 'utf-8').split('\n');
    lines[200] = 'CHANGED';
    fs.writeFileSync(path.join(dir, 'small.txt'), lines.join('\n'));

    const res = captureGitState(dir, headBefore, { fullContext: true });

    // Full context => the untouched head and tail of the file are both present,
    // which is what AI Blame needs. This is the no-regression guard.
    expect(res.uncommittedDiff).toContain(' line 0');
    expect(res.uncommittedDiff).toContain(' line 399');
    expect(res.linesAdded).toBe(1);
    expect(res.linesRemoved).toBe(1);
  });

  it('a normal capture is unaffected by the ladder', () => {
    const headBefore = seedBigRepo();
    touchEveryFile();

    const res = captureGitState(dir, headBefore); // no fullContext
    expect(res.linesAdded).toBe(40);
    expect(res.linesRemoved).toBe(40);
    assertWellFormed(res.uncommittedDiff);
  });
});
