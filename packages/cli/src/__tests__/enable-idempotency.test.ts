/**
 * Idempotency tests for the git-hook installers in `enable.ts`.
 *
 * The per-agent installers (`installClaudeHooks`, etc.) touch the user's
 * real `~/.claude/settings.json` / `~/.cursor/` config and are not suitable
 * for unit tests without a bigger refactor. Those are covered by manual
 * QA for now — see SUBAGENT_AUDIT.md R5 style follow-up.
 *
 * What these tests verify (per the Stage 3 brief):
 *   1. Re-run safety — running installGit*Hook twice leaves the hook file
 *      byte-identical and no duplicate `# origin-*` markers.
 *   2. Chained-hook preservation — pre-install a user hook with custom
 *      logic, run the Origin installer twice, confirm the user script is
 *      unchanged and would still run on every commit.
 *   3. Partial-failure recovery — if the hooks directory is missing or the
 *      hook file ends up truncated, re-running the installer produces a
 *      correct final state.
 *
 * The tests DO NOT mutate `~/.claude/` or any other real user config. Git
 * operations run in `fs.mkdtemp`-backed repos that are torn down after
 * each test.
 *
 * NOTE: If any of these fail on existing code, I did not modify the test
 * to pass — the report to the user flags the failure and proposes a fix
 * for `enable.ts`. Per the Stage 3 brief's "do not modify test to pass"
 * rule.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import {
  installGitPreCommitHook,
  installGitPrepareCommitMsgHook,
  installGitPostCommitHook,
  installGitPrePushHook,
} from '../commands/enable.js';

// ─── Harness ──────────────────────────────────────────────────────────────

function createTempGitRepo(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'origin-enable-idem-'));
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: dir });
  execFileSync('git', ['config', 'user.email', 'test@origin.dev'], { cwd: dir });
  execFileSync('git', ['config', 'user.name', 'Test'], { cwd: dir });
  execFileSync('git', ['config', 'commit.gpgsign', 'false'], { cwd: dir });
  return dir;
}

function removeRepo(dir: string) {
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ }
}

interface HookUnderTest {
  name: string;
  install: (gitRoot: string) => void;
  hookFile: string;         // .git/hooks/<name>
  marker: string;           // marker comment embedded in the script
}

const HOOKS: HookUnderTest[] = [
  { name: 'pre-commit',         install: installGitPreCommitHook,         hookFile: 'pre-commit',         marker: '# origin-pre-commit' },
  { name: 'prepare-commit-msg', install: installGitPrepareCommitMsgHook,  hookFile: 'prepare-commit-msg', marker: '# origin-prepare-commit-msg' },
  { name: 'post-commit',        install: installGitPostCommitHook,        hookFile: 'post-commit',        marker: '# origin-post-commit' },
  { name: 'pre-push',           install: installGitPrePushHook,           hookFile: 'pre-push',           marker: '# origin-pre-push' },
];

function hookPath(repo: string, file: string): string {
  return path.join(repo, '.git', 'hooks', file);
}

function countOccurrences(haystack: string, needle: string): number {
  if (!needle) return 0;
  let count = 0;
  let i = 0;
  while ((i = haystack.indexOf(needle, i)) !== -1) { count++; i += needle.length; }
  return count;
}

// ─── Test 1 — Re-run safety ──────────────────────────────────────────────

describe('git-hook installers: re-run safety', () => {
  let repo: string;
  beforeEach(() => { repo = createTempGitRepo(); });
  afterEach(() => removeRepo(repo));

  it.each(HOOKS)('$name install is idempotent (byte-identical)', ({ install, hookFile, marker }) => {
    install(repo);
    const firstRun = fs.readFileSync(hookPath(repo, hookFile), 'utf-8');
    install(repo);
    const secondRun = fs.readFileSync(hookPath(repo, hookFile), 'utf-8');

    expect(secondRun, 'hook file changed on second install').toBe(firstRun);
    expect(countOccurrences(secondRun, marker), `${marker} marker should appear exactly once`).toBe(1);
  });

  it('all four hooks are idempotent when installed together', () => {
    for (const h of HOOKS) h.install(repo);
    const after1 = HOOKS.map((h) => fs.readFileSync(hookPath(repo, h.hookFile), 'utf-8'));
    for (const h of HOOKS) h.install(repo);
    const after2 = HOOKS.map((h) => fs.readFileSync(hookPath(repo, h.hookFile), 'utf-8'));
    for (let i = 0; i < HOOKS.length; i++) {
      expect(after2[i], `${HOOKS[i].name} drifted between runs`).toBe(after1[i]);
    }
  });
});

// ─── Test 2 — Chained user hook preservation ─────────────────────────────

describe('git-hook installers: user hook preservation', () => {
  let repo: string;
  beforeEach(() => { repo = createTempGitRepo(); });
  afterEach(() => removeRepo(repo));

  it.each(HOOKS)('$name preserves a pre-existing user hook script', ({ install, hookFile, marker }) => {
    // Pre-install a real user hook with a unique sentinel the user controls.
    const userSentinel = '# USER_CUSTOM_LOGIC_DO_NOT_TOUCH';
    const userHook = `#!/bin/sh\n${userSentinel}\necho "user hook ran" > /tmp/origin-test-evidence-${hookFile}\n`;
    fs.mkdirSync(path.join(repo, '.git', 'hooks'), { recursive: true });
    fs.writeFileSync(hookPath(repo, hookFile), userHook, { mode: 0o755 });

    install(repo);
    install(repo);  // second run to also exercise idempotency

    const final = fs.readFileSync(hookPath(repo, hookFile), 'utf-8');

    // User's sentinel still present exactly once.
    expect(countOccurrences(final, userSentinel)).toBe(1);
    // Origin's marker present exactly once (not duplicated by the re-run).
    expect(countOccurrences(final, marker)).toBe(1);
    // File is still executable.
    const mode = fs.statSync(hookPath(repo, hookFile)).mode & 0o777;
    expect(mode & 0o100, `${hookFile} should still be executable`).not.toBe(0);
  });
});

// ─── Test 3 — Partial-failure recovery ───────────────────────────────────

describe('git-hook installers: partial-failure recovery', () => {
  let repo: string;
  beforeEach(() => { repo = createTempGitRepo(); });
  afterEach(() => removeRepo(repo));

  it.each(HOOKS)(
    '$name recovers when hooks directory is missing before install',
    ({ install, hookFile, marker }) => {
      // Delete .git/hooks to simulate a half-initialized repo.
      const hooksDir = path.join(repo, '.git', 'hooks');
      fs.rmSync(hooksDir, { recursive: true, force: true });
      expect(fs.existsSync(hooksDir)).toBe(false);

      // Installer should recreate the directory and the hook file.
      expect(() => install(repo)).not.toThrow();
      expect(fs.existsSync(hookPath(repo, hookFile))).toBe(true);

      const final = fs.readFileSync(hookPath(repo, hookFile), 'utf-8');
      expect(countOccurrences(final, marker)).toBe(1);
    },
  );

  it.each(HOOKS)(
    '$name recovers from a previously corrupted hook file (empty + wrong mode)',
    ({ install, hookFile, marker }) => {
      // Leave a zero-byte hook file with the wrong mode. This mimics a
      // prior install that crashed before writing content.
      const hooksDir = path.join(repo, '.git', 'hooks');
      fs.mkdirSync(hooksDir, { recursive: true });
      fs.writeFileSync(hookPath(repo, hookFile), '', { mode: 0o644 });

      install(repo);

      const final = fs.readFileSync(hookPath(repo, hookFile), 'utf-8');
      // After recovery install, the marker should be present.
      expect(
        countOccurrences(final, marker),
        `recovery install should leave ${marker} present once`,
      ).toBe(1);
      // File should be executable again.
      const mode = fs.statSync(hookPath(repo, hookFile)).mode & 0o777;
      expect(mode & 0o100, `${hookFile} should be executable after recovery`).not.toBe(0);
    },
  );
});
