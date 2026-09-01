/**
 * A turn that captures nothing must still get the shell window.
 *
 * The Stop that ends a turn anchors the NEXT turn's baseline at the current
 * tree. So work a turn failed to capture is not merely missing from that turn —
 * it is inside the following baseline, and every later diff correctly reports it
 * as unchanged. There is no second chance.
 *
 * Prod a77105c0 turn 0:
 *
 *   [stop] final-state hunks {"prompts":0,"shadows":1}              <- captured 0
 *   [stop] shadow commit anchored next-prompt baseline {"dirtyCount":3}
 *
 * Three source files (+87/-79) erased in one step, present in no turn. The
 * window was skipped because `shellWriteTurns` — a heuristic meaning "a Bash
 * command in this turn looked like it wrote" — did not list turn 0. The
 * heuristic may now veto only a turn that already captured something.
 */
import { describe, it, expect } from 'vitest';
import { shouldRunShellWindow, __testRecordShellWindowEdits } from '../commands/hooks.js';
import { execFileSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';

const edit = () => ({ file: 'a.ts', source: 'tool_call' });

describe('shouldRunShellWindow', () => {
  it('runs for a turn that captured nothing, even without a shell-write signal', () => {
    // The regression. Turn 0 had no ledger entry and no shellWriteTurns entry,
    // so the window never ran and the work was erased by the next baseline.
    expect(shouldRunShellWindow({ liveEdits: [], shellWriteTurns: [] }, 0)).toBe(true);
  });

  it('runs when the turn has a ledger entry that is EMPTY', () => {
    // An entry with no edits is not a capture.
    expect(shouldRunShellWindow(
      { liveEdits: [{ promptIndex: 0, edits: [] }], shellWriteTurns: [] }, 0,
    )).toBe(true);
  });

  it('still lets the heuristic veto a turn that already captured something', () => {
    // Unchanged behaviour: a turn with real tool-call edits and no shell-write
    // signal does not need the window, and running it would only add cost.
    expect(shouldRunShellWindow(
      { liveEdits: [{ promptIndex: 0, edits: [edit()] }], shellWriteTurns: [] }, 0,
    )).toBe(false);
  });

  it('runs for a captured turn when the shell-write signal IS present', () => {
    expect(shouldRunShellWindow(
      { liveEdits: [{ promptIndex: 0, edits: [edit()] }], shellWriteTurns: [0] }, 0,
    )).toBe(true);
  });

  it('scopes the check to the turn being captured, not the whole session', () => {
    // Turn 1 captured work; turn 0 captured none. Turn 0 must still run.
    const state = { liveEdits: [{ promptIndex: 1, edits: [edit()] }], shellWriteTurns: [1] };
    expect(shouldRunShellWindow(state, 0)).toBe(true);
    expect(shouldRunShellWindow(state, 1)).toBe(true);
  });

  it('tolerates a state with neither field', () => {
    expect(shouldRunShellWindow({}, 0)).toBe(true);
  });
});

/**
 * End to end against real git: the predicate returning true proves nothing on
 * its own — what matters is that the file actually lands in the ledger.
 */
describe('turn 0 capture, driven against a real repo', () => {
  it('captures a turn-0 edit that no probe reported', () => {
    const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'origin-turn0-'));
    const git = (...a: string[]) =>
      execFileSync('git', a, { cwd: repo, encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] }).toString().trim();
    git('init', '-q', '-b', 'main');
    git('config', 'user.email', 't@t.t'); git('config', 'user.name', 'T');
    git('config', 'commit.gpgsign', 'false');
    fs.writeFileSync(path.join(repo, 'src.ts'), 'line one\n');
    git('add', '-A'); git('commit', '-qm', 'base');
    const baseline = git('rev-parse', 'HEAD');

    // The turn edits a tracked file. No tool-call edit was recorded and no
    // shell-write probe fired — exactly prod a77105c0's turn 0.
    fs.writeFileSync(path.join(repo, 'src.ts'), 'line one\nline two\nline three\n');

    const state: any = {
      sessionId: 'turn0-test', sessionTag: 'turn0-test', repoPath: repo,
      liveEdits: [], shellWriteTurns: [], prompts: ['do the thing'],
    };
    const changed = __testRecordShellWindowEdits(state, repo, 0, baseline);

    expect(changed, 'the window did not run for a turn that captured nothing').toBe(true);
    const files = (state.liveEdits || []).flatMap((e: any) => (e.edits || []).map((x: any) => x.file));
    expect(files).toContain('src.ts');
  });

  it('leaves a genuinely clean turn empty', () => {
    // The relaxed gate must not invent work for a chat-only turn.
    const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'origin-turn0-'));
    const git = (...a: string[]) =>
      execFileSync('git', a, { cwd: repo, encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] }).toString().trim();
    git('init', '-q', '-b', 'main');
    git('config', 'user.email', 't@t.t'); git('config', 'user.name', 'T');
    git('config', 'commit.gpgsign', 'false');
    fs.writeFileSync(path.join(repo, 'src.ts'), 'line one\n');
    git('add', '-A'); git('commit', '-qm', 'base');
    const baseline = git('rev-parse', 'HEAD');

    const state: any = { sessionId: 't', sessionTag: 't', repoPath: repo, liveEdits: [], shellWriteTurns: [] };
    __testRecordShellWindowEdits(state, repo, 0, baseline);
    const files = (state.liveEdits || []).flatMap((e: any) => (e.edits || []).map((x: any) => x.file));
    expect(files).toEqual([]);
  });
});
