// `origin enable --global` takes core.hooksPath. A hooks dir the user already
// had there (~/.githooks, a team-wide dir) must keep running — Origin's hooks
// chain to it — and `origin disable --global` must hand the setting back.
//
// Before: enable overwrote the value without looking, the hooks chained only to
// $(git-dir)/hooks, and disable never touched core.hooksPath at all.
//
// Everything runs against a temp HOME + GIT_CONFIG_GLOBAL; the real ~/.gitconfig
// is never read or written.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync, spawnSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import {
  writeGlobalPreCommitHook, writeGlobalPostCommitHook, writeGlobalPrePushHook,
} from '../commands/enable.js';
import { rememberPreviousHooksPath, restorePreviousHooksPath, PREVIOUS_HOOKS_PATH_FILE } from '../global-hooks-path.js';

const ENV_KEYS = ['HOME', 'GIT_CONFIG_GLOBAL', 'GIT_CONFIG_SYSTEM', 'GIT_CONFIG_NOSYSTEM'] as const;

describe('a pre-existing global core.hooksPath survives enable/disable --global', () => {
  let root: string;
  let originDir: string;
  let userDir: string;
  let gitconfig: string;
  const saved: Partial<Record<string, string | undefined>> = {};

  const git = (cwd: string, ...args: string[]) =>
    execFileSync('git', args, { cwd, encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  const globalHooksPath = () => {
    const r = spawnSync('git', ['config', '--global', '--get', 'core.hooksPath'], { encoding: 'utf-8' });
    return r.status === 0 ? r.stdout.trim() : null;
  };

  beforeEach(() => {
    for (const k of ENV_KEYS) saved[k] = process.env[k];
    root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'origin-hookspath-'));
    gitconfig = path.join(root, 'gitconfig');
    fs.writeFileSync(gitconfig, '[init]\n\tdefaultBranch = main\n[user]\n\tname = t\n\temail = t@t.co\n[commit]\n\tgpgsign = false\n');
    process.env.HOME = root;
    process.env.GIT_CONFIG_GLOBAL = gitconfig;
    process.env.GIT_CONFIG_SYSTEM = '/dev/null';
    process.env.GIT_CONFIG_NOSYSTEM = '1';
    originDir = path.join(root, '.origin', 'git-hooks');
    userDir = path.join(root, '.githooks');
    fs.mkdirSync(originDir, { recursive: true });
    fs.mkdirSync(userDir, { recursive: true });
  });

  afterEach(() => {
    for (const k of ENV_KEYS) {
      if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k];
    }
    try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  /** What installGlobalGitHooks does with the config. */
  const enable = () => {
    rememberPreviousHooksPath(originDir);
    git(root, 'config', '--global', 'core.hooksPath', originDir);
  };

  it('enable saves the user\'s hooks dir; disable restores it', () => {
    git(root, 'config', '--global', 'core.hooksPath', '~/.githooks');
    enable();
    expect(fs.readFileSync(path.join(originDir, PREVIOUS_HOOKS_PATH_FILE), 'utf-8').trim()).toBe('~/.githooks');
    // A re-enable must not overwrite the save with Origin's own dir.
    enable();
    expect(fs.readFileSync(path.join(originDir, PREVIOUS_HOOKS_PATH_FILE), 'utf-8').trim()).toBe('~/.githooks');

    expect(restorePreviousHooksPath(originDir)).toEqual({ action: 'restored', value: '~/.githooks' });
    expect(globalHooksPath()).toBe('~/.githooks');
    expect(fs.existsSync(path.join(originDir, PREVIOUS_HOOKS_PATH_FILE))).toBe(false);
  });

  it('with nothing set before, disable unsets core.hooksPath', () => {
    enable();
    expect(fs.existsSync(path.join(originDir, PREVIOUS_HOOKS_PATH_FILE))).toBe(false);
    expect(restorePreviousHooksPath(originDir)).toEqual({ action: 'unset' });
    expect(globalHooksPath()).toBeNull();
  });

  it('disable leaves a hooksPath the user changed since alone', () => {
    enable();
    git(root, 'config', '--global', 'core.hooksPath', '/somewhere/else');
    expect(restorePreviousHooksPath(originDir)).toEqual({ action: 'untouched' });
    expect(globalHooksPath()).toBe('/somewhere/else');
  });

  /** Write Origin's real hooks with the origin binary stubbed out. */
  function writeOriginHooks() {
    for (const [write, name] of [
      [writeGlobalPreCommitHook, 'pre-commit'],
      [writeGlobalPostCommitHook, 'post-commit'],
      [writeGlobalPrePushHook, 'pre-push'],
    ] as const) {
      write(originDir);
      const p = path.join(originDir, name);
      const src = fs.readFileSync(p, 'utf-8');
      const start = src.indexOf('ORIGIN_BIN=""');
      const end = src.indexOf('\nfi\n', start);
      expect(start).toBeGreaterThan(-1);
      fs.writeFileSync(p, src.slice(0, start) + 'ORIGIN_BIN=""' + src.slice(end + '\nfi'.length));
      fs.chmodSync(p, '755');
    }
  }
  function hook(dir: string, name: string, body: string) {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, name), `#!/bin/sh\n${body}\n`);
    fs.chmodSync(path.join(dir, name), '755');
  }
  function repo(): string {
    const r = path.join(root, 'repo');
    fs.mkdirSync(r);
    git(r, 'init', '-q', '.');
    return r;
  }

  it('Origin\'s hooks chain to the previous global hooks dir AND the repo\'s own hooks', () => {
    const log = path.join(root, 'ran.log');
    hook(userDir, 'post-commit', `echo user-post-commit >> ${JSON.stringify(log)}`);
    git(root, 'config', '--global', 'core.hooksPath', '~/.githooks');
    writeOriginHooks();
    enable();
    const r = repo();
    hook(path.join(r, '.git', 'hooks'), 'post-commit', `echo repo-post-commit >> ${JSON.stringify(log)}`);
    git(r, 'commit', '-q', '--allow-empty', '-m', 'x');
    // THE regression: user-post-commit never ran.
    expect(fs.readFileSync(log, 'utf-8').trim().split('\n')).toEqual(['user-post-commit', 'repo-post-commit']);
  });

  it('a failing previous global pre-commit still blocks the commit', () => {
    hook(userDir, 'pre-commit', 'echo "blocked by user hook" >&2; exit 1');
    git(root, 'config', '--global', 'core.hooksPath', userDir);
    writeOriginHooks();
    enable();
    const r = repo();
    const res = spawnSync('git', ['commit', '-q', '--allow-empty', '-m', 'x'], { cwd: r, encoding: 'utf-8' });
    expect(res.status).not.toBe(0);
    expect(res.stderr).toContain('blocked by user hook');
  });

  it('a previous hooksPath that IS the repo\'s hooks dir runs the hook once', () => {
    const log = path.join(root, 'ran.log');
    git(root, 'config', '--global', 'core.hooksPath', '.git/hooks');
    writeOriginHooks();
    enable();
    const r = repo();
    hook(path.join(r, '.git', 'hooks'), 'post-commit', `echo repo-post-commit >> ${JSON.stringify(log)}`);
    git(r, 'commit', '-q', '--allow-empty', '-m', 'x');
    expect(fs.readFileSync(log, 'utf-8').trim().split('\n')).toEqual(['repo-post-commit']);
  });

  it('pre-push hands its stdin refs to both chained hooks', () => {
    const log = path.join(root, 'ran.log');
    hook(userDir, 'pre-push', `echo "user:$(cat)" >> ${JSON.stringify(log)}`);
    git(root, 'config', '--global', 'core.hooksPath', userDir);
    writeOriginHooks();
    enable();
    const r = repo();
    hook(path.join(r, '.git', 'hooks'), 'pre-push', `echo "repo:$(cat)" >> ${JSON.stringify(log)}`);
    const res = spawnSync('sh', [path.join(originDir, 'pre-push'), 'origin', 'url'], {
      cwd: r, input: 'refs/heads/main abc refs/heads/main def\n', encoding: 'utf-8',
    });
    expect(res.status).toBe(0);
    expect(fs.readFileSync(log, 'utf-8').trim().split('\n')).toEqual([
      'user:refs/heads/main abc refs/heads/main def',
      'repo:refs/heads/main abc refs/heads/main def',
    ]);
  });
});
