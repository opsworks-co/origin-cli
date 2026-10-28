// Re-anchoring canonical line claims onto a later revision (OR-46 checkpoint 1).
//
// A target line keeps a contribution's claim only when strict blame, the
// exact source record and a mandatory line alignment all agree. These tests
// pin what survives (shifts, renames, merges, unchanged neighbours) and every
// way a claim is refused: rewrites, reformatting, repeated content, moves,
// copies, overlapping claims, broken or foreign records, and the deadline.
//
// Nothing here reads or writes a note through the CLI's writers: notes are
// put on commits by hand, and the module is not wired into any reader yet.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { execFileSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';

/** Every git invocation the orchestration makes. */
const gitCalls: string[][] = [];
vi.mock('../utils/exec.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../utils/exec.js')>();
  return {
    ...real,
    gitDetailed: (args: string[], opts?: any) => { gitCalls.push(args); return real.gitDetailed(args, opts); },
  };
});

const {
  parseBlamePorcelain,
  parseBlameIncremental,
  commitRecordIdentity,
  sourceRecordView,
  matchSourceClaim,
  reanchorFileClaims,
  reanchorFileAtRevision,
  MAX_ALIGNED_SOURCES,
} = await import('../attribution-line-reanchor.js');
const { validateFull } = await import('../attribution-record.js');
type BlameOrigin = import('../attribution-line-reanchor.js').BlameOrigin;
type FileReanchorResult = import('../attribution-line-reanchor.js').FileReanchorResult;

const SHA_X = 'a'.repeat(40);
const SHA_Y = 'b'.repeat(40);
const ZERO = '0'.repeat(40);

const rows = (from: number, to: number) =>
  Array.from({ length: to - from + 1 }, (_, i) => `Row ${from + i}`).join('\n') + '\n';

// ─── Canonical record fixtures ──────────────────────────────────────────────

type Range = { start_line: number; end_line: number; iteration_index?: number };

const contribution = (session: string, files?: Array<{ path: string; ranges: Range[] }>, iterations: number[] = []) => ({
  evidence: 'session_capture',
  agent: { id: 'claude-code' },
  model: { id: 'claude-opus-4-6' },
  session: iterations.length ? { id: session, iterations: iterations.map((index) => ({ index })) } : { id: session },
  ...(files ? { files } : {}),
});

const record = (sha: string, contributions: any[], version = '1.0') => ({
  schema_version: version,
  revision: { vcs: 'git', id: sha },
  attribution_level: contributions.some((c) => c.files) ? 'line' : 'commit',
  recorded_at: '2026-10-20T00:00:00Z',
  producer: { name: 'origin-cli', version: '0.20261020.1504' },
  contributions,
});

const lineRecord = (sha: string, filePath: string, ranges: Range[], session = 'session-agent') =>
  record(sha, [contribution(session, [{ path: filePath, ranges }], [...new Set(ranges.flatMap((r) => r.iteration_index ?? []))])]);

const envelope = (rec: unknown) => JSON.stringify({ origin: { sessionId: 'legacy' }, attribution_record: rec });

// ─── Pure: blame --incremental (CR1) ────────────────────────────────────────

/** One `--incremental` group; commit metadata only when `meta` (a commit's first group). */
const inc = (
  sha: string, src: number, tgt: number, count: number,
  { meta = true, filename = 'a.ts', boundary = false, author = 'A U' }: { meta?: boolean; filename?: string; boundary?: boolean; author?: string } = {},
) => [
  `${sha} ${src} ${tgt} ${count}`,
  ...(meta ? [`author ${author}`, 'author-mail <a@example.com>', 'author-time 1', 'author-tz +0000', 'committer C', 'summary s', ...(boundary ? ['boundary'] : [])] : []),
  `previous ${SHA_Y} a.ts`,
  `filename ${filename}`,
].join('\n') + '\n';

describe('parseBlameIncremental', () => {
  it('out-of-order groups, a repeated SHA without metadata, unicode and quoted paths: every line 1..N', () => {
    const out = inc(SHA_Y, 1, 3, 2, { filename: 'dir ü/b c.ts' })
      + inc(SHA_X, 10, 1, 2, { author: 'B X', boundary: true })
      + inc(SHA_Y, 7, 5, 1, { meta: false, filename: '"q\\303\\274.ts"' });
    expect(parseBlameIncremental(out, 5)).toEqual({
      ok: true,
      origins: [
        { targetLine: 1, sourceRevision: SHA_X, sourceLine: 10, sourcePath: 'a.ts', author: 'B X', boundary: true },
        { targetLine: 2, sourceRevision: SHA_X, sourceLine: 11, sourcePath: 'a.ts', author: 'B X', boundary: true },
        { targetLine: 3, sourceRevision: SHA_Y, sourceLine: 1, sourcePath: 'dir ü/b c.ts', author: 'A U', boundary: false },
        { targetLine: 4, sourceRevision: SHA_Y, sourceLine: 2, sourcePath: 'dir ü/b c.ts', author: 'A U', boundary: false },
        { targetLine: 5, sourceRevision: SHA_Y, sourceLine: 7, sourcePath: null, author: 'A U', boundary: false },
      ],
    });
  });

  const valid = inc(SHA_X, 1, 1, 2) + inc(SHA_Y, 5, 3, 1);
  it.each([
    ['truncated: no final newline', valid.slice(0, -1), 3],
    ['truncated: the last group lost its filename', valid.split('\n').slice(0, -2).join('\n') + '\n', 3],
    ['a group without filename before the next header', inc(SHA_X, 1, 1, 2).replace(/filename a\.ts\n$/, '') + inc(SHA_Y, 5, 3, 1), 3],
    ['a commit whose metadata (author) never came', inc(SHA_X, 1, 1, 2) + inc(SHA_Y, 5, 3, 1, { meta: false }), 3],
    ['author printed twice for one commit', inc(SHA_X, 1, 1, 2) + inc(SHA_X, 5, 3, 1), 3],
    ['a gap', inc(SHA_X, 1, 1, 1) + inc(SHA_Y, 5, 3, 1), 3],
    ['an overlap', inc(SHA_X, 1, 1, 2) + inc(SHA_Y, 5, 2, 2), 3],
    ['out of range', inc(SHA_X, 1, 1, 2) + inc(SHA_Y, 5, 3, 2), 3],
    ['trailing garbage', valid + 'garbage\n', 3],
    ['a header with a missing count', valid.replace(`${SHA_Y} 5 3 1`, `${SHA_Y} 5 3`), 3],
    ['empty output for a non-empty file', '', 1],
  ])('rejects the whole output: %s', (_, out, lineCount) => {
    expect(parseBlameIncremental(out, lineCount)).toEqual({ ok: false });
  });

  it('empty output is valid only for an empty file', () => {
    expect(parseBlameIncremental('', 0)).toEqual({ ok: true, origins: [] });
    expect(parseBlameIncremental(valid, 3).ok).toBe(true);
  });
});

// ─── Pure: commit-level identity of a record (CR1) ──────────────────────────

describe('commitRecordIdentity', () => {
  const other = { ...contribution('session-b'), agent: { id: 'claude-code' }, model: { id: 'gpt-5.5' } };
  const cases: Array<[string, string | null, string, Record<string, string> | null]> = [
    ['one contribution: its session, agent and model', envelope(record(SHA_X, [contribution('session-a')])), SHA_X,
      { sessionId: 'session-a', agentId: 'claude-code', modelId: 'claude-opus-4-6' }],
    ['a line-level record: the same commit-level identity', envelope(lineRecord(SHA_X, 'a.ts', [{ start_line: 1, end_line: 1 }])), SHA_X,
      { sessionId: 'session-agent', agentId: 'claude-code', modelId: 'claude-opus-4-6' }],
    ['several contributions: only the field they all share', envelope(record(SHA_X, [contribution('session-a'), other])), SHA_X,
      { agentId: 'claude-code' }],
    ['an invalid record', envelope({ schema_version: '1.0', revision: { vcs: 'git', id: SHA_X } }), SHA_X, null],
    ['a record of another revision', envelope(record(SHA_Y, [contribution('session-a')])), SHA_X, null],
    ['no record beside the legacy payload', JSON.stringify({ origin: { sessionId: 'legacy' } }), SHA_X, null],
    ['no contributions', envelope(record(SHA_X, [])), SHA_X, null],
    ['not JSON', 'not json', SHA_X, null],
    ['no note', null, SHA_X, null],
  ];
  it.each(cases)('%s', (_, text, revision, expected) => {
    expect(commitRecordIdentity(text, revision)).toEqual(expected);
  });

  it('the valid fixtures above are valid records', () => {
    expect(validateFull(record(SHA_X, [contribution('session-a'), other])).ok).toBe(true);
    expect(validateFull(record(SHA_X, [contribution('session-a')])).ok).toBe(true);
  });
});

// ─── Pure: blame porcelain ──────────────────────────────────────────────────

function entry(
  sha: string, orig: number, final: number, count?: number,
  { filename = 'a.ts', content = 'x', boundary = false, author = 'A U' }: { filename?: string; content?: string; boundary?: boolean; author?: string } = {},
): string {
  return [
    `${sha} ${orig} ${final}${count === undefined ? '' : ` ${count}`}`,
    `author ${author}`, 'author-mail <a@example.com>', 'author-time 1', 'author-tz +0000',
    'committer C', 'committer-mail <c@example.com>', 'committer-time 1', 'committer-tz +0000',
    'summary a summary that looks like nothing',
    ...(boundary ? ['boundary'] : []),
    `filename ${filename}`,
    `\t${content}`,
  ].join('\n') + '\n';
}

describe('parseBlamePorcelain', () => {
  it('keeps the source line and source path of every target line', () => {
    const out = entry(SHA_X, 7, 1, 2, { content: 'one' }) + entry(SHA_X, 8, 2, undefined, { content: 'two' })
      + entry(SHA_Y, 1, 3, 1, { filename: 'old name ü.ts', content: '' });
    const parsed = parseBlamePorcelain(out);
    expect(parsed).toEqual({
      ok: true,
      origins: [
        { targetLine: 1, sourceRevision: SHA_X, sourceLine: 7, sourcePath: 'a.ts', author: 'A U', content: 'one', boundary: false },
        { targetLine: 2, sourceRevision: SHA_X, sourceLine: 8, sourcePath: 'a.ts', author: 'A U', content: 'two', boundary: false },
        { targetLine: 3, sourceRevision: SHA_Y, sourceLine: 1, sourcePath: 'old name ü.ts', author: 'A U', content: '', boundary: false },
      ],
    });
  });

  it('keeps tabs, carriage returns and header-looking text inside content', () => {
    const content = `${SHA_X} 1 1 1\tand\r`;
    const parsed = parseBlamePorcelain(entry(SHA_X, 1, 1, 1, { content }));
    expect(parsed.ok && parsed.origins[0].content).toBe(content);
  });

  it('reports a quoted filename as no path, the uncommitted SHA and a boundary as they are', () => {
    const parsed = parseBlamePorcelain(
      entry(ZERO, 1, 1, 1, { filename: '"q\\"uote.ts"' }) + entry(SHA_X, 1, 2, 1, { boundary: true }),
    );
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.origins[0]).toMatchObject({ sourceRevision: ZERO, sourcePath: null });
    expect(parsed.origins[1]).toMatchObject({ boundary: true });
  });

  it('reads an empty blame as an empty file', () => {
    expect(parseBlamePorcelain('')).toEqual({ ok: true, origins: [] });
  });

  it.each([
    ['a stream cut before its last newline', entry(SHA_X, 1, 1, 1).slice(0, -1)],
    ['a header with no content row', entry(SHA_X, 1, 1, 2).split('\t')[0] + entry(SHA_X, 2, 2)],
    ['a gap in final lines', entry(SHA_X, 1, 1, 1) + entry(SHA_X, 2, 3, 1)],
    ['a group that never delivers its lines', entry(SHA_X, 1, 1, 2)],
    ['a group continued by another commit', entry(SHA_X, 1, 1, 2) + entry(SHA_Y, 2, 2)],
    ['a group whose source lines jump', entry(SHA_X, 1, 1, 2) + entry(SHA_X, 5, 2)],
    ['a continuation with no open group', entry(SHA_X, 1, 1)],
    ['a new group before the last one closed', entry(SHA_X, 1, 1, 2) + entry(SHA_Y, 1, 2, 1)],
    ['an abbreviated SHA', entry('abcdef1', 1, 1, 1)],
    ['a missing filename', entry(SHA_X, 1, 1, 1).replace(/^filename .*\n/m, '')],
    ['a repeated filename', entry(SHA_X, 1, 1, 1).replace(/^(filename .*\n)/m, '$1$1')],
    ['a missing author', entry(SHA_X, 1, 1, 1).replace(/^author .*\n/m, '')],
    ['a non-porcelain row', 'b1d2e3f (Someone 2026-10-20 1) code\n'],
  ])('rejects the whole output for %s', (_, out) => {
    expect(parseBlamePorcelain(out)).toEqual({ ok: false });
  });
});

// ─── Pure: source record view and claim matching ────────────────────────────

describe('sourceRecordView / matchSourceClaim', () => {
  it('reads only an exact-revision canonical record, never the legacy payload', () => {
    expect(sourceRecordView(null, SHA_X)).toEqual({ kind: 'no_record' });
    expect(sourceRecordView('not json', SHA_X)).toEqual({ kind: 'no_record' });
    expect(sourceRecordView(JSON.stringify({ origin: { model: 'claude-opus-4-6' } }), SHA_X)).toEqual({ kind: 'no_record' });
    expect(sourceRecordView(envelope(record(SHA_X, [contribution('s1')])), SHA_X)).toEqual({ kind: 'commit_level' });
    expect(sourceRecordView(envelope(lineRecord(SHA_Y, 'a.ts', [{ start_line: 1, end_line: 2 }])), SHA_X)).toEqual({ kind: 'wrong_revision' });
    expect(sourceRecordView(envelope(lineRecord(SHA_X, 'a.ts', [{ start_line: 3, end_line: 2 }])), SHA_X)).toEqual({ kind: 'invalid' });
    expect(sourceRecordView(envelope({ ...lineRecord(SHA_X, 'a.ts', [{ start_line: 1, end_line: 2 }]), schema_version: '2.0' }), SHA_X))
      .toEqual({ kind: 'unsupported' });
  });

  it('accepts a newer 1.x record through its 1.0 projection', () => {
    const rec = { ...lineRecord(SHA_X, 'a.ts', [{ start_line: 1, end_line: 2 }]), schema_version: '1.3', future_field: true };
    const view = sourceRecordView(envelope(rec), SHA_X);
    expect(matchSourceClaim(view, 'a.ts', 2)).toMatchObject({ kind: 'claim', range: { contributionIndex: 0, rangeIndex: 0 } });
  });

  it('says why a line has no claim', () => {
    const view = sourceRecordView(envelope(lineRecord(SHA_X, 'a.ts', [{ start_line: 3, end_line: 5 }])), SHA_X);
    expect(matchSourceClaim(view, 'a.ts', 2)).toEqual({ kind: 'none', reason: 'no_line_claim' });
    expect(matchSourceClaim(view, 'b.ts', 3)).toEqual({ kind: 'none', reason: 'no_line_claim' });
    expect(matchSourceClaim({ kind: 'commit_level' }, 'a.ts', 3)).toEqual({ kind: 'none', reason: 'commit_level' });
    expect(matchSourceClaim({ kind: 'invalid' }, 'a.ts', 3)).toEqual({ kind: 'none', reason: 'record_invalid' });
  });

  it('treats overlapping ranges of one contribution and one iteration as one claim', () => {
    const rec = record(SHA_X, [contribution('s1', [{ path: 'a.ts', ranges: [{ start_line: 1, end_line: 5, iteration_index: 2 }, { start_line: 4, end_line: 8, iteration_index: 2 }] }], [2])]);
    const view = sourceRecordView(envelope(rec), SHA_X);
    expect(matchSourceClaim(view, 'a.ts', 4)).toEqual({
      kind: 'claim', range: { contributionIndex: 0, fileIndex: 0, rangeIndex: 0, startLine: 1, endLine: 5, iterationIndex: 2 },
    });
  });

  it('picks no winner between iterations of one contribution or between contributions', () => {
    const twoIterations = record(SHA_X, [contribution('s1', [{ path: 'a.ts', ranges: [{ start_line: 1, end_line: 5, iteration_index: 1 }, { start_line: 5, end_line: 6 }] }], [1])]);
    expect(matchSourceClaim(sourceRecordView(envelope(twoIterations), SHA_X), 'a.ts', 5)).toEqual({ kind: 'ambiguous' });
    const twoSessions = record(SHA_X, [
      contribution('s1', [{ path: 'a.ts', ranges: [{ start_line: 1, end_line: 5 }] }]),
      contribution('s2', [{ path: 'a.ts', ranges: [{ start_line: 5, end_line: 5 }] }]),
    ]);
    const view = sourceRecordView(envelope(twoSessions), SHA_X);
    expect(matchSourceClaim(view, 'a.ts', 5)).toEqual({ kind: 'ambiguous' });
    expect(matchSourceClaim(view, 'a.ts', 4)).toMatchObject({ kind: 'claim', range: { contributionIndex: 0 } });
  });

  it('never modifies the note it reads', () => {
    const rec = lineRecord(SHA_X, 'a.ts', [{ start_line: 1, end_line: 2, iteration_index: 0 }]);
    const before = structuredClone(rec);
    sourceRecordView(envelope({ ...rec, schema_version: '1.2', extra: 1 }), SHA_X);
    sourceRecordView(envelope(rec), SHA_X);
    expect(rec).toEqual(before);
  });
});

// ─── Pure: the resolver ─────────────────────────────────────────────────────

const origin = (targetLine: number, sourceRevision: string, sourceLine: number, content: string, sourcePath: string | null = 'a.ts'): BlameOrigin =>
  ({ targetLine, sourceRevision, sourceLine, sourcePath, author: 'A', content, boundary: false });

describe('reanchorFileClaims', () => {
  const xView = sourceRecordView(envelope(lineRecord(SHA_X, 'a.ts', [{ start_line: 1, end_line: 3 }])), SHA_X);

  it('keeps target and source coordinates apart', () => {
    const res = reanchorFileClaims({
      targetRevision: SHA_Y, targetPath: 'b.ts', targetText: 'new\nl1\nl2\nl3\n',
      origins: [origin(1, SHA_Y, 1, 'new', 'b.ts'), origin(2, SHA_X, 1, 'l1'), origin(3, SHA_X, 2, 'l2'), origin(4, SHA_X, 3, 'l3')],
      sourceRecord: (rev) => (rev === SHA_X ? xView : { kind: 'no_record' }),
      sourceText: () => 'l1\nl2\nl3\n',
    });
    expect(res).toEqual({
      target_revision: SHA_Y, target_path: 'b.ts', status: 'resolved',
      claims: [{
        target_revision: SHA_Y, target_path: 'b.ts', start_line: 2, end_line: 4,
        source_revision: SHA_X, source_path: 'a.ts', source_start_line: 1, source_end_line: 3,
        contribution_index: 0, file_index: 0, range_index: 0,
      }],
      unresolved: [{ start_line: 1, end_line: 1, reason: 'no_record' }],
    });
  });

  it('A.ts and a.ts of one revision are two entries: the source is read, not taken from the target', () => {
    // Exact Git tree-entry identity, even on a case-insensitive host.
    const upper = sourceRecordView(envelope(lineRecord(SHA_Y, 'A.ts', [{ start_line: 1, end_line: 2 }])), SHA_Y);
    const asked: string[] = [];
    const run = (sourcePath: string) => reanchorFileClaims({
      targetRevision: SHA_Y, targetPath: 'a.ts', targetText: 'l1\nl2\n',
      origins: [origin(1, SHA_Y, 1, 'l1', sourcePath), origin(2, SHA_Y, 2, 'l2', sourcePath)],
      sourceRecord: () => (sourcePath === 'A.ts' ? upper : sourceRecordView(envelope(lineRecord(SHA_Y, 'a.ts', [{ start_line: 1, end_line: 2 }])), SHA_Y)),
      // The other entry's blob differs on line 1: only a real read can tell.
      sourceText: (rev, p) => { asked.push(`${rev}:${p}`); return 'L1\nl2\n'; },
    });
    const distinct = run('A.ts');
    expect(asked).toEqual([`${SHA_Y}:A.ts`]);
    expect(distinct.unresolved).toEqual([{ start_line: 1, end_line: 1, reason: 'source_mismatch' }]);
    expect(distinct.claims.map((c) => [c.start_line, c.source_path])).toEqual([[2, 'A.ts']]);

    // The same entry is the target itself: no read, both lines proven.
    asked.length = 0;
    const same = run('a.ts');
    expect(asked).toEqual([]);
    expect(same.claims.map((c) => [c.start_line, c.end_line, c.source_path])).toEqual([[1, 2, 'a.ts']]);
  });

  it('refuses a blame that does not describe the target text line for line', () => {
    const base = { targetRevision: SHA_Y, targetPath: 'a.ts', sourceRecord: () => xView, sourceText: () => 'l1\n' };
    expect(reanchorFileClaims({ ...base, targetText: 'l1\n', origins: [origin(1, SHA_X, 1, 'L1')] }).failure).toBe('blame_mismatch');
    expect(reanchorFileClaims({ ...base, targetText: 'l1\nl2\n', origins: [origin(1, SHA_X, 1, 'l1')] }).failure).toBe('blame_mismatch');
  });

  it('gives the uncommitted, boundary and unsafe-path lines no claim', () => {
    const res = reanchorFileClaims({
      targetRevision: SHA_Y, targetPath: 'a.ts', targetText: 'l1\nl2\nl3\n',
      origins: [origin(1, ZERO, 1, 'l1'), { ...origin(2, SHA_X, 2, 'l2'), boundary: true }, origin(3, SHA_X, 3, 'l3', null)],
      sourceRecord: () => xView,
      sourceText: () => 'l1\nl2\nl3\n',
    });
    expect(res.claims).toEqual([]);
    expect(res.unresolved.map((u) => u.reason)).toEqual(['uncommitted', 'boundary', 'unsafe_path']);
  });

  it('drops a line whose source text is not what blame printed', () => {
    const res = reanchorFileClaims({
      targetRevision: SHA_Y, targetPath: 'a.ts', targetText: 'l1\n',
      origins: [origin(1, SHA_X, 1, 'l1')], sourceRecord: () => xView, sourceText: () => 'other\n',
    });
    expect(res.unresolved).toEqual([{ start_line: 1, end_line: 1, reason: 'source_mismatch' }]);
  });

  it('drops both target lines that name the same source line', () => {
    const res = reanchorFileClaims({
      targetRevision: SHA_Y, targetPath: 'a.ts', targetText: 'l1\nl1\n',
      origins: [origin(1, SHA_X, 1, 'l1'), origin(2, SHA_X, 1, 'l1')], sourceRecord: () => xView, sourceText: () => 'l1\n',
    });
    expect(res.claims).toEqual([]);
  });

  it('fails one unreadable source alone and keeps the claims of the others', () => {
    const yView = sourceRecordView(envelope(lineRecord(SHA_Y, 'a.ts', [{ start_line: 1, end_line: 1 }])), SHA_Y);
    const target = 'b\nl1\n';
    const res = reanchorFileClaims({
      targetRevision: SHA_Y, targetPath: 'a.ts', targetText: target,
      origins: [origin(1, SHA_Y, 1, 'b'), origin(2, SHA_X, 1, 'l1', 'gone.ts')],
      sourceRecord: (rev) => (rev === SHA_X ? sourceRecordView(envelope(lineRecord(SHA_X, 'gone.ts', [{ start_line: 1, end_line: 1 }])), SHA_X) : yView),
      sourceText: () => null,
    });
    expect(res.claims).toMatchObject([{ start_line: 1, source_revision: SHA_Y }]);
    expect(res.unresolved).toEqual([{ start_line: 2, end_line: 2, reason: 'source_unreadable' }]);
  });

  it('refuses more source pairs than it may align, deterministically', () => {
    const n = MAX_ALIGNED_SOURCES + 1;
    const shas = Array.from({ length: n }, (_, i) => (i + 1).toString(16).padStart(40, '0'));
    const lines = shas.map((_, i) => `line ${i}`);
    const res = reanchorFileClaims({
      targetRevision: SHA_Y, targetPath: 'a.ts', targetText: lines.join('\n') + '\n',
      origins: shas.map((sha, i) => origin(i + 1, sha, 1, lines[i])),
      sourceRecord: (rev) => sourceRecordView(envelope(lineRecord(rev, 'a.ts', [{ start_line: 1, end_line: 1 }])), rev),
      sourceText: () => { throw new Error('must not read'); },
    });
    expect(res).toMatchObject({ status: 'failed', failure: 'too_many_sources', claims: [], unresolved: [] });
  });

  describe('the deadline is all or nothing', () => {
    const big = Array.from({ length: 200 }, (_, i) => `r${i}`);
    const twoSources = (sourceText: (rev: string, p: string) => string | null, now: () => number, at = 1) => reanchorFileClaims({
      targetRevision: SHA_Y, targetPath: 'a.ts', targetText: ['new', ...big].join('\n') + '\n',
      origins: [origin(1, SHA_Y, 1, 'new'), ...big.map((l, i) => origin(i + 2, SHA_X, i + 1, l, i < 100 ? 'p1.ts' : 'p2.ts'))],
      sourceRecord: (rev) => (rev === SHA_X
        ? sourceRecordView(envelope(record(SHA_X, [contribution('s1', [
          { path: 'p1.ts', ranges: [{ start_line: 1, end_line: 100 }] },
          { path: 'p2.ts', ranges: [{ start_line: 101, end_line: 200 }] },
        ])])), SHA_X)
        : { kind: 'no_record' }),
      sourceText,
      deadline: { at, now },
    });

    it('expired before anything runs', () => {
      const res = twoSources(() => big.join('\n') + '\n', () => 5);
      expect(res).toMatchObject({ status: 'failed', failure: 'timeout', claims: [], unresolved: [] });
    });

    it('expired between source pairs keeps none of the first pair', () => {
      let expired = false;
      const res = twoSources((_, p) => { if (p === 'p1.ts') expired = true; return ['new', ...big].join('\n') + '\n'; }, () => (expired ? 1 : 0));
      expect(res).toMatchObject({ status: 'failed', failure: 'timeout', claims: [] });
    });

    it('expired inside the alignment tables', () => {
      let calls = 0;
      const res = twoSources(() => big.join('\n') + '\n', () => calls++, 50);
      expect(res).toMatchObject({ status: 'failed', failure: 'timeout', claims: [] });
    });

    it('with time to spare, the same input resolves', () => {
      const res = twoSources(() => big.join('\n') + '\n', () => 0);
      expect(res.status).toBe('resolved');
      expect(res.claims.map((c) => [c.start_line, c.end_line, c.source_path])).toEqual([[2, 101, 'p1.ts'], [102, 201, 'p2.ts']]);
    });
  });
});

// ─── Real git ───────────────────────────────────────────────────────────────

describe('reanchorFileAtRevision (real git)', () => {
  let repo: string;
  const git = (...args: string[]): string => execFileSync('git', args, { cwd: repo, encoding: 'utf-8', stdio: 'pipe' });
  const write = (rel: string, content: string | Buffer) => {
    fs.mkdirSync(path.dirname(path.join(repo, rel)), { recursive: true });
    fs.writeFileSync(path.join(repo, rel), content);
  };
  const commit = (msg: string): string => {
    git('add', '-A');
    git('commit', '-q', '--allow-empty', '-m', msg);
    return git('rev-parse', 'HEAD').trim();
  };
  const note = (sha: string, rec: unknown, { valid = true } = {}) => {
    if (valid) expect(validateFull(rec).ok).toBe(true);
    git('notes', '--ref=origin', 'add', '-f', '-m', envelope(rec), sha);
  };
  const claimLines = (sha: string, file: string, ranges: Range[], session = 'session-agent') =>
    note(sha, lineRecord(sha, file, ranges, session));
  const view = (sha: string, file: string): FileReanchorResult => reanchorFileAtRevision({ repoPath: repo, targetRevision: sha, targetPath: file });
  /** [target_start, target_end, source_start, source_end, source_revision] per claim. */
  const spans = (res: FileReanchorResult) => res.claims.map((c) => [c.start_line, c.end_line, c.source_start_line, c.source_end_line, c.source_revision]);
  const reasonAt = (res: FileReanchorResult, line: number) =>
    res.unresolved.find((u) => u.start_line <= line && line <= u.end_line)?.reason;

  beforeEach(() => {
    gitCalls.length = 0;
    repo = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'origin-reanchor-')));
    git('init', '-q');
    git('config', 'user.email', 't@t.co');
    git('config', 'user.name', 'T');
    git('config', 'commit.gpgsign', 'false');
    git('config', 'core.autocrlf', 'false');
  });
  afterEach(() => { try { fs.rmSync(repo, { recursive: true, force: true }); } catch { /* ignore */ } });

  describe('an ordinary descendant', () => {
    let x: string;
    beforeEach(() => {
      // x is the root commit: blame --root keeps it a real origin, not a boundary.
      write('a.ts', rows(1, 10));
      x = commit('agent writes a.ts');
      claimLines(x, 'a.ts', [{ start_line: 3, end_line: 5 }]);
    });

    it('keeps an unchanged claim, with the root source identity, and leaves the note untouched', () => {
      write('other.ts', 'unrelated\n');
      const y = commit('unrelated');
      const before = git('notes', '--ref=origin', 'show', x);
      const res = view(y, 'a.ts');
      expect(res.claims).toEqual([{
        target_revision: y, target_path: 'a.ts', start_line: 3, end_line: 5,
        source_revision: x, source_path: 'a.ts', source_start_line: 3, source_end_line: 5,
        contribution_index: 0, file_index: 0, range_index: 0,
      }]);
      expect(res.unresolved).toEqual([
        { start_line: 1, end_line: 2, reason: 'no_line_claim' },
        { start_line: 6, end_line: 10, reason: 'no_line_claim' },
      ]);
      expect(git('notes', '--ref=origin', 'show', x)).toBe(before);
    });

    it('shifts target lines past an insertion above; source lines stay in X', () => {
      write('a.ts', 'import a\nimport b\n' + rows(1, 10));
      const y = commit('human inserts above');
      const res = view(y, 'a.ts');
      expect(spans(res)).toEqual([[5, 7, 3, 5, x]]);
      expect(reasonAt(res, 1)).toBe('no_record');
    });

    it('shifts target lines past a deletion above', () => {
      write('a.ts', rows(2, 10));
      const y = commit('human deletes row 1');
      expect(spans(view(y, 'a.ts'))).toEqual([[2, 4, 3, 5, x]]);
    });

    it('keeps the claimed neighbours of an edited line', () => {
      write('a.ts', rows(1, 10).replace('Row 4\n', 'Row four\n').replace('Row 6\n', 'Row six\n'));
      const y = commit('human edits row 4 and 6');
      const res = view(y, 'a.ts');
      expect(spans(res)).toEqual([[3, 3, 3, 3, x], [5, 5, 5, 5, x]]);
      expect(reasonAt(res, 4)).toBe('no_record');
    });

    it('drops a claimed line a formatter only re-indented, even when ignore-revs lists the formatter', () => {
      write('a.ts', rows(1, 10).replace('Row 4\n', '  Row 4\n'));
      const y = commit('format');
      fs.writeFileSync(path.join(repo, '.git', 'ignore-revs'), `${y}\n`);
      git('config', 'blame.ignoreRevsFile', '.git/ignore-revs');
      // The repo's own config would hand the line back to x:
      expect(git('blame', '--porcelain', '-L', '4,4', y, '--', 'a.ts').startsWith(x)).toBe(true);
      const res = view(y, 'a.ts');
      expect(spans(res)).toEqual([[3, 3, 3, 3, x], [5, 5, 5, 5, x]]);
      expect(reasonAt(res, 4)).toBe('no_record');
    });

    it('drops every line a CRLF conversion rewrote', () => {
      write('a.ts', rows(1, 10).replace(/\n/g, '\r\n'));
      const y = commit('crlf');
      const res = view(y, 'a.ts');
      expect(res.claims).toEqual([]);
      expect(res.unresolved).toEqual([{ start_line: 1, end_line: 10, reason: 'no_record' }]);
    });

    it('hands a line a later agent rewrote with its own range to that agent', () => {
      write('a.ts', rows(1, 10).replace('Row 4\n', 'Row four\n'));
      const y = commit('later agent');
      claimLines(y, 'a.ts', [{ start_line: 4, end_line: 4 }], 'session-later');
      expect(spans(view(y, 'a.ts'))).toEqual([[3, 3, 3, 3, x], [4, 4, 4, 4, y], [5, 5, 5, 5, x]]);
    });

    it('gives a line a later commit-level agent rewrote to nobody', () => {
      write('a.ts', rows(1, 10).replace('Row 4\n', 'Row four\n'));
      const y = commit('later agent, commit-level');
      note(y, record(y, [contribution('session-later')]));
      const res = view(y, 'a.ts');
      expect(spans(res)).toEqual([[3, 3, 3, 3, x], [5, 5, 5, 5, x]]);
      expect(reasonAt(res, 4)).toBe('commit_level');
    });

    it('follows a whole-file rename and names the source path', () => {
      fs.mkdirSync(path.join(repo, 'src'));
      git('mv', 'a.ts', 'src/b.ts');
      const y = commit('rename');
      const res = view(y, 'src/b.ts');
      expect(res.claims).toMatchObject([{ target_path: 'src/b.ts', source_path: 'a.ts', start_line: 3, end_line: 5, source_revision: x }]);
    });

    it('follows a rename with an unrelated edit and keeps only the unchanged claims', () => {
      git('mv', 'a.ts', 'b.ts');
      write('b.ts', rows(1, 10).replace('Row 5\n', 'Row five\n'));
      const y = commit('rename and edit');
      expect(view(y, 'b.ts').claims.map((c) => [c.start_line, c.end_line, c.source_path])).toEqual([[3, 4, 'a.ts']]);
    });

    it('has nothing for a deleted file, and nothing old for one recreated with the same content', () => {
      git('rm', '-q', 'a.ts');
      const y = commit('delete');
      expect(view(y, 'a.ts')).toMatchObject({ status: 'failed', failure: 'target_unreadable', claims: [] });
      write('a.ts', rows(1, 10));
      const z = commit('recreate');
      const res = view(z, 'a.ts');
      expect(res.claims).toEqual([]);
      expect(res.unresolved).toEqual([{ start_line: 1, end_line: 10, reason: 'no_record' }]);
    });

    it('keeps the original claims when a human copies them into another file', () => {
      write('copy.ts', 'Row 3\nRow 4\nRow 5\n');
      const y = commit('human copies the block');
      expect(view(y, 'copy.ts').claims).toEqual([]);
      expect(spans(view(y, 'a.ts'))).toEqual([[3, 5, 3, 5, x]]);
    });
  });

  it('keeps claims from both sides of a merge', () => {
    write('a.ts', rows(1, 10));
    const base = commit('base');
    const main = git('rev-parse', '--abbrev-ref', 'HEAD').trim();
    write('a.ts', rows(1, 10).replace('Row 2\n', 'Row two\n'));
    const left = commit('left agent');
    claimLines(left, 'a.ts', [{ start_line: 2, end_line: 2 }], 'session-left');
    git('checkout', '-q', '-b', 'side', base);
    write('a.ts', rows(1, 10).replace('Row 9\n', 'Row nine\n'));
    const right = commit('right agent');
    claimLines(right, 'a.ts', [{ start_line: 9, end_line: 9 }], 'session-right');
    git('checkout', '-q', main);
    git('merge', '-q', '--no-ff', '-m', 'merge', 'side');
    const merge = git('rev-parse', 'HEAD').trim();
    expect(spans(view(merge, 'a.ts'))).toEqual([[2, 2, 2, 2, left], [9, 9, 9, 9, right]]);
  });

  it('does not borrow a claim from a sibling that made the same change', () => {
    write('a.ts', rows(1, 10));
    const base = commit('base');
    write('a.ts', rows(1, 10).replace('Row 2\n', 'Row two\n'));
    const sibling = commit('agent on a branch');
    claimLines(sibling, 'a.ts', [{ start_line: 2, end_line: 2 }]);
    git('checkout', '-q', '-b', 'other', base);
    write('a.ts', rows(1, 10).replace('Row 2\n', 'Row two\n'));
    const human = commit('the same change by hand');
    const res = view(human, 'a.ts');
    expect(res.claims).toEqual([]);
    expect(reasonAt(res, 2)).toBe('no_record');
  });

  describe('repeated, moved and contested content', () => {
    it('refuses both duplicates when one of two claimed identical lines is deleted', () => {
      write('a.ts', 'start\nx = 1\nx = 1\nend\n');
      const x = commit('agent');
      claimLines(x, 'a.ts', [{ start_line: 2, end_line: 3 }]);
      write('a.ts', 'start\nx = 1\nend\n');
      const y = commit('human deletes one');
      const res = view(y, 'a.ts');
      expect(res.claims).toEqual([]);
      expect(reasonAt(res, 2)).toBe('ambiguous_alignment');
    });

    it('refuses identical blocks that were reordered', () => {
      write('a.ts', 'head\nf()\ng()\nf()\ng()\ntail\n');
      const x = commit('agent');
      claimLines(x, 'a.ts', [{ start_line: 2, end_line: 5 }]);
      write('a.ts', 'head\ng()\nf()\ng()\nf()\ntail\n');
      const y = commit('human reorders');
      expect(view(y, 'a.ts').claims).toEqual([]);
    });

    it('keeps only the lines that stayed put when a block moves within the file', () => {
      write('a.ts', rows(1, 8));
      const x = commit('agent');
      claimLines(x, 'a.ts', [{ start_line: 1, end_line: 8 }]);
      write('a.ts', rows(3, 8) + rows(1, 2));
      const y = commit('human moves rows 1-2 to the end');
      const res = view(y, 'a.ts');
      expect(spans(res)).toEqual([[1, 6, 3, 8, x]]);
      expect(reasonAt(res, 7)).toBe('no_record');
    });

    it('picks no winner between overlapping contributions', () => {
      write('a.ts', rows(1, 10));
      const x = commit('two agents');
      note(x, record(x, [
        contribution('session-one', [{ path: 'a.ts', ranges: [{ start_line: 3, end_line: 5 }] }]),
        contribution('session-two', [{ path: 'a.ts', ranges: [{ start_line: 4, end_line: 4 }] }]),
      ]));
      write('z.ts', 'later\n');
      const y = commit('later');
      const res = view(y, 'a.ts');
      expect(res.claims.map((c) => [c.start_line, c.end_line, c.contribution_index])).toEqual([[3, 3, 0], [5, 5, 0]]);
      expect(reasonAt(res, 4)).toBe('ambiguous_claim');
    });

    it('merges a run only within one range identity', () => {
      write('a.ts', rows(1, 10));
      const x = commit('agent, two iterations');
      note(x, record(x, [contribution('session-one', [{ path: 'a.ts', ranges: [
        { start_line: 2, end_line: 3, iteration_index: 0 },
        { start_line: 4, end_line: 5, iteration_index: 1 },
      ] }], [0, 1])]));
      expect(view(x, 'a.ts').claims.map((c) => [c.start_line, c.end_line, c.range_index, c.iteration_index])).toEqual([[2, 3, 0, 0], [4, 5, 1, 1]]);
    });
  });

  describe('records that prove nothing', () => {
    let x: string;
    beforeEach(() => {
      write('a.ts', rows(1, 4));
      x = commit('agent');
    });
    const reason = () => view(x, 'a.ts').unresolved.map((u) => u.reason);

    it('a record naming another commit', () => {
      note(x, lineRecord(SHA_Y, 'a.ts', [{ start_line: 1, end_line: 4 }]));
      expect(reason()).toEqual(['record_wrong_revision']);
    });

    it('an invalid record', () => {
      note(x, lineRecord(x, 'a.ts', [{ start_line: 4, end_line: 1 }]), { valid: false });
      expect(reason()).toEqual(['record_invalid']);
    });

    it('an unsupported major version', () => {
      note(x, { ...lineRecord(x, 'a.ts', [{ start_line: 1, end_line: 4 }]), schema_version: '2.0' }, { valid: false });
      expect(reason()).toEqual(['record_unsupported']);
    });

    it('a legacy note, or one that is not JSON', () => {
      git('notes', '--ref=origin', 'add', '-f', '-m', JSON.stringify({ origin: { sessionId: 's', model: 'claude-opus-4-6' } }), x);
      expect(reason()).toEqual(['no_record']);
      git('notes', '--ref=origin', 'add', '-f', '-m', 'garbage {', x);
      expect(reason()).toEqual(['no_record']);
    });
  });

  describe('paths and file kinds', () => {
    it('keeps claims in a path with spaces and unicode', () => {
      const p = 'dir with space/файл ü.ts';
      write(p, rows(1, 4));
      const x = commit('agent');
      claimLines(x, p, [{ start_line: 2, end_line: 3 }]);
      write('a b.ts', 'x\n');
      const y = commit('later');
      expect(view(y, p).claims).toMatchObject([{ target_path: p, source_path: p, start_line: 2, end_line: 3 }]);
    });

    it('degrades a path git has to quote', () => {
      const p = 'q"uote.ts';
      write(p, rows(1, 2));
      const x = commit('agent');
      claimLines(x, p, [{ start_line: 1, end_line: 2 }]);
      const res = view(x, p);
      expect(res.claims).toEqual([]);
      expect(res.unresolved).toEqual([{ start_line: 1, end_line: 2, reason: 'unsafe_path' }]);
    });

    it('refuses binary, symlink, notebook, oversized and unsafe targets', () => {
      write('bin.dat', Buffer.from([0x61, 0x00, 0x62, 0x0a]));
      write('nb.ipynb', '{}\n');
      write('big.ts', rows(1, 4100));
      fs.symlinkSync('big.ts', path.join(repo, 'link.ts'));
      const x = commit('files');
      expect(view(x, 'bin.dat').failure).toBe('non_text');
      expect(view(x, 'link.ts').failure).toBe('non_text');
      expect(view(x, 'nb.ipynb').failure).toBe('notebook');
      expect(view(x, 'big.ts').failure).toBe('oversized');
      expect(view(x, '../escape.ts').failure).toBe('unsafe_path');
      expect(view(x, 'missing.ts').failure).toBe('target_unreadable');
      expect(reanchorFileAtRevision({ repoPath: repo, targetRevision: x.slice(0, 12), targetPath: 'big.ts' }).failure).toBe('not_full_sha');
    });

    it('reads an empty file as no lines', () => {
      write('empty.ts', '');
      const x = commit('empty');
      expect(view(x, 'empty.ts')).toMatchObject({ status: 'resolved', claims: [], unresolved: [] });
    });
  });

  describe('bounds', () => {
    it('runs a fixed set of strict git calls, whatever the number of source commits', () => {
      write('a.ts', rows(1, 20));
      let sha = commit('base');
      // Commit i rewrites line i, so the final file has twenty source commits.
      const upTo = (i: number) => Array.from({ length: 20 }, (_, k) => (k < i ? `Row #${k + 1}` : `Row ${k + 1}`)).join('\n') + '\n';
      for (let i = 1; i <= 20; i++) {
        write('a.ts', upTo(i));
        sha = commit(`agent ${i}`);
        claimLines(sha, 'a.ts', [{ start_line: i, end_line: i }], `session-${i}`);
      }
      gitCalls.length = 0;
      const res = view(sha, 'a.ts');
      expect(res.claims).toHaveLength(20);
      // ls-tree, blame, notes list and three cat-file check/batch pairs.
      expect(gitCalls.length).toBeLessThanOrEqual(9);
      const blame = gitCalls.find((a) => a.includes('blame'))!;
      expect(blame).toEqual(expect.arrayContaining(['--line-porcelain', '--root', '--no-textconv', '--ignore-revs-file', '']));
      for (const forbidden of ['-w', '-M', '-C', '--porcelain', '-L']) expect(blame).not.toContain(forbidden);
    });

    it('returns nothing, and runs no git, once the deadline has passed', () => {
      write('a.ts', rows(1, 4));
      const x = commit('agent');
      claimLines(x, 'a.ts', [{ start_line: 1, end_line: 4 }]);
      gitCalls.length = 0;
      const res = reanchorFileAtRevision({ repoPath: repo, targetRevision: x, targetPath: 'a.ts', deadline: { at: 0, now: () => 1 } });
      expect(res).toMatchObject({ status: 'failed', failure: 'timeout', claims: [], unresolved: [] });
      expect(gitCalls).toEqual([]);
    });

    it('returns nothing when the deadline passes between git calls', () => {
      write('a.ts', rows(1, 4));
      const x = commit('agent');
      claimLines(x, 'a.ts', [{ start_line: 1, end_line: 4 }]);
      let t = 0;
      // Every git call costs a tick; the budget runs out after blame.
      const res = reanchorFileAtRevision({
        repoPath: repo, targetRevision: x, targetPath: 'a.ts',
        deadline: { at: 1_000_000, now: () => (gitCalls.some((a) => a.includes('blame')) ? 2_000_000 : ++t) },
      });
      expect(res).toMatchObject({ status: 'failed', failure: 'timeout', claims: [] });
    });

    it('carries no source text, prompt or note payload in its result', () => {
      write('a.ts', 'const SECRET_LINE_TEXT = 1;\nother\n');
      const x = commit('agent');
      const rec = lineRecord(x, 'a.ts', [{ start_line: 1, end_line: 1, iteration_index: 0 }]);
      (rec.contributions[0].session as any).iterations[0].prompt_hash = `sha256:${'e'.repeat(64)}`;
      note(x, rec);
      write('a.ts', 'changed\nconst SECRET_LINE_TEXT = 1;\nother\n');
      const y = commit('human');
      const out = JSON.stringify(view(y, 'a.ts'));
      expect(out).toContain('"iteration_index":0');
      for (const leaked of ['SECRET_LINE_TEXT', 'e'.repeat(64), 'claude-opus', 'session-agent', 'legacy']) expect(out).not.toContain(leaked);
    });
  });
});
