/**
 * A tree-moving command's files are git's in the PROBE channel too, not only in
 * the journal channel.
 *
 * Live session 4c7cbc7e (cli 0.20261021.2146), prompt 2, "merge them": the turn
 * checked out a PR branch and ran `git -c core.hooksPath=/dev/null rebase
 * <main>`, which stopped on a conflict. post-tool-use logged both halves of the
 * mistake one line apart:
 *
 *   tree-moving command — files recorded as git's   {files: 31}
 *   shell command probe captured                    {files: 13}
 *
 * The 13 were the PR's own files, left dirty by the stopped pick, conflict
 * markers included. They went out as `command_probe` edits of the turn; the
 * ledger then proved the turn wrote nothing (files 0, netZero 128), but a row
 * that names no files keeps every watched edit (trim-watched-edits.ts), so the
 * server synthesized a card of 9 files, +320/-26, "uncommitted" — another
 * session's PR, merged on main as 5383892e0, on a turn that only merged PRs.
 *
 * The journal channel already treated every touched file of a tree-moving
 * command as git's (`moved` includes `touched`); the probe recorded the same
 * files as the turn's. One rule now: a file a tree-moving command moved is
 * the turn's only when the command NAMED it.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { beginShellProbe, endShellProbe } from '../commands/hooks/tool-use.js';
import { recordJournalEdits } from '../commands/hooks/stop.js';
import { gitMovedFilesForTurn } from '../git-moved-files.js';

let repo = '';
const git = (...args: string[]) =>
  execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@x', '-c', 'commit.gpgsign=false', '-c', 'core.hooksPath=/dev/null', ...args], {
    cwd: repo, encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'],
  });
const write = (f: string, body: string) => {
  fs.mkdirSync(path.dirname(path.join(repo, f)), { recursive: true });
  fs.writeFileSync(path.join(repo, f), body);
};

beforeEach(() => {
  repo = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'origin-tmp-probe-')));
  git('init', '-q', '-b', 'main', '.');
  write('settings.ts', 'export const a = 1;\nexport const b = 1;\n');
  write('scheduler.ts', 'export const jobs = [];\n');
  git('add', '-A');
  git('commit', '-q', '-m', 'base');
  // The PR the turn rebases: another session's work.
  git('checkout', '-q', '-b', 'feat/audit');
  // The last line does not conflict: it applies cleanly even when the rebase stops.
  write('settings.ts', 'export const a = 1;\nexport const b = 2; // audit\nexport const retentionDays = 90;\n');
  write('scheduler.ts', 'export const jobs = ["audit-retention"];\n');
  write('audit.ts', 'export const retention = 90;\n');
  git('add', '-A');
  git('commit', '-q', '-m', 'feat(audit): retention');
  // main moves on and conflicts with it in settings.ts.
  git('checkout', '-q', 'main');
  write('settings.ts', 'export const a = 1;\nexport const b = 3; // api keys\n');
  git('commit', '-q', '-am', 'feat(api-keys): expiry');
  // The turn starts on a third branch: its own earlier commit.
  git('checkout', '-q', '-b', 'feat/trackers');
  write('trackers.ts', 'export const gtm = false;\n');
  git('add', '-A');
  git('commit', '-q', '-m', 'fix(security): trackers');
});
afterEach(() => { fs.rmSync(repo, { recursive: true, force: true }); });

const stateAtTurnStart = (): any => ({
  sessionId: 's', sessionTag: 's', repoPath: repo,
  prompts: ['merge them'],
  prePromptSha: git('rev-parse', 'HEAD').trim(),
  liveEdits: [], shellProbes: [],
});

function run(state: any, id: string, command: string, act: () => void) {
  const input = { tool_name: 'Bash', tool_use_id: id, tool_input: { command } };
  beginShellProbe(state, input);
  act();
  endShellProbe(state, input);
}

const probeEdits = (s: any) => (s.liveEdits || [])
  .filter((e: any) => e.promptIndex === 0)
  .flatMap((e: any) => e.edits || []);

describe('a rebase the turn ran is not the turn\'s edit', () => {
  it('a rebase stopped on a conflict leaves no probe edits for the PR\'s files', () => {
    const state = stateAtTurnStart();
    run(state, 'checkout', 'git checkout feat/audit', () => git('checkout', '-q', 'feat/audit'));
    run(state, 'rebase', 'git -c core.hooksPath=/dev/null rebase main', () => {
      try { git('rebase', 'main'); } catch { /* stops on the settings.ts conflict */ }
    });
    // The repro really is a stopped rebase with dirty, conflicted files.
    expect(fs.readFileSync(path.join(repo, 'settings.ts'), 'utf-8')).toContain('<<<<<<<');
    expect(git('status', '--porcelain')).toMatch(/settings\.ts/);

    expect(probeEdits(state).map((e: any) => e.file)).toEqual([]);
    const moved = gitMovedFilesForTurn(state, 0, repo);
    expect(moved.has('settings.ts')).toBe(true);
    expect(moved.has('scheduler.ts')).toBe(true);
  });

  it('a merge stopped on a conflict — HEAD never moved — leaves none either', () => {
    const state = stateAtTurnStart();
    const head = git('rev-parse', 'HEAD').trim();
    run(state, 'merge', 'git merge feat/audit', () => { try { git('merge', 'feat/audit'); } catch { /* conflict */ } });
    expect(git('rev-parse', 'HEAD').trim()).toBe(head);
    expect(fs.readFileSync(path.join(repo, 'settings.ts'), 'utf-8')).toContain('<<<<<<<');
    expect(probeEdits(state).map((e: any) => e.file)).toEqual([]);
  });

  it('a file the tree-moving command NAMED stays the turn\'s', () => {
    const state = stateAtTurnStart();
    run(state, 'named', 'echo "notes" > notes.md && git checkout -q main', () => {
      write('notes.md', 'notes\n');
      git('checkout', '-q', 'main');
    });
    expect(probeEdits(state).map((e: any) => e.file)).toEqual(['notes.md']);
  });

  it('an earlier command\'s real edit survives a later rebase that moves the same file', () => {
    const state = stateAtTurnStart();
    run(state, 'sed', 'sed -i.bak s/false/true/ trackers.ts', () => write('trackers.ts', 'export const gtm = true;\n'));
    git('commit', '-q', '-am', 'the turn\'s own commit');
    run(state, 'rebase', 'git rebase main', () => git('rebase', '-q', 'main'));
    expect(probeEdits(state).map((e: any) => e.file)).toEqual(['trackers.ts']);
  });

  it('a conflicted file the command names when it resolves it is the turn\'s', () => {
    const state = stateAtTurnStart();
    run(state, 'checkout', 'git checkout feat/audit', () => git('checkout', '-q', 'feat/audit'));
    run(state, 'rebase', 'git rebase main', () => { try { git('rebase', 'main'); } catch { /* conflict */ } });
    run(state, 'resolve', 'git checkout --theirs -- settings.ts', () => git('checkout', '--theirs', '--', 'settings.ts'));
    expect(probeEdits(state).map((e: any) => e.file)).toEqual(['settings.ts']);
  });

  it('a command that moves nothing still records what it wrote', () => {
    const state = stateAtTurnStart();
    run(state, 'sed', 'sed -i.bak s/false/true/ trackers.ts', () => write('trackers.ts', 'export const gtm = true;\n'));
    expect(probeEdits(state).map((e: any) => e.file)).toEqual(['trackers.ts']);
  });
});

/**
 * What the turn did to a file a STOPPED operation handed it is measured from
 * what git left, not from the turn's start (#2603). A shell resolution of a
 * conflicted file was measured from the turn's baseline, so every hunk the
 * incoming side applied cleanly — the other session's work — rode along as
 * the turn's lines. A clean checkout or pull is out of #2603's scope on
 * purpose (the state-file bound), so it has no case here.
 */
describe('a resolution is measured from the state git left the file in', () => {
  const editOf = (s: any, file: string, slot?: string) => (s.liveEdits || [])
    .filter((e: any) => e.promptIndex === 0 && (!slot || e.toolName === slot))
    .flatMap((e: any) => e.edits || [])
    .find((e: any) => e.file === file);

  function stopOnConflict(state: any) {
    run(state, 'checkout', 'git checkout feat/audit', () => git('checkout', '-q', 'feat/audit'));
    run(state, 'rebase', 'git rebase main', () => { try { git('rebase', 'main'); } catch { /* conflict */ } });
    expect(fs.readFileSync(path.join(repo, 'settings.ts'), 'utf-8')).toContain('<<<<<<<');
  }
  const RESOLVED = 'export const a = 1;\nexport const b = 3; // api keys + audit\nexport const retentionDays = 90;\n';

  it('a shell write that resolves a conflict is measured from the conflicted file', () => {
    const state = stateAtTurnStart();
    stopOnConflict(state);
    const conflicted = fs.readFileSync(path.join(repo, 'settings.ts'), 'utf-8');
    run(state, 'resolve', `cat > ${repo}/settings.ts <<'EOF'\n${RESOLVED}EOF`, () => write('settings.ts', RESOLVED));
    const e = editOf(state, 'settings.ts');
    expect(e, 'the resolution is the turn\'s edit').toBeTruthy();
    expect(e.oldContent).toBe(conflicted);
    expect(e.newContent).toBe(RESOLVED);
    // The incoming side's clean hunk is in the "before": not the turn's line.
    expect(e.oldContent).toContain('retentionDays');
  });

  it('a named checkout of one side is measured from the conflicted file too', () => {
    const state = stateAtTurnStart();
    stopOnConflict(state);
    const conflicted = fs.readFileSync(path.join(repo, 'settings.ts'), 'utf-8');
    run(state, 'theirs', 'git checkout --theirs -- settings.ts', () => git('checkout', '--theirs', '--', 'settings.ts'));
    expect(editOf(state, 'settings.ts')?.oldContent).toBe(conflicted);
  });

  it('a file the turn wrote before git moved it keeps the turn\'s start as its before', () => {
    const state = stateAtTurnStart();
    const start = fs.readFileSync(path.join(repo, 'trackers.ts'), 'utf-8');
    run(state, 'w1', `echo v1 > ${repo}/trackers.ts`, () => write('trackers.ts', 'v1\n'));
    git('commit', '-q', '-am', 'the turn\'s own commit');
    run(state, 'away', 'git checkout main', () => git('checkout', '-q', 'main'));
    run(state, 'back', 'git checkout feat/trackers', () => git('checkout', '-q', 'feat/trackers'));
    run(state, 'w2', `echo v2 > ${repo}/trackers.ts`, () => write('trackers.ts', 'v2\n'));
    const e = editOf(state, 'trackers.ts');
    expect(e?.oldContent).toBe(start);
    expect(e?.newContent).toBe('v2\n');
  });

  it('the write-journal channel measures a named resolution from the conflicted file', () => {
    const state = stateAtTurnStart();
    const t0 = Date.now() - 10_000;
    const journal = path.join(repo, '..', path.basename(repo) + '-journal.jsonl');
    Object.assign(state, { writeJournalPath: journal, currentTurnStartedAt: t0 });
    stopOnConflict(state);
    const conflicted = fs.readFileSync(path.join(repo, 'settings.ts'), 'utf-8');
    run(state, 'theirs', 'git checkout --theirs -- settings.ts', () => git('checkout', '--theirs', '--', 'settings.ts'));
    fs.writeFileSync(journal, JSON.stringify({ f: 'settings.ts', t: t0 + 100, h: 'x'.repeat(64), n: 1, m: t0 + 100 }) + '\n');
    try {
      recordJournalEdits(state, 0);
      expect(editOf(state, 'settings.ts', 'origin:write-journal')?.oldContent).toBe(conflicted);
    } finally { fs.rmSync(journal, { force: true }); }
  });
});
