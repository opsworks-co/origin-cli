// The transcript watcher's session-level capture against a REAL repo: its
// session-start..HEAD walk holds whatever reached the branch meanwhile, and
// every sha it sends in `gitCapture.commitDetails` becomes a Commit row linked
// to the session for good (first claim wins on the server).
//
// Same failure as prod session 6c21a6d8 (2026-09-16) on the hook path, where a
// merge session served 45 commits for the 4 it wrote: a sibling session's
// commit replayed into the tree and GitHub squashes of other PRs.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { execFileSync } from 'child_process';
import {
  __resetStartSessionBackoff,
  reconcileSession,
  loadSessionState,
  saveSessionState,
  type WatchDeps,
  type SessionWatchState,
} from '../transcript-watch.js';
import type { TranscriptAdapter, ScannedTranscript, ParsedSession } from '../transcript-adapters.js';
import { captureGitState } from '../git-capture.js';
import { foreignWalkCommits, localCommitterEmail, readCommitOwnershipFactsBatch } from '../commit-ownership-facts.js';

let tmp = '';
let repo = '';
let stateDir = '';

const git = (args: string[], env: Record<string, string> = {}): string =>
  execFileSync('git', args, { cwd: repo, encoding: 'utf-8', env: { ...process.env, ...env } }).trim();

function commit(file: string, content: string, message: string, env: Record<string, string> = {}): string {
  fs.mkdirSync(path.dirname(path.join(repo, file)), { recursive: true });
  fs.writeFileSync(path.join(repo, file), content);
  git(['add', file]);
  git(['commit', '-q', '-m', message], env);
  return git(['rev-parse', 'HEAD']);
}
const GITHUB = { GIT_COMMITTER_NAME: 'GitHub', GIT_COMMITTER_EMAIL: 'noreply@github.com' };

function mockApi() {
  const calls = { update: [] as Array<{ id: string; data: any }> };
  return {
    calls,
    startSession: vi.fn(async () => ({ sessionId: 'sess-watch-0001' })),
    updateSession: vi.fn(async (id: string, data: any) => { calls.update.push({ id, data }); return {}; }),
  };
}

function deps(api: ReturnType<typeof mockApi>, withFacts = true): WatchDeps {
  return {
    now: () => Date.now(),
    idleMs: 20 * 60 * 1000,
    machineId: 'machine-1',
    hostname: 'host-1',
    stateDir,
    api,
    resolveRepo: (cwd: string) => ({ repoPath: cwd, workRoot: cwd, branch: 'main' }),
    createShadow: () => null,
    getHead: (root: string) => execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf-8' }).trim(),
    captureDiff: () => ({ diff: '', filesChanged: [], linesAdded: 0, linesRemoved: 0 }),
    captureGit: (root, headBefore, pre) => captureGitState(root, headBefore, { committedOnly: true, preSessionBaseline: pre }),
    ...(withFacts ? {
      commitFacts: (root: string, shas: string[]) => ({
        facts: readCommitOwnershipFactsBatch(root, shas), localEmail: localCommitterEmail(root),
      }),
    } : {}),
    loadState: (slug: string, id: string) => loadSessionState(slug, id, stateDir),
    saveState: (s: SessionWatchState) => saveSessionState(s, stateDir),
  };
}

function adapter(parsed: Partial<ParsedSession>): TranscriptAdapter {
  const full: ParsedSession = {
    userPrompts: ['edit mine and commit'], promptTimestamps: [1], transcript: 't', model: 'm',
    tokensUsed: 1, inputTokens: 1, outputTokens: 0, toolCalls: 0,
    filePaths: [], filesChanged: [], promptDiffs: [], ...parsed,
  };
  return { slug: 'fake', agentSlugForServer: 'fake-agent', listActive: () => [], parse: () => full };
}
const scanned = (): ScannedTranscript => ({ sessionId: 'conv-watch-1', transcriptPath: '/nope', cwd: repo, mtimeMs: Date.now() });
const lastCapture = (api: ReturnType<typeof mockApi>) => api.calls.update.at(-1)?.data?.gitCapture;
const same = (a: string, b: string) => a.startsWith(b) || b.startsWith(a);

beforeEach(() => {
  __resetStartSessionBackoff();
  tmp = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'twatch-foreign-')));
  repo = path.join(tmp, 'repo');
  stateDir = path.join(tmp, 'state');
  fs.mkdirSync(repo, { recursive: true });
  fs.mkdirSync(stateDir, { recursive: true });
  git(['init', '-q', '-b', 'main']);
  git(['config', 'user.name', 'Me']);
  git(['config', 'user.email', 'me@example.com']);
  commit('README.md', '# demo\n', 'base');
});
afterEach(() => { try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* best effort */ } });

describe('transcript watcher: the session capture carries only this session\'s commits', () => {
  it('drops a sibling session\'s commit and a GitHub squash, keeps its own and a hook-missed local commit', async () => {
    const api = mockApi();
    const parsed = {
      filesChanged: [path.join(repo, 'src/mine.ts')],
      promptsThatCommitted: [0],
      promptDiffs: [{ promptIndex: 0, filesChanged: [path.join(repo, 'src/mine.ts')], diff: '+x', linesAdded: 1, linesRemoved: 0 }],
    };
    // Poll 1 opens the session and pins headShaAtStart.
    await reconcileSession(scanned(), adapter(parsed), deps(api));

    const own = commit('src/mine.ts', 'export const mine = 1;\n', 'feat: mine\n\nOrigin-Session: sess-watch-0 | Fake | 1 prompt');
    const sibling = commit('src/sibling.ts', 'export const s = 1;\n', 'feat: sibling\n\nOrigin-Session: 0ther-sess10 | Claude Code | 3 prompts\nOrigin-Session: sess-watch-0 | Fake | 1 prompt');
    // A pulled squash of somebody's PR that ALSO touched our file — it overlaps
    // our edits, which is what used to let the file-overlap pairing take it.
    const squash = commit('src/mine.ts', 'export const mine = 2;\n', 'fix: upstream (#99)', GITHUB);
    const untrailered = commit('src/local.ts', 'export const l = 1;\n', 'chore: local commit the hook missed');

    await reconcileSession(scanned(), adapter(parsed), deps(api));

    const gc = lastCapture(api);
    expect(gc, 'no session capture was sent').toBeDefined();
    const sent = [...(gc.commitShas || []), ...(gc.commitDetails || []).map((d: any) => d.sha)];
    expect(sent.filter((s: string) => same(s, sibling) || same(s, squash)), 'foreign commits reached the session').toEqual([]);
    expect(gc.commitShas.some((s: string) => same(s, own))).toBe(true);
    expect(gc.commitShas.some((s: string) => same(s, untrailered))).toBe(true);
    expect(gc.commitDetails.map((d: any) => d.sha).sort()).toEqual([own, untrailered].sort());
    // The range diff held the squash's lines; what is sent is a snapshot of
    // owned commits or no diff at all — never the range.
    expect(String(gc.diff || '')).not.toContain('mine = 2');

    // And no turn is paired with the squash.
    const turnShas = (api.calls.update.at(-1)?.data?.promptChanges || []).map((pc: any) => pc.commitSha).filter(Boolean);
    expect(turnShas.filter((s: string) => same(s, squash))).toEqual([]);
  });

  it('sends no session capture at all when every walked commit is somebody else\'s', async () => {
    const api = mockApi();
    await reconcileSession(scanned(), adapter({}), deps(api));
    commit('src/sibling.ts', 'export const s = 1;\n', 'feat: sibling\n\nOrigin-Session: 0ther-sess10 | Claude Code | 3 prompts');
    commit('src/upstream.ts', 'export const u = 1;\n', 'fix: upstream (#98)', GITHUB);
    await reconcileSession(scanned(), adapter({}), deps(api));
    expect(lastCapture(api)).toBeUndefined();
  });

  it('without ownership facts the walk is sent as before', async () => {
    const api = mockApi();
    await reconcileSession(scanned(), adapter({}), deps(api, false));
    const squash = commit('src/upstream.ts', 'export const u = 1;\n', 'fix: upstream (#98)', GITHUB);
    await reconcileSession(scanned(), adapter({}), deps(api, false));
    expect(lastCapture(api)?.commitShas).toEqual([squash]);
  });
});

describe('foreignWalkCommits', () => {
  it('keeps an owned commit whatever its trailer says, and drops one committed before the session', () => {
    const early = commit('a.ts', '1\n', 'early');
    const amended = commit('b.ts', '1\n', 'mine, trailer from before an amend\n\nOrigin-Session: stale-id-000 | Fake | 1 prompt');
    const facts = readCommitOwnershipFactsBatch(repo, [early, amended]);
    const startedAt = new Date(Date.now() + 5_000).toISOString();
    const foreign = foreignWalkCommits([early, amended], facts, {
      sessionIds: ['sess-watch-0001'], owned: [amended.slice(0, 12)], startedAt, localEmail: 'me@example.com',
    });
    expect([...foreign]).toEqual([early]);
  });

  it('keeps a commit git cannot describe', () => {
    const foreign = foreignWalkCommits(['deadbeef'.repeat(5)], new Map(), {
      sessionIds: ['sess-watch-0001'], owned: [], localEmail: 'me@example.com',
    });
    expect(foreign.size).toBe(0);
  });
});
