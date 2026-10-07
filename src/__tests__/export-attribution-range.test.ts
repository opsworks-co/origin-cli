// OR-12/A6: `origin export --format=json <range>` is the attribution read
// boundary. It emits canonical v1 records only — each one read through
// readRecord() and bound to the commit its note is attached to — oldest first.
// A record a consumer must not see is skipped with a warning, or fails the
// whole export under --strict; a Git failure is always fatal. The first
// half pins the reader; the second runs real git and the built CLI.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync, spawn, spawnSync } from 'child_process';
import fs from 'fs';
import http from 'http';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';
import {
  AttributionExportError, ATTRIBUTION_NOTES_REF, exportAttributionRecords, recordFromNote, validateExportRange,
} from '../attribution-export.js';
import { validateFull } from '../attribution-record.js';
import { rebuildRewrittenNote } from '../history-rewrite.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const distPath = path.resolve(here, '../../dist/index.js');

const sha = (n: number) => n.toString(16).padStart(2, '0').repeat(20);
const X = sha(0xa1);
const Y = sha(0xb2);

function record(revision: string, sessionId = 'sess-a', agent = 'claude-code') {
  const r = {
    schema_version: '1.0',
    revision: { vcs: 'git', id: revision },
    attribution_level: 'commit',
    recorded_at: '2026-09-29T10:00:00Z',
    producer: { name: 'origin-cli', version: '0.20260929.1109' },
    contributions: [{ evidence: 'session_capture', agent: { id: agent }, model: { id: 'claude-opus-4-6' }, session: { id: sessionId } }],
  };
  expect(validateFull(r).ok, JSON.stringify(validateFull(r))).toBe(true);
  return r;
}

/** A legacy session payload with the fields that must never leave the note. */
function legacy(sessionId: string) {
  return {
    origin: {
      version: 1, sessionId, agent: 'claude-code', model: 'claude-opus-4-6',
      promptSummary: `SECRET-SUMMARY-${sessionId}`, prompts: [{ index: 0, text: 'SECRET-PROMPT', editsJson: '{"x":1}' }],
    },
  };
}

function newer(revision: string) {
  const r: any = record(revision);
  r.schema_version = '1.4';
  r.future_top = { anything: true };
  r.contributions[0].future_detail = 'x';
  r.contributions[0].session.future_session = 1;
  return r;
}

function expectError(fn: () => unknown, kind: AttributionExportError['kind'], match?: RegExp): AttributionExportError {
  let caught: unknown;
  try { fn(); } catch (err) { caught = err; }
  expect(caught).toBeInstanceOf(AttributionExportError);
  const e = caught as AttributionExportError;
  expect(e.kind).toBe(kind);
  if (match) expect(e.message).toMatch(match);
  return e;
}

// ─── Reader: one note ─────────────────────────────────────────────────────

describe('recordFromNote', () => {
  const unusable = (text: string, reason: string) => {
    const out = recordFromNote(X, text);
    expect(out.status, text).toBe('unusable');
    expect((out as any).reason, text).toBe(reason);
    return (out as any).message as string;
  };

  it('an exact 1.0 record is returned as a copy, without the envelope', () => {
    const env = { ...legacy('sess-a'), attribution_record: record(X), origin_rewrite: { schema: 'origin-rewrite/1' } };
    const out = recordFromNote(X, JSON.stringify(env));
    expect(out).toEqual({ status: 'record', record: record(X) });
    expect(JSON.stringify(out)).not.toMatch(/SECRET|origin_rewrite|promptSummary|editsJson/);
  });

  it('a note without attribution_record is legacy-only: no record, not unusable', () => {
    expect(recordFromNote(X, JSON.stringify(legacy('sess-a')))).toEqual({ status: 'none' });
    expect(recordFromNote(X, JSON.stringify({ sessionId: 'backfill-abc', agent: 'x' }))).toEqual({ status: 'none' });
  });

  it('a newer 1.x record comes out as its 1.0 projection; unknown fields do not leak', () => {
    const out: any = recordFromNote(X, JSON.stringify({ attribution_record: newer(X) }));
    expect(out).toEqual({ status: 'record', record: record(X) });
    expect(JSON.stringify(out)).not.toMatch(/future_/);
  });

  it('an unknown major is unsupported and names the version', () => {
    const r: any = { ...record(X), schema_version: '2.0', v2_only: true };
    expect(unusable(JSON.stringify({ attribution_record: r }), 'unsupported')).toBe('unsupported schema_version 2.0');
  });

  it('an invalid 1.0 record is invalid: schema, semantic rule, missing or null version', () => {
    const schemaBad = { ...record(X), attribution_level: 'hunk' };
    const r2: any = record(X);
    r2.contributions.push({ ...r2.contributions[0] }); // S2: one contribution per session
    expect(validateFull(r2).semanticErrors.map((e) => e.rule)).toContain('S2');
    const noVersion: any = record(X);
    delete noVersion.schema_version;
    for (const bad of [schemaBad, r2, noVersion, null, 'text', []]) {
      unusable(JSON.stringify({ attribution_record: bad }), 'invalid');
    }
  });

  it('a malformed or non-object envelope is unusable', () => {
    for (const text of ['{not json', '', 'plain text note']) unusable(text, 'not-json');
    for (const text of ['[]', '"a string"', 'null', '42', JSON.stringify([{ attribution_record: record(X) }])]) unusable(text, 'not-object');
  });

  it('a valid record naming another commit is a revision mismatch', () => {
    unusable(JSON.stringify({ attribution_record: record(Y) }), 'revision-mismatch');
    const hg = { ...record(X), revision: { vcs: 'hg', id: X } };
    expect(validateFull(hg).ok).toBe(true);
    unusable(JSON.stringify({ attribution_record: hg }), 'revision-mismatch');
  });

  it('the message never quotes the note', () => {
    const secret = 'SENTINEL-SECRET-https://user:token@host/x';
    const msgs = [
      unusable(secret, 'not-json'),
      unusable(JSON.stringify(secret), 'not-object'),
      unusable(JSON.stringify({ attribution_record: { ...record(X), attribution_level: secret } }), 'invalid'),
      unusable(JSON.stringify({ attribution_record: { ...record(X), schema_version: secret } }), 'invalid'),
      unusable(JSON.stringify({ ...legacy(secret), attribution_record: record(Y, 'SENTINEL-SECRET-session') }), 'revision-mismatch'),
    ];
    for (const m of msgs) expect(m).not.toMatch(/SENTINEL|token/);
  });
});

describe('validateExportRange', () => {
  it('accepts plain revisions and two-dot / three-dot ranges', () => {
    for (const r of ['HEAD', 'HEAD~3..HEAD', 'main...feature/x', 'v1.2.0..v1.3.0', `${X}..${Y}`, 'HEAD^..HEAD', 'main..']) {
      expect(validateExportRange(r)).toBe(r);
    }
  });

  it('rejects option-like, empty, control-character and multi-range input', () => {
    for (const r of ['', '-x', '--all', '--output=/tmp/x', 'HEAD..-x', 'HEAD...--all', 'a\nb', 'a\0b', 'a b', 'HEAD@{1}', 'a..b..c', 'a....b', '$(id)']) {
      expectError(() => validateExportRange(r), 'usage');
    }
  });
});

// ─── Real git ─────────────────────────────────────────────────────────────

let tmp: string;
let home: string;
let repo: string;
let gitEnv: NodeJS.ProcessEnv;

function g(args: string[], cwd = repo): string {
  return execFileSync('git', args, { cwd, env: gitEnv, encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

let counter = 0;
function commit(message = `c${++counter}`): string {
  fs.writeFileSync(path.join(repo, `f${counter}.txt`), `${message}\n`);
  g(['add', '-A']);
  g(['commit', '-q', '-m', message]);
  return g(['rev-parse', 'HEAD']);
}

function addNote(target: string, payload: unknown): void {
  const text = typeof payload === 'string' ? payload : JSON.stringify(payload);
  g(['notes', `--ref=${ATTRIBUTION_NOTES_REF}`, 'add', '-f', '-m', text, target]);
}

function notesTip(): string {
  return g(['rev-parse', ATTRIBUTION_NOTES_REF]);
}

function runCli(args: string[], cwd = repo) {
  const r = spawnSync(process.execPath, [distPath, ...args], { cwd, env: gitEnv, encoding: 'utf-8' });
  return { stdout: r.stdout, stderr: r.stderr, status: r.status };
}

beforeEach(() => {
  tmp = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'origin-export-range-')));
  home = path.join(tmp, 'home');
  repo = path.join(tmp, 'repo');
  fs.mkdirSync(path.join(home, '.origin'), { recursive: true });
  // A fresh, current update-check cache: the no-range commands never go to the network here.
  fs.writeFileSync(path.join(home, '.origin', 'last-update-check.json'), JSON.stringify({ latest: '0.0.1', checkedAt: new Date().toISOString() }));
  fs.writeFileSync(path.join(home, '.gitconfig'), '');
  gitEnv = {
    ...process.env,
    HOME: home, USERPROFILE: home, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: path.join(home, '.gitconfig'),
    GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@example.com', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@example.com',
    LC_ALL: 'C',
  };
  for (const k of ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'GIT_NOTES_REF']) delete gitEnv[k];
  fs.mkdirSync(repo);
  g(['init', '-q', '-b', 'main']);
  counter = 0;
});

afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

const ids = (range: string) => exportAttributionRecords(repo, range).records.map((r: any) => r.revision.id);

/** Every unusable note shape of the reader, with its reason code. */
const UNUSABLE: Array<[string, (self: string, other: string) => unknown, string]> = [
  ['plain text', () => 'plain text note SENTINEL-SECRET https://user:token@host/x', 'not-json'],
  ['a v2 record', (self) => ({ attribution_record: { ...record(self), schema_version: '2.0', v2: 'SENTINEL-SECRET' } }), 'unsupported'],
  ['an invalid 1.0 record', (self) => ({ attribution_record: { ...record(self), attribution_level: 'SENTINEL-SECRET' } }), 'invalid'],
  ['a non-object envelope', () => ['SENTINEL-SECRET'], 'not-object'],
  ['a record of another commit', (_self, other) => ({ ...legacy('sess-x'), attribution_record: record(other, 'SENTINEL-SECRET') }), 'revision-mismatch'],
];

describe('exportAttributionRecords over a real repository', () => {
  it('two attributed commits come out oldest first, each bound to its own full sha', () => {
    const base = commit();
    const a = commit();
    const b = commit();
    addNote(a, { ...legacy('sess-a'), attribution_record: record(a, 'sess-a') });
    addNote(b, { ...legacy('sess-b'), attribution_record: record(b, 'sess-b', 'codex') });
    const out = exportAttributionRecords(repo, `${base}..HEAD`);
    expect(out.skipped).toEqual([]);
    expect(out.records.map((r: any) => r.revision.id)).toEqual([a, b]);
    expect(out.records.map((r: any) => r.contributions[0].session.id)).toEqual(['sess-a', 'sess-b']);
    expect(JSON.stringify(out)).not.toMatch(/SECRET|"origin"|promptSummary/);
  });

  it('a commit without a note and a legacy-only note are left out, and neither is skipped', () => {
    const base = commit();
    const human = commit();
    const legacyOnly = commit();
    const attributed = commit();
    addNote(legacyOnly, legacy('sess-l'));
    addNote(attributed, { attribution_record: record(attributed) });
    const out = exportAttributionRecords(repo, `${base}..HEAD`);
    expect(out.records.map((r: any) => r.revision.id)).toEqual([attributed]);
    expect(out.skipped).toEqual([]);
    expect(ids(`${base}..HEAD`)).not.toContain(human);
  });

  it('an empty range, and a range with no records, give nothing', () => {
    const a = commit();
    const none = { records: [], skipped: [] };
    expect(exportAttributionRecords(repo, 'HEAD..HEAD')).toEqual(none);
    expect(exportAttributionRecords(repo, a)).toEqual(none);
    addNote(a, legacy('sess-l'));
    expect(exportAttributionRecords(repo, 'HEAD')).toEqual(none);
  });

  it('a newer 1.x note is exported as its projection and the note is not rewritten', () => {
    const a = commit();
    addNote(a, { attribution_record: newer(a) });
    const before = g(['notes', `--ref=${ATTRIBUTION_NOTES_REF}`, 'show', a]);
    const tip = notesTip();
    expect(exportAttributionRecords(repo, 'HEAD')).toEqual({ records: [record(a)], skipped: [] });
    expect(g(['notes', `--ref=${ATTRIBUTION_NOTES_REF}`, 'show', a])).toBe(before);
    expect(notesTip()).toBe(tip);
  });

  for (const [label, payload, reason] of UNUSABLE) {
    it(`${label} between two valid records is skipped; its neighbours are exported`, () => {
      const base = commit();
      const a = commit();
      const b = commit();
      const c = commit();
      addNote(a, { attribution_record: record(a) });
      addNote(b, payload(b, a));
      addNote(c, { attribution_record: record(c) });
      const out = exportAttributionRecords(repo, `${base}..HEAD`);
      expect(out.records.map((r: any) => r.revision.id)).toEqual([a, c]);
      expect(out.skipped.map((s) => [s.sha, s.reason])).toEqual([[b, reason]]);
      expect(JSON.stringify(out)).not.toMatch(/SENTINEL|token/);
    });
  }

  it('several unusable notes: one skip each, oldest first, every commit at most once', () => {
    const base = commit();
    const shas = UNUSABLE.map(() => commit());
    const good = commit();
    UNUSABLE.forEach(([, payload], i) => addNote(shas[i], payload(shas[i], good)));
    addNote(good, { attribution_record: record(good) });
    for (let i = 0; i < 2; i++) {
      const out = exportAttributionRecords(repo, `${base}..HEAD`);
      expect(out.skipped.map((s) => [s.sha, s.reason])).toEqual(UNUSABLE.map(([, , reason], j) => [shas[j], reason]));
      expect(out.records.map((r: any) => r.revision.id)).toEqual([good]);
    }
  });

  it('an unresolvable range is an error, never a fallback to HEAD or []', () => {
    const a = commit();
    addNote(a, { attribution_record: record(a) });
    for (const r of ['nope', 'nope..HEAD', 'HEAD..nope', `${'0'.repeat(40)}..HEAD`]) {
      expectError(() => exportAttributionRecords(repo, r), 'git');
    }
    expectError(() => exportAttributionRecords(repo, '--all'), 'usage');
  });

  it('Git failures stay fatal, never a skip: not a repository, a broken notes ref, an unreadable note', () => {
    const outside = path.join(tmp, 'not-a-repo');
    fs.mkdirSync(outside);
    expectError(() => exportAttributionRecords(outside, 'HEAD'), 'git');

    const a = commit();
    addNote(a, 'plain text');
    const blob = g(['notes', `--ref=${ATTRIBUTION_NOTES_REF}`, 'list', a]);
    fs.rmSync(path.join(repo, '.git', 'objects', blob.slice(0, 2), blob.slice(2)));
    expectError(() => exportAttributionRecords(repo, 'HEAD'), 'git', /could not read the note/);

    const notATree = execFileSync('git', ['hash-object', '-w', '--stdin'], { cwd: repo, env: gitEnv, input: 'x', encoding: 'utf-8' }).trim();
    g(['update-ref', ATTRIBUTION_NOTES_REF, notATree]);
    expectError(() => exportAttributionRecords(repo, 'HEAD'), 'git', /could not list/);
  });

  it('a branchy range with a merge is topological, oldest first, without duplicates, and stable', () => {
    const root = commit();
    g(['checkout', '-q', '-b', 'feature']);
    const f1 = commit();
    const f2 = commit();
    g(['checkout', '-q', 'main']);
    const m1 = commit();
    g(['merge', '-q', '--no-ff', '-m', 'merge', 'feature']);
    const merge = g(['rev-parse', 'HEAD']);
    for (const c of [f1, f2, m1, merge]) addNote(c, { attribution_record: record(c) });

    const order = ids(`${root}..main`);
    expect(new Set(order)).toEqual(new Set([f1, f2, m1, merge]));
    expect(order).toHaveLength(4);
    expect(order.indexOf(f1)).toBeLessThan(order.indexOf(f2));
    expect(order[order.length - 1]).toBe(merge);
    for (let i = 0; i < 3; i++) expect(ids(`${root}..main`)).toEqual(order);
    expect(order).toEqual(g(['rev-list', '--topo-order', '--reverse', `${root}..main`]).split('\n'));
    // A commit off the current branch is still found when the range names it.
    g(['checkout', '-q', 'feature']);
    expect(ids(`${root}..main`)).toEqual(order);
  });

  it('an A5 rewrite note exports as an ordinary record for the new commit (origin_rewrite stays inside)', () => {
    const base = commit();
    const old = commit('old');
    addNote(old, { ...legacy('sess-r'), attribution_record: record(old, 'sess-r') });
    g(['reset', '-q', '--hard', base]);
    const rewritten = commit('rewritten');
    const rebuilt = rebuildRewrittenNote({
      targetSha: rewritten, sources: [{ sha: old, note: g(['notes', `--ref=${ATTRIBUTION_NOTES_REF}`, 'show', old]) }],
      recordedAt: new Date('2026-09-29T12:00:00Z'), producerVersion: '9.9.9',
    });
    expect(rebuilt.payload).toBeTruthy();
    expect(JSON.parse(rebuilt.payload!).origin_rewrite).toBeTruthy();
    addNote(rewritten, rebuilt.payload!);

    const out = exportAttributionRecords(repo, `${base}..HEAD`);
    expect(out).toEqual({ records: [rebuilt.record], skipped: [] });
    expect((out.records[0] as any).revision.id).toBe(rewritten);
    expect((out.records[0] as any).attribution_level).toBe('commit');
    expect(JSON.stringify(out)).not.toMatch(/origin_rewrite|SECRET/);
  });
});

// ─── Built CLI ────────────────────────────────────────────────────────────

describe('origin export <range> (built CLI)', () => {
  if (!fs.existsSync(distPath)) {
    it.skip('requires a built CLI (pnpm run build)', () => { /* skipped */ });
    return;
  }

  function seed() {
    const base = commit();
    const a = commit();
    const b = commit();
    addNote(a, { ...legacy('sess-a'), attribution_record: record(a, 'sess-a') });
    addNote(b, { attribution_record: newer(b) });
    return { base, a, b, expected: JSON.stringify([record(a, 'sess-a'), record(b)], null, 2) + '\n' };
  }

  /** A valid, an unusable and a valid commit: the reviewer's fixture. */
  function seedWithUnusable(payload: (self: string, other: string) => unknown) {
    const base = commit();
    const a = commit();
    const b = commit();
    const c = commit();
    addNote(a, { attribution_record: record(a) });
    addNote(b, payload(b, a));
    addNote(c, { attribution_record: record(c) });
    return { base, a, b, c, expected: JSON.stringify([record(a), record(c)], null, 2) + '\n' };
  }

  it('--format=json and --format json print the same document; stdout is only JSON', () => {
    const { base, expected } = seed();
    const eq = runCli(['export', '--format=json', `${base}..HEAD`]);
    const sp = runCli(['export', '--format', 'json', `${base}..HEAD`]);
    const before = runCli(['export', `${base}..HEAD`, '--format=json']);
    const strict = runCli(['export', '--format=json', '--strict', `${base}..HEAD`]);
    for (const r of [eq, sp, before, strict]) {
      expect(r.status, r.stderr).toBe(0);
      expect(r.stdout).toBe(expected);
      expect(r.stderr).toBe('');
    }
    expect(JSON.parse(eq.stdout)).toHaveLength(2);
  });

  it('an empty range prints [] and exits 0', () => {
    commit();
    const r = runCli(['export', '--format=json', 'HEAD..HEAD']);
    expect(r.status).toBe(0);
    expect(r.stdout).toBe('[]\n');
  });

  for (const [label, payload, reason] of UNUSABLE) {
    it(`${label}: the default exports the valid subset with one warning; --strict fails the export`, () => {
      const { base, b, expected } = seedWithUnusable(payload);
      const lenient = runCli(['export', '--format=json', `${base}..HEAD`]);
      expect(lenient.status, lenient.stderr).toBe(0);
      expect(lenient.stdout).toBe(expected);
      const warnings = lenient.stderr.split('\n').filter(Boolean);
      expect(warnings).toHaveLength(1);
      expect(warnings[0]).toMatch(new RegExp(`^Warning: skipped attribution for ${b}: `));
      expect(lenient.stderr).not.toMatch(/SENTINEL|token|sess-x/);
      if (reason === 'unsupported') expect(warnings[0]).toBe(`Warning: skipped attribution for ${b}: unsupported schema_version 2.0`);
      if (reason === 'not-json') expect(warnings[0]).toBe(`Warning: skipped attribution for ${b}: the note is not JSON`);

      const strict = runCli(['export', '--format=json', '--strict', `${base}..HEAD`]);
      expect(strict.status).toBe(1);
      expect(strict.stdout).toBe('');
      expect(strict.stderr).toContain(`Error: unusable attribution for ${b}: `);
      expect(strict.stderr).toMatch(/--strict: 1 unusable attribution record; nothing was exported/);
      expect(strict.stderr).not.toMatch(/SENTINEL|token|sess-x|Warning/);
    });
  }

  it('a legacy-only note gives no warning, with or without --strict', () => {
    const base = commit();
    const a = commit();
    const l = commit();
    addNote(a, { attribution_record: record(a) });
    addNote(l, legacy('sess-l'));
    for (const extra of [[], ['--strict']]) {
      const r = runCli(['export', '--format=json', ...extra, `${base}..HEAD`]);
      expect(r.status, r.stderr).toBe(0);
      expect(r.stderr).toBe('');
      expect(JSON.parse(r.stdout).map((x: any) => x.revision.id)).toEqual([a]);
    }
  });

  it('several unusable notes: one warning per commit, oldest first', () => {
    const base = commit();
    const shas = UNUSABLE.map(() => commit());
    const good = commit();
    UNUSABLE.forEach(([, payload], i) => addNote(shas[i], payload(shas[i], good)));
    addNote(good, { attribution_record: record(good) });
    const r = runCli(['export', '--format=json', `${base}..HEAD`]);
    expect(r.status).toBe(0);
    expect(JSON.parse(r.stdout).map((x: any) => x.revision.id)).toEqual([good]);
    const warned = r.stderr.split('\n').filter(Boolean).map((l) => /^Warning: skipped attribution for ([0-9a-f]{40}): /.exec(l)?.[1]);
    expect(warned).toEqual(shas);
    const strict = runCli(['export', '--format=json', '--strict', `${base}..HEAD`]);
    expect(strict.status).toBe(1);
    expect(strict.stdout).toBe('');
    expect(strict.stderr).toMatch(/--strict: 5 unusable attribution records/);
  });

  it('errors exit non-zero, print nothing on stdout and explain on stderr', () => {
    const { base } = seed();
    const cases: string[][] = [
      ['export', '--format=json', 'nope..HEAD'],
      ['export', '--format=json', '--', '--all'],
      ['export', '--format=json', '--', 'HEAD..-x'],
      ['export', '--format=csv', `${base}..HEAD`],
      ['export', '--format=agent-trace', `${base}..HEAD`],
      ['export', '--format=xml', `${base}..HEAD`],
      ['export', '--format=json', '--limit', '1', `${base}..HEAD`],
      ['export', '--format=json', '--model', 'x', `${base}..HEAD`],
      ['export', '--format=json', '--session', 's', `${base}..HEAD`],
      ['export', '--format=csv', '--strict', `${base}..HEAD`],
      ['export', '--format=agent-trace', '--strict', `${base}..HEAD`],
      ['export', '--strict'],
      ['export', '--format=json', '--strict'],
      ['export', '--format=csv', '--strict'],
      ['export', '--format=agent-trace', '--strict'],
    ];
    for (const args of cases) {
      const r = runCli(args);
      expect(r.status, args.join(' ')).toBe(1);
      expect(r.stdout, args.join(' ')).toBe('');
      expect(r.stderr, args.join(' ')).toMatch(/Error/);
    }
    expect(runCli(['export', '--strict']).stderr).toMatch(/--strict applies only to a commit range/);
  });

  it('a Git failure stays fatal by default: no warning, no JSON', () => {
    const { base, b } = seed();
    const blob = g(['notes', `--ref=${ATTRIBUTION_NOTES_REF}`, 'list', b]);
    fs.rmSync(path.join(repo, '.git', 'objects', blob.slice(0, 2), blob.slice(2)));
    const r = runCli(['export', '--format=json', `${base}..HEAD`]);
    expect(r.status).toBe(1);
    expect(r.stdout).toBe('');
    expect(r.stderr).toMatch(/Error: git could not read the note/);
    expect(r.stderr).not.toMatch(/Warning/);
  });

  it('--output: the valid subset is written atomically by default; --strict and fatal errors leave targets alone', () => {
    const { base, expected } = seed();
    const out = path.join(tmp, 'records.json');
    const ok = runCli(['export', '--format=json', '--output', out, `${base}..HEAD`]);
    expect(ok.status, ok.stderr).toBe(0);
    expect(ok.stdout).toBe('');
    expect(ok.stderr).toMatch(/Exported 2 attribution records/);
    expect(fs.readFileSync(out, 'utf-8')).toBe(expected);

    // A plain-text note on a new commit: the default writes the subset, --strict writes nothing.
    const bad = commit();
    addNote(bad, 'plain text note SENTINEL-SECRET');
    const subset = path.join(tmp, 'subset.json');
    const lenient = runCli(['export', '--format=json', '--output', subset, `${base}..HEAD`]);
    expect(lenient.status, lenient.stderr).toBe(0);
    expect(lenient.stdout).toBe('');
    expect(lenient.stderr).toContain(`Warning: skipped attribution for ${bad}: the note is not JSON`);
    expect(lenient.stderr).toMatch(/Exported 2 attribution records/);
    expect(fs.readFileSync(subset, 'utf-8')).toBe(expected);

    const fresh = path.join(tmp, 'fresh.json');
    const r1 = runCli(['export', '--format=json', '--strict', '--output', fresh, `${base}..HEAD`]);
    expect(r1.status).toBe(1);
    expect(fs.existsSync(fresh)).toBe(false);
    fs.writeFileSync(out, 'previous contents\n');
    const r2 = runCli(['export', '--format=json', '--strict', '--output', out, `${base}..HEAD`]);
    expect(r2.status).toBe(1);
    expect(fs.readFileSync(out, 'utf-8')).toBe('previous contents\n');
    const r3 = runCli(['export', '--format=json', '--output', out, 'nope..HEAD']);
    expect(r3.status).toBe(1);
    expect(fs.readFileSync(out, 'utf-8')).toBe('previous contents\n');
    expect(fs.readdirSync(tmp).filter((f) => f.endsWith('.tmp'))).toEqual([]);
  });

  it('is read-only and offline: no request, no fetch, notes and refs unchanged', async () => {
    const { base } = seed();
    // A remote whose notes would land in staging refs if anything fetched.
    const remote = path.join(tmp, 'remote.git');
    g(['clone', '-q', '--bare', repo, remote], tmp);
    g(['remote', 'add', 'origin', remote]);
    const refsBefore = g(['for-each-ref', '--format=%(refname) %(objectname)']);
    const noteBefore = g(['notes', `--ref=${ATTRIBUTION_NOTES_REF}`, 'list']);

    // Any request to the configured API (version check included) is recorded.
    const hits: string[] = [];
    const server = http.createServer((req, res) => { hits.push(req.url || ''); res.writeHead(200, { 'content-type': 'application/json' }); res.end('{"version":"99.0.0"}'); });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const port = (server.address() as any).port;
    fs.rmSync(path.join(home, '.origin', 'last-update-check.json'));
    fs.writeFileSync(path.join(home, '.origin', 'config.json'), JSON.stringify({ apiUrl: `http://127.0.0.1:${port}` }));
    const runAsync = (args: string[]) => new Promise<number | null>((resolve) => {
      const child = spawn(process.execPath, [distPath, ...args], { cwd: repo, env: gitEnv, stdio: 'ignore' });
      child.on('close', resolve);
    });
    try {
      expect(await runAsync(['export', '--format=json', `${base}..HEAD`])).toBe(0);
      expect(await runAsync(['export', '--format=json', 'nope..HEAD'])).not.toBe(0);
      expect(hits).toEqual([]);
      // Control: the probe sees the version check of a command that does make it.
      await runAsync(['export', '--format=csv']);
      expect(hits.length).toBeGreaterThan(0);
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }

    expect(g(['for-each-ref', '--format=%(refname) %(objectname)'])).toBe(refsBefore);
    expect(g(['notes', `--ref=${ATTRIBUTION_NOTES_REF}`, 'list'])).toBe(noteBefore);
    expect(fs.existsSync(path.join(repo, '.git', 'FETCH_HEAD'))).toBe(false);
  });

  describe('without a range, the session export is unchanged', () => {
    /** An origin-sessions branch with one session, written with plumbing. */
    function seedSessions(): void {
      const meta = {
        sessionId: 'sess-1', model: 'claude-opus-4-6', startedAt: '2026-09-01T00:00:00.000Z', endedAt: '2026-09-01T01:00:00.000Z',
        status: 'ended', durationMs: 3_600_000, cost: { usd: 1.5 }, tokens: { total: 1000 }, lines: { added: 10, removed: 2 },
        filesChanged: ['a.ts', 'b.ts'], git: { branch: 'main' },
      };
      const blob = execFileSync('git', ['hash-object', '-w', '--stdin'], { cwd: repo, env: gitEnv, input: JSON.stringify(meta), encoding: 'utf-8' }).trim();
      const index = path.join(tmp, 'sessions.index');
      const env = { ...gitEnv, GIT_INDEX_FILE: index };
      execFileSync('git', ['update-index', '--add', '--cacheinfo', `100644,${blob},sessions/sess-1/metadata.json`], { cwd: repo, env });
      const tree = execFileSync('git', ['write-tree'], { cwd: repo, env, encoding: 'utf-8' }).trim();
      const c = g(['commit-tree', tree, '-m', 'sessions']);
      g(['update-ref', 'refs/heads/origin-sessions', c]);
    }

    it('JSON, CSV and Agent Trace keep their shapes', () => {
      commit();
      seedSessions();
      const json = runCli(['export']);
      expect(json.status, json.stderr).toBe(0);
      expect(JSON.parse(json.stdout)).toEqual([{
        sessionId: 'sess-1', model: 'claude-opus-4-6', startedAt: '2026-09-01T00:00:00.000Z', endedAt: '2026-09-01T01:00:00.000Z',
        status: 'ended', durationMs: 3_600_000, costUsd: 1.5, tokensUsed: 1000, linesAdded: 10, linesRemoved: 2,
        filesCount: 2, filesChanged: ['a.ts', 'b.ts'], branch: 'main',
      }]);
      expect(runCli(['export', '--format=json']).stdout).toBe(json.stdout);

      const csv = runCli(['export', '--format', 'csv']);
      expect(csv.status).toBe(0);
      expect(csv.stdout).toBe(
        'sessionId,model,startedAt,endedAt,status,durationMs,costUsd,tokensUsed,linesAdded,linesRemoved,filesCount,branch\n'
        + 'sess-1,claude-opus-4-6,2026-09-01T00:00:00.000Z,2026-09-01T01:00:00.000Z,ended,3600000,1.5000,1000,10,2,2,main\n',
      );
      expect(runCli(['export', '--model', 'nomatch']).stdout).toBe('[]\n');

      const trace = runCli(['export', '--format', 'agent-trace']);
      expect(trace.status).toBe(0);
      const t = JSON.parse(trace.stdout);
      expect(t.version).toBe('0.1.0');
      expect(Array.isArray(t.files)).toBe(true);
    });

    it('no sessions: a notice on stderr and nothing on stdout, as before', () => {
      commit();
      const r = runCli(['export']);
      expect(r.status).toBe(0);
      expect(r.stdout).toBe('');
      expect(r.stderr).toMatch(/No sessions found/);
    });
  });
});
