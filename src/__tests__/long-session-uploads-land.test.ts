/**
 * Session 874ff028 froze on the dashboard at turn 8 of 11. Every Stop update
 * from 16:23Z on was 4.5–4.7MB: a turn's editsJson carried whole files for each
 * commit-sourced edit (1.16MB on turn 0), and every Stop re-sent all turns.
 * The hook sent it with its 8s fast-fail, it aborted and was queued; the next
 * hook replayed the queued copy with the same 8s, which aborted again and
 * blocked everything after it for that session. The server would also have
 * thrown away any editsJson past 500,000 characters had one landed.
 *
 * These pin the three halves of the fix: an over-limit editsJson is fitted to
 * what the server accepts; a queued update too large for a hook is deferred
 * to the background drain, which replays it with a timeout sized to it; and a
 * newer Stop snapshot replaces an older queued one instead of queueing behind it.
 */
import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest';
import fs from 'fs';
import path from 'path';

const { TEST_HOME } = vi.hoisted(() => {
  const base = process.env.TMPDIR || '/tmp';
  return { TEST_HOME: `${base.replace(/\/$/, '')}/origin-long-uploads-${process.pid}` };
});

vi.mock('os', async (orig) => {
  const actual = (await orig()) as typeof import('os');
  const homedir = () => TEST_HOME;
  return { ...actual, default: { ...actual, homedir }, homedir };
});

const updateSession = vi.hoisted(() => vi.fn());
const endSession = vi.hoisted(() => vi.fn());
vi.mock('../api.js', () => ({ api: { updateSession, endSession, ingestCommits: vi.fn() } }));
const spawn = vi.hoisted(() => vi.fn(() => ({ unref: () => {} })));
vi.mock('child_process', async (orig) => {
  const actual = (await orig()) as typeof import('child_process');
  return { ...actual, default: { ...actual, spawn }, spawn };
});

import { drainUpdateQueue, durableEndSession, durableUpdateSession, enqueueFailedUpdate, HOOK_REPLAY_MAX_BYTES } from '../update-queue.js';
import { SERVER_EDITS_JSON_MAX_CHARS, fitEditsJsonForServer, fitSessionUpdateForServer } from '../session-update-size.js';
import { timeoutForPayload } from '../fetch-timeout.js';

const QUEUE_DIR = path.join(TEST_HOME, '.origin', 'queue');
const entries = () => (fs.existsSync(QUEUE_DIR) ? fs.readdirSync(QUEUE_DIR).filter((f) => f.endsWith('.json')).sort() : [])
  .map((name) => ({ name, ...JSON.parse(fs.readFileSync(path.join(QUEUE_DIR, name), 'utf-8')) }));
const netErr = () => new Error('This operation was aborted');
const tick = () => new Promise((r) => setTimeout(r, 5));

beforeEach(() => {
  fs.rmSync(TEST_HOME, { recursive: true, force: true });
  updateSession.mockReset();
  endSession.mockReset();
  spawn.mockClear();
});
afterAll(() => fs.rmSync(TEST_HOME, { recursive: true, force: true }));

const bigFile = 'x'.repeat(300_000) + '\n';
const capture = (extraToolBytes = 0) => ({
  promptIndex: 0,
  promptText: 'do it',
  agent: 'claude',
  edits: [
    { file: 'a.ts', op: 'edit', oldContent: 'one', newContent: 'two' + 'y'.repeat(extraToolBytes), source: 'tool_call' },
    { file: 'hooks.ts', op: 'edit', oldContent: bigFile, newContent: bigFile + 'z\n', source: 'commit', commitSha: 'a'.repeat(40) },
  ],
  commits: ['a'.repeat(40)],
});

describe('fitEditsJsonForServer', () => {
  it('leaves an editsJson the server accepts byte-for-byte', () => {
    const raw = JSON.stringify({ edits: [{ file: 'a.ts', op: 'edit', oldContent: 'x', newContent: 'y', source: 'commit' }] });
    expect(fitEditsJsonForServer(raw)).toBe(raw);
  });

  it('sheds only the commit-sourced edits\' contents, keeping every edit and its commit', () => {
    const raw = JSON.stringify(capture());
    expect(raw.length).toBeGreaterThan(SERVER_EDITS_JSON_MAX_CHARS);
    const fitted = JSON.parse(fitEditsJsonForServer(raw)!);
    expect(fitted.edits).toHaveLength(2);
    expect(fitted.edits[0]).toEqual(capture().edits[0]);
    expect(fitted.edits[1]).toEqual({ file: 'hooks.ts', op: 'edit', source: 'commit', commitSha: 'a'.repeat(40), contentOmitted: true });
    expect(fitted.commits).toEqual(['a'.repeat(40)]);
  });

  it('omits a capture still over the limit — the server would discard it anyway', () => {
    expect(fitEditsJsonForServer(JSON.stringify(capture(SERVER_EDITS_JSON_MAX_CHARS)))).toBeUndefined();
  });

  it('fits every row of a session update and drops only an unfittable editsJson', () => {
    const data = {
      prompt: 'p',
      promptChanges: [
        { promptIndex: 0, diff: 'd0', editsJson: JSON.stringify(capture()) },
        { promptIndex: 1, diff: 'd1', editsJson: JSON.stringify(capture(SERVER_EDITS_JSON_MAX_CHARS)) },
        { promptIndex: 2, diff: 'd2', editsJson: '{"edits":[]}' },
      ],
    };
    const fits: any[] = [];
    const out = fitSessionUpdateForServer(data, (f) => fits.push(f));
    expect(out.promptChanges[0].editsJson.length).toBeLessThanOrEqual(SERVER_EDITS_JSON_MAX_CHARS);
    expect(out.promptChanges[1]).toEqual({ promptIndex: 1, diff: 'd1' });
    expect(out.promptChanges[2]).toBe(data.promptChanges[2]);
    expect(fits.map((f) => [f.promptIndex, f.after === null])).toEqual([[0, false], [1, true]]);
    expect(fitSessionUpdateForServer({ promptChanges: [data.promptChanges[2]] })).toEqual({ promptChanges: [data.promptChanges[2]] });
  });

  it('a queued update is stored fitted', () => {
    enqueueFailedUpdate('updateSession', 's', { promptChanges: [{ promptIndex: 0, editsJson: JSON.stringify(capture()) }] }, netErr());
    const [entry] = entries();
    expect(entry.payload.promptChanges[0].editsJson.length).toBeLessThanOrEqual(SERVER_EDITS_JSON_MAX_CHARS);
  });
});

describe('a queued update too large for a hook', () => {
  const large = { transcript: 't'.repeat(HOOK_REPLAY_MAX_BYTES + 1) };

  it('is deferred by a hook drain, holding back that session\'s later updates but not other sessions', async () => {
    updateSession.mockResolvedValue({});
    enqueueFailedUpdate('updateSession', 'big', large, netErr());
    await tick();
    enqueueFailedUpdate('updateSession', 'big', { tag: 'after' }, netErr());
    await tick();
    enqueueFailedUpdate('updateSession', 'other', { tag: 'other' }, netErr());
    const res = await drainUpdateQueue();
    expect(res).toMatchObject({ replayed: 1, deferred: 1, remaining: 2 });
    expect(updateSession).toHaveBeenCalledTimes(1);
    expect(updateSession.mock.calls[0][0]).toBe('other');
    expect(entries().map((e) => e.attempts)).toEqual([0, 0]);
  });

  it('is replayed by the background drain with a timeout sized to it, then the rest in order', async () => {
    updateSession.mockResolvedValue({});
    enqueueFailedUpdate('updateSession', 'big', large, netErr());
    await tick();
    enqueueFailedUpdate('updateSession', 'big', { tag: 'after' }, netErr());
    const bytes = fs.statSync(path.join(QUEUE_DIR, entries()[0].name)).size;
    const res = await drainUpdateQueue(undefined, { background: true });
    expect(res).toMatchObject({ replayed: 2, deferred: 0, remaining: 0 });
    expect(updateSession.mock.calls[0][2]).toEqual({ timeoutMs: timeoutForPayload(bytes) });
    expect(updateSession.mock.calls[0][2].timeoutMs).toBeGreaterThan(8000);
    expect(updateSession.mock.calls[1][1]).toEqual({ tag: 'after' });
  });

  // Sent past a deferred older update, a fresh one landed FIRST and the older
  // one then landed on top of it: a queued Stop snapshot replaced the session
  // diff a later session end or post-commit had stored.
  it('a fresh update of that session queues behind it instead of landing first', async () => {
    updateSession.mockResolvedValue({});
    enqueueFailedUpdate('updateSession', 'big', { ...large, tag: 'older-stop' }, netErr(), undefined, { snapshot: true });
    await tick();
    expect(await durableUpdateSession('big', { tag: 'post-commit' })).toBeNull();
    expect(updateSession).not.toHaveBeenCalled();
    expect(spawn).toHaveBeenCalledTimes(1);
    await drainUpdateQueue(undefined, { background: true });
    expect(updateSession.mock.calls.map((c) => c[1].tag)).toEqual(['older-stop', 'post-commit']);
  });

  it('so does a session end', async () => {
    updateSession.mockResolvedValue({});
    endSession.mockResolvedValue({});
    enqueueFailedUpdate('updateSession', 'big', { ...large, tag: 'older-stop' }, netErr(), undefined, { snapshot: true });
    await tick();
    expect(await durableEndSession('big', { sessionId: 'big' })).toBeNull();
    expect(endSession).not.toHaveBeenCalled();
    expect(entries().map((e) => e.kind)).toEqual(['updateSession', 'endSession']);
  });

  it('a newer Stop snapshot still goes straight out: it replaces the deferred snapshot', async () => {
    updateSession.mockResolvedValue({});
    enqueueFailedUpdate('updateSession', 'big', { ...large, tag: 'older-stop' }, netErr(), undefined, { snapshot: true });
    await tick();
    await durableUpdateSession('big', { tag: 'new-stop' }, undefined, { snapshot: true });
    expect(updateSession.mock.calls.map((c) => c[1].tag)).toEqual(['new-stop']);
    expect(entries()).toHaveLength(0);
  });
});

describe('Stop snapshots', () => {
  it('a newer snapshot that lands removes the older queued one instead of replaying it first', async () => {
    enqueueFailedUpdate('updateSession', 's', { tag: 'old-stop' }, netErr(), undefined, { snapshot: true });
    await tick();
    enqueueFailedUpdate('updateSession', 's', { tag: 'commit' }, netErr());
    updateSession.mockResolvedValue({});
    await tick();
    await durableUpdateSession('s', { tag: 'new-stop' }, undefined, { snapshot: true });
    expect(updateSession.mock.calls.map((c) => c[1].tag)).toEqual(['commit', 'new-stop']);
    expect(entries()).toHaveLength(0);
  });

  it('a newer snapshot that fails replaces the older queued one, keeping partial updates', async () => {
    enqueueFailedUpdate('updateSession', 's', { tag: 'old-stop' }, netErr(), undefined, { snapshot: true });
    await tick();
    enqueueFailedUpdate('updateSession', 's', { tag: 'commit' }, netErr());
    await tick();
    updateSession.mockImplementation(async (_id: string, data: any) => {
      if (data.tag === 'new-stop') throw netErr();
      return {};
    });
    await durableUpdateSession('s', { tag: 'new-stop' }, undefined, { snapshot: true });
    expect(entries().map((e) => [e.payload.tag, e.snapshot === true])).toEqual([['new-stop', true]]);
  });

  it('a snapshot queued while this one was sending is kept', async () => {
    updateSession.mockImplementation(async () => {
      await tick();
      enqueueFailedUpdate('updateSession', 's', { tag: 'newer-stop' }, netErr(), undefined, { snapshot: true });
      return {};
    });
    await durableUpdateSession('s', { tag: 'stop' }, undefined, { snapshot: true });
    expect(entries().map((e) => e.payload.tag)).toEqual(['newer-stop']);
  });

  it('non-snapshot sends never drop queued snapshots', async () => {
    enqueueFailedUpdate('updateSession', 's', { tag: 'old-stop' }, netErr(), undefined, { snapshot: true });
    updateSession.mockResolvedValue({});
    await tick();
    await durableUpdateSession('s', { tag: 'commit' });
    expect(updateSession.mock.calls.map((c) => c[1].tag)).toEqual(['old-stop', 'commit']);
  });
});
