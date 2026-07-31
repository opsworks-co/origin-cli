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

  it('ends the .git session-state file when the session goes idle', async () => {
    const api = mockApi();
    const endGitState = vi.fn();
    const deps = baseDeps(api, { saveGitState: vi.fn(), endGitState });
    await reconcileSession(scanned({ cwd: '/repo/a' }), fakeAdapter(), deps);        // running
    await reconcileSession(scanned({ cwd: '/repo/a', mtimeMs: Date.now() - 25 * 60 * 1000 }), fakeAdapter(), deps); // idle
    expect(endGitState).toHaveBeenCalledWith('/repo/a', 'conv-123');
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
