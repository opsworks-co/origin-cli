/**
 * The idle-skip guard keyed on the transcript (size, mtime, prompt count) and
 * HEAD. All four can sit still while an agent is still writing files:
 *
 *   - an agent writes its files and THEN summarises, so the last transcript
 *     write can precede the last file write;
 *   - a turn whose work is never committed never moves HEAD.
 *
 * So the working tree is a SECOND source of change, not a mirror of the first,
 * and the guard could not see it. Session 65014e0b froze on a partial capture —
 * one file, +37/-37, stored at 17:45:45Z — while the agent went on to write
 * three files worth +1352/-41. Re-running the same window against the same
 * worktree afterwards reports +1347/-41 across all three, so the capture was
 * recoverable the whole time; every later poll simply skipped.
 *
 * Unknown fingerprint counts as CHANGED, matching the transcript-size rule it
 * sits beside: skipping is the optimisation, doing the work is correct, so
 * anything unconfirmed falls through to a capture.
 */
import { describe, it, expect } from 'vitest';
import { realTreeFingerprint } from '../transcript-watch.js';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { execFileSync } from 'child_process';

function tmpRepo(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'origin-tree-fp-'));
  const git = (...args: string[]) =>
    execFileSync('git', args, { cwd: dir, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
  git('init', '-q');
  git('config', 'user.email', 't@example.com');
  git('config', 'user.name', 'T');
  fs.writeFileSync(path.join(dir, 'a.txt'), 'one\n');
  git('add', '.');
  git('commit', '-qm', 'init');
  return dir;
}

describe('realTreeFingerprint', () => {
  it('is stable while nothing moves', () => {
    const dir = tmpRepo();
    const first = realTreeFingerprint(dir);
    expect(first).not.toBeNull();
    expect(realTreeFingerprint(dir)).toBe(first);
  });

  it('changes when a tracked file is modified — no commit, no transcript write', () => {
    const dir = tmpRepo();
    const before = realTreeFingerprint(dir);
    fs.writeFileSync(path.join(dir, 'a.txt'), 'one\ntwo\n');
    expect(realTreeFingerprint(dir)).not.toBe(before);
  });

  it('changes when an UNTRACKED file appears — the 65014e0b shape', () => {
    // styles.css and app.js were both untracked. A guard blind to untracked
    // files would still have skipped.
    const dir = tmpRepo();
    const before = realTreeFingerprint(dir);
    fs.writeFileSync(path.join(dir, 'styles.css'), 'body{}\n');
    const after = realTreeFingerprint(dir);
    expect(after).not.toBe(before);
    expect(after).toContain('styles.css');
  });

  it('changes when a file is deleted', () => {
    const dir = tmpRepo();
    const before = realTreeFingerprint(dir);
    fs.unlinkSync(path.join(dir, 'a.txt'));
    expect(realTreeFingerprint(dir)).not.toBe(before);
  });

  it('returns null rather than throwing outside a repo', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'origin-not-a-repo-'));
    expect(realTreeFingerprint(dir)).toBeNull();
  });
});
