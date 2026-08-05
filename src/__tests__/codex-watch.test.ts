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
    // Default: no shadow-range delta, so tests that predate sealing keep
    // exercising the latest-diff / text-backfill paths unchanged.
    captureRangeDiff: () => ({ diff: '', filesChanged: [], linesAdded: 0, linesRemoved: 0 }),
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

// Two user turns, each with its own apply_patch, landing inside ONE poll. A git
// working-tree snapshot (mock captureDiff → linesAdded:1) could only show the
// latest turn's total; the rollout-derived per-turn diff must give each turn its
// OWN add count (+2 for turn 0, +3 for turn 1). Regression guard for the
// "fast consecutive turns lose their per-prompt diff" bug.
function writeRolloutWithPatches(threadId: string, cwd: string): string {
  const dir = path.join(sessionsDir, '2026', '07', '24');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `rollout-2026-07-24T10-00-00-${threadId}.jsonl`);
  const patchInput = (body: string) =>
    `const patch = "${body.replace(/\n/g, '\\n')}";\ntext(await tools.apply_patch(patch));`;
  const p0 = '*** Begin Patch\n*** Add File: a.ts\n+one\n+two\n*** End Patch';
  const p1 = '*** Begin Patch\n*** Add File: b.ts\n+x\n+y\n+z\n*** End Patch';
  const lines = [
    { timestamp: '2026-07-24T10:00:05.000Z', type: 'session_meta', payload: { id: threadId, timestamp: '2026-07-24T10:00:00.000Z', cwd, originator: 'codex_cli_rs' } },
    { timestamp: '2026-07-24T10:00:10.000Z', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'first prompt' }] } },
    { payload: { type: 'custom_tool_call', name: 'exec', call_id: 'c0', input: patchInput(p0) } },
    { timestamp: '2026-07-24T10:00:12.000Z', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'second prompt' }] } },
    { payload: { type: 'custom_tool_call', name: 'exec', call_id: 'c1', input: patchInput(p1) } },
  ];
  fs.writeFileSync(file, lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
  return file;
}

describe('reconcileThread — rollout-derived per-turn diffs', () => {
  it('gives each of two same-poll turns its OWN diff from the rollout', async () => {
    const tid = '019f8754-1acd-70f1-bb8e-882eb975b5c0';
    const file = writeRolloutWithPatches(tid, '/repo/a');
    const api = mockApi();
    await reconcileThread(scan(file, tid, '/repo/a'), baseDeps(api));
    const update = api.calls.update.at(-1);
    const byIdx = (update.data.promptChanges as any[]).reduce((m, pc) => { m[pc.promptIndex] = pc; return m; }, {} as Record<number, any>);
    expect(byIdx[0].linesAdded).toBe(2);
    expect(byIdx[0].filesChanged).toEqual(['a.ts']);
    expect(byIdx[1].linesAdded).toBe(3);
    expect(byIdx[1].filesChanged).toEqual(['b.ts']);
    // The earlier turn is NOT a text-only backfill and NOT the git snapshot (1).
    expect(byIdx[0].diff).toContain('a.ts');
    expect(byIdx[1].diff).toContain('b.ts');
  });
});

// Codex often BUILDS the patch body at runtime, so the rollout stores the JS
// expression and the converter yields zero lines. That empty result must never
// suppress the git-snapshot path — regression guard for session 1ffc5f67, where
// "create 1 file with 88 rows" and "add 77 more" both captured +0 because the
// rollout branch swallowed the turn.
function writeRolloutRuntimePatch(threadId: string, cwd: string): string {
  const dir = path.join(sessionsDir, '2026', '08', '04');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `rollout-2026-08-04T04-54-45-${threadId}.jsonl`);
  // Verbatim shape from the real rollout: no literal +lines anywhere.
  const runtimeBuilt =
    'const lines = Array.from({length:88}, (_,i)=>`Line ${i+1}`); '
    + 'const patch = "*** Begin Patch\\n*** Add File: C:\\\\soft\\\\demo\\\\rows.txt\\n" '
    + '+ lines.map(x=>"+"+x).join("\\n") + "\\n*** End Patch";\n'
    + 'text(await tools.apply_patch(patch));';
  const lines = [
    { timestamp: '2026-08-04T04:54:45.000Z', type: 'session_meta', payload: { id: threadId, timestamp: '2026-08-04T04:54:40.000Z', cwd, originator: 'codex_cli_rs' } },
    { timestamp: '2026-08-04T04:54:50.000Z', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'create 1 file with 88 rows' }] } },
    { payload: { type: 'custom_tool_call', name: 'exec', call_id: 'c0', input: runtimeBuilt } },
  ];
  fs.writeFileSync(file, lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
  return file;
}

describe('reconcileThread — runtime-built apply_patch must not lose the diff', () => {
  it('falls back to the git snapshot when the rollout patch yields zero lines', async () => {
    const tid = '019fcae8-d99e-7bb1-838e-099734d53b89';
    const file = writeRolloutRuntimePatch(tid, '/repo/a');
    const api = mockApi();
    await reconcileThread(scan(file, tid, '/repo/a'), baseDeps(api));
    const update = api.calls.update.at(-1);
    const pc = (update.data.promptChanges as any[]).find((c) => c.promptIndex === 0);
    // baseDeps.captureDiff returns +1 / ['x'] — proof we used the git path
    // instead of pushing the converter's empty result.
    expect(pc.linesAdded).toBe(1);
    expect(pc.filesChanged).toEqual(['x']);
    expect(pc.diff).toContain('diff --git');
  });
});

// Codex Update-File sections carry a bare `@@` with no line ranges, so the
// converter can only place a hunk if the watcher hands it the file as it was at
// the start of the turn. Verbatim shape from real rollout 019fce00: the file
// `fikus` holds the rows 1..11 and the turn appends 12..16, so the hunk belongs
// at line 11 — it used to render at line 1 in the dashboard's "by prompt" view.
function writeRolloutFikus(threadId: string, cwd: string): string {
  const dir = path.join(sessionsDir, '2026', '07', '24');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `rollout-2026-07-24T10-00-00-${threadId}.jsonl`);
  const body = '*** Begin Patch\n*** Update File: /repo/a/fikus\n@@\n 11\n+12\n+13\n+14\n+15\n+16\n*** End Patch';
  const lines = [
    { timestamp: '2026-07-24T10:00:05.000Z', type: 'session_meta', payload: { id: threadId, timestamp: '2026-07-24T10:00:00.000Z', cwd, originator: 'codex_cli_rs' } },
    { timestamp: '2026-07-24T10:00:10.000Z', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'add 5 rows to it and commit' }] } },
    { payload: { type: 'custom_tool_call', name: 'exec', call_id: 'c0', input: `const patch = "${body.replace(/\n/g, '\\n')}";\ntext(await tools.apply_patch(patch));` } },
  ];
  fs.writeFileSync(file, lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
  return file;
}

describe('reconcileThread — anchoring per-prompt patch diffs to real line numbers', () => {
  const FIKUS = Array.from({ length: 11 }, (_, n) => String(n + 1)).join('\n') + '\n';
  // The user message is stamped 10:00:10Z; a `now` just after it makes the
  // shadow a trustworthy start-of-turn baseline.
  const ALIGNED_NOW = Date.parse('2026-07-24T10:00:10.500Z');
  const tid = '019fce00-d87b-76a1-85f5-42215c5517d1';
  const promptDiff = (api: ReturnType<typeof mockApi>) =>
    (api.calls.update.at(-1).data.promptChanges as any[]).find((c) => c.promptIndex === 0).diff as string;

  it('anchors the hunk to the file as it was at the START of the turn', async () => {
    const file = writeRolloutFikus(tid, '/repo/a');
    const api = mockApi();
    const read = vi.fn(() => FIKUS);
    await reconcileThread(scan(file, tid, '/repo/a'), baseDeps(api, { now: () => ALIGNED_NOW, readFileAtRev: read }));
    expect(read).toHaveBeenCalledWith('/repo/a', 'a'.repeat(40), 'fikus');
    expect(promptDiff(api)).toContain('@@ -11,1 +11,6 @@');
  });

  it('keeps the old sequential numbering when no baseline reader is injected', async () => {
    const file = writeRolloutFikus(tid, '/repo/a');
    const api = mockApi();
    await reconcileThread(scan(file, tid, '/repo/a'), baseDeps(api, { now: () => ALIGNED_NOW, readFileAtRev: undefined }));
    // Strictly additive: without the dep the output is byte-identical to before.
    expect(promptDiff(api)).toContain('@@ -1,1 +1,6 @@');
  });

  it('refuses a STALE shadow rather than anchoring against the wrong file state', async () => {
    // First capture back-creates shadows for prompts that ran long ago, so the
    // "baseline" is really the current tree — a plausible but wrong anchor.
    const file = writeRolloutFikus(tid, '/repo/a');
    const api = mockApi();
    const read = vi.fn(() => FIKUS);
    await reconcileThread(scan(file, tid, '/repo/a'), baseDeps(api, {
      now: () => Date.parse('2026-07-24T10:05:00.000Z'), // ~5 min after the prompt
      readFileAtRev: read,
    }));
    expect(read).not.toHaveBeenCalled();
    expect(promptDiff(api)).toContain('@@ -1,1 +1,6 @@');
  });

  it('still ships the diff when the baseline file cannot be read', async () => {
    const file = writeRolloutFikus(tid, '/repo/a');
    const api = mockApi();
    await reconcileThread(scan(file, tid, '/repo/a'), baseDeps(api, {
      now: () => ALIGNED_NOW,
      readFileAtRev: () => null,
    }));
    const pc = (api.calls.update.at(-1).data.promptChanges as any[]).find((c) => c.promptIndex === 0);
    expect(pc.linesAdded).toBe(5);
    expect(pc.diff).toContain('@@ -1,1 +1,6 @@');
  });

  it('reads each file once per turn even when several patches touch it', async () => {
    const file = writeRolloutFikus(tid, '/repo/a');
    const api = mockApi();
    const read = vi.fn(() => FIKUS);
    await reconcileThread(scan(file, tid, '/repo/a'), baseDeps(api, { now: () => ALIGNED_NOW, readFileAtRev: read }));
    expect(read).toHaveBeenCalledTimes(1);
  });

  // One turn, THREE apply_patch calls to the same file — Codex's normal shape
  // for "append some rows" follow-ups inside a single response. Each patch is
  // expressed against the file as IT saw it, so they cannot be concatenated:
  // the dashboard merges same-path blocks and rendered only the first patch's
  // lines. The turn is re-rendered as one real diff from start to end.
  it('renders a file patched repeatedly in one turn as a single real diff', async () => {
    const dir = path.join(sessionsDir, '2026', '07', '24');
    fs.mkdirSync(dir, { recursive: true });
    const rollout = path.join(dir, `rollout-2026-07-24T10-00-00-${tid}.jsonl`);
    const append = (ctx: number, rows: number[]) => {
      const body = ['*** Begin Patch', '*** Update File: /repo/a/fikus', '@@', ` ${ctx}`, ...rows.map((r) => `+${r}`), '*** End Patch'].join('\n');
      return `const patch = "${body.replace(/\n/g, '\\n')}";\ntext(await tools.apply_patch(patch));`;
    };
    const lines = [
      { timestamp: '2026-07-24T10:00:05.000Z', type: 'session_meta', payload: { id: tid, timestamp: '2026-07-24T10:00:00.000Z', cwd: '/repo/a', originator: 'codex_cli_rs' } },
      { timestamp: '2026-07-24T10:00:10.000Z', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'append rows in three goes' }] } },
      { payload: { type: 'custom_tool_call', name: 'exec', call_id: 'c0', input: append(11, [12, 13]) } },
      { payload: { type: 'custom_tool_call', name: 'exec', call_id: 'c1', input: append(13, [14, 15]) } },
      { payload: { type: 'custom_tool_call', name: 'exec', call_id: 'c2', input: append(15, [16]) } },
    ];
    fs.writeFileSync(rollout, lines.map((l) => JSON.stringify(l)).join('\n') + '\n');

    const api = mockApi();
    const read = vi.fn(() => FIKUS); // git only ever knows the 11-row file
    await reconcileThread(scan(rollout, tid, '/repo/a'), baseDeps(api, { now: () => ALIGNED_NOW, readFileAtRev: read }));
    const pc = (api.calls.update.at(-1).data.promptChanges as any[]).find((c) => c.promptIndex === 0);
    // ONE block for the file, positioned in the real file, holding ALL five
    // added rows — what git itself reports for the same edit.
    expect(pc.diff.match(/^diff --git /gm)).toHaveLength(1);
    expect(pc.diff).toContain('@@ -9,3 +9,8 @@');
    for (const row of [12, 13, 14, 15, 16]) expect(pc.diff).toContain(`+${row}`);
    expect(pc.linesAdded).toBe(5);
    expect(pc.linesRemoved).toBe(0);
    expect(read).toHaveBeenCalledTimes(1); // one git read for the whole turn
  });

  // The watcher's shadow is taken when it NOTICES the prompt, so Codex is often
  // already mid-edit — session 019fce3b's shadow held the file with the turn's
  // FIRST patch already applied. Anchoring must recognise an
  // already-applied patch instead of replaying it a second time (which
  // duplicated lines and made every later patch ambiguous).
  it('handles a shadow taken after some of the turn-s patches already landed', async () => {
    const dir = path.join(sessionsDir, '2026', '07', '24');
    fs.mkdirSync(dir, { recursive: true });
    const rollout = path.join(dir, `rollout-2026-07-24T10-00-00-${tid}.jsonl`);
    const append = (ctx: number, rows: number[]) => {
      const body = ['*** Begin Patch', '*** Update File: /repo/a/fikus', '@@', ` ${ctx}`, ...rows.map((r) => `+${r}`), '*** End Patch'].join('\n');
      return `const patch = "${body.replace(/\n/g, '\\n')}";\ntext(await tools.apply_patch(patch));`;
    };
    const lines = [
      { timestamp: '2026-07-24T10:00:05.000Z', type: 'session_meta', payload: { id: tid, timestamp: '2026-07-24T10:00:00.000Z', cwd: '/repo/a', originator: 'codex_cli_rs' } },
      { timestamp: '2026-07-24T10:00:10.000Z', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'append rows' }] } },
      { payload: { type: 'custom_tool_call', name: 'exec', call_id: 'c0', input: append(11, [12, 13]) } },
      { payload: { type: 'custom_tool_call', name: 'exec', call_id: 'c1', input: append(13, [14, 15]) } },
    ];
    fs.writeFileSync(rollout, lines.map((l) => JSON.stringify(l)).join('\n') + '\n');

    // The shadow already contains rows 12 and 13 — patch 0 had landed by the
    // time the watcher snapshotted the tree.
    const midTurn = Array.from({ length: 13 }, (_, n) => String(n + 1)).join('\n') + '\n';
    const api = mockApi();
    await reconcileThread(scan(rollout, tid, '/repo/a'), baseDeps(api, {
      now: () => ALIGNED_NOW,
      readFileAtRev: () => midTurn,
    }));
    const pc = (api.calls.update.at(-1).data.promptChanges as any[]).find((c) => c.promptIndex === 0);
    // The turn as a whole added 12..15 to the 11-row file.
    expect(pc.diff).toContain('@@ -9,3 +9,7 @@');
    for (const row of [12, 13, 14, 15]) expect(pc.diff).toContain(`+${row}`);
    expect(pc.diff).not.toContain('+11'); // no duplicated context from a double replay
    expect(pc.linesAdded).toBe(4);
  });
});

// A superseded turn used to be frozen at whatever the live capture saw, because
// its work is no longer in the working tree. Sealing recovers it from the
// shadow range (shadow[i] → shadow[i+1]) so older turns self-heal.
describe('reconcileThread — idle END must reach the server before latching', () => {
  const idleScan = (file: string, tid: string) => ({
    ...scan(file, tid, '/repo/a'),
    mtimeMs: Date.now() - 60 * 60 * 1000, // an hour idle
  });

  it('stays RUNNING (and retries next poll) when the end PATCH fails', async () => {
    const tid = '019f8754-1acd-70f1-bb8e-882eb975b5e1';
    const file = writeRollout(tid, '/repo/a', { prompts: ['hi'] });
    const api = mockApi();
    await reconcileThread(scan(file, tid, '/repo/a'), baseDeps(api)); // create session
    api.updateSession.mockRejectedValueOnce(new Error('network blip'));
    const st = await reconcileThread(idleScan(file, tid), baseDeps(api));
    expect(st?.status).toBe('RUNNING');
    expect(loadThreadState(tid, stateDir)?.status).toBe('RUNNING');
    // Next poll retries and succeeds.
    const st2 = await reconcileThread(idleScan(file, tid), baseDeps(api));
    expect(st2?.status).toBe('ENDED');
  });

  // The server allowlist is {RUNNING, COMPLETED, ERROR} and DROPS anything else
  // silently, so 'ENDED' PATCHed fine and did nothing — every watcher-captured
  // session stayed RUNNING. Assert the wire value is one the server accepts.
  it('sends a server-accepted terminal status, not the local ENDED vocabulary', async () => {
    const tid = '019f8754-1acd-70f1-bb8e-882eb975b5e3';
    const file = writeRollout(tid, '/repo/a', { prompts: ['hi'] });
    const api = mockApi();
    await reconcileThread(scan(file, tid, '/repo/a'), baseDeps(api));
    await reconcileThread(idleScan(file, tid), baseDeps(api));
    const sent = api.calls.update.at(-1).data.status;
    expect(sent).toBe('COMPLETED');
    expect(['RUNNING', 'COMPLETED', 'ERROR']).toContain(sent);
  });

  it('latches ENDED when the end PATCH succeeds', async () => {
    const tid = '019f8754-1acd-70f1-bb8e-882eb975b5e2';
    const file = writeRollout(tid, '/repo/a', { prompts: ['hi'] });
    const api = mockApi();
    await reconcileThread(scan(file, tid, '/repo/a'), baseDeps(api));
    const st = await reconcileThread(idleScan(file, tid), baseDeps(api));
    expect(st?.status).toBe('ENDED');
  });
});

describe('reconcileThread — sealing completed turns from the shadow range', () => {
  const RANGE = { diff: 'diff --git a/r b/r\n+sealed\n', filesChanged: ['r'], linesAdded: 42, linesRemoved: 3 };
  // Distinct shadow per prompt so shadow[i] and shadow[i+1] both exist.
  const perPromptShadow = () => {
    let n = 0;
    return () => String(n++).repeat(40).slice(0, 40);
  };
  // writeRollout stamps every user message 2026-07-24T10:00:10Z; pinning `now`
  // just after it makes the shadow prompt-aligned (lag 0.5s < SHADOW_ALIGN_MS).
  const ALIGNED_NOW = Date.parse('2026-07-24T10:00:10.500Z');

  it('heals an earlier turn with its true range diff instead of a text-only backfill', async () => {
    const tid = '019f8754-1acd-70f1-bb8e-882eb975b5d1';
    const file = writeRollout(tid, '/repo/a', { prompts: ['first', 'second'] });
    const api = mockApi();
    await reconcileThread(scan(file, tid, '/repo/a'), baseDeps(api, {
      now: () => ALIGNED_NOW,
      createShadow: perPromptShadow(),
      captureRangeDiff: () => RANGE,
    }));
    const update = api.calls.update.at(-1);
    const pc0 = (update.data.promptChanges as any[]).find((c) => c.promptIndex === 0);
    expect(pc0.linesAdded).toBe(42);
    expect(pc0.linesRemoved).toBe(3);
    expect(pc0.filesChanged).toEqual(['r']);
    expect(pc0.diff).toContain('sealed');
    // The latest turn still uses the live working-tree capture.
    const pc1 = (update.data.promptChanges as any[]).find((c) => c.promptIndex === 1);
    expect(pc1.linesAdded).toBe(1);
  });

  it('computes each turn ONCE — a sealed turn is not re-diffed on later polls', async () => {
    const tid = '019f8754-1acd-70f1-bb8e-882eb975b5d2';
    const file = writeRollout(tid, '/repo/a', { prompts: ['first', 'second'] });
    const api = mockApi();
    const spy = vi.fn(() => RANGE);
    const deps = () => baseDeps(api, { now: () => ALIGNED_NOW, createShadow: perPromptShadow(), captureRangeDiff: spy });
    await reconcileThread(scan(file, tid, '/repo/a'), deps());
    expect(spy).toHaveBeenCalledTimes(1);
    await reconcileThread(scan(file, tid, '/repo/a'), deps());
    expect(spy).toHaveBeenCalledTimes(1); // still 1 — sealed, never recomputed
    const st = loadThreadState(tid, stateDir);
    expect(st?.sealedPrompts).toEqual([0]);
  });

  it('never overwrites existing data when the range is empty (shadows identical)', async () => {
    const tid = '019f8754-1acd-70f1-bb8e-882eb975b5d3';
    const file = writeRollout(tid, '/repo/a', { prompts: ['first', 'second'] });
    const api = mockApi();
    await reconcileThread(scan(file, tid, '/repo/a'), baseDeps(api, {
      now: () => ALIGNED_NOW,
      createShadow: perPromptShadow(),
      captureRangeDiff: () => ({ diff: '', filesChanged: [], linesAdded: 0, linesRemoved: 0 }),
    }));
    const update = api.calls.update.at(-1);
    const pc0 = (update.data.promptChanges as any[]).find((c) => c.promptIndex === 0);
    // Falls back to the text-only backfill row — no zeroing diff is sent.
    expect(pc0.linesAdded).toBe(0);
    expect(pc0.diff).toBeUndefined();
  });

  it('REFUSES to seal from a late shadow that already absorbed the next turn', async () => {
    // Shadow taken 6s after the prompt started — by then Codex has applied the
    // next turn's edits, so the range would over-attribute (the +29/+0 failure).
    const tid = '019f8754-1acd-70f1-bb8e-882eb975b5d4';
    const file = writeRollout(tid, '/repo/a', { prompts: ['first', 'second'] });
    const api = mockApi();
    const spy = vi.fn(() => RANGE);
    await reconcileThread(scan(file, tid, '/repo/a'), baseDeps(api, {
      now: () => Date.parse('2026-07-24T10:00:16.000Z'), // 6s lag
      createShadow: perPromptShadow(),
      captureRangeDiff: spy,
    }));
    expect(spy).not.toHaveBeenCalled();
    const update = api.calls.update.at(-1);
    const pc0 = (update.data.promptChanges as any[]).find((c) => c.promptIndex === 0);
    expect(pc0.linesAdded).toBe(0); // untouched backfill, not an inflated range
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

  // Windows-only regression: two Codex sessions live in the same repo. The
  // cumulative headShaAtStart..HEAD walk sweeps in a commit a DIFFERENT thread
  // made after HEAD moved, and the older still-running thread stole it (session
  // 15234617's turn-3 commit went to the idle d09ee3c8). Scope by commit-time:
  // anything committed well after THIS thread's last rollout activity isn't its.
  it('drops a concurrent thread\'s later commit, keeping only its own', async () => {
    const tid = '019f8754-1acd-70f1-bb8e-882eb975b596';
    const file = writeRollout(tid, '/repo/a', { prompts: ['add rows and commit'] });
    const mtime = fs.statSync(file).mtimeMs; // this thread's last activity
    const api = mockApi();
    const own = 'a'.repeat(40);
    const foreign = 'f'.repeat(40);
    const captureGit = vi.fn(() => ({
      headBefore: 'b'.repeat(40), headAfter: foreign,
      commitShas: [own, foreign],
      commitDetails: [
        { sha: own, message: 'mine', author: 'd', filesChanged: ['x'], linesAdded: 5, linesRemoved: 0, committedAt: mtime - 60_000 },
        { sha: foreign, message: 'theirs', author: 'd', filesChanged: ['y'], linesAdded: 9, linesRemoved: 0, committedAt: mtime + 10 * 60_000 },
      ],
      diff: '', diffTruncated: false, linesAdded: 14, linesRemoved: 0,
    }));
    await reconcileThread(scan(file, tid, '/repo/a'), baseDeps(api, { captureGit }));
    const gc = api.calls.update.at(-1).data.gitCapture;
    expect(gc).toBeDefined();
    expect(gc.commitShas).toEqual([own]);                              // foreign dropped
    expect(gc.commitDetails.map((d: any) => d.sha)).toEqual([own]);
    expect(gc.linesAdded).toBe(5);                                     // re-totaled without foreign's 9
  });

  it('keeps a commit whose time is within the grace window after last activity', async () => {
    const tid = '019f8754-1acd-70f1-bb8e-882eb975b596';
    const file = writeRollout(tid, '/repo/a', { prompts: ['commit right before the poll'] });
    const mtime = fs.statSync(file).mtimeMs;
    const api = mockApi();
    const sha = 'c'.repeat(40);
    const captureGit = vi.fn(() => ({
      headBefore: 'b'.repeat(40), headAfter: sha, commitShas: [sha],
      commitDetails: [{ sha, message: 'fresh', author: 'd', filesChanged: ['x'], linesAdded: 3, linesRemoved: 0, committedAt: mtime + 30_000 }],
      diff: '', diffTruncated: false, linesAdded: 3, linesRemoved: 0,
    }));
    await reconcileThread(scan(file, tid, '/repo/a'), baseDeps(api, { captureGit }));
    expect(api.calls.update.at(-1).data.gitCapture.commitShas).toEqual([sha]);
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
    expect(st?.status).toBe('ENDED'); // LOCAL state vocabulary
    const endCall = api.calls.update.at(-1);
    // ON THE WIRE it must be a status the server actually accepts — it drops
    // 'ENDED' silently, which is what left every session showing RUNNING.
    expect(endCall.data.status).toBe('COMPLETED');
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
