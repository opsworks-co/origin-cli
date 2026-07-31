// Unit tests for the hook-independent Codex rollout watcher (codex-watch.ts).
// Hermetic: temp dirs for rollout files + watch state, a mock api client, and
// injected git/repo deps — no real network, no real git, no real ~/.codex.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import {
  listActiveRollouts,
  reconcileThread,
  runWatchCycle,
  loadThreadState,
  saveThreadState,
  anotherWatcherRunning,
  watcherSuperseded,
  restartCodexWatch,
  codexWatchAutoStartEnabled,
  ACTIVE_WINDOW_MS,
  type WatchDeps,
  type ThreadWatchState,
  type ScannedRollout,
} from '../codex-watch.js';
import { parseCodexRolloutLive, isCodexInternalSubroutine } from '../agents/codex.js';

let tmp = '';
let sessionsDir = '';
let stateDir = '';

function writeRollout(threadId: string, cwd: string, opts: {
  prompts?: string[];
  model?: string;
  toolCalls?: number;
  dateParts?: [string, string, string];
  ageMs?: number;
} = {}): string {
  const [y, m, d] = opts.dateParts || ['2026', '07', '24'];
  const dir = path.join(sessionsDir, y, m, d);
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `rollout-${y}-${m}-${d}T10-00-00-${threadId}.jsonl`);
  const lines: string[] = [];
  lines.push(JSON.stringify({
    timestamp: `${y}-${m}-${d}T10:00:05.000Z`,
    type: 'session_meta',
    payload: { id: threadId, timestamp: `${y}-${m}-${d}T10:00:00.000Z`, cwd, originator: 'codex_cli_rs' },
  }));
  for (const p of opts.prompts || []) {
    lines.push(JSON.stringify({
      timestamp: `${y}-${m}-${d}T10:00:10.000Z`,
      payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: p }] },
    }));
  }
  if (opts.model) {
    lines.push(JSON.stringify({ payload: { type: 'message', role: 'assistant', content: [{ text: 'ok' }] }, model: opts.model }));
  }
  for (let i = 0; i < (opts.toolCalls || 0); i++) {
    lines.push(JSON.stringify({ payload: { type: 'function_call', name: 'exec', input: 'ls', call_id: `c${i}` } }));
  }
  fs.writeFileSync(file, lines.join('\n') + '\n');
  if (opts.ageMs) {
    const t = (Date.now() - opts.ageMs) / 1000;
    fs.utimesSync(file, t, t);
  }
  return file;
}

// A mock api that records calls and hands out incrementing session ids.
function mockApi() {
  const calls = { start: [] as any[], update: [] as any[] };
  let n = 0;
  return {
    calls,
    startSession: vi.fn(async (data: any) => { calls.start.push(data); return { sessionId: `sess-${++n}` }; }),
    updateSession: vi.fn(async (id: string, data: any) => { calls.update.push({ id, data }); return {}; }),
  };
}

function baseDeps(api: ReturnType<typeof mockApi>, over: Partial<WatchDeps> = {}): WatchDeps {
  return {
    now: () => Date.now(),
    idleMs: 20 * 60 * 1000,
    machineId: 'machine-1',
    hostname: 'host-1',
    stateDir,
    api,
    // Real parser reads the temp rollout file — exercises the actual pipeline.
    parseRollout: (p: string) => parseCodexRolloutLive(p),
    isInternalSubroutine: isCodexInternalSubroutine,
    resolveRepo: (cwd: string) => ({ repoPath: cwd, workRoot: cwd, repoUrl: 'git@github.com:org/repo.git', branch: 'main' }),
    createShadow: () => 'a'.repeat(40),
    getHead: () => 'b'.repeat(40),
    captureDiff: () => ({ diff: 'diff --git a/x b/x\n+line\n', filesChanged: ['x'], linesAdded: 1, linesRemoved: 0 }),
    // Default: session made no commits (so gitCapture is omitted). Individual
    // tests override this to simulate committed work.
    captureGit: () => ({
      headBefore: 'b'.repeat(40), headAfter: 'b'.repeat(40),
      commitShas: [], commitDetails: [], diff: '', diffTruncated: false, linesAdded: 0, linesRemoved: 0,
    }),
    loadState: (threadId: string) => loadThreadState(threadId, stateDir),
    saveState: (s: ThreadWatchState) => saveThreadState(s, stateDir),
    ...over,
  };
}

function scan(file: string, threadId: string, cwd: string): ScannedRollout {
  return { rolloutPath: file, threadId, cwd, mtimeMs: fs.statSync(file).mtimeMs };
}

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'origin-codexwatch-'));
  sessionsDir = path.join(tmp, 'sessions');
  stateDir = path.join(tmp, 'state');
  fs.mkdirSync(sessionsDir, { recursive: true });
  fs.mkdirSync(stateDir, { recursive: true });
});
afterEach(() => { try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* ignore */ } });

describe('listActiveRollouts', () => {
  it('finds recent rollouts and resolves their cwd + threadId', () => {
    const tid = '019f8754-1acd-70f1-bb8e-882eb975b596';
    writeRollout(tid, '/repo/a', { prompts: ['hi'] });
    const found = listActiveRollouts(sessionsDir, Date.now());
    expect(found).toHaveLength(1);
    expect(found[0].threadId).toBe(tid);
    expect(found[0].cwd).toBe('/repo/a');
  });

  it('excludes rollouts older than the active window', () => {
    writeRollout('019f0000-0000-7000-8000-000000000001', '/repo/a', { prompts: ['hi'], ageMs: ACTIVE_WINDOW_MS + 60_000 });
    expect(listActiveRollouts(sessionsDir, Date.now())).toHaveLength(0);
  });

  it('keeps only the newest rollout per thread id', () => {
    const tid = '019f0000-0000-7000-8000-000000000002';
    writeRollout(tid, '/repo/a', { prompts: ['old'], dateParts: ['2026', '07', '23'] });
    writeRollout(tid, '/repo/a', { prompts: ['new'], dateParts: ['2026', '07', '24'] });
    const found = listActiveRollouts(sessionsDir, Date.now());
    expect(found.filter((f) => f.threadId === tid)).toHaveLength(1);
  });
});

describe('reconcileThread — rollout → session mapping', () => {
  it('creates a session keyed on threadId and pushes prompts + per-prompt diff', async () => {
    const tid = '019f8754-1acd-70f1-bb8e-882eb975b596';
    const file = writeRollout(tid, '/repo/a', { prompts: ['first prompt'], model: 'gpt-5.5', toolCalls: 2 });
    const api = mockApi();
    const st = await reconcileThread(scan(file, tid, '/repo/a'), baseDeps(api));
    expect(st?.sessionId).toBe('sess-1');
    expect(api.startSession).toHaveBeenCalledTimes(1);
    expect(api.calls.start[0].agentSessionId).toBe(tid);
    expect(api.calls.start[0].agentSlug).toBe('codex');
    const update = api.calls.update.at(-1);
    expect(update.data.prompt).toContain('first prompt');
    expect(update.data.promptChanges[0].linesAdded).toBe(1);
    expect(update.data.status).toBe('RUNNING');
  });
});

describe('reconcileThread — FIX 1: rollout-start time + no partial banner', () => {
  it('stamps startSession.startedAt from the rollout\'s first user prompt (not "now")', async () => {
    const tid = '019f8754-1acd-70f1-bb8e-882eb975b596';
    const file = writeRollout(tid, '/repo/a', { prompts: ['p1', 'p2'] });
    const api = mockApi();
    await reconcileThread(scan(file, tid, '/repo/a'), baseDeps(api));
    // writeRollout stamps every user prompt at 10:00:10Z — the earliest is the
    // session's true start, and must be passed through so the server doesn't
    // treat the watcher as having joined mid-stream.
    expect(api.calls.start[0].startedAt).toBe('2026-07-24T10:00:10.000Z');
  });

  it('backfills a promptChange for EVERY existing prompt on first capture (min index 0 → no partialCapture)', async () => {
    const tid = '019f8754-1acd-70f1-bb8e-882eb975b596';
    // Rollout already holds 3 prompts when the watcher first notices the thread.
    const file = writeRollout(tid, '/repo/a', { prompts: ['p1', 'p2', 'p3'] });
    const api = mockApi();
    await reconcileThread(scan(file, tid, '/repo/a'), baseDeps(api));
    const update = api.calls.update.at(-1);
    const indices = (update.data.promptChanges as any[]).map((pc) => pc.promptIndex).sort((a, b) => a - b);
    expect(indices).toEqual([0, 1, 2]);
    // Server's mid-stream heuristic keys on the LOWEST incoming promptIndex.
    expect(Math.min(...indices)).toBe(0);
    // Steady state: a later poll with no new prompt sends only the latest.
    const file2 = writeRollout(tid, '/repo/a', { prompts: ['p1', 'p2', 'p3'] });
    const api2b = api; // reuse so prior state (initialBackfillSent) is honored
    await reconcileThread(scan(file2, tid, '/repo/a'), baseDeps(api2b));
    const update2 = api2b.calls.update.at(-1);
    const indices2 = (update2.data.promptChanges as any[]).map((pc) => pc.promptIndex);
    expect(indices2).toEqual([2]);
  });

  it('re-sends the full backfill until the server acks it (failed first PATCH must not strand prompt 0)', async () => {
    const tid = '019f8754-1acd-70f1-bb8e-882eb975b596';
    const file = writeRollout(tid, '/repo/a', { prompts: ['p1', 'p2'] });
    const api = mockApi();
    // First update fails — initialBackfillSent must stay false.
    api.updateSession.mockRejectedValueOnce(new Error('network'));
    await reconcileThread(scan(file, tid, '/repo/a'), baseDeps(api));
    const st = loadThreadState(tid, stateDir);
    expect(st?.initialBackfillSent).toBeFalsy();
    // Next poll re-sends the whole backfill (indices 0 AND 1).
    await reconcileThread(scan(file, tid, '/repo/a'), baseDeps(api));
    const update = api.calls.update.at(-1);
    const indices = (update.data.promptChanges as any[]).map((pc) => pc.promptIndex).sort((a, b) => a - b);
    expect(indices).toEqual([0, 1]);
    expect(loadThreadState(tid, stateDir)?.initialBackfillSent).toBe(true);
  });
});

describe('reconcileThread — FIX 2: git commit capture', () => {
  it('sends gitCapture.commitDetails for commits made during the session window', async () => {
    const tid = '019f8754-1acd-70f1-bb8e-882eb975b596';
    const file = writeRollout(tid, '/repo/a', { prompts: ['add some more shit and commit'] });
    const api = mockApi();
    const commitSha = 'c'.repeat(40);
    const captureGit = vi.fn((_root: string, headBefore: string | null) => ({
      headBefore: headBefore || 'b'.repeat(40),
      headAfter: commitSha,
      commitShas: [commitSha],
      commitDetails: [{
        sha: commitSha, message: 'add some more shit', author: 'dev',
        filesChanged: ['x'], linesAdded: 5, linesRemoved: 0, patch: 'diff --git a/x b/x\n+a\n+b\n+c\n+d\n+e\n',
      }],
      diff: 'diff --git a/x b/x\n+a\n+b\n+c\n+d\n+e\n', diffTruncated: false, linesAdded: 5, linesRemoved: 0,
    }));
    await reconcileThread(scan(file, tid, '/repo/a'), baseDeps(api, { captureGit }));
    // Baseline is the HEAD recorded at session creation (getHead → 'b'*40).
    expect(captureGit).toHaveBeenCalledWith('/repo/a', 'b'.repeat(40));
    const update = api.calls.update.at(-1);
    expect(update.data.gitCapture).toBeDefined();
    expect(update.data.gitCapture.commitShas).toEqual([commitSha]);
    expect(update.data.gitCapture.commitDetails[0].linesAdded).toBe(5);
    // headShaAtStart persisted for a stable baseline across restarts.
    expect(loadThreadState(tid, stateDir)?.headShaAtStart).toBe('b'.repeat(40));
  });

  it('omits gitCapture when the session made no commits', async () => {
    const tid = '019f8754-1acd-70f1-bb8e-882eb975b596';
    const file = writeRollout(tid, '/repo/a', { prompts: ['read-only prompt'] });
    const api = mockApi();
    await reconcileThread(scan(file, tid, '/repo/a'), baseDeps(api)); // default captureGit → no commits
    const update = api.calls.update.at(-1);
    expect(update.data.gitCapture).toBeUndefined();
  });
});

describe('reconcileThread — internal-subroutine skip', () => {
  it('does NOT create a session for a Codex internal meta-call thread', async () => {
    const tid = '019f0000-0000-7000-8000-0000000000aa';
    const file = writeRollout(tid, '/repo/a', {
      prompts: ['You are an expert at upholding safety and compliance standards for Codex ambient suggestions.'],
      model: 'gpt-5.4-mini',
      toolCalls: 0,
    });
    const api = mockApi();
    const st = await reconcileThread(scan(file, tid, '/repo/a'), baseDeps(api));
    expect(st).toBeNull();
    expect(api.startSession).not.toHaveBeenCalled();
  });
});

describe('reconcileThread — non-git cwd skip', () => {
  it('skips a thread whose cwd is not a git repo', async () => {
    const tid = '019f0000-0000-7000-8000-0000000000bb';
    const file = writeRollout(tid, '/tmp/not-a-repo', { prompts: ['hi'] });
    const api = mockApi();
    const st = await reconcileThread(scan(file, tid, '/tmp/not-a-repo'), baseDeps(api, { resolveRepo: () => null }));
    expect(st).toBeNull();
    expect(api.startSession).not.toHaveBeenCalled();
  });
});

describe('reconcileThread — dedup / no-duplicate-on-restart', () => {
  it('reuses the sessionId from prior state and does not call startSession again', async () => {
    const tid = '019f8754-1acd-70f1-bb8e-882eb975b596';
    const file = writeRollout(tid, '/repo/a', { prompts: ['p1', 'p2'] });
    const api = mockApi();
    const deps = baseDeps(api);
    // First pass creates the session + processes 2 prompts.
    await reconcileThread(scan(file, tid, '/repo/a'), deps);
    expect(api.startSession).toHaveBeenCalledTimes(1);
    const persisted = loadThreadState(tid, stateDir);
    expect(persisted?.promptCount).toBe(2);
    expect(persisted?.promptShadows).toHaveLength(2);
    // Second pass (simulating a restart) must NOT create a second session and
    // must NOT re-create shadows for prompts already processed.
    const shadowSpy = vi.fn(() => 'c'.repeat(40));
    await reconcileThread(scan(file, tid, '/repo/a'), baseDeps(api, { createShadow: shadowSpy }));
    expect(api.startSession).toHaveBeenCalledTimes(1);
    expect(shadowSpy).not.toHaveBeenCalled(); // no new prompts → no new shadows
  });

  it('captures a shadow only for genuinely new prompts', async () => {
    const tid = '019f8754-1acd-70f1-bb8e-882eb975b596';
    const api = mockApi();
    // Start with one prompt.
    let file = writeRollout(tid, '/repo/a', { prompts: ['p1'] });
    await reconcileThread(scan(file, tid, '/repo/a'), baseDeps(api));
    // Add a second prompt; only prompt index 1 should get a fresh shadow.
    file = writeRollout(tid, '/repo/a', { prompts: ['p1', 'p2'] });
    const shadowSpy = vi.fn((_root: string, tag: string) => `sha-${tag}`);
    await reconcileThread(scan(file, tid, '/repo/a'), baseDeps(api, { createShadow: shadowSpy }));
    expect(shadowSpy).toHaveBeenCalledTimes(1);
    const st = loadThreadState(tid, stateDir);
    expect(st?.promptCount).toBe(2);
  });
});

describe('reconcileThread — idle → end', () => {
  it('marks a RUNNING session ENDED once its rollout goes idle', async () => {
    const tid = '019f8754-1acd-70f1-bb8e-882eb975b596';
    const file = writeRollout(tid, '/repo/a', { prompts: ['p1'] });
    const api = mockApi();
    // Live pass creates the session.
    await reconcileThread(scan(file, tid, '/repo/a'), baseDeps(api));
    // Now present the same thread with a stale mtime (> idle threshold).
    const idleScan: ScannedRollout = { rolloutPath: file, threadId: tid, cwd: '/repo/a', mtimeMs: Date.now() - 30 * 60 * 1000 };
    const st = await reconcileThread(idleScan, baseDeps(api));
    expect(st?.status).toBe('ENDED');
    const endCall = api.calls.update.at(-1);
    expect(endCall.data.status).toBe('ENDED');
  });

  it('does not resurrect or double-end an already-ENDED thread', async () => {
    const tid = '019f8754-1acd-70f1-bb8e-882eb975b596';
    const file = writeRollout(tid, '/repo/a', { prompts: ['p1'] });
    saveThreadState({
      threadId: tid, sessionId: 'sess-x', repoPath: '/repo/a', workRoot: '/repo/a',
      promptCount: 1, promptShadows: [], createdAt: new Date().toISOString(),
      lastRolloutMtime: Date.now() - 40 * 60 * 1000, status: 'ENDED', endedAt: new Date().toISOString(),
    }, stateDir);
    const api = mockApi();
    const idleScan: ScannedRollout = { rolloutPath: file, threadId: tid, cwd: '/repo/a', mtimeMs: Date.now() - 40 * 60 * 1000 };
    await reconcileThread(idleScan, baseDeps(api));
    expect(api.updateSession).not.toHaveBeenCalled();
  });
});

describe('runWatchCycle', () => {
  it('processes every active thread in one pass', async () => {
    writeRollout('019f0000-0000-7000-8000-0000000000c1', '/repo/a', { prompts: ['a'] });
    writeRollout('019f0000-0000-7000-8000-0000000000c2', '/repo/b', { prompts: ['b'] });
    const api = mockApi();
    await runWatchCycle(sessionsDir, baseDeps(api));
    expect(api.startSession).toHaveBeenCalledTimes(2);
  });
});

describe('single-instance guard', () => {
  it('anotherWatcherRunning is false when the pid file names THIS process', () => {
    const pidFile = path.join(tmp, 'watch.pid');
    fs.writeFileSync(pidFile, String(process.pid));
    expect(anotherWatcherRunning(pidFile)).toBe(false);
  });

  it('anotherWatcherRunning is false when the pid is dead', () => {
    const pidFile = path.join(tmp, 'watch.pid');
    fs.writeFileSync(pidFile, '999999'); // almost certainly not a live pid
    expect(anotherWatcherRunning(pidFile)).toBe(false);
  });

  it('anotherWatcherRunning is false when no pid file exists', () => {
    expect(anotherWatcherRunning(path.join(tmp, 'nope.pid'))).toBe(false);
  });

  it('watcherSuperseded is true when a different pid owns the file', () => {
    const pidFile = path.join(tmp, 'watch.pid');
    fs.writeFileSync(pidFile, String(process.pid + 1));
    expect(watcherSuperseded(pidFile)).toBe(true);
  });

  it('watcherSuperseded is true when the pid file is gone', () => {
    expect(watcherSuperseded(path.join(tmp, 'gone.pid'))).toBe(true);
  });

  it('watcherSuperseded is false when we still own the file', () => {
    const pidFile = path.join(tmp, 'watch.pid');
    fs.writeFileSync(pidFile, String(process.pid));
    expect(watcherSuperseded(pidFile)).toBe(false);
  });

  it('restartCodexWatch is a no-op (never spawns) where auto-start is gated off', () => {
    const saved = process.env.ORIGIN_CODEX_WATCH;
    process.env.ORIGIN_CODEX_WATCH = '0'; // force-disable regardless of host OS
    try {
      const r = restartCodexWatch();
      expect(r.restarted).toBe(false);
      expect(r.reason).toBe('gated-off');
    } finally {
      if (saved === undefined) delete process.env.ORIGIN_CODEX_WATCH;
      else process.env.ORIGIN_CODEX_WATCH = saved;
    }
  });
});

describe('codexWatchAutoStartEnabled — Windows-first gating', () => {
  const saved = process.env.ORIGIN_CODEX_WATCH;
  afterEach(() => { if (saved === undefined) delete process.env.ORIGIN_CODEX_WATCH; else process.env.ORIGIN_CODEX_WATCH = saved; });

  it('auto-starts on Windows', () => {
    delete process.env.ORIGIN_CODEX_WATCH;
    expect(codexWatchAutoStartEnabled('win32')).toBe(true);
  });

  it('does NOT auto-start on macOS/Linux by default (hooks still work there)', () => {
    delete process.env.ORIGIN_CODEX_WATCH;
    expect(codexWatchAutoStartEnabled('darwin')).toBe(false);
    expect(codexWatchAutoStartEnabled('linux')).toBe(false);
  });

  it('ORIGIN_CODEX_WATCH=1 force-enables anywhere; =0 force-disables', () => {
    process.env.ORIGIN_CODEX_WATCH = '1';
    expect(codexWatchAutoStartEnabled('linux')).toBe(true);
    process.env.ORIGIN_CODEX_WATCH = '0';
    expect(codexWatchAutoStartEnabled('win32')).toBe(false);
  });
});
