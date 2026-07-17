// The 'refs' session backend: one ref per session (refs/origin/sessions/<id>).
//
// Why it exists: the shared `origin-sessions` branch forces every writer
// through one ref. Even with the CAS retry loop that stopped the data loss,
// only one writer lands per round and every write re-reads/re-writes the whole
// accumulated tree. Per-session refs remove the shared ref entirely — writers
// touch disjoint refs, so there is nothing to contend on and nothing to retry.
//
// Reads must stay backwards compatible: sessions written on the branch before
// the switch have to remain readable afterwards.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { execFileSync, spawn } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';

// The agent script lives in a temp repo OUTSIDE the pnpm workspace, so
// `--import tsx` can't resolve tsx from there. Spawn from the package dir
// instead — CI runs vitest from the repo root, where it also wouldn't resolve.
// (All paths the agent touches are absolute, so cwd doesn't affect the test.)
const PKG_DIR = path.resolve(__dirname, '..', '..');

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf-8' }).trim();
}

// Each agent is its own process with the refs backend forced on via config.
const AGENT_SRC = `
import { writeSessionFiles } from '${path.resolve(__dirname, '../local-entrypoint.ts')}';
const [, , repoPath, sessionId, startAt] = process.argv;
while (Date.now() < Number(startAt)) { /* spin to a shared start */ }
writeSessionFiles(repoPath, {
  sessionId, model: 'claude-opus-4-8',
  startedAt: new Date().toISOString(), endedAt: new Date().toISOString(),
  durationMs: 1, status: 'ended', costUsd: 0, tokensUsed: 0,
  inputTokens: 0, outputTokens: 0, toolCalls: 0, linesAdded: 1, linesRemoved: 0,
  prompts: [{ index: 1, text: 'p-' + sessionId, filesChanged: [] }],
  filesChanged: [], git: { branch: 'main', headBefore: '', headAfter: '', commitShas: [] },
  summary: '', originUrl: '', changes: [],
});
`;

function makeRepo(): string {
  const repo = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'origin-refs-'));
  git(repo, 'init', '-q', '.');
  git(repo, 'config', 'user.email', 't@t.co');
  git(repo, 'config', 'user.name', 't');
  git(repo, 'config', 'commit.gpgsign', 'false');
  git(repo, 'commit', '-q', '--allow-empty', '-m', 'seed');
  return repo;
}

function baseData(sessionId: string) {
  return {
    sessionId,
    model: 'claude-opus-4-8',
    startedAt: new Date().toISOString(),
    endedAt: new Date().toISOString(),
    durationMs: 1,
    status: 'ended' as const,
    costUsd: 0,
    tokensUsed: 0,
    inputTokens: 0,
    outputTokens: 0,
    toolCalls: 0,
    linesAdded: 1,
    linesRemoved: 0,
    prompts: [{ index: 1, text: `p-${sessionId}`, filesChanged: [] }],
    filesChanged: [],
    git: { branch: 'main', headBefore: '', headAfter: '', commitShas: [] },
    summary: '',
    originUrl: '',
    changes: [],
  };
}

describe('session-store: hot-path backend vs publishing', () => {
  // These are deliberately independent. The hot path defaults to refs (fast, no
  // cross-agent contention); the branch is still produced, by publish. An
  // earlier design keyed the backend off "is the branch published?" — that
  // forced publishers back onto the contended hot-path branch write. Publish
  // now bridges the two, so the backend doesn't have to care.
  async function storeFor(config: Record<string, unknown>) {
    vi.resetModules();
    vi.doMock('../config.js', () => ({ loadConfig: () => config }));
    return import('../session-store.js');
  }

  afterEach(() => { vi.resetModules(); vi.restoreAllMocks(); });

  it('hot path is refs by default — connected or standalone', async () => {
    expect((await storeFor({})).getSessionBackend()).toBe('refs');
    expect((await storeFor({ apiKey: 'k', apiUrl: 'https://api' })).getSessionBackend()).toBe('refs');
    expect((await storeFor({ snapshotRepo: 'git@x:y.git' })).getSessionBackend()).toBe('refs');
  });

  it('an explicit session-backend=branch still opts back onto the branch', async () => {
    expect((await storeFor({ sessionBackend: 'branch' })).getSessionBackend()).toBe('branch');
  });

  it('builds the branch by default — INCLUDING connected mode', async () => {
    // The point of the change: a user who only ever runs the CLI, or an agent
    // cloning with no Origin at all, can't read the platform. The branch has to
    // be there for them regardless of whether this machine is signed in.
    const s = await storeFor({});
    expect(s.shouldBuildSessionBranch({ apiKey: 'k', apiUrl: 'https://api' } as any)).toBe(true);
    expect(s.shouldBuildSessionBranch({} as any)).toBe(true);
    expect(s.shouldPushSessionBranch({ apiKey: 'k', apiUrl: 'https://api' } as any)).toBe(true);
  });

  it("pushStrategy=prompt still BUILDS the branch — the user can't push what doesn't exist", async () => {
    // Regression: gating the build on the push decision left 'prompt' users
    // (who push via their own pre-push hook) with no branch to push.
    const s = await storeFor({});
    expect(s.shouldBuildSessionBranch({ pushStrategy: 'prompt' } as any)).toBe(true);
    expect(s.shouldPushSessionBranch({ pushStrategy: 'prompt' } as any)).toBe(false);
  });

  it('pushStrategy=false skips both — refs already serve every local read', async () => {
    const s = await storeFor({});
    expect(s.shouldBuildSessionBranch({ pushStrategy: 'false' } as any)).toBe(false);
    expect(s.shouldPushSessionBranch({ pushStrategy: 'false' } as any)).toBe(false);
  });
});

describe('session-store: refs backend', () => {
  let repo: string;

  beforeEach(() => {
    repo = makeRepo();
    vi.resetModules();
  });

  afterEach(() => {
    try { fs.rmSync(repo, { recursive: true, force: true }); } catch { /* ignore */ }
    vi.restoreAllMocks();
  });

  it('writes each session to its own ref and leaves no shared branch', async () => {
    vi.doMock('../config.js', () => ({ loadConfig: () => ({ sessionBackend: 'refs' }) }));
    const { writeSessionFiles } = await import('../local-entrypoint.js');

    writeSessionFiles(repo, baseData('sess-a') as any);
    writeSessionFiles(repo, baseData('sess-b') as any);

    const refs = git(repo, 'for-each-ref', '--format=%(refname)', 'refs/origin/sessions/');
    expect(refs.split('\n').sort()).toEqual([
      'refs/origin/sessions/sess-a',
      'refs/origin/sessions/sess-b',
    ]);
    // The shared branch must not be created at all under this backend.
    expect(() => git(repo, 'rev-parse', '--verify', 'refs/heads/origin-sessions')).toThrow();
  });

  it('reads back sessions from both backends after a switch', async () => {
    // 1. Write on the branch backend (the default), as a pre-switch user would.
    vi.doMock('../config.js', () => ({ loadConfig: () => ({ sessionBackend: 'branch' }) }));
    const branchMod = await import('../local-entrypoint.js');
    branchMod.writeSessionFiles(repo, baseData('legacy-1') as any);
    expect(git(repo, 'rev-parse', '--verify', 'refs/heads/origin-sessions')).toBeTruthy();

    // 2. Switch to refs and write a new session.
    vi.resetModules();
    vi.doMock('../config.js', () => ({ loadConfig: () => ({ sessionBackend: 'refs' }) }));
    const refsMod = await import('../local-entrypoint.js');
    refsMod.writeSessionFiles(repo, baseData('modern-1') as any);

    // 3. Both must still be listed and readable — switching is non-destructive.
    const store = await import('../session-store.js');
    expect(store.listSessionIds(repo).sort()).toEqual(['legacy-1', 'modern-1']);

    const legacy = store.readSessionFile(repo, 'legacy-1', 'metadata.json');
    expect(JSON.parse(legacy!).sessionId).toBe('legacy-1');
    const modern = store.readSessionFile(repo, 'modern-1', 'metadata.json');
    expect(JSON.parse(modern!).sessionId).toBe('modern-1');
  });

  it('publishes the BRANCH to the remote, not the session ref', async () => {
    vi.doMock('../config.js', () => ({
      loadConfig: () => ({ sessionBackend: 'refs', pushStrategy: 'auto' }),
    }));
    const { writeSessionFiles, pushSessionBranch } = await import('../local-entrypoint.js');

    const bare = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'origin-bare-')) + '.git';
    execFileSync('git', ['init', '-q', '--bare', bare]);
    git(repo, 'remote', 'add', 'origin', bare);

    writeSessionFiles(repo, baseData('pushed-1') as any);
    pushSessionBranch(repo, 'pushed-1');

    const remoteRefs = execFileSync('git', ['for-each-ref', '--format=%(refname)'], {
      cwd: bare, encoding: 'utf-8',
    }).trim().split('\n');
    // The branch is what a plain clone fetches, so that's what has to land.
    expect(remoteRefs).toContain('refs/heads/origin-sessions');
    // The session ref is a local implementation detail — pushing it would put
    // bytes on the remote that no fresh clone would ever fetch.
    expect(remoteRefs).not.toContain('refs/origin/sessions/pushed-1');

    try { fs.rmSync(bare, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  it('loses nothing when many agents write at once (no shared ref to contend on)', async () => {
    const N = 8;
    const ids = Array.from({ length: N }, (_, i) => `session-${i + 1}`);
    // Force the refs backend in the subprocesses via a repo-local config.
    const agentScript = path.join(repo, 'agent.mts');
    fs.writeFileSync(agentScript, AGENT_SRC);
    const home = path.join(repo, 'fakehome');
    fs.mkdirSync(path.join(home, '.origin'), { recursive: true });
    fs.writeFileSync(
      path.join(home, '.origin', 'config.json'),
      JSON.stringify({ sessionBackend: 'refs' }),
    );

    const startAt = Date.now() + 6000;
    const results = await Promise.all(
      ids.map(
        (id) =>
          new Promise<{ code: number | null; stderr: string }>((resolve) => {
            const p = spawn(
              process.execPath,
              ['--import', 'tsx', agentScript, repo, id, String(startAt)],
              { stdio: ['ignore', 'ignore', 'pipe'], cwd: PKG_DIR, env: { ...process.env, HOME: home } },
            );
            let stderr = '';
            p.stderr.on('data', (d) => { stderr += String(d); });
            p.on('close', (code) => resolve({ code, stderr }));
          }),
      ),
    );
    expect(results.find((r) => r.code !== 0)?.stderr ?? '', 'agents failed to run').toBe('');

    const refs = git(repo, 'for-each-ref', '--format=%(refname)', 'refs/origin/sessions/');
    const survivors = refs.split('\n').filter(Boolean).map((r) => r.split('/').pop()).sort();
    expect(survivors).toEqual([...ids].sort());
  }, 180_000);
});
