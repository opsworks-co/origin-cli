// Concurrent writes to the shared `origin-sessions` branch must not lose
// sessions.
//
// Root cause this pins: writeSessionFiles() seeds its tree from the branch
// tip, then committed with `update-ref <ref> <new>` — an UNCONDITIONAL write
// with no compare-and-swap. Two agents that both seed from tip T each build a
// tree that lacks the other's files; whoever calls update-ref last wins and
// the loser's session is silently orphaned. The PID-scoped temp index only
// ever protected the *index file*, never the ref.
//
// Measured against the real function before the fix: 16 parallel agents →
// 1 session survived. After (CAS + jittered backoff): 16/16.
//
// This must run as real subprocesses — the whole write path is synchronous, so
// the interleaving that triggers the bug cannot occur inside one process.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
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

// A standalone script so each agent is its own process, like a real fleet.
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

describe('origin-sessions branch: concurrent writers', () => {
  let repo: string;
  let agentScript: string;
  let home: string;

  beforeEach(() => {
    // realpath the tmpdir: on macOS it's a /var → /private/var symlink, and
    // git resolves it, which breaks path comparisons.
    repo = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'origin-race-'));
    git(repo, 'init', '-q', '.');
    git(repo, 'config', 'user.email', 't@t.co');
    git(repo, 'config', 'user.name', 't');
    git(repo, 'config', 'commit.gpgsign', 'false');
    git(repo, 'commit', '-q', '--allow-empty', '-m', 'seed');
    agentScript = path.join(repo, 'agent.mts');
    fs.writeFileSync(agentScript, AGENT_SRC);
    // The refs backend is the default now, and it has no shared ref to contend
    // on. Force the branch backend so this keeps exercising the CAS path that
    // branch-backend users still run.
    home = path.join(repo, 'fakehome');
    fs.mkdirSync(path.join(home, '.origin'), { recursive: true });
    fs.writeFileSync(
      path.join(home, '.origin', 'config.json'),
      JSON.stringify({ sessionBackend: 'branch' }),
    );
  });

  afterEach(() => {
    try { fs.rmSync(repo, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  it('does not drop sessions when several agents write at once', async () => {
    const N = 8;
    const ids = Array.from({ length: N }, (_, i) => `session-${i + 1}`);
    // Shared wall-clock start so the writes genuinely overlap. MUST use async
    // spawn: spawnSync would block, running the agents strictly one after
    // another — no overlap, no race, and this test would pass on the bug.
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
    // Surface a harness failure (bad spawn) rather than mistaking it for data loss.
    const failed = results.find((r) => r.code !== 0);
    expect(failed?.stderr ?? '', 'agents failed to run').toBe('');

    const listed = git(repo, 'ls-tree', '--name-only', 'refs/heads/origin-sessions:sessions/');
    const survivors = listed.split('\n').filter(Boolean).sort();
    expect(survivors).toEqual([...ids].sort());
  }, 180_000);
});
