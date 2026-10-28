// OR-46 CR4: the line projection never runs under the note-write lock.
//
// A rewrite reads the notes it builds from under a short lock, projects and
// builds outside it, and writes under a second short lock only when every note
// it read is still byte for byte the same. The real projector runs; a module
// hook around it lets a test act while it runs, as a concurrent writer would.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { execFileSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';

vi.mock('../api.js', () => ({ api: { importGitNote: vi.fn(() => Promise.resolve({ ok: true })) } }));

const probe = vi.hoisted(() => ({
  calls: [] as Array<{ targetSha: string; sources: ReadonlyArray<{ sha: string; note: string }> }>,
  /** Runs while the projector runs; `n` is the 1-based call. */
  during: null as null | ((n: number) => void),
  /** Passed to the real projector instead of its default budget. */
  deadline: undefined as undefined | { at: number; now: () => number },
}));

vi.mock('../rewrite-line-projection.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../rewrite-line-projection.js')>();
  return {
    ...real,
    projectRewriteLineClaims: (input: Parameters<typeof real.projectRewriteLineClaims>[0]) => {
      probe.calls.push({ targetSha: input.targetSha, sources: input.sources });
      probe.during?.(probe.calls.length);
      return real.projectRewriteLineClaims(probe.deadline ? { ...input, deadline: probe.deadline } : input);
    },
  };
});

const { preserveAttributionBatch } = await import('../history-preservation.js');
const { withNoteWriteLock } = await import('../note-write-lock.js');
const { validateFull } = await import('../attribution-record.js');

const rows = (from: number, to: number) =>
  Array.from({ length: to - from + 1 }, (_, i) => `Row ${from + i}`).join('\n') + '\n';

/** A source note as the OR-45 writer leaves it: legacy payload + record, line-level when `files` is given. */
function sourceNote(sha: string, session: string, files: Array<{ path: string; ranges: Array<{ start_line: number; end_line: number }> }> | null) {
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
      session: { id: session },
      ...(files ? { files } : {}),
    }],
  };
  expect(validateFull(record).ok).toBe(true);
  return JSON.stringify({ origin: { version: 1, sessionId: session, agent: 'codex', model: 'gpt-5.3-codex' }, attribution_record: record });
}

describe('a rewrite projects outside the note lock and writes only what it read', () => {
  let repo: string;
  let base: string;
  const git = (...args: string[]): string => execFileSync('git', args, { cwd: repo, encoding: 'utf-8', stdio: 'pipe' }).trim();
  const write = (rel: string, content: string) => fs.writeFileSync(path.join(repo, rel), content);
  const commit = (msg: string): string => { git('add', '-A'); git('commit', '-q', '--allow-empty', '-m', msg); return git('rev-parse', 'HEAD'); };
  const annotate = (sha: string, session: string, files: Parameters<typeof sourceNote>[2] = null) =>
    git('notes', '--ref=origin', 'add', '-f', '-m', sourceNote(sha, session, files), sha);
  const readNote = (sha: string): string | null => {
    try { return git('notes', '--ref=origin', 'show', sha); } catch { return null; }
  };
  const sessionsOn = (sha: string) => JSON.parse(readNote(sha)!).attribution_record.contributions.map((c: any) => c.session.id).sort();
  /** The agent's commit S adds rows 3-6 and claims them; T is S reworded (an amend). */
  const agentAmend = () => {
    write('a.ts', rows(1, 6));
    const s = commit('agent adds rows 3-6');
    annotate(s, 'session-agent', [{ path: 'a.ts', ranges: [{ start_line: 3, end_line: 6 }] }]);
    git('commit', '-q', '--amend', '-m', 'reworded');
    return { s, t: git('rev-parse', 'HEAD') };
  };
  const rewrite = (pairs: Array<[string, string]>, lock?: Record<string, unknown>) =>
    preserveAttributionBatch(repo, pairs.map(([oldSha, newSha]) => ({ oldSha, newSha })), lock ? { lock } : {});

  beforeEach(() => {
    probe.calls.length = 0;
    probe.during = null;
    probe.deadline = undefined;
    repo = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'origin-or46-lockflow-')));
    execFileSync('git', ['init', '-q', '-b', 'main', repo], { stdio: 'pipe' });
    git('config', 'user.email', 'dev@example.com');
    git('config', 'user.name', 'Dev');
    git('config', 'commit.gpgsign', 'false');
    write('a.ts', rows(1, 2));
    base = commit('base');
  });
  afterEach(() => { try { fs.rmSync(repo, { recursive: true, force: true }); } catch { /* ignore */ } });

  it('another writer takes the note lock without waiting while the projection runs', () => {
    const { s, t } = agentAmend();
    const seen: Array<string | null> = [];
    probe.during = () => { seen.push(withNoteWriteLock(repo, () => 'free', { waitMs: 0 })); };
    expect(rewrite([[s, t]])).toMatchObject({ written: 1, failed: 0 });
    expect(seen).toEqual(['free']);
    expect(JSON.parse(readNote(t)!).attribution_record).toMatchObject({ attribution_level: 'line' });
  });

  it('a source note changed during the projection: the stale note is never written, the retry builds from the new one', () => {
    const { s, t } = agentAmend();
    probe.during = (n) => { if (n === 1) annotate(s, 'session-late', [{ path: 'a.ts', ranges: [{ start_line: 3, end_line: 6 }] }]); };
    expect(rewrite([[s, t]])).toMatchObject({ written: 1, failed: 0 });
    expect(probe.calls).toHaveLength(2);
    expect(JSON.parse(probe.calls[1].sources[0].note).origin.sessionId).toBe('session-late');
    expect(sessionsOn(t)).toEqual(['session-late']);
  });

  it('a target note written during the projection is extended, never overwritten', () => {
    const { s, t } = agentAmend();
    probe.during = (n) => { if (n === 1) annotate(t, 'session-own'); };
    expect(rewrite([[s, t]])).toMatchObject({ written: 1, failed: 0 });
    expect(probe.calls).toHaveLength(2);
    expect(sessionsOn(t)).toEqual(['session-agent', 'session-own']);
  });

  it('a note no rebuild reads changes: no retry, one projection, both notes kept', () => {
    const { s, t } = agentAmend();
    probe.during = () => annotate(base, 'session-unrelated');
    expect(rewrite([[s, t]])).toMatchObject({ written: 1, failed: 0 });
    expect(probe.calls).toHaveLength(1);
    expect(sessionsOn(t)).toEqual(['session-agent']);
    expect(sessionsOn(base)).toEqual(['session-unrelated']);
  });

  it('the old commits an earlier rewrite recorded join before the one projection', () => {
    const { s, t } = agentAmend();
    expect(rewrite([[s, t]]).written).toBe(1);
    git('checkout', '-q', '--detach', base);
    write('b.ts', 'other\n');
    const o = commit('another old commit');
    annotate(o, 'session-other');
    probe.calls.length = 0;
    expect(rewrite([[o, t]])).toMatchObject({ written: 1, failed: 0 });
    expect(probe.calls).toHaveLength(1);
    expect(probe.calls[0].sources.map((x) => x.sha).sort()).toEqual([o, s].sort());
    expect(sessionsOn(t)).toEqual(['session-agent', 'session-other']);
  });

  it('a lease that cannot cover the write leaves the target untouched: the lease-loss failure', () => {
    const { s, t } = agentAmend();
    const r = rewrite([[s, t]], { leaseMs: 5_000, attempts: 2 });
    expect(r).toMatchObject({ written: 0, failed: 1 });
    expect(r.warnings).toEqual([expect.objectContaining({
      code: 'note-lock-unavailable', detail: 'the note lock\'s lease ran out before the write; 2 attempt(s), nothing written',
    })]);
    expect(probe.calls).toHaveLength(2);
    expect(readNote(t)).toBeNull();
  });

  it('notes that change on every attempt: bounded attempts, nothing written, a reported failure', () => {
    const { s, t } = agentAmend();
    probe.during = (n) => annotate(s, `session-churn-${n}`);
    const r = rewrite([[s, t]], { attempts: 3 });
    expect(r).toMatchObject({ written: 0, failed: 1 });
    expect(r.warnings).toEqual([expect.objectContaining({
      code: 'note-lock-unavailable', detail: 'the old commits\' or the target\'s notes kept changing; 3 attempt(s), nothing written',
    })]);
    expect(probe.calls).toHaveLength(3);
    expect(readNote(t)).toBeNull();
  });

  it('a projection out of budget stays commit-level with one warning, and a stale attempt adds none', () => {
    const { s, t } = agentAmend();
    probe.deadline = { at: 0, now: () => 1 };
    probe.during = (n) => { if (n === 1) annotate(s, 'session-late', [{ path: 'a.ts', ranges: [{ start_line: 3, end_line: 6 }] }]); };
    const r = rewrite([[s, t]]);
    expect(r).toMatchObject({ written: 1, failed: 0 });
    expect(probe.calls).toHaveLength(2);
    expect(r.warnings.filter((w) => w.code === 'rewrite-lines-not-carried')).toEqual([expect.objectContaining({
      detail: 'line projection: timeout; the rewrite stays commit-level',
    })]);
    expect(JSON.parse(readNote(t)!).attribution_record).toMatchObject({ attribution_level: 'commit' });
    expect(sessionsOn(t)).toEqual(['session-late']);
  });

  it('a rebase of 12 commits: a session writer gets the lock at once during every projection', () => {
    const pairs: Array<[string, string]> = [];
    for (let i = 0; i < 12; i++) {
      git('checkout', '-q', '--detach', base);
      write(`f${i}.ts`, rows(1, 2));
      const s = commit(`agent adds f${i}`);
      annotate(s, `session-${i}`, [{ path: `f${i}.ts`, ranges: [{ start_line: 1, end_line: 2 }] }]);
      git('commit', '-q', '--amend', '-m', `reworded f${i}`);
      pairs.push([s, git('rev-parse', 'HEAD')]);
    }
    // The competing writer: a real note write on a commit no rewrite reads, under the shared lock.
    const acquired: number[] = [];
    probe.during = (n) => {
      const got = withNoteWriteLock(repo, () => { annotate(base, `session-writer-${n}`); return n; }, { waitMs: 0 });
      if (got !== null) acquired.push(got);
    };
    const r = rewrite(pairs);
    expect(r).toMatchObject({ targets: 12, written: 12, failed: 0 });
    expect(probe.calls).toHaveLength(12);
    expect(acquired).toEqual(Array.from({ length: 12 }, (_, i) => i + 1));
    expect(sessionsOn(base)).toEqual(['session-writer-12']);
    pairs.forEach(([, t], i) => expect(sessionsOn(t)).toEqual([`session-${i}`]));
  });
});
