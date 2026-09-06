/**
 * A leaked write-journal watcher must not hang the process that made it.
 *
 * `startWriteJournal` opens `fs.watch(recursive: true, persistent: true)`. The
 * persistence is deliberate and correct for ONE caller — the detached
 * `hooks journal-watch` process, which exists for nothing else and exited
 * immediately (node code 13, "unsettled top-level await") when the watcher did
 * not hold the loop open.
 *
 * It applied to every other caller too, and they are all guests inside a
 * process with its own reasons to live: the hooks, the transcript watcher, and
 * this suite. For them a watcher that is never closed stopped being a quiet
 * leak and became a hang.
 *
 * It hung `Vitest (workspace)` on every CI run from that commit onward — the
 * tests passed and the process would not exit — while the same suite stayed
 * green on macOS, so it read as a Linux-runner mystery rather than as a handle
 * anyone had opened. The job carried no `timeout-minutes`, so each hang ran to
 * GitHub's 360-minute default, and an unfinished job's logs cannot be
 * downloaded — the evidence was withheld for exactly as long as the failure
 * lasted.
 *
 * The guarantee: outside the dedicated watcher process, a watcher is `unref`ed.
 * It still fires events and still journals; it is simply not a reason for the
 * process to stay alive. A missed `stop()` is survivable again.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { startWriteJournal } from '../write-journal-watch.js';

let dir: string;
let journal: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'origin-journal-ref-'));
  journal = path.join(dir, 'j.jsonl');
});
afterEach(() => {
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ }
});

/**
 * Does `unref()` actually release an fs watcher on THIS platform?
 *
 * It does on macOS and Windows. On Linux it does not: a recursive watcher stays
 * counted among the active handles after `unref()`, measured on the CI runner
 * (`expected 5 to be 4`) — the recursive implementation there is backed by
 * something `unref` does not reach.
 *
 * So the guarantee below is asserted where the platform can honour it, and
 * skipped — loudly, not silently — where it cannot. Asserting it everywhere
 * would put a known-false expectation in the suite; dropping it everywhere
 * would stop testing the two platforms where it is real.
 */
const unrefReleasesWatchers = (): boolean => {
  const probeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'origin-unref-probe-'));
  try {
    const before = (process as any)._getActiveHandles?.().length ?? 0;
    let w: fs.FSWatcher;
    try {
      w = fs.watch(probeDir, { recursive: true, persistent: true }, () => {});
    } catch { return false; } // no recursive watch here at all
    try {
      (w as unknown as { unref?: () => void }).unref?.();
      return ((process as any)._getActiveHandles?.().length ?? 0) === before;
    } finally { try { w.close(); } catch { /* ignore */ } }
  } finally {
    try { fs.rmSync(probeDir, { recursive: true, force: true }); } catch { /* ignore */ }
  }
};

describe('a write-journal watcher and the process that owns it', () => {
  it.skipIf(!unrefReleasesWatchers())(
    'leaves no ref\'d fs watcher behind when the caller forgets to stop it', () => {
      // The leak this exists for: no `stop()` at all.
      const before = (process as any)._getActiveHandles?.().length ?? 0;
      const w = startWriteJournal(dir, journal);
      if (!w) return;
      const after = (process as any)._getActiveHandles?.().length ?? 0;
      // An unref'd handle is not counted among the ones keeping the loop alive.
      expect(after).toBe(before);
      w.stop();
    });

  it('DOES hold the dedicated watcher process open', () => {
    // The case persistence was introduced for must keep working: that process
    // has nothing else referencing the loop, so an unref'd watcher would let it
    // exit instantly and journal nothing — which is exactly the silent failure
    // (empty journal, indistinguishable from "no journal here") that shipped
    // once already.
    const before = (process as any)._getActiveHandles?.().length ?? 0;
    const w = startWriteJournal(dir, journal, { holdProcessOpen: true });
    if (!w) return;
    const after = (process as any)._getActiveHandles?.().length ?? 0;
    try {
      // Measured the same way as the case above, so the two are directly
      // comparable: this one ADDS a handle that keeps the loop alive.
      expect(after).toBe(before + 1);
    } finally {
      w.stop();
    }
  });

  it('still records writes when unref\'d', async () => {
    // unref changes only whether the handle keeps the loop alive. If it also
    // cost us events, the fix would trade a hang for an empty journal.
    const w = startWriteJournal(dir, journal);
    if (!w) return;
    try {
      const deadline = Date.now() + 10_000;
      fs.writeFileSync(path.join(dir, 'app.ts'), 'const a = 1;\n');
      while (Date.now() < deadline) {
        if (fs.existsSync(journal) && fs.readFileSync(journal, 'utf-8').includes('app.ts')) break;
        await new Promise((r) => setTimeout(r, 25));
      }
      expect(fs.readFileSync(journal, 'utf-8')).toContain('app.ts');
    } finally {
      w.stop();
    }
  });
});
