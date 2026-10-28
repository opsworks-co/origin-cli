/**
 * A shell write that resolves a conflict is measured from what git LEFT in
 * the file, not from the turn's start (Origin TODO 1de72a6e).
 *
 * `git merge <branch>` stops on a conflict with the file holding both sides
 * and the markers — put there by git, in no commit. The turn's resolving
 * write (a heredoc, sed, `git checkout --theirs`) was measured from the turn's
 * shadow, so the row billed the turn the incoming branch's lines it kept, and
 * the files the merge brought in cleanly read as the turn's creations. Live
 * session 8a0a80ae turn 1: package.json and package-lock.json recorded as the
 * turn's `command_probe` edits from the turn's start to the conflicted text.
 *
 * endShellProbe now records what the stopped operation left in each file it
 * moved (as blobs, per turn); the probe, the shell window, the ledger and the
 * safety-net diff all read a file's before-state from there.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { beginShellProbe, endShellProbe } from '../commands/hooks/tool-use.js';
import { diffMeasuredFromGitLeft, gitLeftBeforeStatesForTurn } from '../commands/hooks.js';
import { gitLeftBlobsForTurn, gitLeftContent } from '../git-moved-files.js';

let repo = '';
const git = (...args: string[]) =>
  execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@x', '-c', 'commit.gpgsign=false', '-c', 'core.hooksPath=/dev/null', ...args], {
    cwd: repo, encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'],
  });
const write = (f: string, body: string) => {
  fs.mkdirSync(path.dirname(path.join(repo, f)), { recursive: true });
  fs.writeFileSync(path.join(repo, f), body);
};
const read = (f: string) => fs.readFileSync(path.join(repo, f), 'utf-8');

const INCOMING_LINE = 'export const b = 2; // audit';
const RESOLVED_LINE = 'export const c = 1; // resolved';

beforeEach(() => {
  repo = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'origin-tmp-conflict-')));
  git('init', '-q', '-b', 'main', '.');
  write('api/settings.ts', 'export const a = 1;\nexport const b = 1;\n');
  write('api/scheduler.ts', 'export const jobs = [];\n');
  git('add', '-A');
  git('commit', '-q', '-m', 'base');
  // The branch to merge: another session's work.
  git('checkout', '-q', '-b', 'feat/audit');
  write('api/settings.ts', `export const a = 1;\n${INCOMING_LINE}\n`);
  write('api/scheduler.ts', 'export const jobs = ["audit-retention"];\n');
  write('api/audit.ts', 'export const retention = 90;\n');
  git('add', '-A');
  git('commit', '-q', '-m', 'feat(audit): retention');
  // main moved on and conflicts with it in settings.ts only.
  git('checkout', '-q', 'main');
  write('api/settings.ts', 'export const a = 1;\nexport const b = 3; // api keys\n');
  git('commit', '-q', '-am', 'feat(api-keys): expiry');
});
afterEach(() => { fs.rmSync(repo, { recursive: true, force: true }); });

const stateAtTurnStart = (): any => ({
  sessionId: 's', sessionTag: 's', repoPath: repo,
  prompts: ['merge the audit branch'],
  prePromptSha: git('rev-parse', 'HEAD').trim(),
  liveEdits: [], shellProbes: [],
});

function run(state: any, id: string, command: string, act: () => void) {
  const input = { tool_name: 'Bash', tool_use_id: id, tool_input: { command } };
  beginShellProbe(state, input);
  act();
  endShellProbe(state, input);
}

const probeEdits = (state: any, file: string): any[] =>
  (state.liveEdits || []).filter((e: any) => e.promptIndex === 0)
    .flatMap((e: any) => (e.edits || []).filter((x: any) => x.file === file));

function mergeStopsOnConflict(state: any): string {
  run(state, 'tu-1', 'git merge feat/audit', () => {
    try { git('merge', 'feat/audit'); } catch { /* stops on the conflict */ }
  });
  const conflicted = read('api/settings.ts');
  expect(conflicted).toContain('<<<<<<<');
  return conflicted;
}

const resolved = `export const a = 1;\n${INCOMING_LINE}\n${RESOLVED_LINE}\n`;
function resolve(state: any) {
  run(state, 'tu-2', "cat > api/settings.ts <<'EOF'\n" + resolved + 'EOF', () => write('api/settings.ts', resolved));
}

describe('a merge that stops on a conflict', () => {
  it('records what git left in every file it moved, and none of them as the turn\'s edit', () => {
    const state = stateAtTurnStart();
    const conflicted = mergeStopsOnConflict(state);
    const left = gitLeftBlobsForTurn(state, 0, repo);
    expect([...left.keys()].sort()).toEqual(['api/audit.ts', 'api/scheduler.ts', 'api/settings.ts']);
    expect(gitLeftContent(state, 0, repo, 'api/settings.ts')).toBe(conflicted);
    expect(gitLeftContent(state, 0, repo, 'api/audit.ts')).toBe('export const retention = 90;\n');
    for (const f of ['api/audit.ts', 'api/scheduler.ts', 'api/settings.ts']) expect(probeEdits(state, f)).toEqual([]);
  });

  it('a file the command NAMED is the turn\'s act: nothing recorded for it', () => {
    const state = stateAtTurnStart();
    mergeStopsOnConflict(state);
    // Pick the incoming side of the conflict by name: a write of the turn's.
    run(state, 'tu-2', 'git checkout --theirs api/settings.ts', () => git('checkout', '--theirs', 'api/settings.ts'));
    const [edit] = probeEdits(state, 'api/settings.ts');
    expect(edit).toBeTruthy();
    // Measured from what the merge left — the conflict — not the turn's start.
    expect(edit.oldContent).toContain('<<<<<<<');
    expect(edit.newContent).toBe(`export const a = 1;\n${INCOMING_LINE}\n`);
    expect(edit.evidence).toBe('command_named');
  });
});

describe('the resolving shell write', () => {
  it('is measured from the conflicted file: its old content holds the markers', () => {
    const state = stateAtTurnStart();
    const conflicted = mergeStopsOnConflict(state);
    resolve(state);
    const edits = probeEdits(state, 'api/settings.ts');
    expect(edits).toHaveLength(1);
    expect(edits[0]).toMatchObject({ op: 'write', evidence: 'command_named', oldContent: conflicted, newContent: resolved });
  });

  it('a second write to the file is still measured from what git left', () => {
    const state = stateAtTurnStart();
    const conflicted = mergeStopsOnConflict(state);
    resolve(state);
    const again = resolved + 'export const d = 1;\n';
    run(state, 'tu-3', "cat > api/settings.ts <<'EOF'\n" + again + 'EOF', () => write('api/settings.ts', again));
    const edits = probeEdits(state, 'api/settings.ts');
    expect(edits).toHaveLength(1);
    expect(edits[0]).toMatchObject({ oldContent: conflicted, newContent: again });
  });

  it('gives the ledger and the shell window the same before-states: the conflict, and the clean files as git left them', () => {
    const state = stateAtTurnStart();
    const conflicted = mergeStopsOnConflict(state);
    resolve(state);
    const before = gitLeftBeforeStatesForTurn(repo, state, state.prePromptSha, 0);
    expect(before.get('api/settings.ts')).toBe(conflicted);
    expect(before.get('api/audit.ts')).toBe('export const retention = 90;\n');
    expect(before.get('api/scheduler.ts')).toBe('export const jobs = ["audit-retention"];\n');
  });

  it('re-measures the safety-net diff: the resolution alone, and not the files the merge brought in', () => {
    const state = stateAtTurnStart();
    mergeStopsOnConflict(state);
    resolve(state);
    // The shadow diff Stop builds: everything since the turn's start.
    const fromStart = git('diff', state.prePromptSha);
    expect(fromStart).toContain(`+${INCOMING_LINE}`);
    expect(fromStart).toContain('+export const retention = 90;');
    const measured = diffMeasuredFromGitLeft(repo, state, state.prePromptSha, 0, fromStart);
    const added = measured.split('\n').filter((l) => l.startsWith('+') && !l.startsWith('+++')).map((l) => l.slice(1));
    expect(added).toEqual([RESOLVED_LINE]);
    expect(measured).not.toContain('api/audit.ts');
    expect(measured).not.toContain('api/scheduler.ts');
    expect(measured).toContain('-<<<<<<< HEAD');
  });
});

describe('the operation is backed out', () => {
  it('`git merge --abort`: the files are back at the turn\'s start, the record is gone, nothing is the turn\'s', () => {
    const state = stateAtTurnStart();
    mergeStopsOnConflict(state);
    resolve(state);
    expect(probeEdits(state, 'api/settings.ts')).toHaveLength(1);
    run(state, 'tu-3', 'git merge --abort', () => git('merge', '--abort'));
    expect(read('api/settings.ts')).toBe('export const a = 1;\nexport const b = 3; // api keys\n');
    expect(probeEdits(state, 'api/settings.ts')).toEqual([]);
    expect(gitLeftBlobsForTurn(state, 0, repo).has('api/settings.ts')).toBe(false);
    expect(gitLeftBeforeStatesForTurn(repo, state, state.prePromptSha, 0).size).toBe(0);
    // A write after the abort is measured from the turn's start again.
    const fresh = 'export const a = 1;\nexport const b = 4;\n';
    run(state, 'tu-4', "cat > api/settings.ts <<'EOF'\n" + fresh + 'EOF', () => write('api/settings.ts', fresh));
    expect(probeEdits(state, 'api/settings.ts')[0]).toMatchObject({
      oldContent: 'export const a = 1;\nexport const b = 3; // api keys\n', newContent: fresh,
    });
  });

  it('backed out by hand (no probe saw it): a file that ends as it began gets no before-state', () => {
    const state = stateAtTurnStart();
    mergeStopsOnConflict(state);
    git('merge', '--abort');
    expect(gitLeftBeforeStatesForTurn(repo, state, state.prePromptSha, 0).size).toBe(0);
    const fromStart = git('diff', state.prePromptSha);
    expect(diffMeasuredFromGitLeft(repo, state, state.prePromptSha, 0, fromStart)).toBe(fromStart);
  });
});
