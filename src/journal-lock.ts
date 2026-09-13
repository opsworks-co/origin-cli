// Cross-process ownership for a single journal. Never expire a live owner:
// a paused watcher must not resume beside a replacement writer.
import * as fs from 'fs';
import * as path from 'path';
import { randomUUID } from 'crypto';

export interface JournalLock { release(): void; owned(): boolean; }

export interface AcquireOptions {
  /**
   * How long an EMPTY lock directory is presumed to be a claimant between its
   * mkdir and its identity write. A long-lived lease can afford to wait a
   * minute; the per-write mutation lock cannot.
   */
  emptyGraceMs?: number;
}

// mkdir on a directory whose removal has not finished yet. Native Windows
// reports that as a permission or busy error rather than EEXIST, and it clears
// on its own a moment later. It is contention, not a reason to give up.
const TRANSIENT_MKDIR = new Set(['EPERM', 'EACCES', 'EBUSY']);

export function acquireJournalLock(dir: string, opts: AcquireOptions = {}): JournalLock | null {
  const name = `${process.pid}-${randomUUID()}`;
  const emptyGraceMs = opts.emptyGraceMs ?? 60_000;
  try {
    fs.mkdirSync(dir);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code && TRANSIENT_MKDIR.has(code)) return null;
    if (code !== 'EEXIST') throw error;
    // Remove only the dead owner's unique entry. A competing reaper cannot
    // remove a successor's entry, and rmdir refuses a nonempty directory.
    let removedDeadOwner = false;
    let entries: string[];
    try { entries = fs.readdirSync(dir); } catch { return null; }
    for (const entry of entries) {
      const pid = Number(entry.split('-')[0]);
      if (!Number.isSafeInteger(pid) || pid <= 0) continue;
      try { process.kill(pid, 0); } catch (err) {
        if ((err as NodeJS.ErrnoException).code === 'ESRCH') {
          try { fs.unlinkSync(path.join(dir, entry)); removedDeadOwner = true; } catch { /* another reaper */ }
        }
      }
    }
    // An empty directory can be a claimant between mkdir and writing its
    // identity — or what a release left behind when its rmdir failed (on
    // Windows, while a scanner still holds the identity it just unlinked).
    // Recovering one that was a live claimant is safe: the identity check
    // below makes a resumed claimant back off rather than join the new owner.
    try {
      if (fs.readdirSync(dir).length || (!removedDeadOwner && Date.now() - fs.statSync(dir).mtimeMs < emptyGraceMs)) return null;
      fs.rmdirSync(dir);
      fs.mkdirSync(dir);
    } catch { return null; }
  }
  const identity = path.join(dir, name);
  try {
    fs.writeFileSync(identity, '', { flag: 'wx' });
    // A claimant paused in an empty directory past recovery must not join
    // the new owner when it resumes.
    if (fs.readdirSync(dir).some((entry) => entry !== name)) {
      fs.unlinkSync(identity);
      return null;
    }
  } catch { return null; }
  return {
    owned: () => fs.existsSync(identity),
    release: () => {
      try { fs.unlinkSync(identity); } catch { return; }
      try { fs.rmdirSync(dir); } catch { /* a new owner arrived, or Windows still holds the identity */ }
    },
  };
}

const MUTATION_TIMEOUT_MS = 5_000;
// The mkdir-to-identity window of a mutation is two syscalls, and a leftover
// directory must not stall every writer: see acquireJournalLock.
const EMPTY_MUTATION_DIR_GRACE_MS = 250;
const POLL_MS = 5;
// A waiter removes its ticket when it gets the lock or gives up, so no live
// ticket outlives the longest timeout. Older ones belong to a process that
// hung or died under a reused pid.
const ABANDONED_TICKET_MS = 30_000;

const sleep = (ms: number): void => { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); };

/**
 * Take a numbered place in line. Numbers are wall-clock microseconds, bumped
 * past every ticket already waiting, so a process that arrives while others
 * wait always lands behind them — including a holder coming straight back for
 * its next write, which is what starved everyone else when the lock was a
 * free-for-all. Null when the line cannot be joined; the caller then competes
 * unordered, which is how every mutation worked before there was a line.
 */
function joinLine(line: string): string | null {
  try {
    fs.mkdirSync(line, { recursive: true });
    let last = 0;
    for (const entry of fs.readdirSync(line)) {
      const n = Number(entry.split('-')[0]);
      if (Number.isSafeInteger(n) && n > last) last = n;
    }
    const key = Math.max(Date.now() * 1000, last + 1);
    const ticket = `${String(key).padStart(20, '0')}-${process.pid}-${randomUUID()}`;
    fs.writeFileSync(path.join(line, ticket), '', { flag: 'wx' });
    return ticket;
  } catch {
    return null;
  }
}

function alive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch (err) {
    return (err as NodeJS.ErrnoException).code !== 'ESRCH';
  }
}

/** Is nobody still waiting ahead of `ticket`? Clears abandoned tickets it passes. */
function frontOfLine(line: string, ticket: string): boolean {
  let entries: string[];
  try { entries = fs.readdirSync(line); } catch { return true; }
  const now = Date.now();
  for (const entry of entries.sort()) {
    if (entry >= ticket) return true;
    const [keyText, pidText] = entry.split('-');
    const key = Number(keyText);
    const pid = Number(pidText);
    const abandoned = !Number.isSafeInteger(key) || !Number.isSafeInteger(pid) || pid <= 0
      || now - key / 1000 > ABANDONED_TICKET_MS || !alive(pid);
    if (!abandoned) return false;
    try { fs.unlinkSync(path.join(line, entry)); } catch { /* another waiter cleared it */ }
  }
  return true;
}

/** Serialize snapshots, appends, and read/replace/prune as one transaction. */
export function mutateJournal<T>(journalPath: string, action: () => T, opts: { timeoutMs?: number } = {}): T {
  const deadline = Date.now() + (opts.timeoutMs ?? MUTATION_TIMEOUT_MS);
  const line = `${journalPath}.mutation-queue`;
  const ticket = joinLine(line);
  let lock: JournalLock | null = null;
  try {
    do {
      if (!ticket || frontOfLine(line, ticket)) {
        lock = acquireJournalLock(`${journalPath}.mutation`, { emptyGraceMs: EMPTY_MUTATION_DIR_GRACE_MS });
        if (lock) break;
      }
      if (Date.now() >= deadline) {
        // An incomplete log cannot safely claim authoritative turn evidence.
        fs.writeFileSync(`${journalPath}.contended`, 'journal mutation timed out');
        throw new Error('journal mutation timed out');
      }
      sleep(POLL_MS);
    } while (true);
  } finally {
    // Leave the line as soon as the lock is ours, so the next waiter can start
    // polling for it; and on the way out of a timeout, so nobody waits on us.
    if (ticket) try { fs.unlinkSync(path.join(line, ticket)); } catch { /* already cleared */ }
  }
  try { return action(); } finally { lock.release(); }
}
