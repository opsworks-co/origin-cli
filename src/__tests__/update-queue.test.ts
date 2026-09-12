// Durable retry queue — the fix for silently-lost capture uploads. A failed
// stop/session-end PATCH must be persisted and replayed, in per-session
// order, never after newer data, and never retried when the failure is
// permanent (4xx).
import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';

const { TEST_HOME } = vi.hoisted(() => {
  const base = process.env.TMPDIR || '/tmp';
  return { TEST_HOME: `${base.replace(/\/$/, '')}/origin-updq-${process.pid}` };
});

vi.mock('os', async (orig) => {
  const actual = (await orig()) as typeof import('os');
  const homedir = () => TEST_HOME;
  return { ...actual, default: { ...actual, homedir }, homedir };
});

const updateSession = vi.hoisted(() => vi.fn());
const endSession = vi.hoisted(() => vi.fn());
const ingestCommits = vi.hoisted(() => vi.fn());
vi.mock('../api.js', () => ({ api: { updateSession, endSession, ingestCommits } }));

import {
  durableUpdateSession,
  durableEndSession,
  drainUpdateQueue,
  enqueueFailedUpdate,
  persistUpdateBeforeWork,
  removeQueuedUpdate,
  isRetriableApiError,
} from '../update-queue.js';

const QUEUE_DIR = path.join(TEST_HOME, '.origin', 'queue');
const entryFiles = () =>
  fs.existsSync(QUEUE_DIR) ? fs.readdirSync(QUEUE_DIR).filter((f) => f.endsWith('.json')) : [];

const netErr = () => new Error('fetch failed'); // no .status → retriable
const httpErr = (status: number) => Object.assign(new Error(`http ${status}`), { status });

beforeEach(() => {
  fs.rmSync(TEST_HOME, { recursive: true, force: true });
  updateSession.mockReset();
  endSession.mockReset();
  ingestCommits.mockReset();
});
afterAll(() => fs.rmSync(TEST_HOME, { recursive: true, force: true }));

describe('isRetriableApiError', () => {
  it('classifies network / 5xx / 408 / 429 as retriable, other 4xx as permanent', () => {
    expect(isRetriableApiError(netErr())).toBe(true);
    expect(isRetriableApiError(httpErr(500))).toBe(true);
    expect(isRetriableApiError(httpErr(503))).toBe(true);
    expect(isRetriableApiError(httpErr(408))).toBe(true);
    expect(isRetriableApiError(httpErr(429))).toBe(true);
    expect(isRetriableApiError(httpErr(400))).toBe(false);
    expect(isRetriableApiError(httpErr(401))).toBe(false);
    expect(isRetriableApiError(httpErr(404))).toBe(false);
  });
});

describe('durableUpdateSession', () => {
  it('passes through on success (no queue file)', async () => {
    updateSession.mockResolvedValueOnce({ ok: true });
    const res = await durableUpdateSession('sess-1', { a: 1 });
    expect(res).toEqual({ ok: true });
    expect(entryFiles()).toHaveLength(0);
  });

  it('queues the payload and returns null on a retriable failure', async () => {
    updateSession.mockRejectedValueOnce(netErr());
    const res = await durableUpdateSession('sess-1', { transcript: 'valuable' });
    expect(res).toBeNull();
    expect(entryFiles()).toHaveLength(1);
  });

  it('rethrows permanent failures without queueing', async () => {
    updateSession.mockRejectedValueOnce(httpErr(401));
    await expect(durableUpdateSession('sess-1', { a: 1 })).rejects.toThrow('http 401');
    expect(entryFiles()).toHaveLength(0);
  });

  it('drains the SAME session backlog before sending fresh state (ordering)', async () => {
    const calls: string[] = [];
    updateSession.mockImplementation(async (_id: string, data: any) => {
      calls.push(data.tag);
      return {};
    });
    enqueueFailedUpdate('updateSession', 'sess-1', { tag: 'old' }, netErr());
    await durableUpdateSession('sess-1', { tag: 'new' });
    expect(calls).toEqual(['old', 'new']);
    expect(entryFiles()).toHaveLength(0);
  });
});

describe('drainUpdateQueue', () => {
  it('replays oldest-first and clears the queue', async () => {
    const seen: string[] = [];
    updateSession.mockImplementation(async (_id: string, data: any) => { seen.push(data.tag); return {}; });
    enqueueFailedUpdate('updateSession', 's1', { tag: 'first' }, netErr());
    await new Promise((r) => setTimeout(r, 5)); // distinct timestamp prefix
    enqueueFailedUpdate('updateSession', 's1', { tag: 'second' }, netErr());
    const res = await drainUpdateQueue();
    expect(seen).toEqual(['first', 'second']);
    expect(res.replayed).toBe(2);
    expect(entryFiles()).toHaveLength(0);
  });

  it('a retriable failure blocks LATER entries of the same session but not other sessions', async () => {
    updateSession.mockImplementation(async (id: string) => {
      if (id === 'bad') throw netErr();
      return {};
    });
    enqueueFailedUpdate('updateSession', 'bad', { tag: 'b1' }, netErr());
    await new Promise((r) => setTimeout(r, 5));
    enqueueFailedUpdate('updateSession', 'bad', { tag: 'b2' }, netErr());
    await new Promise((r) => setTimeout(r, 5));
    enqueueFailedUpdate('updateSession', 'good', { tag: 'g1' }, netErr());
    const res = await drainUpdateQueue();
    expect(res.replayed).toBe(1);   // good/g1
    expect(res.remaining).toBe(2);  // bad/b1 blocked, bad/b2 skipped in order
    expect(entryFiles()).toHaveLength(2);
  });

  it('drops entries on permanent failure', async () => {
    updateSession.mockRejectedValue(httpErr(404)); // session gone
    enqueueFailedUpdate('updateSession', 's1', { tag: 'x' }, netErr());
    const res = await drainUpdateQueue();
    expect(res.dropped).toBe(1);
    expect(entryFiles()).toHaveLength(0);
  });

  it('routes endSession entries to api.endSession', async () => {
    endSession.mockResolvedValueOnce({});
    enqueueFailedUpdate('endSession', 's1', { sessionId: 's1', summary: 'done' }, netErr());
    const res = await drainUpdateQueue();
    expect(res.replayed).toBe(1);
    expect(endSession).toHaveBeenCalledWith({ sessionId: 's1', summary: 'done' });
  });

  it('durableEndSession queues on retriable failure', async () => {
    endSession.mockRejectedValueOnce(httpErr(503));
    const res = await durableEndSession('s1', { sessionId: 's1' });
    expect(res).toBeNull();
    expect(entryFiles()).toHaveLength(1);
  });

  // The post-commit shadow ingest is the ONLY producer of Commit.patch and of
  // per-commit additions/deletions. When it fails, the read side degrades in
  // two visible ways — commit-detail falls back to the session aggregate, and
  // the turn header's "committed" chip vanishes — so the payload has to
  // survive the failure rather than being logged and dropped.
  it('routes ingestCommits entries to api.ingestCommits with a generous timeout', async () => {
    ingestCommits.mockResolvedValueOnce({ ingested: 1 });
    const payload = { repoPath: '/repo', commits: [{ sha: 'abc123', diff: 'diff --git a/x b/x' }] };
    enqueueFailedUpdate('ingestCommits', 'commit:abc123', payload, netErr());
    const res = await drainUpdateQueue();
    expect(res.replayed).toBe(1);
    expect(ingestCommits).toHaveBeenCalledWith(payload, { timeoutMs: 60_000 });
    expect(entryFiles()).toHaveLength(0);
  });

  it('keys ingest entries per sha, so one stuck commit cannot block another', async () => {
    ingestCommits.mockRejectedValueOnce(httpErr(503)).mockResolvedValueOnce({ ingested: 1 });
    enqueueFailedUpdate('ingestCommits', 'commit:aaa', { commits: [{ sha: 'aaa' }] }, netErr());
    enqueueFailedUpdate('ingestCommits', 'commit:bbb', { commits: [{ sha: 'bbb' }] }, netErr());
    const res = await drainUpdateQueue();
    expect(res.replayed).toBe(1);
    expect(res.remaining).toBe(1);
  });

  it('drops corrupt entry files instead of wedging the queue', async () => {
    fs.mkdirSync(QUEUE_DIR, { recursive: true });
    fs.writeFileSync(path.join(QUEUE_DIR, '1-1-corrupt.json'), '{not json');
    updateSession.mockResolvedValue({});
    enqueueFailedUpdate('updateSession', 's1', { tag: 'ok' }, netErr());
    const res = await drainUpdateQueue();
    expect(res.dropped).toBe(1);
    expect(res.replayed).toBe(1);
    expect(entryFiles()).toHaveLength(0);
  });
});

describe('persistUpdateBeforeWork', () => {
  it('writes the payload to the queue without waiting for a failed fetch, and names the entry', () => {
    const name = persistUpdateBeforeWork('sess-kill', { prompt: 'where is prompt 3?' });
    expect(typeof name).toBe('string');
    expect(entryFiles()).toEqual([name]);
    expect(updateSession).not.toHaveBeenCalled();
  });

  it('never carries status — a late replay of RUNNING would reopen an ended session', () => {
    persistUpdateBeforeWork('sess-kill', { prompt: 'p', status: 'RUNNING' });
    const entry = JSON.parse(fs.readFileSync(path.join(QUEUE_DIR, entryFiles()[0]), 'utf-8'));
    expect(entry.payload).toEqual({ prompt: 'p' });
  });

  it('a later drain delivers the pre-persisted PATCH when the hook died', async () => {
    persistUpdateBeforeWork('sess-kill', { prompt: 'prompt 3' });
    updateSession.mockResolvedValueOnce({});
    const res = await drainUpdateQueue();
    expect(res.replayed).toBe(1);
    expect(updateSession).toHaveBeenCalledWith('sess-kill', { prompt: 'prompt 3' });
    expect(entryFiles()).toHaveLength(0);
  });

  it('the real send supersedes it: sent once, with the fresh payload, and the entry is gone', async () => {
    // The hook finished normally. Without `supersedes` the in-process drain
    // replayed the stale copy first (two PATCHes per prompt), and when the
    // drain lock was held the copy outlived the send and replayed later over
    // newer state — a shorter prompt list overwriting a longer one.
    const name = persistUpdateBeforeWork('sess-ok', { prompt: 'p1' });
    updateSession.mockResolvedValueOnce({ ok: true });
    await durableUpdateSession('sess-ok', { prompt: 'p1\n\n---\n\np2', tokensUsed: 5 }, undefined, { supersedes: name });
    expect(updateSession).toHaveBeenCalledTimes(1);
    expect(updateSession).toHaveBeenCalledWith('sess-ok', { prompt: 'p1\n\n---\n\np2', tokensUsed: 5 });
    expect(entryFiles()).toHaveLength(0);
  });

  it('a retriable failure of the superseding send still leaves the FULL payload queued', async () => {
    const name = persistUpdateBeforeWork('sess-down', { prompt: 'p1' });
    updateSession.mockRejectedValueOnce(netErr());
    await durableUpdateSession('sess-down', { prompt: 'p1', tokensUsed: 5 }, undefined, { supersedes: name });
    expect(entryFiles()).toHaveLength(1);
    const entry = JSON.parse(fs.readFileSync(path.join(QUEUE_DIR, entryFiles()[0]), 'utf-8'));
    expect(entry.payload).toEqual({ prompt: 'p1', tokensUsed: 5 });
  });

  it('removeQueuedUpdate drops exactly the named entry', () => {
    const a = persistUpdateBeforeWork('s', { prompt: 'a' });
    const b = persistUpdateBeforeWork('s', { prompt: 'b' });
    removeQueuedUpdate(a);
    expect(entryFiles()).toEqual([b]);
    removeQueuedUpdate('does-not-exist.json');
    removeQueuedUpdate(null);
    expect(entryFiles()).toEqual([b]);
  });
});
