import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { execFileSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf-8' }).trim();
}

function makeRepo(): string {
  const repo = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'origin-explain-'));
  git(repo, 'init', '-q', '.');
  git(repo, 'config', 'user.email', 't@origin.dev');
  git(repo, 'config', 'user.name', 'Origin Test');
  git(repo, 'config', 'commit.gpgsign', 'false');
  git(repo, 'commit', '-q', '--allow-empty', '-m', 'seed');
  return repo;
}

describe('explain local fallback', () => {
  let repo: string;
  let cwd: string;

  beforeEach(() => {
    repo = makeRepo();
    cwd = process.cwd();
    process.chdir(repo);
    vi.resetModules();
    vi.doMock('../config.js', () => ({
      isConnectedMode: () => true,
      loadConfig: () => ({
        apiUrl: 'http://localhost:4002',
        apiKey: 'test-key',
        sessionBackend: 'refs',
      }),
    }));
    vi.doMock('../api.js', () => ({
      api: {
        getSession: async () => {
          const err = new Error('Session not found') as Error & { status?: number };
          err.status = 404;
          throw err;
        },
      },
    }));
  });

  afterEach(() => {
    process.chdir(cwd);
    try { fs.rmSync(repo, { recursive: true, force: true }); } catch { /* ignore */ }
    vi.restoreAllMocks();
    vi.resetModules();
  });

  it('falls back to local storage and trusts changes.json over stale metadata rollup', async () => {
    const { writeSessionFiles } = await import('../local-entrypoint.js');
    const { explainCommand } = await import('../commands/explain.js');

    writeSessionFiles(repo, {
      sessionId: 'sess-cross-repo',
      model: 'claude-opus-5',
      startedAt: '2026-09-16T09:00:00.000Z',
      endedAt: '2026-09-16T10:00:00.000Z',
      durationMs: 60 * 60 * 1000,
      status: 'ended',
      costUsd: 0,
      tokensUsed: 0,
      inputTokens: 0,
      outputTokens: 0,
      toolCalls: 1,
      linesAdded: 0,
      linesRemoved: 0,
      prompts: [{ index: 1, text: 'bump deps', filesChanged: ['requirements.txt'] }],
      filesChanged: ['rhodecode-vcsserver/vcsserver/remote/git_remote.py'],
      git: { branch: 'main', headBefore: '', headAfter: '', commitShas: [] },
      summary: '',
      originUrl: 'http://localhost:4002/sessions/sess-cross-repo',
      changes: [{
        promptIndex: 1,
        promptText: 'bump deps',
        filesChanged: ['requirements.txt', 'requirements_test.txt'],
        diff: [
          'diff --git a/requirements.txt b/requirements.txt',
          '--- a/requirements.txt',
          '+++ b/requirements.txt',
          '@@ -1 +1 @@',
          '-webob==1.8.10',
          '+webob==1.8.11',
        ].join('\n'),
      }],
    } as any);

    const logs: string[] = [];
    vi.spyOn(console, 'log').mockImplementation((msg?: unknown) => {
      logs.push(String(msg ?? ''));
    });

    await explainCommand('sess-cross-repo');

    const out = logs.join('\n');
    expect(out).toContain('requirements.txt');
    expect(out).toContain('requirements_test.txt');
    expect(out).toContain('Lines:');
    expect(out).toContain('+1');
    expect(out).toContain('-1');
    expect(out).not.toContain('rhodecode-vcsserver/vcsserver/remote/git_remote.py');
  });
});
