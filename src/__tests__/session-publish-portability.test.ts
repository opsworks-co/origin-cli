// Session context must survive from user to user THROUGH GIT.
//
// The requirement: someone may run the CLI standalone and never touch the
// platform, and an agent that clones the repo with no Origin tooling at all
// should still see what happened. Neither of those users can read the API.
//
// The constraint that shapes the design: `git clone` fetches refs/heads/* and
// refs/tags/* and NOTHING ELSE. Not refs/notes/* (git notes), not
// refs/origin/sessions/* (the per-session refs). Both of those can be pushed
// and still never reach a fresh clone. Measured directly in the first test
// below — it's the reason the shared `origin-sessions` BRANCH exists and the
// reason publish has to produce one.
//
// So: refs are the local hot-path store (fast, no cross-agent contention), and
// the branch is the published artifact (portable to anyone with plain git).
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { execFileSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf-8' }).trim();
}
function gitOk(cwd: string, ...args: string[]): boolean {
  try { git(cwd, ...args); return true; } catch { return false; }
}

function baseData(sessionId: string, over: Record<string, unknown> = {}) {
  return {
    sessionId,
    model: 'claude-opus-4-8',
    startedAt: new Date().toISOString(),
    endedAt: new Date().toISOString(),
    durationMs: 1,
    status: 'ended' as const,
    costUsd: 0.5,
    tokensUsed: 10,
    inputTokens: 5,
    outputTokens: 5,
    toolCalls: 1,
    linesAdded: 1,
    linesRemoved: 0,
    prompts: [{ index: 1, text: `why we did ${sessionId}`, filesChanged: ['a.txt'] }],
    filesChanged: ['a.txt'],
    git: { branch: 'main', headBefore: '', headAfter: '', commitShas: [] },
    summary: '',
    originUrl: '',
    changes: [],
    ...over,
  };
}

describe('session context survives to another user via git', () => {
  let repo: string;
  let bare: string;

  beforeEach(() => {
    const tmp = fs.realpathSync(os.tmpdir());
    bare = fs.mkdtempSync(path.join(tmp, 'origin-remote-')) + '.git';
    execFileSync('git', ['init', '-q', '--bare', bare]);
    repo = fs.mkdtempSync(path.join(tmp, 'origin-author-'));
    git(repo, 'init', '-q', '-b', 'main', '.');
    git(repo, 'config', 'user.email', 't@t.co');
    git(repo, 'config', 'user.name', 't');
    git(repo, 'config', 'commit.gpgsign', 'false');
    fs.writeFileSync(path.join(repo, 'a.txt'), 'work\n');
    git(repo, 'add', '-A');
    git(repo, 'commit', '-qm', 'the work');
    git(repo, 'remote', 'add', 'origin', bare);
    git(repo, 'push', '-q', 'origin', 'main');
    vi.resetModules();
  });

  afterEach(() => {
    for (const d of [repo, bare]) {
      try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* ignore */ }
    }
    vi.restoreAllMocks();
  });

  function cloneFresh(): string {
    const dest = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'origin-clone-'));
    fs.rmSync(dest, { recursive: true, force: true });
    execFileSync('git', ['clone', '-q', bare, dest]);
    return dest;
  }

  it('a plain clone receives branches but NOT notes or custom refs (why publish must produce a branch)', () => {
    // Push one of each, exactly as the CLI would.
    const sha = git(repo, 'rev-parse', 'HEAD');
    git(repo, 'notes', '--ref=origin', 'add', '-m', '{"prompt":"note payload"}', sha);
    git(repo, 'push', '-q', 'origin', 'refs/notes/origin:refs/notes/origin');
    const blob = execFileSync('git', ['hash-object', '-w', '--stdin'], {
      cwd: repo, input: '{"sessionId":"x"}', encoding: 'utf-8',
    }).trim();
    execFileSync('git', ['read-tree', '--empty'], { cwd: repo, env: { ...process.env, GIT_INDEX_FILE: path.join(repo, '.git', 'ti') } });
    execFileSync('git', ['update-index', '--add', '--cacheinfo', `100644,${blob},sessions/x/metadata.json`], { cwd: repo, env: { ...process.env, GIT_INDEX_FILE: path.join(repo, '.git', 'ti') } });
    const tree = execFileSync('git', ['write-tree'], { cwd: repo, encoding: 'utf-8', env: { ...process.env, GIT_INDEX_FILE: path.join(repo, '.git', 'ti') } }).trim();
    const commit = git(repo, 'commit-tree', tree, '-m', 'session x');
    git(repo, 'update-ref', 'refs/heads/origin-sessions', commit);
    git(repo, 'push', '-q', 'origin', 'origin-sessions');
    git(repo, 'update-ref', 'refs/origin/sessions/x', commit);
    git(repo, 'push', '-q', 'origin', 'refs/origin/sessions/x:refs/origin/sessions/x');

    // All three are on the remote…
    const onRemote = git(bare, 'for-each-ref', '--format=%(refname)').split('\n');
    expect(onRemote).toEqual(expect.arrayContaining([
      'refs/heads/origin-sessions', 'refs/notes/origin', 'refs/origin/sessions/x',
    ]));

    // …but a fresh clone only gets the BRANCH.
    const fresh = cloneFresh();
    expect(gitOk(fresh, 'show', 'origin/origin-sessions:sessions/x/metadata.json')).toBe(true);
    expect(gitOk(fresh, 'notes', '--ref=origin', 'show', git(fresh, 'rev-parse', 'HEAD'))).toBe(false);
    expect(gitOk(fresh, 'rev-parse', '--verify', 'refs/origin/sessions/x')).toBe(false);
    fs.rmSync(fresh, { recursive: true, force: true });
  });

  it('refs backend: hot-path write stays local, publish puts it on the branch for a fresh clone', async () => {
    // Standalone-ish config: refs on the hot path, publishing on.
    vi.doMock('../config.js', () => ({
      loadConfig: () => ({ sessionBackend: 'refs', pushStrategy: 'auto' }),
    }));
    const { writeSessionFiles, pushSessionBranch } = await import('../local-entrypoint.js');

    // 1. Hot path: per-prompt write. Local ref only — no branch, nothing pushed.
    writeSessionFiles(repo, baseData('sess-1') as any);
    expect(gitOk(repo, 'rev-parse', '--verify', 'refs/origin/sessions/sess-1')).toBe(true);
    expect(gitOk(repo, 'rev-parse', '--verify', 'refs/heads/origin-sessions')).toBe(false);

    // 2. Publish moment (commit / session end): branch built + pushed.
    pushSessionBranch(repo, 'sess-1');
    expect(gitOk(repo, 'rev-parse', '--verify', 'refs/heads/origin-sessions')).toBe(true);

    // 3. THE REQUIREMENT: a different user, plain clone, no Origin tooling.
    const fresh = cloneFresh();
    const meta = git(fresh, 'show', 'origin/origin-sessions:sessions/sess-1/metadata.json');
    expect(JSON.parse(meta).sessionId).toBe('sess-1');
    // ...and the prompt — the "why" behind the code — travels with it.
    const prompts = git(fresh, 'show', 'origin/origin-sessions:sessions/sess-1/prompts.md');
    expect(prompts).toContain('why we did sess-1');
    fs.rmSync(fresh, { recursive: true, force: true });
  });

  it('the published branch explains itself to someone with no Origin tooling', async () => {
    // Whoever clones this has no Origin by definition — the branch is the only
    // thing that reached them, so it has to say what it is and how to read it,
    // including the one command that brings per-commit notes down (git clone
    // never fetches refs/notes/*).
    vi.doMock('../config.js', () => ({
      loadConfig: () => ({ sessionBackend: 'refs', pushStrategy: 'auto' }),
    }));
    const { writeSessionFiles, pushSessionBranch } = await import('../local-entrypoint.js');

    writeSessionFiles(repo, baseData('readme-1') as any);
    pushSessionBranch(repo, 'readme-1');

    const fresh = cloneFresh();
    const readme = git(fresh, 'show', 'origin/origin-sessions:README.md');
    expect(readme).toContain('git fetch origin refs/notes/origin:refs/notes/origin');
    expect(readme).toContain('git log --show-notes=origin');
    // It must not recommend the refspec that destroys unpushed local notes.
    expect(readme).not.toContain("'+refs/notes/origin:refs/notes/origin'");
    fs.rmSync(fresh, { recursive: true, force: true });
  });

  it('connected mode publishes too (a CLI-only user is not on the platform)', async () => {
    // This is the behaviour change: connected mode used to skip the push
    // entirely because "the data is on the API" — which is no help to someone
    // who never signs in.
    vi.doMock('../config.js', () => ({
      loadConfig: () => ({ apiKey: 'k', apiUrl: 'https://api.example', pushStrategy: 'auto' }),
    }));
    const { writeSessionFiles, pushSessionBranch } = await import('../local-entrypoint.js');

    writeSessionFiles(repo, baseData('connected-1') as any);
    pushSessionBranch(repo, 'connected-1');

    const fresh = cloneFresh();
    const meta = git(fresh, 'show', 'origin/origin-sessions:sessions/connected-1/metadata.json');
    expect(JSON.parse(meta).sessionId).toBe('connected-1');
    fs.rmSync(fresh, { recursive: true, force: true });
  });

  it('publishing many sessions keeps every one of them on the branch', async () => {
    vi.doMock('../config.js', () => ({
      loadConfig: () => ({ sessionBackend: 'refs', pushStrategy: 'auto' }),
    }));
    const { writeSessionFiles, pushSessionBranch } = await import('../local-entrypoint.js');

    const ids = ['s-a', 's-b', 's-c', 's-d'];
    for (const id of ids) {
      writeSessionFiles(repo, baseData(id) as any);
      pushSessionBranch(repo, id);
    }
    // Each publish folds onto the tip — earlier sessions must survive later ones.
    const fresh = cloneFresh();
    const listed = git(fresh, 'ls-tree', '--name-only', 'origin/origin-sessions:sessions/');
    expect(listed.split('\n').filter(Boolean).sort()).toEqual([...ids].sort());
    fs.rmSync(fresh, { recursive: true, force: true });
  }, 30_000);

  it('pushStrategy=prompt builds the branch locally but does not push it', async () => {
    // 'prompt' means the user pushes it themselves (pre-push hook / by hand).
    // The branch therefore has to EXIST locally — an earlier draft gated the
    // build on the push decision and left these users nothing to push.
    vi.doMock('../config.js', () => ({
      loadConfig: () => ({ sessionBackend: 'refs', pushStrategy: 'prompt' }),
    }));
    const { writeSessionFiles, pushSessionBranch } = await import('../local-entrypoint.js');

    writeSessionFiles(repo, baseData('manual-1') as any);
    pushSessionBranch(repo, 'manual-1');

    // Built locally…
    const local = git(repo, 'show', 'refs/heads/origin-sessions:sessions/manual-1/metadata.json');
    expect(JSON.parse(local).sessionId).toBe('manual-1');
    // …but not sent.
    expect(git(bare, 'for-each-ref', '--format=%(refname)')).not.toContain('origin-sessions');
    // And the user's own push works, because the branch is there.
    git(repo, 'push', '-q', 'origin', 'origin-sessions');
    expect(git(bare, 'for-each-ref', '--format=%(refname)')).toContain('refs/heads/origin-sessions');
  });

  it('pushStrategy=false publishes nothing (opt-out still works)', async () => {
    vi.doMock('../config.js', () => ({
      loadConfig: () => ({ sessionBackend: 'refs', pushStrategy: 'false' }),
    }));
    const { writeSessionFiles, pushSessionBranch } = await import('../local-entrypoint.js');

    writeSessionFiles(repo, baseData('private-1') as any);
    pushSessionBranch(repo, 'private-1');

    // Stored locally, but never published.
    expect(gitOk(repo, 'rev-parse', '--verify', 'refs/origin/sessions/private-1')).toBe(true);
    expect(git(bare, 'for-each-ref', '--format=%(refname)')).not.toContain('origin-sessions');
  });

  it('branch backend still works end to end (explicit opt-in)', async () => {
    vi.doMock('../config.js', () => ({
      loadConfig: () => ({ sessionBackend: 'branch', pushStrategy: 'auto' }),
    }));
    const { writeSessionFiles, pushSessionBranch } = await import('../local-entrypoint.js');

    writeSessionFiles(repo, baseData('branch-1') as any);
    // Hot path writes the branch directly under this backend.
    expect(gitOk(repo, 'rev-parse', '--verify', 'refs/heads/origin-sessions')).toBe(true);
    pushSessionBranch(repo, 'branch-1');

    const fresh = cloneFresh();
    const meta = git(fresh, 'show', 'origin/origin-sessions:sessions/branch-1/metadata.json');
    expect(JSON.parse(meta).sessionId).toBe('branch-1');
    fs.rmSync(fresh, { recursive: true, force: true });
  });
});
