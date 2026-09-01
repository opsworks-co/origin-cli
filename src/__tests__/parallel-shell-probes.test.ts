/**
 * Parallel tool calls each get their own probe window.
 *
 * `beginShellProbe` used to ASSIGN `state.shellProbes = probes`, and
 * `endShellProbe` drained the whole list. Agents issue Bash calls in parallel,
 * so with two in flight:
 *
 *   begin(A)  arms A
 *   begin(B)  DISCARDS A, arms B
 *   end(A)    resolves B's snapshot against the tree at A's finish, clears
 *   end(B)    finds nothing
 *
 * A's window vanished, and B was credited with whatever A wrote after B was
 * armed. It is also the most plausible way a probe is left undrained at a turn
 * boundary — the corruption #1322 fixed downstream (prod session 7f3776c8 turn
 * 0 carrying turn 1's whole-file write).
 *
 * The subagent tool-call ring already keys on the agent's id for exactly this
 * reason; the probe list never did.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { beginShellProbe, endShellProbe } from '../commands/hooks.js';
import { closeTurn } from '../session-state.js';

const A_FILE = 'src/a.ts';
const B_FILE = 'src/b.ts';

describe('parallel shell probes', () => {
  let repo: string;
  const git = (...args: string[]) =>
    execFileSync('git', args, { cwd: repo, stdio: ['pipe', 'pipe', 'pipe'] }).toString();

  beforeEach(() => {
    repo = fs.mkdtempSync(path.join(fs.realpathSync.native(os.tmpdir()), 'origin-par-'));
    git('init', '-q', '.');
    git('config', 'user.email', 't@t.t');
    git('config', 'user.name', 'T');
    fs.mkdirSync(path.join(repo, 'src'));
    fs.writeFileSync(path.join(repo, A_FILE), 'const a = 1;\n');
    fs.writeFileSync(path.join(repo, B_FILE), 'const b = 1;\n');
    git('add', '-A');
    git('commit', '-q', '-m', 'base');
  });
  afterEach(() => {
    try { fs.rmSync(repo, { recursive: true, force: true }); } catch { /* best effort */ }
  });

  const state = () => ({
    sessionId: 's', sessionTag: 's', repoPath: repo,
    prompts: ['only'],
    prePromptSha: git('rev-parse', 'HEAD').trim(),
    liveEdits: [],
    shellProbes: [],
  } as any);

  /** A write-capable shell call, as the hooks see it. */
  const call = (id: string, cmd: string) => ({
    tool_name: 'Bash', tool_use_id: id, tool_input: { command: cmd },
  });

  const filesFor = (s: any, idx: number) =>
    (s.liveEdits || [])
      .filter((e: any) => e.promptIndex === idx)
      .flatMap((e: any) => (e.edits || []).map((x: any) => x.file));

  it('keeps both windows when two calls are armed before either ends', () => {
    const s = state();
    beginShellProbe(s, call('A', `sed -i "" s/1/2/ ${A_FILE}`));
    beginShellProbe(s, call('B', `sed -i "" s/1/2/ ${B_FILE}`));

    // Was 1: begin(B) replaced A's probe outright.
    expect(s.shellProbes.length).toBe(2);
    expect(s.shellProbes.map((p: any) => p.toolCallId).sort()).toEqual(['A', 'B']);
  });

  it('resolves only the call that ends, leaving the other armed', () => {
    const s = state();
    beginShellProbe(s, call('A', `sed -i "" s/1/2/ ${A_FILE}`));
    beginShellProbe(s, call('B', `sed -i "" s/1/2/ ${B_FILE}`));

    fs.writeFileSync(path.join(repo, A_FILE), 'const a = 2;\n');
    endShellProbe(s, call('A', ''));

    expect(filesFor(s, 0)).toEqual([A_FILE]);
    // B is still in flight — its window must survive A's completion.
    expect(s.shellProbes.map((p: any) => p.toolCallId)).toEqual(['B']);

    fs.writeFileSync(path.join(repo, B_FILE), 'const b = 2;\n');
    endShellProbe(s, call('B', ''));

    expect(filesFor(s, 0).sort()).toEqual([A_FILE, B_FILE].sort());
    expect(s.shellProbes).toEqual([]);
  });

  it('does not let an unrelated tool call close someone else\'s window', () => {
    // The read-only command that drained a window it never opened — the
    // trigger behind the cross-turn corruption in #1322.
    const s = state();
    beginShellProbe(s, call('A', `sed -i "" s/1/2/ ${A_FILE}`));
    fs.writeFileSync(path.join(repo, A_FILE), 'const a = 2;\n');

    endShellProbe(s, { tool_name: 'Bash', tool_use_id: 'UNRELATED', tool_input: {} });

    expect(filesFor(s, 0)).toEqual([]);
    expect(s.shellProbes.map((p: any) => p.toolCallId)).toEqual(['A']);
  });

  it('still drains when the agent propagates no id on either hook', () => {
    // Older builds send none; they keep the previous behaviour rather than
    // leaking probes for the whole turn.
    const s = state();
    beginShellProbe(s, { tool_name: 'Bash', tool_input: { command: `sed -i "" s/1/2/ ${A_FILE}` } });
    expect(s.shellProbes.length).toBe(1);
    expect(s.shellProbes[0].toolCallId).toBeUndefined();

    fs.writeFileSync(path.join(repo, A_FILE), 'const a = 2;\n');
    endShellProbe(s, { tool_name: 'Bash', tool_input: {} });

    expect(filesFor(s, 0)).toEqual([A_FILE]);
    expect(s.shellProbes).toEqual([]);
  });

  it('bounds how many undrained probes a turn can hold', () => {
    const s = state();
    for (let i = 0; i < 12; i++) beginShellProbe(s, call(`T${i}`, `sed -i "" s/1/2/ ${A_FILE}`));
    expect(s.shellProbes.length).toBe(8);
    // Oldest dropped, newest kept.
    expect(s.shellProbes[s.shellProbes.length - 1].toolCallId).toBe('T11');
    expect(s.shellProbes.some((p: any) => p.toolCallId === 'T0')).toBe(false);
  });

  it('drops a previous turn\'s probe when a new turn arms one', () => {
    const s = state();
    beginShellProbe(s, call('OLD', `sed -i "" s/1/2/ ${A_FILE}`));
    // The turn ends and the next prompt binds — the real boundary, not a
    // hand-edited index: a queued prompt only becomes current once the running
    // turn closes.
    s.prompts.push('second');
    closeTurn(s);
    beginShellProbe(s, call('NEW', `sed -i "" s/1/2/ ${B_FILE}`));

    expect(s.shellProbes.map((p: any) => p.toolCallId)).toEqual(['NEW']);
    expect(s.shellProbes.every((p: any) => p.promptIndex === 1)).toBe(true);
  });
});
