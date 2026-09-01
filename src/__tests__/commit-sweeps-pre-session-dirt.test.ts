/**
 * A commit's total describes the COMMIT, not the session that made it.
 *
 * `git commit -a` sweeps up whatever is dirty — including work a previous
 * session left uncommitted. Session 38bcb56c committed +223/-16 while
 * authoring +97/-20; the other +144/-14 was the previous Codex session's last
 * turn, never committed, still sitting in the tree when this one opened. The
 * page showed the commit total next to a turn's own +43/-9 with nothing able
 * to say where the difference came from, and the reader's only reading was
 * that Origin had miscounted.
 *
 * The read side cannot answer it: by the time a payload lands, the tree that
 * held the inherited work is gone. Only the capture can measure it, which is
 * what these pin.
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

describe('a commit that swept in work from before the session', () => {
  let dir: string;

  beforeEach(() => {
    dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'origin-presession-')));
    gitIn(dir, ['init', '-q']);
    gitIn(dir, ['config', 'user.email', 't@t.co']);
    gitIn(dir, ['config', 'user.name', 'T']);
    gitIn(dir, ['config', 'commit.gpgsign', 'false']);
    fs.writeFileSync(path.join(dir, 'app.js'), lines(1, 10));
    gitIn(dir, ['add', '-A']);
    gitIn(dir, ['commit', '-q', '-m', 'seed']);
  });

  afterEach(() => {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ }
  });

  // The session's baseline, exactly as the watchers take it: a shadow commit
  // over a dirty tree, plain HEAD when it is clean.
  const sessionStart = (): string =>
    createShadowCommit(dir, 'test-session-start') || gitIn(dir, ['rev-parse', 'HEAD']).trim();

  it('names the inherited part of the commit instead of leaving it unexplained', () => {
    // A PREVIOUS session appended 20 lines and never committed them.
    fs.writeFileSync(path.join(dir, 'app.js'), lines(1, 10) + lines(11, 30));
    // …this session opens on top of that.
    const baseline = sessionStart();

    // …writes 5 lines of its own, and commits everything.
    fs.writeFileSync(path.join(dir, 'app.js'), lines(1, 10) + lines(11, 30) + lines(31, 35));
    gitIn(dir, ['add', '-A']);
    gitIn(dir, ['commit', '-q', '-m', 'work']);

    const res = captureGitState(dir, baseline);
    expect(res.commitDetails.length).toBe(1);
    const c = res.commitDetails[0];
    // git's own total for the commit — 25 lines, only 5 of them this session's.
    expect(c.linesAdded).toBe(25);
    // …and the part of it that was already in the tree when the session began.
    expect(c.preSessionLinesAdded).toBe(20);
    expect(c.preSessionLinesRemoved).toBe(0);
  });

  it('reports zero — not silence — for a session that started clean', () => {
    // "Nothing was inherited" is an answer. Omitting the field would make a
    // clean session indistinguishable from one we could not measure.
    const baseline = sessionStart();
    fs.writeFileSync(path.join(dir, 'app.js'), lines(1, 10) + lines(11, 13));
    gitIn(dir, ['add', '-A']);
    gitIn(dir, ['commit', '-q', '-m', 'work']);

    const c = captureGitState(dir, baseline).commitDetails[0];
    expect(c.linesAdded).toBe(3);
    expect(c.preSessionLinesAdded).toBe(0);
    expect(c.preSessionLinesRemoved).toBe(0);
  });

  it('counts inherited DELETIONS too', () => {
    // A previous session deleted lines and left that uncommitted.
    fs.writeFileSync(path.join(dir, 'app.js'), lines(1, 6));   // -4
    const baseline = sessionStart();
    fs.writeFileSync(path.join(dir, 'app.js'), lines(1, 5));   // this session: -1
    gitIn(dir, ['add', '-A']);
    gitIn(dir, ['commit', '-q', '-m', 'work']);

    const c = captureGitState(dir, baseline).commitDetails[0];
    expect(c.linesRemoved).toBe(5);
    expect(c.preSessionLinesRemoved).toBe(4);
  });

  it('says nothing about a LATER commit in the same session', () => {
    // Its parent is the session's own first commit, which the baseline never
    // saw. Diffing across that pair reports the first commit's work as though
    // the tree had been holding it — a confident, wrong explanation. Only the
    // commit sitting directly on pre-session history can be measured.
    fs.writeFileSync(path.join(dir, 'app.js'), lines(1, 10) + lines(11, 20));
    const baseline = sessionStart();

    fs.writeFileSync(path.join(dir, 'app.js'), lines(1, 10) + lines(11, 20) + lines(21, 22));
    gitIn(dir, ['add', '-A']);
    gitIn(dir, ['commit', '-q', '-m', 'first']);
    fs.writeFileSync(path.join(dir, 'app.js'), lines(1, 10) + lines(11, 20) + lines(21, 25));
    gitIn(dir, ['add', '-A']);
    gitIn(dir, ['commit', '-q', '-m', 'second']);

    const res = captureGitState(dir, baseline);
    expect(res.commitDetails.length).toBe(2);
    const [first, second] = res.commitDetails;
    expect(first.preSessionLinesAdded).toBe(10);   // provable: sits on the baseline
    expect(second.preSessionLinesAdded).toBeUndefined();
    expect(second.preSessionLinesRemoved).toBeUndefined();
  });

  it('measures only the files the commit actually touched', () => {
    // Dirt in a file the commit left alone is not part of that commit, and
    // counting it would explain away lines the commit never carried.
    fs.writeFileSync(path.join(dir, 'app.js'), lines(1, 10) + lines(11, 30));
    fs.writeFileSync(path.join(dir, 'untouched.txt'), lines(1, 50));
    const baseline = sessionStart();

    fs.writeFileSync(path.join(dir, 'app.js'), lines(1, 10) + lines(11, 30) + lines(31, 31));
    gitIn(dir, ['add', '--', 'app.js']);
    gitIn(dir, ['commit', '-q', '-m', 'just app.js']);

    const c = captureGitState(dir, baseline).commitDetails[0];
    expect(c.filesChanged).toEqual(['app.js']);
    expect(c.preSessionLinesAdded).toBe(20); // not 70
  });
});
