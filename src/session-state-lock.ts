// Serialize a state's read/merge/rename across hook processes. Atomic rename
// alone only protects readers from partial JSON; it does not prevent lost writes.
import fs from 'fs';
import os from 'os';
import path from 'path';
import crypto from 'crypto';
import { acquireJournalLock, frontOfLine, joinLine } from './journal-lock.js';
import { debugLog } from './debug-log.js';

/**
 * How long a save waits for the state lock before writing WITHOUT it.
 *
 * Same policy, and the same reason, as `claude-hook-lock.ts`: a rare lost
 * update on state is recoverable, a killed — or crashed — hook is not. This
 * function never throws for a lock reason. It used to: a timeout came back as
 * an exception, `user-prompt-submit` runs its auto-create save inside a `try`
 * whose `catch` is written for API failures, and the prompt was either filed
 * under a `local-<uuid>` id the server 404s or lost outright when the throw
 * escaped the handler (measured on the built binary: exit 1, prompt never on
 * disk). Serializing writes is an improvement over the unlocked behaviour;
 * failing the write is not, because unlocked is what every save did before
 * this lock existed.
 *
 * The wait is short because the hook budget is short. Origin installs Codex's
 * SessionStart and UserPromptSubmit with `timeout: 10` (`commands/enable.ts`)
 * and Codex KILLS a hook at its timeout; on Claude the caller may already have
 * spent up to 20s inside `withClaudeHookLock`, so the two must not stack past
 * the host's own timeout either. 2s leaves Codex ~8s of its budget for the
 * work itself, and stacks to 22s on Claude's default 60s.
 *
 * 2s is a long time for this lock: the slow work that used to run inside it
 * (session-start's baseline shadow commit, 26.8s on this repo) is now taken
 * outside, so a holder does a read, a merge and a rename and nothing else.
 */
export const STATE_LOCK_WAIT_MS = 2_000;
const POLL_MS = 5;
// The mkdir-to-identity window of a save is two syscalls, and a leftover
// directory must not stall every writer — the value `mutateJournal` uses.
const EMPTY_LOCK_DIR_GRACE_MS = 250;

const sleep = (ms: number): void => { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); };

/**
 * Where the locks live.
 *
 * Outside `.git` on purpose, so a sandbox-fallback writer (which writes its
 * state elsewhere) still takes the same lock as the normal path.
 *
 * KNOWN LIMIT: the path is rooted at `os.homedir()`, as `~/.origin` is
 * everywhere else in the CLI (`config.ts`, `claude-hook-lock.ts`). Two
 * processes running with different `HOME` values — a sandbox that rewrites it,
 * a hook launched from a daemon with none — key into different directories and
 * do not exclude one another. They fall back to the unlocked behaviour with
 * respect to each other, which is what every writer did before this lock; the
 * alternative (a lock beside the state file) is what `.git`-relative locking
 * already fails to do across a worktree and its main checkout.
 *
 * Null when the directory cannot be made: an unwritable home must not fail a
 * save that would have succeeded, so the caller runs unlocked instead.
 */
function lockRoot(): string | null {
  const dir = path.join(os.homedir(), '.origin', 'state-locks');
  try {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    return dir;
  } catch (err: unknown) {
    debugLog('session-state', 'state lock directory unavailable, saving without the lock', {
      dir, message: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
}

export function withSessionStateLock<T>(statePath: string, action: () => T, timeoutMs = STATE_LOCK_WAIT_MS): T {
  const dir = lockRoot();
  if (!dir) return action();
  // Use the common state filename, not the caller's checkout or conversation id:
  // Cursor's main-checkout handshake and worktree prompt have different ids.
  let canonical = path.resolve(statePath);
  try { canonical = path.join(fs.realpathSync.native(path.dirname(statePath)), path.basename(statePath)); } catch { /* directory not created yet */ }
  if (process.platform === 'win32') canonical = canonical.toLowerCase();
  const key = crypto.createHash('sha256').update(canonical).digest('hex');
  const lockPath = path.join(dir, `${key}.state-save-lock`);
  // #1600's ticket queue, not a free-for-all retry: numbered places in line so
  // a writer that arrives while others wait lands behind them, and a holder
  // coming straight back for its next save cannot starve them. Null when the
  // line cannot be joined — then compete unordered, as every mutation did
  // before there was a line.
  const line = `${lockPath}.queue`;
  const ticket = joinLine(line);
  const started = Date.now();
  const deadline = started + timeoutMs;
  let lock = null;
  try {
    for (;;) {
      if (!ticket || frontOfLine(line, ticket)) {
        try {
          lock = acquireJournalLock(lockPath, { emptyGraceMs: EMPTY_LOCK_DIR_GRACE_MS });
        } catch { lock = null; /* an unusable lock must not fail the save */ }
        if (lock) break;
      }
      if (Date.now() >= deadline) break;
      sleep(POLL_MS);
    }
  } finally {
    // Leave the line as soon as the lock is ours, so the next waiter can start
    // polling for it; and on the way out of a timeout, so nobody waits on us.
    if (ticket) try { fs.unlinkSync(path.join(line, ticket)); } catch { /* already cleared */ }
  }
  if (!lock) {
    debugLog('session-state', 'state lock wait exceeded, saving without the state lock', {
      statePath, waitedMs: Date.now() - started, limitMs: timeoutMs,
    });
    return action();
  }
  try { return action(); } finally { lock.release(); }
}

/**
 * Change a few fields of a session state file without losing anyone else's.
 *
 * For writers that own a handful of fields rather than the whole state — the
 * heartbeat's budget flags, policy rules and Codex prompt mirror. They used to
 * read the file, do their work (for the Codex mirror: shadow commits, seconds
 * of git), and write back the object they read — unlocked and in place. Any
 * field a hook saved in between was erased, and a hook reading mid-write could
 * see a truncated file.
 *
 * Here the read happens INSIDE the hooks' state lock, `patch` edits that fresh
 * copy, and the result is renamed into place. `patch` returns false to write
 * nothing. Returns whether a write happened; throws only for I/O errors, which
 * the caller already handles (a missing or unparseable file included).
 */
export function patchSessionStateFile(statePath: string, patch: (state: Record<string, any>) => boolean): boolean {
  return withSessionStateLock(statePath, () => {
    const state = JSON.parse(fs.readFileSync(statePath, 'utf-8'));
    if (!state || typeof state !== 'object' || Array.isArray(state)) return false;
    if (!patch(state)) return false;
    const tmp = `${statePath}.tmp.${process.pid}`;
    fs.writeFileSync(tmp, JSON.stringify(state), { mode: 0o600 });
    fs.renameSync(tmp, statePath);
    return true;
  });
}
