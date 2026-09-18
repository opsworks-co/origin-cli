/**
 * git hands post-rewrite its "old-sha new-sha" pairs on STDIN.
 *
 * Both hook scripts Origin installs ran the CLI as
 *
 *     origin hooks git-post-rewrite "$@" >/dev/null 2>&1 &
 *
 * (the repo-local one without the redirect until #711), and a command
 * backgrounded with `&` in a non-interactive shell reads /dev/null, not the
 * script's stdin. So the CLI has received an EMPTY input on every rebase and
 * amend for as long as the hook has been backgrounded: no attribution note was
 * carried across a rewrite, and no rewrite pair was ever recorded on a session.
 * hooks.log holds zero `[post-rewrite]` lines.
 *
 * It was not the only break. The handler in index.ts read stdin with
 * `require('fs')` inside a try/catch — in an ES module, where `require` is
 * undefined — so it could not have read the pairs even if they had arrived.
 *
 * Prod 47b6f0e4, 2026-09-17: the agent committed (a2bd7c49) and rebased the
 * branch two seconds later (7f21862e). post-commit correctly skipped the
 * replay as "not this turn's work" — linking old to new is post-rewrite's
 * job, and it never heard about it. Both shas stayed on the session, the old
 * one owned by no turn, and the page rendered it under a turn from the day
 * before.
 *
 * The fix is to read stdin in the foreground and pipe it into the background
 * child. This module holds the shell fragments both templates share, and the
 * repair for scripts already on disk — an installed hook is never rewritten
 * by an upgrade, so without the repair the fix reaches new installs only.
 */
import fs from 'fs';
import os from 'os';
import path from 'path';
import { execFileSync } from 'child_process';

/** Foreground read of git's pairs. A TTY stdin is someone running the hook by
 *  hand; `cat` would block on it forever. */
export const CAPTURE_REWRITES = 'if [ -t 0 ]; then ORIGIN_REWRITES=""; else ORIGIN_REWRITES="$(cat)"; fi';

/** `cmd` in the FOREGROUND, fed the captured pairs — the chained repo-local hook. */
export function withRewritesOnStdin(cmd: string): string {
  return `printf '%s\\n' "$ORIGIN_REWRITES" | ${cmd}`;
}

/**
 * `cmd` in the BACKGROUND, fed the captured pairs. A pipe is an explicit stdin,
 * so it survives `&`.
 *
 * The redirect wraps the WHOLE pipeline. On `cmd` alone it leaves `printf`
 * holding the hook's stderr — which for post-rewrite is git's — and above the
 * 64 KB pipe buffer (a rebase of ~800 commits) printf blocks until the CLI
 * drains stdin: #703's stall, back again. A `2>/dev/null` on printf itself is
 * not enough either: dash, which is /bin/sh on Debian and Ubuntu, implements a
 * redirect on a builtin by parking the original fd 2 at fd 10, so the blocked
 * child still holds git's pipe (measured: 3.06 s behind a 3 s reader under
 * dash, 0.02 s under bash). The brace group redirects before either side
 * starts; sh, dash and bash all release in ~0.02 s at 246 KB.
 */
const BACKGROUND_TAIL = '; } >/dev/null 2>&1 &';
export function backgroundedWithRewrites(cmd: string): string {
  return `{ printf '%s\\n' "$ORIGIN_REWRITES" | ${cmd}${BACKGROUND_TAIL}`;
}

const GLOBAL_MARKER = '# origin-global-post-rewrite';
// The old invocation, on a line of its own, not already fed by a pipe. The
// redirect is optional: from 2026-03 until #711 the repo-local block was
// written without it, and #711 never rewrote those files (marker present →
// "already installed"). The repaired line always carries it.
const OLD_LINE = /^([ \t]*)((?:"\$ORIGIN_BIN"|origin) hooks git-post-rewrite "\$@")(?: >\/dev\/null 2>&1)? &[ \t]*$/gm;

/**
 * Keyed on the CURRENT backgrounded form, not merely on the capture being
 * there: an earlier cut of this fix piped without the brace group, and a check
 * for `ORIGIN_REWRITES` alone would have left that form on disk for good.
 */
export function needsStdinRepair(script: string): boolean {
  return script.includes('hooks git-post-rewrite') && !script.includes(`hooks git-post-rewrite "$@"${BACKGROUND_TAIL}`);
}

/**
 * Repair a repo-local script in place: each old invocation becomes the capture
 * plus the piped form. Anything else in the file — a user's own hook the block
 * was appended to — is left alone. Returns null when nothing needs doing.
 */
export function repairLocalPostRewriteScript(script: string): string | null {
  if (!needsStdinRepair(script)) return null;
  let first = true;
  const out = script.replace(OLD_LINE, (_m, indent: string, cmd: string) => {
    const capture = first ? `${indent}${CAPTURE_REWRITES}\n` : '';
    first = false;
    return `${capture}${indent}${backgroundedWithRewrites(cmd)}`;
  });
  return out === script ? null : out;
}

/**
 * Repair the hooks already installed: the global one (wholly Origin's, so it
 * is regenerated) and the repo's own. Cheap — two small reads — and never
 * throws. Returns the paths it rewrote.
 */
export async function repairInstalledPostRewriteHooks(
  repoPath?: string | null,
  globalHooksDir: string = path.join(os.homedir(), '.origin', 'git-hooks'),
): Promise<string[]> {
  const repaired: string[] = [];
  try {
    const globalHook = path.join(globalHooksDir, 'post-rewrite');
    if (fs.existsSync(globalHook)) {
      const script = fs.readFileSync(globalHook, 'utf-8');
      if (script.includes(GLOBAL_MARKER) && needsStdinRepair(script)) {
        const { writeGlobalPostRewriteHook } = await import('./commands/enable.js');
        writeGlobalPostRewriteHook(globalHooksDir);
        repaired.push(globalHook);
      }
    }
  } catch { /* leave it as it was */ }
  try {
    if (repoPath) {
      const common = execFileSync('git', ['rev-parse', '--git-common-dir'], {
        cwd: repoPath, encoding: 'utf-8', stdio: ['ignore', 'pipe', 'ignore'],
        // Runs on every session start: no console flash under a Windows GUI
        // agent, and never a hung git holding the hook.
        windowsHide: true, timeout: 5_000,
      }).trim();
      const localHook = path.join(path.resolve(repoPath, common), 'hooks', 'post-rewrite');
      if (fs.existsSync(localHook)) {
        const fixed = repairLocalPostRewriteScript(fs.readFileSync(localHook, 'utf-8'));
        if (fixed) {
          fs.writeFileSync(localHook, fixed);
          repaired.push(localHook);
        }
      }
    }
  } catch { /* leave it as it was */ }
  return repaired;
}
