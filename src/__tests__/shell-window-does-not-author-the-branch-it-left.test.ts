/**
 * The shell window must not bill a checkout-revert as this turn's work.
 *
 * Session 9a1ef9e3 prompt 6 ("implement permanent fix and open PR") ran
 * `git checkout -B … origin/main`. The ledger already cancelled that rewrite
 * via inheritedBaselineForTurn. The shell window still diffed the
 * pre-checkout shadow, so the API files from prompt 2 came back as inferred
 * edits: the turn card said +138/-132 over 9 files against a commit of
 * +120/-12 over 6.
 *
 * `filesLeftByOwnEarlierCommits` cannot catch this. It only drops a file
 * whose working tree still equals the earlier commit; after leaving the
 * branch it does not. The inherited destination IS that equality.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import {
  inheritedBaselineForTurn,
  recordShellWindowEdits,
} from '../commands/hooks.js';

const SHELL_WINDOW_TOOL = 'origin:shell-window';
const T_EARLIER = 't_api_empty_handshake';
const T_NOW = 't_dotfile_path_fix';

let repo: string, home: string, prevHome: string | undefined, prevUserProfile: string | undefined;

const git = (...a: string[]): string =>
  execFileSync('git', a, { cwd: repo, stdio: 'pipe', encoding: 'utf-8' }).trim();

const write = (f: string, c: string) => {
  fs.mkdirSync(path.dirname(path.join(repo, f)), { recursive: true });
  fs.writeFileSync(path.join(repo, f), c);
};

function shadowAt(ref: string): string {
  const tree = git('rev-parse', `${ref}^{tree}`);
  return git('commit-tree', tree, '-p', ref, '-m', 'origin shadow prompt-6');
}

function windowFiles(state: { liveEdits?: Array<{ toolName?: string; edits?: Array<{ file: string }> }> }): string[] {
  return (state.liveEdits || [])
    .filter((e) => e.toolName === SHELL_WINDOW_TOOL)
    .flatMap((e) => (e.edits || []).map((x) => x.file))
    .sort();
}

beforeEach(() => {
  prevHome = process.env.HOME; prevUserProfile = process.env.USERPROFILE;
  home = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'sw-home-')));
  process.env.HOME = home; process.env.USERPROFILE = home;
  repo = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'sw-repo-')));
  execFileSync('git', ['init', '-q', '-b', 'main', repo], { stdio: 'pipe' });
  git('config', 'user.email', 'dev@test.dev');
  git('config', 'user.name', 'Dev');
  git('config', 'core.hooksPath', path.join(repo, '.git', 'no-hooks'));

  write('src/session-cleanup.ts', 'export const old = 1;\n');
  write('src/git-capture.ts', 'export const base = 1;\n');
  git('add', '.'); git('commit', '-q', '-m', 'initial');
});

afterEach(() => {
  if (prevHome === undefined) delete process.env.HOME; else process.env.HOME = prevHome;
  if (prevUserProfile === undefined) delete process.env.USERPROFILE; else process.env.USERPROFILE = prevUserProfile;
  fs.rmSync(repo, { recursive: true, force: true });
  fs.rmSync(home, { recursive: true, force: true });
});

describe('the shell window does not author the branch it left', () => {
  it('does not infer an earlier turn\'s files after checking out main', () => {
    git('checkout', '-q', '-b', 'feature');
    write('src/session-cleanup.ts', 'export const old = 1;\nexport const handshake = true;\n');
    git('add', '.'); git('commit', '-q', '-m', 'fix(api): empty handshake');
    const earlier = git('rev-parse', 'HEAD');
    const shadow = shadowAt('HEAD');

    git('checkout', '-q', 'main');
    write('src/git-capture.ts', 'export const base = 1;\nexport const dotfiles = true;\n');

    const state = {
      sessionId: '9a1ef9e3', sessionTag: '9a1ef9e3', repoPath: repo, lastCwd: repo,
      startedAt: '2026-09-13T19:26:53.772Z',
      prompts: ['empty handshake', 'implement permanent fix and open PR'],
      promptTurnIds: [T_EARLIER, T_NOW],
      commitTurns: [{ sha: earlier, turnId: T_EARLIER }],
      liveEdits: [],
    } as any;

    expect(inheritedBaselineForTurn(repo, state, shadow, 1)).toBe(git('rev-parse', 'HEAD'));

    recordShellWindowEdits(state, repo, 1, shadow);

    expect(windowFiles(state)).toEqual(['src/git-capture.ts']);
    const edit = (state.liveEdits || [])
      .flatMap((e: { edits?: Array<{ file: string; oldContent?: string; newContent?: string }> }) => e.edits || [])
      .find((e: { file: string }) => e.file === 'src/git-capture.ts');
    expect(edit?.newContent).toContain('dotfiles');
    expect(edit?.oldContent).not.toContain('dotfiles');
  });

  it('still records the turn\'s own edit after it commits on the new branch', () => {
    git('checkout', '-q', '-b', 'feature');
    write('src/session-cleanup.ts', 'export const old = 1;\nexport const handshake = true;\n');
    git('add', '.'); git('commit', '-q', '-m', 'fix(api): empty handshake');
    const earlier = git('rev-parse', 'HEAD');
    const shadow = shadowAt('HEAD');

    git('checkout', '-q', 'main');
    write('src/git-capture.ts', 'export const base = 1;\nexport const dotfiles = true;\n');
    git('add', '.'); git('commit', '-q', '-m', 'fix(capture): read hidden repo paths');
    const ours = git('rev-parse', 'HEAD');

    const state = {
      sessionId: '9a1ef9e3', sessionTag: '9a1ef9e3', repoPath: repo, lastCwd: repo,
      startedAt: '2026-09-13T19:26:53.772Z',
      prompts: ['empty handshake', 'implement permanent fix and open PR'],
      promptTurnIds: [T_EARLIER, T_NOW],
      commitTurns: [
        { sha: earlier, turnId: T_EARLIER },
        { sha: ours, turnId: T_NOW },
      ],
      sessionCommitShas: [earlier, ours],
      liveEdits: [],
    } as any;

    recordShellWindowEdits(state, repo, 1, shadow);
    expect(windowFiles(state)).toEqual(['src/git-capture.ts']);
  });
});
