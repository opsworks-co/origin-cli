/**
 * Watchers must SAY when they skip a session.
 *
 * Found live: a Codex session vanished from the dashboard and nothing anywhere
 * explained it. Codex Desktop had opened a scratch folder that was a git repo
 * but one git refused to read ("detected dubious ownership"), so every git call
 * failed, resolveRepo returned null, and the watcher skipped in silence — "not
 * tracked" and "broken" looked identical from the outside.
 *
 * Logged once per (agent, path): a permanently-skipped session is re-examined
 * every poll forever, and the unregistered-repo retry already proved that
 * logging such a thing unconditionally buries the log.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { logSkipOnce, __resetLoggedSkips } from '../debug-log.js';
import { reconcileSession, loadSessionState, saveSessionState, type WatchDeps, type SessionWatchState } from '../transcript-watch.js';
import { type TranscriptAdapter, type ScannedTranscript, type ParsedSession } from '../transcript-adapters.js';

describe('logSkipOnce', () => {
  beforeEach(() => __resetLoggedSkips());

  it('emits the first time and never again for the same key', () => {
    const emit = vi.fn();
    logSkipOnce('k', emit);
    logSkipOnce('k', emit);
    logSkipOnce('k', emit);
    expect(emit).toHaveBeenCalledTimes(1);
  });

  it('keys are independent', () => {
    const a = vi.fn();
    const b = vi.fn();
    logSkipOnce('repo-a', a);
    logSkipOnce('repo-b', b);
    logSkipOnce('repo-a', a);
    expect(a).toHaveBeenCalledTimes(1);
    expect(b).toHaveBeenCalledTimes(1);
  });
});

describe('transcript-watch logs why it skipped', () => {
  let tmp = '';
  let stateDir = '';

  beforeEach(() => {
    __resetLoggedSkips();
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'skiplog-'));
    stateDir = path.join(tmp, 'state');
    fs.mkdirSync(stateDir, { recursive: true });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  function adapter(): TranscriptAdapter {
    const parsed: ParsedSession = {
      userPrompts: ['hello'], promptTimestamps: [1000], transcript: 't', model: 'm',
      tokensUsed: 0, inputTokens: 0, outputTokens: 0, toolCalls: 0,
      filePaths: [], filesChanged: [], promptDiffs: [],
    };
    return { slug: 'fake', agentSlugForServer: 'fake', listActive: () => [], parse: () => parsed };
  }

  function deps(over: Partial<WatchDeps> = {}): WatchDeps {
    return {
      now: () => Date.now(), idleMs: 20 * 60_000, machineId: 'm', hostname: 'h', stateDir,
      api: { startSession: vi.fn(), updateSession: vi.fn() } as any,
      resolveRepo: () => null, // the condition under test
      createShadow: () => null, getHead: () => null,
      captureDiff: () => ({ diff: '', filesChanged: [], linesAdded: 0, linesRemoved: 0 }),
      captureGit: () => ({ headBefore: '', headAfter: '', commitShas: [], commitDetails: [], diff: '', diffTruncated: false, linesAdded: 0, linesRemoved: 0 }),
      loadState: (a: string, s: string) => loadSessionState(a, s, stateDir),
      saveState: (s: SessionWatchState) => saveSessionState(s, stateDir),
      ...over,
    };
  }

  const scanned = (over: Partial<ScannedTranscript> = {}): ScannedTranscript =>
    ({ sessionId: 'sess-1', transcriptPath: '/x', cwd: '/not/a/repo', mtimeMs: Date.now(), ...over });

  // Capture at the write, not by diffing ~/.origin/hooks.log: reading the real
  // file makes the test depend on the suite's HOME and on nothing else writing
  // concurrently. debugLog calls fs.appendFileSync on the default fs object, so
  // spying there sees exactly what would have been logged.
  function captureLog() {
    const lines: string[] = [];
    vi.spyOn(fs, 'appendFileSync').mockImplementation(((_p: any, data: any) => {
      lines.push(String(data));
    }) as any);
    return lines;
  }

  it('writes a line naming the unusable cwd, and only once', async () => {
    const lines = captureLog();

    await reconcileSession(scanned(), adapter(), deps());
    await reconcileSession(scanned(), adapter(), deps());
    await reconcileSession(scanned(), adapter(), deps());

    const hits = lines.filter((l) => l.includes('not a usable git repo'));
    expect(hits.length).toBe(1);
    expect(hits[0]).toContain('/not/a/repo');
    // The hint is the actionable part — this is exactly the case that confused us.
    expect(hits[0]).toContain('dubious ownership');
  });

  it('names the no-cwd case distinctly', async () => {
    const lines = captureLog();

    await reconcileSession(scanned({ cwd: null }), adapter(), deps());

    expect(lines.join('')).toContain('skipped: no cwd for session');
  });
});
