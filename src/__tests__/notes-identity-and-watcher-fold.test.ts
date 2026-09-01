/**
 * Two reasons a repo's Origin memory can never become readable.
 *
 * Both were found on the same repo: notes fetched into staging, `origin
 * context memory` reporting "No session memory yet", and the payload — two
 * sessions and three commit records — sitting in .git the whole time.
 *
 *   1. NO GIT IDENTITY. `git notes add` builds an object, so it needs
 *      user.name/user.email exactly like `git commit-tree`. A box with none
 *      fails every note write with "unable to auto-detect email address", and
 *      because notes callers all swallow their errors (a note must never fail
 *      a commit or a session end) nothing surfaces. Attribution folds anyway —
 *      it uses `git update-ref`, which needs no identity — so the two halves of
 *      one fold visibly disagree, which is what made this findable at all.
 *      git-capture.ts already solved this for shadow commits; notes never got
 *      the same treatment.
 *
 *   2. THE WATCHER NEVER FOLDED. syncNotesForSessionStart carries the
 *      self-repair for a repo that fetched but never folded, and it was wired
 *      into hooks.ts alone. GUI agents on Windows fire no hooks — the entire
 *      reason the transcript watcher exists — so for exactly the agents it
 *      covers, nothing ever folded.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { execFileSync } from 'child_process';
import { gitIdentityEnv, ORIGIN_FALLBACK_IDENTITY, __resetGitIdentityProbe } from '../utils/exec.js';
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
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'notes-ident-'));
  stateDir = path.join(tmp, 'state');
  fs.mkdirSync(stateDir, { recursive: true });
  __resetStartSessionBackoff();
  __resetGitIdentityProbe();
});

afterEach(() => {
  vi.restoreAllMocks();
  __resetGitIdentityProbe();
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* ignore */ }
});

// --- 1. identity fallback ---------------------------------------------------

/** A repo with NO user.name/user.email of its own. */
function repoWithoutIdentity(): string {
  const dir = fs.mkdtempSync(path.join(tmp, 'noident-'));
  const opts = { cwd: dir, stdio: 'pipe' as const, windowsHide: true };
  execFileSync('git', ['init', '-q'], opts);
  // Isolate from the machine's global config, which may or may not carry one.
  execFileSync('git', ['config', '--local', 'user.useConfigOnly', 'true'], opts);
  return dir;
}

describe('git identity fallback for note writes', () => {
  it('supplies an identity when the repo has none', () => {
    const dir = repoWithoutIdentity();
    const env = gitIdentityEnv(dir);
    expect(env.GIT_COMMITTER_EMAIL).toBe(ORIGIN_FALLBACK_IDENTITY.GIT_COMMITTER_EMAIL);
    expect(env.GIT_AUTHOR_NAME).toBe('Origin');
  });

  it('defers to a real identity rather than overriding it', () => {
    // GIT_AUTHOR_* OVERRIDES config, so setting it unconditionally would stamp
    // "Origin" on notes written by users who do have a name configured.
    const dir = repoWithoutIdentity();
    const opts = { cwd: dir, stdio: 'pipe' as const, windowsHide: true };
    execFileSync('git', ['config', '--local', 'user.name', 'Real Person'], opts);
    execFileSync('git', ['config', '--local', 'user.email', 'real@example.com'], opts);
    __resetGitIdentityProbe();
    expect(gitIdentityEnv(dir)).toEqual({});
  });

  it('lets `git notes add` succeed in a repo with no identity', () => {
    // The end-to-end shape of the bug: without this env the write throws
    // "unable to auto-detect email address" and the caller swallows it.
    const dir = repoWithoutIdentity();
    const opts = { cwd: dir, stdio: 'pipe' as const, windowsHide: true, encoding: 'utf-8' as const };
    fs.writeFileSync(path.join(dir, 'f.txt'), 'x\n');
    execFileSync('git', ['add', '.'], opts);
    execFileSync('git', ['commit', '-q', '-m', 'seed'], {
      ...opts, env: { ...process.env, ...ORIGIN_FALLBACK_IDENTITY },
    });
    const sha = execFileSync('git', ['rev-parse', 'HEAD'], opts).trim();

    expect(() => execFileSync(
      'git', ['notes', '--ref=origin-memory', 'add', '-f', '-m', '{"version":2}', sha],
      { ...opts, env: { ...process.env, ...gitIdentityEnv(dir) } },
    )).not.toThrow();

    const back = execFileSync('git', ['notes', '--ref=origin-memory', 'show', sha], opts).trim();
    expect(back).toBe('{"version":2}');
  });
});

// --- 2. the watcher folds ---------------------------------------------------

function mockApi() {
  let n = 0;
  return {
    startSession: vi.fn(async () => ({ sessionId: `sess-${++n}` })),
    updateSession: vi.fn(async () => ({})),
  };
}

function adapter(): TranscriptAdapter {
  const full: ParsedSession = {
    userPrompts: ['do a thing'],
    promptTimestamps: [1_000],
    transcript: 't',
    model: 'claude-opus-4-8',
    tokensUsed: 1, inputTokens: 1, outputTokens: 0, toolCalls: 0,
    filePaths: [], filesChanged: [], promptDiffs: [],
  };
  return { slug: 'fake', agentSlugForServer: 'fake-agent', listActive: () => [], parse: () => full };
}

function deps(api: ReturnType<typeof mockApi>, over: Partial<WatchDeps> = {}): WatchDeps {
  return {
    now: () => Date.now(),
    idleMs: 20 * 60 * 1000,
    machineId: 'm', hostname: 'h', stateDir,
    api: api as any,
    resolveRepo: (cwd: string) => ({ repoPath: cwd, workRoot: cwd, repoUrl: 'git@github.com:o/r.git', branch: 'main' }),
    createShadow: () => 'a'.repeat(40),
    getHead: () => 'b'.repeat(40),
    captureDiff: () => ({ diff: '', filesChanged: [], linesAdded: 0, linesRemoved: 0 }),
    captureGit: () => ({
      headBefore: 'b'.repeat(40), headAfter: 'b'.repeat(40), commitShas: [], commitDetails: [],
      diff: '', diffTruncated: false, linesAdded: 0, linesRemoved: 0,
    }),
    loadState: (slug: string, sid: string) => loadSessionState(slug, sid, stateDir),
    saveState: (s: SessionWatchState) => saveSessionState(s, stateDir),
    ...over,
  };
}

const scanned = (): ScannedTranscript =>
  ({ sessionId: 'conv-1', transcriptPath: '/nope', cwd: '/repo/a', mtimeMs: Date.now() });

describe('watcher folds staged notes when it adopts a session', () => {
  it('syncs notes for the repo before opening the session', async () => {
    const api = mockApi();
    const syncNotes = vi.fn();
    await reconcileSession(scanned(), adapter(), deps(api, { syncNotes }));
    expect(syncNotes).toHaveBeenCalledWith('/repo/a');
  });

  it('does NOT re-sync on later polls of the same session', async () => {
    // Once per adopted session, not once per 8s tick — the fold is far too
    // expensive to pay on every poll (see hasUnfoldedStagedNotes).
    const api = mockApi();
    const syncNotes = vi.fn();
    const d = deps(api, { syncNotes });
    await reconcileSession(scanned(), adapter(), d);
    await reconcileSession(scanned(), adapter(), d);
    await reconcileSession(scanned(), adapter(), d);
    expect(syncNotes).toHaveBeenCalledTimes(1);
  });

  it('still captures when the sync throws', async () => {
    // Notes bookkeeping must never take capture down with it.
    const api = mockApi();
    const syncNotes = vi.fn(() => { throw new Error('offline'); });
    await reconcileSession(scanned(), adapter(), deps(api, { syncNotes }));
    expect(api.startSession).toHaveBeenCalled();
  });
});
