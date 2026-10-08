/**
 * The user's own global `core.hooksPath`, kept across `origin enable --global`.
 *
 * `enable --global` points `core.hooksPath` at Origin's dir, and Origin's hooks
 * chained only to `$(git-dir)/hooks/*`. A user who already had a global hooks
 * dir (`~/.githooks`, a team-wide dir, …) silently lost every hook in it, and
 * `disable --global` never put the setting back — it left `core.hooksPath` on
 * Origin's dir, so Origin's hooks kept firing after "disable".
 *
 * Now the previous value is saved beside Origin's hooks (the hook scripts read
 * it at run time and chain to that dir too), and `disable --global` restores it.
 */
import fs from 'fs';
import os from 'os';
import path from 'path';
import { execFileSync } from 'child_process';

/** File in Origin's hooks dir holding the user's previous `core.hooksPath`. */
export const PREVIOUS_HOOKS_PATH_FILE = 'previous-hooks-path';

export function originGlobalHooksDir(): string {
  return path.join(os.homedir(), '.origin', 'git-hooks');
}

/** Same separator-insensitive test ensurePolicyHookInstalled uses. */
export function isOriginHooksPath(value: string): boolean {
  return value.replace(/\\/g, '/').includes('.origin/git-hooks');
}

function readGlobalHooksPath(): string {
  try {
    return execFileSync('git', ['config', '--global', '--get', 'core.hooksPath'], {
      encoding: 'utf-8', stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true,
    }).trim();
  } catch { return ''; }
}

/**
 * Before `enable --global` takes `core.hooksPath`: remember a value that isn't
 * Origin's own. A re-enable (already Origin's) keeps what was saved the first
 * time; no value at all clears a stale save.
 */
export function rememberPreviousHooksPath(hooksDir: string = originGlobalHooksDir()): string | null {
  const current = readGlobalHooksPath();
  const file = path.join(hooksDir, PREVIOUS_HOOKS_PATH_FILE);
  if (current && isOriginHooksPath(current)) return null;
  if (!current) {
    try { fs.rmSync(file, { force: true }); } catch { /* best effort */ }
    return null;
  }
  fs.mkdirSync(hooksDir, { recursive: true });
  fs.writeFileSync(file, current + '\n');
  return current;
}

/**
 * `disable --global`: hand `core.hooksPath` back — the saved value, or unset
 * when there was none. Left alone when it no longer points at Origin's dir
 * (the user changed it since). Returns what it did.
 */
export function restorePreviousHooksPath(
  hooksDir: string = originGlobalHooksDir(),
): { action: 'restored' | 'unset' | 'untouched'; value?: string } {
  const current = readGlobalHooksPath();
  if (!current || !isOriginHooksPath(current)) return { action: 'untouched' };
  const file = path.join(hooksDir, PREVIOUS_HOOKS_PATH_FILE);
  let previous = '';
  try { previous = fs.readFileSync(file, 'utf-8').trim(); } catch { /* none saved */ }
  if (previous && !isOriginHooksPath(previous)) {
    execFileSync('git', ['config', '--global', 'core.hooksPath', previous], { stdio: 'ignore', windowsHide: true });
  } else {
    previous = '';
    execFileSync('git', ['config', '--global', '--unset-all', 'core.hooksPath'], { stdio: 'ignore', windowsHide: true });
  }
  try { fs.rmSync(file, { force: true }); } catch { /* best effort */ }
  return previous ? { action: 'restored', value: previous } : { action: 'unset' };
}
