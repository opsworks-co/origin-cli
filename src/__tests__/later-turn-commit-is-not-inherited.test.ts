/**
 * A later turn's commit is not something an EARLIER turn inherited.
 *
 * capture-e2e-cursor-binary, replayed through the real ingest: turn 1 edits
 * app.py, turn 2 writes notes.md, turn 3 writes lib/helper.py and commits
 * everything with `git add -A`. At turn 3's Stop the ledger re-captured turns
 * 1 and 2 and logged
 *
 *   [ledger] turn capture taken from the write journal {promptIndex:0, inherited:3, files:0, netZero:1}
 *
 * `inheritedWindowDeps` listed the window as `baseline..HEAD`. For a completed
 * turn HEAD is past its end, so turn 3's commit sat in turn 1's window, was
 * attributed to ANOTHER turn, and counted as inherited: turn 1's before-state
 * became the committed app.py, its own edit read as net-zero, and the row was
 * sent — authoritatively, with its editsJson — as files [] +0/-0. The server
 * stored it that way and the Cursor session showed turns 1 and 2 as empty.
 *
 * `windowInheritsCommitsForTurn` already bounded a completed turn at its next
 * shadow ("a commit after the window closed belongs to a later turn"); the
 * before-state resolver the ledger uses did not. Driven against REAL git.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { createShadowCommit } from '../git-capture.js';
import { inheritedBeforeStatesForTurn, inheritedBaselineForTurn } from '../commands/hooks.js';

const TURNS = ['t_f42d99ff28944f0f', 't_1b0d6a5a97444e87', 't_dde1e031602c4d7c'];

let repo: string, home: string, prevHome: string | undefined, prevUserProfile: string | undefined;

const git = (...a: string[]): string =>
  execFileSync('git', a, { cwd: repo, stdio: 'pipe', encoding: 'utf-8' }).trim();

const write = (f: string, c: string) => {
  fs.mkdirSync(path.dirname(path.join(repo, f)), { recursive: true });
  fs.writeFileSync(path.join(repo, f), c);
};

function boundary(promptIndex: number, tag: string) {
  const shadow = createShadowCommit(repo, tag);
  return shadow
    ? { promptIndex, shadowSha: shadow }
    : { promptIndex, shadowSha: git('rev-parse', 'HEAD'), completeBaseline: true };
}

function stateFor(shadows: Array<{ promptIndex: number; shadowSha: string; completeBaseline?: boolean }>, commitTurns: Array<{ sha: string; turnId: string }>) {
  return {
    sessionId: 'e2e-cursor-session-0001',
    sessionTag: 'c0ffee00-e2e', repoPath: repo, lastCwd: repo,
    startedAt: new Date(Date.now() - 60_000).toISOString(),
    prompts: ['change the greeting', 'now leave a note', 'add a helper and commit it'],
    promptTurnIds: TURNS,
    promptShadows: shadows,
    sessionCommitShas: commitTurns.map((c) => c.sha),
    commitTurns,
  } as any;
}

beforeEach(() => {
  prevHome = process.env.HOME; prevUserProfile = process.env.USERPROFILE;
  home = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'later-commit-home-')));
  process.env.HOME = home; process.env.USERPROFILE = home;
  repo = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'later-commit-repo-')));
  execFileSync('git', ['init', '-q', '-b', 'main', repo], { stdio: 'pipe' });
  git('config', 'user.email', 'e2e@example.com');
  git('config', 'user.name', 'E2E');
  git('config', 'commit.gpgsign', 'false');
  git('config', 'core.hooksPath', path.join(repo, '.git', 'no-hooks'));
  write('app.py', 'def main():\n    print("old")\n\n\nmain()\n');
  git('add', '.'); git('commit', '-q', '-m', 'base');
});

afterEach(() => {
  process.env.HOME = prevHome; process.env.USERPROFILE = prevUserProfile;
  for (const d of [repo, home]) { try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* best effort */ } }
});

/** The cursor-binary shape: two uncommitted turns, then a third commits all of it. */
function threeTurnsThenCommit() {
  const t0 = boundary(0, 'prompt-0');
  write('app.py', 'def main():\n    print("new")\n\n\nmain()\n');
  const t1 = boundary(1, 'prompt-1');
  write('notes.md', 'remember this\n');
  const t2 = boundary(2, 'prompt-2');
  write('lib/helper.py', 'def helper():\n    return 1\n');
  git('add', '-A'); git('commit', '-q', '-m', 'add helper');
  const sha = git('rev-parse', 'HEAD');
  return { shadows: [t0, t1, t2], sha };
}

describe('a later turn\'s commit is not inherited by an earlier turn', () => {
  it('turn 1 keeps its own before-state after turn 3 commits its edit', () => {
    const { shadows, sha } = threeTurnsThenCommit();
    const state = stateFor(shadows, [{ sha, turnId: TURNS[2] }]);
    expect(inheritedBeforeStatesForTurn(repo, state, shadows[0].shadowSha, 0).size).toBe(0);
    expect(inheritedBaselineForTurn(repo, state, shadows[0].shadowSha, 0)).toBeNull();
  });

  it('turn 2 likewise', () => {
    const { shadows, sha } = threeTurnsThenCommit();
    const state = stateFor(shadows, [{ sha, turnId: TURNS[2] }]);
    expect(inheritedBeforeStatesForTurn(repo, state, shadows[1].shadowSha, 1).size).toBe(0);
  });

  it('the committing turn, still open, is not re-baselined past its own commit', () => {
    const { shadows, sha } = threeTurnsThenCommit();
    const state = stateFor(shadows, [{ sha, turnId: TURNS[2] }]);
    expect(inheritedBeforeStatesForTurn(repo, state, shadows[2].shadowSha, 2).size).toBe(0);
  });

  it('a pull INSIDE a completed turn\'s own window is still inherited', () => {
    // Someone else's commit, made before this session started.
    git('checkout', '-q', '-b', 'upstream');
    write('upstream.py', 'X = 1\n');
    git('add', 'upstream.py');
    execFileSync('git', ['commit', '-q', '-m', 'someone else'], {
      cwd: repo, stdio: 'pipe',
      env: {
        ...process.env,
        GIT_AUTHOR_NAME: 'Other', GIT_AUTHOR_EMAIL: 'other@example.com', GIT_AUTHOR_DATE: '2020-01-01T00:00:00Z',
        GIT_COMMITTER_NAME: 'Other', GIT_COMMITTER_EMAIL: 'other@example.com', GIT_COMMITTER_DATE: '2020-01-01T00:00:00Z',
      },
    });
    const upstream = git('rev-parse', 'HEAD');
    git('checkout', '-q', 'main');

    const t0 = boundary(0, 'prompt-0');
    write('app.py', 'def main():\n    print("new")\n\n\nmain()\n');
    git('merge', '-q', '--ff-only', upstream);       // the pull, inside turn 1
    const t1 = boundary(1, 'prompt-1');
    write('notes.md', 'later\n');
    const state = stateFor([t0, t1], []);
    const inherited = inheritedBeforeStatesForTurn(repo, state, t0.shadowSha, 0);
    expect([...inherited.keys()]).toContain('upstream.py');
  });
});
