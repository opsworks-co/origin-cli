/**
 * A turn that committed nothing must not be handed an earlier turn's commit.
 *
 * Session 04bfe29c is the case. Turn 8 ("merge it once CI is green and deploy")
 * merged a PR, pulled, deployed and built — it ran no edit tool at all — and
 * stored **10 files, +235/-19**, which is exactly
 * `git show --numstat e8c57189a` over those files: turn 3's own commit. Turn 3
 * had already captured it in full (14 files, +894/-34), so one session counted
 * the same work twice, and the duplicate was labelled `uncommitted` on a turn
 * that wrote nothing.
 *
 * The mechanism: the shell window diffs the working tree against the turn's
 * BASELINE. Turn 8's baseline shadow (`ed932bbbfe17`) had been cut with turn
 * 3's parent as its own parent, so every file that commit touched read as
 * changed-since-baseline. `filesLeftByForeignCommits` could not help — it asks
 * "is this commit someone else's?", and this one was ours.
 *
 * `state.commitTurns` already recorded the answer (`e8c57189a` →
 * `t_742efc905bd0451d` → turn 3); nothing asked it. The guard is at the
 * attribution layer rather than the baseline one deliberately: a baseline goes
 * stale in more ways than can be enumerated, and all of them produce this same
 * double count.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { filesLeftByOwnEarlierCommits, recordShellWindowEdits } from '../commands/hooks.js';

/** hooks.ts keeps this private; the ledger entry is identified by it. */
const SHELL_WINDOW_TOOL = 'origin:shell-window';

const T3 = 't_earlier_turn_three';
const T8 = 't_current_turn_eight';

let repo: string, home: string, prevHome: string | undefined, prevUserProfile: string | undefined;

const git = (...a: string[]): string =>
  execFileSync('git', a, { cwd: repo, stdio: 'pipe', encoding: 'utf-8' }).trim();

const write = (f: string, c: string) => {
  fs.mkdirSync(path.dirname(path.join(repo, f)), { recursive: true });
  fs.writeFileSync(path.join(repo, f), c);
};

/** A shadow cut BEFORE the earlier turn's commit — the stale baseline. */
function shadowAt(ref: string): string {
  const tree = git('rev-parse', `${ref}^{tree}`);
  return git('commit-tree', tree, '-p', ref, '-m', 'origin shadow (stale, from another tree)');
}

function baseState(overrides: Record<string, unknown> = {}) {
  return {
    sessionId: 'sess-dup', sessionTag: 'sess-dup', repoPath: repo, lastCwd: repo,
    startedAt: new Date().toISOString(), prompts: ['a', 'b'],
    liveEdits: [], shellWriteTurns: [8],
    promptTurnIds: { 3: T3, 8: T8 } as unknown as string[],
    commitTurns: [] as Array<{ sha: string; turnId: string }>,
    ...overrides,
  } as any;
}

beforeEach(() => {
  prevHome = process.env.HOME; prevUserProfile = process.env.USERPROFILE;
  home = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'dup-home-')));
  process.env.HOME = home; process.env.USERPROFILE = home;
  repo = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'dup-repo-')));
  execFileSync('git', ['init', '-q', '-b', 'main', repo], { stdio: 'pipe' });
  git('config', 'user.email', 'dev@test.dev');
  git('config', 'user.name', 'Dev');
  git('config', 'core.hooksPath', path.join(repo, '.git', 'no-hooks'));
  write('src/untouched.ts', 'export const a = 1;\n');
  git('add', '.'); git('commit', '-q', '-m', 'initial');
});

afterEach(() => {
  if (prevHome === undefined) delete process.env.HOME; else process.env.HOME = prevHome;
  if (prevUserProfile === undefined) delete process.env.USERPROFILE; else process.env.USERPROFILE = prevUserProfile;
  fs.rmSync(repo, { recursive: true, force: true });
  fs.rmSync(home, { recursive: true, force: true });
});

describe('the shell window does not re-claim an earlier turn of the same session', () => {
  it('absorbs a file left exactly as an earlier turn committed it', () => {
    const stale = shadowAt('HEAD');            // baseline cut BEFORE turn 3's commit
    write('src/feature.ts', 'export const feature = true;\n');
    git('add', '.'); git('commit', '-q', '-m', 'turn 3 work');
    const earlier = git('rev-parse', 'HEAD');

    const state = baseState({ commitTurns: [{ sha: earlier, turnId: T3 }] });
    const absorbed = filesLeftByOwnEarlierCommits(repo, state, stale, 8);
    expect([...absorbed]).toEqual(['src/feature.ts']);
  });

  it('keeps a file the CURRENT turn edited on top of that commit', () => {
    const stale = shadowAt('HEAD');
    write('src/feature.ts', 'export const feature = true;\n');
    git('add', '.'); git('commit', '-q', '-m', 'turn 3 work');
    const earlier = git('rev-parse', 'HEAD');
    // Turn 8 genuinely changes it further — content no longer matches the
    // commit, so it is this turn's work and must survive.
    write('src/feature.ts', 'export const feature = true;\nexport const more = 1;\n');

    const state = baseState({ commitTurns: [{ sha: earlier, turnId: T3 }] });
    expect([...filesLeftByOwnEarlierCommits(repo, state, stale, 8)]).toEqual([]);
  });

  it("keeps the CURRENT turn's own commit — committing your work is still doing it", () => {
    const stale = shadowAt('HEAD');
    write('src/feature.ts', 'export const feature = true;\n');
    git('add', '.'); git('commit', '-q', '-m', 'turn 8 committed its own work');
    const mine = git('rev-parse', 'HEAD');

    const state = baseState({ commitTurns: [{ sha: mine, turnId: T8 }] });
    expect([...filesLeftByOwnEarlierCommits(repo, state, stale, 8)]).toEqual([]);
  });

  it('says nothing about a commit no mapping claims — that is the foreign check\'s question', () => {
    const stale = shadowAt('HEAD');
    write('src/stranger.ts', 'export const x = 1;\n');
    git('add', '.'); git('commit', '-q', '-m', 'somebody else');

    const state = baseState({ commitTurns: [] });
    expect([...filesLeftByOwnEarlierCommits(repo, state, stale, 8)]).toEqual([]);
  });

  it('end to end: a no-edit turn on a stale baseline records NO window edits', () => {
    const stale = shadowAt('HEAD');
    write('src/feature.ts', 'export const feature = true;\n');
    write('src/second.ts', 'export const second = 2;\n');
    git('add', '.'); git('commit', '-q', '-m', 'turn 3 work');
    const earlier = git('rev-parse', 'HEAD');

    const state = baseState({ commitTurns: [{ sha: earlier, turnId: T3 }] });
    recordShellWindowEdits(state, repo, 8, stale);

    const win = (state.liveEdits || []).filter((e: any) => e.toolName === SHELL_WINDOW_TOOL);
    const files = win.flatMap((e: any) => (e.edits || []).map((x: any) => x.file));
    // Turn 8 ran no edit tool. Without the guard it takes both of turn 3's
    // files and the +lines that go with them.
    expect(files).toEqual([]);
  });
});
