/**
 * A committed turn's diff is the commit's patch.
 *
 * Prod vodka 5adc4b18 turn 8: the ledger rendered the turn's change with two
 * blank lines aligned as context where git aligns them as a delete/insert
 * pair. The turn card read +590/-630 under a badge reading +592/-632 — both
 * patches reproduce the committed file exactly, and the page still disagreed
 * with itself. Post-commit had sent git's answer; Stop overwrote it.
 *
 * Driven against REAL git: the rule turns on what `git diff` renders and on
 * whether the working tree matches a commit, which a stub cannot answer.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { preferCommitPatchForCommittedTurns, pathsInDiff } from '../commit-patch-for-committed-turn.js';
import { createShadowCommit, commitDiffScopedToPrompt } from '../git-capture.js';

let repo: string;
const git = (...args: string[]) =>
  execFileSync('git', args, { cwd: repo, encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] }).toString().trim();
const write = (f: string, c: string) => {
  fs.mkdirSync(path.dirname(path.join(repo, f)), { recursive: true });
  fs.writeFileSync(path.join(repo, f), c);
};

const OLD = ['import sys', '', 'RESET = 1', '', '', 'def main():', '    return 1', ''].join('\n');
const NEW = ['from card import RESET', '', '', 'def main():', '    return RESET', ''].join('\n');

// The ledger's rendering of OLD → NEW: the same change, aligned so that two
// blank lines stay as context. It applies cleanly; it is just not git's.
const LEDGER_DIFF = [
  'diff --git a/vodka.py b/vodka.py',
  '--- a/vodka.py',
  '+++ b/vodka.py',
  '@@ -1,7 +1,5 @@',
  '-import sys',
  '+from card import RESET',
  ' ',
  '-RESET = 1',
  ' ',
  ' ',
  ' def main():',
  '-    return 1',
  '+    return RESET',
  '',
].join('\n');

beforeEach(() => {
  repo = fs.mkdtempSync(path.join(os.tmpdir(), 'origin-commit-patch-'));
  git('init', '-q', '-b', 'main');
  git('config', 'user.email', 't@t.t'); git('config', 'user.name', 'T');
  git('config', 'commit.gpgsign', 'false');
  write('vodka.py', OLD); write('README.md', '# vodka\n');
  git('add', '-A'); git('commit', '-qm', 'base');
});
afterEach(() => { try { fs.rmSync(repo, { recursive: true, force: true }); } catch {} });

/** The turn's baseline as user-prompt-submit records it: a shadow of the
 *  dirty tree, or — on a clean tree, where createShadowCommit returns null —
 *  HEAD itself, which the pass reads from prePromptSha. */
const baselineNow = (tag: string) => createShadowCommit(repo, tag) || git('rev-parse', 'HEAD');

/** Turn 0 starts (baseline taken), rewrites vodka.py, commits. */
function committedTurn() {
  const shadowSha = baselineNow('turn0');
  write('vodka.py', NEW);
  git('add', '-A'); git('commit', '-qm', 'Extract the shared card.');
  const sha = git('rev-parse', 'HEAD');
  const state = {
    promptTurnIds: ['t_0'],
    commitTurns: [{ sha, turnId: 't_0' }],
    promptShadows: [{ promptIndex: 0, shadowSha }],
    prePromptSha: null,
  };
  const mapping = { promptIndex: 0, filesChanged: ['vodka.py'], diff: LEDGER_DIFF, uncommittedDiff: '', linesAdded: 3, linesRemoved: 3, diffSource: 'ledger' as const, ledgerOwned: true };
  return { shadowSha, sha, state, mapping };
}

describe('a turn whose work is entirely in its commit', () => {
  it('sends the commit patch, with git\'s line counts', () => {
    const { shadowSha, sha, state, mapping } = committedTurn();
    const expected = commitDiffScopedToPrompt(repo, shadowSha, sha, ['vodka.py'])!;
    // The fixture is only meaningful if git renders the change differently.
    expect(expected.diff).not.toBe(LEDGER_DIFF);

    const n = preferCommitPatchForCommittedTurns(state, [mapping], repo);
    expect(n).toBe(1);
    expect(mapping.diff).toBe(expected.diff);
    expect([mapping.linesAdded, mapping.linesRemoved]).toEqual([expected.linesAdded, expected.linesRemoved]);
    expect(mapping.filesChanged).toEqual(['vodka.py']);
    expect(mapping.uncommittedDiff).toBe('');
    // Provenance is untouched: still the turn's observed work.
    expect(mapping.diffSource).toBe('ledger');
    expect(mapping.ledgerOwned).toBe(true);
  });

  it('counts what the badge counts — the numbers the page compares', () => {
    const { state, mapping } = committedTurn();
    preferCommitPatchForCommittedTurns(state, [mapping], repo);
    const numstat = git('diff', '--numstat', 'HEAD~1', 'HEAD', '--', 'vodka.py').split('\t');
    expect([mapping.linesAdded, mapping.linesRemoved]).toEqual([Number(numstat[0]), Number(numstat[1])]);
  });

  it('picks up a file the commit carries that the ledger never saw', () => {
    const shadowSha = baselineNow('turn0');
    write('vodka.py', NEW);
    fs.appendFileSync(path.join(repo, 'README.md'), 'A shell wrote this.\n');
    git('add', '-A'); git('commit', '-qm', 'Extract the shared card.');
    const sha = git('rev-parse', 'HEAD');
    const state = { promptTurnIds: ['t_0'], commitTurns: [{ sha, turnId: 't_0' }], promptShadows: [{ promptIndex: 0, shadowSha }] };
    const mapping = { promptIndex: 0, filesChanged: ['vodka.py'], diff: LEDGER_DIFF, linesAdded: 3, linesRemoved: 3 };
    expect(preferCommitPatchForCommittedTurns(state, [mapping], repo)).toBe(1);
    expect(pathsInDiff(mapping.diff!).sort()).toEqual(['README.md', 'vodka.py']);
    expect(mapping.filesChanged).toEqual(pathsInDiff(mapping.diff!));
  });
});

describe('the ledger keeps the turn when it knows more than the commit', () => {
  it('commit-and-go: a file edited again after the commit', () => {
    const { state, mapping } = committedTurn();
    fs.appendFileSync(path.join(repo, 'vodka.py'), '# after the commit\n');
    expect(preferCommitPatchForCommittedTurns(state, [mapping], repo)).toBe(0);
    expect(mapping.diff).toBe(LEDGER_DIFF);
    expect([mapping.linesAdded, mapping.linesRemoved]).toEqual([3, 3]);
  });

  it('a file the turn wrote that the commit does not carry', () => {
    const { state, mapping } = committedTurn();
    write('notes.md', 'untracked\n');
    mapping.filesChanged = ['vodka.py', 'notes.md'];
    expect(preferCommitPatchForCommittedTurns(state, [mapping], repo)).toBe(0);
    expect(mapping.diff).toBe(LEDGER_DIFF);
  });

  it('only an amended-away sha on record — nothing reachable to point at', () => {
    const { state, mapping, sha } = committedTurn();
    write('vodka.py', NEW + '# amended\n');
    git('add', '-A'); git('commit', '-q', '--amend', '--no-edit');
    expect(git('rev-parse', 'HEAD')).not.toBe(sha);
    // commitTurns still names the orphan (the rescue has not run yet).
    expect(preferCommitPatchForCommittedTurns(state, [mapping], repo)).toBe(0);
    expect(mapping.diff).toBe(LEDGER_DIFF);
  });

  it('a turn with no commit', () => {
    const { mapping } = committedTurn();
    const state = { promptTurnIds: ['t_0'], commitTurns: [], promptShadows: [] };
    expect(preferCommitPatchForCommittedTurns(state, [mapping], repo)).toBe(0);
    expect(mapping.diff).toBe(LEDGER_DIFF);
  });

  it('a commit that only shipped an earlier turn\'s work', () => {
    // Turn 1 wrote, turn 2 committed: turn 2's baseline already holds the
    // change, so the scoped patch is empty and the ledger's answer stands.
    write('vodka.py', NEW);
    const shadowSha = createShadowCommit(repo, 'turn1')!;
    git('add', '-A'); git('commit', '-qm', 'ship it');
    const sha = git('rev-parse', 'HEAD');
    const state = { promptTurnIds: ['t_0', 't_1'], commitTurns: [{ sha, turnId: 't_1' }], promptShadows: [{ promptIndex: 1, shadowSha }] };
    const mapping = { promptIndex: 1, filesChanged: [], diff: '', linesAdded: 0, linesRemoved: 0 };
    expect(preferCommitPatchForCommittedTurns(state, [mapping], repo)).toBe(0);
    expect(mapping.diff).toBe('');
  });
});

describe('a mid-turn fast-forward does not become the turn\'s diff', () => {
  it('scopes to the commit\'s files, not the leaked baseline..HEAD list', () => {
    // Session 761adbe8 turn 5: the prompt landed on a stale checkout, then
    // the agent fast-forwarded onto main and authored 4 files. Stop rebuilt
    // the mapping as git diff <turn-baseline>..HEAD (41 files / +2615).
    // Diffing THAT file list from the turn baseline to the commit reproduces
    // the range — the number the commit badge disagrees with. The commit's
    // own name-only list is the 4 files the badge shows.
    const fork = git('rev-parse', 'HEAD');
    write('theirs.ts', 'export const leaked = 1;\n');
    git('add', '-A'); git('commit', '-qm', 'work from another PR');
    write('ours.ts', 'export const mine = 1;\n');
    git('add', 'ours.ts'); git('commit', '-qm', 'the turn\'s own commit');
    const sha = git('rev-parse', 'HEAD');

    const leaked = ['theirs.ts', 'ours.ts', 'vodka.py', 'README.md'];
    // The old pathspec (the mapping's file list) is what made the card flap:
    // baseline→commit over the leaked names includes the fast-forward.
    const leakedScoped = commitDiffScopedToPrompt(repo, fork, sha, leaked)!;
    expect(leakedScoped.diff).toContain('theirs.ts');
    expect(pathsInDiff(leakedScoped.diff).sort()).toEqual(['ours.ts', 'theirs.ts']);

    const state = {
      promptTurnIds: ['t_0'],
      commitTurns: [{ sha, turnId: 't_0' }],
      promptShadows: [{ promptIndex: 0, shadowSha: fork }],
      prePromptSha: fork,
    };
    const mapping = {
      promptIndex: 0,
      filesChanged: leaked,
      diff: leakedScoped.diff,
      uncommittedDiff: '',
      linesAdded: leakedScoped.linesAdded,
      linesRemoved: leakedScoped.linesRemoved,
    };

    expect(preferCommitPatchForCommittedTurns(state, [mapping], repo)).toBe(1);
    expect(mapping.filesChanged).toEqual(['ours.ts']);
    expect(mapping.diff).toContain('ours.ts');
    expect(mapping.diff).not.toContain('theirs.ts');
    expect(mapping.linesAdded).toBeGreaterThan(0);
  });
});

describe('a later Stop still owns a settled committed turn', () => {
  it('replaces even when this Stop is for a later prompt', () => {
    // Stop re-sends every turn with a newer stamp. Skipping a settled
    // turn left the reconstructed baseline..HEAD range on the wire
    // (session 761adbe8: +2615/41 files came back at session-end).
    const { state, mapping, sha } = committedTurn();
    const st = { ...state, commitTurns: [{ sha, turnId: 't_0', at: '2026-09-06T03:00:00.000Z' }] };
    const n = preferCommitPatchForCommittedTurns(st, [mapping], repo);
    expect(n).toBe(1);
    expect(mapping.diff).not.toBe(LEDGER_DIFF);
  });
});

describe('a resumed conversation: the mapping is a server row, the id and shadow are local', () => {
  it('finds the turn through the base', () => {
    // Prod 8a626742: base 21. Row 21 is local turn 0 — its id is
    // promptTurnIds[0] and its shadow is recorded at promptIndex 0.
    const { shadowSha, sha, state, mapping } = committedTurn();
    const expected = commitDiffScopedToPrompt(repo, shadowSha, sha, ['vodka.py'])!;
    const resumed = { ...state, promptIndexBase: 21 };
    const row21 = { ...mapping, promptIndex: 21 };
    expect(preferCommitPatchForCommittedTurns(resumed, [row21], repo)).toBe(1);
    expect(row21.diff).toBe(expected.diff);
  });

  it('THE BUG: a row from before the launch is not this launch\'s turn 0', () => {
    const { state, mapping } = committedTurn();
    const resumed = { ...state, promptIndexBase: 21 };
    const rowZero = { ...mapping, promptIndex: 0 };
    expect(preferCommitPatchForCommittedTurns(resumed, [rowZero], repo)).toBe(0);
    expect(rowZero.diff).toBe(LEDGER_DIFF);
  });
});
