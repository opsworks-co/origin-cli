// OR-11/A5, review №1 P1-1: two writers, one note.
//
// A rewritten commit can get a note from two backgrounded hooks at once: the
// rewrite (post-rewrite, or the cherry-pick carry) and the commit's own
// session writer (post-commit → writeGitNotes; Stop and SessionEnd later).
// Whichever finishes last used to replace the other's note wholesale. Both now
// read → merge → write under one lock, and the session writer keeps what the
// rewrite carried — so both contributions survive in either order, and in a
// real race between two processes.
import { describe, it, expect, beforeEach, afterEach, beforeAll, afterAll, vi } from 'vitest';
import { execFileSync, spawn, spawnSync } from 'child_process';
import fs from 'fs';
import http from 'http';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';
import { holdIdleConnections } from './helpers/fake-api-keepalive.js';
import { gitAsync } from './helpers/git-async.js';

vi.mock('../api.js', () => ({ api: { importGitNote: vi.fn(() => Promise.resolve({ ok: true })) } }));

const { writeGitNotes } = await import('../git-notes.js');
const { preserveAttributionOnRewrite } = await import('../history-preservation.js');
const { readRecord } = await import('../attribution-record.js');
const { mergeSessionNoteOverRewrite, REWRITE_NOTE_KEY, REWRITE_NOTE_SCHEMA } = await import('../history-rewrite.js');
const { getLineBlame, getSessionContextForCommit, isAiCommit } = await import('../attribution.js');
const {
  withNoteWriteLock, observeNoteLock, claimNoteLock, releaseNoteLock, newLockOwner, noteLease, processStartToken,
  NOTE_LOCK_NAME, NOTE_LOCK_LEASE_MS, NOTE_LOCK_GRACE_MS,
} = await import('../note-write-lock.js');
const { api } = await import('../api.js');
const importGitNote = api.importGitNote as unknown as ReturnType<typeof vi.fn>;
const { preserveAttributionBatch } = await import('../history-preservation.js');

const cliRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const DIST = path.join(cliRoot, 'dist');
const BIN = process.env.ORIGIN_E2E_BIN || path.join(DIST, 'index.js');
const isWindows = process.platform === 'win32';
const REF = (id: string) => `https://origin.example.com/sessions/${id}`;

let repo: string;
const git = (...args: string[]): string => execFileSync('git', args, { cwd: repo, encoding: 'utf-8', stdio: 'pipe' }).trim();
function commit(name: string): string {
  fs.writeFileSync(path.join(repo, name), `${name} ${Math.random()}\n`);
  git('add', '.');
  git('commit', '-q', '-m', `add ${name}`);
  return git('rev-parse', 'HEAD');
}
const readNote = (sha: string): any => { try { return JSON.parse(git('notes', '--ref=origin', 'show', sha)); } catch { return null; } };
const sessionsOn = (sha: string): string[] => (readNote(sha)?.attribution_record?.contributions ?? []).map((c: any) => c.session?.id).sort();

/** A source note of session `id` on `sha`, legacy + v1, as the OR-9 writer leaves it. */
function annotate(sha: string, id: string, agent: string, model: string) {
  const note = {
    origin: { version: 1, sessionId: id, agent, model, promptCount: 1, originUrl: REF(id) },
    attribution_record: {
      schema_version: '1.0', revision: { vcs: 'git', id: sha }, attribution_level: 'commit',
      recorded_at: '2026-09-01T00:00:00Z', producer: { name: 'origin-cli', version: '0.1.0' },
      contributions: [{ evidence: 'session_capture', agent: { id: agent }, model: { id: model }, session: { id, reference_uri: REF(id) } }],
    },
  };
  git('notes', '--ref=origin', 'add', '-f', '-m', JSON.stringify(note), sha);
}

/** What post-commit hands writeGitNotes for session `id`. */
const sessionData = (id: string, agent = 'claude-code') => ({
  sessionId: id, model: 'claude-opus-5-5', agentSlug: agent, promptCount: 2, promptSummary: 'x',
  originUrl: REF(id), linesAdded: 1, linesRemoved: 0, attribution: { sessionId: id, agentId: agent, modelId: 'claude-opus-5-5' },
});

beforeEach(() => {
  repo = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'origin-or11-writers-')));
  execFileSync('git', ['init', '-q', '-b', 'main', repo], { stdio: 'pipe' });
  git('config', 'user.email', 'dev@example.com');
  git('config', 'user.name', 'Dev');
  git('config', 'commit.gpgsign', 'false');
});
afterEach(() => { try { fs.rmSync(repo, { recursive: true, force: true }); } catch { /* ignore */ } });

describe('rewrite and session writer on one commit, in either order', () => {
  it('rewrite first, then the session snapshot: both contributions, the session\'s legacy, the bookkeeping kept', () => {
    const a = commit('a.txt');
    annotate(a, 'sess-b', 'codex', 'gpt-5');
    const t = commit('t.txt');
    preserveAttributionOnRewrite(repo, a, t);
    writeGitNotes(repo, [t], sessionData('sess-s') as any);
    const n = readNote(t);
    expect(sessionsOn(t)).toEqual(['sess-b', 'sess-s']);
    expect(readRecord(n.attribution_record).status).toBe('exact');
    expect(n.attribution_record.revision.id).toBe(t);
    expect(n.origin.sessionId).toBe('sess-s');
    expect(n[REWRITE_NOTE_KEY]).toEqual({ schema: REWRITE_NOTE_SCHEMA, target: t, sources: [a], base: 'note' });
    // Stop writes the same commit again: still both.
    writeGitNotes(repo, [t], sessionData('sess-s') as any);
    expect(sessionsOn(t)).toEqual(['sess-b', 'sess-s']);
  });

  it('session snapshot first, then the rewrite: both contributions, and the same note shape', () => {
    const a = commit('a.txt');
    annotate(a, 'sess-b', 'codex', 'gpt-5');
    const t = commit('t.txt');
    writeGitNotes(repo, [t], sessionData('sess-s') as any);
    preserveAttributionOnRewrite(repo, a, t);
    const n = readNote(t);
    expect(sessionsOn(t)).toEqual(['sess-b', 'sess-s']);
    expect(n.origin.sessionId).toBe('sess-s');
    expect(n[REWRITE_NOTE_KEY]).toEqual({ schema: REWRITE_NOTE_SCHEMA, target: t, sources: [a], base: 'note' });
    // A repeat of the pair changes nothing.
    const before = git('notes', '--ref=origin', 'show', t);
    preserveAttributionOnRewrite(repo, a, t);
    expect(git('notes', '--ref=origin', 'show', t)).toBe(before);
  });

  it('without rewrite bookkeeping the session writer behaves as before: its snapshot replaces the note', () => {
    const payload = JSON.stringify({ origin: { sessionId: 'sess-s' } });
    const foreign = JSON.stringify({ origin: { sessionId: 'sess-x' }, rewrite_sources: ['a'.repeat(40)] });
    const opts = { recordedAt: new Date(), producerVersion: '1' };
    expect(mergeSessionNoteOverRewrite(null, payload, 'e'.repeat(40), opts)).toBe(payload);
    expect(mergeSessionNoteOverRewrite(foreign, payload, 'e'.repeat(40), opts)).toBe(payload);
  });
});

// ─── The lock: owned, never bypassed, never stolen (review №2 P1-1, №3 P2) ───

describe('the note-write lock', () => {
  const lockDir = () => path.join(repo, '.git', NOTE_LOCK_NAME);
  const owner = (pid: number, token: string) => ({ pid, host: os.hostname(), token, at: new Date().toISOString() });
  /** Put the next epoch file in place as if `o` had claimed it; returns the epoch. */
  const seed = (o: ReturnType<typeof owner> & { start?: string }, epoch = observeNoteLock(lockDir()).epoch + 1) => {
    fs.mkdirSync(lockDir(), { recursive: true });
    fs.writeFileSync(path.join(lockDir(), `e${epoch}`), JSON.stringify(o));
    return epoch;
  };
  const deadPid = (): number => spawnSync(process.execPath, ['-e', '0']).pid!;
  afterEach(() => {
    delete process.env.ORIGIN_NOTE_LOCK_WAIT_MS;
    try { fs.rmSync(lockDir(), { recursive: true, force: true }); } catch { /* none */ }
  });

  it('a live holder past the wait: nothing written, nothing mirrored, the rewrite note untouched', () => {
    const a = commit('a.txt');
    annotate(a, 'sess-b', 'codex', 'gpt-5');
    const t = commit('t.txt');
    preserveAttributionOnRewrite(repo, a, t);
    const before = git('notes', '--ref=origin', 'show', t);
    const held = seed(owner(process.pid, 'another-writer'));
    process.env.ORIGIN_NOTE_LOCK_WAIT_MS = '150';
    importGitNote.mockClear();
    writeGitNotes(repo, [t], sessionData('sess-s') as any);
    expect(git('notes', '--ref=origin', 'show', t)).toBe(before);
    expect(importGitNote).not.toHaveBeenCalled();
    expect(observeNoteLock(lockDir())).toMatchObject({ epoch: held, state: 'held', owner: { token: 'another-writer' } });
    // The rewrite path likewise: failed, not written.
    const c = commit('c.txt');
    annotate(c, 'sess-c', 'cursor', 'gpt-5');
    expect(preserveAttributionBatch(repo, [{ oldSha: c, newSha: t }], { lock: { waitMs: 150, attempts: 1 } }).failed).toBe(1);
    expect(git('notes', '--ref=origin', 'show', t)).toBe(before);
  });

  it('a dead owner\'s lock is recovered — by a new epoch, not by deleting it', () => {
    commit('a.txt');
    seed(owner(deadPid(), 'crashed'));
    expect(withNoteWriteLock(repo, () => observeNoteLock(lockDir()), { waitMs: 2000 })).toMatchObject({ epoch: 2, state: 'held' });
    expect(observeNoteLock(lockDir())).toMatchObject({ epoch: 2, state: 'free' });
  });

  it('a live holder inside its lease keeps its lock, whatever the file\'s age', () => {
    commit('a.txt');
    seed({ ...owner(process.pid, 'slow-but-alive'), start: 'me' });
    const hoursAgo = new Date(Date.now() - 2 * 60 * 60_000);
    fs.utimesSync(path.join(lockDir(), 'e1'), hoursAgo, hoursAgo);
    expect(withNoteWriteLock(repo, () => 42, { waitMs: 150, processStart: () => 'me' })).toBeNull();
    expect(observeNoteLock(lockDir(), undefined, { processStart: () => 'me' })).toMatchObject({ epoch: 1, state: 'held', owner: { token: 'slow-but-alive' } });
  });

  it('a holder\'s release never touches a newer owner\'s lock', () => {
    commit('a.txt');
    withNoteWriteLock(repo, () => {
      const mine = observeNoteLock(lockDir()).epoch;
      seed(owner(process.pid, 'the-next-owner'), mine + 1);
      return 1;
    }, { waitMs: 500 });
    expect(observeNoteLock(lockDir())).toMatchObject({ state: 'held', owner: { token: 'the-next-owner' } });
  });

  it('three contenders around a dead owner, every interleaving step by step: one holder at a time, a live owner is never robbed', () => {
    commit('a.txt');
    const dir = lockDir();
    const alive = new Set([1001, 1002, 1003]);
    const isAlive = (pid: number) => alive.has(pid);
    const [A, B, C] = [owner(1001, 'A'), owner(1002, 'B'), owner(1003, 'C')];
    seed(owner(999_999, 'dead'));
    const holders = new Set<string>();
    const hold = (who: { token: string }, epoch: number | null) => {
      if (epoch === null) return;
      holders.add(who.token);
      expect(holders.size, `${[...holders]} hold at once`).toBe(1);
    };

    // A and B both see the dead owner of e1.
    const viewA = observeNoteLock(dir, isAlive);
    const viewB = observeNoteLock(dir, isAlive);
    expect(viewA).toMatchObject({ epoch: 1, state: 'dead' });
    // B replaces it with its live lock first.
    const eB = claimNoteLock(dir, viewB, B);
    expect(eB).toBe(2);
    hold(B, eB);
    // C tries to acquire during the recovery: B is alive, C must wait.
    const viewC = observeNoteLock(dir, isAlive);
    expect(viewC).toMatchObject({ epoch: 2, state: 'held', owner: { token: 'B' } });
    expect(claimNoteLock(dir, viewC, C)).toBeNull();
    // A finally acts on its stale view of the dead owner: it cannot touch B's lock.
    expect(claimNoteLock(dir, viewA, A)).toBeNull();
    expect(observeNoteLock(dir, isAlive)).toMatchObject({ epoch: 2, state: 'held', owner: { token: 'B' } });

    // B releases; C takes it; B's and the dead owner's files are left or pruned, never reused.
    releaseNoteLock(dir, 2, B);
    holders.delete('B');
    const eC = claimNoteLock(dir, observeNoteLock(dir, isAlive), C);
    expect(eC).toBe(3);
    hold(C, eC);
    // A retries on its long-stale view (epoch 1, dead): e2 still exists, the claim fails.
    expect(claimNoteLock(dir, viewA, A)).toBeNull();
    releaseNoteLock(dir, 3, C);
    holders.delete('C');
    const eB2 = claimNoteLock(dir, observeNoteLock(dir, isAlive), B);
    expect(eB2).toBe(4);
    hold(B, eB2);
    // e2 has been pruned by now; A's stale claim creates e2, sees e4, and backs off.
    expect(fs.existsSync(path.join(dir, 'e2'))).toBe(false);
    expect(claimNoteLock(dir, viewA, A)).toBeNull();
    expect(fs.existsSync(path.join(dir, 'e2'))).toBe(false);
    expect(observeNoteLock(dir, isAlive)).toMatchObject({ epoch: 4, state: 'held', owner: { token: 'B' } });
  });

  it.skipIf(isWindows || !fs.existsSync(path.join(DIST, 'note-write-lock.js')))('once a live holder releases, the waiting writer merges: both contributions', async () => {
    const a = commit('a.txt');
    annotate(a, 'sess-b', 'codex', 'gpt-5');
    const t = commit('t.txt');
    preserveAttributionOnRewrite(repo, a, t);
    const script = `import { withNoteWriteLock } from ${JSON.stringify('file://' + path.join(DIST, 'note-write-lock.js'))};
withNoteWriteLock(${JSON.stringify(repo)}, () => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 1500), { waitMs: 5000 });`;
    const holder = spawn(process.execPath, ['--input-type=module', '-e', script], { cwd: repo, stdio: 'ignore' });
    const deadline = Date.now() + 10_000;
    while (observeNoteLock(lockDir()).state !== 'held' && Date.now() < deadline) await new Promise((r) => setTimeout(r, 20));
    expect(observeNoteLock(lockDir()).state).toBe('held');
    process.env.ORIGIN_NOTE_LOCK_WAIT_MS = '10000';
    writeGitNotes(repo, [t], sessionData('sess-s') as any);
    await new Promise<void>((r) => holder.on('close', () => r()));
    expect(sessionsOn(t)).toEqual(['sess-b', 'sess-s']);
    expect(observeNoteLock(lockDir()).state).toBe('free');
  }, 60_000);
});

// ─── The lock is never permanent (external review, blocker 1) ──────────────

describe('note-write lock liveness: pid reuse, leases, bounded waits', () => {
  const lockDir = () => path.join(repo, '.git', NOTE_LOCK_NAME);
  const seed = (o: Record<string, unknown>, epoch = 1) => {
    fs.mkdirSync(lockDir(), { recursive: true });
    fs.writeFileSync(path.join(lockDir(), `e${epoch}`), JSON.stringify(o));
  };
  /** A clock that only moves when the lock waits. */
  const fakeClock = (start = Date.now()) => {
    const c = { t: start, now: () => c.t, sleep: (ms: number) => { c.t += ms; } };
    return c;
  };
  afterEach(() => { try { fs.rmSync(lockDir(), { recursive: true, force: true }); } catch { /* none */ } });

  it('an owner whose pid now names another process (start token differs) is recovered, and the note written', () => {
    const a = commit('a.txt');
    annotate(a, 'sess-b', 'codex', 'gpt-5');
    const t = commit('t.txt');
    // The hook that claimed e1 was killed; its pid is running something else now.
    seed({ pid: process.pid, host: os.hostname(), token: 'killed-hook', at: new Date().toISOString(), start: 'the-killed-hook', leaseMs: NOTE_LOCK_LEASE_MS });
    const r = preserveAttributionBatch(repo, [{ oldSha: a, newSha: t }], { lock: { waitMs: 200, attempts: 1, processStart: () => 'an-unrelated-process' } });
    expect(r).toMatchObject({ written: 1, failed: 0 });
    expect(sessionsOn(t)).toEqual(['sess-b']);
    expect(observeNoteLock(lockDir())).toMatchObject({ epoch: 2, state: 'free' });
  });

  it.skipIf(isWindows)('the reviewer\'s case: a stale e1 of pid 1, read with the real process probe, does not block writers', () => {
    const t = commit('t.txt');
    expect(processStartToken(process.pid)).toBeTruthy();
    seed({ pid: 1, host: os.hostname(), token: 'stale', at: new Date().toISOString(), start: 'not-pid-1s-start' });
    const started = Date.now();
    writeGitNotes(repo, [t], sessionData('sess-s') as any, { lockWaitMs: 2_000 });
    expect(Date.now() - started).toBeLessThan(2_000);
    expect(sessionsOn(t)).toEqual(['sess-s']);
  });

  it('an owner nothing can be proven about (another host, no start token, unreadable) is released by its lease', () => {
    commit('a.txt');
    for (const stale of [
      { pid: 4242, host: 'another-host', token: 'foreign', at: new Date().toISOString() },
      { pid: process.pid, host: os.hostname(), token: 'no-start-token', at: new Date().toISOString() },
      'not json at all',
    ]) {
      seed(typeof stale === 'string' ? {} : stale);
      if (typeof stale === 'string') fs.writeFileSync(path.join(lockDir(), 'e1'), stale);
      const clock = fakeClock();
      // Inside the lease: waited for.
      expect(withNoteWriteLock(repo, () => 'x', { waitMs: 1_000, pollMs: 100, now: clock.now, sleep: clock.sleep })).toBeNull();
      // Past lease + grace: claimed, without a real two-minute wait.
      const later = fakeClock(Date.now());
      const got = withNoteWriteLock(repo, (lease) => lease.epoch, {
        waitMs: NOTE_LOCK_LEASE_MS + NOTE_LOCK_GRACE_MS + 10_000, pollMs: 1_000, now: later.now, sleep: later.sleep,
      });
      expect(got).toBe(2);
      expect(later.t - Date.now()).toBeLessThanOrEqual(NOTE_LOCK_LEASE_MS + NOTE_LOCK_GRACE_MS + 2_000);
      fs.rmSync(lockDir(), { recursive: true, force: true });
    }
  });

  it('a live owner with its own start token inside the lease is never displaced', () => {
    commit('a.txt');
    seed({ pid: process.pid, host: os.hostname(), token: 'live', at: new Date().toISOString(), start: 'live-start', leaseMs: NOTE_LOCK_LEASE_MS });
    const clock = fakeClock();
    const got = withNoteWriteLock(repo, () => 'robbed', {
      waitMs: NOTE_LOCK_LEASE_MS - 10_000, pollMs: 1_000, now: clock.now, sleep: clock.sleep, processStart: () => 'live-start',
    });
    expect(got).toBeNull();
    expect(observeNoteLock(lockDir(), undefined, { processStart: () => 'live-start' })).toMatchObject({ epoch: 1, state: 'held', owner: { token: 'live' } });
  });

  it('a holder whose lease ran out can neither write over the next epoch nor release it', () => {
    const a = commit('a.txt');
    annotate(a, 'sess-b', 'codex', 'gpt-5');
    const t = commit('t.txt');
    const clock = fakeClock();
    let next: ReturnType<typeof newLockOwner> | null = null;
    const r = withNoteWriteLock(repo, (lease) => {
      expect(lease.holds(10_000)).toBe(true);
      // The holder stalls past its lease; a contender takes the lock over.
      clock.t += NOTE_LOCK_LEASE_MS + NOTE_LOCK_GRACE_MS + 1;
      const view = observeNoteLock(lockDir(), () => true, { now: clock.now, processStart: () => null });
      expect(view.state).toBe('expired');
      next = { ...newLockOwner({ now: clock.now }), token: 'next-owner' };
      expect(claimNoteLock(lockDir(), view, next)).toBe(lease.epoch + 1);
      // The stalled holder must not write now, even with a tiny budget.
      expect(lease.holds(0)).toBe(false);
      return 'returned';
    }, { now: clock.now, sleep: clock.sleep });
    expect(r).toBe('returned');
    // Its release in `finally` did not touch the next owner's epoch.
    expect(observeNoteLock(lockDir(), () => true, { now: clock.now, processStart: () => null })).toMatchObject({ epoch: 2, state: 'held', owner: { token: 'next-owner' } });
    // And a lease whose write budget would outlast it refuses too.
    const late = noteLease(lockDir(), 2, next!, () => clock.t + NOTE_LOCK_LEASE_MS - 5_000);
    expect(late.holds(10_000)).toBe(false);
    expect(late.holds(1_000)).toBe(true);
    expect(readNote(t)).toBeNull();
  });

  it('Stop/SessionEnd over several commits wait one short budget in total, not one per commit', () => {
    const shas = [commit('a.txt'), commit('b.txt'), commit('c.txt')];
    seed({ pid: process.pid, host: os.hostname(), token: 'busy', at: new Date().toISOString(), leaseMs: NOTE_LOCK_LEASE_MS });
    importGitNote.mockClear();
    const started = Date.now();
    writeGitNotes(repo, shas, sessionData('sess-s') as any, { lockWaitMs: 400 });
    const took = Date.now() - started;
    expect(took).toBeGreaterThanOrEqual(400);
    // Three commits × 400 ms would be 1.2 s.
    expect(took).toBeLessThan(1_100);
    for (const s of shas) expect(readNote(s)).toBeNull();
    expect(importGitNote).not.toHaveBeenCalled();
  });

  it('a rewrite that meets a busy lock retries: the holder leaves after the first attempt, the note is written once', () => {
    const a = commit('a.txt');
    annotate(a, 'sess-b', 'codex', 'gpt-5');
    const t = commit('t.txt');
    seed({ pid: process.pid, host: os.hostname(), token: 'busy', at: new Date().toISOString(), leaseMs: NOTE_LOCK_LEASE_MS });
    const clock = fakeClock();
    let released = false;
    const sleep = (ms: number) => {
      clock.sleep(ms);
      // The first attempt (300 ms) has given up: the holder finishes.
      if (!released && clock.t - start > 300) {
        fs.writeFileSync(path.join(lockDir(), 'e1.done'), 'busy');
        released = true;
      }
    };
    const start = clock.t;
    const r = preserveAttributionBatch(repo, [{ oldSha: a, newSha: t }], { lock: { waitMs: 300, pollMs: 50, attempts: 3, now: clock.now, sleep } });
    expect(released).toBe(true);
    expect(r).toMatchObject({ targets: 1, written: 1, failed: 0 });
    expect(sessionsOn(t)).toEqual(['sess-b']);
    // One write: the note carries one rebuild, and a repeat changes nothing.
    const once = git('notes', '--ref=origin', 'show', t);
    expect(preserveAttributionBatch(repo, [{ oldSha: a, newSha: t }]).unchanged).toBe(1);
    expect(git('notes', '--ref=origin', 'show', t)).toBe(once);
  });

  it('a lock that stays busy through every attempt is a reported failure, never a success', () => {
    const a = commit('a.txt');
    annotate(a, 'sess-b', 'codex', 'gpt-5');
    const t = commit('t.txt');
    seed({ pid: process.pid, host: os.hostname(), token: 'busy', at: new Date().toISOString(), leaseMs: NOTE_LOCK_LEASE_MS });
    const clock = fakeClock();
    const r = preserveAttributionBatch(repo, [{ oldSha: a, newSha: t }], { lock: { waitMs: 200, pollMs: 50, attempts: 2, now: clock.now, sleep: clock.sleep } });
    expect(r).toMatchObject({ targets: 1, written: 0, failed: 1 });
    expect(r.warnings).toEqual([expect.objectContaining({ code: 'note-lock-unavailable', detail: expect.stringMatching(/2 attempt/) })]);
    expect(readNote(t)).toBeNull();
  });
});

// ─── The API mirror: only what was written (review №3 P1-1) ─────────────────

describe('the note mirrored to the API is the note that was written', () => {
  it('a merge under the lock mirrors the final envelope with both contributions', () => {
    const a = commit('a.txt');
    annotate(a, 'sess-b', 'codex', 'gpt-5');
    const t = commit('t.txt');
    preserveAttributionOnRewrite(repo, a, t);
    importGitNote.mockClear();
    writeGitNotes(repo, [t], sessionData('sess-s') as any);
    expect(importGitNote).toHaveBeenCalledTimes(1);
    const [sessionId, sha, mirrored] = importGitNote.mock.calls[0];
    expect([sessionId, sha]).toEqual(['sess-s', t]);
    expect(mirrored).toEqual(readNote(t));
    expect((mirrored as any).attribution_record.contributions.map((c: any) => c.session.id).sort()).toEqual(['sess-b', 'sess-s']);
  });

  it('a failed `git notes add` mirrors nothing', () => {
    commit('a.txt');
    importGitNote.mockClear();
    // Not a commit here: `git notes add` cannot resolve it and fails.
    writeGitNotes(repo, ['no-such-commit'], sessionData('sess-s') as any);
    expect(importGitNote).not.toHaveBeenCalled();
  });
});

describe('a rewrite repeated after an old commit lost its note', () => {
  it('keeps the carried contribution of the old commit whose note is gone', () => {
    const a = commit('a.txt');
    annotate(a, 'sess-a', 'claude-code', 'claude-opus-4-6');
    const b = commit('b.txt');
    annotate(b, 'sess-b', 'codex', 'gpt-5');
    const t = commit('t.txt');
    preserveAttributionBatch(repo, [{ oldSha: a, newSha: t }, { oldSha: b, newSha: t }]);
    expect(sessionsOn(t)).toEqual(['sess-a', 'sess-b']);
    git('notes', '--ref=origin', 'remove', a);
    preserveAttributionBatch(repo, [{ oldSha: a, newSha: t }, { oldSha: b, newSha: t }]);
    expect(sessionsOn(t)).toEqual(['sess-a', 'sess-b']);
    expect(readNote(t).origin).toMatchObject({ commitsSquashed: 2, sessionIds: ['sess-a', 'sess-b'] });
  });
});

// ─── Two real processes ─────────────────────────────────────────────────────

describe.skipIf(isWindows || !fs.existsSync(BIN))('two hook processes racing for one note', () => {
  let home: string;
  let env: NodeJS.ProcessEnv;
  beforeEach(() => {
    home = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'origin-or11-race-home-'));
    fs.mkdirSync(path.join(home, '.origin'), { recursive: true });
    // Nothing listens on port 9: the note mirror to the API fails at once.
    fs.writeFileSync(path.join(home, '.origin', 'config.json'), JSON.stringify({ apiUrl: 'http://127.0.0.1:9', apiKey: 'k' }));
    const base: NodeJS.ProcessEnv = {};
    for (const [k, v] of Object.entries(process.env)) if (!k.startsWith('ORIGIN_')) base[k] = v;
    env = { ...base, HOME: home, USERPROFILE: home };
  });
  afterEach(() => { try { fs.rmSync(home, { recursive: true, force: true }); } catch { /* ignore */ } });

  const writer = (sha: string) => {
    const script = `import { writeGitNotes } from ${JSON.stringify('file://' + path.join(DIST, 'git-notes.js'))};
writeGitNotes(${JSON.stringify(repo)}, [${JSON.stringify(sha)}], ${JSON.stringify(sessionData('sess-s'))});
setTimeout(() => process.exit(0), 50);`;
    return spawn(process.execPath, ['--input-type=module', '-e', script], { cwd: repo, env, stdio: 'ignore' });
  };
  const rewrite = (from: string, to: string) => {
    const child = spawn(process.execPath, [BIN, 'hooks', 'git-post-rewrite', 'amend'], { cwd: repo, env, stdio: ['pipe', 'ignore', 'ignore'] });
    child.stdin!.end(`${from} ${to}\n`);
    return child;
  };
  const done = (c: ReturnType<typeof spawn>) => new Promise<void>((r) => c.on('close', () => r()));

  for (const first of ['writer', 'rewrite'] as const) {
    it(`${first} started first: no lost update, three rounds`, async () => {
      for (let round = 0; round < 3; round++) {
        const a = commit(`a${round}.txt`);
        annotate(a, 'sess-b', 'codex', 'gpt-5');
        const t = commit(`t${round}.txt`);
        const kids = first === 'writer' ? [writer(t), rewrite(a, t)] : [rewrite(a, t), writer(t)];
        await Promise.all(kids.map(done));
        expect(sessionsOn(t), `round ${round}`).toEqual(['sess-b', 'sess-s']);
        expect(readNote(t)[REWRITE_NOTE_KEY]?.base, `round ${round}`).toBe('note');
      }
    }, 120_000);
  }
});

// ─── Legacy readers and a multi-session squash ──────────────────────────────

describe('legacy readers of a squash aggregate', () => {
  it('several sessions: an AI commit with no single owner', () => {
    const t = commit('squashed.txt');
    git('notes', '--ref=origin', 'add', '-m', JSON.stringify({
      origin: { version: 1, squashMerge: true, commitsSquashed: 3, sessionIds: ['sess-a', 'sess-b'], models: ['gpt-5', 'claude-opus-4-6'] },
    }), t);
    expect(isAiCommit(repo, t)).toBe(true);
    expect(getSessionContextForCommit(repo, t)).toBeNull();
    const lines = getLineBlame(repo, 'squashed.txt');
    expect(lines.length).toBeGreaterThan(0);
    for (const l of lines) {
      expect(l.authorship).toBe('ai');
      expect(l.sessionId).toBeUndefined();
      expect(l.agent).toBeUndefined();
      expect(l.model).toBeUndefined();
    }
  });

  it('one session: the singular fields keep working', () => {
    const t = commit('squashed.txt');
    git('notes', '--ref=origin', 'add', '-m', JSON.stringify({
      origin: { version: 1, squashMerge: true, commitsSquashed: 2, sessionId: 'sess-a', agent: 'codex', model: 'gpt-5', sessionIds: ['sess-a'], models: ['gpt-5'] },
    }), t);
    expect(isAiCommit(repo, t)).toBe(true);
    expect(getSessionContextForCommit(repo, t)).toMatchObject({ sessionId: 'sess-a', agent: 'codex', model: 'gpt-5' });
    expect(getLineBlame(repo, 'squashed.txt')[0]).toMatchObject({ authorship: 'ai', sessionId: 'sess-a', agent: 'codex' });
  });

  it('an aggregate that names no session is not an AI claim', () => {
    const t = commit('empty.txt');
    git('notes', '--ref=origin', 'add', '-m', JSON.stringify({ origin: { version: 1, squashMerge: true, sessionIds: [] } }), t);
    expect(isAiCommit(repo, t)).toBe(false);
  });
});

// ─── An active session, through the hooks Origin installs ───────────────────

const SERVER_ID = 'e2e-or11-session-0001';

describe.skipIf(isWindows || !fs.existsSync(BIN))('active session: amend and rebase squash through real hooks', () => {
  let server: http.Server;
  let apiUrl = '';
  let tmp = '';
  let home = '';
  let hooks = '';
  let env: NodeJS.ProcessEnv;
  let transcript = '';

  beforeAll(async () => {
    await new Promise<void>((resolve) => {
      server = http.createServer((req, res) => {
        req.on('data', () => { /* drain */ });
        req.on('end', () => {
          res.setHeader('content-type', 'application/json');
          const u = req.url || '';
          if (req.method === 'POST' && u.startsWith('/api/mcp/session/start')) res.end(JSON.stringify({ sessionId: SERVER_ID, verboseCapture: false }));
          else if (u.startsWith('/api/pricing')) res.end(JSON.stringify({ models: {} }));
          else res.end(JSON.stringify({ ok: true }));
        });
      });
      holdIdleConnections(server);
      server.listen(0, '127.0.0.1', () => { apiUrl = `http://127.0.0.1:${(server.address() as { port: number }).port}`; resolve(); });
    });
  });
  afterAll(async () => { await new Promise<void>((r) => server.close(() => r())); });

  beforeEach(async () => {
    tmp = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'origin-or11-active-')));
    home = path.join(tmp, 'home');
    hooks = path.join(tmp, 'hooks');
    repo = path.join(tmp, 'repo');
    for (const d of [path.join(home, '.origin'), hooks, repo, path.join(tmp, 'bin')]) fs.mkdirSync(d, { recursive: true });
    fs.writeFileSync(path.join(home, '.origin', 'config.json'), JSON.stringify({ apiUrl, apiKey: 'org_sk_e2e_test_key', orgId: 'org-e2e', keyType: 'team', accountType: 'developer' }));
    fs.writeFileSync(path.join(home, '.origin', 'agent.json'), JSON.stringify({ machineId: 'machine-e2e', hostname: 'e2e', detectedTools: ['claude'], orgId: 'org-e2e' }));
    // This machine's own agent processes must not answer post-commit's pgrep fallback.
    fs.writeFileSync(path.join(tmp, 'bin', 'pgrep'), '#!/bin/sh\nexit 1\n', { mode: 0o755 });
    const wrapper = path.join(tmp, 'origin-bin');
    fs.writeFileSync(wrapper, `#!/bin/sh\nexec "${process.execPath}" "${BIN}" "$@"\n`, { mode: 0o755 });
    const { writeGlobalPostCommitHook, writeGlobalPostRewriteHook, writeGlobalPrepareCommitMsgHook } = await import('../commands/enable.js');
    writeGlobalPrepareCommitMsgHook(hooks);
    writeGlobalPostCommitHook(hooks);
    writeGlobalPostRewriteHook(hooks);
    for (const h of ['prepare-commit-msg', 'post-commit', 'post-rewrite']) {
      const p = path.join(hooks, h);
      const src = fs.readFileSync(p, 'utf-8');
      const s = src.indexOf('ORIGIN_BIN=""');
      const e = src.indexOf('\nfi\n', s);
      fs.writeFileSync(p, src.slice(0, s) + `ORIGIN_BIN="${wrapper}"` + src.slice(e + '\nfi'.length), { mode: 0o755 });
    }
    const base: NodeJS.ProcessEnv = {};
    for (const [k, v] of Object.entries(process.env)) if (!k.startsWith('ORIGIN_') && !k.startsWith('GIT_')) base[k] = v;
    env = {
      ...base, PATH: `${path.join(tmp, 'bin')}${path.delimiter}${base.PATH || ''}`, HOME: home, USERPROFILE: home,
      GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null',
      GIT_AUTHOR_NAME: 'E2E', GIT_AUTHOR_EMAIL: 'e2e@example.com', GIT_COMMITTER_NAME: 'E2E', GIT_COMMITTER_EMAIL: 'e2e@example.com',
    };
    execFileSync('git', ['init', '-q', '-b', 'main', repo], { env });
    hgit('config', 'core.hooksPath', hooks);
    transcript = path.join(tmp, 'transcript.jsonl');
    fs.writeFileSync(transcript, '');
    const earlier = new Date(Date.now() - 60 * 60_000).toISOString();
    fs.writeFileSync(path.join(repo, 'base.txt'), 'base\n');
    hgit('add', '.');
    execFileSync('git', ['-c', 'core.hooksPath=/dev/null', 'commit', '-q', '-m', 'base'], { cwd: repo, env: { ...env, GIT_AUTHOR_DATE: earlier, GIT_COMMITTER_DATE: earlier } });
  });
  afterEach(() => { try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* ignore */ } });

  function hgit(...args: string[]): string {
    return execFileSync('git', args, { cwd: repo, env, encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  }
  // Async, like gitAsync: a spawnSync here froze the fake API the hook calls.
  async function hook(event: string, payload: Record<string, unknown>) {
    const child = spawn(process.execPath, [BIN, 'hooks', 'claude-code', event], { cwd: repo, env, stdio: ['pipe', 'ignore', 'pipe'] });
    let stderr = '';
    child.stderr.on('data', (c) => { stderr += c; });
    child.stdin.end(JSON.stringify({ session_id: 'e2e-or11-claude', transcript_path: transcript, cwd: repo, hook_event_name: event, ...payload }));
    const status = await new Promise<number | null>((resolve) => child.on('close', resolve));
    expect(status, stderr).toBe(0);
  }
  async function startSession() {
    await hook('session-start', { source: 'startup' });
    fs.writeFileSync(transcript, JSON.stringify({ type: 'user', timestamp: new Date().toISOString(), message: { role: 'user', content: [{ type: 'text', text: 'rework it' }] } }) + '\n');
    await hook('user-prompt-submit', { prompt: 'rework it' });
    await new Promise((r) => setTimeout(r, 1100));
  }
  const batches = () => {
    const log = path.join(home, '.origin', 'hooks.log');
    return fs.existsSync(log) ? fs.readFileSync(log, 'utf-8').split('\n').filter((l) => l.includes('rewrite batch:')).length : 0;
  };
  async function until(what: string, ok: () => boolean, ms = 60_000) {
    const deadline = Date.now() + ms;
    while (Date.now() < deadline) {
      if (ok()) return;
      await new Promise((r) => setTimeout(r, 200));
    }
    throw new Error(`timed out waiting for ${what}\n${diagnostics()}`);
  }
  function diagnostics(): string {
    const log = path.join(home, '.origin', 'hooks.log');
    const tail = fs.existsSync(log) ? fs.readFileSync(log, 'utf-8').split('\n').filter((l) => /git-notes|post-commit|rewrite|stop|session-end/.test(l)).slice(-40).join('\n') : '(no hooks.log)';
    return `hooks.log:\n${tail}`;
  }
  const hnote = (sha: string): any => { try { return JSON.parse(hgit('notes', '--ref=origin', 'show', sha)); } catch { return null; } };
  const hsessions = (sha: string) => (hnote(sha)?.attribution_record?.contributions ?? []).map((c: any) => c.session?.id).sort();

  it('an amend in a live session keeps the session\'s own claim AND the carried one', async () => {
    fs.writeFileSync(path.join(repo, 'a.txt'), 'by another session\n');
    hgit('add', '.');
    // Earlier work of another session: made without this checkout's hooks, so a
    // late background post-commit cannot claim it for the live session.
    hgit('-c', 'core.hooksPath=/dev/null', 'commit', '-q', '-m', 'earlier work');
    const a = hgit('rev-parse', 'HEAD');
    annotate(a, 'sess-b', 'codex', 'gpt-5');
    await startSession();
    const before = batches();
    fs.writeFileSync(path.join(repo, 'a.txt'), 'by another session\nand this one\n');
    hgit('add', '.');
    await gitAsync(repo, ['commit', '-q', '--amend', '--no-edit'], { env });
    const t = hgit('rev-parse', 'HEAD');
    await until('the rewrite hook', () => batches() > before);
    // The live session's own note (its id: the server's, or local-* until registered) and the carried one.
    await until('both contributions', () => hsessions(t).length === 2 && hsessions(t).includes('sess-b') && hnote(t)?.origin?.sessionId !== 'sess-b');
    // Both background hooks are done by now; nothing later takes a claim away.
    await new Promise((r) => setTimeout(r, 4000));
    const n = hnote(t);
    const live = n.origin.sessionId;
    expect(live === SERVER_ID || String(live).startsWith('local-'), diagnostics()).toBe(true);
    expect(hsessions(t)).toEqual([live, 'sess-b'].sort());
    expect(readRecord(n.attribution_record).status).toBe('exact');
    expect(n.attribution_record.revision.id).toBe(t);
    expect(n[REWRITE_NOTE_KEY]).toMatchObject({ target: t, sources: [a], base: 'note' });
  }, 180_000);

  it('a rebase squash in a live session ends with the full record of both squashed sessions', async () => {
    const shas: string[] = [];
    for (const [i, id, agent, model] of [[1, 'sess-1', 'cursor', 'gpt-5'], [2, 'sess-2', 'codex', 'gpt-5']] as const) {
      fs.writeFileSync(path.join(repo, `c${i}.txt`), `${i}\n`);
      hgit('add', '.');
      hgit('-c', 'core.hooksPath=/dev/null', 'commit', '-q', '-m', `c${i}`);
      const sha = hgit('rev-parse', 'HEAD');
      annotate(sha, id, agent, model);
      shas.push(sha);
    }
    await startSession();
    const before = batches();
    const editor = path.join(tmp, 'seq.sh');
    fs.writeFileSync(editor, '#!/bin/sh\nsed -i.bak -e "2s/^pick/squash/" "$1"\n', { mode: 0o755 });
    await gitAsync(repo, ['rebase', '-q', '-i', 'HEAD~2'], { env: { ...env, GIT_SEQUENCE_EDITOR: editor, GIT_EDITOR: 'true' } });
    const s = hgit('rev-parse', 'HEAD');
    await until('both rewrite hooks', () => batches() >= before + 2);
    await new Promise((r) => setTimeout(r, 4000));
    const n = hnote(s);
    expect(hsessions(s), diagnostics()).toEqual(['sess-1', 'sess-2']);
    expect(readRecord(n.attribution_record).status).toBe('exact');
    expect(n.attribution_record.revision.id).toBe(s);
    expect(n.origin).toMatchObject({ squashMerge: true, commitsSquashed: 2, sessionIds: ['sess-1', 'sess-2'] });
    expect(n[REWRITE_NOTE_KEY]).toMatchObject({ target: s, sources: [...shas].sort(), base: 'none' });
  }, 180_000);
});
