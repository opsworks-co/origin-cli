// Unit tests for the hook-independent multi-agent transcript watcher.
// Hermetic: temp dirs for transcript stores + watch state, a mock api client,
// and injected git/repo deps — no real network, no real git, no real ~/.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import {
  __resetStartSessionBackoff,
  reconcileSession,
  runWatchCycle,
  loadSessionState,
  saveSessionState,
  listSessionStates,
  deriveRepoFromFilePaths,
  anotherWatcherRunning,
  watcherSuperseded,
  transcriptWatchAutoStartEnabled,
  type WatchDeps,
  type SessionWatchState,
} from '../transcript-watch.js';
import {
  claudeAdapter,
  copilotAdapter,
  antigravityAdapter,
  geminiAdapter,
  type TranscriptAdapter,
  type ScannedTranscript,
  type ParsedSession,
} from '../transcript-adapters.js';

let tmp = '';
let stateDir = '';

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'twatch-'));
  stateDir = path.join(tmp, 'state');
  fs.mkdirSync(stateDir, { recursive: true });
  // The startSession cooloff is module state — a leak across tests would make
  // a later reconcile silently skip its API call.
  __resetStartSessionBackoff();
});

afterEach(() => {
  vi.restoreAllMocks();
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* ignore */ }
});

// ─── Mocks / builders ─────────────────────────────────────────────────────────

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
    resolveRepo: (cwd: string) => ({ repoPath: cwd, workRoot: cwd, repoUrl: 'git@github.com:org/repo.git', branch: 'main' }),
    createShadow: () => 'a'.repeat(40),
    getHead: () => 'b'.repeat(40),
    captureDiff: () => ({ diff: 'diff --git', filesChanged: ['src/x.ts'], linesAdded: 3, linesRemoved: 1 }),
    captureGit: () => ({
      headBefore: 'b'.repeat(40), headAfter: 'c'.repeat(40), commitShas: [], commitDetails: [],
      diff: '', diffTruncated: false, linesAdded: 0, linesRemoved: 0,
    }),
    loadState: (agentSlug: string, sessionId: string) => loadSessionState(agentSlug, sessionId, stateDir),
    saveState: (s: SessionWatchState) => saveSessionState(s, stateDir),
    ...over,
  };
}

function fakeAdapter(parsed: Partial<ParsedSession> = {}): TranscriptAdapter {
  const full: ParsedSession = {
    userPrompts: ['first prompt', 'second prompt'],
    promptTimestamps: [1_000, 2_000],
    transcript: 'the transcript',
    model: 'claude-opus-4-8',
    tokensUsed: 50, inputTokens: 20, outputTokens: 30, toolCalls: 4,
    filePaths: [],
    filesChanged: [],
    promptDiffs: [],
    ...parsed,
  };
  return {
    slug: 'fake',
    agentSlugForServer: 'fake-agent',
    listActive: () => [],
    parse: () => full,
  };
}

function scanned(over: Partial<ScannedTranscript> = {}): ScannedTranscript {
  return { sessionId: 'conv-123', transcriptPath: '/does/not/matter', cwd: '/repo/a', mtimeMs: Date.now(), ...over };
}

/**
 * The payload as the SERVER receives it. The watcher builds optional fields as
 * `value || undefined`, so an absent field is a key holding undefined — present
 * to `in`, gone the moment it is serialized. What the server branches on is the
 * latter, so that is what an "did we send it?" assertion has to look at.
 */
function onTheWire(data: any): any {
  return JSON.parse(JSON.stringify(data));
}

// ─── State persistence ────────────────────────────────────────────────────────

describe('session state persistence', () => {
  it('roundtrips namespaced by agent slug', () => {
    const st: SessionWatchState = {
      agentSlug: 'claude', sessionId: 'abc', originSessionId: 'sess-1',
      repoPath: '/repo', workRoot: '/repo', promptCount: 1, promptShadows: [],
      createdAt: new Date().toISOString(), lastTranscriptMtime: Date.now(), status: 'RUNNING',
    };
    saveSessionState(st, stateDir);
    const loaded = loadSessionState('claude', 'abc', stateDir);
    expect(loaded?.originSessionId).toBe('sess-1');
    // A different agent with the same session id is a distinct file.
    expect(loadSessionState('cursor', 'abc', stateDir)).toBeNull();
  });

  it('lists states across agent subdirs', () => {
    saveSessionState({ agentSlug: 'claude', sessionId: 'a', originSessionId: null, repoPath: '/r', workRoot: '/r', promptCount: 0, promptShadows: [], createdAt: '', lastTranscriptMtime: 0, status: 'RUNNING' }, stateDir);
    saveSessionState({ agentSlug: 'cursor', sessionId: 'b', originSessionId: null, repoPath: '/r', workRoot: '/r', promptCount: 0, promptShadows: [], createdAt: '', lastTranscriptMtime: 0, status: 'ENDED' }, stateDir);
    const all = listSessionStates(stateDir);
    expect(all.map((s) => `${s.agentSlug}:${s.sessionId}`).sort()).toEqual(['claude:a', 'cursor:b']);
  });
});

// ─── reconcileSession ───────────────────────────────────────────────────────────

describe('reconcileSession', () => {
  it('creates a session keyed on agentSessionId with the server agent slug and earliest start time', async () => {
    const api = mockApi();
    const deps = baseDeps(api);
    await reconcileSession(scanned(), fakeAdapter(), deps);

    expect(api.startSession).toHaveBeenCalledTimes(1);
    const start = api.calls.start[0];
    expect(start.agentSessionId).toBe('conv-123');
    expect(start.agentSlug).toBe('fake-agent');
    expect(start.model).toBe('claude-opus-4-8');
    expect(start.repoPath).toBe('/repo/a');
    // startedAt stamped from the earliest prompt timestamp, not "now".
    expect(start.startedAt).toBe(new Date(1_000).toISOString());
  });

  // Regression: promptChanges carried NO createdAt, so the server fell back to
  // the DB insert time — whenever this watcher happened to poll. Prod session
  // 03a338b8 recorded commit 5f6c7a37 at 19:08:24 while the prompt that made it
  // was stamped 19:08:58: the turn's own commit appeared to predate the turn by
  // 34s, and every timestamp-based attribution rule then reasoned from that.
  // The parser already exposes aligned per-prompt epoch-ms.
  it('sends each prompt\'s REAL transcript timestamp as createdAt', async () => {
    const api = mockApi();
    await reconcileSession(scanned(), fakeAdapter(), baseDeps(api));
    const pcs = api.calls.update[0].data.promptChanges;
    expect(pcs[0].createdAt).toBe(1_000);
    expect(pcs[1].createdAt).toBe(2_000);
  });

  it('omits createdAt rather than sending a bogus epoch when the transcript has no timestamp', async () => {
    const api = mockApi();
    await reconcileSession(
      scanned(),
      fakeAdapter({ userPrompts: ['only prompt'], promptTimestamps: [0] }),
      baseDeps(api),
    );
    const pcs = api.calls.update[0].data.promptChanges;
    expect(pcs[0]).not.toHaveProperty('createdAt');
  });

  it('emits a per-turn row for EVERY prompt; the latest carries the diff', async () => {
    const api = mockApi();
    await reconcileSession(scanned(), fakeAdapter(), baseDeps(api));
    const update = api.calls.update[0].data;
    expect(update.status).toBe('RUNNING');
    expect(update.promptChanges.map((c: any) => c.promptIndex)).toEqual([0, 1]);
    // The latest prompt carries the diff (as uncommittedDiff); earlier ones don't.
    expect(update.promptChanges[0].uncommittedDiff).toBeUndefined();
    expect(update.promptChanges[1].uncommittedDiff).toContain('diff --git');
    const st = loadSessionState('fake', 'conv-123', stateDir);
    expect(st?.promptCount).toBe(2);
    expect(st?.originSessionId).toBe('sess-1');
  });

  it('skips the git pass when nothing changed since the last poll', async () => {
    // #1281's optimization, which had no test of its own. An idle session used to
    // redo the whole reconcile every 8s and — on Windows, where the daemon has no
    // console — flash a black window for every git child it spawned. Same
    // transcript, same prompt count, same HEAD: there is nothing to recompute.
    const api = mockApi();
    const deps = baseDeps(api);
    // A REAL file: the guard also compares the transcript's SIZE, and a size it
    // cannot read is unknown rather than unchanged, so it declines to skip.
    // Every live session has a transcript on disk — this is the production shape.
    const file = path.join(tmp, 'idle.jsonl');
    fs.writeFileSync(file, '{"role":"user","content":"first prompt"}\n');
    const fixed = scanned({ transcriptPath: file, mtimeMs: fs.statSync(file).mtimeMs });
    await reconcileSession(fixed, fakeAdapter(), deps);
    const updatesAfterFirst = api.calls.update.length;
    await reconcileSession(fixed, fakeAdapter(), deps);   // identical poll
    expect(api.calls.update.length).toBe(updatesAfterFirst);
  });

  it('does NOT skip when the WORKING TREE moved but the transcript did not', async () => {
    // Session 65014e0b. An agent writes its files and then summarises, so the
    // last transcript write can precede the last file write; and a turn whose
    // work is never committed never moves HEAD either. Every signal the guard
    // watched sat still while three files worth +1352/-41 landed on disk, so
    // the session stayed frozen on a one-file, +37/-37 capture for over an hour.
    const api = mockApi();
    let fingerprint = '?? styles.css\n';
    const deps = { ...baseDeps(api), treeFingerprint: () => fingerprint };
    const file = path.join(tmp, 'tree-moved.jsonl');
    fs.writeFileSync(file, '{"role":"user","content":"first prompt"}\n');
    const fixed = scanned({ transcriptPath: file, mtimeMs: fs.statSync(file).mtimeMs });

    await reconcileSession(fixed, fakeAdapter(), deps);
    const afterFirst = api.calls.update.length;
    // Identical transcript, identical HEAD — only the tree moved.
    fingerprint = '?? styles.css\n?? app.js\n M index.html\n';
    await reconcileSession(fixed, fakeAdapter(), deps);
    expect(api.calls.update.length).toBeGreaterThan(afterFirst);
  });

  it('still skips when the tree is quiet too', async () => {
    // The optimisation has to survive: an idle session must not spawn git every
    // poll just because the guard grew a fourth signal.
    const api = mockApi();
    const deps = { ...baseDeps(api), treeFingerprint: () => 'stable\n' };
    const file = path.join(tmp, 'tree-quiet.jsonl');
    fs.writeFileSync(file, '{"role":"user","content":"first prompt"}\n');
    const fixed = scanned({ transcriptPath: file, mtimeMs: fs.statSync(file).mtimeMs });

    await reconcileSession(fixed, fakeAdapter(), deps);
    const afterFirst = api.calls.update.length;
    await reconcileSession(fixed, fakeAdapter(), deps);
    expect(api.calls.update.length).toBe(afterFirst);
  });

  it('treats an unreadable tree as CHANGED rather than unchanged', async () => {
    // Same rule the transcript-size check follows: skipping is the optimisation,
    // doing the work is the correct answer, so anything unconfirmed falls
    // through. A git failure must cost a redundant capture, never a lost one.
    const api = mockApi();
    const deps = { ...baseDeps(api), treeFingerprint: () => null };
    const file = path.join(tmp, 'tree-unknown.jsonl');
    fs.writeFileSync(file, '{"role":"user","content":"first prompt"}\n');
    const fixed = scanned({ transcriptPath: file, mtimeMs: fs.statSync(file).mtimeMs });

    await reconcileSession(fixed, fakeAdapter(), deps);
    const afterFirst = api.calls.update.length;
    await reconcileSession(fixed, fakeAdapter(), deps);
    expect(api.calls.update.length).toBeGreaterThan(afterFirst);
  });

  it('does NOT skip a new prompt that landed within the same mtime tick', async () => {
    // The regression #1281 shipped. The skip keyed on mtime alone, and mtime has
    // finite resolution — a whole second on some filesystems — so a turn appended
    // within the same tick as the previous poll's reading was invisible to it and
    // got skipped. If that turn is the session's last, nothing ever bumps mtime
    // again and it is dropped for good: a 3-prompt session reported turns 0 and 1
    // and silently lost the newest.
    //
    // Same `scanned` object BOTH times, so the mtime is provably identical rather
    // than incidentally so — the count is what has to catch it.
    const api = mockApi();
    const deps = baseDeps(api);
    const fixed = scanned();
    await reconcileSession(fixed, fakeAdapter(), deps);
    await reconcileSession(fixed, fakeAdapter({
      userPrompts: ['first prompt', 'second prompt', 'third'],
      promptTimestamps: [1000, 2000, 3000],
    }), deps);
    const last = api.calls.update[api.calls.update.length - 1].data;
    expect(last.promptChanges.map((c: any) => c.promptIndex)).toEqual([0, 1, 2]);
  });

  it('sends per-turn rows for ALL prompts every poll (not just the latest)', async () => {
    const api = mockApi();
    const deps = baseDeps(api);
    await reconcileSession(scanned(), fakeAdapter(), deps);            // first capture
    await reconcileSession(scanned(), fakeAdapter({ userPrompts: ['first prompt', 'second prompt', 'third'], promptTimestamps: [1000, 2000, 3000] }), deps); // more prompts
    expect(api.startSession).toHaveBeenCalledTimes(1); // session reused
    const lastUpdate = api.calls.update[api.calls.update.length - 1].data;
    // Every prompt attributed each poll — so a multi-prompt session shows changes
    // on the right turn, not only the last.
    expect(lastUpdate.promptChanges.map((c: any) => c.promptIndex)).toEqual([0, 1, 2]);
  });

  it('attributes each prompt its OWN per-turn diff from the transcript', async () => {
    const api = mockApi();
    const adapter = fakeAdapter({
      userPrompts: ['read the repo', 'create pulya with 24 rows', 'add 4 lines'],
      promptTimestamps: [1000, 2000, 3000],
      promptDiffs: [
        { promptIndex: 0, filesChanged: [], diff: '', linesAdded: 0, linesRemoved: 0 },           // read-only
        { promptIndex: 1, filesChanged: ['/repo/a/pulya'], diff: '+r'.repeat(1) + '\n'.repeat(0), linesAdded: 24, linesRemoved: 0 },
        { promptIndex: 2, filesChanged: ['/repo/a/pulya'], diff: '+a\n+b\n+c\n+d', linesAdded: 4, linesRemoved: 0 },
      ],
    });
    await reconcileSession(scanned({ cwd: '/repo/a' }), adapter, baseDeps(api));
    const pc = api.calls.update[0].data.promptChanges;
    expect(pc[0].filesChanged).toEqual([]);          // read-only prompt: no changes
    expect(pc[0].linesAdded).toBe(0);
    expect(pc[1].filesChanged).toEqual(['pulya']);   // create: +24
    expect(pc[1].linesAdded).toBe(24);
    expect(pc[2].filesChanged).toEqual(['pulya']);   // increment: +4 (not the commit's total)
    expect(pc[2].linesAdded).toBe(4);
  });

  it('marks an idle session ENDED', async () => {
    const api = mockApi();
    const deps = baseDeps(api);
    // Seed a running session.
    await reconcileSession(scanned(), fakeAdapter(), deps);
    // Same session, but the transcript hasn't been written in > idleMs.
    const old = Date.now() - 25 * 60 * 1000;
    await reconcileSession(scanned({ mtimeMs: old }), fakeAdapter(), deps);
    const ended = api.calls.update[api.calls.update.length - 1];
    expect(ended.data.status).toBe('ENDED');
    expect(loadSessionState('fake', 'conv-123', stateDir)?.status).toBe('ENDED');
  });

  it('skips a session the adapter flags as noise', async () => {
    const api = mockApi();
    const adapter = { ...fakeAdapter(), isNoise: () => true };
    const res = await reconcileSession(scanned(), adapter, baseDeps(api));
    expect(res).toBeNull();
    expect(api.startSession).not.toHaveBeenCalled();
  });

  it('writes the .git session-state file so git hooks can attribute commits/PRs/blame', async () => {
    const api = mockApi();
    const saveGitState = vi.fn();
    const registerSnapshot = vi.fn(async () => {});
    const deps = baseDeps(api, { saveGitState, registerSnapshot });
    await reconcileSession(
      scanned({ cwd: '/repo/a' }),
      fakeAdapter({ userPrompts: ['create mumuka'], promptTimestamps: [1000], filesChanged: ['/repo/a/mumuka'] }),
      deps,
    );
    expect(saveGitState).toHaveBeenCalledTimes(1);
    const [state, workRoot, tag] = saveGitState.mock.calls[0];
    expect(state.sessionId).toBe('sess-1');          // SERVER session id (for api + notes)
    expect(state.claudeSessionId).toBe('conv-123');  // required by loadSessionState
    expect(state.agentSessionId).toBe('conv-123');
    expect(state.sessionTag).toBe('conv-123');
    expect(state.canonicalRepoPath).toBe('/repo/a');
    expect(state.status).toBe('RUNNING');
    expect(workRoot).toBe('/repo/a');
    expect(tag).toBe('conv-123');
  });

  it('reports files-changed from the transcript (not the late tree diff) and registers a snapshot', async () => {
    const api = mockApi();
    const registerSnapshot = vi.fn(async () => {});
    // The tree diff returns NO files (baseline captured after the edit), but the
    // transcript knows the agent wrote mumuka.
    const deps = baseDeps(api, {
      registerSnapshot,
      captureDiff: () => ({ diff: '', filesChanged: [], linesAdded: 0, linesRemoved: 0 }),
    });
    await reconcileSession(
      scanned({ cwd: '/repo/a' }),
      fakeAdapter({ userPrompts: ['create mumuka'], promptTimestamps: [1000], filesChanged: ['/repo/a/mumuka'] }),
      deps,
    );
    const latest = api.calls.update[0].data.promptChanges.find((c: any) => c.promptIndex === 0);
    expect(latest.filesChanged).toEqual(['mumuka']);
    expect(registerSnapshot).toHaveBeenCalledTimes(1);
    expect((registerSnapshot.mock.calls[0] as any[])[2].filesChanged).toEqual(['mumuka']);
  });

  // createSnapshot's dedup only refuses a snapshot when the whole tree is clean
  // or byte-identical to the last one. On a repo carrying pre-existing dirt that
  // never fires, so a chat-only turn used to get a snapshot stamped on it and
  // wear a green dot in the Session view next to an empty diff.
  it('does not snapshot a chat-only turn that inherits earlier prompts\' files', async () => {
    const api = mockApi();
    const registerSnapshot = vi.fn(async () => {});
    const deps = baseDeps(api, {
      registerSnapshot,
      // No tree movement attributable to the latest prompt.
      captureDiff: () => ({ diff: '', filesChanged: [], linesAdded: 0, linesRemoved: 0 }),
    });
    await reconcileSession(
      scanned({ cwd: '/repo/a' }),
      fakeAdapter({
        userPrompts: ['add rows to mumuka', 'thanks, looks good'],
        promptTimestamps: [1000, 2000],
        // Session-wide file list — prompt 0 wrote it, prompt 1 only chatted.
        filesChanged: ['/repo/a/mumuka'],
        promptDiffs: [
          { promptIndex: 0, filesChanged: ['/repo/a/mumuka'], diff: '+row', linesAdded: 1, linesRemoved: 0 },
        ],
      }),
      deps,
    );
    expect(registerSnapshot).not.toHaveBeenCalled();
  });

  // The skip must not latch: a turn polled before its edit lands reads empty,
  // and has to still be eligible once the edit shows up.
  it('snapshots a prompt on a later poll once its edit lands', async () => {
    const api = mockApi();
    const registerSnapshot = vi.fn(async () => {});
    const emptyDiff = { diff: '', filesChanged: [], linesAdded: 0, linesRemoved: 0 };
    const deps = baseDeps(api, { registerSnapshot, captureDiff: () => emptyDiff });

    const chatOnly = fakeAdapter({
      userPrompts: ['add rows to mumuka', 'now add one to cocain'],
      promptTimestamps: [1000, 2000],
      filesChanged: ['/repo/a/mumuka'],
      promptDiffs: [
        { promptIndex: 0, filesChanged: ['/repo/a/mumuka'], diff: '+row', linesAdded: 1, linesRemoved: 0 },
      ],
    });
    await reconcileSession(scanned({ cwd: '/repo/a' }), chatOnly, deps);
    expect(registerSnapshot).not.toHaveBeenCalled();

    // Next poll: prompt 1's edit is now in the transcript.
    const withEdit = fakeAdapter({
      userPrompts: ['add rows to mumuka', 'now add one to cocain'],
      promptTimestamps: [1000, 2000],
      filesChanged: ['/repo/a/mumuka', '/repo/a/cocain'],
      promptDiffs: [
        { promptIndex: 0, filesChanged: ['/repo/a/mumuka'], diff: '+row', linesAdded: 1, linesRemoved: 0 },
        { promptIndex: 1, filesChanged: ['/repo/a/cocain'], diff: '+row', linesAdded: 1, linesRemoved: 0 },
      ],
    });
    await reconcileSession(scanned({ cwd: '/repo/a' }), withEdit, deps);
    expect(registerSnapshot).toHaveBeenCalledTimes(1);
    expect((registerSnapshot.mock.calls[0] as any[])[2].promptIndex).toBe(1);
  });

  it('falls back to the transcript-derived diff when the tree diff is empty (uncommitted in-flight prompt)', async () => {
    const api = mockApi();
    // Tree diff empty (baseline captured after the edit), but the transcript
    // carries the edit as a +5 diff for the latest prompt.
    const deps = baseDeps(api, {
      captureDiff: () => ({ diff: '', filesChanged: [], linesAdded: 0, linesRemoved: 0 }),
    });
    const adapter = fakeAdapter({
      userPrompts: ['add 5 more rows'],
      promptTimestamps: [1000],
      filesChanged: ['/repo/a/cocain'],
      promptDiffs: [{ promptIndex: 0, filesChanged: ['/repo/a/cocain'], diff: '+Row 21\n+Row 22\n+Row 23\n+Row 24\n+Row 25', linesAdded: 5, linesRemoved: 0 }],
    });
    await reconcileSession(scanned({ cwd: '/repo/a' }), adapter, deps);
    const latest = api.calls.update[0].data.promptChanges.find((c: any) => c.promptIndex === 0);
    expect(latest.uncommittedDiff).toContain('Row 25');
    expect(latest.linesAdded).toBe(5);
    expect(latest.filesChanged).toEqual(['cocain']);
  });

  it('a turn window polluted by a foreign merge reports only its OWN files', async () => {
    // Prod fdf299d3 turn 10. A sibling session merged during the turn, and the
    // baseline..worktree window — which exists to catch work no transcript
    // records — swept the whole merge in. The row showed 17 files, exactly that
    // commit's, and none of the files the turn had actually edited.
    //
    // Here the window sees both `mine.ts` (ours) and `theirs.ts` (from a commit
    // we do not own). Only ours may survive, and the counts must be re-measured
    // for the survivors: a filtered file list with the window's original counts
    // is the mosaic shape, not a fix.
    const api = mockApi();
    const deps = baseDeps(api, {
      captureGit: () => ({
        headBefore: 'b'.repeat(40), headAfter: 'c'.repeat(40),
        commitShas: ['s1bl1ng'],
        commitDetails: [
          { sha: 's1bl1ng', message: 'their merge', author: 'other', filesChanged: ['theirs.ts'], linesAdded: 177, linesRemoved: 37 },
        ],
        diff: '', diffTruncated: false, linesAdded: 177, linesRemoved: 37,
      }),
      captureDiff: () => ({
        diff: 'diff --git a/theirs.ts\n+++', filesChanged: ['theirs.ts', 'mine.ts'],
        linesAdded: 178, linesRemoved: 37,
      }),
      captureFilesDiff: (_root, files) => ({
        diff: files.includes('mine.ts') ? 'diff --git a/mine.ts\n+x' : '',
        filesChanged: files, linesAdded: 1, linesRemoved: 0,
      }),
    });
    // No transcript file list — a shell-write turn. That is what makes the
    // unscoped window run at all; with candidate files the branch above it
    // answers first and the window is never consulted.
    await reconcileSession(scanned(), fakeAdapter({
      userPrompts: ['do my edit'],
      promptTimestamps: [1],
      filesChanged: [],
      promptDiffs: [{ promptIndex: 0, filesChanged: [], diff: '', linesAdded: 0, linesRemoved: 0 }],
    }), deps);

    const pc = (api.calls.update[api.calls.update.length - 1]?.data?.promptChanges || [])[0];
    expect(pc.filesChanged).not.toContain('theirs.ts');
    expect(pc.linesAdded).toBe(1);
    expect(pc.linesRemoved).toBe(0);
  });

  it('keeps a file the agent edited even when a foreign commit also touched it', async () => {
    // Overlap is the dangerous direction: our change really is in the tree, and
    // dropping the file to fix an over-report would lose real work.
    const api = mockApi();
    const deps = baseDeps(api, {
      captureGit: () => ({
        headBefore: 'b'.repeat(40), headAfter: 'c'.repeat(40),
        commitShas: ['s1bl1ng'],
        commitDetails: [
          { sha: 's1bl1ng', message: 'theirs', author: 'other', filesChanged: ['shared.ts'], linesAdded: 9, linesRemoved: 0 },
        ],
        diff: '', diffTruncated: false, linesAdded: 9, linesRemoved: 0,
      }),
      captureDiff: () => ({
        diff: 'diff --git a/shared.ts\n+x', filesChanged: ['shared.ts'],
        linesAdded: 10, linesRemoved: 0,
      }),
      // Declines, so the unscoped window below is the one that answers.
      captureFilesDiff: () => ({ diff: '', filesChanged: [], linesAdded: 0, linesRemoved: 0 }),
    });
    await reconcileSession(scanned(), fakeAdapter({
      userPrompts: ['edit the shared file'],
      promptTimestamps: [1],
      filesChanged: ['/repo/a/shared.ts'],
      promptDiffs: [{ promptIndex: 0, filesChanged: [], diff: '', linesAdded: 0, linesRemoved: 0 }],
    }), deps);

    const pc = (api.calls.update[api.calls.update.length - 1]?.data?.promptChanges || [])[0];
    expect(pc.filesChanged).toContain('shared.ts');
  });
  it('does not record a CONCURRENT session\'s commit as this session\'s own', async () => {
    // The headShaAtStart..HEAD walk sees every commit made in the repo during
    // the session, including other agents'. It used to be merged straight into
    // `sessionCommitShas` — one line below a comment saying it must never be
    // treated as this session's commits — and then persisted, handed to the
    // extractor, and read by the per-commit memory writer.
    //
    // Prod fdf299d3 turn 10 is the result: its 17 files are exactly commit
    // 9f811c65f, made by a concurrent session, while its own three edited files
    // appear nowhere on the row.
    //
    // `foreign.ts` is touched by no prompt here, so nothing in this session can
    // legitimately claim that commit.
    const api = mockApi();
    const deps = baseDeps(api, {
      captureGit: () => ({
        headBefore: 'b'.repeat(40), headAfter: 'c'.repeat(40),
        commitShas: ['f0re1gn'],
        commitDetails: [
          { sha: 'f0re1gn', message: 'someone else\'s work', author: 'other', filesChanged: ['foreign.ts'], linesAdded: 177, linesRemoved: 37 },
        ],
        diff: '', diffTruncated: false, linesAdded: 177, linesRemoved: 37,
      }),
    });
    await reconcileSession(scanned(), fakeAdapter({
      userPrompts: ['edit mine'],
      promptTimestamps: [1],
      filesChanged: ['/repo/a/mine.ts'],
      promptDiffs: [{ promptIndex: 0, filesChanged: ['/repo/a/mine.ts'], diff: '+x', linesAdded: 1, linesRemoved: 0 }],
    }), deps);

    const st = loadSessionState('fake', 'conv-123', stateDir);
    expect(st?.sessionCommitShas || []).not.toContain('f0re1gn');
    // And it must not be pinned to the turn either — the pairing passes test
    // file overlap, and this commit touches nothing this session edited.
    const sent = api.calls.update[api.calls.update.length - 1]?.data;
    const shas = (sent?.promptChanges || []).map((pc: any) => pc.commitSha).filter(Boolean);
    expect(shas).not.toContain('f0re1gn');
  });

  it('still pairs a commit that DOES touch this session\'s files', async () => {
    // The other direction: the pairing passes legitimately consider commits
    // seen in the window, so a real commit must still land. Losing this is how
    // a fix for the above would silently break commit attribution.
    const api = mockApi();
    const deps = baseDeps(api, {
      captureGit: () => ({
        headBefore: 'b'.repeat(40), headAfter: 'c'.repeat(40),
        commitShas: ['m1ne'],
        commitDetails: [
          { sha: 'm1ne', message: 'mine', author: 'me', filesChanged: ['mine.ts'], linesAdded: 1, linesRemoved: 0 },
        ],
        diff: '', diffTruncated: false, linesAdded: 1, linesRemoved: 0,
      }),
    });
    await reconcileSession(scanned(), fakeAdapter({
      userPrompts: ['edit and commit'],
      promptTimestamps: [1],
      filesChanged: ['/repo/a/mine.ts'],
      promptsThatCommitted: [0],
      promptDiffs: [{ promptIndex: 0, filesChanged: ['/repo/a/mine.ts'], diff: '+x', linesAdded: 1, linesRemoved: 0 }],
    }), deps);

    const sent = api.calls.update[api.calls.update.length - 1]?.data;
    const shas = (sent?.promptChanges || []).map((pc: any) => pc.commitSha).filter(Boolean);
    expect(shas).toContain('m1ne');
  });

  it('pairs commits with the turns that actually ran git commit (deterministic, stable)', async () => {
    const api = mockApi();
    // Two commits; turns 2 and 4 (0-based) ran `git commit`. Every turn edited
    // the SAME file, which is exactly the case the old file-overlap heuristic got
    // wrong (both commits collapsed onto one turn, flipping between polls).
    const deps = baseDeps(api, {
      captureGit: () => ({
        headBefore: 'b'.repeat(40), headAfter: 'c'.repeat(40),
        commitShas: ['aaa1', 'bbb2'],
        commitDetails: [
          { sha: 'aaa1', message: 'first', author: 'x', filesChanged: ['f.txt'], linesAdded: 5, linesRemoved: 0 },
          { sha: 'bbb2', message: 'second', author: 'x', filesChanged: ['f.txt'], linesAdded: 3, linesRemoved: 0 },
        ],
        diff: '', diffTruncated: false, linesAdded: 8, linesRemoved: 0,
      }),
    });
    const adapter: TranscriptAdapter = {
      ...fakeAdapter({
        userPrompts: ['look', 'edit', 'edit+commit', 'edit', 'edit+commit'],
        promptTimestamps: [1, 2, 3, 4, 5],
        filesChanged: ['/repo/a/f.txt'],
        promptsThatCommitted: [2, 4],
        promptDiffs: [0, 1, 2, 3, 4].map((i) => ({
          promptIndex: i, filesChanged: i === 0 ? [] : ['/repo/a/f.txt'], diff: i === 0 ? '' : '+x', linesAdded: i === 0 ? 0 : 1, linesRemoved: 0,
        })),
      }),
    };
    await reconcileSession(scanned({ cwd: '/repo/a' }), adapter, deps);
    const pc = api.calls.update[0].data.promptChanges;
    // Oldest commit → first committing turn; newest → last committing turn.
    expect(pc[2].commitSha).toBe('aaa1');
    expect(pc[4].commitSha).toBe('bbb2');
    // Non-committing turns carry no commit.
    expect(pc[0].commitSha).toBeUndefined();
    expect(pc[1].commitSha).toBeUndefined();
    expect(pc[3].commitSha).toBeUndefined();
  });

  // Cursor records no file-edit when the agent works through the terminal, so
  // that turn's transcript mapping is empty. The working-tree recovery only
  // runs for the LATEST turn, so a turn that was never latest (two prompts in
  // one poll) stayed blank forever — grey badge, missing from "N with changes"
  // — despite having produced a commit. Session 7ff68eb7 turn 1.
  const committingTurnNoEdits = (over: Partial<ParsedSession> = {}) => ({
    ...fakeAdapter({
      userPrompts: ['create it', 'add 5 more rows and commit', 'add 7 more rows'],
      promptTimestamps: [1, 2, 3],
      filesChanged: ['/repo/a/shisha'],
      promptsThatCommitted: [1],
      promptDiffs: [
        { promptIndex: 0, filesChanged: ['/repo/a/shisha'], diff: '+a', linesAdded: 11, linesRemoved: 0 },
        { promptIndex: 1, filesChanged: [], diff: '', linesAdded: 0, linesRemoved: 0 }, // terminal edit → nothing
        { promptIndex: 2, filesChanged: ['/repo/a/shisha'], diff: '+c', linesAdded: 12, linesRemoved: 0 },
      ],
      ...over,
    }),
  });
  const oneCommit = () => ({
    headBefore: 'b'.repeat(40), headAfter: 'c'.repeat(40),
    commitShas: ['e815b214'],
    commitDetails: [{ sha: 'e815b214', message: 'Add five more rows', author: 'x', filesChanged: ['shisha'], linesAdded: 16, linesRemoved: 0 }],
    diff: '', diffTruncated: false, linesAdded: 16, linesRemoved: 0,
  });

  it('recovers a committing turn that recorded no edits, scoped to its own contribution', async () => {
    const api = mockApi();
    const captureCommitScoped = vi.fn(() => ({ diff: '+r1\n+r2\n+r3\n+r4\n+r5', linesAdded: 5, linesRemoved: 0 }));
    const deps = baseDeps(api, { captureGit: oneCommit, captureCommitScoped });
    await reconcileSession(scanned({ cwd: '/repo/a' }), committingTurnNoEdits() as TranscriptAdapter, deps);
    const pc = api.calls.update[0].data.promptChanges;
    // The blank turn now carries its OWN delta (+5), not the commit's headline
    // +16 (which includes the previous turn's 11 lines).
    expect(pc[1].linesAdded).toBe(5);
    expect(pc[1].filesChanged).toEqual(['shisha']);
    expect(pc[1].uncommittedDiff).toContain('+r5');
    expect(captureCommitScoped).toHaveBeenCalledWith('/repo/a', expect.any(String), 'e815b214', ['shisha']);
    // Turns that DID record edits are untouched.
    expect(pc[0].linesAdded).toBe(11);
    expect(pc[2].linesAdded).toBe(12);
  });

  it('leaves the turn alone when the scoped recovery finds nothing', async () => {
    const api = mockApi();
    const deps = baseDeps(api, {
      captureGit: oneCommit,
      captureCommitScoped: () => ({ diff: '', linesAdded: 0, linesRemoved: 0 }),
    });
    await reconcileSession(scanned({ cwd: '/repo/a' }), committingTurnNoEdits() as TranscriptAdapter, deps);
    const pc = api.calls.update[0].data.promptChanges;
    expect(pc[1].linesAdded).toBe(0);
    // An empty payload must NOT claim authority — that is what let a blank poll
    // wipe a good capture from an earlier one and make the turn permanently grey.
    expect(pc[1].authoritative).toBeUndefined();
    // Turns that carry content still assert authority.
    expect(pc[0].authoritative).toBe(true);
  });

  it('survives a throwing scoped recovery', async () => {
    const api = mockApi();
    const deps = baseDeps(api, {
      captureGit: oneCommit,
      captureCommitScoped: () => { throw new Error('git exploded'); },
    });
    await reconcileSession(scanned({ cwd: '/repo/a' }), committingTurnNoEdits() as TranscriptAdapter, deps);
    expect(api.calls.update[0].data.promptChanges[1].linesAdded).toBe(0);
  });

  it('ends the .git session-state file when the session goes idle', async () => {
    const api = mockApi();
    const endGitState = vi.fn();
    const deps = baseDeps(api, { saveGitState: vi.fn(), endGitState });
    await reconcileSession(scanned({ cwd: '/repo/a' }), fakeAdapter(), deps);        // running
    await reconcileSession(scanned({ cwd: '/repo/a', mtimeMs: Date.now() - 25 * 60 * 1000 }), fakeAdapter(), deps); // idle
    expect(endGitState).toHaveBeenCalledWith('/repo/a', 'conv-123');
  });

  // Regression: the watcher redid the FULL pass for every live session on every
  // 8s poll — including the ~20 minutes after the agent had gone quiet, where
  // the transcript is untouched and the answer is byte-identical. On Windows the
  // daemon has no console, so each git child of that wasted pass opened its own
  // console window: a finished Antigravity session kept flashing black windows
  // until it aged out.
  it('does no work at all when neither the transcript nor HEAD moved', async () => {
    const api = mockApi();
    const captureDiff = vi.fn(() => ({ diff: 'diff --git', filesChanged: ['src/x.ts'], linesAdded: 3, linesRemoved: 1 }));
    const deps = baseDeps(api, { captureDiff });
    // Real file, same reason as above: an unreadable transcript has an unknown
    // size, and unknown never satisfies the guard.
    const file = path.join(tmp, 'unmoved.jsonl');
    fs.writeFileSync(file, '{"role":"user","content":"first prompt"}\n');
    const s = scanned({ transcriptPath: file, mtimeMs: fs.statSync(file).mtimeMs });
    await reconcileSession(s, fakeAdapter(), deps);
    expect(api.updateSession).toHaveBeenCalledTimes(1);
    const diffCalls = captureDiff.mock.calls.length;
    expect(diffCalls).toBeGreaterThan(0); // the first pass really did git work

    // Same transcript, same HEAD — the identical poll, 8 seconds later.
    const again = await reconcileSession(s, fakeAdapter(), deps);
    expect(api.updateSession).toHaveBeenCalledTimes(1);   // nothing re-sent
    expect(captureDiff.mock.calls.length).toBe(diffCalls); // no git children spawned
    expect(again?.originSessionId).toBe('sess-1');         // state preserved
  });

  it('still reconciles when a turn WROTE inside one mtime tick, adding no prompt', async () => {
    // #1289 closed the mtime tie for a new PROMPT, by adding the prompt count to
    // the guard. A turn's WORK is the other half and does not move that count:
    // tool calls, file edits and the assistant's reply all append to the same
    // turn. That is also the likelier shape — a session's final write is almost
    // always assistant/tool content, not a new user prompt — and if it lands in
    // the tick the last poll read, the guard skips it and nothing ever bumps
    // mtime again.
    //
    // Same mtime, same prompt count, same HEAD, more bytes. Only the size term
    // can tell these two polls apart.
    const api = mockApi();
    const deps = baseDeps(api);
    const file = path.join(tmp, 'grew-same-turn.jsonl');
    fs.writeFileSync(file, '{"role":"user","content":"first prompt"}\n');
    const frozen = scanned({ transcriptPath: file, mtimeMs: fs.statSync(file).mtimeMs });

    await reconcileSession(frozen, fakeAdapter(), deps);
    expect(api.updateSession).toHaveBeenCalledTimes(1);

    // The turn does its work: appended content, no new prompt, mtime pinned.
    fs.appendFileSync(file, '{"role":"assistant","tool":"Edit","file":"src/x.ts"}\n');
    await reconcileSession(frozen, fakeAdapter(), deps);
    expect(api.updateSession).toHaveBeenCalledTimes(2);
  });

  // ─── The agent's own name for the conversation ──────────────────────────────
  //
  // #1443 taught the READER to find Claude Code's generated `ai-title`, and
  // fixed nothing the user could see: it wired the name into the hook path
  // only (session-end + stop). On Windows the GUI clients fire no hooks — the
  // entire reason this watcher exists — so every watcher-captured session kept
  // shipping Origin's own generated title next to the name the agent showed.
  // Prod session e38434a2 read "Generated Random Code For Testing" while its
  // transcript on disk carried `custom-title: "Claude capture validation test"`.
  it("sends the adapter's session name on the PATCH", async () => {
    const api = mockApi();
    const deps = baseDeps(api);
    const named = { ...fakeAdapter(), sessionName: () => 'Claude capture validation test' };
    await reconcileSession(scanned(), named, deps);
    expect(api.calls.update[0].data.agentSessionName).toBe('Claude capture validation test');
  });

  it('omits the field entirely for an agent that names nothing', async () => {
    // Codex, Antigravity, Copilot and Gemini keep no conversation title. The
    // field has to leave the wire entirely, not go out blank: a session the
    // HOOK path already named (macOS, where hooks fire and both producers run)
    // would otherwise have that name overwritten every 8 seconds by a watcher
    // that simply could not read it.
    const api = mockApi();
    const deps = baseDeps(api);
    await reconcileSession(scanned(), fakeAdapter(), deps);
    expect(onTheWire(api.calls.update[0].data).agentSessionName).toBeUndefined();
  });

  it('picks up a name that only exists on a LATER poll', async () => {
    // This is the normal Claude Code shape, not an edge case: the terminal REPL
    // generates its `ai-title` from the first prompt AFTER that turn is already
    // on disk, so the name does not exist at all when the watcher first adopts
    // the session. Read once at adoption and it would never arrive — which is
    // also why /session/start doesn't carry it.
    const api = mockApi();
    const deps = baseDeps(api);
    let name: string | null = null;
    const late: TranscriptAdapter = { ...fakeAdapter(), sessionName: () => name };
    const s = scanned();

    await reconcileSession(s, late, deps);
    expect(onTheWire(api.calls.update[0].data).agentSessionName).toBeUndefined();

    name = 'Debug the flaky watcher test';
    await reconcileSession({ ...s, mtimeMs: s.mtimeMs + 1 }, late, deps);
    expect(api.calls.update[1].data.agentSessionName).toBe('Debug the flaky watcher test');
  });

  it('captures the turn anyway when the name lookup throws', async () => {
    // Cursor's name comes from a sqlite file it holds a write lock on. A
    // failed read is a normal transient; losing the whole poll's capture over
    // a cosmetic field is not.
    const api = mockApi();
    const deps = baseDeps(api);
    const broken: TranscriptAdapter = {
      ...fakeAdapter(),
      sessionName: () => { throw new Error('database is locked'); },
    };
    await reconcileSession(scanned(), broken, deps);
    expect(api.updateSession).toHaveBeenCalledTimes(1);
    expect(onTheWire(api.calls.update[0].data).agentSessionName).toBeUndefined();
    expect(api.calls.update[0].data.transcript).toBe('the transcript');
  });

  it('still reconciles when the transcript grew', async () => {
    const api = mockApi();
    const deps = baseDeps(api);
    const s = scanned();
    await reconcileSession(s, fakeAdapter(), deps);
    await reconcileSession({ ...s, mtimeMs: s.mtimeMs + 1 }, fakeAdapter(), deps);
    expect(api.updateSession).toHaveBeenCalledTimes(2);
  });

  // A commit made outside the agent's own transcript (the user committing in a
  // terminal) is the one thing that changes what we'd send without touching the
  // file — so HEAD moving has to break the skip.
  it('still reconciles when HEAD moved under an untouched transcript', async () => {
    const api = mockApi();
    let head = 'b'.repeat(40);
    const deps = baseDeps(api, { getHead: () => head });
    const s = scanned();
    await reconcileSession(s, fakeAdapter(), deps);
    head = 'd'.repeat(40);
    await reconcileSession(s, fakeAdapter(), deps);
    expect(api.updateSession).toHaveBeenCalledTimes(2);
  });

  // Regression: a session the server had disowned kept being PATCHed under the
  // same dead id every poll — "Session not found" every 8 seconds for hours,
  // each one preceded by a full git pass that could never be delivered.
  it('drops a session id the server no longer knows and re-creates it', async () => {
    const api = mockApi();
    api.updateSession.mockRejectedValueOnce(new Error('Session not found'));
    const deps = baseDeps(api);
    const s = scanned();
    const first = await reconcileSession(s, fakeAdapter(), deps);
    expect(first?.originSessionId).toBeNull();

    // Next poll starts a session again rather than retrying the dead id.
    await reconcileSession({ ...s, mtimeMs: s.mtimeMs + 1 }, fakeAdapter(), deps);
    expect(api.startSession).toHaveBeenCalledTimes(2);
    expect(loadSessionState('fake', 'conv-123', stateDir)?.originSessionId).toBe('sess-2');
  });

  it('keeps the session id when the update fails for any other reason', async () => {
    const api = mockApi();
    api.updateSession.mockRejectedValueOnce(new Error('socket hang up'));
    const deps = baseDeps(api);
    const st = await reconcileSession(scanned(), fakeAdapter(), deps);
    expect(st?.originSessionId).toBe('sess-1');
  });

  it('skips when the cwd is not resolvable to a repo', async () => {
    const api = mockApi();
    const deps = baseDeps(api, { resolveRepo: () => null });
    const res = await reconcileSession(scanned({ cwd: null }), fakeAdapter({ filePaths: [] }), deps);
    expect(res).toBeNull();
    expect(api.startSession).not.toHaveBeenCalled();
  });
});

// ─── runWatchCycle ──────────────────────────────────────────────────────────────

describe('runWatchCycle', () => {
  it('reconciles every adapter and survives one that throws', async () => {
    const api = mockApi();
    const good: TranscriptAdapter = { ...fakeAdapter(), slug: 'good', agentSlugForServer: 'good', listActive: () => [scanned({ sessionId: 'g1' })] };
    const boom: TranscriptAdapter = { slug: 'boom', agentSlugForServer: 'boom', listActive: () => { throw new Error('store gone'); }, parse: () => null };
    await runWatchCycle([boom, good], baseDeps(api));
    // The throwing adapter didn't stop the good one from creating its session.
    expect(api.startSession).toHaveBeenCalledTimes(1);
    expect(api.calls.start[0].agentSlug).toBe('good');
  });

  it('collapses multiple transcript files with the SAME session id into one reconcile (newest wins)', async () => {
    const api = mockApi();
    // One conversation surfacing as two files (e.g. a chat log + a checkpoint).
    const dup: TranscriptAdapter = {
      ...fakeAdapter(),
      slug: 'dup', agentSlugForServer: 'dup',
      listActive: () => [
        scanned({ sessionId: 'same', transcriptPath: '/old', mtimeMs: Date.now() - 60_000 }),
        scanned({ sessionId: 'same', transcriptPath: '/new', mtimeMs: Date.now() }),
      ],
    };
    await runWatchCycle([dup], baseDeps(api));
    // Exactly one session created for the conversation — not two forked ones.
    expect(api.startSession).toHaveBeenCalledTimes(1);
  });
});

// ─── auto-start gating + single-instance ─────────────────────────────────────────

describe('auto-start gating', () => {
  const orig = process.env.ORIGIN_TRANSCRIPT_WATCH;
  afterEach(() => { if (orig === undefined) delete process.env.ORIGIN_TRANSCRIPT_WATCH; else process.env.ORIGIN_TRANSCRIPT_WATCH = orig; });

  it('is Windows-only by default, overridable by env', () => {
    delete process.env.ORIGIN_TRANSCRIPT_WATCH;
    expect(transcriptWatchAutoStartEnabled('win32')).toBe(true);
    expect(transcriptWatchAutoStartEnabled('darwin')).toBe(false);
    expect(transcriptWatchAutoStartEnabled('linux')).toBe(false);
    process.env.ORIGIN_TRANSCRIPT_WATCH = '1';
    expect(transcriptWatchAutoStartEnabled('linux')).toBe(true);
    process.env.ORIGIN_TRANSCRIPT_WATCH = '0';
    expect(transcriptWatchAutoStartEnabled('win32')).toBe(false);
  });
});

describe('single-instance guard', () => {
  it('detects a live foreign pid and a superseded self', () => {
    const pidFile = path.join(tmp, 'twatch.pid');
    fs.writeFileSync(pidFile, String(process.pid)); // our own pid → not "another"
    expect(anotherWatcherRunning(pidFile)).toBe(false);
    expect(watcherSuperseded(pidFile)).toBe(false);
    fs.writeFileSync(pidFile, String(process.pid + 1)); // a different pid → superseded
    expect(watcherSuperseded(pidFile)).toBe(true);
  });
});

// ─── Adapter discovery (real parsers, fixture stores under a fake HOME) ───────────

function withFakeHome(dir: string) {
  vi.spyOn(os, 'homedir').mockReturnValue(dir);
}

describe('claude adapter', () => {
  it('discovers recent project transcripts, reads cwd from the file, ignores stale + subagent files', () => {
    const homeDir = path.join(tmp, 'home');
    const proj = path.join(homeDir, '.claude', 'projects', 'C--soft-origin');
    fs.mkdirSync(proj, { recursive: true });
    const sid = '317b73d5-5aed-40a9-9105-717c93b02dd2';
    const lines = [
      JSON.stringify({ type: 'attachment', cwd: 'C:\\soft\\origin', sessionId: sid, gitBranch: 'main' }),
      JSON.stringify({ type: 'user', message: { role: 'user', content: [{ type: 'text', text: 'do the thing' }] }, cwd: 'C:\\soft\\origin', timestamp: new Date().toISOString() }),
      JSON.stringify({ type: 'assistant', message: { role: 'assistant', model: 'claude-opus-4-8', usage: { input_tokens: 10, output_tokens: 20 }, content: [{ type: 'text', text: 'ok' }] }, id: 'm1' }),
    ];
    fs.writeFileSync(path.join(proj, `${sid}.jsonl`), lines.join('\n') + '\n');
    // A stale file — outside the active window — must be ignored.
    const stale = path.join(proj, 'old-session.jsonl');
    fs.writeFileSync(stale, JSON.stringify({ type: 'user', cwd: 'C:\\x', message: { role: 'user', content: [] } }) + '\n');
    const t = (Date.now() - 8 * 60 * 60 * 1000) / 1000;
    fs.utimesSync(stale, t, t);
    // A subagent transcript in a nested dir must NOT be picked up.
    const subDir = path.join(proj, sid, 'subagents');
    fs.mkdirSync(subDir, { recursive: true });
    fs.writeFileSync(path.join(subDir, 'agent-x.jsonl'), '{}\n');

    withFakeHome(homeDir);
    const active = claudeAdapter.listActive(Date.now());
    expect(active.map((a) => a.sessionId)).toEqual([sid]);
    expect(active[0].cwd).toBe('C:\\soft\\origin');

    const parsed = claudeAdapter.parse(active[0].transcriptPath);
    expect(parsed?.userPrompts).toContain('do the thing');
    expect(parsed?.model).toBe('claude-opus-4-8');
  });
});

describe('copilot adapter', () => {
  it('discovers events.jsonl per session dir with the dir name as session id', () => {
    const homeDir = path.join(tmp, 'home');
    const sessDir = path.join(homeDir, '.copilot', 'session-state', 'cop-1');
    fs.mkdirSync(sessDir, { recursive: true });
    fs.writeFileSync(path.join(sessDir, 'events.jsonl'), JSON.stringify({ type: 'session.start', data: {}, timestamp: new Date().toISOString() }) + '\n');
    withFakeHome(homeDir);
    const active = copilotAdapter.listActive(Date.now());
    expect(active.map((a) => a.sessionId)).toEqual(['cop-1']);
    expect(active[0].cwd).toBeNull();
  });
});

describe('gemini adapter', () => {
  it('takes only chats/session-<id>.json (stable id), ignoring checkpoint files', () => {
    const homeDir = path.join(tmp, 'home');
    const ws = path.join(homeDir, '.gemini', 'tmp', 'abc123hash');
    fs.mkdirSync(path.join(ws, 'chats'), { recursive: true });
    fs.mkdirSync(path.join(ws, 'checkpoints'), { recursive: true });
    // Real session file — embeds the id in its name.
    fs.writeFileSync(path.join(ws, 'chats', 'session-conv-9.json'), JSON.stringify({ messages: [{ role: 'user', content: 'hi' }] }));
    // Checkpoint — no stable id; must NOT be surfaced (would fork/collide).
    fs.writeFileSync(path.join(ws, 'checkpoints', 'checkpoint.json'), JSON.stringify({ messages: [{ role: 'user', content: 'hi' }] }));
    withFakeHome(homeDir);
    const active = geminiAdapter.listActive(Date.now());
    expect(active.map((a) => a.sessionId)).toEqual(['conv-9']);
  });
});

describe('antigravity adapter', () => {
  it('discovers brain conversation transcripts at ~/.gemini/antigravity/brain', () => {
    const homeDir = path.join(tmp, 'home');
    const cid = 'agy-conv-1';
    const logs = path.join(homeDir, '.gemini', 'antigravity', 'brain', cid, '.system_generated', 'logs');
    fs.mkdirSync(logs, { recursive: true });
    fs.writeFileSync(path.join(logs, 'transcript_full.jsonl'), '{}\n');
    withFakeHome(homeDir);
    const active = antigravityAdapter.listActive(Date.now());
    expect(active.map((a) => a.sessionId)).toEqual([cid]);
    expect(active[0].transcriptPath.endsWith('transcript_full.jsonl')).toBe(true);
  });

  it('emits the transcript as a DisplayMessage[] JSON array (user+assistant), so responses render', () => {
    const homeDir = path.join(tmp, 'home');
    const cid = 'agy-resp';
    const logs = path.join(homeDir, '.gemini', 'antigravity', 'brain', cid, '.system_generated', 'logs');
    fs.mkdirSync(logs, { recursive: true });
    const lines = [
      JSON.stringify({ type: 'USER_INPUT', source: 'USER_EXPLICIT', content: '<USER_REQUEST>\ncheck the repo\n</USER_REQUEST>' }),
      JSON.stringify({ type: 'PLANNER_RESPONSE', source: 'MODEL', content: 'This repo is a demo sandbox.' }),
    ];
    fs.writeFileSync(path.join(logs, 'transcript_full.jsonl'), lines.join('\n') + '\n');
    withFakeHome(homeDir);
    const active = antigravityAdapter.listActive(Date.now());
    const parsed = antigravityAdapter.parse(active[0].transcriptPath)!;
    const msgs = JSON.parse(parsed.transcript); // must be valid JSON, not a markdown string
    expect(Array.isArray(msgs)).toBe(true);
    expect(msgs.map((m: any) => m.role)).toEqual(['user', 'assistant']);
    expect(msgs[1].content).toContain('demo sandbox');
  });

  it('falls back to the legacy antigravity-cli path and to transcript.jsonl', () => {
    const homeDir = path.join(tmp, 'home');
    const cid = 'agy-legacy';
    const logs = path.join(homeDir, '.gemini', 'antigravity-cli', 'brain', cid, '.system_generated', 'logs');
    fs.mkdirSync(logs, { recursive: true });
    // Only the short transcript exists here.
    fs.writeFileSync(path.join(logs, 'transcript.jsonl'), '{}\n');
    withFakeHome(homeDir);
    const active = antigravityAdapter.listActive(Date.now());
    expect(active.map((a) => a.sessionId)).toEqual([cid]);
    expect(active[0].transcriptPath.endsWith('transcript.jsonl')).toBe(true);
  });
});

// ─── startSession backoff ─────────────────────────────────────────────────────
// A repo the server refuses stays refused until a human registers it, so
// re-asking every poll can never succeed — it just hammers the API and buries
// the log. Observed live: the same rejection every ~10s for hours.

describe('startSession backoff', () => {
  const REJECTED = new Error('"C:\\soft\\origin" is not registered in Origin. Ask your admin to add it first.');

  function rejectingApi(err: Error) {
    const api = mockApi();
    api.startSession = vi.fn(async () => { throw err; });
    return api;
  }

  it('stops calling the API for a permanently-refused repo', async () => {
    const api = rejectingApi(REJECTED);
    let clock = 1_000_000;
    const deps = baseDeps(api, { now: () => clock });

    await reconcileSession(scanned(), fakeAdapter(), deps);
    expect(api.startSession).toHaveBeenCalledTimes(1);

    // Several more polls at the real 10s cadence — none should reach the API.
    for (let i = 0; i < 10; i++) {
      clock += 10_000;
      await reconcileSession(scanned(), fakeAdapter(), deps);
    }
    expect(api.startSession).toHaveBeenCalledTimes(1);
  });

  it('retries a refused repo once the 30-minute cooloff expires', async () => {
    const api = rejectingApi(REJECTED);
    let clock = 1_000_000;
    const deps = baseDeps(api, { now: () => clock });

    await reconcileSession(scanned(), fakeAdapter(), deps);
    clock += 29 * 60_000;
    await reconcileSession(scanned(), fakeAdapter(), deps);
    expect(api.startSession).toHaveBeenCalledTimes(1); // still cooling off

    clock += 2 * 60_000; // past 30 min
    await reconcileSession(scanned(), fakeAdapter(), deps);
    expect(api.startSession).toHaveBeenCalledTimes(2);
  });

  it('backs off transient failures on a widening interval, not a flat one', async () => {
    const api = rejectingApi(new Error('AbortError: This operation was aborted'));
    let clock = 1_000_000;
    const deps = baseDeps(api, { now: () => clock });

    await reconcileSession(scanned(), fakeAdapter(), deps);
    expect(api.startSession).toHaveBeenCalledTimes(1);

    clock += 20_000; // inside the first 30s window
    await reconcileSession(scanned(), fakeAdapter(), deps);
    expect(api.startSession).toHaveBeenCalledTimes(1);

    clock += 15_000; // past 30s
    await reconcileSession(scanned(), fakeAdapter(), deps);
    expect(api.startSession).toHaveBeenCalledTimes(2);

    // Window has doubled to 60s, so 35s is no longer enough.
    clock += 35_000;
    await reconcileSession(scanned(), fakeAdapter(), deps);
    expect(api.startSession).toHaveBeenCalledTimes(2);

    clock += 30_000;
    await reconcileSession(scanned(), fakeAdapter(), deps);
    expect(api.startSession).toHaveBeenCalledTimes(3);
  });

  it('a healthy repo is unaffected', async () => {
    const api = mockApi();
    let clock = 1_000_000;
    const deps = baseDeps(api, { now: () => clock });

    const st = await reconcileSession(scanned(), fakeAdapter(), deps);
    expect(api.startSession).toHaveBeenCalledTimes(1);
    expect(st?.originSessionId).toBe('sess-1');
  });

  it('scopes the cooloff per repo, so one bad repo cannot mute another', async () => {
    const api = mockApi();
    api.startSession = vi.fn(async (data: any) => {
      if (data.repoPath === '/repo/bad') throw REJECTED;
      return { sessionId: 'sess-ok' };
    });
    let clock = 1_000_000;
    const deps = baseDeps(api, { now: () => clock });

    await reconcileSession(scanned({ sessionId: 'c1', cwd: '/repo/bad' }), fakeAdapter(), deps);
    clock += 10_000;
    const good = await reconcileSession(scanned({ sessionId: 'c2', cwd: '/repo/good' }), fakeAdapter(), deps);
    expect(good?.originSessionId).toBe('sess-ok');
  });
});
