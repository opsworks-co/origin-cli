// Regression test for "a committing turn that edits via a shell command shows
// +0 / no diff" (Copilot's gpt-5-mini does `printf >> file && git commit`
// instead of an edit tool).
//
// The turn produces NO transcript edit-tool call, so extractPromptFileMappings
// emits an EMPTY mapping for it. The stop hook then must re-derive the turn's
// per-prompt diff from git — against the PER-PROMPT SHADOW baseline, so a prior
// turn's uncommitted work is excluded and only THIS turn's lines are counted.
//
// This validates the git-capture semantics the fix relies on, using the real
// createShadowCommit + captureGitState:
//   turn 1: create file with 15 lines (uncommitted)
//   turn 2 start: shadow the 15-line dirty tree
//   turn 2: append 5 lines via shell + commit all 20
//   => capture vs the shadow must report +5 (turn 2's authored delta), NOT the
//      commit's full +20 and NOT 0.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { createShadowCommit, captureGitState } from '../git-capture.js';

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf-8' }).trim();
}
function count(diff: string | undefined | null) {
  const lines = (diff || '').split('\n');
  return {
    add: lines.filter((l) => l.startsWith('+') && !l.startsWith('+++')).length,
    rem: lines.filter((l) => l.startsWith('-') && !l.startsWith('---')).length,
  };
}

describe('shell-edit + same-turn commit: per-prompt diff via shadow baseline', () => {
  let dir: string;
  beforeEach(() => {
    dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'origin-shelledit-')));
    git(dir, 'init', '-q');
    git(dir, 'config', 'user.email', 't@t.co');
    git(dir, 'config', 'user.name', 't');
    fs.writeFileSync(path.join(dir, 'README.md'), 'init\n');
    git(dir, 'add', '-A');
    git(dir, 'commit', '-qm', 'initial');
  });
  afterEach(() => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ } });

  it('captures the committing turn\'s +5, not the commit\'s full +20 or 0', () => {
    // turn 1: create file with 15 lines, leave uncommitted
    fs.writeFileSync(
      path.join(dir, 'random-lines.txt'),
      Array.from({ length: 15 }, (_, i) => `line${i + 1}`).join('\n') + '\n',
    );
    // turn 2 start: shadow the dirty (15-line) working tree
    const shadow = createShadowCommit(dir, 'p1');
    expect(shadow).toBeTruthy();

    // turn 2: append 5 more lines via shell, then commit all 20
    fs.appendFileSync(
      path.join(dir, 'random-lines.txt'),
      Array.from({ length: 5 }, (_, i) => `line${i + 16}`).join('\n') + '\n',
    );
    git(dir, 'add', 'random-lines.txt');
    git(dir, 'commit', '-qm', 'add 5 more');

    // What the stop hook computes for the current prompt (baseline = shadow).
    const cap = captureGitState(dir, shadow, { fullContext: true });
    expect(cap.baselineIsShadow).toBe(true);
    // The turn's authored delta is +5 — NOT the commit's full +20.
    expect(count(cap.committedDiff).add).toBe(5);

    // The safety-net synthesis picks workingTreeDiff for a shadow baseline (or
    // falls back to committedDiff); either way the per-prompt diff is +5.
    const useWorkingTreeDiff = cap.baselineIsShadow && cap.workingTreeDiff;
    const synth = useWorkingTreeDiff ? cap.workingTreeDiff! : (cap.committedDiff || '');
    expect(count(synth).add).toBe(5);
    expect(count(synth).rem).toBe(0);

    // And the commit IS seen since the shadow, so the turn gets its commit stamp.
    expect((cap.commitDetails || []).length).toBe(1);
  });

  it('a chat-only turn (no edits, no commit) reports no work', () => {
    // Nothing changes this turn.
    const shadow = createShadowCommit(dir, 'p1'); // clean tree → null
    expect(shadow).toBeNull();
    const cap = captureGitState(dir, git(dir, 'rev-parse', 'HEAD'), { fullContext: true });
    expect(count(cap.committedDiff).add).toBe(0);
    expect(count(cap.workingTreeDiff).add).toBe(0);
  });
});
