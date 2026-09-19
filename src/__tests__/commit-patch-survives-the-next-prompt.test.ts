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
import { previousMappingKept, lateWriteRecordsForTurn } from '../commands/hooks/user-prompt-submit.js';
import { preferCommitPatchForCommittedTurns } from '../commit-patch-for-committed-turn.js';
import { turnClosedByStop } from '../restored-from-history.js';
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

  // Session 874ff028 turn 6: Stop's row was right; a background job then
  // reverted the tree with a pathspec checkout and the next prompt landed
  // mid-revert. Nothing the agent did re-opened the turn after its Stop.
  it('keeps the mapping of a turn Stop closed and nothing re-opened', () => {
    const closed = { activeTurn: null, lastClosedTurnIndex: 5 };
    expect(previousMappingKept({ diff: 'x', uncommittedDiff: '' }, { diff: 'reverted tree', uncommittedDiff: 'y' }, closed, 5))
      .toBe('closed by stop');
    expect(turnClosedByStop(closed, 5)).toBe(true);
  });

  it('still recovers an interrupted turn: agent activity after its last Stop re-opened it', () => {
    const reopened = { activeTurn: { index: 5 }, lastClosedTurnIndex: 5 };
    expect(previousMappingKept({ diff: 'x', uncommittedDiff: '' }, rebuild, reopened, 5)).toBeNull();
    // Never closed at all (no Stop fired): recovered, as today.
    expect(previousMappingKept({ diff: 'x', uncommittedDiff: '' }, rebuild, { activeTurn: null, lastClosedTurnIndex: 4 }, 5)).toBeNull();
    expect(previousMappingKept({ diff: 'x', uncommittedDiff: '' }, rebuild, { activeTurn: null }, 5)).toBeNull();
  });

  it('a chat-only verdict yields to a turn that went on after its Stop — with a write record', () => {
    // Stop saved the turn blank + chatOnly. A background task then re-invoked
    // the agent, it wrote a file through the shell, and the user typed the
    // next prompt before another Stop. The blank used to be kept.
    const blank = { diff: '', uncommittedDiff: '', chatOnly: true };
    const late = { diff: 'diff --git a/app.py b/app.py\n+late\n', uncommittedDiff: '' };
    const reopened = { activeTurn: { index: 5 }, lastClosedTurnIndex: 5 };
    expect(previousMappingKept(blank, late, reopened, 5, true)).toBeNull();
    // …also when the blank is the inherited-files pass's authoritative one.
    expect(previousMappingKept({ ...blank, emptiedOfInheritedFiles: true, contentAuthoritative: true } as any, late, reopened, 5, true)).toBeNull();
  });

  it('re-opening alone is not enough: any tool re-opens a turn, a Read included', () => {
    // Without a write record the capture's content is whatever the tree holds —
    // another session's edits, a background job, a pull between turns. That is
    // what the chat-only rule exists to keep off a turn that touched no code.
    const blank = { diff: '', uncommittedDiff: '', chatOnly: true };
    const dirt = { diff: '', uncommittedDiff: 'diff --git a/stranger.txt b/stranger.txt\n+x\n' };
    const reopened = { activeTurn: { index: 5 }, lastClosedTurnIndex: 5 };
    expect(previousMappingKept(blank, dirt, reopened, 5, false)).toBe('chat-only');
    expect(previousMappingKept(blank, dirt, reopened, 5)).toBe('chat-only');
    // A write record, but some OTHER turn is the open one: the verdict stands.
    expect(previousMappingKept(blank, dirt, { activeTurn: { index: 6 }, lastClosedTurnIndex: 5 }, 5, true)).toBe('chat-only');
    // Closed and never re-opened: Stop's row is final, as before.
    expect(previousMappingKept(blank, dirt, { activeTurn: null, lastClosedTurnIndex: 5 }, 5, true)).toBe('closed by stop');
  });

  describe('what counts as a write record since the Stop', () => {
    const STOP = Date.parse('2026-09-18T10:00:00.000Z');
    const entry = (promptIndex: number, file: string, evidence: string, at: string) =>
      ({ promptIndex, capturedAt: at, edits: [{ file, evidence }] });
    const LATE = '2026-09-18T10:05:00.000Z';
    const EARLY = '2026-09-18T09:55:00.000Z';

    it('a shell write needs BOTH the write-shaped flag and its own probe window', () => {
      expect([...lateWriteRecordsForTurn({ shellWriteTurns: [5], liveEdits: [entry(5, 'app.py', 'command_probe', LATE)] }, 5, STOP)]).toEqual(['app.py']);
      expect(lateWriteRecordsForTurn({ shellWriteTurns: [], liveEdits: [entry(5, 'app.py', 'command_probe', LATE)] }, 5, STOP).size).toBe(0);
      expect(lateWriteRecordsForTurn({ shellWriteTurns: [5], liveEdits: [] }, 5, STOP).size).toBe(0);
      // Another turn's probe, or a journal sighting, says nothing about this turn.
      expect(lateWriteRecordsForTurn({ shellWriteTurns: [5], liveEdits: [entry(4, 'app.py', 'command_probe', LATE)] }, 5, STOP).size).toBe(0);
      expect(lateWriteRecordsForTurn({ shellWriteTurns: [5], liveEdits: [entry(5, 'stranger.txt', 'write_journal', LATE)] }, 5, STOP).size).toBe(0);
    });

    it('a tool edit or an edit hook is a record on its own', () => {
      expect([...lateWriteRecordsForTurn({ liveEdits: [entry(5, 'a.ts', 'tool_call', LATE), entry(5, 'b.ts', 'edit_hook', LATE)] }, 5, STOP)].sort()).toEqual(['a.ts', 'b.ts']);
    });

    it('a record from BEFORE the Stop is not evidence of late work', () => {
      // `printf >> b.py`, then `git checkout b.py`: Stop saves the turn
      // chat-only, but the probe entry survives the revert. Re-opened, the
      // turn used to be handed whatever happened to b.py next — a human's
      // edit included (review of #1726, reproduced through the binary).
      const state = { shellWriteTurns: [5], liveEdits: [entry(5, 'b.py', 'command_probe', EARLY), entry(5, 'c.ts', 'tool_call', EARLY)] };
      expect(lateWriteRecordsForTurn(state, 5, STOP).size).toBe(0);
      // The same records with no Stop time to beat (an older state file) still count.
      expect([...lateWriteRecordsForTurn(state, 5, undefined)].sort()).toEqual(['b.py', 'c.ts']);
    });

    it('a commit attested to the turn after the Stop brings its files', () => {
      const state = { promptTurnIds: ['t0', 't1', 't2', 't3', 't4', 't_five'], commitTurns: [
        { sha: 'late000', turnId: 't_five', at: LATE }, { sha: 'early00', turnId: 't_five', at: EARLY }, { sha: 'other00', turnId: 't_other', at: LATE },
      ] };
      const files = (sha: string) => [`${sha}.ts`];
      expect([...lateWriteRecordsForTurn(state, 5, STOP, files)]).toEqual(['late000.ts']);
    });
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
