/**
 * A turn that merges in the SQUASH of an earlier turn's own PR did not write it.
 *
 * Session a7740ea3 turn 15 is the shape #1661 only half closed. That turn
 * merged main into its PR branch and was credited with +284/-9 — #1659's code,
 * authored two turns earlier, arriving through the merge. #1661 clears the row
 * of a turn whose ONLY commit is a clean merge; a turn that merges and then
 * makes its own commit still takes the single-range path, and there the
 * inherited baseline is what has to keep the merged-in side out.
 *
 * It does not, because of who the squash belongs to. GitHub's squash of our own
 * PR keeps the branch commits' `Origin-Session` trailer, so
 * `commitBelongsToSession` calls it ours — correctly, at the SESSION level.
 * `isOwnWork` then reads that as "the turn being closed wrote it" and stops the
 * walk, which is the one thing it must not do: the squash is an EARLIER turn's
 * work, and this turn inherited it exactly as it inherits a stranger's.
 *
 * With every window commit counted as ours the walk finds nothing inherited at
 * all and falls through to the checkout-boundary rule, which hands back the
 * squash's PARENT — main before the PR. The turn is then measured from a tree
 * that predates its own session's earlier work, and re-reports it.
 *
 * `shell-window-does-not-author-its-own-squash.test.ts` records the same
 * misfire from the other side (it asserts the wrong baseline is returned and
 * relies on content-equality downstream to hide it). A turn that edits ON TOP
 * of the merge has no such shelter. Driven against real git.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { inheritedBaselineForTurn } from '../commands/hooks.js';
import { preferCommitPatchForCommittedTurns } from '../commit-patch-for-committed-turn.js';

const SESSION = 'a7740ea3-2f17-4c61-9a53-6f0a1c7b2e48';
const T_WROTE = 't_wrote_the_pr';
const T_MERGED = 't_merged_and_committed';

let repo: string, home: string, prevHome: string | undefined, prevUserProfile: string | undefined;

const git = (a: string[], env: Record<string, string> = {}): string =>
  execFileSync('git', a, { cwd: repo, stdio: 'pipe', encoding: 'utf-8', env: { ...process.env, ...env } }).trim();

const write = (f: string, c: string) => {
  fs.mkdirSync(path.dirname(path.join(repo, f)), { recursive: true });
  fs.writeFileSync(path.join(repo, f), c);
};

/** A turn shadow: the tree as it stood, parented on the real commit. */
function shadowAt(ref: string): string {
  const tree = git(['rev-parse', `${ref}^{tree}`]);
  return git(['commit-tree', tree, '-p', ref, '-m', 'origin shadow prompt-a7740ea3-2f1']);
}

const trailer = `Origin-Session: ${SESSION.slice(0, 12)} | Claude Code | 16 prompts`;

beforeEach(() => {
  prevHome = process.env.HOME; prevUserProfile = process.env.USERPROFILE;
  home = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'squash-inherit-home-')));
  process.env.HOME = home; process.env.USERPROFILE = home;
  repo = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'squash-inherit-repo-')));
  execFileSync('git', ['init', '-q', '-b', 'main', repo], { stdio: 'pipe' });
  git(['config', 'user.email', 'dev@test.dev']);
  git(['config', 'user.name', 'Dev']);
  git(['config', 'commit.gpgsign', 'false']);
  git(['config', 'core.hooksPath', path.join(repo, '.git', 'no-hooks')]);
  write('src/turn-index.ts', 'export const base = 1;\n');
  write('src/own.ts', 'export const own = 1;\n');
  git(['add', '.']); git(['commit', '-q', '-m', 'initial']);
});

afterEach(() => {
  if (prevHome === undefined) delete process.env.HOME; else process.env.HOME = prevHome;
  if (prevUserProfile === undefined) delete process.env.USERPROFILE; else process.env.USERPROFILE = prevUserProfile;
  fs.rmSync(repo, { recursive: true, force: true });
  fs.rmSync(home, { recursive: true, force: true });
});

/**
 * The session's earlier turn ships a PR; GitHub squashes it onto main, keeping
 * the trailer and committing as itself. Returns the branch commit and squash.
 */
function earlierTurnsPrAndItsSquash(): { base: string; pr: string; squash: string } {
  const base = git(['rev-parse', 'HEAD']);
  git(['checkout', '-q', '-b', 'fix/submit-time']);
  write('src/turn-index.ts', `export const base = 1;\n${Array.from({ length: 12 }, (_, i) => `export const carried${i} = ${i};`).join('\n')}\n`);
  git(['add', '.']);
  git(['commit', '-q', '-m', `fix(capture): a turn's row carries its submit time\n\n${trailer}`]);
  const pr = git(['rev-parse', 'HEAD']);
  const tree = git(['rev-parse', `${pr}^{tree}`]);
  const squash = git(['commit-tree', tree, '-p', base, '-m',
    `fix(capture): a turn's row carries its submit time (#1659)\n\n${trailer}`], {
    GIT_COMMITTER_NAME: 'GitHub', GIT_COMMITTER_EMAIL: 'noreply@github.com',
  });
  git(['update-ref', 'refs/heads/main', squash]);
  return { base, pr, squash };
}

/** The turn under test: merge main in, then commit its own work. */
function mergeThenCommit(): { shadow: string; merge: string; own: string; squash: string; base: string } {
  const { base, pr, squash } = earlierTurnsPrAndItsSquash();
  git(['checkout', '-q', 'fix/submit-time']);
  const shadow = shadowAt(pr);
  git(['merge', '-q', '--no-ff', '-m', `Merge main into fix/submit-time\n\n${trailer}`, 'main']);
  const merge = git(['rev-parse', 'HEAD']);
  write('src/own.ts', 'export const own = 1;\nexport const addedByThisTurn = true;\n');
  // ON TOP of what the merge brought in — the half no file-level exclusion can
  // drop, because the turn really did write to this file.
  write('src/turn-index.ts',
    `${fs.readFileSync(path.join(repo, 'src/turn-index.ts'), 'utf-8')}export const editedByThisTurn = true;\n`);
  git(['add', '.']);
  git(['commit', '-q', '-m', `fix(capture): this turn's own work\n\n${trailer}`]);
  const own = git(['rev-parse', 'HEAD']);
  return { shadow, merge, own, squash, base };
}

function stateFor(pr: string, merge: string, own: string, shadow: string) {
  return {
    sessionId: SESSION, sessionTag: 'a7740ea3-2f1', repoPath: repo, lastCwd: repo,
    startedAt: '2026-09-15T18:00:00.000Z',
    prompts: ['carry the submit time', 'merge main in and fix the rest'],
    promptTurnIds: [T_WROTE, T_MERGED],
    promptShadows: [{ promptIndex: 1, shadowSha: shadow }],
    promptIndexBase: 0,
    commitTurns: [
      { sha: pr, turnId: T_WROTE },
      { sha: merge, turnId: T_MERGED },
      { sha: own, turnId: T_MERGED },
    ],
    sessionCommitShas: [pr, merge, own],
    liveEdits: [],
  } as any;
}

describe('a merge that brings in the squash of an earlier turn', () => {
  it('starts the turn at the squash, not at main before the PR', () => {
    const { shadow, merge, own, squash, base } = mergeThenCommit();
    const pr = git(['rev-parse', `${shadow}^`]);
    const state = stateFor(pr, merge, own, shadow);

    const inherited = inheritedBaselineForTurn(repo, state, shadow, 1);

    expect(inherited).not.toBe(base);
    expect(inherited).toBe(squash);
  });

  it('credits the turn with its own commit only, not the merged-in side', () => {
    const { shadow, merge, own } = mergeThenCommit();
    const pr = git(['rev-parse', `${shadow}^`]);
    const state = stateFor(pr, merge, own, shadow);
    // What the shadow-window pass leaves on the row before this one runs:
    // baseline..HEAD, which is the merge's whole other side plus the edit.
    const mapping: any = {
      promptIndex: 1,
      filesChanged: ['src/turn-index.ts', 'src/own.ts'],
      diff: 'placeholder — replaced by the commit patch',
      linesAdded: 14,
      linesRemoved: 0,
    };

    preferCommitPatchForCommittedTurns(state, [mapping], repo, {
      inheritedBaseline: (shadowSha, localTurn) => inheritedBaselineForTurn(repo, state, shadowSha, localTurn),
    });

    // One line in each file, and none of the twelve the earlier turn wrote.
    expect(mapping.filesChanged.slice().sort()).toEqual(['src/own.ts', 'src/turn-index.ts']);
    expect(mapping.linesAdded).toBe(2);
    expect(mapping.linesRemoved).toBe(0);
    // The earlier turn's lines may appear as CONTEXT; none may be an addition.
    expect(mapping.diff).not.toMatch(/^\+export const carried/m);
  });
});
