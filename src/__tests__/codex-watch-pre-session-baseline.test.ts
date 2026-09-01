/**
 * The Codex watcher measures inherited work against a tree that HELD it.
 *
 * #1387 taught the capture to say how much of a commit was already uncommitted
 * when the session started, and it works by diffing the commit's parent against
 * the session's baseline. The hook path passes a baseline SHADOW — a commit
 * over the dirty tree — so the question has an answer there. The Codex watcher
 * passes `headShaAtStart`, a plain HEAD sha, and a commit sitting directly on
 * that HEAD has it as its own parent: parent..baseline is empty by
 * construction, so every Codex session recorded "+0/-0, started clean" no
 * matter what was in the tree.
 *
 * Measured on kotleta f20f04c5 with the shipped binary: 0/0 from the session's
 * HEAD (`369f4a82`), +83/-15 from its first prompt's shadow (`d8de1d6c`) — a
 * commit whose +270/-18 exceeded its session's own +188/-7 by exactly that.
 *
 * The shadow is measured against, never walked: the commit range stays
 * headBefore..HEAD, so which commits belong to the session is untouched.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { execFileSync } from 'child_process';
import { captureGitState, createShadowCommit } from '../git-capture.js';

const gitIn = (dir: string, args: string[]) =>
  execFileSync('git', args, { cwd: dir, encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] }).toString();

const lines = (from: number, to: number) =>
  Array.from({ length: to - from + 1 }, (_, i) => `line ${from + i}`).join('\n') + '\n';

describe('captureGitState — pre-session baseline supplied separately', () => {
  let dir: string;
  let headAtStart: string;
  let shadow: string;

  beforeEach(() => {
    dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'origin-codexbase-')));
    gitIn(dir, ['init', '-q']);
    gitIn(dir, ['config', 'user.email', 't@t.co']);
    gitIn(dir, ['config', 'user.name', 'T']);
    gitIn(dir, ['config', 'commit.gpgsign', 'false']);
    fs.writeFileSync(path.join(dir, 'app.js'), lines(1, 10));
    gitIn(dir, ['add', '-A']);
    gitIn(dir, ['commit', '-q', '-m', 'seed']);

    // A PREVIOUS session left 20 lines uncommitted…
    fs.writeFileSync(path.join(dir, 'app.js'), lines(1, 10) + lines(11, 30));
    // …and this one opens on top of them. The watcher records both: the HEAD
    // sha it will walk commits from, and a shadow of the tree as it found it.
    headAtStart = gitIn(dir, ['rev-parse', 'HEAD']).trim();
    shadow = createShadowCommit(dir, 'codexwatch-0-test') || headAtStart;

    // This session writes 5 lines and commits everything.
    fs.writeFileSync(path.join(dir, 'app.js'), lines(1, 10) + lines(11, 30) + lines(31, 35));
    gitIn(dir, ['add', '-A']);
    gitIn(dir, ['commit', '-q', '-m', 'work']);
  });

  afterEach(() => {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ }
  });

  it('reports the inherited work when given the session shadow', () => {
    const res = captureGitState(dir, headAtStart, {
      committedOnly: true, fullContext: true, preSessionBaseline: shadow,
    });
    const c = res.commitDetails[0];
    expect(c.linesAdded).toBe(25);          // git's own total
    expect(c.preSessionLinesAdded).toBe(20); // the part the session did not write
    expect(c.preSessionLinesRemoved).toBe(0);
  });

  it('answers "clean" from the HEAD sha alone — the shape that hid it', () => {
    // Not an assertion that this is DESIRABLE; it pins why the parameter
    // exists. A commit on `headAtStart` measures headAtStart against itself.
    const c = captureGitState(dir, headAtStart, { committedOnly: true, fullContext: true })
      .commitDetails[0];
    expect(c.preSessionLinesAdded).toBe(0);
  });

  it('leaves the commit range alone — the shadow is measured against, not walked', () => {
    const withShadow = captureGitState(dir, headAtStart, {
      committedOnly: true, fullContext: true, preSessionBaseline: shadow,
    });
    const without = captureGitState(dir, headAtStart, { committedOnly: true, fullContext: true });
    expect(withShadow.commitShas).toEqual(without.commitShas);
    expect(withShadow.headBefore).toBe(without.headBefore);
    expect(withShadow.commitDetails[0].linesAdded).toBe(without.commitDetails[0].linesAdded);
  });

  it('falls back to previous behaviour when the baseline is absent or junk', () => {
    for (const preSessionBaseline of [null, undefined, 'not-a-sha']) {
      const c = captureGitState(dir, headAtStart, {
        committedOnly: true, fullContext: true, preSessionBaseline,
      }).commitDetails[0];
      expect(c.preSessionLinesAdded).toBe(0);
    }
  });
});
