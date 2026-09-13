// Cross-process ownership for a single journal. Never expire a live owner:
// a paused watcher must not resume beside a replacement writer.
import * as fs from 'fs';
import * as path from 'path';
import { randomUUID } from 'crypto';

export interface JournalLock { release(): void; owned(): boolean; }

export function acquireJournalLock(dir: string): JournalLock | null {
  const name = `${process.pid}-${randomUUID()}`;
  try {
    fs.mkdirSync(dir);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
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
    // identity. Give that startup window a minute before recovering it.
    try {
      if (fs.readdirSync(dir).length || (!removedDeadOwner && Date.now() - fs.statSync(dir).mtimeMs < 60_000)) return null;
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
      try { fs.rmdirSync(dir); } catch { /* a new owner already arrived */ }
    },
  };
}

/** Serialize snapshots, appends, and read/replace/prune as one transaction. */
export function mutateJournal<T>(journalPath: string, action: () => T): T {
  const deadline = Date.now() + 2_000;
  let lock: JournalLock | null;
  do {
    lock = acquireJournalLock(`${journalPath}.mutation`);
    if (lock) break;
    if (Date.now() >= deadline) {
      // An incomplete log cannot safely claim authoritative turn evidence.
      fs.writeFileSync(`${journalPath}.contended`, 'journal mutation timed out');
      throw new Error('journal mutation timed out');
    }
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
  } while (true);
  try { return action(); } finally { lock.release(); }
}
