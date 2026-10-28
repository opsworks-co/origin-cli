// `origin export --format=line-claims <commit>` (OR-21 / M1): the
// `origin-line-claims/1` document of one commit's anchor paths. These tests pin
// which paths are resolved (combined diff, tree-entry filter before the path
// limit), that every claim is exactly what OR-46 proves for a later revision
// that shows the same file, what never reaches the document, and the command's
// usage, offline and bare-repository behaviour.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { execFileSync, spawn, spawnSync } from 'child_process';
import fs from 'fs';
import http from 'http';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';

const hooks = vi.hoisted(() => ({
  resolverCalls: [] as string[][],
  identityOff: false,
  fingerprintOff: false,
  fingerprintCalls: 0,
  readRecordCalls: 0,
  gitCalls: [] as string[][],
  noteReadTimeout: false,
}));

// Can make reading note blobs run out of time (export takes no deadline, so
// this is how its top-level handling of a note-read timeout is reached).
vi.mock('../git-object-batch.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../git-object-batch.js')>();
  const { ProjectionTimeout } = await import('../attribution-line-ranges.js');
  return {
    ...real,
    readBlobs: (...args: Parameters<typeof real.readBlobs>) => {
      if (hooks.noteReadTimeout) throw new ProjectionTimeout();
      return real.readBlobs(...args);
    },
  };
});

// Every git invocation the export and the resolver make.
vi.mock('../utils/exec.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../utils/exec.js')>();
  return {
    ...real,
    gitDetailed: (args: string[], opts?: any) => { hooks.gitCalls.push(args); return real.gitDetailed(args, opts); },
  };
});

// Counts the parses of a canonical record (every note is read through readRecord).
vi.mock('../attribution-record.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../attribution-record.js')>();
  return { ...real, readRecord: (input: unknown) => { hooks.readRecordCalls++; return real.readRecord(input); } };
});

// Records every set of target paths the export hands to the OR-46 resolver,
// and can make the resolver's snapshot prove no identity.
vi.mock('../attribution-line-reanchor.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../attribution-line-reanchor.js')>();
  return {
    ...real,
    resolveFilesAtRevision: (input: Parameters<typeof real.resolveFilesAtRevision>[0]) => {
      hooks.resolverCalls.push([...input.targetPaths]);
      const out = real.resolveFilesAtRevision(input);
      if (!hooks.identityOff) return out;
      return new Map([...out].map(([p, r]) => [p, { ...r, identityOf: () => null }]));
    },
  };
});

// Can make every record unfingerprintable (a valid v1 record always has a
// canonical form, so this is the only way to reach that branch).
vi.mock('../attribution-record-fingerprint.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../attribution-record-fingerprint.js')>();
  return {
    ...real,
    recordFingerprint: (r: unknown) => {
      hooks.fingerprintCalls++;
      return hooks.fingerprintOff ? null : real.recordFingerprint(r);
    },
  };
});

const { exportLineClaims, selectAnchorPaths, decodeGitPaths, LineClaimsExportError } = await import('../attribution-line-claims-export.js');
const { reanchorFileAtRevision, resolveFilesAtRevision, UnreadableNoteError } = await import('../attribution-line-reanchor.js');
const { exportAttributionRecords } = await import('../attribution-export.js');
const { validateFull } = await import('../attribution-record.js');
type LineClaimsDocument = import('../attribution-line-claims-export.js').LineClaimsDocument;
type LineClaimsFile = import('../attribution-line-claims-export.js').LineClaimsFile;

const here = path.dirname(fileURLToPath(import.meta.url));
const distPath = path.resolve(here, '../../dist/index.js');
const TOKEN = /^origin-record-fingerprint\/1:sha256:[0-9a-f]{64}$/;

const rows = (from: number, to: number) =>
  Array.from({ length: to - from + 1 }, (_, i) => `Row ${from + i}`).join('\n') + '\n';

// ─── Records ────────────────────────────────────────────────────────────────

type Range = { start_line: number; end_line: number; iteration_index?: number };

const contribution = (session: string, files?: Array<{ path: string; ranges: Range[] }>, iterations: number[] = [], agent = 'claude-code') => ({
  evidence: 'session_capture',
  agent: { id: agent },
  model: { id: 'claude-opus-4-6' },
  session: iterations.length ? { id: session, iterations: iterations.map((index) => ({ index })) } : { id: session },
  ...(files ? { files } : {}),
});

const record = (sha: string, contributions: any[]) => ({
  schema_version: '1.0',
  revision: { vcs: 'git', id: sha },
  attribution_level: contributions.some((c) => c.files) ? 'line' : 'commit',
  recorded_at: '2026-10-20T00:00:00Z',
  producer: { name: 'origin-cli', version: '0.20261020.1504' },
  contributions,
});

const lineRecord = (sha: string, filePath: string, ranges: Range[], session = 'session-agent', agent = 'claude-code') =>
  record(sha, [contribution(session, [{ path: filePath, ranges }], [...new Set(ranges.flatMap((r) => r.iteration_index ?? []))], agent)]);

// ─── Repository ─────────────────────────────────────────────────────────────

let tmp: string;
let repo: string;

const g = (args: string[], cwd = repo): string =>
  execFileSync('git', args, { cwd, encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const write = (rel: string, content: string | Buffer) => {
  fs.mkdirSync(path.dirname(path.join(repo, rel)), { recursive: true });
  fs.writeFileSync(path.join(repo, rel), content);
};
const commit = (msg: string): string => {
  g(['add', '-A']);
  g(['commit', '-q', '--allow-empty', '-m', msg]);
  return g(['rev-parse', 'HEAD']);
};
const note = (sha: string, rec: unknown, extra: Record<string, unknown> = {}) => {
  expect(validateFull(rec).ok).toBe(true);
  g(['notes', '--ref=origin', 'add', '-f', '-m', JSON.stringify({ ...extra, attribution_record: rec }), sha]);
};
const claimLines = (sha: string, file: string, ranges: Range[], session = 'session-agent', agent = 'claude-code') =>
  note(sha, lineRecord(sha, file, ranges, session, agent));

const doc = (sha: string, opts = {}, cwd = repo): LineClaimsDocument => exportLineClaims(cwd, sha, opts).document;
const file = (d: LineClaimsDocument, p: string): LineClaimsFile | undefined => d.files.find((f) => f.path === p);
const paths = (d: LineClaimsDocument) => d.files.map((f) => f.path);
const lastResolve = () => hooks.resolverCalls[hooks.resolverCalls.length - 1];

function newRepo(dir: string): string {
  fs.mkdirSync(dir, { recursive: true });
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: dir });
  for (const [k, v] of [['user.email', 't@t.co'], ['user.name', 'T'], ['commit.gpgsign', 'false'], ['core.autocrlf', 'false']]) {
    execFileSync('git', ['config', k, v], { cwd: dir });
  }
  return dir;
}

beforeEach(() => {
  hooks.resolverCalls.length = 0;
  hooks.identityOff = false;
  hooks.fingerprintOff = false;
  hooks.fingerprintCalls = 0;
  hooks.readRecordCalls = 0;
  hooks.gitCalls.length = 0;
  hooks.noteReadTimeout = false;
  tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'origin-line-claims-')));
  repo = newRepo(path.join(tmp, 'repo'));
});
afterEach(() => { try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* ignore */ } });

// ─── Path selection ─────────────────────────────────────────────────────────

describe('anchor paths', () => {
  it('a root commit resolves its whole tree', () => {
    write('a.ts', rows(1, 3));
    write('dir/b.ts', rows(1, 2));
    const x = commit('root');
    const d = doc(x);
    expect(d.status).toBe('complete');
    expect(paths(d)).toEqual(['a.ts', 'dir/b.ts']);
    expect(lastResolve()).toEqual(['a.ts', 'dir/b.ts']);
  });

  it('a commit resolves only the paths it changed', () => {
    write('a.ts', rows(1, 3));
    write('b.ts', rows(1, 3));
    commit('root');
    write('a.ts', rows(1, 4));
    const y = commit('change a');
    expect(paths(doc(y))).toEqual(['a.ts']);
    expect(lastResolve()).toEqual(['a.ts']);
  });

  it('a merge resolves only paths that differ from every parent', () => {
    write('a.ts', 'a\n'); write('b.ts', 'b\n'); write('c.ts', 'c\n');
    const base = commit('base');
    g(['checkout', '-q', '-b', 'side', base]);
    write('b.ts', 'b right\n'); write('c.ts', 'c right\n');
    commit('right');
    g(['checkout', '-q', 'main']);
    write('a.ts', 'a left\n'); write('c.ts', 'c left\n');
    commit('left');
    spawnSync('git', ['merge', '-q', '--no-commit', 'side'], { cwd: repo });
    write('c.ts', 'c merged\n');
    const merge = commit('merge');
    // a.ts equals the left parent, b.ts the right one: not anchors of the merge.
    expect(paths(doc(merge))).toEqual(['c.ts']);
    expect(lastResolve()).toEqual(['c.ts']);
  });

  it('a commit with no file changes resolves nothing', () => {
    write('a.ts', 'a\n');
    commit('root');
    const empty = commit('empty');
    expect(doc(empty)).toMatchObject({ status: 'complete', files: [], sources: {} });
  });
});

describe('deletions and type changes never reach the resolver', () => {
  it('deleted paths are dropped before the path limit', () => {
    for (let i = 1; i <= 4; i++) write(`d${i}.ts`, `${i}\n`);
    commit('base');
    for (let i = 1; i <= 4; i++) g(['rm', '-q', `d${i}.ts`]);
    write('n.ts', 'new\n');
    const y = commit('delete four, add one');
    const d = doc(y, { maxPaths: 3 });
    expect(d.status).toBe('complete');
    expect(paths(d)).toEqual(['n.ts']);
    expect(lastResolve()).toEqual(['n.ts']);
  });

  it('a merge that deletes a path both parents kept does not list it', () => {
    write('a.ts', 'a\n');
    const base = commit('base');
    g(['checkout', '-q', '-b', 'side', base]);
    write('y.ts', 'y\n');
    commit('side');
    g(['checkout', '-q', 'main']);
    write('z.ts', 'z\n');
    commit('main');
    g(['merge', '-q', '--no-commit', 'side']);
    g(['rm', '-q', 'a.ts']);
    const merge = commit('merge deleting a.ts');
    expect(selectAnchorPaths(repo, merge)).toEqual([]);
    expect(paths(doc(merge))).toEqual([]);
    expect(hooks.resolverCalls.flat()).not.toContain('a.ts');
  });

  it('a rename is a deletion plus a new path; the claims follow from the old one', () => {
    write('a.ts', rows(1, 6));
    const x = commit('agent');
    claimLines(x, 'a.ts', [{ start_line: 2, end_line: 4 }]);
    g(['mv', 'a.ts', 'b.ts']);
    const y = commit('rename');
    const d = doc(y);
    expect(paths(d)).toEqual(['b.ts']);
    expect(lastResolve()).toEqual(['b.ts']);
    expect(file(d, 'b.ts')).toMatchObject({
      status: 'resolved',
      claims: [{ start_line: 2, end_line: 4, source_revision: x, source_path: 'a.ts', source_start_line: 2, source_end_line: 4 }],
    });
  });

  it('file → symlink is a failed non_text file; symlink → file resolves', () => {
    write('target.ts', 'x\n');
    write('t.ts', 'file\n');
    commit('base');
    fs.rmSync(path.join(repo, 't.ts'));
    fs.symlinkSync('target.ts', path.join(repo, 't.ts'));
    const toLink = commit('to symlink');
    expect(file(doc(toLink), 't.ts')).toEqual({ path: 't.ts', status: 'failed', failure: 'non_text' });
    fs.rmSync(path.join(repo, 't.ts'));
    write('t.ts', 'file again\n');
    const toFile = commit('to file');
    expect(file(doc(toFile), 't.ts')).toMatchObject({ status: 'resolved', line_count: 1 });
  });

  it('file → directory drops the old path and resolves the new one', () => {
    write('p', 'was a file\n');
    commit('base');
    fs.rmSync(path.join(repo, 'p'));
    write('p/x.ts', 'now a dir\n');
    const y = commit('file to directory');
    expect(paths(doc(y))).toEqual(['p/x.ts']);
    expect(hooks.resolverCalls.flat()).not.toContain('p');
  });

  it('binary, notebook and oversized files are failed entries; a quoted path claims nothing', () => {
    write('bin.dat', Buffer.from([0x61, 0x00, 0x62, 0x0a]));
    write('nb.ipynb', '{}\n');
    write('big.ts', rows(1, 4100));
    write('q"uote.ts', rows(1, 2));
    const x = commit('files');
    claimLines(x, 'q"uote.ts', [{ start_line: 1, end_line: 2 }]);
    const d = doc(x);
    expect(file(d, 'bin.dat')).toEqual({ path: 'bin.dat', status: 'failed', failure: 'non_text' });
    expect(file(d, 'nb.ipynb')).toEqual({ path: 'nb.ipynb', status: 'failed', failure: 'notebook' });
    expect(file(d, 'big.ts')).toEqual({ path: 'big.ts', status: 'failed', failure: 'oversized' });
    // As in OR-46: blame names the path quoted, so no line can be proven.
    expect(file(d, 'q"uote.ts')).toMatchObject({ status: 'resolved', claims: [], unresolved: [{ start_line: 1, end_line: 2, reason: 'unsafe_path' }] });
  });
});

// ─── The proof is OR-46's, under the anchor ─────────────────────────────────

const proof = (claims: any[]) => claims.map((c) => JSON.parse(JSON.stringify({
  start_line: c.start_line, end_line: c.end_line,
  source_revision: c.source_revision, source_path: c.source_path,
  source_start_line: c.source_start_line, source_end_line: c.source_end_line,
  contribution_index: c.contribution_index, file_index: c.file_index, range_index: c.range_index,
  iteration_index: c.iteration_index,
})));

/** A later revision `y` shows `p` as its anchor L does: L's document must hold exactly the claims OR-46 proves at y. */
function expectAnchorEquivalent(y: string, p: string) {
  const anchor = g(['rev-list', '-1', y, '--', p]);
  const f = file(doc(anchor), p);
  expect(f, `${p} is an anchor path of ${anchor}`).toBeDefined();
  const direct = reanchorFileAtRevision({ repoPath: repo, targetRevision: y, targetPath: p });
  expect(direct.status).toBe('resolved');
  expect(f!.status).toBe('resolved');
  if (f!.status !== 'resolved') return;
  expect(proof(f!.claims)).toEqual(proof(direct.claims));
  expect(f!.unresolved).toEqual(direct.unresolved);
  expect(f!.line_count).toBe(Math.max(0, ...[...direct.claims, ...direct.unresolved].map((r) => r.end_line)));
}

describe('equivalence: the anchor document is what OR-46 proves at any later revision', () => {
  it('insertion above, unrelated commits, reformatting, a rewrite by a later agent and a rename', () => {
    write('a.ts', rows(1, 10));
    const x = commit('agent writes a.ts');
    claimLines(x, 'a.ts', [{ start_line: 3, end_line: 5, iteration_index: 0 }]);
    write('o1.ts', 'o\n');
    expectAnchorEquivalent(commit('unrelated'), 'a.ts');

    write('a.ts', 'import a\nimport b\n' + rows(1, 10));
    commit('human inserts above');
    write('o2.ts', 'o\n');
    expectAnchorEquivalent(commit('unrelated'), 'a.ts');

    write('a.ts', ('import a\nimport b\n' + rows(1, 10)).replace('Row 4\n', '  Row 4\n'));
    expectAnchorEquivalent(commit('format'), 'a.ts');

    write('a.ts', ('import a\nimport b\n' + rows(1, 10)).replace('Row 4\n', '  Row 4\n').replace('Row 7\n', 'Row seven\n'));
    const later = commit('later agent');
    claimLines(later, 'a.ts', [{ start_line: 9, end_line: 9 }], 'session-later', 'codex');
    expectAnchorEquivalent(later, 'a.ts');

    g(['mv', 'a.ts', 'b.ts']);
    commit('rename');
    write('o3.ts', 'o\n');
    expectAnchorEquivalent(commit('unrelated'), 'b.ts');
  });

  it('a merge that keeps both sides\' claims', () => {
    write('a.ts', rows(1, 10));
    const base = commit('base');
    write('a.ts', rows(1, 10).replace('Row 2\n', 'Row two\n'));
    const left = commit('left agent');
    claimLines(left, 'a.ts', [{ start_line: 2, end_line: 2 }], 'session-left');
    g(['checkout', '-q', '-b', 'side', base]);
    write('a.ts', rows(1, 10).replace('Row 9\n', 'Row nine\n'));
    const right = commit('right agent');
    claimLines(right, 'a.ts', [{ start_line: 9, end_line: 9 }], 'session-right', 'codex');
    g(['checkout', '-q', 'main']);
    g(['merge', '-q', '--no-ff', '-m', 'merge', 'side']);
    write('z.ts', 'z\n');
    const z = commit('after the merge');
    expectAnchorEquivalent(z, 'a.ts');
    const merged = file(doc(g(['rev-list', '-1', z, '--', 'a.ts'])), 'a.ts');
    expect(merged).toMatchObject({ claims: [{ source_revision: left, agent_id: 'claude-code' }, { source_revision: right, agent_id: 'codex' }] });
  });

  it('repeated content and a block moved within the file', () => {
    write('a.ts', 'start\nx = 1\nx = 1\nend\n' + rows(1, 8));
    const x = commit('agent');
    claimLines(x, 'a.ts', [{ start_line: 2, end_line: 12 }]);
    write('a.ts', 'start\nx = 1\nend\n' + rows(3, 8) + rows(1, 2));
    commit('human deletes a duplicate and moves a block');
    write('z.ts', 'z\n');
    expectAnchorEquivalent(commit('unrelated'), 'a.ts');
  });
});

// ─── Document ───────────────────────────────────────────────────────────────

describe('the origin-line-claims/1 document', () => {
  it('has the documented shape, sources for exported claims only, and a full fingerprint', () => {
    write('a.ts', rows(1, 6));
    write('b.ts', rows(1, 2));
    const x = commit('agent');
    note(x, record(x, [contribution('session-agent', [{ path: 'a.ts', ranges: [{ start_line: 2, end_line: 3, iteration_index: 1 }] }], [1])]));
    const d = doc(x);
    expect(d).toEqual({
      protocol: 'origin-line-claims/1',
      path_selection: 'anchor/1',
      revision: { vcs: 'git', id: x },
      producer: { name: 'origin-cli', version: expect.any(String) },
      status: 'complete',
      sources: { [x]: { record_fingerprint: expect.stringMatching(TOKEN) } },
      files: [
        {
          path: 'a.ts', status: 'resolved', line_count: 6,
          claims: [{
            start_line: 2, end_line: 3, source_revision: x, source_path: 'a.ts', source_start_line: 2, source_end_line: 3,
            contribution_index: 0, file_index: 0, range_index: 0, iteration_index: 1, agent_id: 'claude-code', model_id: 'claude-opus-4-6',
          }],
          unresolved: [{ start_line: 1, end_line: 1, reason: 'no_line_claim' }, { start_line: 4, end_line: 6, reason: 'no_line_claim' }],
        },
        { path: 'b.ts', status: 'resolved', line_count: 2, claims: [], unresolved: [{ start_line: 1, end_line: 2, reason: 'no_line_claim' }] },
      ],
    });
    expect(d.sources[x].record_fingerprint).toHaveLength(99);
    // The key order of a claim is the documented one.
    expect(Object.keys((d.files[0] as any).claims[0])).toEqual([
      'start_line', 'end_line', 'source_revision', 'source_path', 'source_start_line', 'source_end_line',
      'contribution_index', 'file_index', 'range_index', 'iteration_index', 'agent_id', 'model_id',
    ]);
  });

  it('is byte-identical on every run, with paths and sources in byte order', () => {
    for (const p of ['é.ts', 'a.ts', 'Z/x.ts', 'B.ts']) write(p, rows(1, 3));
    const x = commit('agent');
    claimLines(x, 'a.ts', [{ start_line: 1, end_line: 1 }]);
    const first = exportLineClaims(repo, x).output;
    expect(exportLineClaims(repo, x).output).toBe(first);
    expect(first.endsWith('\n')).toBe(true);
    expect(first.slice(0, -1)).not.toContain('\n');
    expect(paths(JSON.parse(first))).toEqual(['B.ts', 'Z/x.ts', 'a.ts', 'é.ts']);
  });

  it('every resolved file is partitioned into claims and unresolved runs covering 1..line_count', () => {
    write('a.ts', rows(1, 20));
    write('e.ts', '');
    const x = commit('agent');
    note(x, record(x, [
      contribution('s1', [{ path: 'a.ts', ranges: [{ start_line: 3, end_line: 6 }] }]),
      contribution('s2', [{ path: 'a.ts', ranges: [{ start_line: 6, end_line: 9 }] }]),
    ]));
    const d = doc(x);
    for (const f of d.files) {
      if (f.status !== 'resolved') continue;
      const runs = [...f.claims, ...f.unresolved].sort((a, b) => a.start_line - b.start_line);
      let next = 1;
      for (const r of runs) { expect(r.start_line).toBe(next); next = r.end_line + 1; }
      expect(next - 1).toBe(f.line_count);
    }
    expect(file(d, 'e.ts')).toEqual({ path: 'e.ts', status: 'resolved', line_count: 0, claims: [], unresolved: [] });
    // Line 6 is claimed by two contributions: no winner is picked.
    expect((file(d, 'a.ts') as any).unresolved).toContainEqual({ start_line: 6, end_line: 6, reason: 'ambiguous_claim' });
  });

  it('a claim whose record has no fingerprint is not exported', () => {
    write('a.ts', rows(1, 4));
    const x = commit('agent');
    claimLines(x, 'a.ts', [{ start_line: 2, end_line: 3 }]);
    hooks.fingerprintOff = true;
    const d = doc(x);
    expect(d.sources).toEqual({});
    expect(file(d, 'a.ts')).toMatchObject({
      claims: [],
      unresolved: [
        { start_line: 1, end_line: 1, reason: 'no_line_claim' },
        { start_line: 2, end_line: 3, reason: 'fingerprint_unavailable' },
        { start_line: 4, end_line: 4, reason: 'no_line_claim' },
      ],
    });
  });

  it('a claim whose identity the snapshot does not re-prove is not exported', () => {
    write('a.ts', rows(1, 3));
    const x = commit('agent');
    claimLines(x, 'a.ts', [{ start_line: 1, end_line: 3 }]);
    hooks.identityOff = true;
    const d = doc(x);
    expect(d.sources).toEqual({});
    expect(file(d, 'a.ts')).toMatchObject({ claims: [], unresolved: [{ start_line: 1, end_line: 3, reason: 'identity_unproven' }] });
  });

  it('carries no file text, prompt, prompt hash, session id, recorded_at or legacy payload', () => {
    write('a.ts', 'const SECRET_LINE_TEXT = 1;\nother\n');
    const x = commit('agent');
    const rec = lineRecord(x, 'a.ts', [{ start_line: 1, end_line: 1, iteration_index: 0 }], 'session-SECRET-id');
    (rec.contributions[0].session as any).iterations[0].prompt_hash = `sha256:${'e'.repeat(64)}`;
    note(x, rec, { origin: { sessionId: 'LEGACY-SECRET', promptSummary: 'SECRET PROMPT TEXT' } });
    const out = exportLineClaims(repo, x).output;
    expect(JSON.parse(out).files[0].claims).toHaveLength(1);
    for (const leaked of ['SECRET_LINE_TEXT', 'e'.repeat(64), 'session-SECRET-id', 'LEGACY-SECRET', 'SECRET PROMPT', '2026-10-20T00:00:00Z', 'other']) {
      expect(out).not.toContain(leaked);
    }
  });
});

// ─── Limits and errors ──────────────────────────────────────────────────────

describe('limits', () => {
  it('more anchor paths than --max-paths: nothing is resolved', () => {
    write('a.ts', 'a\n');
    write('b.ts', 'b\n');
    const x = commit('two files');
    const d = doc(x, { maxPaths: 1 });
    expect(d).toMatchObject({ status: 'paths_over_limit', files: [], sources: {} });
    expect(hooks.resolverCalls).toEqual([]);
    expect(doc(x, { maxPaths: 2 }).status).toBe('complete');
  });

  it('a document over the output limit is replaced, not truncated', () => {
    write('a.ts', rows(1, 50));
    const x = commit('file');
    const { document, output } = exportLineClaims(repo, x, { maxOutputBytes: 200 });
    expect(document).toMatchObject({ status: 'output_over_limit', files: [], sources: {} });
    expect(JSON.parse(output)).toEqual(document);
  });

  it('rejects --max-paths outside 1..5000 before reading anything', () => {
    write('a.ts', 'a\n');
    const x = commit('file');
    for (const bad of [0, -1, 5001, 1.5, NaN]) {
      expect(() => exportLineClaims(repo, x, { maxPaths: bad })).toThrow(LineClaimsExportError);
    }
    expect(hooks.resolverCalls).toEqual([]);
  });
});

describe('errors', () => {
  const kindOf = (fn: () => unknown) => { try { fn(); } catch (e: any) { return e instanceof LineClaimsExportError ? e.kind : 'other'; } return 'none'; };

  it('only one full commit id is accepted', () => {
    write('a.ts', 'a\n');
    const x = commit('file');
    for (const bad of ['HEAD', 'main', `${x}..HEAD`, x.slice(0, 12), `-${x.slice(1)}`, `${x} `, '', `${x}0`]) {
      expect(kindOf(() => exportLineClaims(repo, bad)), bad).toBe('usage');
    }
    expect(doc(x.toUpperCase()).revision.id).toBe(x);
  });

  it('not a repository, an unknown commit, a non-commit object and a broken notes ref are git errors', () => {
    write('a.ts', 'a\n');
    const x = commit('file');
    const outside = path.join(tmp, 'plain');
    fs.mkdirSync(outside);
    expect(kindOf(() => exportLineClaims(outside, x))).toBe('git');
    expect(kindOf(() => exportLineClaims(repo, '0'.repeat(40)))).toBe('git');
    expect(kindOf(() => exportLineClaims(repo, g(['rev-parse', 'HEAD^{tree}'])))).toBe('git');
    expect(kindOf(() => exportLineClaims(repo, g(['rev-parse', 'HEAD:a.ts'])))).toBe('git');
    const blob = execFileSync('git', ['hash-object', '-w', '--stdin'], { cwd: repo, input: 'x', encoding: 'utf-8' }).trim();
    g(['update-ref', 'refs/notes/origin', blob]);
    expect(kindOf(() => exportLineClaims(repo, x))).toBe('git');
  });

  it('never writes a note or a ref', () => {
    write('a.ts', rows(1, 3));
    const x = commit('agent');
    claimLines(x, 'a.ts', [{ start_line: 1, end_line: 2 }]);
    const refs = g(['for-each-ref', '--format=%(refname) %(objectname)']);
    const notes = g(['notes', '--ref=origin', 'list']);
    doc(x);
    expect(g(['for-each-ref', '--format=%(refname) %(objectname)'])).toBe(refs);
    expect(g(['notes', '--ref=origin', 'list'])).toBe(notes);
  });
});

// ─── Repositories without notes, and bare ones ──────────────────────────────

describe('repositories', () => {
  it('a fork that received the commits but not the notes proves nothing', () => {
    write('a.ts', rows(1, 4));
    const x = commit('agent');
    claimLines(x, 'a.ts', [{ start_line: 1, end_line: 4 }]);
    const target = path.join(tmp, 'target.git');
    // A plain clone fetches branches, never refs/notes/origin.
    g(['clone', '-q', '--bare', repo, target], tmp);
    expect(spawnSync('git', ['rev-parse', '--verify', '--quiet', 'refs/notes/origin'], { cwd: target }).status).not.toBe(0);
    expect((file(doc(x), 'a.ts') as any).claims).toHaveLength(1);
    expect(file(doc(x, {}, target), 'a.ts')).toMatchObject({ claims: [], unresolved: [{ start_line: 1, end_line: 4, reason: 'no_record' }] });
  });

  it('a bare repository with the notes gives the same document', () => {
    write('a.ts', rows(1, 4));
    const x = commit('agent');
    claimLines(x, 'a.ts', [{ start_line: 2, end_line: 3 }]);
    const bare = path.join(tmp, 'mirror.git');
    g(['clone', '-q', '--bare', repo, bare], tmp);
    g(['fetch', '-q', repo, 'refs/notes/origin:refs/notes/origin'], bare);
    expect(exportLineClaims(bare, x).output).toBe(exportLineClaims(repo, x).output);
  });
});

// ─── M1-R1: one prepared record per source revision ─────────────────────────

describe('a source record is prepared once per call, every claim still proves itself', () => {
  const separated = (n: number): Range[] => Array.from({ length: n }, (_, i) => ({ start_line: 1 + 4 * i, end_line: 2 + 4 * i }));

  it('many claim runs over several files: one parse and one fingerprint of the source record', () => {
    for (const p of ['a.ts', 'b.ts', 'c.ts']) write(p, rows(1, 40));
    const x = commit('agent');
    note(x, record(x, [contribution('session-agent', ['a.ts', 'b.ts', 'c.ts'].map((p) => ({ path: p, ranges: separated(10) })))]));
    hooks.fingerprintCalls = 0;
    hooks.readRecordCalls = 0;
    const d = doc(x);
    const claims = d.files.flatMap((f) => (f.status === 'resolved' ? f.claims : []));
    expect(claims).toHaveLength(30);
    expect(Object.keys(d.sources)).toEqual([x]);
    expect(hooks.readRecordCalls).toBe(1);
    expect(hooks.fingerprintCalls).toBe(1);
  });

  it('a claim whose own range, path or indices the cached view does not cover gets no identity', () => {
    write('a.ts', rows(1, 12));
    const x = commit('agent');
    note(x, record(x, [contribution('session-agent', [{ path: 'a.ts', ranges: separated(3) }])]));
    const resolved = resolveFilesAtRevision({ repoPath: repo, targetRevision: x, targetPaths: ['a.ts'] }).get('a.ts')!;
    const [c0, c1, c2] = resolved.result.claims;
    expect([c0, c1, c2].map((c) => c.range_index)).toEqual([0, 1, 2]);
    expect(resolved.identityOf(c0)).toMatchObject({ agentId: 'claude-code', recordFingerprint: expect.stringMatching(TOKEN) });
    // Contribution 0 is already prepared; c1 must still prove its own range.
    c1.range_index = 0;
    expect(resolved.identityOf(c1)).toBeNull();
    c1.range_index = 1;
    expect(resolved.identityOf(c1)).not.toBeNull();
    c1.source_end_line += 1;
    expect(resolved.identityOf(c1)).toBeNull();
    c1.source_end_line -= 1;
    c2.source_path = 'b.ts';
    expect(resolved.identityOf(c2)).toBeNull();
    c2.source_path = 'a.ts';
    c2.file_index = 1;
    expect(resolved.identityOf(c2)).toBeNull();
    c2.file_index = 0;
    c2.contribution_index = 1;
    expect(resolved.identityOf(c2)).toBeNull();
    c2.contribution_index = 0;
    c2.iteration_index = 0;
    expect(resolved.identityOf(c2)).toBeNull();
    // A copy is not a claim of this call.
    expect(resolved.identityOf({ ...c0 })).toBeNull();
    expect(hooks.fingerprintCalls).toBe(1);
  });
});

// ─── M1-R2: one notes snapshot; an unreadable note the export needs is an error ─

const notesListCalls = () => hooks.gitCalls.filter((a) => a.includes('notes') && a.includes('list')).length;
const deleteObject = (oid: string) => fs.rmSync(path.join(repo, '.git', 'objects', oid.slice(0, 2), oid.slice(2)));

describe('notes', () => {
  it('lists refs/notes/origin exactly once per export', () => {
    write('a.ts', rows(1, 4));
    const x = commit('agent');
    claimLines(x, 'a.ts', [{ start_line: 1, end_line: 2 }]);
    write('a.ts', 'top\n' + rows(1, 4));
    const y = commit('human');
    hooks.gitCalls.length = 0;
    const d = doc(y);
    expect((file(d, 'a.ts') as any).claims).toHaveLength(1);
    expect(notesListCalls()).toBe(1);
  });

  it('a missing notes ref is an empty snapshot: a complete document without claims', () => {
    write('a.ts', rows(1, 3));
    const x = commit('no notes at all');
    const d = doc(x);
    expect(d.status).toBe('complete');
    expect(file(d, 'a.ts')).toMatchObject({ claims: [], unresolved: [{ start_line: 1, end_line: 3, reason: 'no_record' }] });
    expect(notesListCalls()).toBe(1);
  });

  it('a listed note of a revision the export needs that is missing fails the export', () => {
    write('a.ts', rows(1, 3));
    const x = commit('agent');
    note(x, lineRecord(x, 'a.ts', [{ start_line: 1, end_line: 2 }]), { origin: { promptSummary: 'SECRET PROMPT' } });
    deleteObject(g(['notes', '--ref=origin', 'list', x]));
    let caught: any;
    try { exportLineClaims(repo, x); } catch (e) { caught = e; }
    expect(caught).toBeInstanceOf(LineClaimsExportError);
    expect(caught.kind).toBe('git');
    expect(caught.message).toBe(`the attribution note of ${x} cannot be read`);
  });

  it('a listed note that is not a blob is an error with strictNotes, and the old per-file failure without', () => {
    write('a.ts', rows(1, 3));
    const x = commit('agent');
    const tree = g(['rev-parse', `${x}^{tree}`]);
    const notes = new Map([[x, tree]]);
    expect(() => resolveFilesAtRevision({ repoPath: repo, targetRevision: x, targetPaths: ['a.ts'], notes, strictNotes: true }))
      .toThrow(UnreadableNoteError);
    const lenient = resolveFilesAtRevision({ repoPath: repo, targetRevision: x, targetPaths: ['a.ts'], notes }).get('a.ts')!;
    expect(lenient.result).toMatchObject({ status: 'failed', failure: 'internal_error' });
    // The snapshot handed in is the one used: no second `notes list`.
    expect(notesListCalls()).toBe(0);
  });

  // M1-R4: a deadline that runs out exactly while the note of x is read — the
  // first `cat-file --batch-check` after blame — and never before.
  const noteReadDeadline = () => ({
    at: 1_000_000,
    now: () => {
      const blame = hooks.gitCalls.findIndex((a) => a.includes('blame'));
      return blame >= 0 && hooks.gitCalls.slice(blame + 1).some((a) => a.includes('--batch-check')) ? 2_000_000 : 0;
    },
  });

  it('a note read that runs out of time is an error with strictNotes, and a file timeout without', () => {
    write('a.ts', rows(1, 3));
    const x = commit('agent');
    claimLines(x, 'a.ts', [{ start_line: 1, end_line: 2 }]);
    const notes = new Map([[x, g(['notes', '--ref=origin', 'list', x])]]);
    hooks.gitCalls.length = 0;
    expect(() => resolveFilesAtRevision({
      repoPath: repo, targetRevision: x, targetPaths: ['a.ts'], notes, strictNotes: true, deadline: noteReadDeadline(),
    })).toThrow(UnreadableNoteError);
    // Control: lenient OR-46 callers keep the file-level timeout.
    hooks.gitCalls.length = 0;
    const lenient = resolveFilesAtRevision({
      repoPath: repo, targetRevision: x, targetPaths: ['a.ts'], notes, deadline: noteReadDeadline(),
    }).get('a.ts')!;
    expect(lenient.result).toMatchObject({ status: 'failed', failure: 'timeout', claims: [] });
    // And with time to spare the same input resolves.
    expect(resolveFilesAtRevision({ repoPath: repo, targetRevision: x, targetPaths: ['a.ts'], notes, strictNotes: true })
      .get('a.ts')!.result.claims).toHaveLength(1);
  });

  it('the export fails as a whole, redacted, when a note it needs cannot be read in time', () => {
    write('a.ts', 'const SECRET_LINE_TEXT = 1;\n');
    const x = commit('agent');
    note(x, lineRecord(x, 'a.ts', [{ start_line: 1, end_line: 1 }], 'session-SECRET-id'), { origin: { promptSummary: 'SECRET PROMPT' } });
    hooks.noteReadTimeout = true;
    let caught: any;
    let result: unknown;
    try { result = exportLineClaims(repo, x); } catch (e) { caught = e; }
    expect(result).toBeUndefined();
    expect(caught).toBeInstanceOf(LineClaimsExportError);
    expect(caught.kind).toBe('git');
    expect(caught.message).toBe('an attribution note cannot be read');
    expect(caught.message).not.toMatch(/SECRET|a\.ts/);
  });

  it('an unreadable note of a revision the export does not need is never read', () => {
    write('a.ts', rows(1, 3));
    const x = commit('agent');
    claimLines(x, 'a.ts', [{ start_line: 1, end_line: 1 }]);
    write('other.ts', 'o\n');
    const u = commit('unrelated');
    note(u, record(u, [contribution('session-other')]));
    deleteObject(g(['notes', '--ref=origin', 'list', u]));
    write('a.ts', rows(1, 3) + 'more\n');
    const y = commit('touches a.ts');
    const d = doc(y);
    expect(d.status).toBe('complete');
    expect((file(d, 'a.ts') as any).claims).toHaveLength(1);
  });
});

// ─── M1-R3: path names are bytes ────────────────────────────────────────────

/** A commit whose tree holds `entries` — raw path bytes are written with plumbing, never through the file system. */
function commitTree(entries: Array<{ name: Buffer; content: string }>, parent?: string): string {
  const input = Buffer.concat(entries.map(({ name, content }) => {
    const blob = execFileSync('git', ['hash-object', '-w', '--stdin'], { cwd: repo, input: content, encoding: 'utf-8' }).trim();
    return Buffer.concat([Buffer.from(`100644 blob ${blob}\t`), name, Buffer.from([0])]);
  }));
  const tree = execFileSync('git', ['mktree', '-z'], { cwd: repo, input, encoding: 'utf-8' }).trim();
  return execFileSync('git', ['commit-tree', tree, ...(parent ? ['-p', parent] : []), '-m', 'plumbing'], { cwd: repo, encoding: 'utf-8' }).trim();
}

const INVALID_NAME = Buffer.from([0x62, 0xff, 0xfe, 0x2e, 0x74, 0x73]); // "b", two bytes that are never UTF-8, ".ts"

describe('path bytes', () => {
  it('decodes NUL-separated names as strict UTF-8', () => {
    const latin1 = (b: Buffer) => b.toString('latin1');
    const valid = Buffer.concat([Buffer.from('a.ts\u0000dir/é.ts\u0000x�y.ts\u0000', 'utf-8')]);
    expect(decodeGitPaths(latin1(valid), 'c')).toEqual(['a.ts', 'dir/é.ts', 'x�y.ts']);
    expect(decodeGitPaths('', 'c')).toEqual([]);
    expect(() => decodeGitPaths(latin1(Buffer.concat([Buffer.from('a.ts\u0000'), INVALID_NAME, Buffer.from([0])])), 'c'))
      .toThrow(LineClaimsExportError);
  });

  it('rejects output that does not frame: a missing final NUL or an empty field, without echoing it', () => {
    const latin1 = (b: Buffer) => b.toString('latin1');
    const malformed = [
      'secret-path.ts',                       // one path, no terminator
      'a.ts\u0000secret-path.ts',             // last path cut off
      '\u0000',                               // an empty field alone
      'a.ts\u0000\u0000',                     // an empty field after a path
      '\u0000secret-path.ts\u0000',           // an empty field before a path
    ];
    for (const raw of malformed) {
      let caught: any;
      try { decodeGitPaths(latin1(Buffer.from(raw, 'utf-8')), 'c'); } catch (e) { caught = e; }
      expect(caught, JSON.stringify(raw)).toBeInstanceOf(LineClaimsExportError);
      expect(caught.kind).toBe('git');
      expect(caught.message).not.toMatch(/secret-path|a\.ts/);
    }
    // Invalid UTF-8 without a terminator is still a framing error, and never echoed.
    let caught: any;
    try { decodeGitPaths(latin1(INVALID_NAME), 'c'); } catch (e) { caught = e; }
    expect(caught).toBeInstanceOf(LineClaimsExportError);
    expect(caught.message).not.toMatch(/�|ÿ|þ/);
  });

  it('a valid name that contains U+FFFD is an ordinary path', () => {
    const name = 'odd�name.ts';
    write(name, rows(1, 3));
    const x = commit('agent');
    claimLines(x, name, [{ start_line: 2, end_line: 3 }]);
    const d = doc(x);
    expect(paths(d)).toEqual([name]);
    expect(file(d, name)).toMatchObject({ status: 'resolved', claims: [{ start_line: 2, end_line: 3, source_path: name }] });
    expect(lastResolve()).toEqual([name]);
  });

  it('a changed name that is not UTF-8 fails the export, before the path limit', () => {
    const x = commitTree([{ name: Buffer.from('ok.ts'), content: 'ok\n' }, { name: INVALID_NAME, content: 'bad\n' }]);
    for (const opts of [{}, { maxPaths: 1 }]) {
      let caught: any;
      try { exportLineClaims(repo, x, opts); } catch (e) { caught = e; }
      expect(caught).toBeInstanceOf(LineClaimsExportError);
      expect(caught.kind).toBe('git');
      expect(caught.message).not.toMatch(/�|ÿ|þ/);
    }
    expect(hooks.resolverCalls).toEqual([]);
  });

  it('a deleted name that is not UTF-8 also fails the export, never a failed entry or paths_over_limit', () => {
    const p1 = commitTree([{ name: Buffer.from('ok.ts'), content: 'ok\n' }, { name: INVALID_NAME, content: 'bad\n' }]);
    const p2 = commitTree([{ name: Buffer.from('ok.ts'), content: 'ok\n' }], p1);
    expect(() => exportLineClaims(repo, p2)).toThrow(LineClaimsExportError);
    expect(() => exportLineClaims(repo, p2, { maxPaths: 1 })).toThrow(LineClaimsExportError);
    expect(hooks.resolverCalls).toEqual([]);
  });
});

// ─── Built CLI ──────────────────────────────────────────────────────────────

describe('origin export --format=line-claims (built CLI)', () => {
  if (!fs.existsSync(distPath)) {
    it.skip('requires a built CLI (pnpm run build)', () => { /* skipped */ });
    return;
  }

  let home: string;
  let env: NodeJS.ProcessEnv;
  beforeEach(() => {
    home = path.join(tmp, 'home');
    fs.mkdirSync(path.join(home, '.origin'), { recursive: true });
    fs.writeFileSync(path.join(home, '.origin', 'last-update-check.json'), JSON.stringify({ latest: '0.0.1', checkedAt: new Date().toISOString() }));
    env = { ...process.env, HOME: home, USERPROFILE: home };
  });
  const runCli = (args: string[], cwd = repo) => {
    const r = spawnSync(process.execPath, [distPath, ...args], { cwd, env, encoding: 'utf-8' });
    return { stdout: r.stdout, stderr: r.stderr, status: r.status };
  };

  it('prints the document and nothing else; it works in a bare repository', () => {
    write('a.ts', rows(1, 4));
    const x = commit('agent');
    claimLines(x, 'a.ts', [{ start_line: 2, end_line: 3 }]);
    const r = runCli(['export', '--format=line-claims', '--', x]);
    expect(r.status, r.stderr).toBe(0);
    expect(r.stderr).toBe('');
    expect(r.stdout).toBe(exportLineClaims(repo, x).output);
    expect(runCli(['export', '--format', 'line-claims', '--max-paths', '7', x]).stdout).toBe(r.stdout);

    const bare = path.join(tmp, 'bare.git');
    g(['clone', '-q', '--bare', repo, bare], tmp);
    g(['fetch', '-q', repo, 'refs/notes/origin:refs/notes/origin'], bare);
    const fromBare = runCli(['export', '--format=line-claims', x], bare);
    expect(fromBare.status, fromBare.stderr).toBe(0);
    expect(fromBare.stdout).toBe(r.stdout);
  });

  it('usage and git errors exit 1 with nothing on stdout and no note content on stderr', () => {
    write('a.ts', 'a\n');
    const x = commit('file');
    note(x, lineRecord(x, 'a.ts', [{ start_line: 1, end_line: 1 }], 'session-SECRET-id'), { origin: { promptSummary: 'SECRET PROMPT' } });
    const cases: string[][] = [
      ['export', '--format=line-claims'],
      ['export', '--format=line-claims', 'HEAD'],
      ['export', '--format=line-claims', `${x}..HEAD`],
      ['export', '--format=line-claims', x.slice(0, 7)],
      ['export', '--format=line-claims', '--', `-${x.slice(1)}`],
      ['export', '--format=line-claims', '--strict', x],
      ['export', '--format=line-claims', '--limit', '1', x],
      ['export', '--format=line-claims', '--model', 'm', x],
      ['export', '--format=line-claims', '--session', 's', x],
      ['export', '--format=line-claims', '--output', path.join(tmp, 'out.json'), x],
      ['export', '--format=line-claims', '--max-paths', '0', x],
      ['export', '--format=line-claims', '--max-paths', '5001', x],
      ['export', '--format=line-claims', '--max-paths', 'many', x],
      ['export', '--format=json', '--max-paths', '3', `${x}`],
      ['export', '--max-paths', '3'],
      ['export', '--format=line-claims', '0'.repeat(40)],
    ];
    for (const args of cases) {
      const r = runCli(args);
      expect(r.status, args.join(' ')).toBe(1);
      expect(r.stdout, args.join(' ')).toBe('');
      expect(r.stderr, args.join(' ')).toMatch(/Error/);
      expect(r.stderr).not.toMatch(/SECRET/);
    }
    expect(fs.existsSync(path.join(tmp, 'out.json'))).toBe(false);
    const outside = path.join(tmp, 'plain');
    fs.mkdirSync(outside);
    expect(runCli(['export', '--format=line-claims', x], outside)).toMatchObject({ status: 1, stdout: '' });
  });

  it('a broken notes ref, a missing note the export needs and a non-UTF-8 path exit 1 without leaking anything', () => {
    write('a.ts', rows(1, 3));
    const x = commit('agent');
    note(x, lineRecord(x, 'a.ts', [{ start_line: 1, end_line: 2 }], 'session-SECRET-id'), { origin: { promptSummary: 'SECRET PROMPT' } });
    const noteBlob = g(['notes', '--ref=origin', 'list', x]);
    const check = (args: string[], cwd = repo) => {
      const r = runCli(args, cwd);
      expect(r.status, r.stderr).toBe(1);
      expect(r.stdout).toBe('');
      expect(r.stderr).toMatch(/^Error: /);
      for (const leaked of ['SECRET', 'Row 1', noteBlob, '�', 'ÿ', 'þ']) expect(r.stderr).not.toContain(leaked);
    };

    // The note of x is listed but its blob is gone.
    const notesTip = g(['rev-parse', 'refs/notes/origin']);
    fs.rmSync(path.join(repo, '.git', 'objects', noteBlob.slice(0, 2), noteBlob.slice(2)));
    check(['export', '--format=line-claims', x]);

    // The notes ref itself is not a notes tree.
    const blob = execFileSync('git', ['hash-object', '-w', '--stdin'], { cwd: repo, input: 'x', encoding: 'utf-8' }).trim();
    g(['update-ref', 'refs/notes/origin', blob]);
    check(['export', '--format=line-claims', x]);
    g(['update-ref', 'refs/notes/origin', notesTip]);

    // A changed path whose name is not UTF-8.
    const bad = commitTree([{ name: INVALID_NAME, content: 'bad\n' }]);
    check(['export', '--format=line-claims', bad]);
  });

  it('the range export is unchanged', () => {
    const base = commit('base');
    write('a.ts', 'a\n');
    const a = commit('a');
    note(a, record(a, [contribution('sess-a')]));
    const r = runCli(['export', '--format=json', `${base}..HEAD`]);
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout).toBe(JSON.stringify(exportAttributionRecords(repo, `${base}..HEAD`).records, null, 2) + '\n');
  });

  it('is read-only and offline: no request, no fetch, notes and refs unchanged', async () => {
    write('a.ts', rows(1, 3));
    const x = commit('agent');
    claimLines(x, 'a.ts', [{ start_line: 1, end_line: 2 }]);
    const remote = path.join(tmp, 'remote.git');
    g(['clone', '-q', '--bare', repo, remote], tmp);
    g(['remote', 'add', 'origin', remote]);
    const refsBefore = g(['for-each-ref', '--format=%(refname) %(objectname)']);
    const notesBefore = g(['notes', '--ref=origin', 'list']);

    const hits: string[] = [];
    const server = http.createServer((req, res) => { hits.push(req.url || ''); res.writeHead(200, { 'content-type': 'application/json' }); res.end('{"version":"99.0.0"}'); });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const port = (server.address() as any).port;
    fs.rmSync(path.join(home, '.origin', 'last-update-check.json'));
    fs.writeFileSync(path.join(home, '.origin', 'config.json'), JSON.stringify({ apiUrl: `http://127.0.0.1:${port}` }));
    const runAsync = (args: string[]) => new Promise<number | null>((resolve) => {
      const child = spawn(process.execPath, [distPath, ...args], { cwd: repo, env, stdio: 'ignore' });
      child.on('close', resolve);
    });
    try {
      expect(await runAsync(['export', '--format=line-claims', x])).toBe(0);
      expect(await runAsync(['export', '--format=line-claims', 'HEAD'])).not.toBe(0);
      expect(hits).toEqual([]);
      // Control: the probe does see the version check of a command that makes it.
      await runAsync(['export', '--format=csv']);
      expect(hits.length).toBeGreaterThan(0);
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
    expect(g(['for-each-ref', '--format=%(refname) %(objectname)'])).toBe(refsBefore);
    expect(g(['notes', '--ref=origin', 'list'])).toBe(notesBefore);
    expect(fs.existsSync(path.join(repo, '.git', 'FETCH_HEAD'))).toBe(false);
  });
});
