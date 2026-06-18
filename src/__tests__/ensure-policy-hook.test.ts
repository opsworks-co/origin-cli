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

  // ── Global core.hooksPath (Origin-managed dir) ─────────────────────────
  // We don't touch the user's real ~/.gitconfig — GIT_CONFIG_GLOBAL is
  // pointed at a temp config file for the duration of each test.

  function makeGlobalHooksSetup(): { hooksDir: string; cleanup: string[] } {
    // The dir must contain ".origin/git-hooks" for the managed-dir check.
    const base = fs.mkdtempSync(path.join(os.tmpdir(), 'origin-global-'));
    const hooksDir = path.join(base, '.origin', 'git-hooks');
    fs.mkdirSync(hooksDir, { recursive: true });
    const cfgPath = path.join(base, 'gitconfig');
    fs.writeFileSync(cfgPath, `[core]\n\thooksPath = ${hooksDir}\n`);
    process.env.GIT_CONFIG_GLOBAL = cfgPath;
    return { hooksDir, cleanup: [base] };
  }

  it('skips when the Origin-managed global dir already has a pre-commit hook', () => {
    const { hooksDir, cleanup } = makeGlobalHooksSetup();
    repos.push(...cleanup);
    fs.writeFileSync(path.join(hooksDir, 'pre-commit'), '#!/bin/sh\n# origin-global-pre-commit\n', { mode: 0o755 });
    const repo = makeTmpRepo();
    repos.push(repo);

    const result = ensurePolicyHookInstalled(repo);

    expect(result.installed).toBe(false);
    expect(result.reason).toBe('global-origin-hooks-active');
    expect(readHook(repo)).toBeNull(); // no redundant per-repo hook
  });

  it('heals an Origin-managed global dir that is missing pre-commit', () => {
    // Regression: global hooks dirs written by CLI versions that
    // predate the global pre-commit hook carry only post-commit/
    // pre-push/prepare-commit-msg. With core.hooksPath set, git
    // ignores .git/hooks entirely, so the old skip-because-global
    // behavior left CONTENT_FILTER and secret-scan enforcement dead
    // on the whole machine (user-reported June 11: a "block 'blyat'"
    // policy didn't block a Codex commit).
    const { hooksDir, cleanup } = makeGlobalHooksSetup();
    repos.push(...cleanup);
    // Simulate the stale dir: post-commit present, pre-commit absent.
    fs.writeFileSync(path.join(hooksDir, 'post-commit'), '#!/bin/sh\n# origin-global-post-commit\n', { mode: 0o755 });
    const repo = makeTmpRepo();
    repos.push(repo);

    const result = ensurePolicyHookInstalled(repo);

    expect(result.installed).toBe(true);
    expect(result.reason).toBe('healed-global-pre-commit');
    const healed = fs.readFileSync(path.join(hooksDir, 'pre-commit'), 'utf-8');
    expect(healed).toContain('# origin-global-pre-commit');
    // The hook resolves the binary into $ORIGIN_BIN, so assert on the
    // subcommand invocation rather than a literal "origin" prefix.
    expect(healed).toContain('hooks git-pre-commit');
    // Executable bit set — git silently skips non-executable hooks.
    expect(fs.statSync(path.join(hooksDir, 'pre-commit')).mode & 0o111).not.toBe(0);
    // Still no per-repo hook — the global one covers the repo.
    expect(readHook(repo)).toBeNull();
  });

  it('healing is idempotent — second call skips', () => {
    const { hooksDir, cleanup } = makeGlobalHooksSetup();
    repos.push(...cleanup);
    const repo = makeTmpRepo();
    repos.push(repo);

    ensurePolicyHookInstalled(repo);
    const healedContent = fs.readFileSync(path.join(hooksDir, 'pre-commit'), 'utf-8');
    const second = ensurePolicyHookInstalled(repo);

    expect(second.installed).toBe(false);
    expect(second.reason).toBe('global-origin-hooks-active');
    expect(fs.readFileSync(path.join(hooksDir, 'pre-commit'), 'utf-8')).toBe(healedContent);
  });
});
