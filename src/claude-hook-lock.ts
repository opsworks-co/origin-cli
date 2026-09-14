import fs from 'fs';
import os from 'os';
import path from 'path';
import { createHash } from 'crypto';
import { acquireJournalLock } from './journal-lock.js';
import { debugLog } from './debug-log.js';

const MUTATING_EVENTS = new Set([
  'session-start', 'user-prompt-submit', 'pre-tool-use', 'post-tool-use', 'stop', 'session-end',
]);

/**
 * How long a hook waits for its conversation's lock before running without it.
 *
 * Claude Code kills a hook that outlives its timeout, and Origin sets none for
 * Claude, so the host default applies. Stop legitimately holds the lock for
 * 30-80s on a large repo. A user-prompt-submit queued behind it and killed
 * while waiting loses the prompt (see submit-hook-timeout memory: the prompt
 * then lands only at Stop, one turn late). Waiting well inside the host
 * timeout and then proceeding keeps today's unlocked behaviour as the floor:
 * a rare lost update on state is recoverable, a killed hook is not.
 */
const DEFAULT_LOCK_WAIT_MS = 20_000;

/**
 * Claude starts a separate process for each parallel tool hook. Atomic rename
 * prevents torn JSON, but two read/modify/save cycles still erase one another.
 * Lock BEFORE the handler discovers/loads state, including turn boundaries.
 * The native conversation id stays the same across worktrees and server-id
 * adoption. Different conversations never wait for each other.
 */
export async function withClaudeHookLock<T>(
  agent: string | undefined, event: string, sessionId: unknown, action: () => Promise<T>,
  options: { directory?: string; timeoutMs?: number } = {},
): Promise<T> {
  if (agent !== 'claude-code' || !MUTATING_EVENTS.has(event)
    || typeof sessionId !== 'string' || !sessionId) return action();
  const directory = options.directory ?? path.join(os.homedir(), '.origin', 'hook-locks');
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const key = createHash('sha256').update(sessionId).digest('hex');
  const lockPath = path.join(directory, key);
  const waitMs = options.timeoutMs ?? DEFAULT_LOCK_WAIT_MS;
  const started = Date.now();
  const deadline = started + waitMs;
  for (;;) {
    // A killed hook is reclaimed by PID, never by age: a slow live owner
    // cannot be displaced. The short grace handles a crash between mkdir
    // and writing the owner record. Policy process.exit() is safe too.
    const lock = acquireJournalLock(lockPath, { emptyGraceMs: 250 });
    if (lock) {
      try { return await action(); } finally { lock.release(); }
    }
    if (Date.now() >= deadline) {
      // Never throw here: a hook that fails or is killed while waiting drops
      // its capture (for user-prompt-submit, the prompt itself). Run unlocked,
      // which is exactly the behaviour before this lock existed, and say so.
      debugLog(event, 'claude hook lock wait exceeded, running without the lock', {
        waitedMs: Date.now() - started, limitMs: waitMs,
      });
      return action();
    }
    await new Promise(resolve => setTimeout(resolve, 10));
  }
}
