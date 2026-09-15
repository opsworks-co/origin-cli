/**
 * Inside a file a merge had to resolve, the merge is credited with the lines it
 * resolved — not with every hunk the other side brought into that file.
 * Driven against real git.
 *
 * Session c5487aa9's merge c5bd9889c merged main (#1649) into
 * fix/carried-rows-drop-inherited-files. stop.ts conflicted only on its import
 * lines, and the turn still read stop.ts +20/-2: #1649's import and its 17-line
 * native-commit recovery block, which git had merged on its own, rendered by
 * `git diff <first parent> <merge> -- stop.ts`.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { commitAuthoredDelta, mergeOwnDiff, oursSideOfConflicts } from '../history-backfill.js';
import { preferCommitPatchForCommittedTurns } from '../commit-patch-for-committed-turn.js';

let repo: string;
const git = (...args: string[]) =>
  execFileSync('git', args, { cwd: repo, encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] }).trim();
const write = (f: string, c: string) => fs.writeFileSync(path.join(repo, f), c);
// Twenty lines, so line 2 and line 17 sit in separate hunks.
const source = (changes: Record<number, string> = {}) =>
  Array.from({ length: 20 }, (_, i) => changes[i] ?? `line ${i}`).join('\n') + '\n';

function branch(name: string, content: string): void {
  git('checkout', '-q', 'main');
  git('checkout', '-qb', name);
  write('stop.ts', content);
  git('commit', '-qam', name);
}

/** Merge `theirs` into `ours` — a conflict on line 2 — and commit `resolved`. */
function mergeResolvedAs(resolved: string): string {
  branch('theirs', source({ 2: 'import theirs', 17: 'recovery block from theirs' }));
  branch('ours', source({ 2: 'import ours' }));
  let conflicted = false;
  try { git('merge', '-q', '--no-ff', '--no-commit', 'theirs'); } catch { conflicted = true; }
  expect(conflicted).toBe(true);
  write('stop.ts', resolved);
  git('add', '-A');
  git('commit', '-qm', 'merge theirs');
  return git('rev-parse', 'HEAD');
}

const added = (diff: string) => diff.split('\n').filter((l) => l[0] === '+' && !l.startsWith('+++'));
const removed = (diff: string) => diff.split('\n').filter((l) => l[0] === '-' && !l.startsWith('---'));

beforeEach(() => {
  repo = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'origin-merge-hunks-')));
  git('init', '-q', '-b', 'main');
  git('config', 'user.email', 'me@example.com');
  git('config', 'user.name', 'Me');
  git('config', 'commit.gpgsign', 'false');
  write('stop.ts', source());
  git('add', '-A');
  git('commit', '-qm', 'base');
});
afterEach(() => { try { fs.rmSync(repo, { recursive: true, force: true }); } catch { /* best effort */ } });

describe('mergeOwnDiff inside a conflicted file', () => {
  it('credits the resolved hunk, not the other side\'s distant hunk git merged', () => {
    const sha = mergeResolvedAs(source({ 2: 'import ours, theirs', 17: 'recovery block from theirs' }));

    const own = mergeOwnDiff(repo, sha)!;
    expect(own.filesChanged).toEqual(['stop.ts']);
    expect(own.diff).toMatch(/^diff --git a\/stop\.ts b\/stop\.ts$/m);
    expect(added(own.diff)).toEqual(['+import ours, theirs']);
    expect(removed(own.diff)).toEqual(['-import ours']);
    expect(own.diff).not.toContain('recovery block from theirs');

    const delta = commitAuthoredDelta(repo, sha);
    expect([delta.linesAdded, delta.linesRemoved]).toEqual([1, 1]);
  });

  it('measures the same way under a diff3 conflict style', () => {
    git('config', 'merge.conflictStyle', 'diff3');
    const sha = mergeResolvedAs(source({ 2: 'import ours, theirs', 17: 'recovery block from theirs' }));

    const own = mergeOwnDiff(repo, sha)!;
    expect(added(own.diff)).toEqual(['+import ours, theirs']);
    expect(removed(own.diff)).toEqual(['-import ours']);
  });

  it('credits nothing when the conflict was resolved to the first parent\'s side', () => {
    const sha = mergeResolvedAs(source({ 2: 'import ours', 17: 'recovery block from theirs' }));

    expect(mergeOwnDiff(repo, sha)).toEqual({ diff: '', filesChanged: [] });
  });

  it('still credits an edit the merger made outside the conflict', () => {
    const sha = mergeResolvedAs(source({
      2: 'import ours, theirs', 10: 'fixed while merging', 17: 'recovery block from theirs',
    }));

    const own = mergeOwnDiff(repo, sha)!;
    expect(added(own.diff).sort()).toEqual(['+fixed while merging', '+import ours, theirs']);
    expect(removed(own.diff).sort()).toEqual(['-import ours', '-line 10']);
    expect(own.diff).not.toContain('recovery block from theirs');
  });

  it('credits the merger for dropping a line the other side added', () => {
    const sha = mergeResolvedAs(source({ 2: 'import ours, theirs' }));

    const own = mergeOwnDiff(repo, sha)!;
    expect(added(own.diff).sort()).toEqual(['+import ours, theirs', '+line 17']);
    expect(removed(own.diff).sort()).toEqual(['-import ours', '-recovery block from theirs']);
  });
});

// Stop's commit-patch pass measured a merge-only turn from the merge's first
// parent too — the same +20/-2 by a second road.
describe('a turn whose only commit is that merge', () => {
  it('gets the resolution as its patch, not the other side\'s hunk', () => {
    const sha = mergeResolvedAs(source({ 2: 'import ours, theirs', 17: 'recovery block from theirs' }));
    const state = {
      promptTurnIds: ['t_0'],
      commitTurns: [{ sha, turnId: 't_0' }],
      promptShadows: [],
      prePromptSha: null,
    };
    const mapping = {
      promptIndex: 0, filesChanged: ['stop.ts'], diff: 'diff --git a/stop.ts b/stop.ts\n+ledger\n', uncommittedDiff: '',
      linesAdded: 2, linesRemoved: 1, diffSource: 'ledger' as const, ledgerOwned: true,
    };

    expect(preferCommitPatchForCommittedTurns(state, [mapping], repo)).toBe(1);
    expect(mapping.filesChanged).toEqual(['stop.ts']);
    expect([mapping.linesAdded, mapping.linesRemoved]).toEqual([1, 1]);
    // This pass renders full-file context, so the other side's line is there
    // as context — just never as a change.
    expect(added(mapping.diff)).toEqual(['+import ours, theirs']);
    expect(removed(mapping.diff)).toEqual(['-import ours']);
  });

  // Session a7740ea3 turn 15: `git merge origin/main` into a PR branch, the one
  // conflict kept on the branch's own side. The resolution is empty, the pass
  // declined, and the row kept the shadow window's +284/-9 — the other side.
  it('a clean merge authored nothing: the other side\'s lines are cleared from the row', () => {
    const sha = mergeResolvedAs(source({ 2: 'import ours', 17: 'recovery block from theirs' }));
    const state = { promptTurnIds: ['t_0'], commitTurns: [{ sha, turnId: 't_0' }], promptShadows: [], prePromptSha: null };
    const mapping: Record<string, any> = {
      promptIndex: 0, filesChanged: ['stop.ts'], diff: 'diff --git a/stop.ts b/stop.ts\n+recovery block from theirs\n',
      uncommittedDiff: '', linesAdded: 1, linesRemoved: 0, commitSha: sha,
    };

    expect(preferCommitPatchForCommittedTurns(state, [mapping as any], repo)).toBe(1);
    expect(mapping.diff).toBe('');
    expect(mapping.filesChanged).toEqual([]);
    expect([mapping.linesAdded, mapping.linesRemoved]).toEqual([0, 0]);
    expect(mapping.commitSha).toBe(sha);
    // Both flags, so the server accepts an EMPTY row over the stored one.
    expect(mapping.contentAuthoritative).toBe(true);
    expect(mapping.commitPatch).toBe(true);
  });

  it('keeps the row when the turn also left an edit uncommitted after the clean merge', () => {
    const sha = mergeResolvedAs(source({ 2: 'import ours', 17: 'recovery block from theirs' }));
    fs.appendFileSync(path.join(repo, 'stop.ts'), 'edited after the merge\n');
    const state = { promptTurnIds: ['t_0'], commitTurns: [{ sha, turnId: 't_0' }], promptShadows: [], prePromptSha: null };
    const diff = 'diff --git a/stop.ts b/stop.ts\n+edited after the merge\n';
    const mapping: Record<string, any> = { promptIndex: 0, filesChanged: ['stop.ts'], diff, uncommittedDiff: '', linesAdded: 1, linesRemoved: 0 };

    expect(preferCommitPatchForCommittedTurns(state, [mapping as any], repo)).toBe(0);
    expect(mapping.diff).toBe(diff);
    expect(mapping.commitPatch).toBeUndefined();
  });
});

describe('oursSideOfConflicts', () => {
  it('keeps the first side of each region, in every conflict style', () => {
    const merge = 'a\n<<<<<<< ours\nmine\n=======\nyours\n>>>>>>> theirs\nb\n';
    const diff3 = 'a\n<<<<<<< ours\nmine\n||||||| base\nold\n=======\nyours\n>>>>>>> theirs\nb\n';
    expect(oursSideOfConflicts(merge)).toBe('a\nmine\nb\n');
    expect(oursSideOfConflicts(diff3)).toBe('a\nmine\nb\n');
  });

  it('leaves text without markers — and ======= outside a region — alone', () => {
    const text = 'Title\n=======\nbody\n';
    expect(oursSideOfConflicts(text)).toBe(text);
  });

  it('matches separators by the opening marker\'s length', () => {
    const text = '<<<<<<<<< ours\nkeep\n=======\nstill ours\n=========\nyours\n>>>>>>>>> theirs\n';
    expect(oursSideOfConflicts(text)).toBe('keep\n=======\nstill ours\n');
  });

  it('handles CRLF files', () => {
    expect(oursSideOfConflicts('a\r\n<<<<<<< ours\r\nmine\r\n=======\r\nyours\r\n>>>>>>> theirs\r\n'))
      .toBe('a\r\nmine\r\n');
  });

  it('gives up on a region that never closes', () => {
    expect(oursSideOfConflicts('<<<<<<< ours\nmine\n=======\nyours\n')).toBeNull();
  });
});
