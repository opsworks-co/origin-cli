// A repo's own core.hooksPath (`.git/hooks-claude-only`, husky, pre-commit)
// outranks the global one `origin enable --global` sets, so git never ran
// Origin's hooks there: nothing captured, no notes or memory pushed — and
// `origin doctor` reported every check green. Seen on a teammate's machine
// whose repo memory had never reached the remote.
//
// Real git against a temp HOME + GIT_CONFIG_GLOBAL; the real ~/.gitconfig is
// never read or written.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync, spawnSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import {
  writeGlobalPreCommitHook, writeGlobalPostCommitHook, writeGlobalPrePushHook,
  writeGlobalChainOnlyHook, upgradeOutdatedGlobalHooks, ORIGIN_GLOBAL_HOOKS, REPO_CHAIN_MARKER,
} from '../commands/enable.js';
import { findShadowingHooksPath, chainShadowingHooksPath, undoCommand } from '../local-hooks-path.js';

const ENV_KEYS = ['HOME', 'GIT_CONFIG_GLOBAL', 'GIT_CONFIG_SYSTEM', 'GIT_CONFIG_NOSYSTEM'] as const;

describe('a repo-local core.hooksPath that shadows Origin\'s global hooks', () => {
  let root: string;
  let originDir: string;
  let log: string;
  let repo: string;
  const saved: Partial<Record<string, string | undefined>> = {};

  const git = (cwd: string, ...args: string[]) =>
    execFileSync('git', args, { cwd, encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  const ran = () => (fs.existsSync(log) ? fs.readFileSync(log, 'utf-8').trim().split('\n') : []);
  function hook(dir: string, name: string, body: string) {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, name), `#!/bin/sh\n${body}\n`);
    fs.chmodSync(path.join(dir, name), '755');
  }

  /** Origin's real hooks, with the origin binary swapped for one that logs. */
  function writeOriginHooks() {
    const stub = path.join(root, 'origin-stub');
    fs.writeFileSync(stub, `#!/bin/sh\necho "origin $2" >> ${JSON.stringify(log)}\n`);
    fs.chmodSync(stub, '755');
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
      // post-commit backgrounds the CLI; run it in the foreground so the log is ordered.
      const body = (src.slice(0, start) + `ORIGIN_BIN=${JSON.stringify(stub)}` + src.slice(end + '\nfi'.length))
        .replace(/\s&\s*$/gm, '\n');
      fs.writeFileSync(p, body);
      fs.chmodSync(p, '755');
    }
  }

  beforeEach(() => {
    for (const k of ENV_KEYS) saved[k] = process.env[k];
    root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'origin-local-hookspath-'));
    const gitconfig = path.join(root, 'gitconfig');
    fs.writeFileSync(gitconfig, '[init]\n\tdefaultBranch = main\n[user]\n\tname = t\n\temail = t@t.co\n[commit]\n\tgpgsign = false\n');
    process.env.HOME = root;
    process.env.GIT_CONFIG_GLOBAL = gitconfig;
    process.env.GIT_CONFIG_SYSTEM = '/dev/null';
    process.env.GIT_CONFIG_NOSYSTEM = '1';
    originDir = path.join(root, '.origin', 'git-hooks');
    fs.mkdirSync(originDir, { recursive: true });
    log = path.join(root, 'ran.log');
    writeOriginHooks();
    git(root, 'config', '--global', 'core.hooksPath', originDir);
    repo = path.join(root, 'repo');
    fs.mkdirSync(repo);
    git(repo, 'init', '-q', '.');
    // The repo's own dir, set in its .git/config — exactly what was seen.
    git(repo, 'config', 'core.hooksPath', '.git/hooks-claude-only');
    hook(path.join(repo, '.git', 'hooks-claude-only'), 'post-commit', `echo "repo post-commit" >> ${JSON.stringify(log)}`);
  });

  afterEach(() => {
    for (const k of ENV_KEYS) {
      if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k];
    }
    try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  it('is found, and while it is set git never runs Origin\'s hooks', () => {
    git(repo, 'commit', '-q', '--allow-empty', '-m', 'x');
    expect(ran()).toEqual(['repo post-commit']);

    const found = findShadowingHooksPath(repo);
    expect(found).toMatchObject({ value: '.git/hooks-claude-only', scope: 'local', hooks: ['post-commit'] });
    expect(found!.dir).toBe(path.join(repo, '.git', 'hooks-claude-only'));
  });

  it('after the fix Origin\'s hook runs first, then the repo\'s own — and not the dormant .git/hooks', () => {
    hook(path.join(repo, '.git', 'hooks'), 'post-commit', `echo "dormant .git/hooks" >> ${JSON.stringify(log)}`);
    const found = findShadowingHooksPath(repo)!;
    chainShadowingHooksPath(repo, found, writeGlobalChainOnlyHook, ORIGIN_GLOBAL_HOOKS, originDir);

    expect(spawnSync('git', ['config', '--local', '--get', 'core.hooksPath'], { cwd: repo }).status).not.toBe(0);
    expect(git(repo, 'config', '--get', 'origin.chainedHooksPath')).toBe('.git/hooks-claude-only');
    expect(findShadowingHooksPath(repo)).toBeNull();

    git(repo, 'commit', '-q', '--allow-empty', '-m', 'x');
    expect(ran()).toEqual(['origin git-pre-commit', 'origin git-post-commit', 'repo post-commit']);
  });

  it('a failing pre-commit in the chained dir still blocks the commit', () => {
    hook(path.join(repo, '.git', 'hooks-claude-only'), 'pre-commit', 'echo "blocked" >&2; exit 1');
    chainShadowingHooksPath(repo, findShadowingHooksPath(repo)!, writeGlobalChainOnlyHook, ORIGIN_GLOBAL_HOOKS, originDir);
    const res = spawnSync('git', ['commit', '-q', '--allow-empty', '-m', 'x'], { cwd: repo, encoding: 'utf-8' });
    expect(res.status).not.toBe(0);
    expect(res.stderr).toContain('blocked');
  });

  it('a hook Origin has no version of keeps running through a chain-only stub', () => {
    hook(path.join(repo, '.git', 'hooks-claude-only'), 'post-index-change', `echo "repo post-index-change" >> ${JSON.stringify(log)}`);
    const { chainOnly } = chainShadowingHooksPath(repo, findShadowingHooksPath(repo)!, writeGlobalChainOnlyHook, ORIGIN_GLOBAL_HOOKS, originDir);
    expect(chainOnly).toEqual(['post-index-change']);
    fs.writeFileSync(path.join(repo, 'a.txt'), 'a');
    git(repo, 'add', 'a.txt');
    expect(ran()).toContain('repo post-index-change');
  });

  it('the undo line puts the repo back', () => {
    const found = findShadowingHooksPath(repo)!;
    chainShadowingHooksPath(repo, found, writeGlobalChainOnlyHook, ORIGIN_GLOBAL_HOOKS, originDir);
    execFileSync('sh', ['-c', undoCommand(found)], { cwd: repo });
    expect(git(repo, 'config', '--local', '--get', 'core.hooksPath')).toBe('.git/hooks-claude-only');
    expect(spawnSync('git', ['config', '--get', 'origin.chainedHooksPath'], { cwd: repo }).status).not.toBe(0);
  });

  it('is not reported when the global hooksPath is not Origin\'s', () => {
    git(root, 'config', '--global', 'core.hooksPath', path.join(root, '.githooks'));
    expect(findShadowingHooksPath(repo)).toBeNull();
  });

  it('Origin\'s global hooks written before the repo chain are rewritten with it', () => {
    const p = path.join(originDir, 'post-commit');
    fs.writeFileSync(p, fs.readFileSync(p, 'utf-8').split('\n').filter((l) => !l.includes(REPO_CHAIN_MARKER)).join('\n'));
    expect(upgradeOutdatedGlobalHooks(originDir)).toEqual(['post-commit']);
    expect(fs.readFileSync(p, 'utf-8')).toContain(REPO_CHAIN_MARKER);
    expect(upgradeOutdatedGlobalHooks(originDir)).toEqual([]);
  });
});
