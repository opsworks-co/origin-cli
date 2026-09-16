/**
 * A committed turn's commit patch survives the next prompt.
 *
 * Prod session e33b6ee1 (cli-v0.20260916.59). Stop replaced turn 6 (promptIndex
 * 5, 8596151de) and turn 7 (promptIndex 6, 1e2aecba) with their commit patches.
 * The next prompt's submit then re-sent both rows without `commitPatch`:
 *
 *   - persistCompletedMappings did not keep the flag, so every re-send from
 *     state was an unlabelled row;
 *   - the submit hook's retroactive capture replaced turn 7's mapping outright
 *     with its own rebuild from the session's commits.
 *
 * The server took both for rebuilds and the page fell back to the Edit calls:
 * +194/-34 for turn 6, and turn 7 lost hooks.ts, changed only through python.
 *
 * Separately, turn 7's commit patch kept whole-file context (hooks.ts is 4,666
 * lines), so its +21/-1 was a 249 KB section. Stop's 200 KB upload budget
 * dropped the file and declared it unavailable: "5 files · 4 shown".
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { persistCompletedMappings } from '../commands/hooks/stop.js';
import { previousMappingKept } from '../commands/hooks/user-prompt-submit.js';
import { preferCommitPatchForCommittedTurns } from '../commit-patch-for-committed-turn.js';
import { fitDiffToBudget } from '../diff-budget.js';
import { MAX_PROMPT_DIFF_LEN } from '../git-capture.js';

const DIFF = 'diff --git a/a.ts b/a.ts\n--- a/a.ts\n+++ b/a.ts\n@@ -1 +1 @@\n-old\n+new\n';

describe('the commit-patch flag survives the state round-trip', () => {
  it('is persisted, with the authority the merge pass gives an empty replacement', () => {
    const state: any = {};
    persistCompletedMappings({
      state,
      promptMappings: [
        { promptIndex: 5, promptText: 'p', filesChanged: ['a.ts'], diff: DIFF, uncommittedDiff: '', commitPatch: true, contentUnavailableFiles: [] },
        { promptIndex: 6, promptText: 'merge', filesChanged: [], diff: '', uncommittedDiff: '', commitPatch: true, contentAuthoritative: true },
        { promptIndex: 7, promptText: 'q', filesChanged: ['a.ts'], diff: DIFF, uncommittedDiff: '', contentAuthoritative: true },
      ] as any,
    });
    const [five, six, seven] = state.completedPromptMappings;
    expect(five.commitPatch).toBe(true);
    expect(five.contentAuthoritative).toBeUndefined();
    expect(six).toMatchObject({ commitPatch: true, contentAuthoritative: true });
    // Authority is not invented for a row that is not a commit patch.
    expect(seven.commitPatch).toBeUndefined();
    expect(seven.contentAuthoritative).toBeUndefined();
  });
});

describe('the retroactive capture of the previous prompt', () => {
  const rebuild = { diff: DIFF.replace('@@ -1 +1 @@', '@@ -1,1 +1,1 @@'), uncommittedDiff: '' };

  it('keeps Stop\'s commit patch instead of its own rebuild (the bug)', () => {
    expect(previousMappingKept({ diff: DIFF, uncommittedDiff: '', commitPatch: true }, rebuild)).toBe('commit patch');
  });

  it('still replaces it with work left uncommitted after the commit', () => {
    expect(previousMappingKept(
      { diff: DIFF, uncommittedDiff: '', commitPatch: true },
      { diff: DIFF, uncommittedDiff: 'diff --git a/b.ts b/b.ts\n+later\n' },
    )).toBeNull();
  });

  it('replaces an ordinary mapping, as before', () => {
    expect(previousMappingKept({ diff: 'x', uncommittedDiff: '' }, rebuild)).toBeNull();
    expect(previousMappingKept({ diff: 'x', chatOnly: true }, rebuild)).toBe('chat-only');
    expect(previousMappingKept({ diff: 'x' }, { diff: '', uncommittedDiff: '' })).toBe('new diff was empty');
  });
});

describe('a small change to a very large file', () => {
  let repo: string;
  const git = (...args: string[]) =>
    execFileSync('git', args, { cwd: repo, encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] }).toString().trim();

  beforeEach(() => {
    repo = fs.mkdtempSync(path.join(os.tmpdir(), 'origin-commit-patch-large-'));
    git('init', '-q', '-b', 'main');
    git('config', 'user.email', 't@t.t'); git('config', 'user.name', 'T');
    git('config', 'commit.gpgsign', 'false');
  });
  afterEach(() => { try { fs.rmSync(repo, { recursive: true, force: true }); } catch {} });

  it('stays whole on the wire: context steps down before the upload budget drops the file', () => {
    // hooks.ts in miniature: ~4,700 lines, one change in the middle.
    const lines = Array.from({ length: 4700 }, (_, i) => `export const line${i} = ${'x'.repeat(40)}; // ${i}`);
    fs.writeFileSync(path.join(repo, 'hooks.ts'), `${lines.join('\n')}\n`);
    fs.writeFileSync(path.join(repo, 'small.ts'), 'export const a = 1;\n');
    git('add', '-A'); git('commit', '-qm', 'base');
    const base = git('rev-parse', 'HEAD');
    lines[2350] = 'export const changedThroughPython = true;';
    fs.writeFileSync(path.join(repo, 'hooks.ts'), `${lines.join('\n')}\n`);
    fs.writeFileSync(path.join(repo, 'small.ts'), 'export const a = 2;\n');
    git('add', '-A'); git('commit', '-qm', 'turn');
    const sha = git('rev-parse', 'HEAD');

    const state = { promptTurnIds: ['t_0'], commitTurns: [{ sha, turnId: 't_0' }], promptShadows: [{ promptIndex: 0, shadowSha: base }] };
    // The ledger saw small.ts; hooks.ts was written through python.
    const pm: any = { promptIndex: 0, filesChanged: ['small.ts'], diff: 'diff --git a/small.ts b/small.ts\n-export const a = 1;\n+export const a = 2;\n', linesAdded: 1, linesRemoved: 1 };
    expect(preferCommitPatchForCommittedTurns(state, [pm], repo)).toBe(1);
    expect(pm.commitPatch).toBe(true);
    expect([pm.linesAdded, pm.linesRemoved]).toEqual([2, 2]);

    // What Stop does to it before the upload.
    const fit = fitDiffToBudget(pm.diff, MAX_PROMPT_DIFF_LEN);
    expect(fit.omittedFiles).toEqual([]);
    expect(fit.partialFiles).toEqual([]);
    expect(fit.diff).toContain('changedThroughPython');
    expect(pm.contentUnavailableFiles).toEqual([]);
  });
});
