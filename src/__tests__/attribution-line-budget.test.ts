// OR-45 checkpoint 6.4: line projection is best effort inside hooks, so it is
// bounded in time and in what it reads.
//
//   - ONE absolute deadline covers a whole lineClaimsForCommits call: git gets
//     only what is left of it, the replay and alignment loops check it, and
//     expiry degrades the commit (a commit-level note is still written);
//   - EVERY `diff-tree` covers only the paths the admitted edits name (and a
//     captured rename's old path), as literal pathspecs — a space, unicode, a
//     leading `:` or a glob character in a name is matched exactly, and an
//     unrelated added, deleted or large file is never scanned. A rename is
//     followed only when the capture names both sides; a path the commit adds
//     with no captured counterpart degrades (`possible_rename`).
//
// Time is an injected clock: nothing here sleeps.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { execFileSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';

/** Every git invocation the projector makes, with what it printed. */
const gitCalls: Array<{ args: string[]; timeoutMs?: number; out: string }> = [];
vi.mock('../utils/exec.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../utils/exec.js')>();
  const record = (args: string[], opts: { timeoutMs?: number } | undefined, out: string) => {
    gitCalls.push({ args, timeoutMs: opts?.timeoutMs, out });
    return out;
  };
  return {
    ...real,
    git: (args: string[], opts?: { timeoutMs?: number }) => record(args, opts, real.git(args, opts as any)),
    gitOrNull: (args: string[], opts?: { timeoutMs?: number }) => {
      const out = real.gitOrNull(args, opts as any);
      record(args, opts, out ?? '');
      return out;
    },
  };
});
vi.mock('../api.js', () => ({ api: { importGitNote: vi.fn(() => Promise.resolve({ ok: true })) } }));

const { projectCommitLineClaims, createProjectionDeadline } = await import('../attribution-line-ranges.js');
const { lineClaimsForCommits, LINE_CLAIM_BUDGET_MS } = await import('../attribution-line-claims.js');
const { writeGitNotes } = await import('../git-notes.js');
const { validateFull } = await import('../attribution-record.js');

const rows = (from: number, to: number) =>
  Array.from({ length: to - from + 1 }, (_, i) => `Row ${from + i}`).join('\n') + '\n';
const toolEdit = (file: string, oldContent: string, newContent: string) =>
  ({ file, op: 'edit' as const, oldContent, newContent, source: 'tool_call' as const, evidence: 'tool_call' as const });

let repo: string;
const git = (...args: string[]): string => execFileSync('git', args, { cwd: repo, encoding: 'utf-8', stdio: 'pipe' }).trim();
const write = (rel: string, content: string) => {
  fs.mkdirSync(path.dirname(path.join(repo, rel)), { recursive: true });
  fs.writeFileSync(path.join(repo, rel), content);
};
const commit = (msg: string): string => {
  git('add', '-A');
  git('commit', '-q', '-m', msg);
  return git('rev-parse', 'HEAD');
};

beforeEach(() => {
  repo = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'origin-line-budget-')));
  execFileSync('git', ['init', '-q', '-b', 'main', repo], { stdio: 'pipe' });
  git('config', 'user.email', 'dev@example.com');
  git('config', 'user.name', 'Dev');
  git('config', 'commit.gpgsign', 'false');
  write('a.ts', rows(1, 10));
  commit('base');
  gitCalls.length = 0;
});
afterEach(() => { try { fs.rmSync(repo, { recursive: true, force: true }); } catch { /* ignore */ } });

const sighting = (sha: string, turnId = 't0', at = '2026-10-16T10:00:00Z') => ({ sha, turnId, at, via: 'post-commit' as const });

describe('literal pathspecs: only the edited paths are diffed', () => {
  const diffTrees = () => gitCalls.filter((c) => c.args.includes('diff-tree'));
  const patchCall = () => diffTrees().find((c) => c.args.includes('-p'));
  /** What follows `--` in every diff-tree call; a call without `--` fails the test. */
  const pathspecsOfEveryDiffTree = () => diffTrees().map((c) => {
    const at = c.args.indexOf('--');
    expect(at, `diff-tree without a pathspec: ${c.args.join(' ')}`).toBeGreaterThan(-1);
    return c.args.slice(at + 1).sort();
  });

  it('matches a space, unicode, a leading colon and a glob character exactly', () => {
    const names = ['dir with space/a b.ts', 'ünïcödé.ts', ':colon.ts', '*.ts'];
    for (const n of names) write(n, 'one\n');
    write('decoy.ts', 'one\n'); // `*.ts` as a glob would take this too
    commit('files');
    for (const n of names) write(n, 'one\nagent\n');
    write('decoy.ts', 'one\nhuman\n');
    const sha = commit('agent lines');
    gitCalls.length = 0;
    const out = projectCommitLineClaims({
      repoPath: repo, commitSha: sha, binding: 'post-commit',
      turns: [{ promptIndex: 0, iterationIndex: 0, edits: names.map((n) => toolEdit(n, 'one\n', 'one\nagent\n')) }],
    });
    expect(out.files.map((f) => f.path).sort()).toEqual([...names].sort());
    for (const f of out.files) expect(f.ranges).toEqual([{ start_line: 2, end_line: 2, iteration_index: 0 }]);
    expect(pathspecsOfEveryDiffTree()).toEqual([names.map((n) => `:(literal)${n}`).sort()]);
    expect(patchCall()!.out).not.toContain('decoy.ts');
  });

  it('never scans an unrelated large, added or deleted file of the same commit', () => {
    write('gone/old.txt', 'y'.repeat(512 * 1024) + '\n');
    commit('a file the next commit deletes');
    write('a.ts', rows(1, 10).replace('Row 4\n', 'Row four\n'));
    write('big/generated.txt', 'x'.repeat(2 * 1024 * 1024) + '\n');
    fs.rmSync(path.join(repo, 'gone'), { recursive: true });
    const sha = commit('agent edit + generated file + deletion');
    gitCalls.length = 0;
    const out = projectCommitLineClaims({
      repoPath: repo, commitSha: sha, binding: 'post-commit',
      turns: [{ promptIndex: 0, iterationIndex: 0, edits: [toolEdit('a.ts', 'Row 4', 'Row four')] }],
    });
    expect(out.files).toEqual([{ path: 'a.ts', ranges: [{ start_line: 4, end_line: 4, iteration_index: 0 }] }]);
    // One diff-tree, limited to the edited path: no rename scan of the commit.
    expect(pathspecsOfEveryDiffTree()).toEqual([[':(literal)a.ts']]);
    expect(diffTrees().some((c) => c.args.includes('--name-status'))).toBe(false);
    // No call names the unrelated files, and no call printed their content.
    for (const name of ['generated.txt', 'old.txt']) {
      expect(gitCalls.some((c) => c.args.some((a) => a.includes(name))), name).toBe(false);
      expect(gitCalls.some((c) => c.out.includes(name)), name).toBe(false);
    }
    expect(gitCalls.some((c) => c.out.includes('xxxxxxxx') || c.out.includes('yyyyyyyy'))).toBe(false);
  });

  describe('a rename', () => {
    let sha: string;
    beforeEach(() => {
      write('old name.ts', rows(1, 10));
      commit('file to move');
      git('mv', 'old name.ts', 'new name.ts');
      write('new name.ts', rows(1, 10).replace('Row 6\n', 'Row six\n'));
      sha = commit('move + edit');
      gitCalls.length = 0;
    });
    const project = (edits: Array<Record<string, unknown>>) => projectCommitLineClaims({
      repoPath: repo, commitSha: sha, binding: 'post-commit', turns: [{ promptIndex: 0, iterationIndex: 0, edits: edits as any }],
    });

    it('is followed when the capture names both sides: both are in the literal pathspec, and -M pairs them', () => {
      const out = project([
        { file: 'new name.ts', oldPath: 'old name.ts', op: 'rename', source: 'tool_call', evidence: 'tool_call' },
        toolEdit('new name.ts', 'Row 6', 'Row six'),
      ]);
      expect(out.files).toEqual([{ path: 'new name.ts', ranges: [{ start_line: 6, end_line: 6, iteration_index: 0 }] }]);
      expect(pathspecsOfEveryDiffTree()).toEqual([[':(literal)new name.ts', ':(literal)old name.ts']]);
    });

    it('with no captured old side, degrades: the commit is not scanned for the counterpart', () => {
      const out = project([toolEdit('new name.ts', 'Row 6', 'Row six')]);
      expect(out.files).toEqual([]);
      expect(out.diagnostics).toContainEqual({ reason: 'possible_rename', path: 'new name.ts' });
      expect(pathspecsOfEveryDiffTree()).toEqual([[':(literal)new name.ts']]);
    });

    it('a human git mv followed by an agent Write with no pre-image claims none of the moved lines', () => {
      // Without the counterpart the file reads as new, and a Write replayed
      // from empty would reproduce the blob exactly — every moved line a claim.
      const whole = rows(1, 10).replace('Row 6\n', 'Row six\n');
      const out = project([{ file: 'new name.ts', op: 'write', oldContent: '', newContent: whole, source: 'tool_call', evidence: 'tool_call' }]);
      expect(out.files).toEqual([]);
      expect(out.diagnostics).toContainEqual({ reason: 'possible_rename', path: 'new name.ts' });
    });
  });
});

describe('one wall-clock deadline for the whole call', () => {
  const caps = (edits: ReturnType<typeof toolEdit>[], promptIndex = 0) => [{ promptIndex, edits }];

  it('is LINE_CLAIM_BUDGET_MS by default, at most 500 ms', () => {
    expect(LINE_CLAIM_BUDGET_MS).toBeLessThanOrEqual(500);
  });

  it('expired before any git: the commit is degraded, and no subprocess ran', () => {
    write('a.ts', rows(1, 10).replace('Row 4\n', 'Row four\n'));
    const sha = commit('edit');
    gitCalls.length = 0;
    const state = { promptTurnIds: ['t0'], commitTurns: [sighting(sha)] };
    const decisions = lineClaimsForCommits(repo, 'claude-code', state as any, [sha], caps([toolEdit('a.ts', 'Row 4', 'Row four')]), {
      budgetMs: 0, now: () => 1_000,
    });
    expect(decisions).toEqual({ [sha]: { status: 'degraded', reason: 'timeout' } });
    expect(gitCalls).toEqual([]);
  });

  it('gives each git subprocess only what is left, never its fixed 10-15 s', () => {
    write('a.ts', rows(1, 10).replace('Row 4\n', 'Row four\n'));
    const sha = commit('edit');
    gitCalls.length = 0;
    let t = 0;
    const state = { promptTurnIds: ['t0'], commitTurns: [sighting(sha)] };
    const decisions = lineClaimsForCommits(repo, 'claude-code', state as any, [sha], caps([toolEdit('a.ts', 'Row 4', 'Row four')]), {
      budgetMs: 400, now: () => (t += 10),
    });
    expect(decisions[sha].status).toBe('proven');
    expect(gitCalls.length).toBeGreaterThan(0);
    for (const c of gitCalls) expect(c.timeoutMs, c.args.join(' ')).toBeLessThanOrEqual(400);
    // Later calls get less than earlier ones: the budget is shared, not per call.
    const timeouts = gitCalls.map((c) => c.timeoutMs!);
    expect(timeouts[timeouts.length - 1]).toBeLessThan(timeouts[0]);
  });

  it('expires between commits: the first keeps its proof, the rest are degraded', () => {
    write('a.ts', rows(1, 10).replace('Row 2\n', 'Row two\n'));
    const first = commit('turn 0');
    write('a.ts', rows(1, 10).replace('Row 2\n', 'Row two\n').replace('Row 8\n', 'Row eight\n'));
    const second = commit('turn 1');
    const state = { promptTurnIds: ['t0', 't1'], commitTurns: [sighting(first, 't0', '2026-10-16T10:00:00Z'), sighting(second, 't1', '2026-10-16T10:05:00Z')] };
    // The clock jumps a second each time a commit's window is read from the captures.
    let t = 0;
    const captures = [
      { promptIndex: 0, edits: [toolEdit('a.ts', 'Row 2', 'Row two')] },
      { promptIndex: 1, edits: [toolEdit('a.ts', 'Row 8', 'Row eight')] },
    ];
    const ticking = Object.assign([...captures], {
      filter(this: typeof captures, ...args: Parameters<typeof captures.filter>) { t += 1_000; return Array.prototype.filter.apply(this, args as any); },
    });
    const decisions = lineClaimsForCommits(repo, 'claude-code', state as any, [first, second], ticking as any, {
      budgetMs: 1_500, now: () => t,
    });
    expect(decisions[first]).toEqual({ status: 'proven', files: [{ path: 'a.ts', ranges: [{ start_line: 2, end_line: 2, iteration_index: 0 }] }] });
    expect(decisions[second]).toEqual({ status: 'degraded', reason: 'timeout' });
  });

  it('expires inside the alignment of a large file: degraded, nothing partial', () => {
    // 3000 lines; the agent changes one, a human another, so the replay is not
    // the blob and the full alignment runs.
    const big = rows(1, 3000);
    write('big.ts', big);
    commit('big file');
    write('big.ts', big.replace('Row 10\n', 'Row ten\n').replace('Row 2900\n', 'Row 2900 human\n'));
    const sha = commit('agent + human');
    const state = { promptTurnIds: ['t0'], commitTurns: [sighting(sha)] };
    const edits = caps([toolEdit('big.ts', 'Row 10\n', 'Row ten\n')]);

    // A roomy budget proves the line: the deadline below is what changes.
    const roomy = lineClaimsForCommits(repo, 'claude-code', state as any, [sha], edits, { budgetMs: 60_000 });
    expect(roomy[sha]).toEqual({ status: 'proven', files: [{ path: 'big.ts', ranges: [{ start_line: 10, end_line: 10, iteration_index: 0 }] }] });

    // Every clock read is one tick. Everything before the alignment reads the
    // clock a few dozen times; the alignment checks it once per row (≥ 3000).
    let ticks = 0;
    const decisions = lineClaimsForCommits(repo, 'claude-code', state as any, [sha], edits, { budgetMs: 500, now: () => ticks++ });
    expect(decisions[sha]).toEqual({ status: 'degraded', reason: 'timeout' });
    expect(ticks).toBeGreaterThan(500);
    expect(ticks).toBeLessThan(1_000); // stopped as soon as it expired, not after the table
  });

  it('a timed-out commit still gets a valid commit-level note', () => {
    write('a.ts', rows(1, 10).replace('Row 4\n', 'Row four\n'));
    const sha = commit('edit');
    const state = { promptTurnIds: ['t0'], commitTurns: [sighting(sha)] };
    const lineClaims = lineClaimsForCommits(repo, 'claude-code', state as any, [sha], caps([toolEdit('a.ts', 'Row 4', 'Row four')]), {
      budgetMs: 0, now: () => 0,
    });
    writeGitNotes(repo, [sha], {
      sessionId: 'sess-budget1', model: 'claude-opus-5-5', agentSlug: 'claude-code', promptCount: 1, promptSummary: '',
      originUrl: '', linesAdded: 1, linesRemoved: 1,
      attribution: { sessionId: 'sess-budget1', agentId: 'claude-code', iterationIndexBySha: { [sha]: 0 }, lineClaims },
    } as any);
    const record = JSON.parse(git('notes', '--ref=origin', 'show', sha)).attribution_record;
    expect(record.attribution_level).toBe('commit');
    expect(record.contributions[0]).not.toHaveProperty('files');
    expect(validateFull(record).ok).toBe(true);
  });

  it('createProjectionDeadline measures from the injected clock', () => {
    const d = createProjectionDeadline(250, () => 1_000);
    expect(d.at).toBe(1_250);
  });
});
