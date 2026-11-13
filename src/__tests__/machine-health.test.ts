/**
 * The machine-health report a session start carries for the admin Rollout
 * view (machine-health.ts): computed from the same hook-config checks
 * `origin doctor` runs, cached for an hour in ~/.origin, never throwing.
 * Runs against a throwaway HOME so the real ~/.claude etc. are never read.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { installClaudeHooks, installCursorHooks, HOOK_CONFIG_SPECS } from '../commands/enable.js';
import { execFileSync } from 'child_process';
import { computeMachineHealth, machineHealthForUpload, recordHookFired, MACHINE_HEALTH_TTL_MS, HOOK_FIRED_WINDOW_MS } from '../machine-health.js';

let home: string;
let repo: string;
let prevHome: string | undefined;
let prevUserProfile: string | undefined;
let prevGitGlobal: string | undefined;
let prevCwd: string;
let prevClaudeConfigDir: string | undefined;

beforeEach(() => {
  home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'origin-mhealth-home-')));
  repo = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'origin-mhealth-repo-')));
  prevHome = process.env.HOME;
  prevUserProfile = process.env.USERPROFILE;
  prevGitGlobal = process.env.GIT_CONFIG_GLOBAL;
  prevCwd = process.cwd();
  process.env.HOME = home;
  process.env.USERPROFILE = home;
  delete process.env.GIT_CONFIG_GLOBAL;
  prevClaudeConfigDir = process.env.CLAUDE_CONFIG_DIR;
  delete process.env.CLAUDE_CONFIG_DIR;
  process.chdir(repo);
  vi.spyOn(console, 'log').mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
  try { process.chdir(prevCwd); } catch { /* ignore */ }
  if (prevHome === undefined) delete process.env.HOME; else process.env.HOME = prevHome;
  if (prevUserProfile === undefined) delete process.env.USERPROFILE; else process.env.USERPROFILE = prevUserProfile;
  if (prevGitGlobal === undefined) delete process.env.GIT_CONFIG_GLOBAL; else process.env.GIT_CONFIG_GLOBAL = prevGitGlobal;
  if (prevClaudeConfigDir === undefined) delete process.env.CLAUDE_CONFIG_DIR; else process.env.CLAUDE_CONFIG_DIR = prevClaudeConfigDir;
  for (const dir of [home, repo]) {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
  }
});

function driftCursor(base: string) {
  const file = HOOK_CONFIG_SPECS.find((s) => s.agent === 'cursor')!.filePath(base);
  const doc = JSON.parse(fs.readFileSync(file, 'utf-8'));
  const events = Object.keys(doc.hooks);
  delete doc.hooks[events[0]];
  fs.writeFileSync(file, JSON.stringify(doc));
}

describe('computeMachineHealth', () => {
  it('counts installed and drifted agent hooks, names detected tools with none, and checks git hooks', async () => {
    installClaudeHooks(repo);
    installCursorHooks(repo);
    driftCursor(repo);
    fs.mkdirSync(path.join(repo, '.git', 'hooks'), { recursive: true });
    fs.writeFileSync(path.join(repo, '.git', 'hooks', 'post-commit'), '#!/bin/sh\n# origin-post-commit\norigin hooks git-post-commit\n');

    const h = await computeMachineHealth({ repoPath: repo, detectedTools: ['claude', 'cursor', 'codex', 'code'], cliVersion: '0.20261008.2210' });

    expect(h).toMatchObject({ v: 1, cliVersion: '0.20261008.2210', platform: process.platform });
    expect(h.hooks.agents).toEqual([
      { agent: 'claude-code', scope: 'repo', state: 'ok' },
      { agent: 'cursor', scope: 'repo', state: 'stale' },
    ]);
    expect(h.hooks).toMatchObject({ installed: 2, drifted: 1, missing: ['codex'] });
    expect(h.gitHooks).toEqual({ global: false, repo: true });
  });

  it('reports nothing installed on a bare machine', async () => {
    const h = await computeMachineHealth({ repoPath: null, detectedTools: ['claude'], cliVersion: '1' });
    expect(h.hooks).toEqual({ installed: 0, drifted: 0, missing: ['claude-code'], agents: [] });
    expect(h.gitHooks).toEqual({ global: false, repo: null });
  });
});

const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf-8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();

// Ihor's MacBook, 2026-11-03: a Claude Code hook started his session and the
// health report that rode on that same start said "no Claude Code hooks", so
// the Rollout view called a capturing machine hooks-broken. The config check
// only read ~/.claude/settings.json and <repo>/.claude/settings.json.
describe('computeMachineHealth — hooks configured where the old check never looked', () => {
  it('counts an agent whose Origin hook fired in the last day, wherever its config is', async () => {
    const now = Date.now();
    recordHookFired('claude-code', now - 60_000);
    recordHookFired('codex', now - HOOK_FIRED_WINDOW_MS - 60_000); // too old to prove anything
    const h = await computeMachineHealth({ repoPath: null, detectedTools: ['claude', 'codex'], cliVersion: '1' });
    expect(h.hooks.agents).toEqual([{ agent: 'claude-code', scope: 'fired', state: 'ok' }]);
    expect(h.hooks).toMatchObject({ installed: 1, drifted: 0, missing: ['codex'] });
  });

  it('ignores a hook stamp for something that is not an agent', async () => {
    recordHookFired('git');
    recordHookFired(undefined);
    expect(fs.existsSync(path.join(home, '.origin', 'hook-fired'))).toBe(false);
  });

  it("reads Claude Code hooks from the repo's settings.local.json", async () => {
    installClaudeHooks(repo);
    fs.renameSync(path.join(repo, '.claude', 'settings.json'), path.join(repo, '.claude', 'settings.local.json'));
    const h = await computeMachineHealth({ repoPath: repo, detectedTools: ['claude'], cliVersion: '1' });
    expect(h.hooks.agents).toEqual([{ agent: 'claude-code', scope: 'repo', state: 'ok' }]);
    expect(h.hooks.missing).toEqual([]);
  });

  it('reads Claude Code hooks from $CLAUDE_CONFIG_DIR', async () => {
    const configBase = fs.mkdtempSync(path.join(os.tmpdir(), 'origin-mhealth-ccd-'));
    try {
      installClaudeHooks(configBase);
      process.env.CLAUDE_CONFIG_DIR = path.join(configBase, '.claude');
      const h = await computeMachineHealth({ repoPath: null, detectedTools: ['claude'], cliVersion: '1' });
      expect(h.hooks.agents).toEqual([{ agent: 'claude-code', scope: 'global', state: 'ok' }]);
    } finally {
      fs.rmSync(configBase, { recursive: true, force: true });
    }
  });

  it("finds the repo's Origin post-commit through a repo-local core.hooksPath", async () => {
    git(repo, 'init', '-q');
    const hooksDir = path.join(repo, '.githooks');
    fs.mkdirSync(hooksDir);
    fs.writeFileSync(path.join(hooksDir, 'post-commit'), '#!/bin/sh\norigin hooks git-post-commit\n');
    git(repo, 'config', 'core.hooksPath', '.githooks');
    const h = await computeMachineHealth({ repoPath: repo, detectedTools: [], cliVersion: '1' });
    expect(h.gitHooks).toEqual({ global: false, repo: true });
  });

  it('counts a repo whose hooks path is Origin\'s own hooks dir', async () => {
    git(repo, 'init', '-q');
    git(repo, 'config', 'core.hooksPath', path.join(home, '.origin', 'git-hooks'));
    const h = await computeMachineHealth({ repoPath: repo, detectedTools: [], cliVersion: '1' });
    expect(h.gitHooks.repo).toBe(true);
  });

  it('still says no repo hooks when there are none', async () => {
    git(repo, 'init', '-q');
    const h = await computeMachineHealth({ repoPath: repo, detectedTools: [], cliVersion: '1' });
    expect(h.gitHooks).toEqual({ global: false, repo: false });
  });
});

describe('machineHealthForUpload', () => {
  it('recomputes a fresh cached report once an agent hook fires that it does not name', async () => {
    const t0 = Date.now();
    const first = await machineHealthForUpload(repo, t0);
    expect(first?.hooks.installed).toBe(0);
    recordHookFired('claude-code', t0 + 1000);
    const next = await machineHealthForUpload(repo, t0 + 2000);
    expect(next?.hooks.agents).toEqual([{ agent: 'claude-code', scope: 'fired', state: 'ok' }]);
    // …and the recomputed report is then reused.
    const again = await machineHealthForUpload(repo, t0 + 3000);
    expect(again).toEqual(next);
  });

  it('caches the report for an hour, per repo, then recomputes', async () => {
    const t0 = Date.now();
    const first = await machineHealthForUpload(repo, t0);
    expect(first?.hooks.installed).toBe(0);
    expect(fs.existsSync(path.join(home, '.origin', 'machine-health.json'))).toBe(true);

    // A hook installed now is not seen while the cached report is fresh…
    installClaudeHooks(repo);
    const cached = await machineHealthForUpload(repo, Date.parse(first!.checkedAt) + 60_000);
    expect(cached).toEqual(first);

    // …is seen once it is an hour old, and for a different repo at once.
    const later = await machineHealthForUpload(repo, Date.parse(first!.checkedAt) + MACHINE_HEALTH_TTL_MS + 1);
    expect(later?.hooks.installed).toBe(1);
    const other = await machineHealthForUpload(home, Date.now());
    expect(other?.gitHooks.repo).toBeNull();
  });

  it('survives a corrupt cache file', async () => {
    fs.mkdirSync(path.join(home, '.origin'), { recursive: true });
    fs.writeFileSync(path.join(home, '.origin', 'machine-health.json'), '{nope');
    const h = await machineHealthForUpload(repo);
    expect(h?.v).toBe(1);
  });
});
