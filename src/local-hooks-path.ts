/**
 * A repo's own `core.hooksPath` shadowing Origin's global one.
 *
 * `origin enable --global` sets `core.hooksPath` in the GLOBAL config. A repo
 * that sets it again in its own `.git/config` (pre-commit, husky, lefthook, a
 * hand-made dir) wins: git then runs that repo's dir and never Origin's. No
 * commit there is captured, no note or memory is pushed, and nothing reports
 * it — `origin doctor` said "all hook configs match" on exactly such a repo
 * (`.git/hooks-claude-only`), whose memory had never once reached the remote.
 *
 * The fix keeps the repo's hooks running: its value moves to
 * `origin.chainedHooksPath` and Origin's global hooks run that dir after their
 * own, in place of `$(git-dir)/hooks` (what git itself did). Undo is one line.
 */
import fs from 'fs';
import path from 'path';
import os from 'os';
import { execFileSync } from 'child_process';
import { CHAINED_HOOKS_PATH_SETTING, isOriginHooksPath, originGlobalHooksDir } from './global-hooks-path.js';

export interface ShadowingHooksPath {
  /** The value as written in the repo's config. */
  value: string;
  /** `local` (.git/config) or `worktree` (config.worktree). */
  scope: 'local' | 'worktree';
  /** Where it resolves to on disk. */
  dir: string;
  /** Executable hooks in that dir (no `.sample` files). */
  hooks: string[];
}

function gitConfig(repoRoot: string, args: string[]): string | null {
  try {
    return execFileSync('git', ['config', ...args], {
      cwd: repoRoot, encoding: 'utf-8', stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true,
    }).trim();
  } catch { return null; }
}

/** Resolve a `core.hooksPath` value the way git does: `~` is home, a relative
 *  path is relative to the working tree's top level. */
export function resolveHooksDir(value: string, repoRoot: string): string {
  let v = value;
  if (v === '~' || v.startsWith('~/')) v = path.join(os.homedir(), v.slice(1));
  return path.isAbsolute(v) ? v : path.resolve(repoRoot, v);
}

export function listExecutableHooks(dir: string): string[] {
  try {
    return fs.readdirSync(dir).filter((name) => {
      if (name.endsWith('.sample') || name.startsWith('.')) return false;
      try {
        const st = fs.statSync(path.join(dir, name));
        return st.isFile() && (process.platform === 'win32' || (st.mode & 0o111) !== 0);
      } catch { return false; }
    }).sort();
  } catch { return []; }
}

/**
 * The repo's own `core.hooksPath`, when it hides Origin's global hooks. Null
 * when the global value is not Origin's (nothing to shadow — Origin is then
 * installed per repo, or not at all) or the repo sets none.
 */
export function findShadowingHooksPath(repoRoot: string): ShadowingHooksPath | null {
  const globalValue = gitConfig(repoRoot, ['--global', '--get', 'core.hooksPath']);
  if (!globalValue || !isOriginHooksPath(globalValue)) return null;
  // The worktree scope beats local; only these two outrank the global value.
  // Without extensions.worktreeConfig `--worktree` just reads .git/config.
  const worktreeScope = gitConfig(repoRoot, ['--get', '--bool', 'extensions.worktreeConfig']) === 'true';
  const scopes = worktreeScope ? (['worktree', 'local'] as const) : (['local'] as const);
  for (const scope of scopes) {
    const value = gitConfig(repoRoot, [`--${scope}`, '--get', 'core.hooksPath']);
    if (!value || isOriginHooksPath(value)) continue;
    const dir = resolveHooksDir(value, repoRoot);
    return { value, scope, dir, hooks: listExecutableHooks(dir) };
  }
  return null;
}

/**
 * Move the repo's `core.hooksPath` out of Origin's way without dropping it:
 * saved to `origin.chainedHooksPath`, unset, and every hook in it given a
 * global hook that chains to it. Origin's own global hooks must already carry
 * the repo chain (the caller upgrades them first).
 */
export function chainShadowingHooksPath(
  repoRoot: string,
  found: ShadowingHooksPath,
  writeChainOnlyHook: (globalHooksDir: string, hook: string) => void,
  originHooks: string[],
  globalHooksDir: string = originGlobalHooksDir(),
): { chainOnly: string[] } {
  execFileSync('git', ['config', '--local', CHAINED_HOOKS_PATH_SETTING, found.value], { cwd: repoRoot, stdio: 'ignore', windowsHide: true });
  execFileSync('git', ['config', `--${found.scope}`, '--unset-all', 'core.hooksPath'], { cwd: repoRoot, stdio: 'ignore', windowsHide: true });
  // git looks up every hook in Origin's dir now, so a name Origin does not
  // write needs a stub that chains, or that hook silently stops running.
  const chainOnly: string[] = [];
  for (const hook of found.hooks) {
    if (originHooks.includes(hook) || fs.existsSync(path.join(globalHooksDir, hook))) continue;
    writeChainOnlyHook(globalHooksDir, hook);
    chainOnly.push(hook);
  }
  return { chainOnly };
}

/** How to put the repo back the way it was. */
export function undoCommand(found: ShadowingHooksPath): string {
  const quoted = /[\s"'$`\\]/.test(found.value) ? JSON.stringify(found.value) : found.value;
  return `git config --${found.scope} core.hooksPath ${quoted} && git config --unset ${CHAINED_HOOKS_PATH_SETTING}`;
}
