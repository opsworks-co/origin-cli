/**
 * One lock for every writer that reads a commit's note on refs/notes/origin
 * and writes it back (OR-11/A5): the rewrite hooks (history-preservation.ts)
 * and the session writer (`writeGitNotes`). Each of them runs in a background
 * hook process, so a rewrite of an amended commit and that commit's own
 * post-commit can overlap; without one lock the later `git notes add -f`
 * silently drops what the other just wrote. Nobody reads-merges-writes a note
 * without holding it: a writer that cannot get it in time writes nothing.
 *
 * The protocol never moves or deletes a lock somebody else may hold, so a
 * live holder cannot be robbed — not by an old lock, not by a racing breaker:
 *
 *  - The lock is a directory of EPOCH files `e<N>` (per repository, in the git
 *    common dir). The holder is the owner written in the highest epoch — its
 *    pid, the start token of that process, host, a random token, when it
 *    claimed and for how long (its lease). `e<N>.done` beside it means released.
 *  - To acquire, a contender looks at the highest epoch N. It may claim only
 *    when N is released, or its owner is provably gone, or its lease is over:
 *      · same host, pid gone → dead;
 *      · same host, pid alive but started at another time (the pid was reused
 *        by an unrelated process after the hook was killed) → dead;
 *      · otherwise — another host, no start token on this platform, an
 *        unreadable owner — it is waited for, but never longer than its lease
 *        (plus a grace for clock skew): no lock is permanent.
 *    It claims by creating `e<N+1>` exclusively, with its owner already in it
 *    (a hard link of a finished temp file). Two contenders for the same N:
 *    one link fails.
 *  - After the claim it lists the directory again: an epoch higher than its
 *    own means it acted on a stale view (its own epoch is dropped, it retries).
 *    The highest epoch never goes down — only a newer owner prunes older files,
 *    after its own file exists — so this check is sound.
 *  - A lease can end under a holder that is still working (a hung git, a
 *    stopped process). So the holder checks, right before every mutation, that
 *    its epoch is still the highest AND that the mutation's own time budget
 *    ends before its lease does (`NoteLease.holds`). A contender claims only
 *    after the lease plus the grace: the old holder's last write, bounded by
 *    that budget, is over by then. A holder that fails the check writes nothing.
 *  - Release writes `e<N>.done` for the holder's own epoch only, after checking
 *    the epoch file still names it. It deletes nothing.
 */
import crypto from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { runDetailed } from './utils/exec.js';

export const NOTE_LOCK_NAME = 'origin-notes-write.lock.d';
const DEFAULT_WAIT_MS = 20_000;
const MAX_WAIT_MS = 120_000;
/** How long a claim holds without proof its owner is gone. Every critical section is far shorter. */
export const NOTE_LOCK_LEASE_MS = 120_000;
/** Clock skew between two hosts sharing a lock directory: an expired lease is only claimed after it. */
export const NOTE_LOCK_GRACE_MS = 5_000;

export interface NoteLockOwner {
  pid: number;
  host: string;
  token: string;
  at: string;
  /** Start token of the process `pid` names (see processStartToken); absent when this platform has none. */
  start?: string;
  leaseMs?: number;
}

export interface NoteLockProbe {
  /** Is this pid (on this host) running? */
  isAlive?: (pid: number) => boolean;
  /** The start token of a running pid on this host, or null when it cannot be read here. */
  processStart?: (pid: number) => string | null;
  /** The clock, in epoch ms. */
  now?: () => number;
}

export interface NoteLockOptions extends NoteLockProbe {
  /** How long to wait for a holder. Default 20 s, or ORIGIN_NOTE_LOCK_WAIT_MS. */
  waitMs?: number;
  pollMs?: number;
  /** The lease this claim takes. Default NOTE_LOCK_LEASE_MS. */
  leaseMs?: number;
  /** Test seam: how the wait between two looks is spent. */
  sleep?: (ms: number) => void;
}

/** What a contender sees: the highest epoch and whether it may claim the next one. */
export interface NoteLockView {
  epoch: number;
  state: 'free' | 'held' | 'dead' | 'expired';
  owner?: NoteLockOwner;
}

/** What the holder is handed: whether it may still write. */
export interface NoteLease {
  epoch: number;
  /** When a contender may take the lock over, in epoch ms (grace not included). */
  expiresAt: number;
  /**
   * True when this epoch is still the highest and a mutation that takes at
   * most `budgetMs` ends before the lease does. Call right before every write;
   * false means: write nothing.
   */
  holds(budgetMs: number): boolean;
}

function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

export function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err: any) {
    // EPERM: it exists, it is just not ours to signal.
    return err?.code === 'EPERM';
  }
}

/**
 * What tells one process from a later one with the same pid: the kernel's
 * start time of the process. Linux: field 22 of /proc/<pid>/stat (clock ticks
 * since boot, plus the boot id so a reboot cannot alias it). macOS and other
 * Unix: `ps -o lstart=` in the C locale and UTC (to the second). Windows, or anything unreadable:
 * null — the lease alone bounds such a lock.
 */
export function processStartToken(pid: number): string | null {
  if (!Number.isInteger(pid) || pid <= 0) return null;
  try {
    if (process.platform === 'linux') {
      const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf-8');
      const fields = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
      const ticks = fields[19];
      if (!ticks || !/^\d+$/.test(ticks)) return null;
      let boot = '';
      try { boot = fs.readFileSync('/proc/sys/kernel/random/boot_id', 'utf-8').trim(); } catch { /* none */ }
      return `linux:${boot}:${ticks}`;
    }
    if (process.platform === 'win32') return null;
    // A fixed locale and zone: two hooks started with different LANG or TZ
    // must read the same token for the same process, or a live lock would
    // look reused.
    const r = runDetailed('ps', ['-o', 'lstart=', '-p', String(pid)], { timeoutMs: 2_000, env: { LC_ALL: 'C', LANG: 'C', TZ: 'UTC' } });
    const out = r.stdout.trim().replace(/\s+/g, ' ');
    return r.status === 0 && out ? `ps:${out}` : null;
  } catch {
    return null;
  }
}

let ownStart: string | null | undefined;
function myStartToken(): string | null {
  if (ownStart === undefined) ownStart = processStartToken(process.pid);
  return ownStart;
}

/** ORIGIN_NOTE_LOCK_WAIT_MS, when set: overrides a writer's default wait (tests, slow CI). */
export function noteLockWaitOverride(): number | undefined {
  const raw = process.env.ORIGIN_NOTE_LOCK_WAIT_MS;
  const env = Number(raw);
  return raw !== undefined && raw !== '' && Number.isFinite(env) && env >= 0 ? Math.min(env, MAX_WAIT_MS) : undefined;
}

function defaultWaitMs(): number {
  return noteLockWaitOverride() ?? DEFAULT_WAIT_MS;
}

/** The lock directory of a repository, or null outside one. */
export function noteLockPath(repoPath: string): string | null {
  const common = runDetailed('git', ['rev-parse', '--git-common-dir'], { cwd: repoPath, timeoutMs: 10_000 });
  if (common.status !== 0 || !common.stdout.trim()) return null;
  return path.join(path.resolve(repoPath, common.stdout.trim()), NOTE_LOCK_NAME);
}

export function newLockOwner(opts: { now?: () => number; leaseMs?: number } = {}): NoteLockOwner {
  const owner: NoteLockOwner = {
    pid: process.pid, host: os.hostname(), token: crypto.randomUUID(),
    at: new Date((opts.now ?? Date.now)()).toISOString(), leaseMs: opts.leaseMs ?? NOTE_LOCK_LEASE_MS,
  };
  const start = myStartToken();
  if (start) owner.start = start;
  return owner;
}

function readOwner(file: string): NoteLockOwner | null {
  try {
    const o = JSON.parse(fs.readFileSync(file, 'utf-8'));
    return o && Number.isInteger(o.pid) && o.pid > 0 && typeof o.host === 'string' && typeof o.token === 'string' ? o : null;
  } catch {
    return null;
  }
}

/** When the epoch's lease ends: its owner's claim time + lease, else the file's own age. */
function leaseEnd(file: string, owner: NoteLockOwner | null): number {
  const lease = owner && Number.isFinite(owner.leaseMs) && owner.leaseMs! > 0 ? Math.min(owner.leaseMs!, NOTE_LOCK_LEASE_MS) : NOTE_LOCK_LEASE_MS;
  const at = owner ? Date.parse(owner.at) : NaN;
  if (Number.isFinite(at)) return at + lease;
  try { return fs.statSync(file).mtimeMs + lease; } catch { return 0; }
}

function epochs(dir: string): number[] {
  let names: string[] = [];
  try { names = fs.readdirSync(dir); } catch { return []; }
  return names.map((n) => /^e(\d+)$/.exec(n)).filter((m): m is RegExpExecArray => !!m).map((m) => Number(m[1]));
}

const epochFile = (dir: string, n: number) => path.join(dir, `e${n}`);

/** Step 1 of an acquisition: look. */
export function observeNoteLock(
  dir: string,
  isAlive: (pid: number) => boolean = pidAlive,
  probe: Omit<NoteLockProbe, 'isAlive'> = {},
): NoteLockView {
  const all = epochs(dir);
  const epoch = all.length ? Math.max(...all) : 0;
  if (epoch === 0 || fs.existsSync(`${epochFile(dir, epoch)}.done`)) return { epoch, state: 'free' };
  const file = epochFile(dir, epoch);
  const owner = readOwner(file);
  if (owner && owner.host === os.hostname()) {
    if (!isAlive(owner.pid)) return { epoch, state: 'dead', owner };
    // Alive — but the pid may belong to a later process than the one that claimed.
    if (owner.start) {
      const now = (probe.processStart ?? processStartToken)(owner.pid);
      if (now !== null && now !== owner.start) return { epoch, state: 'dead', owner };
    }
  }
  // Nothing proves the owner gone: its lease bounds the wait.
  if ((probe.now ?? Date.now)() > leaseEnd(file, owner) + NOTE_LOCK_GRACE_MS) return { epoch, state: 'expired', owner: owner ?? undefined };
  return { epoch, state: 'held', owner: owner ?? undefined };
}

/**
 * Step 2: claim the epoch after the one observed. Returns the claimed epoch,
 * or null when the view was stale or not claimable. Never touches the
 * observed epoch or any file it did not create.
 */
export function claimNoteLock(dir: string, view: NoteLockView, me: NoteLockOwner): number | null {
  if (view.state === 'held') return null;
  const next = view.epoch + 1;
  fs.mkdirSync(dir, { recursive: true });
  const tmp = path.join(dir, `.claim-${me.token}-${crypto.randomUUID()}`);
  fs.writeFileSync(tmp, JSON.stringify(me), { mode: 0o600 });
  try {
    fs.linkSync(tmp, epochFile(dir, next));
  } catch (err: any) {
    if (err?.code === 'EEXIST') return null;
    throw err;
  } finally {
    try { fs.unlinkSync(tmp); } catch { /* gone */ }
  }
  if (Math.max(...epochs(dir)) > next) {
    // Stale view: a newer epoch already exists. Ours was never the lock.
    try { fs.unlinkSync(epochFile(dir, next)); } catch { /* gone */ }
    return null;
  }
  // We hold it: older epochs can go (nobody decides anything from them).
  for (const n of epochs(dir)) {
    if (n >= next - 1) continue;
    try { fs.unlinkSync(epochFile(dir, n)); } catch { /* gone */ }
    try { fs.unlinkSync(`${epochFile(dir, n)}.done`); } catch { /* gone */ }
  }
  return next;
}

/** Step 3: release our own epoch. Deletes nothing. */
export function releaseNoteLock(dir: string, epoch: number, me: NoteLockOwner): void {
  const owner = readOwner(epochFile(dir, epoch));
  if (!owner || owner.token !== me.token) return;
  try { fs.writeFileSync(`${epochFile(dir, epoch)}.done`, me.token, { mode: 0o600 }); } catch { /* best-effort */ }
}

/** The holder's view of its own claim. */
export function noteLease(dir: string, epoch: number, me: NoteLockOwner, now: () => number = Date.now): NoteLease {
  const expiresAt = Date.parse(me.at) + (me.leaseMs ?? NOTE_LOCK_LEASE_MS);
  return {
    epoch,
    expiresAt,
    holds(budgetMs: number): boolean {
      if (now() + Math.max(0, budgetMs) >= expiresAt) return false;
      const all = epochs(dir);
      if (!all.length || Math.max(...all) !== epoch) return false;
      if (fs.existsSync(`${epochFile(dir, epoch)}.done`)) return false;
      return readOwner(epochFile(dir, epoch))?.token === me.token;
    },
  };
}

/** A lease for writers outside any repository: nothing to race for. */
const UNLOCKED: NoteLease = { epoch: 0, expiresAt: Number.POSITIVE_INFINITY, holds: () => true };

/**
 * Run `fn` holding the repository's note-write lock. Returns null — without
 * running `fn` — when a holder keeps it past `waitMs`, or the lock cannot be
 * taken here at all. `fn` gets the lease and must check `holds(budget)` right
 * before each write. Outside a repository `fn` runs unlocked (there is no
 * note to race for).
 */
export function withNoteWriteLock<T>(repoPath: string, fn: (lease: NoteLease) => T, opts: NoteLockOptions = {}): T | null {
  const dir = noteLockPath(repoPath);
  if (!dir) return fn(UNLOCKED);
  const waitMs = opts.waitMs ?? defaultWaitMs();
  const pollMs = opts.pollMs ?? 25;
  const isAlive = opts.isAlive ?? pidAlive;
  const now = opts.now ?? Date.now;
  const sleep = opts.sleep ?? sleepSync;
  // One `ps` per pid per second at most while polling a live holder.
  const cache = new Map<number, { at: number; token: string | null }>();
  const processStart = (pid: number): string | null => {
    const hit = cache.get(pid);
    if (hit && now() - hit.at < 1_000) return hit.token;
    const token = (opts.processStart ?? processStartToken)(pid);
    cache.set(pid, { at: now(), token });
    return token;
  };
  const deadline = now() + waitMs;
  let me: NoteLockOwner;
  let epoch: number | null = null;
  for (;;) {
    const view = observeNoteLock(dir, isAlive, { processStart, now });
    if (view.state !== 'held') {
      // The lease runs from the claim, not from when we started waiting.
      me = newLockOwner({ now, leaseMs: opts.leaseMs });
      try {
        epoch = claimNoteLock(dir, view, me);
      } catch {
        return null; // cannot create a lock here at all: do not write unlocked
      }
      if (epoch !== null) break;
      if (now() >= deadline) return null;
      continue; // lost the race for that epoch: look again
    }
    if (now() >= deadline) return null;
    sleep(pollMs);
  }
  try {
    return fn(noteLease(dir, epoch, me, now));
  } finally {
    releaseNoteLock(dir, epoch, me);
  }
}
