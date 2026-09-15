/**
 * A turn's editsJson keeps only the watched writes its row names.
 *
 * Session 936ac5d1 turn 2 committed one file, +13/-5. A merge and a `git
 * switch` in the same turn rewrote three more, the write journal recorded each
 * as the turn's write, and the card synthesized from editsJson read four
 * files, +15/-56. Driven against real git, through the passes Stop runs, in
 * Stop's order.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { preferCommitPatchForCommittedTurns } from '../commit-patch-for-committed-turn.js';
import { preferShadowRangeForTurns } from '../prefer-shadow-range.js';
import { createTurnObserver, observeReconstruction } from '../resolve-turn.js';
import { createShadowCommit } from '../git-capture.js';
import { trimWatchedEdits, trimWatchedEditsForTurns } from '../trim-watched-edits.js';

let repo: string;
const git = (...args: string[]) =>
  execFileSync('git', args, { cwd: repo, encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] }).toString().trim();
const write = (f: string, c: string) => {
  fs.mkdirSync(path.dirname(path.join(repo, f)), { recursive: true });
  fs.writeFileSync(path.join(repo, f), c);
};
const commitAll = (msg: string) => { git('add', '-A'); git('commit', '-qm', msg); return git('rev-parse', 'HEAD'); };
const edit = (file: string, evidence: string, newContent = 'x\n') =>
  ({ file, op: 'write', newContent, source: 'uncommitted', evidence });
const files = (raw: string) => (JSON.parse(raw).edits as Array<{ file: string }>).map((e) => e.file).sort();

beforeEach(() => {
  repo = fs.mkdtempSync(path.join(os.tmpdir(), 'origin-trim-watched-'));
  git('init', '-q', '-b', 'main');
  git('config', 'user.email', 't@t.t'); git('config', 'user.name', 'T');
  git('config', 'commit.gpgsign', 'false');
  write('a.ts', 'a1\n'); write('b.ts', 'b1\n'); write('c.ts', 'c1\n');
  commitAll('base');
});
afterEach(() => { try { fs.rmSync(repo, { recursive: true, force: true }); } catch {} });

/** Stop's order: reconstruction observed, shadow window, commit patch, trim. */
function runStopPasses(state: any, mappings: any[], edits: Map<number, string>) {
  const observer = createTurnObserver();
  observeReconstruction(mappings, observer);
  preferShadowRangeForTurns(state, mappings, repo, { observe: observer.observe });
  preferCommitPatchForCommittedTurns(state, mappings, repo, { observe: observer.observe });
  const log: Array<[string, Record<string, unknown>]> = [];
  const trimmed = trimWatchedEditsForTurns(edits, mappings, (e, d) => log.push([e, d]));
  return { trimmed, log };
}

describe('a turn that commits one file while a checkout rewrites others', () => {
  it('keeps only the committed file\'s journal edits, and every tool call', () => {
    // Upstream work that lands in the turn's tree by a merge, not by the turn.
    git('checkout', '-qb', 'upstream');
    write('b.ts', 'b1\nb2 upstream\n'); write('c.ts', 'c1\nc2 upstream\n');
    commitAll('upstream: b and c');
    git('checkout', '-q', 'main');

    const baseline = createShadowCommit(repo, 'turn0') || git('rev-parse', 'HEAD');
    write('a.ts', 'a1\na2 turn\n');
    const c1 = commitAll('fix: a');
    // The rewrite: b.ts and c.ts change on disk inside the turn.
    git('merge', '-q', '--no-edit', 'upstream');
    expect(git('status', '--porcelain')).toBe('');

    const state = {
      promptTurnIds: ['t_0'],
      commitTurns: [{ sha: c1, turnId: 't_0' }],
      promptShadows: [{ promptIndex: 0, shadowSha: baseline }],
      prompts: ['fix a'],
      prePromptSha: null,
    };
    // What the reconstruction built before the passes: baseline..HEAD, so the
    // merge's files ride along with the turn's.
    const mapping: any = {
      promptIndex: 0,
      filesChanged: ['a.ts', 'b.ts', 'c.ts'],
      diff: `${git('diff', baseline, 'HEAD')}\n`, uncommittedDiff: '', linesAdded: 3, linesRemoved: 0,
    };
    const edits = new Map([[0, JSON.stringify({
      promptIndex: 0,
      edits: [
        edit('a.ts', 'write_journal', 'a1\na2 turn\n'),
        edit('b.ts', 'write_journal'),
        edit('c.ts', 'command_probe'),
        edit('c.ts', 'turn_window'),
        // The agent's own write outside the commit is authoring wherever it lands.
        edit('notes.md', 'tool_call'),
      ],
      finalHunks: [
        { file: 'a.ts', start: 2, lines: ['a2 turn'] },
        { file: 'b.ts', start: 2, lines: ['b2 upstream'] },
      ],
    })]]);

    const { trimmed, log } = runStopPasses(state, [mapping], edits);

    // The row is the commit's: one file.
    expect(mapping.filesChanged).toEqual(['a.ts']);
    expect([mapping.linesAdded, mapping.linesRemoved]).toEqual([1, 0]);
    expect(trimmed).toBe(1);
    const cap = JSON.parse(edits.get(0)!);
    expect(files(edits.get(0)!)).toEqual(['a.ts', 'notes.md']);
    expect(cap.finalHunks).toEqual([{ file: 'a.ts', start: 2, lines: ['a2 turn'] }]);
    expect(log[0][1]).toMatchObject({ promptIndex: 0, files: ['b.ts', 'c.ts'], count: 2 });
  });
});

describe('a hookless, shell-only turn with nothing git-scoped', () => {
  it('keeps every edit', () => {
    // No shadows, no commits: both passes decline, the row names no files.
    write('a.ts', 'a1\nshell\n'); write('b.ts', 'b1\nshell\n');
    const state = { promptTurnIds: ['t_0'], commitTurns: [], promptShadows: [], prompts: ['run it'] };
    const mapping: any = { promptIndex: 0, filesChanged: [], diff: '', uncommittedDiff: '' };
    const raw = JSON.stringify({
      promptIndex: 0,
      edits: [edit('a.ts', 'write_journal'), edit('b.ts', 'command_probe'), edit('c.ts', 'turn_window')],
    });
    const edits = new Map([[0, raw]]);

    const { trimmed } = runStopPasses(state, [mapping], edits);

    expect(trimmed).toBe(0);
    expect(edits.get(0)).toBe(raw);
  });
});

describe('trimWatchedEdits', () => {
  const raw = JSON.stringify({
    edits: [
      edit('a.ts', 'write_journal'), edit('b.ts', 'write_journal'),
      edit('c.ts', 'edit_hook'), edit('d.ts', 'command_named'), edit('e.ts', 'tool_call'),
      { file: 'f.ts', op: 'write', source: 'uncommitted' },
    ],
  });

  it('never drops tool calls, edit hooks, named commands or edits with no evidence', () => {
    const out = trimWatchedEdits(raw, { promptIndex: 0, filesChanged: ['a.ts'] });
    expect(out.dropped).toEqual(['b.ts']);
    expect(files(out.raw)).toEqual(['a.ts', 'c.ts', 'd.ts', 'e.ts', 'f.ts']);
  });

  it('reads the row\'s files from diff, uncommittedDiff and contentUnavailableFiles too', () => {
    const out = trimWatchedEdits(raw, {
      promptIndex: 0,
      diff: 'diff --git a/a.ts b/a.ts\n',
      uncommittedDiff: 'diff --git a/x.ts b/x.ts\n',
      contentUnavailableFiles: ['b.ts'],
    });
    expect(out.dropped).toEqual([]);
    expect(out.raw).toBe(raw);
  });

  it('a row that names no files drops nothing, as the API does on read', () => {
    // A shadow window that blanked the row, or a hookless turn git never saw:
    // either way there is no file set to scope the journal against.
    for (const row of [{ promptIndex: 0, filesChanged: [], diff: '', contentUnavailableFiles: [] }, { promptIndex: 0 }]) {
      expect(trimWatchedEdits(raw, row)).toEqual({ raw, dropped: [] });
    }
  });

  it('leaves a malformed payload alone', () => {
    expect(trimWatchedEdits('{nope', { promptIndex: 0, filesChanged: ['a.ts'] })).toEqual({ raw: '{nope', dropped: [] });
  });
});
