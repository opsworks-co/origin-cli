/**
 * Checking out main's squash of this session's own PR is not the turn's work.
 *
 * Session c5487aa9 turn 10 ("don't wait for Windows, merge now") squash-merged
 * #1651 on GitHub and ran `git checkout --detach origin/main` from the PR
 * branch. The squash (c04e7809) holds the same tree as the branch it left, so
 * the turn's shadow → worktree window was empty. But the squash message
 * carries this session's Origin-Session trailer, so it counts as the turn's
 * own commit, and the inherited-baseline rule re-baselined the shell window to
 * the squash's parent — main before the PR:
 *
 *   [stop] shell window using inherited checkout baseline {"promptIndex":9,"shadow":"f2c28cf83e8b","inherited":"caa511eb7919"}
 *   [stop] shell window edits captured {"promptIndex":9,"files":7,...,"baseline":"caa511eb7919"}
 *
 * The PR's files were credited to turn 10, already counted on the turn that
 * wrote them. Driven against real git.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { inheritedBaselineForTurn, recordShellWindowEdits } from '../commands/hooks.js';

const SHELL_WINDOW_TOOL = 'origin:shell-window';
const SESSION = 'c5487aa9-8594-4af0-9bc3-42aafd775cc7';
const T_WROTE = 't_fix_carried_rows';
const T_MERGED = 't_merge_now';

let repo: string, home: string, prevHome: string | undefined, prevUserProfile: string | undefined;

const git = (a: string[], env: Record<string, string> = {}): string =>
  execFileSync('git', a, { cwd: repo, stdio: 'pipe', encoding: 'utf-8', env: { ...process.env, ...env } }).trim();

const write = (f: string, c: string) => {
  fs.mkdirSync(path.dirname(path.join(repo, f)), { recursive: true });
  fs.writeFileSync(path.join(repo, f), c);
};

function shadowAt(ref: string): string {
  const tree = git(['rev-parse', `${ref}^{tree}`]);
  return git(['commit-tree', tree, '-p', ref, '-m', 'origin shadow prompt-fb6151ba-bf4']);
}

function windowFiles(state: { liveEdits?: Array<{ toolName?: string; edits?: Array<{ file: string }> }> }): string[] {
  return (state.liveEdits || [])
    .filter((e) => e.toolName === SHELL_WINDOW_TOOL)
    .flatMap((e) => (e.edits || []).map((x) => x.file))
    .sort();
}

beforeEach(() => {
  prevHome = process.env.HOME; prevUserProfile = process.env.USERPROFILE;
  home = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'sw-squash-home-')));
  process.env.HOME = home; process.env.USERPROFILE = home;
  repo = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'sw-squash-repo-')));
  execFileSync('git', ['init', '-q', '-b', 'main', repo], { stdio: 'pipe' });
  git(['config', 'user.email', 'dev@test.dev']);
  git(['config', 'user.name', 'Dev']);
  git(['config', 'commit.gpgsign', 'false']);
  git(['config', 'core.hooksPath', path.join(repo, '.git', 'no-hooks')]);
  write('src/stop.ts', 'export const stop = 1;\n');
  write('package.json', '{ "version": "1" }\n');
  git(['add', '.']); git(['commit', '-q', '-m', 'initial']);
});

afterEach(() => {
  if (prevHome === undefined) delete process.env.HOME; else process.env.HOME = prevHome;
  if (prevUserProfile === undefined) delete process.env.USERPROFILE; else process.env.USERPROFILE = prevUserProfile;
  fs.rmSync(repo, { recursive: true, force: true });
  fs.rmSync(home, { recursive: true, force: true });
});

/** An earlier turn's PR commit, then GitHub's squash of it on main. */
function prAndItsSquash(): { pr: string; squash: string } {
  const base = git(['rev-parse', 'HEAD']);
  git(['checkout', '-q', '-b', 'fix/carried-rows']);
  write('src/drop-inherited-files.ts', 'export const drop = true;\n');
  write('src/stop.ts', 'export const stop = 1;\nexport const carried = true;\n');
  write('package.json', '{ "version": "2" }\n');
  git(['add', '.']);
  git(['commit', '-q', '-m', `fix(capture): carried rows\n\nOrigin-Session: ${SESSION.slice(0, 12)} | Claude Code | 6 prompts`]);
  const pr = git(['rev-parse', 'HEAD']);
  // GitHub's squash: the same tree on main, committed by GitHub, trailer kept.
  const tree = git(['rev-parse', `${pr}^{tree}`]);
  const squash = git(['commit-tree', tree, '-p', base, '-m',
    `fix(capture): carried rows (#1651)\n\nOrigin-Session: ${SESSION.slice(0, 12)} | Claude Code | 6 prompts`], {
    GIT_COMMITTER_NAME: 'GitHub', GIT_COMMITTER_EMAIL: 'noreply@github.com',
  });
  git(['update-ref', 'refs/heads/main', squash]);
  return { pr, squash };
}

function stateFor(pr: string) {
  return {
    sessionId: SESSION, sessionTag: 'fb6151ba-bf4', repoPath: repo, lastCwd: repo,
    startedAt: '2026-09-14T23:56:46.074Z',
    prompts: ['yes, fix the carried rows permanently', 'don\'t wait for Windows, merge now'],
    promptTurnIds: [T_WROTE, T_MERGED],
    commitTurns: [{ sha: pr, turnId: T_WROTE }],
    sessionCommitShas: [pr],
    liveEdits: [],
  } as any;
}

describe('the shell window does not author the squash of its own PR', () => {
  it('records nothing for a turn that only checked out the squash', () => {
    const { pr, squash } = prAndItsSquash();
    const shadow = shadowAt(pr);
    git(['checkout', '-q', '--detach', squash]);
    const state = stateFor(pr);

    // The rule that misfired read the squash as this turn's own commit and
    // re-baselined to its PARENT — main before the PR. The turn inherited the
    // squash, so the squash is where it began.
    expect(inheritedBaselineForTurn(repo, state, shadow, 1)).toBe(squash);

    recordShellWindowEdits(state, repo, 1, shadow);

    expect(windowFiles(state)).toEqual([]);
  });

  it('still records what the turn wrote after checking out the squash', () => {
    const { pr, squash } = prAndItsSquash();
    const shadow = shadowAt(pr);
    git(['checkout', '-q', '--detach', squash]);
    write('src/stop.ts', 'export const stop = 1;\nexport const carried = true;\nexport const later = true;\n');
    const state = stateFor(pr);

    recordShellWindowEdits(state, repo, 1, shadow);

    expect(windowFiles(state)).toEqual(['src/stop.ts']);
    const edit = (state.liveEdits || [])
      .flatMap((e: { edits?: Array<{ file: string; newContent?: string }> }) => e.edits || [])
      .find((e: { file: string }) => e.file === 'src/stop.ts');
    expect(edit?.newContent).toContain('later');
  });
});
