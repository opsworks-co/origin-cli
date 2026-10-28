// OR-46 batching checkpoint: the line re-anchor, acceptance tracking and the
// rewrite projection read git objects in batches whose subprocess count does
// not grow with the number of files (git-object-batch.ts), keep every
// fail-closed rule, tell a timeout from a git failure, and a rewrite that
// projects nothing for a reason says so once.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { execFileSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';

/** Every git invocation, and an optional stand-in answer for some of them. */
const gitCalls: string[][] = [];
let stub: ((args: string[], real: () => any) => any) | null = null;
vi.mock('../utils/exec.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../utils/exec.js')>();
  return {
    ...real,
    gitDetailed: (args: string[], opts?: any) => {
      gitCalls.push(args);
      const call = () => real.gitDetailed(args, opts);
      return stub ? stub(args, call) : call();
    },
  };
});
vi.mock('../api.js', () => ({ api: { importGitNote: vi.fn(() => Promise.resolve({ ok: true })) } }));

const { runDetailed } = await import('../utils/exec.js');
const { ProjectionTimeout, createProjectionDeadline } = await import('../attribution-line-ranges.js');
const batch = await import('../git-object-batch.js');
const { resolveFileAtRevision, resolveFilesAtRevision } = await import('../attribution-line-reanchor.js');
const { computeAcceptanceMetrics, getLineBlame } = await import('../attribution.js');
const { projectRewriteLineClaims } = await import('../rewrite-line-projection.js');
const { preserveAttributionBatch } = await import('../history-preservation.js');
const { validateFull } = await import('../attribution-record.js');

const isBatch = (a: string[]) => a[0] === 'cat-file' && a[1] === '--batch';
const isCheck = (a: string[]) => a[0] === 'cat-file' && a[1] === '--batch-check';
const blames = () => gitCalls.filter((a) => a.includes('blame')).length;

let repo: string;
const git = (...args: string[]): string => execFileSync('git', args, { cwd: repo, encoding: 'utf-8', stdio: 'pipe' }).trim();
const write = (rel: string, content: string) => {
  fs.mkdirSync(path.dirname(path.join(repo, rel)), { recursive: true });
  fs.writeFileSync(path.join(repo, rel), content);
};
const commit = (msg: string): string => { git('add', '-A'); git('commit', '-q', '--allow-empty', '-m', msg); return git('rev-parse', 'HEAD'); };

beforeEach(() => {
  repo = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'origin-or46-batch-')));
  execFileSync('git', ['init', '-q', '-b', 'main', repo], { stdio: 'pipe' });
  git('config', 'user.email', 'dev@example.com');
  git('config', 'user.name', 'Dev');
  git('config', 'commit.gpgsign', 'false');
  git('config', 'gc.auto', '0');
  gitCalls.length = 0;
  stub = null;
});
afterEach(() => {
  stub = null;
  try { fs.rmSync(repo, { recursive: true, force: true }); } catch { /* ignore */ }
});

/** A source note as the OR-45 writer leaves it: legacy payload + line-level record. */
function lineNote(sha: string, files: Array<{ path: string; ranges: Array<{ start_line: number; end_line: number }> }> | null) {
  const record = {
    schema_version: '1.0',
    revision: { vcs: 'git', id: sha },
    attribution_level: files ? 'line' : 'commit',
    recorded_at: '2026-10-01T00:00:00Z',
    producer: { name: 'origin-cli', version: '0.1.0' },
    contributions: [{
      evidence: 'session_capture', agent: { id: 'codex' }, model: { id: 'gpt-5.3-codex' }, session: { id: 'bench' },
      ...(files ? { files } : {}),
    }],
  };
  expect(validateFull(record).ok).toBe(true);
  return JSON.stringify({ origin: { version: 1, sessionId: 'bench', agent: 'codex', model: 'gpt-5.3-codex' }, attribution_record: record });
}

const name = (i: number) => `src/f${String(i).padStart(4, '0')}.ts`;
const baseLines = (i: number) => Array.from({ length: 30 }, (_, k) => `export const f${i}_${k} = ${k};`);
const aiLines = (i: number) => Array.from({ length: 10 }, (_, k) => `export const ai${i}_${k} = 'ai ${i} ${k}';`);

/** N files on `base`; commit A inserts 10 lines (11-20) into each and claims them. */
function agentFixture(n: number) {
  for (let i = 0; i < n; i++) write(name(i), baseLines(i).join('\n') + '\n');
  const base = commit('base');
  for (let i = 0; i < n; i++) { const l = baseLines(i); write(name(i), [...l.slice(0, 10), ...aiLines(i), ...l.slice(10)].join('\n') + '\n'); }
  const a = commit('ai');
  const note = lineNote(a, Array.from({ length: n }, (_, i) => ({ path: name(i), ranges: [{ start_line: 11, end_line: 20 }] })));
  git('notes', '--ref=origin', 'add', '-f', '-m', note, a);
  return { base, a, note };
}

/** A later human commit: every file shifted, one claimed line rewritten in i%5==1, i%10==2 deleted, i%10==3 renamed. */
function humanEdits(n: number) {
  for (let i = 0; i < n; i++) {
    if (i % 10 === 2) { git('rm', '-q', name(i)); continue; }
    const l = fs.readFileSync(path.join(repo, name(i)), 'utf8').replace(/\n$/, '').split('\n');
    if (i % 5 === 1) l[14] = `export const ai${i}_4 = 'human rewrote it';`;
    write(name(i), ['// header 1', '// header 2', ...l].join('\n') + '\n');
    if (i % 10 === 3) { git('add', name(i)); fs.mkdirSync(path.join(repo, 'moved'), { recursive: true }); git('mv', name(i), name(i).replace('src/', 'moved/')); }
  }
  return commit('human edits');
}

// ─── The batch primitives ───────────────────────────────────────────────────

describe('batch reads frame by byte size and fail closed', () => {
  const HEADERISH = `${'a'.repeat(40)} blob 5\nabc\n${'b'.repeat(40)} missing\n`;

  it('unicode and space paths, header-like and newline content, missing, tree and oversized objects', () => {
    write('dir with space/ünï cödé.ts', 'línea 1\nlínea 2\n');
    write('header.txt', HEADERISH);
    write('no-newline.txt', 'last line without newline');
    write('empty.txt', '');
    write('big.txt', 'x'.repeat(5000));
    commit('objects');
    const names = ['HEAD:dir with space/ünï cödé.ts', 'HEAD:header.txt', 'HEAD:no-newline.txt', 'HEAD:empty.txt', 'HEAD:missing.txt', 'HEAD:dir with space', 'HEAD:big.txt', 'HEAD:bad\nname'];
    gitCalls.length = 0;
    const reads = batch.readBlobs(repo, names, { maxBytes: 4096 }, undefined);
    expect(reads.get('HEAD:dir with space/ünï cödé.ts')).toEqual({ kind: 'text', text: 'línea 1\nlínea 2\n' });
    expect(reads.get('HEAD:header.txt')).toEqual({ kind: 'text', text: HEADERISH });
    expect(reads.get('HEAD:no-newline.txt')).toEqual({ kind: 'text', text: 'last line without newline' });
    expect(reads.get('HEAD:empty.txt')).toEqual({ kind: 'text', text: '' });
    expect(reads.get('HEAD:missing.txt')).toEqual({ kind: 'missing' });
    expect(reads.get('HEAD:dir with space')).toEqual({ kind: 'not_blob' });
    expect(reads.get('HEAD:big.txt')).toEqual({ kind: 'oversized' });
    // A name git's line protocol cannot frame is never sent.
    expect(reads.get('HEAD:bad\nname')).toEqual({ kind: 'missing' });
    expect(gitCalls.map((a) => a.slice(0, 2))).toEqual([['cat-file', '--batch-check'], ['cat-file', '--batch']]);
  });

  it('chunks split at the byte bound and read the same texts; the aggregate cap reads nothing', () => {
    for (let i = 0; i < 6; i++) write(`c${i}.txt`, `${i}`.repeat(100 + i) + '\n');
    commit('chunks');
    const names = Array.from({ length: 6 }, (_, i) => `HEAD:c${i}.txt`);
    const info = batch.catFileCheck(repo, names, undefined);
    const objects = names.map((n) => info.get(n) as { oid: string; size: number });
    const read = (chunkBytes: number) => {
      const texts = new Map<string, string>();
      gitCalls.length = 0;
      batch.readObjects(repo, objects, undefined, (c) => { for (const [k, v] of c) texts.set(k, v); }, chunkBytes);
      return { texts, calls: gitCalls.filter(isBatch).length };
    };
    const whole = read(1 << 20);
    expect(whole.calls).toBe(1);
    // Two objects fit under 220 bytes, a third does not: three chunks of two.
    const split = read(220);
    expect(split.calls).toBe(3);
    expect([...split.texts].sort()).toEqual([...whole.texts].sort());
    expect(whole.texts.size).toBe(6);

    gitCalls.length = 0;
    expect(() => batch.readBlobs(repo, names, { maxBytes: 4096, totalBytes: 300 }, undefined)).toThrow(batch.BatchTooLarge);
    expect(gitCalls.filter(isBatch)).toEqual([]);
  });

  it('a truncated, shifted or padded stream is refused, never read in part', () => {
    const oid = 'c'.repeat(40);
    const want = [{ oid, size: 4 }];
    // A body may hold newlines; only the size says where it ends.
    expect([...batch.parseBatchOutput(`${oid} blob 4\na\nb\n\n`, want)]).toEqual([[oid, 'a\nb\n']]);
    for (const raw of [
      `${oid} blob 4\nabc`,              // body cut short
      `${oid} blob 4\nabcd`,             // final newline missing
      `${oid} blob 5\nabcde\n`,          // a size other than the one checked
      `${'d'.repeat(40)} blob 4\nabcd\n`, // another object
      `${oid} missing\n`,
      `${oid} blob 4\nabcd\nextra`,      // anything after the last object
      '',
    ]) {
      expect(() => batch.parseBatchOutput(raw, want), raw).toThrow(batch.GitBatchError);
    }
  });

  it('a child killed by its timeout is a timeout; a missing program, a full buffer or an exit code is not', () => {
    expect(runDetailed('sleep', ['5'], { timeoutMs: 100 }).timedOut).toBe(true);
    expect(runDetailed('false', []).timedOut).toBeUndefined();
    expect(runDetailed('definitely-not-a-program-or46', []).timedOut).toBeUndefined();
    expect(runDetailed('sh', ['-c', 'yes | head -c 100000'], { maxBuffer: 1000 }).timedOut).toBeUndefined();
    stub = () => ({ stdout: '', stderr: '', status: -1, timedOut: true });
    // The clock says there is time left; the kill still decides.
    expect(() => batch.gitWithin(['rev-parse', 'HEAD'], { cwd: repo, capMs: 10_000 }, createProjectionDeadline(60_000))).toThrow(ProjectionTimeout);
  });
});

// ─── Rewrite projection ─────────────────────────────────────────────────────

describe('the rewrite projection does a fixed number of git calls', () => {
  const amendOf = (base: string, a: string) => git('commit-tree', `${a}^{tree}`, '-p', base, '-m', 'reworded');

  it('100 files under the default budget: every claim carried, at most 10 calls, the same count as for 30 files', () => {
    const calls: number[] = [];
    for (const n of [30, 100]) {
      fs.rmSync(path.join(repo, 'src'), { recursive: true, force: true });
      const { base, a, note } = agentFixture(n);
      const t = amendOf(base, a);
      gitCalls.length = 0;
      const p = projectRewriteLineClaims({ repoPath: repo, targetSha: t, sources: [{ sha: a, note }] });
      expect(p.reason).toBeUndefined();
      expect(p.lines).toHaveLength(10 * n);
      expect(new Set(p.lines.map((l) => l.path)).size).toBe(n);
      calls.push(gitCalls.length);
    }
    expect(calls[0]).toBeLessThanOrEqual(10);
    expect(calls[1]).toBe(calls[0]);
  });

  it('a git kill inside the budget is `timeout`, a git error is `git_failed`', () => {
    const { base, a, note } = agentFixture(3);
    const t = amendOf(base, a);
    // A minute of budget left: only the kill itself can make it a timeout.
    const run = () => projectRewriteLineClaims({ repoPath: repo, targetSha: t, sources: [{ sha: a, note }], deadline: createProjectionDeadline(60_000) });
    const steps: Record<string, (x: string[]) => boolean> = {
      'rev-list': (x) => x[0] === 'rev-list',
      'batch-check': isCheck,
      'patch': (x) => x.includes('diff-tree'),
      'batch': isBatch,
    };
    for (const [step, at] of Object.entries(steps)) {
      stub = (args, real) => (at(args) ? { stdout: '', stderr: '', status: -1, timedOut: true } : real());
      expect(run(), step).toEqual({ lines: [], reason: 'timeout' });
      stub = (args, real) => (at(args) ? { stdout: '', stderr: 'fatal: broken', status: 128 } : real());
      // A target git cannot list is not a commit; any other git error is `git_failed`.
      expect(run(), step).toEqual({ lines: [], reason: step === 'rev-list' ? 'target_not_commit' : 'git_failed' });
    }
  });

  it('blobs past the aggregate bound project nothing and are never read', () => {
    const { base, a, note } = agentFixture(25);
    const t = amendOf(base, a);
    // Each blob claims 3 MB: 25 distinct blobs pass the 64 MiB bound together.
    stub = (args, real) => {
      const r = real();
      return isCheck(args) ? { ...r, stdout: r.stdout.replace(/ blob \d+$/gm, ' blob 3000000') } : r;
    };
    gitCalls.length = 0;
    expect(projectRewriteLineClaims({ repoPath: repo, targetSha: t, sources: [{ sha: a, note }] })).toEqual({ lines: [], reason: 'too_many_claim_bytes' });
    expect(gitCalls.filter(isBatch)).toEqual([]);
  });
});

// ─── Warnings of a rewrite ──────────────────────────────────────────────────

describe('a projection that gives up is reported once', () => {
  const rewriteWarnings = (pairs: Array<[string, string]>) => {
    const r = preserveAttributionBatch(repo, pairs.map(([oldSha, newSha]) => ({ oldSha, newSha })));
    return r.warnings.filter((w) => w.code === 'rewrite-lines-not-carried');
  };
  const level = (sha: string) => JSON.parse(git('notes', '--ref=origin', 'show', sha)).attribution_record.attribution_level;
  const timeoutOnPatch = () => { stub = (args, real) => (args.includes('-p') && args.includes('diff-tree') ? { stdout: '', stderr: '', status: -1, timedOut: true } : real()); };

  it('a timeout: one warning with the reason, and the commit-level note', () => {
    const { base, a } = agentFixture(2);
    const t = git('commit-tree', `${a}^{tree}`, '-p', base, '-m', 'reworded');
    timeoutOnPatch();
    const w = rewriteWarnings([[a, t]]);
    expect(w).toHaveLength(1);
    expect(w[0]).toMatchObject({ sha: t, detail: expect.stringContaining('timeout') });
    expect(level(t)).toBe('commit');
  });

  it('a rebuild over recorded sources still reports once', () => {
    // Two batches name the same squash target: the second finds the recorded sources with a probe build first.
    write('a.ts', 'base\n');
    const base = commit('base');
    write('a.ts', 'base\none\n');
    const s1 = commit('one');
    git('notes', '--ref=origin', 'add', '-f', '-m', lineNote(s1, [{ path: 'a.ts', ranges: [{ start_line: 2, end_line: 2 }] }]), s1);
    write('a.ts', 'base\none\ntwo\n');
    const s2 = commit('two');
    git('notes', '--ref=origin', 'add', '-f', '-m', lineNote(s2, [{ path: 'a.ts', ranges: [{ start_line: 3, end_line: 3 }] }]), s2);
    const t = git('commit-tree', `${s2}^{tree}`, '-p', base, '-m', 'squash');
    expect(rewriteWarnings([[s1, t]])).toEqual([]);
    timeoutOnPatch();
    gitCalls.length = 0;
    expect(rewriteWarnings([[s2, t]])).toHaveLength(1);
    // The probe build runs no projection; the one stabilized projection asks for one patch.
    expect(gitCalls.filter((x) => x.includes('diff-tree') && x.includes('-p')).length).toBe(1);
  });

  it('no line claims to carry is not a reason: no warning', () => {
    write('a.ts', 'base\n');
    const base = commit('base');
    write('a.ts', 'base\none\n');
    const s = commit('one');
    git('notes', '--ref=origin', 'add', '-f', '-m', lineNote(s, null), s);
    const t = git('commit-tree', `${s}^{tree}`, '-p', base, '-m', 'reworded');
    expect(rewriteWarnings([[s, t]])).toEqual([]);
    expect(level(t)).toBe('commit');
  });
});

// ─── Acceptance tracking and the bulk re-anchor ─────────────────────────────

describe('acceptance tracking: one blame per HEAD path plus a constant', () => {
  const run = (n: number) => {
    fs.rmSync(path.join(repo, 'src'), { recursive: true, force: true });
    fs.rmSync(path.join(repo, 'moved'), { recursive: true, force: true });
    const { base } = agentFixture(n);
    humanEdits(n);
    gitCalls.length = 0;
    const m = computeAcceptanceMetrics(repo, `${base}..HEAD`);
    return { m, calls: gitCalls.length, blames: blames() };
  };

  it('the fates of the baseline, and the calls grow only by one blame per HEAD path', () => {
    const small = run(20);
    // 200 lines: 2 files deleted (20), 4 claimed lines overridden, the rest accepted.
    expect(small.m).toEqual({ totalAiLines: 200, acceptedLines: 176, overriddenLines: 4, deletedLines: 20, unknownLines: 0, acceptanceRate: 0.88 });
    expect(small.blames).toBe(18);
    expect(small.calls).toBeLessThanOrEqual(small.blames + 30);

    const large = run(40);
    expect(large.m).toEqual({ totalAiLines: 400, acceptedLines: 352, overriddenLines: 8, deletedLines: 40, unknownLines: 0, acceptanceRate: 0.88 });
    expect(large.blames).toBe(36);
    expect(large.calls - small.calls).toBe(large.blames - small.blames);
  });

  it('a failing batch leaves the claims unknown, never guessed', () => {
    const { base } = agentFixture(5);
    humanEdits(5);
    // Every blob read of the bulk re-anchor fails: no file can be resolved.
    stub = (args, real) => (isBatch(args) && gitCalls.some((x) => x.includes('blame') || x[0] === 'ls-tree') ? { stdout: '', stderr: 'fatal', status: 128 } : real());
    // f0002 was deleted: its 10 lines are `deleted` without any blob; the rest cannot be told.
    expect(computeAcceptanceMetrics(repo, `${base}..HEAD`))
      .toEqual({ totalAiLines: 50, acceptedLines: 0, overriddenLines: 0, deletedLines: 10, unknownLines: 40, acceptanceRate: 0 });
  });

  it('the bulk re-anchor gives every file exactly the single-file result', () => {
    agentFixture(12);
    humanEdits(12);
    write('notes.ipynb', '{}\n');
    write('link-target.txt', 'x\n');
    fs.symlinkSync('link-target.txt', path.join(repo, 'link'));
    const head = commit('more');
    const paths = git('ls-tree', '-r', '--name-only', 'HEAD').split('\n').concat(['missing.ts', '../escape.ts', 'link']);
    const bulk = resolveFilesAtRevision({ repoPath: repo, targetRevision: head, targetPaths: paths, deadline: createProjectionDeadline(60_000) });
    for (const p of paths) {
      const one = resolveFileAtRevision({ repoPath: repo, targetRevision: head, targetPath: p, deadline: createProjectionDeadline(60_000) });
      const many = bulk.get(p)!;
      expect(many.result, p).toEqual(one.result);
      expect(many.origins, p).toEqual(one.origins);
      expect(many.targetText, p).toEqual(one.targetText);
    }
    expect(bulk.get('src/f0000.ts')!.result.claims.length).toBeGreaterThan(0);
    expect(bulk.get('link')!.result.failure).toBe('non_text');
    expect(bulk.get('missing.ts')!.result.failure).toBe('target_unreadable');
  });
});

// ─── Revision 1: note batches are bounded and never read as "no notes" ──────

describe('notes that cannot be read are never an empty acceptance', () => {
  const isNotesList = (a: string[]) => a[0] === 'notes' && a.includes('list');
  /** The n-th (1-based) call of a kind, counted over this test's calls. */
  const nth = (kind: (a: string[]) => boolean, n: number) => (args: string[]) => kind(args) && gitCalls.filter(kind).length === n;
  /** The first call of `kind` after the n-th `notes list`. */
  const afterNotesList = (kind: (a: string[]) => boolean, n: number) => (args: string[]) => {
    if (!kind(args)) return false;
    const lists = gitCalls.map((a, k) => (isNotesList(a) ? k : -1)).filter((k) => k >= 0);
    if (lists.length < n) return false;
    const since = gitCalls.slice(lists[n - 1] + 1);
    return since.filter(kind).length === 1 && lists.length === n;
  };
  const failing = { stdout: '', stderr: 'fatal: broken', status: 128 };
  const unavailable = (reason: string) => ({ totalAiLines: 0, acceptedLines: 0, overriddenLines: 0, deletedLines: 0, unknownLines: 0, acceptanceRate: null, unavailable: reason });

  it('a repository without a notes ref: an empty snapshot, an available empty acceptance', () => {
    write('a.ts', 'one\n');
    const base = commit('base');
    write('a.ts', 'one\ntwo\n');
    commit('two');
    expect(batch.noteBlobs(repo, 'refs/notes/origin', undefined)).toEqual(new Map());
    const m = computeAcceptanceMetrics(repo, `${base}..HEAD`);
    expect(m).toEqual({ totalAiLines: 0, acceptedLines: 0, overriddenLines: 0, deletedLines: 0, unknownLines: 0, acceptanceRate: null });
    expect('unavailable' in m).toBe(false);
  });

  it('a failing or malformed notes list, a failing or truncated note batch: `notes_unreadable`, not zeros', () => {
    const { base } = agentFixture(3);
    humanEdits(3);
    const range = `${base}..HEAD`;
    const cases: Array<(args: string[], real: () => any) => any> = [
      (args, real) => (nth(isNotesList, 1)(args) ? failing : real()),
      (args, real) => (nth(isNotesList, 1)(args) ? { ...real(), stdout: 'not a row\n' } : real()),
      (args, real) => (afterNotesList(isBatch, 1)(args) ? failing : real()),
      (args, real) => {
        const r = real();
        return afterNotesList(isBatch, 1)(args) ? { ...r, stdout: r.stdout.slice(0, -5) } : r;
      },
      (args, real) => (afterNotesList(isCheck, 1)(args) ? { ...real(), stdout: real().stdout.replace(/^\S+ blob \d+$/m, 'x missing') } : real()),
    ];
    for (const c of cases) {
      gitCalls.length = 0;
      stub = c;
      expect(computeAcceptanceMetrics(repo, range)).toEqual(unavailable('notes_unreadable'));
    }
    expect(() => { stub = (args, real) => (isNotesList(args) ? { ...real(), stdout: 'garbage\n' } : real()); batch.noteBlobs(repo, 'refs/notes/origin', undefined); })
      .toThrow(batch.GitBatchError);
  });

  it('notes past the byte bound, together or alone: `too_many_note_bytes`, and no note body is read', () => {
    const { base } = agentFixture(2);
    write('b.ts', 'b\n');
    const b = commit('second agent commit');
    git('notes', '--ref=origin', 'add', '-f', '-m', lineNote(b, [{ path: 'b.ts', ranges: [{ start_line: 1, end_line: 1 }] }]), b);
    const range = `${base}..HEAD`;
    for (const size of [40 * 1024 * 1024 /* two of them pass 64 MiB */, 65 * 1024 * 1024 /* each alone */]) {
      gitCalls.length = 0;
      stub = (args, real) => {
        const r = real();
        return afterNotesList(isCheck, 1)(args) ? { ...r, stdout: r.stdout.replace(/ blob \d+$/gm, ` blob ${size}`) } : r;
      };
      expect(computeAcceptanceMetrics(repo, range)).toEqual(unavailable('too_many_note_bytes'));
      expect(gitCalls.filter(isBatch)).toEqual([]);
    }
  });

  it('the bulk re-anchor: a failing notes list or note batch fails the files, never `no_record` or human', () => {
    const { base } = agentFixture(5);
    const head = humanEdits(5);
    const paths = git('ls-tree', '-r', '--name-only', 'HEAD').split('\n');
    for (const at of [isNotesList, afterNotesList(isBatch, 1)]) {
      gitCalls.length = 0;
      stub = (args, real) => (at(args) ? failing : real());
      const bulk = resolveFilesAtRevision({ repoPath: repo, targetRevision: head, targetPaths: paths, deadline: createProjectionDeadline(60_000) });
      for (const p of paths) {
        expect(bulk.get(p)!.result, p).toMatchObject({ status: 'failed', failure: 'internal_error', claims: [], unresolved: [] });
      }
    }
    // In acceptance the tracking pass reads the notes, the bulk re-anchor fails:
    // f0002's 10 deleted lines need no blob, the other 40 cannot be told.
    gitCalls.length = 0;
    stub = (args, real) => (nth(isNotesList, 2)(args) ? failing : real());
    expect(computeAcceptanceMetrics(repo, `${base}..HEAD`))
      .toEqual({ totalAiLines: 50, acceptedLines: 0, overriddenLines: 0, deletedLines: 10, unknownLines: 40, acceptanceRate: 0 });
  });

  it('the bulk re-anchor: notes past its bound fail the files before any note body is read', () => {
    // 40 agent commits, each adding and claiming one line of one file.
    write('a.ts', 'base\n');
    commit('base');
    for (let k = 1; k <= 40; k++) {
      fs.appendFileSync(path.join(repo, 'a.ts'), `line ${k}\n`);
      const s = commit(`line ${k}`);
      git('notes', '--ref=origin', 'add', '-f', '-m', lineNote(s, [{ path: 'a.ts', ranges: [{ start_line: k + 1, end_line: k + 1 }] }]), s);
    }
    const head = git('rev-parse', 'HEAD');
    const resolve = () => resolveFilesAtRevision({ repoPath: repo, targetRevision: head, targetPaths: ['a.ts'], deadline: createProjectionDeadline(60_000) }).get('a.ts')!;
    expect(resolve().result.claims.length).toBe(40);
    // Each note now claims 1 000 000 bytes: 40 of them pass the 32 MiB bound.
    gitCalls.length = 0;
    stub = (args, real) => {
      const r = real();
      return afterNotesList(isCheck, 1)(args) ? { ...r, stdout: r.stdout.replace(/ blob \d+$/gm, ' blob 1000000') } : r;
    };
    expect(resolve().result).toMatchObject({ status: 'failed', failure: 'internal_error', claims: [] });
    const lists = gitCalls.findIndex(isNotesList);
    expect(gitCalls.slice(lists).filter(isBatch)).toEqual([]);
  });
});

describe('commit evidence reads every blamed commit message in one call (CR1)', () => {
  /** One file whose `n` lines each blame to their own agent commit without a note. */
  const agentFile = (file: string, n: number) => {
    const lines: string[] = [];
    for (let k = 0; k < n; k++) {
      lines.push(`line ${k} of ${file}`);
      write(file, lines.join('\n') + '\n');
      commit(`agent ${k}\n\nCo-Authored-By: Claude <noreply@anthropic.com>`);
    }
  };
  const isMessageLog = (a: string[]) => a.includes('log') && a.includes('--stdin');

  it('6 and 18 blamed commits: one `git log --no-walk --stdin`, the same non-blame calls, every line AI/commit', () => {
    agentFile('six.ts', 6);
    agentFile('eighteen.ts', 18);
    const measure = (file: string, n: number) => {
      gitCalls.length = 0;
      const lines = getLineBlame(repo, file);
      expect(lines).toHaveLength(n);
      expect(new Set(lines.map((l) => (l.authorship === 'ai' ? `${l.authorship}:${l.confidence}:${l.agent}` : l.authorship)))).toEqual(new Set(['ai:commit:claude-code']));
      expect(new Set(lines.map((l) => l.commitSha)).size).toBe(n);
      const logs = gitCalls.filter(isMessageLog);
      expect(logs).toHaveLength(1);
      expect(logs[0]).toContain('--no-walk=unsorted');
      return gitCalls.filter((a) => !a.includes('blame')).map((a) => a.filter((x) => !/^[0-9a-f]{40}/.test(x)).map((x) => (x === file ? '<file>' : x)).join(' '));
    };
    const small = measure('six.ts', 6);
    const large = measure('eighteen.ts', 18);
    expect(large).toEqual(small);
  });
});
