// Native Windows refuses a rename over a file another process has open — a
// hook reading it outside the state lock, or Defender scanning what was just
// written — and reports it as EPERM, EACCES or EBUSY. It clears on its own
// once that handle closes, a few to a few hundred milliseconds later.
//
// The same codes are also a real, lasting refusal — a sandbox that forbids
// writes inside .git. Retry only where the two can be told apart: a rename
// whose tmp file was just written into the same directory is not sandboxed.
import fs from 'fs';

const TRANSIENT = new Set(['EPERM', 'EACCES', 'EBUSY']);
const RETRY_BUDGET_MS = 1_000;

export class TransientFsRetryExhaustedError extends Error {
  readonly code: string | undefined;
  readonly originalError: unknown;

  constructor(err: unknown) {
    super(`Transient filesystem operation still refused after retrying: ${err instanceof Error ? err.message : String(err)}`);
    this.name = 'TransientFsRetryExhaustedError';
    this.code = (err as NodeJS.ErrnoException | undefined)?.code;
    this.originalError = err;
  }
}

const sleep = (ms: number): void => { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); };

export function isTransientFsError(err: unknown): boolean {
  return TRANSIENT.has((err as NodeJS.ErrnoException | undefined)?.code ?? '');
}

/**
 * Run `op` again while it fails with a transient code, for up to a second.
 * An exhausted transient refusal is wrapped so callers can distinguish native
 * contention from an initial permission denial. `onRetry` runs once, before
 * the first retry.
 */
export function retryTransient<T>(op: () => T, onRetry?: (err: unknown) => void, budgetMs = RETRY_BUDGET_MS): T {
  const deadline = Date.now() + budgetMs;
  let wait = 5;
  for (let attempt = 0; ; attempt++) {
    try {
      return op();
    } catch (err) {
      if (!isTransientFsError(err)) throw err;
      if (Date.now() >= deadline) throw new TransientFsRetryExhaustedError(err);
      if (attempt === 0) onRetry?.(err);
      sleep(Math.min(wait, Math.max(1, deadline - Date.now())));
      wait = Math.min(wait * 2, 100);
    }
  }
}

/** renameSync, retried while Windows holds the target. */
export function renameRetryingTransient(from: string, to: string, onRetry?: (err: unknown) => void): void {
  retryTransient(() => fs.renameSync(from, to), onRetry);
}
