// OR-46 checkpoint 3: canonical line claims across an exact OR-11 rewrite.
//
// A rewrite's note may carry line claims only where they are PROVEN on the new
// commit (rewrite-line-projection.ts): the source record's own claim, the same
// path or an exact rename, a mandatory line alignment, and a line the new
// commit itself adds. Carried ranges name the new commit, never carry an
// iteration, and a line two claimants reach is carried by none. With nothing
// proven the note is exactly OR-11's commit-level note.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { execFileSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';

vi.mock('../api.js', () => ({ api: { importGitNote: vi.fn(() => Promise.resolve({ ok: true })) } }));

const { preserveAttributionBatch } = await import('../history-preservation.js');
const { rebuildRewrittenNote, mergeSessionNoteOverRewrite } = await import('../history-rewrite.js');
const { projectRewriteLineClaims } = await import('../rewrite-line-projection.js');
const { validateFull } = await import('../attribution-record.js');
const { getLineBlame } = await import('../attribution.js');

const rows = (from: number, to: number) =>
  Array.from({ length: to - from + 1 }, (_, i) => `Row ${from + i}`).join('\n') + '\n';
const SHA = (c: string) => c.repeat(40);
const NOW = new Date('2026-10-20T12:00:00Z');
const OPTS = { recordedAt: NOW, producerVersion: '0.20261020.1504' };

type Range = { start_line: number; end_line: number; iteration_index?: number };

/** A source note as the OR-45 writer leaves it: legacy payload + line-level record. */
function sourceNote(sha: string, session: string, files: Array<{ path: string; ranges: Range[] }> | null, iterations: number[] = []) {
  const record = {
    schema_version: '1.0',
    revision: { vcs: 'git', id: sha },
    attribution_level: files ? 'line' : 'commit',
    recorded_at: '2026-10-01T00:00:00Z',
    producer: { name: 'origin-cli', version: '0.1.0' },
    contributions: [{
      evidence: 'session_capture',
      agent: { id: 'codex' },
      model: { id: 'gpt-5.3-codex' },
      session: iterations.length ? { id: session, iterations: iterations.map((index) => ({ index })) } : { id: session },
      ...(files ? { files } : {}),
    }],
  };
  expect(validateFull(record).ok).toBe(true);
  return JSON.stringify({ origin: { version: 1, sessionId: session, agent: 'codex', model: 'gpt-5.3-codex' }, attribution_record: record });
}

// ─── The pure builder ───────────────────────────────────────────────────────

describe('rebuildRewrittenNote with a line projection', () => {
  const S1 = SHA('a');
  const S2 = SHA('b');
  const T = SHA('c');
  const src1 = sourceNote(S1, 'session-one', [{ path: 'a.ts', ranges: [{ start_line: 3, end_line: 6, iteration_index: 0 }] }], [0]);
  const src2 = sourceNote(S2, 'session-two', [{ path: 'b.ts', ranges: [{ start_line: 1, end_line: 2 }] }]);
  const at = (sourceSha: string, p: string, lines: number[]) => lines.map((line) => ({ sourceSha, contributionIndex: 0, path: p, line }));
  const recordOf = (payload: string | null) => JSON.parse(payload!).attribution_record;

  it('nothing proven: byte for byte the OR-11 commit-level note', () => {
    const before = rebuildRewrittenNote({ targetSha: T, sources: [{ sha: S1, note: src1 }], ...OPTS });
    for (const lineProjection of [undefined, []]) {
      expect(rebuildRewrittenNote({ targetSha: T, sources: [{ sha: S1, note: src1 }], lineProjection, ...OPTS }).payload).toBe(before.payload);
    }
    expect(recordOf(before.payload)).toMatchObject({ attribution_level: 'commit' });
    expect(recordOf(before.payload).contributions[0].files).toBeUndefined();
  });

  it('1→1: proven lines in the new commit\'s coordinates, no iteration, the identity kept', () => {
    const r = rebuildRewrittenNote({ targetSha: T, sources: [{ sha: S1, note: src1 }], lineProjection: at(S1, 'a.ts', [5, 6, 7, 9]), ...OPTS });
    const rec = recordOf(r.payload);
    expect(validateFull(rec).ok).toBe(true);
    expect(rec).toMatchObject({ revision: { vcs: 'git', id: T }, attribution_level: 'line' });
    expect(rec.contributions).toEqual([{
      evidence: 'session_capture', agent: { id: 'codex' }, model: { id: 'gpt-5.3-codex' }, session: { id: 'session-one' },
      files: [{ path: 'a.ts', ranges: [{ start_line: 5, end_line: 7 }, { start_line: 9, end_line: 9 }] }],
    }]);
  });

  it('N→1: each session keeps its own lines; a line both reach is carried by neither', () => {
    const projection = [...at(S1, 'a.ts', [3, 4]), ...at(S1, 'shared.ts', [1]), ...at(S2, 'b.ts', [1]), ...at(S2, 'shared.ts', [1])];
    const rec = recordOf(rebuildRewrittenNote({ targetSha: T, sources: [{ sha: S1, note: src1 }, { sha: S2, note: src2 }], lineProjection: projection, ...OPTS }).payload);
    const filesOf = (id: string) => rec.contributions.find((c: any) => c.session.id === id).files;
    expect(filesOf('session-one')).toEqual([{ path: 'a.ts', ranges: [{ start_line: 3, end_line: 4 }] }]);
    expect(filesOf('session-two')).toEqual([{ path: 'b.ts', ranges: [{ start_line: 1, end_line: 1 }] }]);
    // The order of the projection decides nothing.
    const reversed = recordOf(rebuildRewrittenNote({ targetSha: T, sources: [{ sha: S2, note: src2 }, { sha: S1, note: src1 }], lineProjection: [...projection].reverse(), ...OPTS }).payload);
    expect(reversed.contributions).toEqual(rec.contributions);
  });

  it('a session the sources disagree about carries nothing and still blocks the lines it reaches', () => {
    const otherAgent = JSON.parse(sourceNote(S2, 'session-one', [{ path: 'a.ts', ranges: [{ start_line: 1, end_line: 1 }] }]));
    otherAgent.attribution_record.contributions[0].agent = { id: 'claude-code' };
    otherAgent.origin.agent = 'claude-code';
    const third = SHA('d');
    const src3 = sourceNote(third, 'session-three', [{ path: 'a.ts', ranges: [{ start_line: 1, end_line: 2 }] }]);
    const r = rebuildRewrittenNote({
      targetSha: T,
      sources: [{ sha: S1, note: src1 }, { sha: S2, note: JSON.stringify(otherAgent) }, { sha: third, note: src3 }],
      lineProjection: [...at(S1, 'a.ts', [3]), ...at(S2, 'a.ts', [4]), ...at(third, 'a.ts', [4, 5])],
      ...OPTS,
    });
    const rec = recordOf(r.payload);
    expect(rec.contributions.map((c: any) => c.session.id)).toEqual(['session-three']);
    expect(rec.contributions[0].files).toEqual([{ path: 'a.ts', ranges: [{ start_line: 5, end_line: 5 }] }]);
  });

  it('a projected line whose source contribution no claim names blocks, and never invents a contribution', () => {
    const rec = recordOf(rebuildRewrittenNote({
      targetSha: T, sources: [{ sha: S1, note: src1 }],
      lineProjection: [...at(S1, 'a.ts', [3, 4]), { sourceSha: S1, contributionIndex: 7, path: 'a.ts', line: 4 }],
      ...OPTS,
    }).payload);
    expect(rec.contributions).toHaveLength(1);
    expect(rec.contributions[0].files).toEqual([{ path: 'a.ts', ranges: [{ start_line: 3, end_line: 3 }] }]);
  });

  it('lines that cannot be published whole leave the contribution commit-level', () => {
    const many = Array.from({ length: 10_001 }, (_, i) => 2 * i + 1);
    const r = rebuildRewrittenNote({ targetSha: T, sources: [{ sha: S1, note: src1 }], lineProjection: at(S1, 'a.ts', many), ...OPTS });
    expect(recordOf(r.payload)).toMatchObject({ attribution_level: 'commit' });
    expect(r.warnings.map((w) => w.code)).toContain('rewrite-lines-not-carried');
  });

  it('the target\'s own note: its contributions and line claims stay, a new session gets only free lines', () => {
    const own = sourceNote(T, 'session-own', [{ path: 'a.ts', ranges: [{ start_line: 4, end_line: 4 }] }]);
    const r = rebuildRewrittenNote({ targetSha: T, sources: [{ sha: S1, note: src1 }], existingTarget: own, lineProjection: at(S1, 'a.ts', [3, 4, 5]), ...OPTS });
    const rec = recordOf(r.payload);
    expect(rec.attribution_level).toBe('line');
    expect(rec.contributions[0]).toEqual(JSON.parse(own).attribution_record.contributions[0]);
    expect(rec.contributions[1].files).toEqual([{ path: 'a.ts', ranges: [{ start_line: 3, end_line: 3 }, { start_line: 5, end_line: 5 }] }]);
    // The same session already on the target: the target wins, nothing carried.
    const sameSession = sourceNote(T, 'session-one', null);
    const kept = rebuildRewrittenNote({ targetSha: T, sources: [{ sha: S1, note: src1 }], existingTarget: sameSession, lineProjection: at(S1, 'a.ts', [3]), ...OPTS });
    expect(kept.payload === null || recordOf(kept.payload).contributions.every((c: any) => !c.files)).toBe(true);
  });

  it('foreign, invalid and newer target notes are left alone whatever is projected', () => {
    const foreign = sourceNote(SHA('e'), 'session-x', null);
    const newer = JSON.stringify({ attribution_record: { ...JSON.parse(sourceNote(T, 'session-x', null)).attribution_record, schema_version: '2.0' } });
    for (const existingTarget of ['not json', foreign, newer]) {
      const r = rebuildRewrittenNote({ targetSha: T, sources: [{ sha: S1, note: src1 }], existingTarget, lineProjection: at(S1, 'a.ts', [3]), ...OPTS });
      expect(r.payload).toBeNull();
    }
  });

  it('a repeat over its own note writes nothing new, and a session writer keeps the carried lines', () => {
    const projection = at(S1, 'a.ts', [3, 4]);
    const first = rebuildRewrittenNote({ targetSha: T, sources: [{ sha: S1, note: src1 }], lineProjection: projection, ...OPTS });
    const again = rebuildRewrittenNote({ targetSha: T, sources: [{ sha: S1, note: src1 }], existingTarget: first.payload, lineProjection: projection, recordedAt: new Date('2026-10-21T00:00:00Z'), producerVersion: OPTS.producerVersion });
    expect(again.payload).toBeNull();

    const snapshot = sourceNote(T, 'session-own', null);
    const merged = JSON.parse(mergeSessionNoteOverRewrite(first.payload, snapshot, T, OPTS));
    expect(merged.attribution_record.attribution_level).toBe('line');
    expect(merged.attribution_record.contributions.find((c: any) => c.session.id === 'session-one').files)
      .toEqual([{ path: 'a.ts', ranges: [{ start_line: 3, end_line: 4 }] }]);
  });
});

// ─── Real rewrites ──────────────────────────────────────────────────────────

describe('exact rewrite mappings on a real repository', () => {
  let repo: string;
  let base: string;
  const git = (...args: string[]): string => execFileSync('git', args, { cwd: repo, encoding: 'utf-8', stdio: 'pipe' }).trim();
  const write = (rel: string, content: string) => {
    fs.mkdirSync(path.dirname(path.join(repo, rel)), { recursive: true });
    fs.writeFileSync(path.join(repo, rel), content);
  };
  const commit = (msg: string): string => { git('add', '-A'); git('commit', '-q', '--allow-empty', '-m', msg); return git('rev-parse', 'HEAD'); };
  const annotate = (sha: string, session: string, files: Array<{ path: string; ranges: Range[] }> | null, iterations: number[] = []) =>
    git('notes', '--ref=origin', 'add', '-f', '-m', sourceNote(sha, session, files, iterations), sha);
  const record = (sha: string) => JSON.parse(git('notes', '--ref=origin', 'show', sha)).attribution_record;
  const filesOf = (sha: string, session = 'session-agent') =>
    record(sha).contributions.find((c: any) => c.session?.id === session)?.files;
  const rewrite = (pairs: Array<[string, string]>) => preserveAttributionBatch(repo, pairs.map(([oldSha, newSha]) => ({ oldSha, newSha })));
  /** The agent's commit S on `base`: rows 1-2 were there, it adds rows 3-6 and claims them. */
  const agentCommit = (file = 'a.ts', iterations: number[] = [0]) => {
    write(file, rows(1, 6));
    const s = commit('agent adds rows 3-6');
    annotate(s, 'session-agent', [{ path: file, ranges: [{ start_line: 3, end_line: 6, ...(iterations.length ? { iteration_index: iterations[0] } : {}) }] }], iterations);
    return s;
  };
  /** A commit with `content` in `file` on top of `parent`, as a rebase or a conflict resolution would leave it. */
  const commitOn = (parent: string, files: Record<string, string | null>, msg: string) => {
    git('checkout', '-q', '--detach', parent);
    for (const [f, content] of Object.entries(files)) {
      if (content === null) git('rm', '-q', f);
      else write(f, content);
    }
    return commit(msg);
  };

  beforeEach(() => {
    repo = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'origin-or46-rewrite-')));
    execFileSync('git', ['init', '-q', '-b', 'main', repo], { stdio: 'pipe' });
    git('config', 'user.email', 'dev@example.com');
    git('config', 'user.name', 'Dev');
    git('config', 'commit.gpgsign', 'false');
    write('a.ts', rows(1, 2));
    base = commit('base');
  });
  afterEach(() => { try { fs.rmSync(repo, { recursive: true, force: true }); } catch { /* ignore */ } });

  it('amend without a content change carries the claim to the new sha, without its iteration', () => {
    const s = agentCommit();
    git('commit', '-q', '--amend', '-m', 'reworded');
    const t = git('rev-parse', 'HEAD');
    expect(rewrite([[s, t]]).written).toBe(1);
    const rec = record(t);
    expect(rec).toMatchObject({ revision: { id: t }, attribution_level: 'line' });
    expect(rec.contributions[0].session).toEqual({ id: 'session-agent' });
    expect(rec.contributions[0].files).toEqual([{ path: 'a.ts', ranges: [{ start_line: 3, end_line: 6 }] }]);
    expect(getLineBlame(repo, 'a.ts').map((l) => l.authorship)).toEqual(['human', 'human', 'ai', 'ai', 'ai', 'ai']);
    expect(getLineBlame(repo, 'a.ts')[2].iterationIndex).toBeUndefined();
  });

  it('amend with a human edit drops only the edited line', () => {
    const s = agentCommit();
    write('a.ts', rows(1, 6).replace('Row 4\n', 'Row four\n'));
    git('add', '-A');
    git('commit', '-q', '--amend', '--no-edit');
    const t = git('rev-parse', 'HEAD');
    rewrite([[s, t]]);
    expect(filesOf(t)).toEqual([{ path: 'a.ts', ranges: [{ start_line: 3, end_line: 3 }, { start_line: 5, end_line: 6 }] }]);
  });

  it('a rebase onto lines inserted above shifts the ranges', () => {
    const s = agentCommit();
    const upstream = commitOn(base, { 'a.ts': 'top 1\ntop 2\n' + rows(1, 2) }, 'upstream inserts above');
    const t = commitOn(upstream, { 'a.ts': 'top 1\ntop 2\n' + rows(1, 6) }, 'agent adds rows 3-6');
    rewrite([[s, t]]);
    expect(filesOf(t)).toEqual([{ path: 'a.ts', ranges: [{ start_line: 5, end_line: 8 }] }]);
  });

  it('a conflict resolution keeps only the mandatory survivors', () => {
    const s = agentCommit();
    const upstream = commitOn(base, { 'a.ts': rows(1, 2) + 'Row 5\n' }, 'upstream adds its own Row 5');
    // The resolution keeps upstream's Row 5 once and rewrites Row 6.
    const t = commitOn(upstream, { 'a.ts': rows(1, 4) + 'Row 5\nRow 6 resolved\n' }, 'rebased agent commit');
    rewrite([[s, t]]);
    // Rows 3-4 are the agent's and new here; Row 5 is upstream's line (not added by t); Row 6 changed.
    expect(filesOf(t)).toEqual([{ path: 'a.ts', ranges: [{ start_line: 3, end_line: 4 }] }]);
  });

  it('cherry-pick: exact carries; a parent that already has a claimed line keeps it out', () => {
    const s = agentCommit();
    // Onto other work, so the pick is a new commit and not `s` itself.
    commitOn(base, { 'z.ts': 'z\n' }, 'other work');
    git('cherry-pick', s);
    const t = git('rev-parse', 'HEAD');
    expect(t).not.toBe(s);
    rewrite([[s, t]]);
    expect(filesOf(t)).toEqual([{ path: 'a.ts', ranges: [{ start_line: 3, end_line: 6 }] }]);

    const prepared = commitOn(base, { 'a.ts': rows(1, 4) }, 'someone already wrote rows 3-4');
    const t2 = commitOn(prepared, { 'a.ts': rows(1, 6) }, 'pick the rest');
    rewrite([[s, t2]]);
    expect(filesOf(t2)).toEqual([{ path: 'a.ts', ranges: [{ start_line: 5, end_line: 6 }] }]);
  });

  it('an exact rename carries to the new path; a rename with an edit stays commit-level', () => {
    const s = agentCommit();
    git('mv', 'a.ts', 'b.ts');
    git('commit', '-q', '--amend', '--no-edit');
    const t = git('rev-parse', 'HEAD');
    rewrite([[s, t]]);
    expect(filesOf(t)).toEqual([{ path: 'b.ts', ranges: [{ start_line: 3, end_line: 6 }] }]);

    const t2 = commitOn(base, { 'a.ts': null, 'c.ts': rows(1, 5) + 'Row six\n' }, 'rename and edit');
    rewrite([[s, t2]]);
    expect(record(t2).attribution_level).toBe('commit');
    expect(filesOf(t2)).toBeUndefined();
  });

  it('a unique exact-blob relocation: the old path reused by a human file, the claims go only to the moved blob', () => {
    // Git shows M a.ts + A b.ts, not R100: a.ts still exists, with new human text
    // that repeats one claimed line.
    const s = agentCommit();
    const t = commitOn(base, { 'a.ts': 'human x\nRow 4\nhuman y\n', 'b.ts': rows(1, 6) }, 'move a.ts to b.ts, new a.ts');
    const note = git('notes', '--ref=origin', 'show', s);
    expect(projectRewriteLineClaims({ repoPath: repo, targetSha: t, sources: [{ sha: s, note }] }).lines.map((l) => [l.path, l.line]))
      .toEqual([['b.ts', 3], ['b.ts', 4], ['b.ts', 5], ['b.ts', 6]]);
    rewrite([[s, t]]);
    expect(filesOf(t)).toEqual([{ path: 'b.ts', ranges: [{ start_line: 3, end_line: 6 }] }]);
  });

  it('two exact-blob copies are not told apart by order: neither, nor the reused old path, gets a claim', () => {
    const s = agentCommit();
    const t = commitOn(base, { 'a.ts': 'human x\nRow 4\nhuman y\n', 'b.ts': rows(1, 6), 'c.ts': rows(1, 6) }, 'two copies, new a.ts');
    const note = git('notes', '--ref=origin', 'show', s);
    expect(projectRewriteLineClaims({ repoPath: repo, targetSha: t, sources: [{ sha: s, note }] }).lines).toEqual([]);
    rewrite([[s, t]]);
    expect(filesOf(t)).toBeUndefined();
  });

  it('a case-only exact rename carries to the new entry, on any host', () => {
    // a.ts → A.ts built with plumbing: the work tree of a case-insensitive
    // host never has to hold both names, and git's trees stay exact.
    const s = agentCommit();
    const entry = git('ls-tree', s, '--', 'a.ts');
    const tree = execFileSync('git', ['mktree'], { cwd: repo, input: entry.replace(/\ta\.ts$/, '\tA.ts') + '\n', encoding: 'utf-8' }).trim();
    const t = git('commit-tree', tree, '-p', base, '-m', 'agent adds rows 3-6 as A.ts');
    expect(git('ls-tree', '--name-only', t)).toBe('A.ts');
    const note = git('notes', '--ref=origin', 'show', s);
    expect(projectRewriteLineClaims({ repoPath: repo, targetSha: t, sources: [{ sha: s, note }] }).lines.map((l) => [l.path, l.line]))
      .toEqual([['A.ts', 3], ['A.ts', 4], ['A.ts', 5], ['A.ts', 6]]);
    rewrite([[s, t]]);
    expect(filesOf(t)).toEqual([{ path: 'A.ts', ranges: [{ start_line: 3, end_line: 6 }] }]);
  });

  it('a squash of two sessions keeps each session\'s own lines and drops a line both claim', () => {
    write('a.ts', rows(1, 2) + 'shared\nalpha\n');
    const s1 = commit('session one');
    annotate(s1, 'session-one', [{ path: 'a.ts', ranges: [{ start_line: 3, end_line: 4 }] }]);
    const s2 = commitOn(base, { 'a.ts': rows(1, 2) + 'shared\n', 'b.ts': 'beta\n' }, 'session two');
    annotate(s2, 'session-two', [{ path: 'a.ts', ranges: [{ start_line: 3, end_line: 3 }] }, { path: 'b.ts', ranges: [{ start_line: 1, end_line: 1 }] }]);
    const t = commitOn(base, { 'a.ts': rows(1, 2) + 'shared\nalpha\n', 'b.ts': 'beta\n' }, 'squash');
    expect(rewrite([[s1, t], [s2, t]]).written).toBe(1);
    expect(filesOf(t, 'session-one')).toEqual([{ path: 'a.ts', ranges: [{ start_line: 4, end_line: 4 }] }]);
    expect(filesOf(t, 'session-two')).toEqual([{ path: 'b.ts', ranges: [{ start_line: 1, end_line: 1 }] }]);
  });

  it('a chain A→B→C carries to C, and a repeat changes nothing', () => {
    const s = agentCommit();
    git('commit', '-q', '--amend', '-m', 'first amend');
    const b = git('rev-parse', 'HEAD');
    rewrite([[s, b]]);
    git('commit', '-q', '--amend', '-m', 'second amend');
    const c = git('rev-parse', 'HEAD');
    rewrite([[b, c]]);
    expect(filesOf(c)).toEqual([{ path: 'a.ts', ranges: [{ start_line: 3, end_line: 6 }] }]);
    const before = git('notes', '--ref=origin', 'show', c);
    expect(rewrite([[b, c]]).unchanged).toBe(1);
    expect(git('notes', '--ref=origin', 'show', c)).toBe(before);
  });

  it('a foreign or invalid target note is never touched', () => {
    const s = agentCommit();
    git('commit', '-q', '--amend', '-m', 'reworded');
    const t = git('rev-parse', 'HEAD');
    git('notes', '--ref=origin', 'add', '-f', '-m', 'not json at all', t);
    expect(rewrite([[s, t]]).unchanged).toBe(1);
    expect(git('notes', '--ref=origin', 'show', t)).toBe('not json at all');
    const foreign = sourceNote(base, 'someone', null);
    git('notes', '--ref=origin', 'add', '-f', '-m', foreign, t);
    rewrite([[s, t]]);
    expect(git('notes', '--ref=origin', 'show', t)).toBe(foreign);
  });

  it('a merge commit as the target projects nothing: OR-11\'s commit-level note', () => {
    const s = agentCommit();
    const side = commitOn(base, { 'z.ts': 'z\n' }, 'side');
    git('checkout', '-q', '--detach', s);
    git('merge', '-q', '--no-ff', '-m', 'merge', side);
    const m = git('rev-parse', 'HEAD');
    expect(projectRewriteLineClaims({ repoPath: repo, targetSha: m, sources: [{ sha: s, note: git('notes', '--ref=origin', 'show', s) }] }))
      .toEqual({ lines: [], reason: 'merge_target' });
    rewrite([[s, m]]);
    expect(record(m).attribution_level).toBe('commit');
  });

  it('declared ranges past the bound, or an exhausted budget, project nothing at all', () => {
    const s = agentCommit();
    git('commit', '-q', '--amend', '-m', 'reworded');
    const t = git('rev-parse', 'HEAD');
    const huge = sourceNote(s, 'session-agent', [{ path: 'a.ts', ranges: [{ start_line: 1, end_line: Number.MAX_SAFE_INTEGER }] }]);
    expect(projectRewriteLineClaims({ repoPath: repo, targetSha: t, sources: [{ sha: s, note: huge }] })).toEqual({ lines: [], reason: 'too_many_claim_lines' });
    const note = git('notes', '--ref=origin', 'show', s);
    expect(projectRewriteLineClaims({ repoPath: repo, targetSha: t, sources: [{ sha: s, note }], deadline: { at: 0, now: () => 1 } }))
      .toEqual({ lines: [], reason: 'timeout' });
  });
});

// ─── Revision of checkpoint 3: bounds ───────────────────────────────────────

describe('a rewrite never does unbounded work on what notes or callers state', () => {
  const S1 = SHA('a');
  const T = SHA('c');
  const src1 = sourceNote(S1, 'session-one', [{ path: 'a.ts', ranges: [{ start_line: 3, end_line: 6 }] }]);
  const at = (lines: number[], extra: Partial<{ sourceSha: string; contributionIndex: number; path: string }> = {}) =>
    lines.map((line) => ({ sourceSha: S1, contributionIndex: 0, path: 'a.ts', line, ...extra }));
  const fallback = () => rebuildRewrittenNote({ targetSha: T, sources: [{ sha: S1, note: src1 }], ...OPTS }).payload;

  it('many overlapping source ranges with a tiny union are refused before they are sorted', () => {
    // Three files of 7000 copies of lines 1-3: 21 000 ranges, a union of 3 lines each.
    const files = ['a.ts', 'b.ts', 'c.ts'].map((p) => ({ path: p, ranges: Array.from({ length: 7_000 }, () => ({ start_line: 1, end_line: 3 })) }));
    const note = sourceNote(S1, 'session-one', files);
    const started = performance.now();
    expect(projectRewriteLineClaims({ repoPath: os.tmpdir(), targetSha: T, sources: [{ sha: S1, note }] }))
      .toEqual({ lines: [], reason: 'too_many_claim_ranges' });
    expect(performance.now() - started).toBeLessThan(5_000);
  });

  it('a source note past the byte bound is not parsed at all', () => {
    const note = JSON.stringify({ padding: 'x'.repeat(1024 * 1024 + 1) });
    expect(projectRewriteLineClaims({ repoPath: os.tmpdir(), targetSha: T, sources: [{ sha: S1, note }] }))
      .toEqual({ lines: [], reason: 'note_too_large' });
  });

  it('the note bound counts UTF-8 bytes, not string length', () => {
    // 'é' is one UTF-16 code unit but two UTF-8 bytes: short by length, past the bound in bytes.
    const note = JSON.stringify({ padding: 'é'.repeat(600_000) });
    expect(note.length).toBeLessThan(1024 * 1024);
    expect(Buffer.byteLength(note, 'utf8')).toBeGreaterThan(1024 * 1024);
    expect(projectRewriteLineClaims({ repoPath: os.tmpdir(), targetSha: T, sources: [{ sha: S1, note }] }))
      .toEqual({ lines: [], reason: 'note_too_large' });
  });

  it('a target record with a huge range and a non-empty projection stays byte for byte, at once', () => {
    const target = sourceNote(T, 'session-own', [{ path: 'a.ts', ranges: [{ start_line: 1, end_line: Number.MAX_SAFE_INTEGER }] }]);
    const started = performance.now();
    const r = rebuildRewrittenNote({ targetSha: T, sources: [{ sha: S1, note: src1 }], existingTarget: target, lineProjection: at([3, 4]), ...OPTS });
    expect(performance.now() - started).toBeLessThan(1_000);
    expect(r.payload).toBeNull();
    expect(r.warnings.map((w) => w.code)).toContain('target-lines-unbounded');
    // Without a projection the target is extended exactly as OR-11 always did.
    const plain = rebuildRewrittenNote({ targetSha: T, sources: [{ sha: S1, note: src1 }], existingTarget: target, ...OPTS });
    expect(JSON.parse(plain.payload!).attribution_record.contributions.map((c: any) => c.session.id)).toEqual(['session-own', 'session-one']);
  });

  it.each([
    ['a source outside this rewrite', at([3], { sourceSha: SHA('f') })],
    ['a line past the file bound', at([4_002])],
    ['a line of zero', at([0])],
    ['an unsafe path', at([3], { path: '../escape.ts' })],
    ['a fractional contribution index', at([3], { contributionIndex: 0.5 })],
    ['a negative contribution index', at([3], { contributionIndex: -1 })],
    ['a malformed entry', [null as any]],
    ['more entries than one projection may hold', at(Array.from({ length: 50_001 }, (_, i) => (i % 4_000) + 1))],
  ])('a projection with %s carries no line: OR-11\'s commit-level note, and a warning', (_, lineProjection) => {
    const r = rebuildRewrittenNote({ targetSha: T, sources: [{ sha: S1, note: src1 }], lineProjection, ...OPTS });
    expect(r.payload).toBe(fallback());
    expect(r.warnings.find((w) => w.code === 'rewrite-lines-not-carried')?.detail).toMatch(/^line projection ignored: /);
  });
});
