// Commit-coordinate line claims for the canonical attribution record (OR-45).
//
// A line is claimed only when replaying the turns' edits over the commit's
// parent blob lands exactly on the commit's blob AND git's own diff of the
// commit lists the line as an addition. Everything else degrades: the file is
// dropped with a reason, and the writer stays commit-level. These tests pin
// both halves — what gets claimed, and every way a claim is refused.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import {
  admitEditForLineClaim,
  parseCommitPatch,
  projectCommitLineClaims,
  type CapturedTurn,
  type CommitBindingSource,
  type LineClaimAdmissionContext,
} from '../attribution-line-ranges.js';
import { parseUnifiedZero } from '../final-state-blame.js';
import type { PromptEdit } from '../prompt-capture/types.js';

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf-8', windowsHide: true });
}

const rows = (from: number, to: number) =>
  Array.from({ length: to - from + 1 }, (_, i) => `Row ${from + i}`).join('\n') + '\n';

const toolEdit = (file: string, oldContent: string, newContent: string, extra: Partial<PromptEdit> = {}): PromptEdit =>
  ({ file, op: 'edit', oldContent, newContent, source: 'tool_call', evidence: 'tool_call', ...extra });

const toolWrite = (file: string, newContent: string, extra: Partial<PromptEdit> = {}): PromptEdit =>
  ({ file, op: 'write', newContent, source: 'tool_call', evidence: 'tool_call', ...extra });

// `null` = the prompt is not proven, so the turn carries no iteration.
const turn = (promptIndex: number, edits: PromptEdit[], iterationIndex: number | null = promptIndex): CapturedTurn =>
  iterationIndex === null ? { promptIndex, edits } : { promptIndex, iterationIndex, edits };

describe('projectCommitLineClaims', () => {
  let dir: string;

  const write = (rel: string, content: string | Buffer) => {
    const abs = path.join(dir, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content);
  };
  const commit = (msg: string): string => {
    git(dir, 'add', '-A');
    git(dir, 'commit', '-qm', msg);
    return git(dir, 'rev-parse', 'HEAD').trim();
  };
  const project = (
    sha: string,
    turns: CapturedTurn[],
    binding: CommitBindingSource | null = 'post-commit',
    soleSessionFiles?: Set<string>,
  ) => projectCommitLineClaims({ repoPath: dir, commitSha: sha, turns, binding, soleSessionFiles });

  beforeEach(() => {
    dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'origin-line-ranges-')));
    git(dir, 'init', '-q');
    git(dir, 'config', 'user.email', 't@t.co');
    git(dir, 'config', 'user.name', 'T');
    git(dir, 'config', 'commit.gpgsign', 'false');
  });
  afterEach(() => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ } });

  describe('with a parent commit', () => {
    beforeEach(() => {
      write('a.ts', rows(1, 10));
      commit('base');
    });

    it('claims the one line a single Edit changed, with its iteration', () => {
      write('a.ts', rows(1, 10).replace('Row 4\n', 'Row four\n'));
      const sha = commit('edit');
      const out = project(sha, [turn(0, [toolEdit('a.ts', 'Row 4', 'Row four')])]);
      expect(out.files).toEqual([{ path: 'a.ts', ranges: [{ start_line: 4, end_line: 4, iteration_index: 0 }] }]);
    });

    it('merges adjacent added lines into one inclusive range', () => {
      write('a.ts', rows(1, 2) + 'new A\nnew B\nnew C\n' + rows(3, 10));
      const sha = commit('insert');
      const out = project(sha, [turn(0, [toolEdit('a.ts', 'Row 2\n', 'Row 2\nnew A\nnew B\nnew C\n')])]);
      expect(out.files[0].ranges).toEqual([{ start_line: 3, end_line: 5, iteration_index: 0 }]);
    });

    it('keeps non-adjacent edits as separate ranges', () => {
      write('a.ts', rows(1, 10).replace('Row 2\n', 'Row two\n').replace('Row 8\n', 'Row eight\n'));
      const sha = commit('two edits');
      const out = project(sha, [turn(0, [toolEdit('a.ts', 'Row 2', 'Row two'), toolEdit('a.ts', 'Row 8', 'Row eight')])]);
      expect(out.files[0].ranges).toEqual([
        { start_line: 2, end_line: 2, iteration_index: 0 },
        { start_line: 8, end_line: 8, iteration_index: 0 },
      ]);
    });

    it('never merges adjacent lines of different iterations', () => {
      write('a.ts', rows(1, 10).replace('Row 3\nRow 4\n', 'Row three\nRow four\n'));
      const sha = commit('two prompts');
      const out = project(sha, [
        turn(1, [toolEdit('a.ts', 'Row 4', 'Row four')]),
        turn(0, [toolEdit('a.ts', 'Row 3', 'Row three')]),
      ]);
      expect(out.files[0].ranges).toEqual([
        { start_line: 3, end_line: 3, iteration_index: 0 },
        { start_line: 4, end_line: 4, iteration_index: 1 },
      ]);
    });

    it('omits iteration_index when the prompt is not proven, instead of guessing', () => {
      write('a.ts', rows(1, 10).replace('Row 5\n', 'Row five\n'));
      const sha = commit('edit');
      const out = project(sha, [turn(0, [toolEdit('a.ts', 'Row 5', 'Row five')], null)]);
      expect(out.files[0].ranges).toEqual([{ start_line: 5, end_line: 5 }]);
      expect(out.files[0].ranges[0]).not.toHaveProperty('iteration_index');
    });

    it('leaves lines a whole-file write kept unchanged unclaimed', () => {
      const next = rows(1, 10).replace('Row 6\n', 'Row six\n') + 'Row 11\n';
      write('a.ts', next);
      const sha = commit('rewrite');
      // The captured pre-image is exactly the replayed state.
      const out = project(sha, [turn(0, [toolWrite('a.ts', next, { oldContent: rows(1, 10) })])]);
      expect(out.files[0].ranges).toEqual([
        { start_line: 6, end_line: 6, iteration_index: 0 },
        { start_line: 11, end_line: 11, iteration_index: 0 },
      ]);
    });

    describe('a whole-file Write is proven only against the exact state it replaced (checkpoint 6.1)', () => {
      // Claude Code's Write carries no pre-image (`oldContent: ''`): it may have
      // read a file that already held lines nobody in this turn wrote.
      const claudeWrite = (file: string, content: string) => toolWrite(file, content, { oldContent: '' });

      it('an uncommitted human line before the Write is not claimed — the file is ambiguous', () => {
        // On disk before Claude: the human's line 3. Claude reads the file,
        // changes row 7 and writes it all back.
        const next = rows(1, 10).replace('Row 3\n', 'Row 3 human\n').replace('Row 7\n', 'Row seven\n');
        write('a.ts', next);
        const sha = commit('human + claude');
        const out = project(sha, [turn(0, [claudeWrite('a.ts', next)])]);
        expect(out.files).toEqual([]);
        expect(out.diagnostics).toContainEqual({ reason: 'ambiguous_replay', path: 'a.ts' });
      });

      it('another session\'s line before the Write is not claimed, with or without a stale pre-image', () => {
        const other = rows(1, 10).replace('Row 2\n', 'Row 2 other session\n');
        const next = other.replace('Row 9\n', 'Row nine\n');
        write('a.ts', next);
        const sha = commit('two sessions');
        const none = project(sha, [turn(0, [claudeWrite('a.ts', next)])]);
        expect(none.files).toEqual([]);
        expect(none.diagnostics).toContainEqual({ reason: 'ambiguous_replay', path: 'a.ts' });
        // A pre-image that is not byte for byte the replay state: a mismatch,
        // never a substring match.
        const stale = project(sha, [turn(0, [toolWrite('a.ts', next, { oldContent: other })])]);
        expect(stale.files).toEqual([]);
        expect(stale.diagnostics).toContainEqual({ reason: 'replay_mismatch', path: 'a.ts' });
        const partial = project(sha, [turn(0, [toolWrite('a.ts', next, { oldContent: 'Row 1\n' })])]);
        expect(partial.diagnostics).toContainEqual({ reason: 'replay_mismatch', path: 'a.ts' });
      });

      it('an earlier turn\'s line after an amend is not handed to the turn that rewrote the file', () => {
        // Turn 0 added "older line" and committed; that commit was amended
        // away, so its line is new again against the amended commit's parent.
        // Turn 1 Writes the whole file — the old line and its own.
        const next = rows(1, 10) + 'older line\nturn one line\n';
        write('a.ts', next);
        const amended = commit('amended');
        const out = project(amended, [turn(1, [claudeWrite('a.ts', next)])]);
        expect(out.files).toEqual([]);
        expect(out.diagnostics).toContainEqual({ reason: 'ambiguous_replay', path: 'a.ts' });
      });

      it('an exact captured pre-image claims only the lines the Write changed', () => {
        const next = rows(1, 10).replace('Row 5\n', 'Row five\n');
        write('a.ts', next);
        const sha = commit('exact');
        const out = project(sha, [turn(0, [toolWrite('a.ts', next, { oldContent: rows(1, 10) })])]);
        expect(out.files).toEqual([{ path: 'a.ts', ranges: [{ start_line: 5, end_line: 5, iteration_index: 0 }] }]);
        // `create` follows the same rule.
        const created = project(sha, [turn(0, [toolWrite('a.ts', next, { op: 'create', oldContent: rows(1, 10) })])]);
        expect(created.files).toEqual(out.files);
      });

      it('an empty file needs no pre-image', () => {
        write('fresh.ts', '');
        commit('empty file');
        write('fresh.ts', 'one\ntwo\n');
        const sha = commit('filled');
        for (const oldContent of [undefined, '']) {
          const out = project(sha, [turn(0, [toolWrite('fresh.ts', 'one\ntwo\n', { oldContent })])]);
          expect(out.files).toEqual([{ path: 'fresh.ts', ranges: [{ start_line: 1, end_line: 2, iteration_index: 0 }] }]);
        }
      });

      it('a file a non-root commit adds degrades: it may be a rename nobody captured', () => {
        // The diff is limited to the edited path, so Git cannot say whether
        // this "new" file was moved here; replaying it from empty could claim
        // every moved line. A root commit is the one place a file is surely new.
        write('fresh.ts', 'one\ntwo\n');
        const sha = commit('new file');
        for (const oldContent of [undefined, '']) {
          const out = project(sha, [turn(0, [toolWrite('fresh.ts', 'one\ntwo\n', { oldContent })])]);
          expect(out.files).toEqual([]);
          expect(out.diagnostics).toEqual([{ reason: 'possible_rename', path: 'fresh.ts' }]);
        }
      });

      it('a Write after the turn\'s own Edit is proven against the replayed state', () => {
        const mid = rows(1, 10).replace('Row 2\n', 'Row two\n');
        const next = mid.replace('Row 8\n', 'Row eight\n');
        write('a.ts', next);
        const sha = commit('edit then write');
        const out = project(sha, [turn(0, [toolEdit('a.ts', 'Row 2', 'Row two'), toolWrite('a.ts', next, { oldContent: mid })])]);
        expect(out.files).toEqual([{ path: 'a.ts', ranges: [{ start_line: 2, end_line: 2, iteration_index: 0 }, { start_line: 8, end_line: 8, iteration_index: 0 }] }]);
      });
    });

    it('claims nothing for a deletion-only change', () => {
      write('a.ts', rows(1, 10).replace('Row 7\n', ''));
      const sha = commit('delete a line');
      const out = project(sha, [turn(0, [toolEdit('a.ts', 'Row 7\n', '')])]);
      expect(out.files).toEqual([]);
      expect(out.diagnostics).toContainEqual({ reason: 'not_new_side', path: 'a.ts' });
    });

    it('claims only lines that are new-side additions of this commit', () => {
      // Prompt 0 changes rows 2 and 9; prompt 1 puts row 9 back. Replay says
      // prompt 1 wrote row 9, but the commit did not add it — so it is not claimed.
      write('a.ts', rows(1, 10).replace('Row 2\n', 'Row two\n'));
      const sha = commit('net one line');
      const out = project(sha, [
        turn(0, [toolEdit('a.ts', 'Row 2', 'Row two'), toolEdit('a.ts', 'Row 9', 'Row nine')]),
        turn(1, [toolEdit('a.ts', 'Row nine', 'Row 9')]),
      ]);
      expect(out.files[0].ranges).toEqual([{ start_line: 2, end_line: 2, iteration_index: 0 }]);
    });

    it('drops a file whose recorded "before" occurs twice in the replay state', () => {
      write('b.ts', 'x = 1\ny = 2\nx = 1\n');
      commit('repeated');
      write('b.ts', 'x = 1\ny = 2\nx = 10\n');
      const sha = commit('edit one of them');
      const out = project(sha, [turn(0, [toolEdit('b.ts', 'x = 1', 'x = 10')])]);
      expect(out.files).toEqual([]);
      expect(out.diagnostics).toContainEqual({ reason: 'ambiguous_replay', path: 'b.ts' });
    });

    it('isolates a replay mismatch to its own file', () => {
      write('b.ts', '');
      write('c.ts', '');
      commit('empty files');
      write('a.ts', rows(1, 10).replace('Row 3\n', 'Row three\n'));
      write('b.ts', 'human\n'); // not in any edit record
      write('c.ts', 'c1\n');
      const sha = commit('mixed');
      const out = project(sha, [
        turn(0, [toolEdit('a.ts', 'Row 3', 'Row three'), toolWrite('b.ts', 'agent\n'), toolWrite('c.ts', 'c1\n')]),
      ]);
      expect(out.files.map((f) => f.path)).toEqual(['a.ts', 'c.ts']);
      expect(out.diagnostics).toContainEqual({ reason: 'replay_mismatch', path: 'b.ts' });
    });

    describe('in a file someone else also changed in this commit', () => {
      it('keeps the agent range when a human adds a line below it', () => {
        write('a.ts', rows(1, 10).replace('Row 2\n', 'Row two\n').replace('Row 9\n', 'Row 9\nadded by hand\n'));
        const sha = commit('agent + human below');
        const out = project(sha, [turn(0, [toolEdit('a.ts', 'Row 2', 'Row two')])]);
        expect(out.files).toEqual([{ path: 'a.ts', ranges: [{ start_line: 2, end_line: 2, iteration_index: 0 }] }]);
        expect(out.diagnostics).toEqual([]);
      });

      it('keeps the agent range when a human replaces another line of the file', () => {
        write('a.ts', rows(1, 10).replace('Row 2\n', 'Row two\n').replace('Row 9\n', 'Row 9 by hand\n'));
        const sha = commit('agent + human replacement elsewhere');
        const out = project(sha, [turn(0, [toolEdit('a.ts', 'Row 2', 'Row two')])]);
        expect(out.files).toEqual([{ path: 'a.ts', ranges: [{ start_line: 2, end_line: 2, iteration_index: 0 }] }]);
      });

      it('moves the agent range to its commit coordinate when a human inserts above it', () => {
        write('a.ts', 'hand 1\nhand 2\n' + rows(1, 10).replace('Row 4\n', 'Row four\n'));
        const sha = commit('human above');
        const out = project(sha, [turn(0, [toolEdit('a.ts', 'Row 4', 'Row four')])]);
        expect(out.files).toEqual([{ path: 'a.ts', ranges: [{ start_line: 6, end_line: 6, iteration_index: 0 }] }]);
      });

      it('drops only the agent line a human then replaced', () => {
        write('a.ts', rows(1, 10).replace('Row 2\n', 'Row two\n').replace('Row 4\n', 'Row 4 rewritten by hand\n'));
        const sha = commit('human overwrote one agent line');
        const out = project(sha, [turn(0, [toolEdit('a.ts', 'Row 2', 'Row two'), toolEdit('a.ts', 'Row 4', 'Row four')])]);
        expect(out.files).toEqual([{ path: 'a.ts', ranges: [{ start_line: 2, end_line: 2, iteration_index: 0 }] }]);
      });

      it('drops the file when a human replaced the only agent line', () => {
        write('a.ts', rows(1, 10).replace('Row 4\n', 'Row 4 rewritten by hand\n'));
        const sha = commit('human overwrote the agent line');
        const out = project(sha, [turn(0, [toolEdit('a.ts', 'Row 4', 'Row four')])]);
        expect(out.files).toEqual([]);
        expect(out.diagnostics).toContainEqual({ reason: 'replay_mismatch', path: 'a.ts' });
      });

      it('claims nothing when duplicated content makes the agent line ambiguous', () => {
        // The agent wrote one "Row four"; a human pasted a second right after it.
        // Both are new-side additions, and either could be the agent's.
        write('a.ts', rows(1, 10).replace('Row 4\n', 'Row four\nRow four\n'));
        const sha = commit('human duplicated the agent line');
        const out = project(sha, [turn(0, [toolEdit('a.ts', 'Row 4', 'Row four')])]);
        expect(out.files).toEqual([]);
        expect(out.diagnostics).toContainEqual({ reason: 'replay_mismatch', path: 'a.ts' });
      });

      // Three prompts each write one identical line: the agent state is
      // [dup, dup, dup] owned by iterations 0, 1, 2, and a human turned one of
      // them into another line, so the commit has [dup, dup, human]. Any two of
      // the three agent lines pair with the two that remain, so no surviving
      // line has a provable writer. Agreement of one front-to-back and one
      // back-to-front alignment would wrongly credit iterations 0 and 1.
      const threeDupTurns = (firstLine: string) => [
        turn(0, [toolEdit('f.txt', 'head\n', `${firstLine}\ndup\n`)]),
        turn(1, [toolEdit('f.txt', 'dup\ntail', 'dup\ndup\ntail')]),
        turn(2, [toolEdit('f.txt', 'dup\ntail', 'dup\ndup\ntail')]),
      ];

      it('claims no line of [a,a,a] -> [a,a,b] whose iteration differs by alignment', () => {
        write('f.txt', 'head\ntail\n');
        commit('base f');
        write('f.txt', 'head\ndup\ndup\nhuman\ntail\n');
        const sha = commit('three prompts, one human');
        const out = project(sha, threeDupTurns('head'));
        expect(out.files).toEqual([]);
        expect(out.diagnostics).toContainEqual({ reason: 'replay_mismatch', path: 'f.txt' });
      });

      it('keeps a unique agent line next to an ambiguous [a,a,a] -> [a,a,b] block', () => {
        write('f.txt', 'head\ntail\n');
        commit('base f');
        write('f.txt', 'HEAD\ndup\ndup\nhuman\ntail\n');
        const sha = commit('unique line beside the ambiguous block');
        const out = project(sha, threeDupTurns('HEAD'));
        expect(out.files).toEqual([{ path: 'f.txt', ranges: [{ start_line: 1, end_line: 1, iteration_index: 0 }] }]);
      });

      it('keeps the unambiguous agent line beside an ambiguous one', () => {
        write('a.ts', rows(1, 10).replace('Row 2\n', 'Row two\n').replace('Row 6\n', 'Row six\nRow six\n'));
        const sha = commit('one clean, one duplicated');
        const out = project(sha, [turn(0, [toolEdit('a.ts', 'Row 2', 'Row two'), toolEdit('a.ts', 'Row 6', 'Row six')])]);
        expect(out.files).toEqual([{ path: 'a.ts', ranges: [{ start_line: 2, end_line: 2, iteration_index: 0 }] }]);
      });
    });

    describe('a prompt that produced several commits', () => {
      let shaA: string;
      let shaB: string;
      beforeEach(() => {
        write('a.ts', rows(1, 10).replace('Row 2\n', 'Row two\n'));
        shaA = commit('first commit of the prompt');
        write('a.ts', rows(1, 10).replace('Row 2\n', 'Row two\n').replace('Row 8\n', 'Row eight\n'));
        shaB = commit('second commit of the prompt');
      });

      it('projects each commit with only the edits stamped for it', () => {
        const turns = [turn(0, [
          toolEdit('a.ts', 'Row 2', 'Row two', { commitSha: shaA }),
          toolEdit('a.ts', 'Row 8', 'Row eight', { commitSha: shaB }),
        ])];
        const a = project(shaA, turns);
        expect(a.files).toEqual([{ path: 'a.ts', ranges: [{ start_line: 2, end_line: 2, iteration_index: 0 }] }]);
        expect(a.diagnostics).toEqual([{ reason: 'bound_to_other_commit', path: 'a.ts' }]);
        const b = project(shaB, turns);
        expect(b.files).toEqual([{ path: 'a.ts', ranges: [{ start_line: 8, end_line: 8, iteration_index: 0 }] }]);
      });

      it('accepts an abbreviated stamp of the target commit', () => {
        const turns = [turn(0, [
          toolEdit('a.ts', 'Row 2', 'Row two', { commitSha: shaA.slice(0, 7) }),
          toolEdit('a.ts', 'Row 8', 'Row eight', { commitSha: shaB.slice(0, 12) }),
        ])];
        expect(project(shaB, turns).files[0].ranges).toEqual([{ start_line: 8, end_line: 8, iteration_index: 0 }]);
      });

      it('does not let a foreign stamped edit break a local edit of another file', () => {
        write('b.ts', 'b only\n');
        write('c.ts', '');
        const shaC = commit('third commit');
        write('c.ts', 'c only\n');
        const shaD = commit('fourth commit');
        const out = project(shaD, [turn(0, [toolWrite('b.ts', 'b only\n', { commitSha: shaC }), toolWrite('c.ts', 'c only\n')])]);
        expect(out.files).toEqual([{ path: 'c.ts', ranges: [{ start_line: 1, end_line: 1, iteration_index: 0 }] }]);
        expect(out.diagnostics).toEqual([{ reason: 'bound_to_other_commit', path: 'b.ts' }]);
      });

      it('does not assume an unstamped edit belongs to the target commit', () => {
        // Unstamped, commit A's edit is still replayed for commit B — and its
        // "before" is no longer there, so B's file degrades instead of guessing.
        const turns = [turn(0, [toolEdit('a.ts', 'Row 2', 'Row two'), toolEdit('a.ts', 'Row 8', 'Row eight', { commitSha: shaB })])];
        const out = project(shaB, turns);
        expect(out.files).toEqual([]);
        expect(out.diagnostics).toContainEqual({ reason: 'replay_mismatch', path: 'a.ts' });
        // ...and the binding policy still applies to it.
        const transcriptOnly = project(shaB, [turn(0, [toolEdit('a.ts', 'Row 8', 'Row eight')])], 'transcript');
        expect(transcriptOnly.diagnostics).toEqual([{ reason: 'competing_session', path: 'a.ts' }]);
      });
    });

    it('claims the agent file and leaves a human-only file of the same commit alone', () => {
      write('a.ts', rows(1, 10).replace('Row 2\n', 'Row two\n'));
      write('human.ts', 'typed by hand\n');
      const sha = commit('agent + human file');
      const out = project(sha, [turn(0, [toolEdit('a.ts', 'Row 2', 'Row two')])]);
      expect(out.files).toEqual([{ path: 'a.ts', ranges: [{ start_line: 2, end_line: 2, iteration_index: 0 }] }]);
    });

    it('ignores oldStart/newStart entirely', () => {
      write('a.ts', rows(1, 10).replace('Row 4\n', 'Row four\n'));
      const sha = commit('edit');
      const plain = project(sha, [turn(0, [toolEdit('a.ts', 'Row 4', 'Row four')])]);
      const lying = project(sha, [turn(0, [toolEdit('a.ts', 'Row 4', 'Row four', { oldStart: 1, newStart: 999 })])]);
      expect(lying).toEqual(plain);
      expect(lying.files[0].ranges).toEqual([{ start_line: 4, end_line: 4, iteration_index: 0 }]);
    });

    it('reads the commit blob, not the working tree, after later edits', () => {
      write('a.ts', rows(1, 10).replace('Row 4\n', 'Row four\n'));
      const sha = commit('edit');
      write('a.ts', 'inserted later 1\ninserted later 2\n' + rows(1, 10).replace('Row 4\n', 'Row four\n'));
      const out = project(sha, [turn(0, [toolEdit('a.ts', 'Row 4', 'Row four')])]);
      expect(out.files[0].ranges).toEqual([{ start_line: 4, end_line: 4, iteration_index: 0 }]);
    });

    it('claims only the changed lines of a renamed file under its new path', () => {
      git(dir, 'mv', 'a.ts', 'moved.ts');
      write('moved.ts', rows(1, 10).replace('Row 5\n', 'Row five\n'));
      const sha = commit('rename + edit');
      const out = project(sha, [
        turn(0, [{ file: 'moved.ts', oldPath: 'a.ts', op: 'rename', source: 'tool_call', evidence: 'tool_call' },
          toolEdit('moved.ts', 'Row 5', 'Row five')]),
      ]);
      expect(out.files).toEqual([{ path: 'moved.ts', ranges: [{ start_line: 5, end_line: 5, iteration_index: 0 }] }]);
    });

    it('claims nothing for a pure rename', () => {
      git(dir, 'mv', 'a.ts', 'moved.ts');
      const sha = commit('pure rename');
      const out = project(sha, [
        turn(0, [{ file: 'moved.ts', oldPath: 'a.ts', op: 'rename', source: 'tool_call', evidence: 'tool_call' }]),
      ]);
      expect(out.files).toEqual([]);
      expect(out.diagnostics).toContainEqual({ reason: 'not_new_side', path: 'moved.ts' });
    });

    it('claims nothing for a deleted file', () => {
      fs.rmSync(path.join(dir, 'a.ts'));
      const sha = commit('delete');
      const out = project(sha, [turn(0, [{ file: 'a.ts', op: 'delete', oldContent: rows(1, 10), newContent: '', source: 'tool_call', evidence: 'tool_call' }])]);
      expect(out.files).toEqual([]);
    });

    it('drops binary, notebook and oversized files but keeps the rest', () => {
      for (const f of ['bin.dat', 'nb.ipynb', 'big.txt', 'ok.ts']) write(f, '');
      commit('empty files');
      write('bin.dat', Buffer.from([0x61, 0x00, 0x62, 0x0a]));
      write('nb.ipynb', '{\n  "cells": []\n}\n');
      const big = rows(1, 4100);
      write('big.txt', big);
      write('ok.ts', 'fine\n');
      const sha = commit('mixed kinds');
      const out = project(sha, [turn(0, [
        toolWrite('bin.dat', 'a\u0000b\n'),
        toolWrite('nb.ipynb', '{\n  "cells": []\n}\n'),
        toolWrite('big.txt', big),
        toolWrite('ok.ts', 'fine\n'),
      ])]);
      expect(out.files).toEqual([{ path: 'ok.ts', ranges: [{ start_line: 1, end_line: 1, iteration_index: 0 }] }]);
      expect(out.diagnostics).toEqual(expect.arrayContaining([
        { reason: 'binary_or_unreadable', path: 'bin.dat' },
        { reason: 'notebook', path: 'nb.ipynb' },
        { reason: 'oversized', path: 'big.txt' },
      ]));
    });

    it('drops a path git has to quote', () => {
      write('we"ird.ts', 'q\n');
      const sha = commit('quoted path');
      const out = project(sha, [turn(0, [toolWrite('we"ird.ts', 'q\n')])]);
      expect(out.files).toEqual([]);
      expect(out.diagnostics).toEqual([{ reason: 'unsafe_path' }]);
    });

    it('prefers the tool-call record over the commit patch for the same file', () => {
      write('a.ts', rows(1, 10).replace('Row 3\n', 'Row three\n'));
      const sha = commit('codex');
      const patchEdit: PromptEdit = {
        file: 'a.ts', op: 'edit', oldContent: rows(1, 10), newContent: rows(1, 10).replace('Row 3\n', 'Row three\n'),
        source: 'commit', commitSha: sha,
      };
      const out = project(sha, [turn(0, [toolEdit('a.ts', 'Row 3', 'Row three'), patchEdit])]);
      expect(out.files[0].ranges).toEqual([{ start_line: 3, end_line: 3, iteration_index: 0 }]);
    });

    it('drops a file two turns both claim through the commit patch', () => {
      const next = rows(1, 10).replace('Row 3\n', 'Row three\n');
      write('a.ts', next);
      const sha = commit('codex, two prompts');
      const patchEdit: PromptEdit = { file: 'a.ts', op: 'edit', oldContent: rows(1, 10), newContent: next, source: 'commit', commitSha: sha };
      const out = project(sha, [turn(0, [patchEdit]), turn(1, [patchEdit])]);
      expect(out.files).toEqual([]);
      expect(out.diagnostics).toContainEqual({ reason: 'conflicting_owner', path: 'a.ts' });
    });

    it('projects a commit-patch edit of an attested single-parent commit', () => {
      const next = rows(1, 10).replace('Row 3\n', 'Row three\n');
      write('a.ts', next);
      const sha = commit('codex');
      const patchEdit: PromptEdit = { file: 'a.ts', op: 'edit', oldContent: rows(1, 10), newContent: next, source: 'commit', commitSha: sha };
      expect(project(sha, [turn(0, [patchEdit])]).files[0].ranges).toEqual([{ start_line: 3, end_line: 3, iteration_index: 0 }]);
      expect(project(sha, [turn(0, [patchEdit])], 'transcript', new Set(['a.ts'])).files).toEqual([]);
    });

    it('unlocks a transcript binding only for a file no other session touched', () => {
      write('a.ts', rows(1, 10).replace('Row 4\n', 'Row four\n'));
      const sha = commit('cursor');
      const turns = [turn(0, [toolEdit('a.ts', 'Row 4', 'Row four')])];
      expect(project(sha, turns, 'transcript').files).toEqual([]);
      expect(project(sha, turns, 'transcript').diagnostics).toContainEqual({ reason: 'competing_session', path: 'a.ts' });
      expect(project(sha, turns, 'transcript', new Set(['a.ts'])).files).toHaveLength(1);
      expect(project(sha, turns, 'inferred', new Set(['a.ts'])).files).toEqual([]);
    });

    it('degrades the whole commit for a truncated capture, a missing binding or a bad sha', () => {
      write('a.ts', rows(1, 10).replace('Row 4\n', 'Row four\n'));
      const sha = commit('edit');
      const edits = [toolEdit('a.ts', 'Row 4', 'Row four')];
      expect(project(sha, [{ promptIndex: 0, iterationIndex: 0, edits, truncated: true }]))
        .toEqual({ files: [], diagnostics: [{ reason: 'capture_truncated' }] });
      expect(project(sha, [turn(0, edits)], null)).toEqual({ files: [], diagnostics: [{ reason: 'no_attested_binding' }] });
      expect(project('HEAD', [turn(0, edits)])).toEqual({ files: [], diagnostics: [{ reason: 'commit_unreadable' }] });
    });

    it('makes no claim from a write back-filled from the commit blob, even with a human line in it', () => {
      // A content-less Write (Cursor) filled from the very commit it is
      // checked against: the replay would match by construction.
      const next = rows(1, 10).replace('Row 3\n', 'Row three\n').replace('Row 9\n', 'typed by hand\n');
      write('a.ts', next);
      const sha = commit('backfilled');
      const out = project(sha, [turn(0, [toolWrite('a.ts', next, { oldContent: rows(1, 10), backfillSource: 'commit-blob' })])]);
      expect(out.files).toEqual([]);
      expect(out.diagnostics).toEqual([{ reason: 'path_only_edit', path: 'a.ts' }]);
    });

    it('refuses path-only and turn-window edits', () => {
      write('a.ts', rows(1, 10).replace('Row 4\n', 'Row four\n'));
      const sha = commit('edit');
      const out = project(sha, [turn(0, [
        { file: 'a.ts', op: 'edit', source: 'tool_call' },
        { file: 'a.ts', op: 'write', newContent: rows(1, 10).replace('Row 4\n', 'Row four\n'), source: 'uncommitted', evidence: 'turn_window' },
      ])]);
      expect(out.files).toEqual([]);
      expect(out.diagnostics).toEqual([
        { reason: 'path_only_edit', path: 'a.ts' },
        { reason: 'inference_only', path: 'a.ts' },
      ]);
    });

    it('never puts source or prompt text in its result', () => {
      write('a.ts', rows(1, 10).replace('Row 4\n', 'SECRET_LINE\n'));
      write('b.ts', 'SECRET_HUMAN\n');
      const sha = commit('edit');
      const out = project(sha, [turn(0, [toolEdit('a.ts', 'Row 4', 'SECRET_LINE'), toolWrite('b.ts', 'SECRET_AGENT\n')])]);
      expect(out.files).toHaveLength(1);
      expect(JSON.stringify(out)).not.toMatch(/SECRET|Row/);
    });
  });

  it('diffs a root commit against the empty tree', () => {
    write('first.ts', 'one\ntwo\n');
    const sha = commit('root');
    const out = project(sha, [turn(0, [toolWrite('first.ts', 'one\ntwo\n', { op: 'create', oldContent: '' })])]);
    expect(out.files).toEqual([{ path: 'first.ts', ranges: [{ start_line: 1, end_line: 2, iteration_index: 0 }] }]);
  });

  describe('a merge commit', () => {
    let mergeSha: string;
    beforeEach(() => {
      write('main.ts', rows(1, 5));
      commit('base');
      git(dir, 'checkout', '-q', '-b', 'side');
      write('side.ts', 'from side\n');
      commit('side work');
      git(dir, 'checkout', '-q', '-');
      git(dir, 'merge', '-q', '--no-ff', '--no-commit', 'side');
      write('main.ts', rows(1, 5).replace('Row 2\n', 'Row two\n'));
      mergeSha = commit('merge with a fix');
    });

    it('refuses the merged branch lines carried by the commit patch', () => {
      const patchEdit: PromptEdit = { file: 'side.ts', op: 'create', oldContent: '', newContent: 'from side\n', source: 'commit', commitSha: mergeSha };
      const out = project(mergeSha, [turn(0, [patchEdit])]);
      expect(out.files).toEqual([]);
      expect(out.diagnostics).toContainEqual({ reason: 'merge_commit', path: 'side.ts' });
    });

    it('keeps tool-call lines a first-parent replay proves', () => {
      const out = project(mergeSha, [turn(0, [toolEdit('main.ts', 'Row 2', 'Row two')])]);
      expect(out.files).toEqual([{ path: 'main.ts', ranges: [{ start_line: 2, end_line: 2, iteration_index: 0 }] }]);
    });

    it('does not reconcile partially on a merge: only an exact replay counts', () => {
      git(dir, 'checkout', '-q', '-b', 'side2', `${mergeSha}^1`);
      write('main.ts', rows(1, 5).replace('Row 5\n', 'Row 5 on side2\n'));
      commit('side2 work');
      git(dir, 'checkout', '-q', '-');
      git(dir, 'merge', '-q', '--no-ff', '--no-commit', 'side2');
      write('main.ts', rows(1, 5).replace('Row 2\n', 'Row two\n').replace('Row 3\n', 'Row three\n').replace('Row 5\n', 'Row 5 on side2\n'));
      const sha = commit('merge side2 with a fix');
      // The replay from the first parent misses side2's line, so nothing is claimed.
      const out = project(sha, [turn(0, [toolEdit('main.ts', 'Row 3', 'Row three')])]);
      expect(out.files).toEqual([]);
      expect(out.diagnostics).toContainEqual({ reason: 'replay_mismatch', path: 'main.ts' });
    });
  });
});

describe('admitEditForLineClaim', () => {
  const sha = 'a'.repeat(40);
  const ctx = (over: Partial<LineClaimAdmissionContext> = {}): LineClaimAdmissionContext =>
    ({ commitSha: sha, binding: 'post-commit', isMerge: false, soleSessionForFile: false, ...over });
  const withContent = (over: Partial<PromptEdit>): PromptEdit =>
    ({ file: 'f.ts', op: 'edit', oldContent: 'a', newContent: 'b', source: 'tool_call', ...over });
  const verdict = (edit: PromptEdit, c = ctx()) => {
    const v = admitEditForLineClaim(edit, c);
    return v.admitted ? v.tier : v.reason;
  };

  it('admits tool calls, with or without a recorded evidence value', () => {
    expect(verdict(withContent({ evidence: 'tool_call' }))).toBe('tool_call');
    expect(verdict(withContent({}))).toBe('tool_call');
    expect(verdict(withContent({}), ctx({ binding: 'trailer' }))).toBe('tool_call');
    expect(verdict(withContent({}), ctx({ isMerge: true }))).toBe('tool_call');
  });

  it('needs an attested binding or a sole session for transcript bindings', () => {
    expect(verdict(withContent({}), ctx({ binding: 'transcript' }))).toBe('competing_session');
    expect(verdict(withContent({}), ctx({ binding: 'transcript', soleSessionForFile: true }))).toBe('tool_call');
  });

  it('never lets an inferred or missing binding unlock a claim', () => {
    expect(verdict(withContent({}), ctx({ binding: 'inferred', soleSessionForFile: true }))).toBe('no_attested_binding');
    expect(verdict(withContent({}), ctx({ binding: null }))).toBe('no_attested_binding');
  });

  it('refuses edits with no content to replay, whatever their source says', () => {
    expect(verdict({ file: 'f.ts', op: 'edit', source: 'tool_call' })).toBe('path_only_edit');
    expect(verdict({ file: 'f.ts', op: 'write', source: 'tool_call', evidence: 'tool_call' })).toBe('path_only_edit');
  });

  it('refuses content Origin back-filled, whatever evidence it carries', () => {
    for (const backfillSource of ['commit-blob', 'live-file+reversed-1', 'transcript-reattributed-from-2']) {
      expect(verdict(withContent({ evidence: 'tool_call', backfillSource }))).toBe('path_only_edit');
      expect(verdict(withContent({ source: 'uncommitted', evidence: 'edit_hook', backfillSource }))).toBe('path_only_edit');
    }
    expect(verdict(withContent({ source: 'uncommitted', evidence: 'turn_window', backfillSource: 'shell-window' }))).toBe('inference_only');
  });

  it('never admits turn-window inference', () => {
    expect(verdict(withContent({ source: 'uncommitted', evidence: 'turn_window' }), ctx({ soleSessionForFile: true })))
      .toBe('inference_only');
  });

  it('admits the commit patch only for its own attested, non-merge commit', () => {
    const patch = withContent({ source: 'commit', commitSha: sha });
    expect(verdict(patch)).toBe('commit_patch');
    expect(verdict(withContent({ source: 'commit', commitSha: sha.toUpperCase() }))).toBe('commit_patch');
    expect(verdict(patch, ctx({ isMerge: true }))).toBe('merge_commit');
    expect(verdict(patch, ctx({ binding: 'transcript', soleSessionForFile: true }))).toBe('no_attested_binding');
    expect(verdict(withContent({ source: 'commit', commitSha: 'b'.repeat(40) }))).toBe('bound_to_other_commit');
    expect(verdict(withContent({ source: 'commit' }))).toBe('bound_to_other_commit');
  });

  it('admits edit_hook and command_named as scoped evidence, never on a merge', () => {
    for (const evidence of ['edit_hook', 'command_named'] as const) {
      expect(verdict(withContent({ source: 'uncommitted', evidence }))).toBe('scoped');
      expect(verdict(withContent({ source: 'uncommitted', evidence }), ctx({ isMerge: true }))).toBe('merge_commit');
      expect(verdict(withContent({ source: 'uncommitted', evidence }), ctx({ binding: 'transcript' }))).toBe('competing_session');
    }
  });

  it('admits command_probe and write_journal only with an attested binding and a sole session', () => {
    for (const evidence of ['command_probe', 'write_journal'] as const) {
      const e = withContent({ source: 'uncommitted', evidence });
      expect(verdict(e)).toBe('competing_session');
      expect(verdict(e, ctx({ soleSessionForFile: true }))).toBe('ambiguous');
      expect(verdict(e, ctx({ binding: 'transcript', soleSessionForFile: true }))).toBe('no_attested_binding');
      expect(verdict(e, ctx({ isMerge: true, soleSessionForFile: true }))).toBe('merge_commit');
    }
  });

  it('refuses any edit stamped with another commit, whatever its source or evidence', () => {
    const other = { commitSha: 'b'.repeat(40) };
    expect(verdict(withContent({ evidence: 'tool_call', ...other }))).toBe('bound_to_other_commit');
    expect(verdict(withContent({ source: 'uncommitted', evidence: 'edit_hook', ...other }))).toBe('bound_to_other_commit');
    expect(verdict(withContent({ source: 'uncommitted', evidence: 'command_probe', ...other }), ctx({ soleSessionForFile: true })))
      .toBe('bound_to_other_commit');
    expect(verdict(withContent({ commitSha: 'not-a-sha' }))).toBe('bound_to_other_commit');
  });

  it('admits an edit stamped with the target commit, in full or abbreviated', () => {
    expect(verdict(withContent({ commitSha: sha }))).toBe('tool_call');
    expect(verdict(withContent({ commitSha: sha.slice(0, 7).toUpperCase() }))).toBe('tool_call');
    // The commit patch still needs the full SHA.
    expect(verdict(withContent({ source: 'commit', commitSha: sha.slice(0, 12) }))).toBe('bound_to_other_commit');
  });

  it('applies the evidence and binding rules unchanged to an unstamped edit', () => {
    expect(verdict(withContent({}))).toBe('tool_call');
    expect(verdict(withContent({}), ctx({ binding: 'transcript' }))).toBe('competing_session');
  });

  it('refuses an uncommitted edit with no evidence recorded', () => {
    expect(verdict(withContent({ source: 'uncommitted' }), ctx({ soleSessionForFile: true }))).toBe('weak_evidence');
  });
});

describe('parseCommitPatch', () => {
  it('reads added lines, creations, deletions, renames and binaries', () => {
    const patch = [
      'diff --git a/src/a.ts b/src/a.ts',
      'index 1111111..2222222 100644',
      '--- a/src/a.ts',
      '+++ b/src/a.ts',
      '@@ -2 +2,2 @@',
      '-old',
      '+new',
      '+++plus-plus content',
      'diff --git a/new.ts b/new.ts',
      'new file mode 100644',
      'index 0000000..3333333',
      '--- /dev/null',
      '+++ b/new.ts',
      '@@ -0,0 +1 @@',
      '+hello',
      'diff --git a/gone.ts b/gone.ts',
      'deleted file mode 100644',
      'index 4444444..0000000',
      '--- a/gone.ts',
      '+++ /dev/null',
      '@@ -1 +0,0 @@',
      '-bye',
      'diff --git a/old name.ts b/new name.ts',
      'similarity index 100%',
      'rename from old name.ts',
      'rename to new name.ts',
      'diff --git a/img.png b/img.png',
      'index 5555555..6666666 100644',
      'Binary files a/img.png and b/img.png differ',
      'diff --git a/mod b/mod',
      'index 7777777..8888888 160000',
      '--- a/mod',
      '+++ b/mod',
      '@@ -1 +1 @@',
      '-Subproject commit 7777777',
      '+Subproject commit 8888888',
      '',
    ].join('\n');
    const byPath = (p: string | null) => parseCommitPatch(patch).find((f) => (f.path ?? f.oldPath) === p)!;

    expect([...byPath('src/a.ts').addedLines]).toEqual([2, 3]);
    expect(byPath('new.ts')).toMatchObject({ oldPath: null, nonText: false });
    expect([...byPath('new.ts').addedLines]).toEqual([1]);
    expect(byPath('gone.ts')).toMatchObject({ path: null, oldPath: 'gone.ts' });
    expect(byPath('new name.ts')).toMatchObject({ oldPath: 'old name.ts', unparseable: false });
    expect(byPath('new name.ts').addedLines.size).toBe(0);
    expect(byPath('img.png')).toMatchObject({ nonText: true, oldPath: 'img.png' });
    expect(byPath('mod')).toMatchObject({ nonText: true });
    expect(byPath('mod').addedLines.size).toBe(0);
  });

  it('marks a quoted path unparseable rather than guessing it', () => {
    const [f] = parseCommitPatch([
      'diff --git "a/we\\"ird.ts" "b/we\\"ird.ts"',
      'new file mode 100644',
      '--- /dev/null',
      '+++ "b/we\\"ird.ts"',
      '@@ -0,0 +1 @@',
      '+q',
    ].join('\n'));
    expect(f).toMatchObject({ path: null, unparseable: true });
  });
});

describe('parseUnifiedZero', () => {
  it('reads an added line whose own text starts with ++ by the hunk counts', () => {
    const hunks = parseUnifiedZero(['@@ -0,0 +1,3 @@', '+a', '+++b', '+c', '\\ No newline at end of file'].join('\n'));
    expect(hunks[0].added).toEqual([
      { line: 1, content: 'a' },
      { line: 2, content: '++b' },
      { line: 3, content: 'c' },
    ]);
  });

  it('reads a removed line whose own text starts with -- by the hunk counts', () => {
    const hunks = parseUnifiedZero(['@@ -1,2 +1 @@', '---x', '-y', '+z'].join('\n'));
    expect(hunks[0].added).toEqual([{ line: 1, content: 'z' }]);
  });
});
