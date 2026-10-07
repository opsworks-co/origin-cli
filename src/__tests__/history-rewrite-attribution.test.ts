// OR-11/A5: attribution after a history rewrite.
//
// Every rewrite result is a COMMIT-level v1 record that names the NEW commit,
// passes the full validation path and carries only what the old notes proved;
// the old notes stay as they were; an existing target note is never replaced;
// N→1 is one merge, not "the last source wins". The first half pins the pure
// rebuild; the second runs real git through the hooks Origin installs (global
// core.hooksPath and repo-local) with the built CLI.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync, spawnSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';
import { mergeSessionNoteOverRewrite, rebuildRewrittenNote, REWRITE_NOTE_KEY, REWRITE_NOTE_SCHEMA } from '../history-rewrite.js';
import { readRecord, validateFull } from '../attribution-record.js';
import { installRewriteHooks } from '../history-preservation.js';
import {
  installGitPostCommitHook, installGitPrepareCommitMsgHook,
  writeGlobalPostCommitHook, writeGlobalPostRewriteHook, writeGlobalPrepareCommitMsgHook,
} from '../commands/enable.js';

const NOW = new Date('2026-09-28T12:00:00.000Z');
const OPTS = { recordedAt: NOW, producerVersion: '9.9.9' };
const sha = (n: number) => n.toString(16).padStart(2, '0').repeat(20);
const A = sha(0xa1);
const B = sha(0xb2);
const C = sha(0xc3);
const T = sha(0xee);
const REF = (id: string) => `https://origin.example.com/sessions/${id}`;
const HASH = `sha256:${'ab'.repeat(32)}`;

/** A legacy session note with every prompt carrier populated. */
function legacy(sessionId: string, agent?: string, model = 'claude-opus-4-6', extra: Record<string, unknown> = {}) {
  return {
    origin: {
      version: 1, sessionId, model, agent, promptCount: 3,
      promptSummary: `SECRET-SUMMARY-${sessionId}`, fullPrompt: `SECRET-FULL-${sessionId}`,
      prompts: [{ index: 0, text: `SECRET-TEXT-${sessionId}`, editsJson: '{"promptText":"SECRET-EDITS"}' }],
      markers: { intent: ['SECRET-MARKER'] },
      tokensUsed: 1234, costUsd: 0.42, durationMs: 60_000, linesAdded: 10, linesRemoved: 2,
      originUrl: REF(sessionId), timestamp: '2026-09-01T00:00:00.000Z', ...extra,
    },
  };
}

/** A full session contribution: line claims, iterations, usage, session diff stats. */
function lineContribution(sessionId: string, agent = 'claude-code', model = 'claude-opus-4-6') {
  return {
    evidence: 'session_capture',
    agent: { id: agent, version: '2.1.0' },
    model: { id: model },
    actor: { id: 'user_01' },
    session: {
      id: sessionId, reference_uri: REF(sessionId), started_at: '2026-09-01T00:00:00Z', duration_ms: 1000, prompt_count: 3,
      iterations: [{ index: 1, prompt_hash: HASH, reference_uri: `${REF(sessionId)}?prompt=1` }],
      usage: { tokens: { input: 5, output: 7 }, cost: { amount: '0.5', currency: 'USD', basis: 'estimated' } },
      diff_stats: { lines_added: 40, lines_removed: 4 },
    },
    files: [{ path: 'src/a.ts', ranges: [{ start_line: 1, end_line: 3, iteration_index: 1 }] }],
  };
}

function commitContribution(sessionId: string, agent = 'codex', model?: string) {
  const c: Record<string, any> = { evidence: 'session_capture', agent: { id: agent }, session: { id: sessionId, reference_uri: REF(sessionId) } };
  if (model) c.model = { id: model };
  return c;
}

function record(revision: string, contributions: any[], level?: 'commit' | 'line') {
  const r = {
    schema_version: '1.0',
    revision: { vcs: 'git', id: revision, diff_stats: { lines_added: 3, lines_removed: 0 } },
    attribution_level: level ?? (contributions.some((c) => c.files) ? 'line' : 'commit'),
    recorded_at: '2026-09-01T00:00:00Z',
    producer: { name: 'origin-cli', version: '0.1.0' },
    contributions,
  };
  expect(validateFull(r).ok, JSON.stringify(validateFull(r))).toBe(true);
  return r;
}

const note = (obj: unknown) => JSON.stringify(obj, null, 2);
const parse = (payload: string | null) => JSON.parse(payload as string);

function expectCommitLevelFor(rec: any, target: string) {
  expect(readRecord(rec).status).toBe('exact');
  expect(validateFull(rec).ok).toBe(true);
  expect(rec.revision).toEqual({ vcs: 'git', id: target });
  expect(rec.attribution_level).toBe('commit');
  expect(rec.recorded_at).toBe(NOW.toISOString());
  expect(rec.producer).toEqual({ name: 'origin-cli', version: '9.9.9' });
  for (const c of rec.contributions) {
    expect(c).not.toHaveProperty('files');
    expect(c.session ?? {}).not.toHaveProperty('iterations');
    expect(c.session ?? {}).not.toHaveProperty('prompt_count');
    expect(c.session ?? {}).not.toHaveProperty('usage');
    expect(c.session ?? {}).not.toHaveProperty('duration_ms');
    expect(c.session ?? {}).not.toHaveProperty('diff_stats');
  }
  expect(JSON.stringify(rec)).not.toMatch(/SECRET/);
}

// ─── The pure rebuild ───────────────────────────────────────────────────────

describe('rebuildRewrittenNote: one source → one target', () => {
  it('a line-level record becomes a commit-level record for the NEW sha, identity intact', () => {
    const src = { ...legacy('sess-a', 'claude-code'), attribution_record: record(A, [lineContribution('sess-a')]) };
    const out = rebuildRewrittenNote({ targetSha: T, sources: [{ sha: A, note: note(src) }], ...OPTS });
    const rec = out.record!;
    expectCommitLevelFor(rec, T);
    expect(rec.contributions).toEqual([{
      evidence: 'session_capture',
      agent: { id: 'claude-code', version: '2.1.0' },
      model: { id: 'claude-opus-4-6' },
      actor: { id: 'user_01' },
      session: { id: 'sess-a', reference_uri: REF('sess-a'), started_at: '2026-09-01T00:00:00Z' },
    }]);
    expect(rec.revision).not.toHaveProperty('diff_stats');
    // The legacy payload travels unchanged — prompt carriers included, per the current privacy policy.
    expect(parse(out.payload).origin).toEqual(src.origin);
    expect(parse(out.payload)[REWRITE_NOTE_KEY]).toEqual({ schema: REWRITE_NOTE_SCHEMA, target: T, sources: [A], base: 'none' });
    expect(parse(out.payload).origin).not.toHaveProperty('squashMerge');
  });

  it('a mixed line + commit record keeps both identities, both commit-level', () => {
    const src = { ...legacy('sess-a', 'claude-code'), attribution_record: record(A, [lineContribution('sess-a'), commitContribution('sess-b', 'codex', 'gpt-5')]) };
    const rec = rebuildRewrittenNote({ targetSha: T, sources: [{ sha: A, note: note(src) }], ...OPTS }).record!;
    expectCommitLevelFor(rec, T);
    expect(rec.contributions.map((c: any) => [c.session.id, c.agent.id, c.model?.id])).toEqual([
      ['sess-a', 'claude-code', 'claude-opus-4-6'], ['sess-b', 'codex', 'gpt-5'],
    ]);
  });

  it('a newer 1.x source record is read through its documented 1.0 projection', () => {
    const r: any = record(A, [commitContribution('sess-a', 'cursor', 'gpt-5')]);
    r.schema_version = '1.3';
    r.future_field = { anything: true };
    r.contributions[0].future_detail = 'x';
    const rec = rebuildRewrittenNote({ targetSha: T, sources: [{ sha: A, note: note({ attribution_record: r }) }], ...OPTS }).record!;
    expectCommitLevelFor(rec, T);
    expect(rec.contributions[0]).toEqual({ evidence: 'session_capture', agent: { id: 'cursor' }, model: { id: 'gpt-5' }, session: { id: 'sess-a', reference_uri: REF('sess-a') } });
  });

  it('an observed legacy session with an explicit agent gives a minimal record; guessed identity gives none', () => {
    const ok = rebuildRewrittenNote({ targetSha: T, sources: [{ sha: A, note: note(legacy('sess-a', 'gemini', 'gemini-2.5-pro')) }], ...OPTS });
    expectCommitLevelFor(ok.record, T);
    expect(ok.record!.contributions).toEqual([{ evidence: 'session_capture', agent: { id: 'gemini' }, model: { id: 'gemini-2.5-pro' }, session: { id: 'sess-a', reference_uri: REF('sess-a') } }]);

    const cases: Array<[string, any]> = [
      ['pgrep receipt', legacy('detected-codex-muh7xo1j', 'codex')],
      ['unknown session', legacy('unknown', 'codex')],
      ['model without agent', legacy('sess-a', undefined, 'claude-opus-4-6')],
      ['Origin agent name, not a tool', legacy('sess-a', 'cursor-frontend')],
      ['squash aggregate', { origin: { version: 1, squashMerge: true, sessionIds: ['sess-a', 'sess-b'], models: ['m'] } }],
      ['Agent Trace import', { origin: { source: 'agent-trace', sessionId: 'trace-1', agent: 'claude-code' } }],
      ['bare backfill note', { sessionId: 'backfill-12345678', agent: 'claude-code', model: 'unknown' }],
    ];
    for (const [label, n] of cases) {
      const out = rebuildRewrittenNote({ targetSha: T, sources: [{ sha: A, note: note(n) }], ...OPTS });
      expect(out.record, label).toBeUndefined();
      expect(parse(out.payload), label).not.toHaveProperty('attribution_record');
      expect(out.warnings.map((w) => w.code), label).toContain('source-legacy-no-claim');
      // The legacy payload itself still travels 1→1.
      expect(parse(out.payload), label).toMatchObject(JSON.parse(JSON.stringify(n)));
    }
  });

  it('invalid, unsupported and wrong-revision records make no claim — and are not re-read as legacy', () => {
    const bad: any = record(A, [commitContribution('sess-a')]);
    const invalid = { ...legacy('sess-a', 'codex'), attribution_record: { ...bad, attribution_level: 'hunk' } };
    const unsupported = { ...legacy('sess-a', 'codex'), attribution_record: { ...bad, schema_version: '2.0' } };
    const wrongRevision = { ...legacy('sess-a', 'codex'), attribution_record: record(B, [commitContribution('sess-a')]) };
    for (const [code, n] of [['source-record-invalid', invalid], ['source-record-unsupported', unsupported], ['source-record-wrong-revision', wrongRevision]] as const) {
      const out = rebuildRewrittenNote({ targetSha: T, sources: [{ sha: A, note: note(n) }], ...OPTS });
      expect(out.warnings.map((w) => w.code), code).toContain(code);
      expect(out.record, code).toBeUndefined();
      expect(parse(out.payload).origin, code).toEqual(n.origin);
    }
  });

  it('a non-JSON note is copied byte for byte and carries no record', () => {
    const out = rebuildRewrittenNote({ targetSha: T, sources: [{ sha: A, note: 'plain text note' }], ...OPTS });
    expect(out.payload).toBe('plain text note');
    expect(out.warnings.map((w) => w.code)).toContain('source-note-not-json');
  });

  it('never copies the old record, and a target equal to its source is not a rewrite', () => {
    const src = { ...legacy('sess-a', 'claude-code'), attribution_record: record(A, [lineContribution('sess-a')]) };
    const out = rebuildRewrittenNote({ targetSha: T, sources: [{ sha: A, note: note(src) }], ...OPTS });
    expect(JSON.stringify(out.record)).not.toContain(A);
    expect(out.record!.revision.id).toBe(T);
    expect(rebuildRewrittenNote({ targetSha: A, sources: [{ sha: A, note: note(src) }], ...OPTS }).payload).toBeNull();
  });
});

describe('rebuildRewrittenNote: several sources → one target', () => {
  const s1 = { ...legacy('sess-b', 'codex', 'gpt-5'), attribution_record: record(A, [commitContribution('sess-b', 'codex', 'gpt-5')]) };
  const s2 = { ...legacy('sess-a', 'claude-code'), attribution_record: record(B, [lineContribution('sess-a')]) };
  const s3 = legacy('sess-c', 'cursor', 'gpt-5');

  it('keeps every compatible contribution, independent of the order of the pairs', () => {
    const forward = rebuildRewrittenNote({ targetSha: T, sources: [{ sha: A, note: note(s1) }, { sha: B, note: note(s2) }, { sha: C, note: note(s3) }], ...OPTS });
    const backward = rebuildRewrittenNote({ targetSha: T, sources: [{ sha: C, note: note(s3) }, { sha: B, note: note(s2) }, { sha: A, note: note(s1) }], ...OPTS });
    expect(backward.payload).toBe(forward.payload);
    expectCommitLevelFor(forward.record, T);
    expect(forward.record!.contributions.map((c: any) => `${c.session.id}/${c.agent.id}/${c.model?.id}`))
      .toEqual(['sess-a/claude-code/claude-opus-4-6', 'sess-b/codex/gpt-5', 'sess-c/cursor/gpt-5']);
    expect(parse(forward.payload)[REWRITE_NOTE_KEY].sources).toEqual([A, B, C].sort());
  });

  it('the legacy payload of a multi-session squash names no single owner and sums nothing', () => {
    const out = rebuildRewrittenNote({ targetSha: T, sources: [{ sha: A, note: note(s1) }, { sha: B, note: note(s2) }, { sha: C, note: note(s3) }], ...OPTS });
    const origin = parse(out.payload).origin;
    expect(origin).toEqual({
      version: 1, squashMerge: true, commitsSquashed: 3,
      // No sessionId/agent/model: naming one would hand the whole commit to it.
      sessionIds: ['sess-a', 'sess-b', 'sess-c'], models: ['claude-opus-4-6', 'gpt-5'],
      timestamp: NOW.toISOString(),
    });
    expect(JSON.stringify(origin)).not.toMatch(/SECRET|total|tokensUsed|costUsd|durationMs|linesAdded/);
  });

  it('one session in two sources is one contribution (S2); a duplicated pair counts once', () => {
    const x = { ...legacy('sess-a', 'claude-code'), attribution_record: record(A, [lineContribution('sess-a')]) };
    const y = { ...legacy('sess-a', 'claude-code'), attribution_record: record(B, [commitContribution('sess-a', 'claude-code')]) };
    const out = rebuildRewrittenNote({ targetSha: T, sources: [{ sha: A, note: note(x) }, { sha: B, note: note(y) }, { sha: A, note: note(x) }], ...OPTS });
    expectCommitLevelFor(out.record, T);
    expect(out.record!.contributions).toHaveLength(1);
    // A detail only some copies state (agent.version, model) is kept; one they state differently would be dropped.
    expect(out.record!.contributions[0]).toMatchObject({ agent: { id: 'claude-code' }, model: { id: 'claude-opus-4-6' }, session: { id: 'sess-a', reference_uri: REF('sess-a') } });
    expect(parse(out.payload)[REWRITE_NOTE_KEY].sources).toEqual([A, B]);
    // One session: the legacy aggregate may name it.
    expect(parse(out.payload).origin).toMatchObject({ squashMerge: true, commitsSquashed: 2, sessionId: 'sess-a', agent: 'claude-code', model: 'claude-opus-4-6', sessionIds: ['sess-a'] });
  });

  it('conflicting identities of one session give that session no canonical claim, with a structured warning', () => {
    const x = { ...legacy('sess-a', 'claude-code'), attribution_record: record(A, [commitContribution('sess-a', 'claude-code')]) };
    const y = { ...legacy('sess-a', 'cursor'), attribution_record: record(B, [commitContribution('sess-a', 'cursor')]) };
    const z = { ...legacy('sess-z', 'codex'), attribution_record: record(C, [commitContribution('sess-z', 'codex')]) };
    const out = rebuildRewrittenNote({ targetSha: T, sources: [{ sha: A, note: note(x) }, { sha: B, note: note(y) }, { sha: C, note: note(z) }], ...OPTS });
    const conflict = out.warnings.find((w) => w.code === 'conflicting-session-identity');
    expect(conflict).toMatchObject({ code: 'conflicting-session-identity', sessionId: 'sess-a' });
    expect(out.record!.contributions.map((c: any) => c.session.id)).toEqual(['sess-z']);
    // Its legacy attribution still travels.
    expect(parse(out.payload).origin.sessionIds).toEqual(['sess-a', 'sess-z']);

    const only = rebuildRewrittenNote({ targetSha: T, sources: [{ sha: A, note: note(x) }, { sha: B, note: note(y) }], ...OPTS });
    expect(only.record).toBeUndefined();
    expect(parse(only.payload)).not.toHaveProperty('attribution_record');
    expect(only.warnings.map((w) => w.code)).toEqual(expect.arrayContaining(['conflicting-session-identity', 'record-not-built']));
  });
});

describe('one session under two models (external review, blocker 2)', () => {
  const inSession = (at: string, model?: string, agent = 'claude-code', evidence = 'session_capture') => {
    const c = commitContribution('sess-m', agent, model);
    c.evidence = evidence;
    return { ...legacy('sess-m', agent, model ?? 'unknown'), attribution_record: record(at, [c]) };
  };
  const models = (rec: any) => rec.contributions.map((c: any) => `${c.session.id}/${c.agent.id}/${c.model?.id ?? '-'}`);
  const stripTime = (payload: string | null) => {
    const o = parse(payload);
    delete o.attribution_record.recorded_at;
    delete o.origin.timestamp;
    return JSON.stringify(o);
  };

  it('m1 + m2 of one session and agent: one valid commit-level contribution without a model', () => {
    const out = rebuildRewrittenNote({ targetSha: T, sources: [{ sha: A, note: note(inSession(A, 'm1')) }, { sha: B, note: note(inSession(B, 'm2')) }], ...OPTS });
    expectCommitLevelFor(out.record, T);
    expect(models(out.record)).toEqual(['sess-m/claude-code/-']);
    expect(out.record!.contributions[0]).not.toHaveProperty('model');
    const dropped = out.warnings.find((w) => w.code === 'session-detail-dropped');
    expect(dropped).toMatchObject({ sessionId: 'sess-m' });
    expect(dropped!.detail).toMatch(/model/);
    expect(out.warnings.map((w) => w.code)).not.toContain('conflicting-session-identity');
  });

  it('the reverse order gives the same payload, modulo timestamps', () => {
    const forward = rebuildRewrittenNote({ targetSha: T, sources: [{ sha: A, note: note(inSession(A, 'm1')) }, { sha: B, note: note(inSession(B, 'm2')) }], ...OPTS });
    const backward = rebuildRewrittenNote({
      targetSha: T, sources: [{ sha: B, note: note(inSession(B, 'm2')) }, { sha: A, note: note(inSession(A, 'm1')) }],
      recordedAt: new Date('2026-09-30T00:00:00Z'), producerVersion: '9.9.9',
    });
    expect(stripTime(backward.payload)).toBe(stripTime(forward.payload));
  });

  it('a model only one copy states is kept; only a real disagreement drops it', () => {
    const out = rebuildRewrittenNote({ targetSha: T, sources: [{ sha: A, note: note(inSession(A, 'm1')) }, { sha: B, note: note(inSession(B)) }], ...OPTS });
    expect(models(out.record)).toEqual(['sess-m/claude-code/m1']);
    expect(out.warnings.map((w) => w.code)).not.toContain('session-detail-dropped');
  });

  it('another agent or evidence for the same session is still a hard conflict: no canonical contribution', () => {
    for (const other of [inSession(B, 'm2', 'cursor'), inSession(B, 'm1', 'claude-code', 'imported')]) {
      const out = rebuildRewrittenNote({ targetSha: T, sources: [{ sha: A, note: note(inSession(A, 'm1')) }, { sha: B, note: note(other) }], ...OPTS });
      expect(out.record).toBeUndefined();
      expect(out.warnings.map((w) => w.code)).toContain('conflicting-session-identity');
      expect(out.warnings.map((w) => w.code)).not.toContain('session-detail-dropped');
    }
  });

  it('a target that carries the session with m1, rebuilt from m1 + m2: the target contribution loses its model', () => {
    // A commit's own note (post-commit wrote it, no marker) with the session under m1.
    const own = { ...legacy('sess-m', 'claude-code', 'm1'), attribution_record: record(T, [lineContribution('sess-m', 'claude-code', 'm1')]) };
    const out = rebuildRewrittenNote({ targetSha: T, sources: [{ sha: A, note: note(inSession(A, 'm1')) }, { sha: B, note: note(inSession(B, 'm2')) }], existingTarget: note(own), ...OPTS });
    const rec = parse(out.payload).attribution_record;
    expect(validateFull(rec).ok).toBe(true);
    expect(rec.contributions).toHaveLength(1);
    expect(rec.contributions[0]).not.toHaveProperty('model');
    // Everything else of the commit's own contribution stays.
    const { model: _m, ...rest } = own.attribution_record.contributions[0] as any;
    expect(rec.contributions[0]).toEqual(rest);
    expect(parse(out.payload).origin).toEqual(own.origin);

    // Our own intermediate rewrite note (the amend inside `rebase -i fixup`): the same.
    const intermediate = rebuildRewrittenNote({ targetSha: T, sources: [{ sha: A, note: note(inSession(A, 'm1')) }], ...OPTS }).payload!;
    const final = rebuildRewrittenNote({ targetSha: T, sources: [{ sha: A, note: note(inSession(A, 'm1')) }, { sha: B, note: note(inSession(B, 'm2')) }], existingTarget: intermediate, ...OPTS });
    expect(final.warnings.map((w) => w.code)).not.toContain('target-rebuild-lossy');
    expect(models(parse(final.payload).attribution_record)).toEqual(['sess-m/claude-code/-']);
    expect(parse(final.payload).origin).toMatchObject({ squashMerge: true, commitsSquashed: 2, sessionId: 'sess-m', sessionIds: ['sess-m'], models: ['m1', 'm2'] });
    expect(parse(final.payload).origin).not.toHaveProperty('model');
  });

  it('a hard conflict with every source in hand is its own outcome, not a lossy rebuild', () => {
    const intermediate = rebuildRewrittenNote({ targetSha: T, sources: [{ sha: A, note: note(inSession(A, 'm1')) }], ...OPTS }).payload!;
    const out = rebuildRewrittenNote({ targetSha: T, sources: [{ sha: A, note: note(inSession(A, 'm1')) }, { sha: B, note: note(inSession(B, 'm1', 'cursor')) }], existingTarget: intermediate, ...OPTS });
    const codes = out.warnings.map((w) => w.code);
    expect(codes).toContain('conflicting-session-identity');
    expect(codes).not.toContain('target-rebuild-lossy');
    expect(parse(out.payload)).not.toHaveProperty('attribution_record');
    expect(parse(out.payload).origin).toMatchObject({ squashMerge: true, commitsSquashed: 2 });
  });

  it('a late session snapshot under m2 does not bring back one model over carried m1', () => {
    const carried = rebuildRewrittenNote({ targetSha: T, sources: [{ sha: A, note: note(inSession(A, 'm1')) }], ...OPTS }).payload!;
    const snapshot = { origin: { version: 1, sessionId: 'sess-m', agent: 'claude-code', model: 'm2' }, attribution_record: record(T, [lineContribution('sess-m', 'claude-code', 'm2')]) };
    const out = JSON.parse(mergeSessionNoteOverRewrite(carried, note(snapshot), T, OPTS));
    expect(validateFull(out.attribution_record).ok).toBe(true);
    expect(out.attribution_record.contributions).toHaveLength(1);
    expect(out.attribution_record.contributions[0]).not.toHaveProperty('model');
    expect(out.attribution_record.contributions[0].files).toEqual(snapshot.attribution_record.contributions[0].files);

    // Carried with no model because its sources disagreed: the source notes decide, not the snapshot.
    const degraded = rebuildRewrittenNote({ targetSha: T, sources: [{ sha: A, note: note(inSession(A, 'm1')) }, { sha: B, note: note(inSession(B, 'm2')) }], ...OPTS }).payload!;
    const sources: Record<string, string> = { [A]: note(inSession(A, 'm1')), [B]: note(inSession(B, 'm2')) };
    const again = JSON.parse(mergeSessionNoteOverRewrite(degraded, note(snapshot), T, OPTS, (s) => sources[s] ?? null));
    expect(again.attribution_record.contributions[0]).not.toHaveProperty('model');

    // Same model everywhere: the snapshot keeps it.
    const same = { ...snapshot, attribution_record: record(T, [lineContribution('sess-m', 'claude-code', 'm1')]) };
    const kept = JSON.parse(mergeSessionNoteOverRewrite(carried, note(same), T, OPTS));
    expect(kept.attribution_record.contributions[0].model).toEqual({ id: 'm1' });
  });
});

describe('rebuildRewrittenNote: the mapping, not the notes, decides the squash (review №1 P1-4)', () => {
  const D = sha(0xd4);
  const E = sha(0xe5);
  const claude = (at: string) => ({ ...legacy('sess-1', 'claude-code'), attribution_record: record(at, [commitContribution('sess-1', 'claude-code', 'claude-opus-4-6')]) });
  const codex = (at: string) => ({ ...legacy('sess-2', 'codex', 'gpt-5'), attribution_record: record(at, [commitContribution('sess-2', 'codex', 'gpt-5')]) });

  it('three attributed and one human commit: commitsSquashed 4, two contributions, no human claim', () => {
    const out = rebuildRewrittenNote({
      targetSha: T, sourceCommits: [A, B, C, D],
      sources: [{ sha: A, note: note(claude(A)) }, { sha: B, note: note(codex(B)) }, { sha: C, note: note(claude(C)) }], ...OPTS,
    });
    expect(parse(out.payload).origin).toMatchObject({ squashMerge: true, commitsSquashed: 4, sessionIds: ['sess-1', 'sess-2'] });
    expect(out.record!.contributions.map((c: any) => c.session.id)).toEqual(['sess-1', 'sess-2']);
    expect(parse(out.payload)[REWRITE_NOTE_KEY].sources).toEqual([A, B, C, D].sort());
  });

  it('one attributed commit squashed with human commits stays an N→1 aggregate', () => {
    const out = rebuildRewrittenNote({ targetSha: T, sourceCommits: [A, D, E], sources: [{ sha: A, note: note(claude(A)) }], ...OPTS });
    const origin = parse(out.payload).origin;
    expect(origin).toEqual({
      version: 1, squashMerge: true, commitsSquashed: 3, sessionId: 'sess-1', agent: 'claude-code', model: 'claude-opus-4-6',
      sessionIds: ['sess-1'], models: ['claude-opus-4-6'], timestamp: NOW.toISOString(),
    });
    expect(JSON.stringify(origin)).not.toMatch(/SECRET/);
  });

  it('two commits with a byte-identical note: commitsSquashed 2, one contribution', () => {
    const same = note({ ...legacy('sess-1', 'claude-code'), attribution_record: undefined });
    const out = rebuildRewrittenNote({ targetSha: T, sourceCommits: [A, B], sources: [{ sha: A, note: same }, { sha: B, note: same }], ...OPTS });
    expect(parse(out.payload).origin).toMatchObject({ squashMerge: true, commitsSquashed: 2, sessionId: 'sess-1' });
    expect(out.record!.contributions).toHaveLength(1);
  });

  it('a pure 1→1 carries its payload and no squash marker', () => {
    const out = rebuildRewrittenNote({ targetSha: T, sourceCommits: [A], sources: [{ sha: A, note: note(claude(A)) }], ...OPTS });
    expect(parse(out.payload).origin).toEqual(claude(A).origin);
    expect(parse(out.payload).origin).not.toHaveProperty('squashMerge');
  });

  it('no attributed commit at all writes nothing', () => {
    expect(rebuildRewrittenNote({ targetSha: T, sourceCommits: [A, B], sources: [], ...OPTS }).payload).toBeNull();
  });
});

describe('rebuildRewrittenNote: only the exact rewrite marker marks our own note (review №1 P2)', () => {
  const src = { ...legacy('sess-a', 'claude-code'), attribution_record: record(A, [commitContribution('sess-a', 'claude-code')]) };
  const good = { schema: REWRITE_NOTE_SCHEMA, target: T, sources: [B], base: 'none' };
  const lookalikes: Array<[string, Record<string, unknown>]> = [
    ['the pre-review top-level key', { rewrite_sources: [B] }],
    ['another schema version', { origin_rewrite: { ...good, schema: 'origin-rewrite/2' } }],
    ['another target', { origin_rewrite: { ...good, target: C } }],
    ['an extra key', { origin_rewrite: { ...good, note: 'x' } }],
    ['unsorted sources', { origin_rewrite: { ...good, sources: [C, B].sort().reverse() } }],
    ['a short sha', { origin_rewrite: { ...good, sources: ['abc123'] } }],
    ['an unknown base', { origin_rewrite: { ...good, base: 'all' } }],
  ];
  for (const [label, extra] of lookalikes) {
    it(`${label}: the note is foreign — kept, only extended`, () => {
      const target = { ...legacy('sess-t', 'codex', 'gpt-5'), ...extra };
      const out = rebuildRewrittenNote({ targetSha: T, sources: [{ sha: A, note: note(src) }], existingTarget: note(target), ...OPTS });
      expect(out.recordedSources).toBeUndefined();
      const env = parse(out.payload);
      expect(env.origin).toEqual(target.origin);
      for (const k of Object.keys(extra)) if (k !== REWRITE_NOTE_KEY) expect(env[k]).toEqual((extra as any)[k]);
      expect(env.attribution_record.contributions.map((c: any) => c.session.id)).toEqual(['sess-t', 'sess-a']);
      expect(env[REWRITE_NOTE_KEY]).toEqual({ schema: REWRITE_NOTE_SCHEMA, target: T, sources: [A], base: 'note' });
    });
  }

  it('the exact marker of our own note is recognised and rebuilt from the union', () => {
    const other = { ...legacy('sess-b', 'codex', 'gpt-5'), attribution_record: record(B, [commitContribution('sess-b', 'codex', 'gpt-5')]) };
    const ours = rebuildRewrittenNote({ targetSha: T, sources: [{ sha: B, note: note(other) }], ...OPTS }).payload;
    expect(parse(ours)[REWRITE_NOTE_KEY]).toEqual(good);
    expect(rebuildRewrittenNote({ targetSha: T, sources: [{ sha: A, note: note(src) }], existingTarget: ours, ...OPTS }).recordedSources).toEqual([B]);
  });
});

describe('never downgrade or lose what the target already carries (review №2 P1-2)', () => {
  const a = { ...legacy('sess-a', 'claude-code'), attribution_record: record(A, [commitContribution('sess-a', 'claude-code', 'claude-opus-4-6')]) };
  const b = { ...legacy('sess-b', 'codex', 'gpt-5'), attribution_record: record(B, [commitContribution('sess-b', 'codex', 'gpt-5')]) };
  const c = { ...legacy('sess-c', 'cursor', 'gpt-5'), attribution_record: record(C, [commitContribution('sess-c', 'cursor', 'gpt-5')]) };
  const mark = (base: 'none' | 'note', sources = [A]) => ({ schema: REWRITE_NOTE_SCHEMA, target: T, sources, base });
  const unusable: Array<[string, (r: any) => any]> = [
    ['a newer major', (r) => ({ ...r, schema_version: '2.0', future: { kept: true } })],
    ['an invalid record', (r) => ({ ...r, attribution_level: 'hunk' })],
    ['another revision', (r) => ({ ...r, revision: { vcs: 'git', id: B } })],
  ];

  for (const [label, spoil] of unusable) {
    it(`the session writer keeps ${label} byte for byte next to a valid marker`, () => {
      const existing = { ...legacy('sess-a', 'claude-code'), attribution_record: spoil(record(T, [commitContribution('sess-a', 'claude-code')])), origin_rewrite: mark('none') };
      const session = { origin: { version: 1, sessionId: 'sess-s', agent: 'codex' }, attribution_record: record(T, [commitContribution('sess-s', 'codex')]) };
      const out = JSON.parse(mergeSessionNoteOverRewrite(note(existing), note(session), T, OPTS));
      expect(JSON.stringify(out.attribution_record)).toBe(JSON.stringify(existing.attribution_record));
      expect(out.origin).toEqual(session.origin);
      expect(out[REWRITE_NOTE_KEY]).toEqual(mark('note'));
    });

    it(`a repeat or a new rewrite never rebuilds over ${label}`, () => {
      for (const base of ['none', 'note'] as const) {
        const existing = { ...legacy('sess-a', 'claude-code'), attribution_record: spoil(record(T, [commitContribution('sess-a', 'claude-code')])), origin_rewrite: mark(base) };
        for (const sources of [[{ sha: A, note: note(a) }], [{ sha: A, note: note(a) }, { sha: C, note: note(c) }]]) {
          const out = rebuildRewrittenNote({ targetSha: T, sources, existingTarget: note(existing), ...OPTS });
          expect(out.payload, `${label}/${base}`).toBeNull();
          expect(out.warnings.map((w) => w.code), `${label}/${base}`).toContain('target-record-unusable');
        }
      }
    });
  }

  it('an exact 1.0 target record is still merged into by the session writer', () => {
    const carried = rebuildRewrittenNote({ targetSha: T, sources: [{ sha: A, note: note(a) }], ...OPTS }).payload!;
    const session = { origin: { version: 1, sessionId: 'sess-s', agent: 'codex' }, attribution_record: record(T, [commitContribution('sess-s', 'codex')]) };
    const out = JSON.parse(mergeSessionNoteOverRewrite(carried, note(session), T, OPTS));
    expect(out.attribution_record.contributions.map((x: any) => x.session.id)).toEqual(['sess-s', 'sess-a']);
    expect(validateFull(out.attribution_record).ok).toBe(true);
  });

  it('a recorded old commit whose note is gone does not take its carried contribution away', () => {
    const first = rebuildRewrittenNote({ targetSha: T, sources: [{ sha: A, note: note(a) }, { sha: B, note: note(b) }], ...OPTS }).payload!;
    // Same mapping, A's note (or A itself) no longer readable.
    const again = rebuildRewrittenNote({ targetSha: T, sourceCommits: [A, B], sources: [{ sha: B, note: note(b) }], existingTarget: first, ...OPTS });
    const kept = JSON.parse(again.payload ?? first);
    expect(kept.attribution_record.contributions.map((x: any) => x.session.id)).toEqual(['sess-a', 'sess-b']);
    expect(kept.origin).toMatchObject({ commitsSquashed: 2, sessionIds: ['sess-a', 'sess-b'] });
    expect(again.warnings.map((w) => w.code)).toContain('target-rebuild-lossy');
    // A new old commit still adds, without dropping the one whose note is gone.
    const grown = rebuildRewrittenNote({ targetSha: T, sourceCommits: [A, B, C], sources: [{ sha: B, note: note(b) }, { sha: C, note: note(c) }], existingTarget: first, ...OPTS });
    const env = parse(grown.payload);
    expect(env.attribution_record.contributions.map((x: any) => x.session.id)).toEqual(['sess-a', 'sess-b', 'sess-c']);
    expect(validateFull(env.attribution_record).ok).toBe(true);
    expect(env[REWRITE_NOTE_KEY].sources).toEqual([A, B, C].sort());
  });
});

describe('rebuildRewrittenNote: an existing target note', () => {
  const src = { ...legacy('sess-a', 'claude-code'), attribution_record: record(A, [lineContribution('sess-a')]) };

  it('a foreign legacy note is kept verbatim; the record is added from both', () => {
    const target = legacy('sess-t', 'codex', 'gpt-5');
    const out = rebuildRewrittenNote({ targetSha: T, sources: [{ sha: A, note: note(src) }], existingTarget: note(target), ...OPTS });
    const env = parse(out.payload);
    expect(env.origin).toEqual(target.origin);
    // The bookkeeping says a note of the commit's own sits under the carried contribution.
    expect(env[REWRITE_NOTE_KEY]).toEqual({ schema: REWRITE_NOTE_SCHEMA, target: T, sources: [A], base: 'note' });
    expectCommitLevelFor(env.attribution_record, T);
    expect(env.attribution_record.contributions.map((c: any) => c.session.id)).toEqual(['sess-t', 'sess-a']);
  });

  it('a foreign target record keeps every field and gains only missing sessions', () => {
    const own = record(T, [commitContribution('sess-t', 'codex', 'gpt-5')]);
    (own.contributions[0] as any).session.iterations = [{ index: 0 }];
    const target = { ...legacy('sess-t', 'codex', 'gpt-5'), attribution_record: own };
    const out = rebuildRewrittenNote({ targetSha: T, sources: [{ sha: A, note: note(src) }], existingTarget: note(target), ...OPTS });
    const rec = parse(out.payload).attribution_record;
    expect(validateFull(rec).ok).toBe(true);
    expect(rec.contributions[0]).toEqual(own.contributions[0]);
    expect(rec.revision).toEqual(own.revision);
    expect(rec.contributions.map((c: any) => c.session.id)).toEqual(['sess-t', 'sess-a']);
    expect(parse(out.payload).origin).toEqual(target.origin);
  });

  it('nothing new for the target, or a target that cannot be merged safely: no write at all', () => {
    const same = { ...legacy('sess-a', 'claude-code'), attribution_record: record(T, [commitContribution('sess-a', 'claude-code')]) };
    expect(rebuildRewrittenNote({ targetSha: T, sources: [{ sha: A, note: note(src) }], existingTarget: note(same), ...OPTS }).payload).toBeNull();

    const differs = { ...legacy('sess-a', 'cursor'), attribution_record: record(T, [commitContribution('sess-a', 'cursor')]) };
    const d = rebuildRewrittenNote({ targetSha: T, sources: [{ sha: A, note: note(src) }], existingTarget: note(differs), ...OPTS });
    expect(d.payload).toBeNull();
    expect(d.warnings.map((w) => w.code)).toContain('target-session-differs');

    const stale = { ...legacy('sess-x', 'codex'), attribution_record: record(B, [commitContribution('sess-x')]) };
    const s = rebuildRewrittenNote({ targetSha: T, sources: [{ sha: A, note: note(src) }], existingTarget: note(stale), ...OPTS });
    expect(s.payload).toBeNull();
    expect(s.warnings.map((w) => w.code)).toContain('target-record-unusable');

    const text = rebuildRewrittenNote({ targetSha: T, sources: [{ sha: A, note: note(src) }], existingTarget: 'someone else\'s text', ...OPTS });
    expect(text.payload).toBeNull();
    expect(text.warnings.map((w) => w.code)).toEqual(['target-note-not-json']);
  });

  it('an earlier rewrite\'s note is rebuilt from the union of its sources, and a repeat is a no-op', () => {
    const other = { ...legacy('sess-b', 'codex', 'gpt-5'), attribution_record: record(B, [commitContribution('sess-b', 'codex', 'gpt-5')]) };
    // The internal `amend` pair of a rebase squash ran first...
    const first = rebuildRewrittenNote({ targetSha: T, sources: [{ sha: A, note: note(src) }], ...OPTS });
    // ...then the final `rebase` pairs. Without A's note in hand the builder asks for it.
    const ask = rebuildRewrittenNote({ targetSha: T, sources: [{ sha: B, note: note(other) }], existingTarget: first.payload, ...OPTS });
    expect(ask.payload).toBeNull();
    expect(ask.recordedSources).toEqual([A]);
    const union = rebuildRewrittenNote({ targetSha: T, sources: [{ sha: B, note: note(other) }, { sha: A, note: note(src) }], existingTarget: first.payload, ...OPTS });
    const direct = rebuildRewrittenNote({ targetSha: T, sources: [{ sha: A, note: note(src) }, { sha: B, note: note(other) }], ...OPTS });
    expect(union.payload).toBe(direct.payload);
    // The same pairs again, later: nothing to write.
    const later = { ...OPTS, recordedAt: new Date('2026-09-29T00:00:00Z') };
    expect(rebuildRewrittenNote({ targetSha: T, sources: [{ sha: A, note: note(src) }, { sha: B, note: note(other) }], existingTarget: union.payload, ...later }).payload).toBeNull();
  });
});

// ─── Real git, through the hooks Origin installs ────────────────────────────

const cliRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const BIN = process.env.ORIGIN_E2E_BIN || path.join(cliRoot, 'dist', 'index.js');
const isWindows = process.platform === 'win32';

type Mode = 'global' | 'local';

class Fixture {
  tmp = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'origin-or11-'));
  home = path.join(this.tmp, 'home');
  repo = path.join(this.tmp, 'repo');
  hooks = path.join(this.tmp, 'hooks');
  wrapper = path.join(this.tmp, 'origin-bin');
  env: NodeJS.ProcessEnv;

  constructor(mode: Mode) {
    // ~/.origin exists on every installed machine; the hook log lives there.
    fs.mkdirSync(path.join(this.home, '.origin'), { recursive: true });
    fs.mkdirSync(this.repo);
    fs.mkdirSync(this.hooks);
    const env: NodeJS.ProcessEnv = {};
    for (const [k, v] of Object.entries(process.env)) if (!k.startsWith('ORIGIN_') && !k.startsWith('GIT_')) env[k] = v;
    // post-commit's pgrep fallback would read THIS machine's running agents and
    // write a `detected-*` note over the commit (a known, separate bug). The
    // hooks here see no agent process at all.
    const fakeBin = path.join(this.tmp, 'bin');
    fs.mkdirSync(fakeBin);
    fs.writeFileSync(path.join(fakeBin, 'pgrep'), '#!/bin/sh\nexit 1\n', { mode: 0o755 });
    this.env = {
      ...env, PATH: `${fakeBin}${path.delimiter}${env.PATH || ''}`, HOME: this.home, USERPROFILE: this.home, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null',
      GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@example.com', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@example.com',
    };
    fs.writeFileSync(this.wrapper, `#!/bin/sh\nexec "${process.execPath}" "${BIN}" "$@"\n`, { mode: 0o755 });
    execFileSync('git', ['init', '-q', '-b', 'main', this.repo], { env: this.env });
    if (mode === 'global') {
      writeGlobalPrepareCommitMsgHook(this.hooks);
      writeGlobalPostCommitHook(this.hooks);
      writeGlobalPostRewriteHook(this.hooks);
      for (const h of ['prepare-commit-msg', 'post-commit', 'post-rewrite']) this.patchGlobal(path.join(this.hooks, h));
      this.git('config', 'core.hooksPath', this.hooks);
    } else {
      const quiet = console.log;
      console.log = () => {};
      try {
        installRewriteHooks(this.repo);
        installGitPostCommitHook(this.repo);
        installGitPrepareCommitMsgHook(this.repo);
      } finally { console.log = quiet; }
      for (const h of ['prepare-commit-msg', 'post-commit', 'post-rewrite']) this.patchLocal(path.join(this.repo, '.git', 'hooks', h));
    }
    this.commit('base.txt', 'base\n', 'base');
  }

  /** The generated script, with its binary resolution pointed at the built CLI. */
  private patchGlobal(hook: string) {
    const src = fs.readFileSync(hook, 'utf-8');
    const start = src.indexOf('ORIGIN_BIN=""');
    const end = src.indexOf('\nfi\n', start);
    expect(start).toBeGreaterThan(-1);
    fs.writeFileSync(hook, src.slice(0, start) + `ORIGIN_BIN="${this.wrapper}"` + src.slice(end + '\nfi'.length), { mode: 0o755 });
  }
  private patchLocal(hook: string) {
    const src = fs.readFileSync(hook, 'utf-8');
    const patched = src.replace(/(?:PATH=\S+ )?origin hooks /g, `"${this.wrapper}" hooks `);
    expect(patched).not.toBe(src);
    fs.writeFileSync(hook, patched, { mode: 0o755 });
  }

  git(...args: string[]): string {
    return execFileSync('git', args, { cwd: this.repo, env: this.env, encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  }
  gitEnv(extra: NodeJS.ProcessEnv, ...args: string[]): void {
    execFileSync('git', args, { cwd: this.repo, env: { ...this.env, ...extra }, stdio: 'ignore' });
  }
  commit(file: string, body: string, msg: string): string {
    fs.writeFileSync(path.join(this.repo, file), body);
    this.git('add', file);
    this.git('commit', '-q', '-m', msg);
    return this.git('rev-parse', 'HEAD');
  }
  annotate(commit: string, obj: unknown) {
    this.git('notes', '--ref=origin', 'add', '-f', '-m', JSON.stringify(obj, null, 2), commit);
  }
  noteText(commit: string): string | null {
    try { return this.git('notes', '--ref=origin', 'show', commit); } catch { return null; }
  }
  note(commit: string): any {
    const t = this.noteText(commit);
    return t === null ? null : JSON.parse(t);
  }
  batches(): string[] {
    const log = path.join(this.home, '.origin', 'hooks.log');
    return fs.existsSync(log) ? fs.readFileSync(log, 'utf-8').split('\n').filter((l) => l.includes('rewrite batch:')) : [];
  }
  /** Wait for the backgrounded hooks: `n` more rewrite batches than `before`. */
  async batchesReach(before: number, n: number, ms = 45_000): Promise<string[]> {
    const deadline = Date.now() + ms;
    while (Date.now() < deadline) {
      const b = this.batches();
      if (b.length >= before + n) return b.slice(before);
      await new Promise((r) => setTimeout(r, 100));
    }
    const log = path.join(this.home, '.origin', 'hooks.log');
    const tail = fs.existsSync(log)
      ? fs.readFileSync(log, 'utf-8').split('\n').filter((l) => /cherry|rewrite|HOOK (INVOKED|COMPLETE)|git-notes/.test(l)).slice(-30).join('\n')
      : '(no hooks.log)';
    throw new Error(`expected ${n} rewrite batch(es), saw ${this.batches().length - before}\n${tail}`);
  }
  runRewriteHook(kind: string, pairs: string) {
    const r = spawnSync(process.execPath, [BIN, 'hooks', 'git-post-rewrite', kind], { cwd: this.repo, env: this.env, input: pairs, encoding: 'utf-8', timeout: 60_000 });
    expect(r.status, r.stderr).toBe(0);
  }
  cleanup() { try { fs.rmSync(this.tmp, { recursive: true, force: true }); } catch { /* ignore */ } }
}

/** A note with its build timestamps removed, for comparing rebuilds made at different times. */
function stripTimes(text: string | null): string {
  const o = JSON.parse(text as string);
  if (o.attribution_record) delete o.attribution_record.recorded_at;
  if (o.origin?.squashMerge) delete o.origin.timestamp;
  return JSON.stringify(o);
}

function sessionNote(commit: string, sessionId: string, agent: string, model: string, lineLevel = false) {
  const contribution = lineLevel ? lineContribution(sessionId, agent, model) : commitContribution(sessionId, agent, model);
  return { ...legacy(sessionId, agent, model), attribution_record: record(commit, [contribution]) };
}

describe.skipIf(isWindows || !fs.existsSync(BIN))('real git through the installed hooks (global core.hooksPath)', () => {
  let f: Fixture;
  beforeEach(() => { f = new Fixture('global'); });
  afterEach(() => f.cleanup());

  it('amend without a tree change: a commit-level record for the new sha; the old note is untouched', async () => {
    const a = f.commit('a.txt', 'one\n', 'a');
    f.annotate(a, sessionNote(a, 'sess-a', 'claude-code', 'claude-opus-4-6', true));
    const oldNote = f.noteText(a);
    const before = f.batches().length;
    f.git('commit', '-q', '--amend', '-m', 'a, reworded');
    const amended = f.git('rev-parse', 'HEAD');
    await f.batchesReach(before, 1);
    const n = f.note(amended);
    expect(readRecord(n.attribution_record).status).toBe('exact');
    expect(n.attribution_record.revision).toEqual({ vcs: 'git', id: amended });
    expect(n.attribution_record.attribution_level).toBe('commit');
    expect(n.attribution_record.contributions[0]).not.toHaveProperty('files');
    expect(n.attribution_record.contributions[0].session.id).toBe('sess-a');
    expect(n.origin.sessionId).toBe('sess-a');
    expect(f.noteText(a)).toBe(oldNote);
  }, 120_000);

  it('amend with extra human changes: identity survives at commit level, no revision totals', async () => {
    const a = f.commit('a.txt', 'one\n', 'a');
    f.annotate(a, sessionNote(a, 'sess-a', 'codex', 'gpt-5', true));
    const before = f.batches().length;
    fs.writeFileSync(path.join(f.repo, 'a.txt'), 'one\nhuman line\n');
    fs.writeFileSync(path.join(f.repo, 'human.txt'), 'by hand\n');
    f.git('add', '-A');
    f.git('commit', '-q', '--amend', '--no-edit');
    const amended = f.git('rev-parse', 'HEAD');
    await f.batchesReach(before, 1);
    const rec = f.note(amended).attribution_record;
    expect(validateFull(rec).ok).toBe(true);
    expect(rec.revision).toEqual({ vcs: 'git', id: amended });
    expect(rec.contributions).toEqual([{ evidence: 'session_capture', agent: { id: 'codex', version: '2.1.0' }, model: { id: 'gpt-5' }, actor: { id: 'user_01' }, session: { id: 'sess-a', reference_uri: REF('sess-a'), started_at: '2026-09-01T00:00:00Z' } }]);
  }, 120_000);

  it('rebase of two annotated commits: each new commit gets its own session, never swapped', async () => {
    f.git('checkout', '-q', '-b', 'feat');
    const c1 = f.commit('c1.txt', '1\n', 'c1');
    f.annotate(c1, sessionNote(c1, 'sess-1', 'claude-code', 'claude-opus-4-6'));
    const c2 = f.commit('c2.txt', '2\n', 'c2');
    f.annotate(c2, sessionNote(c2, 'sess-2', 'cursor', 'gpt-5'));
    f.git('checkout', '-q', 'main');
    f.commit('m.txt', 'm\n', 'main moves');
    f.git('checkout', '-q', 'feat');
    const before = f.batches().length;
    f.git('rebase', '-q', 'main');
    const n2 = f.git('rev-parse', 'HEAD');
    const n1 = f.git('rev-parse', 'HEAD~1');
    await f.batchesReach(before, 1);
    expect(f.note(n1).attribution_record.revision.id).toBe(n1);
    expect(f.note(n1).attribution_record.contributions.map((c: any) => c.session.id)).toEqual(['sess-1']);
    expect(f.note(n2).attribution_record.revision.id).toBe(n2);
    expect(f.note(n2).attribution_record.contributions.map((c: any) => c.session.id)).toEqual(['sess-2']);
    expect(f.note(c1).attribution_record.revision.id).toBe(c1);
  }, 120_000);

  it('rebase with a resolved conflict and a new message: git\'s pair decides, not the subject', async () => {
    f.git('checkout', '-q', '-b', 'feat');
    const c1 = f.commit('shared.txt', 'theirs\n', 'change shared');
    f.annotate(c1, sessionNote(c1, 'sess-1', 'gemini', 'gemini-2.5-pro', true));
    f.git('checkout', '-q', 'main');
    f.commit('shared.txt', 'ours\n', 'main changes shared');
    f.git('checkout', '-q', 'feat');
    const before = f.batches().length;
    try { f.git('rebase', '-q', 'main'); } catch { /* conflict */ }
    fs.writeFileSync(path.join(f.repo, 'shared.txt'), 'resolved\n');
    f.git('add', 'shared.txt');
    const editor = path.join(f.tmp, 'reword.sh');
    fs.writeFileSync(editor, '#!/bin/sh\necho "entirely different subject" > "$1"\n', { mode: 0o755 });
    f.gitEnv({ GIT_EDITOR: editor }, 'rebase', '--continue');
    const rewritten = f.git('rev-parse', 'HEAD');
    expect(f.git('log', '-1', '--format=%s')).toBe('entirely different subject');
    await f.batchesReach(before, 1);
    const rec = f.note(rewritten).attribution_record;
    expect(rec.revision.id).toBe(rewritten);
    expect(rec.attribution_level).toBe('commit');
    expect(rec.contributions.map((c: any) => [c.session.id, c.agent.id])).toEqual([['sess-1', 'gemini']]);
  }, 120_000);

  it('rebase -i squash: both sessions in one record, a legacy aggregate, and a repeat changes nothing', async () => {
    const c1 = f.commit('c1.txt', '1\n', 'c1');
    f.annotate(c1, sessionNote(c1, 'sess-1', 'claude-code', 'claude-opus-4-6', true));
    const c2 = f.commit('c2.txt', '2\n', 'c2');
    f.annotate(c2, sessionNote(c2, 'sess-2', 'codex', 'gpt-5'));
    const before = f.batches().length;
    const editor = path.join(f.tmp, 'seq.sh');
    fs.writeFileSync(editor, '#!/bin/sh\nsed -i.bak -e "2s/^pick/squash/" "$1"\n', { mode: 0o755 });
    f.gitEnv({ GIT_SEQUENCE_EDITOR: editor, GIT_EDITOR: 'true' }, 'rebase', '-q', '-i', 'HEAD~2');
    const squashed = f.git('rev-parse', 'HEAD');
    // git reports the internal amend and the final rebase from two backgrounded hooks.
    await f.batchesReach(before, 2);
    const n = f.note(squashed);
    expect(readRecord(n.attribution_record).status).toBe('exact');
    expect(n.attribution_record.revision.id).toBe(squashed);
    expect(n.attribution_record.attribution_level).toBe('commit');
    expect(n.attribution_record.contributions.map((c: any) => `${c.session.id}/${c.agent.id}`)).toEqual(['sess-1/claude-code', 'sess-2/codex']);
    expect(n.origin).toMatchObject({ squashMerge: true, commitsSquashed: 2, sessionIds: ['sess-1', 'sess-2'] });
    expect(n.origin).not.toHaveProperty('sessionId');
    expect(n[REWRITE_NOTE_KEY]).toEqual({ schema: REWRITE_NOTE_SCHEMA, target: squashed, sources: [c1, c2].sort(), base: 'none' });
    const settled = f.noteText(squashed);

    const again = f.batches().length;
    f.runRewriteHook('rebase', `${c2} ${squashed}\n${c1} ${squashed}\n`);
    expect((await f.batchesReach(again, 1))[0]).toContain('1 unchanged');
    expect(f.noteText(squashed)).toBe(settled);
  }, 120_000);

  it('rebase -i pick + fixup, one session under two models: a squash with one model-less contribution, in any hook order', async () => {
    const s1 = f.commit('s1.txt', '1\n', 's1');
    f.annotate(s1, sessionNote(s1, 'sess-s', 'claude-code', 'm1'));
    const s2 = f.commit('s2.txt', '2\n', 's2');
    f.annotate(s2, sessionNote(s2, 'sess-s', 'claude-code', 'm2'));
    const sourceNotes = [f.noteText(s1), f.noteText(s2)];
    const before = f.batches().length;
    const editor = path.join(f.tmp, 'seq.sh');
    fs.writeFileSync(editor, '#!/bin/sh\nsed -i.bak -e "2s/^pick/fixup/" "$1"\n', { mode: 0o755 });
    f.gitEnv({ GIT_SEQUENCE_EDITOR: editor, GIT_EDITOR: 'true' }, 'rebase', '-q', '-i', 'HEAD~2');
    const t = f.git('rev-parse', 'HEAD');
    // git reports the internal amend (s1 → T) and the final rebase (s1, s2 → T).
    await f.batchesReach(before, 2);
    const check = () => {
      const n = f.note(t);
      expect(n.origin).toMatchObject({ squashMerge: true, commitsSquashed: 2, sessionId: 'sess-s', sessionIds: ['sess-s'] });
      expect(n.origin).not.toHaveProperty('model');
      expect(n[REWRITE_NOTE_KEY]).toEqual({ schema: REWRITE_NOTE_SCHEMA, target: t, sources: [s1, s2].sort(), base: 'none' });
      expect(readRecord(n.attribution_record).status).toBe('exact');
      expect(n.attribution_record.revision.id).toBe(t);
      expect(n.attribution_record.contributions).toHaveLength(1);
      expect(n.attribution_record.contributions[0]).toMatchObject({ evidence: 'session_capture', agent: { id: 'claude-code' }, session: { id: 'sess-s' } });
      expect(n.attribution_record.contributions[0]).not.toHaveProperty('model');
    };
    check();
    const settled = f.noteText(t);

    // The two background hooks in the other order, and a repeat: the same note.
    f.git('notes', '--ref=origin', 'remove', t);
    let at = f.batches().length;
    f.runRewriteHook('rebase', `${s1} ${t}\n${s2} ${t}\n`);
    await f.batchesReach(at, 1);
    at = f.batches().length;
    f.runRewriteHook('amend', `${s1} ${t}\n`);
    await f.batchesReach(at, 1);
    check();
    at = f.batches().length;
    f.runRewriteHook('rebase', `${s2} ${t}\n${s1} ${t}\n`);
    expect((await f.batchesReach(at, 1))[0]).toContain('1 unchanged');
    expect(stripTimes(f.noteText(t))).toBe(stripTimes(settled));
    expect([f.noteText(s1), f.noteText(s2)]).toEqual(sourceNotes);
  }, 120_000);

  it('a rewrite chain A→B→C folds to a valid survivor and repeating any hop is idempotent', async () => {
    const a = f.commit('a.txt', '1\n', 'a');
    f.annotate(a, sessionNote(a, 'sess-a', 'copilot', 'gpt-5', true));
    let before = f.batches().length;
    f.git('commit', '-q', '--amend', '-m', 'b');
    const b = f.git('rev-parse', 'HEAD');
    await f.batchesReach(before, 1);
    before = f.batches().length;
    f.git('commit', '-q', '--amend', '-m', 'c');
    const c = f.git('rev-parse', 'HEAD');
    await f.batchesReach(before, 1);
    expect(f.note(b).attribution_record.revision.id).toBe(b);
    const rec = f.note(c).attribution_record;
    expect(readRecord(rec).status).toBe('exact');
    expect(rec.revision.id).toBe(c);
    expect(rec.contributions.map((x: any) => [x.session.id, x.agent.id])).toEqual([['sess-a', 'copilot']]);
    const settled = f.noteText(c);
    before = f.batches().length;
    f.runRewriteHook('amend', `${b} ${c}\n`);
    await f.batchesReach(before, 1);
    expect(f.noteText(c)).toBe(settled);
  }, 120_000);

  it('a note post-commit already wrote on the target is not replaced', async () => {
    const a = f.commit('a.txt', '1\n', 'a');
    f.annotate(a, sessionNote(a, 'sess-a', 'claude-code', 'claude-opus-4-6'));
    const x = f.commit('x.txt', 'x\n', 'x');
    const own = sessionNote(x, 'sess-x', 'codex', 'gpt-5');
    f.annotate(x, own);
    const before = f.batches().length;
    f.runRewriteHook('rebase', `${a} ${x}\n`);
    await f.batchesReach(before, 1);
    const n = f.note(x);
    expect(n.origin).toEqual(own.origin);
    expect(n.attribution_record.contributions.map((c: any) => c.session.id)).toEqual(['sess-x', 'sess-a']);
    expect(n.attribution_record.contributions[0]).toEqual(own.attribution_record.contributions[0]);
  }, 120_000);
});

function cherryPickSuite(mode: Mode) {
  describe.skipIf(isWindows || !fs.existsSync(BIN))(`cherry-pick through the installed hooks (${mode})`, () => {
    let f: Fixture;
    beforeEach(() => { f = new Fixture(mode); });
    afterEach(() => f.cleanup());

    it('a clean pick of an annotated commit gets the legacy note and a commit-level record for the pick', async () => {
      f.git('checkout', '-q', '-b', 'feat');
      const src = f.commit('c.txt', 'c\n', 'c');
      f.annotate(src, sessionNote(src, 'sess-p', 'claude-code', 'claude-opus-4-6', true));
      const srcNote = f.noteText(src);
      f.git('checkout', '-q', 'main');
      f.commit('m.txt', 'm\n', 'main moves');
      const before = f.batches().length;
      f.git('cherry-pick', src);
      const picked = f.git('rev-parse', 'HEAD');
      await f.batchesReach(before, 1);
      const n = f.note(picked);
      expect(readRecord(n.attribution_record).status).toBe('exact');
      expect(n.attribution_record.revision).toEqual({ vcs: 'git', id: picked });
      expect(n.attribution_record.attribution_level).toBe('commit');
      expect(n.attribution_record.contributions.map((c: any) => c.session.id)).toEqual(['sess-p']);
      expect(n.origin.sessionId).toBe('sess-p');
      expect(f.noteText(src)).toBe(srcNote);
    }, 120_000);

    it('a conflict-resolved pick keeps commit-level identity only', async () => {
      f.git('checkout', '-q', '-b', 'feat');
      const src = f.commit('shared.txt', 'theirs\n', 'change shared');
      f.annotate(src, sessionNote(src, 'sess-p', 'cursor', 'gpt-5', true));
      f.git('checkout', '-q', 'main');
      f.commit('shared.txt', 'ours\n', 'main changes shared');
      const before = f.batches().length;
      try { f.git('cherry-pick', src); } catch { /* conflict */ }
      fs.writeFileSync(path.join(f.repo, 'shared.txt'), 'resolved\n');
      f.git('add', 'shared.txt');
      f.gitEnv({ GIT_EDITOR: 'true' }, 'cherry-pick', '--continue');
      const picked = f.git('rev-parse', 'HEAD');
      await f.batchesReach(before, 1);
      const rec = f.note(picked).attribution_record;
      expect(rec.revision.id).toBe(picked);
      expect(rec.attribution_level).toBe('commit');
      expect(rec.contributions).toEqual([{ evidence: 'session_capture', agent: { id: 'cursor', version: '2.1.0' }, model: { id: 'gpt-5' }, actor: { id: 'user_01' }, session: { id: 'sess-p', reference_uri: REF('sess-p'), started_at: '2026-09-01T00:00:00Z' } }]);
    }, 120_000);

    it('a multi-commit pick maps each copy to its own source; a pick without a note gets none', async () => {
      f.git('checkout', '-q', '-b', 'feat');
      const s1 = f.commit('p1.txt', '1\n', 'p1');
      f.annotate(s1, sessionNote(s1, 'sess-1', 'claude-code', 'claude-opus-4-6'));
      const s2 = f.commit('p2.txt', '2\n', 'p2');
      f.annotate(s2, sessionNote(s2, 'sess-2', 'codex', 'gpt-5'));
      const plain = f.commit('p3.txt', '3\n', 'p3 (no note)');
      f.git('checkout', '-q', 'main');
      const before = f.batches().length;
      f.git('cherry-pick', s1, s2, plain);
      const [p1, p2, p3] = [f.git('rev-parse', 'HEAD~2'), f.git('rev-parse', 'HEAD~1'), f.git('rev-parse', 'HEAD')];
      await f.batchesReach(before, 3);
      expect(f.note(p1).attribution_record.contributions.map((c: any) => c.session.id)).toEqual(['sess-1']);
      expect(f.note(p1).attribution_record.revision.id).toBe(p1);
      expect(f.note(p2).attribution_record.contributions.map((c: any) => c.session.id)).toEqual(['sess-2']);
      expect(f.note(p2).attribution_record.revision.id).toBe(p2);
      expect(f.noteText(p3)).toBeNull();
    }, 120_000);

    it('an ordinary commit on the same parent after an abandoned pick carries nothing', async () => {
      f.git('checkout', '-q', '-b', 'feat');
      const src = f.commit('shared.txt', 'theirs\n', 'change shared');
      f.annotate(src, sessionNote(src, 'sess-p', 'claude-code', 'claude-opus-4-6'));
      f.git('checkout', '-q', 'main');
      f.commit('shared.txt', 'ours\n', 'main changes shared');
      try { f.git('cherry-pick', src); } catch { /* conflict */ }
      fs.writeFileSync(path.join(f.repo, 'shared.txt'), 'resolved\n');
      f.git('add', 'shared.txt');
      // prepare-commit-msg runs (and remembers the source), then an empty message aborts the commit.
      const empty = path.join(f.tmp, 'empty.sh');
      fs.writeFileSync(empty, '#!/bin/sh\n: > "$1"\n', { mode: 0o755 });
      try { f.gitEnv({ GIT_EDITOR: empty }, 'cherry-pick', '--continue'); } catch { /* aborted: empty message */ }
      const markers = path.join(f.repo, '.git', 'origin-cherry-picks');
      expect(fs.existsSync(markers) && fs.readdirSync(markers).length).toBe(1);
      // git has already dropped the pick's state; throw the resolution away.
      f.git('reset', '-q', '--hard', 'HEAD');
      const own = f.commit('own.txt', 'mine\n', 'my own work');
      await new Promise((r) => setTimeout(r, 3_000)); // let the backgrounded post-commit finish
      expect(f.noteText(own)).toBeNull();
    }, 120_000);
  });
}

cherryPickSuite('global');
cherryPickSuite('local');
