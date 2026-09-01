/**
 * A chat-only turn must not inherit the previous turn's work.
 *
 * The in-flight prompt falls back to the SESSION-WIDE edited-file list when its
 * own transcript mapping is empty (`agentFilesRel` in transcript-watch.ts), and
 * captureFilesDiff diffs those files against HEAD — not against the turn's own
 * baseline. So a turn that only chatted re-reports every uncommitted line the
 * session has accumulated, and an untracked file is re-counted in FULL every
 * time (captureFilesDiff renders untracked files as entirely added).
 *
 * Observed on session 4308e5b5, where three consecutive chat-only turns each
 * duplicated their predecessor exactly (+9/-0, +31/-1, +337/-6) and the
 * per-turn total came to +1278/-31 against a true session diff of +179/-0.
 * The commit/session diff was right the whole time; only the per-turn split
 * was wrong, which is why the totals never looked alarming.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import {
  __resetStartSessionBackoff,
  reconcileSession,
  loadSessionState,
  saveSessionState,
  type WatchDeps,
  type SessionWatchState,
} from '../transcript-watch.js';
import type { TranscriptAdapter, ScannedTranscript, ParsedSession } from '../transcript-adapters.js';

let tmp = '';
let stateDir = '';

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'twatch-inherit-'));
  stateDir = path.join(tmp, 'state');
  fs.mkdirSync(stateDir, { recursive: true });
  __resetStartSessionBackoff();
});

afterEach(() => {
  vi.restoreAllMocks();
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* ignore */ }
});

function mockApi() {
  const calls = { start: [] as any[], update: [] as any[] };
  let n = 0;
  return {
    calls,
    startSession: vi.fn(async () => ({ sessionId: `sess-${++n}` })),
    updateSession: vi.fn(async (id: string, data: any) => { calls.update.push({ id, data }); return {}; }),
  };
}

// Turn 0 edited src/x.ts (+9). Turn 1 is chat-only: no promptDiffs entry.
// The file is still uncommitted, so a HEAD-relative diff of it keeps showing
// +9 — which is exactly what turn 1 must NOT claim.
const EDITED = 'src/x.ts';

function adapterWith(userPrompts: string[]): TranscriptAdapter {
  const full: ParsedSession = {
    userPrompts,
    promptTimestamps: userPrompts.map((_, i) => 1_000 * (i + 1)),
    transcript: 'transcript',
    model: 'claude-opus-4-8',
    tokensUsed: 50, inputTokens: 20, outputTokens: 30, toolCalls: 4,
    filePaths: [],
    // Session-wide edited-file list — turn 0's work, visible for the whole session.
    filesChanged: [EDITED],
    promptDiffs: [
      { promptIndex: 0, filesChanged: [EDITED], diff: 'diff --git a/src/x.ts', linesAdded: 9, linesRemoved: 0 },
    ],
  };
  return { slug: 'fake', agentSlugForServer: 'fake-agent', listActive: () => [], parse: () => full };
}

function deps(api: ReturnType<typeof mockApi>, over: Partial<WatchDeps> = {}): WatchDeps {
  return {
    now: () => Date.now(),
    idleMs: 20 * 60 * 1000,
    machineId: 'm1',
    hostname: 'h1',
    stateDir,
    api: api as any,
    resolveRepo: (cwd: string) => ({ repoPath: cwd, workRoot: cwd, repoUrl: 'git@github.com:o/r.git', branch: 'main' }),
    createShadow: () => 'a'.repeat(40),
    getHead: () => 'b'.repeat(40),
    // The turn's own baseline shows nothing new — turn 1 genuinely changed nothing.
    captureDiff: () => ({ diff: '', filesChanged: [], linesAdded: 0, linesRemoved: 0 }),
    // HEAD-relative: turn 0's uncommitted edit is still visible here.
    captureFilesDiff: (_root: string, rel: string[]) =>
      rel.includes(EDITED)
        ? { diff: 'diff --git a/src/x.ts', filesChanged: [EDITED], linesAdded: 9, linesRemoved: 0 }
        : { diff: '', filesChanged: [], linesAdded: 0, linesRemoved: 0 },
    captureGit: () => ({
      headBefore: 'b'.repeat(40), headAfter: 'b'.repeat(40), commitShas: [], commitDetails: [],
      diff: '', diffTruncated: false, linesAdded: 0, linesRemoved: 0,
    }),
    loadState: (slug: string, sid: string) => loadSessionState(slug, sid, stateDir),
    saveState: (s: SessionWatchState) => saveSessionState(s, stateDir),
    ...over,
  };
}

function scanned(): ScannedTranscript {
  return { sessionId: 'conv-1', transcriptPath: '/nope', cwd: '/repo/a', mtimeMs: Date.now() };
}

/** The promptChanges array from the most recent updateSession call that sent one. */
function lastPromptChanges(api: ReturnType<typeof mockApi>): any[] {
  for (let i = api.calls.update.length - 1; i >= 0; i--) {
    const pc = api.calls.update[i].data?.promptChanges;
    if (Array.isArray(pc)) return pc;
  }
  return [];
}

describe('chat-only turn does not inherit the previous turn work', () => {
  it('reports +0/-0 and no files for a turn that only chatted', async () => {
    const api = mockApi();
    const d = deps(api);
    await reconcileSession(scanned(), adapterWith(['edit the file']), d);
    await reconcileSession(scanned(), adapterWith(['edit the file', 'did that work?']), d);

    const changes = lastPromptChanges(api);
    const turn1 = changes.find((c) => c.promptIndex === 1);
    expect(turn1).toBeTruthy();
    expect(turn1.linesAdded).toBe(0);
    expect(turn1.linesRemoved).toBe(0);
    expect(turn1.filesChanged).toEqual([]);
  });

  it('keeps the per-turn total equal to the work actually done', async () => {
    const api = mockApi();
    const d = deps(api);
    await reconcileSession(scanned(), adapterWith(['edit the file']), d);
    await reconcileSession(scanned(), adapterWith(['edit the file', 'did that work?']), d);
    await reconcileSession(scanned(), adapterWith(['edit the file', 'did that work?', 'and now?']), d);

    const changes = lastPromptChanges(api);
    const total = changes.reduce((n: number, c: any) => n + (c.linesAdded || 0), 0);
    // Turn 0 did +9. Two chat turns followed. Anything above 9 is re-counted work.
    expect(total).toBe(9);
  });

  it('still captures the in-flight turn when it DID edit something', async () => {
    // The fallback must keep working for a real edit — this guards against
    // fixing the inflation by simply disabling the session-wide recovery.
    const api = mockApi();
    const d = deps(api);
    await reconcileSession(scanned(), adapterWith(['edit the file']), d);

    const changes = lastPromptChanges(api);
    const turn0 = changes.find((c) => c.promptIndex === 0);
    expect(turn0.linesAdded).toBe(9);
    expect(turn0.filesChanged).toEqual([EDITED]);
  });
});
