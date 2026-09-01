/**
 * A turn's own early writes must survive a baseline taken AFTER them.
 *
 * The poll-based watcher stamps a prompt's shadow when it NOTICES the prompt,
 * not when the prompt was submitted. A fast agent writes files inside that gap,
 * so `git show <shadow>:<file>` hands back the file the turn had just written —
 * backfillWriteBaselines stamped oldContent === newContent, the write collapsed
 * to a no-op, and every surface downstream (synthesizePromptDiff, the turn's
 * filesChanged, the session header) dropped it. `git diff <shadow> <worktree>`
 * can't recover it either: the content is identical on both sides.
 *
 * Antigravity session 65953fe2 (kotleta): prompt 1 submitted 16:14:34, shadow
 * taken 16:14:50, five files written in between (backend/task_manager.py,
 * backend/analytics.py, backend/server.py, run.py, server.py). The turn
 * recorded 5 files / +1559 against a git truth of 10 files / +1981-77 —
 * 422 authored lines attributed to no turn at all.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { execFileSync } from 'child_process';
import { backfillWriteBaselines } from '../prompt-capture/index.js';

const gitIn = (dir: string, args: string[]) =>
  execFileSync('git', args, { cwd: dir, encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] }).toString().trim();

describe('backfillWriteBaselines with a baseline taken after the write', () => {
  let dir: string;
  let sessionStart: string;

  const commitAll = (message: string): string => {
    gitIn(dir, ['add', '-A']);
    gitIn(dir, ['commit', '-q', '-m', message]);
    return gitIn(dir, ['rev-parse', 'HEAD']);
  };

  beforeEach(() => {
    dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'origin-latebase-')));
    gitIn(dir, ['init', '-q']);
    gitIn(dir, ['config', 'user.email', 't@t.co']);
    gitIn(dir, ['config', 'user.name', 'T']);
    gitIn(dir, ['config', 'commit.gpgsign', 'false']);
    fs.writeFileSync(path.join(dir, 'server.py'), 'old line 1\nold line 2\n');
    sessionStart = commitAll('start');
  });

  afterEach(() => {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ }
  });

  // The late shadow: the agent has already rewritten server.py and created
  // backend/task_manager.py by the time the watcher takes it.
  function lateBaseline(): string {
    fs.writeFileSync(path.join(dir, 'server.py'), 'new\n');
    fs.mkdirSync(path.join(dir, 'backend'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'backend', 'task_manager.py'), 'brand new\n');
    return commitAll('late shadow');
  }

  it('recovers the real before-state from the session-start baseline', () => {
    const late = lateBaseline();
    const edits = [{ file: 'server.py', op: 'write', newContent: 'new\n' }];
    backfillWriteBaselines(edits as any, dir, late, sessionStart);
    // Not the late baseline's copy (which IS the new content) — the pre-turn one.
    expect(edits[0]).toMatchObject({ oldContent: 'old line 1\nold line 2\n' });
  });

  it('keeps a genuine create reading as a whole-file add', () => {
    const late = lateBaseline();
    const edits: any[] = [{ file: 'backend/task_manager.py', op: 'write', newContent: 'brand new\n' }];
    backfillWriteBaselines(edits, dir, late, sessionStart);
    // Absent at session start → the turn created it. Stamping the late
    // baseline's identical copy would have zeroed the file out entirely.
    expect(edits[0].oldContent).toBeUndefined();
  });

  it('leaves a rewrite-with-identical-content as the no-op it really is', () => {
    // server.py unchanged since session start, and the "write" wrote the same
    // bytes back — so both baselines legitimately hold the new content.
    fs.writeFileSync(path.join(dir, 'unrelated.txt'), 'x\n');
    const late = commitAll('unrelated');
    const edits = [{ file: 'server.py', op: 'write', newContent: 'old line 1\nold line 2\n' }];
    backfillWriteBaselines(edits as any, dir, late, sessionStart);
    expect(edits[0]).toMatchObject({ oldContent: 'old line 1\nold line 2\n' });
  });

  it('is unchanged when the turn baseline genuinely predates the write', () => {
    const edits = [{ file: 'server.py', op: 'write', newContent: 'new\n' }];
    backfillWriteBaselines(edits as any, dir, sessionStart, sessionStart);
    expect(edits[0]).toMatchObject({ oldContent: 'old line 1\nold line 2\n' });
  });

  it('behaves exactly as before when no fallback baseline is supplied', () => {
    const late = lateBaseline();
    const edits = [{ file: 'server.py', op: 'write', newContent: 'new\n' }];
    backfillWriteBaselines(edits as any, dir, late);
    expect(edits[0]).toMatchObject({ oldContent: 'new\n' });
  });

  it('never overwrites a before-state the agent already reported', () => {
    const late = lateBaseline();
    const edits = [{ file: 'server.py', op: 'write', oldContent: 'agent said this\n', newContent: 'new\n' }];
    backfillWriteBaselines(edits as any, dir, late, sessionStart);
    expect(edits[0]).toMatchObject({ oldContent: 'agent said this\n' });
  });
});
