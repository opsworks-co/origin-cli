/**
 * A shell probe armed by one turn must not record the NEXT turn's writes.
 *
 * `beginShellProbe` only arms a probe for a command that can write files, but
 * `endShellProbe` runs on every post-tool-use. So a probe armed by the last
 * write-capable command of a turn, whose own post-tool-use never drained it,
 * survives into the next turn — where the first read-only command resolves it
 * against a tree that has since moved. Everything the new turn wrote reads as
 * "changed inside that command's window".
 *
 * Prod session 7f3776c8 turn 0 was pure investigation. The CLI said so on every
 * Stop — `{"i":0,"f":0,"a":null,"r":null,"d":0}` — and the stored row's own
 * diff and line counts are empty, matching. But the row carried an 88KB
 * editsJson holding a single `command_probe` whole-file write of
 * `packages/cli/src/commands/sessions.ts`, 42,605 → 43,793 bytes: turn 1's
 * edit, filed under turn 0. The session page rendered it as `+0/-2` — the read
 * path synthesizes a diff from that editsJson, then correctly surrenders the
 * ADDED lines to turn 1, leaving turn 1's two deletions stranded on a turn that
 * authored nothing.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { endShellProbe } from '../commands/hooks.js';

const FILE = 'src/target.ts';

describe('a shell probe armed by an earlier turn', () => {
  let repo: string;
  const git = (...args: string[]) =>
    execFileSync('git', args, { cwd: repo, stdio: ['pipe', 'pipe', 'pipe'] }).toString();

  beforeEach(() => {
    repo = fs.mkdtempSync(path.join(fs.realpathSync.native(os.tmpdir()), 'origin-probe-'));
    git('init', '-q', '.');
    git('config', 'user.email', 't@t.t');
    git('config', 'user.name', 'T');
    fs.mkdirSync(path.join(repo, 'src'));
    fs.writeFileSync(path.join(repo, FILE), 'const a = 1;\n');
    git('add', '-A');
    git('commit', '-q', '-m', 'base');
  });
  afterEach(() => {
    try { fs.rmSync(repo, { recursive: true, force: true }); } catch { /* best effort */ }
  });

  const head = () => git('rev-parse', 'HEAD').trim();

  /** Two prompts submitted, so the OPEN turn is index 1. */
  const stateWithProbeFrom = (probeIndex: number) => {
    const abs = path.join(repo, FILE);
    const st = fs.statSync(abs);
    return {
      sessionId: 's', sessionTag: 's', repoPath: repo,
      prompts: ['first', 'second'],
      prePromptSha: head(),
      liveEdits: [],
      shellProbes: [{
        promptIndex: probeIndex,
        tree: repo,
        baselineSha: head(),
        stamps: [{ file: FILE, mtimeMs: st.mtimeMs, size: st.size }],
        command: 'sed -i "" s/a/b/ src/target.ts',
      }],
    } as any;
  };

  /** The next turn's write, landing after the probe was armed. */
  const writeAsNextTurn = () => {
    fs.writeFileSync(path.join(repo, FILE), 'const a = 1;\nconst b = 2;\nconst c = 3;\n');
  };

  const probedFiles = (state: any) =>
    (state.liveEdits || []).flatMap((e: any) => (e.edits || []).map((x: any) => x.file));

  it('does not file the next turn\'s write under the turn that armed it', () => {
    const state = stateWithProbeFrom(0); // armed in turn 0; turn 1 is open
    writeAsNextTurn();

    endShellProbe(state, { tool_name: 'Bash', tool_input: {} });

    // Was: one `command_probe` whole-file write of FILE, promptIndex 0.
    expect(probedFiles(state)).toEqual([]);
    expect((state.liveEdits || []).some((e: any) => e.promptIndex === 0)).toBe(false);
  });

  it('still records a write inside the OPEN turn\'s own probe', () => {
    // The control: identical setup, probe armed by the turn that is running.
    // Dropping stale probes must not disarm live ones.
    const state = stateWithProbeFrom(1);
    writeAsNextTurn();

    endShellProbe(state, { tool_name: 'Bash', tool_input: {} });

    expect(probedFiles(state)).toContain(FILE);
    expect((state.liveEdits || []).every((e: any) => e.promptIndex === 1)).toBe(true);
  });

  it('drains the probe list either way, so it cannot be re-resolved later', () => {
    const state = stateWithProbeFrom(0);
    writeAsNextTurn();

    endShellProbe(state, { tool_name: 'Bash', tool_input: {} });

    expect(state.shellProbes).toEqual([]);
  });
});
