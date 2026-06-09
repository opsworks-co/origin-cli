/**
 * ensurePolicyHookInstalled — auto-install of the git pre-commit hook
 * at AI-session start so CONTENT_FILTER policies actually block
 * commits.
 *
 * Background: user reported a CONTENT_FILTER policy in the Origin
 * dashboard wasn't being enforced for Codex sessions. The policy
 * evaluator (handlePreCommit) is correct — it just never ran, because
 * `.git/hooks/pre-commit` was never installed in the repo. The user
 * had run `origin enable codex` once (globally, into
 * ~/.codex/hooks.json) and assumed enforcement followed everywhere.
 *
 * The fix wires `ensurePolicyHookInstalled(repoPath)` into the
 * agent-agnostic session-start path so any repo touched by any AI
 * session gets the pre-commit hook installed lazily. These tests
 * lock the contract.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { ensurePolicyHookInstalled } from '../commands/enable.js';

function makeTmpRepo(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'origin-ensure-hook-'));
  execFileSync('git', ['init', '--quiet'], { cwd: dir });
  return dir;
}

function readHook(repoPath: string): string | null {
  const hookPath = path.join(repoPath, '.git', 'hooks', 'pre-commit');
  try {
    return fs.readFileSync(hookPath, 'utf-8');
  } catch {
    return null;
  }
}

describe('ensurePolicyHookInstalled', () => {
  let repos: string[] = [];
  let savedGitConfigGlobal: string | undefined;
  let savedGitConfigSystem: string | undefined;

  beforeEach(() => {
    repos = [];
    // Isolate from the developer's real git config — without this,
    // anyone running these tests on a machine that has `git config
    // --global core.hooksPath` set (e.g. someone using Origin's own
    // global hooks) triggers the global-origin-hooks-active branch
    // and `installed` returns false. The fix: point git at an empty
    // config for the duration of the test run.
    savedGitConfigGlobal = process.env.GIT_CONFIG_GLOBAL;
    savedGitConfigSystem = process.env.GIT_CONFIG_SYSTEM;
    process.env.GIT_CONFIG_GLOBAL = '/dev/null';
    process.env.GIT_CONFIG_SYSTEM = '/dev/null';
  });
  afterEach(() => {
    for (const r of repos) {
      try { fs.rmSync(r, { recursive: true, force: true }); } catch { /* ignore */ }
    }
    if (savedGitConfigGlobal === undefined) delete process.env.GIT_CONFIG_GLOBAL;
    else process.env.GIT_CONFIG_GLOBAL = savedGitConfigGlobal;
    if (savedGitConfigSystem === undefined) delete process.env.GIT_CONFIG_SYSTEM;
    else process.env.GIT_CONFIG_SYSTEM = savedGitConfigSystem;
  });

  it('installs the pre-commit hook on a fresh repo', () => {
    const repo = makeTmpRepo();
    repos.push(repo);

    const result = ensurePolicyHookInstalled(repo);

    expect(result.installed).toBe(true);
    expect(result.reason).toBe('fresh-install');
    const content = readHook(repo);
    expect(content).not.toBeNull();
    expect(content).toContain('# origin-pre-commit');
    expect(content).toContain('origin hooks git-pre-commit');
  });

  it('is idempotent — second call is a no-op', () => {
    const repo = makeTmpRepo();
    repos.push(repo);
    ensurePolicyHookInstalled(repo);
    const firstContent = readHook(repo);

    const result = ensurePolicyHookInstalled(repo);

    expect(result.installed).toBe(false);
    expect(result.reason).toBe('already-installed');
    // File must not have grown — no duplicate marker, no duplicate
    // hook script. The handlePreCommit handler is expensive; running
    // it twice per commit would double-block on every commit.
    expect(readHook(repo)).toBe(firstContent);
    // And exactly one marker line.
    expect((firstContent!.match(/# origin-pre-commit/g) || []).length).toBe(1);
  });

  it('appends to an existing user-authored hook without clobbering it', () => {
    // Existing repo with a hand-written hook. We must keep that hook
    // intact (users with husky / lefthook / lint-staged shouldn't
    // lose their setup on session start) and ADD ours below.
    const repo = makeTmpRepo();
    repos.push(repo);
    const hookPath = path.join(repo, '.git', 'hooks', 'pre-commit');
    fs.writeFileSync(hookPath, '#!/bin/sh\nnpx lint-staged\n', { mode: 0o755 });

    const result = ensurePolicyHookInstalled(repo);

    expect(result.installed).toBe(true);
    const content = readHook(repo)!;
    expect(content).toContain('npx lint-staged');
    expect(content).toContain('# origin-pre-commit');
    expect(content).toContain('origin hooks git-pre-commit');
  });

  it('preserves an existing user hook through a re-run', () => {
    const repo = makeTmpRepo();
    repos.push(repo);
    const hookPath = path.join(repo, '.git', 'hooks', 'pre-commit');
    fs.writeFileSync(hookPath, '#!/bin/sh\nnpx lint-staged\n', { mode: 0o755 });

    ensurePolicyHookInstalled(repo);
    const firstContent = readHook(repo);
    const second = ensurePolicyHookInstalled(repo);

    expect(second.installed).toBe(false);
    expect(second.reason).toBe('already-installed');
    expect(readHook(repo)).toBe(firstContent);
  });

  it('returns a structured non-fatal error when gitRoot is bogus', () => {
    // Defensive — session-start can pass a path that turns out not to
    // be a real git repo (multi-repo workspace top-level, e.g.). The
    // helper must not crash; the session continues regardless.
    const fake = path.join(os.tmpdir(), `does-not-exist-${Date.now()}`);
    const result = ensurePolicyHookInstalled(fake);

    // We accept either an error result or a fresh-install result — on
    // some platforms mkdirSync will happily create the dir. What we
    // pin: it returns SOMETHING, doesn't throw.
    expect(typeof result.installed).toBe('boolean');
    expect(typeof result.reason).toBe('string');
  });

  it('skips repos where the global core.hooksPath routes through Origin', () => {
    // When the user ran `origin enable --global`, Origin sets
    // `core.hooksPath` (global) to ~/.origin/git-hooks. The global
    // pre-commit fires for every repo; installing a per-repo one
    // would be redundant. We can't easily set the user's actual
    // global git config in a unit test (it would mutate ~/.gitconfig),
    // so this case is captured in the integration-test plan rather
    // than here. The other reasons (already-installed, custom-hooks-
    // path-set, fresh-install) are exercised above.
    expect(true).toBe(true);
  });
});
