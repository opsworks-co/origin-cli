// Memory notes that were written must reach the remote.
//
// The memory note is written in many places — session end, the post-commit
// hook, `origin todo done`, a TODO closure confirmed by the sweep, the MCP
// add_todo/close_todo tools — but pushed in only a few: session end, the
// heartbeat's end, `origin sync` and the pre-push hook. Everything else
// waited for one of those, and a push that failed was not tried again. A
// clone of rhodecode-new.com sat three note commits ahead of GitHub for days
// (2026-10-07 → 10-13), one of them a TODO closed by hand, so the dashboard
// kept the issue open.
//
// So a write leaves a marker in the repo's common .git — "memory written, not
// yet on the remote" — and starts one detached publisher for the repo
// (`origin hooks publish-memory <repo>`). Only a push that landed clears the
// marker, and any later session start in the repo tries again while it is
// there. Ahead-of-remote with no marker (notes from before this existed) is
// caught at session start too.
import { spawn } from 'child_process';
import fs from 'fs';
import path from 'path';
import { gitOrNull } from './utils/exec.js';

const MARKER = 'origin-memory-unpublished';
const LOCK = 'origin-memory-publish.lock';
/** A publisher holding the lock longer than this is gone; the next may take over. */
const STALE_LOCK_MS = 5 * 60_000;

function commonGitDir(repoPath: string): string | null {
  const d = gitOrNull(['rev-parse', '--git-common-dir'], { cwd: repoPath, timeoutMs: 5_000 })?.trim();
  if (!d) return null;
  return path.isAbsolute(d) ? d : path.resolve(repoPath, d);
}

export function unpublishedMarkerPath(repoPath: string): string | null {
  const dir = commonGitDir(repoPath);
  return dir ? path.join(dir, MARKER) : null;
}

/** Memory was written here and has not been confirmed on the remote since. */
export function hasUnpublishedMemory(repoPath: string): boolean {
  const m = unpublishedMarkerPath(repoPath);
  return !!m && fs.existsSync(m);
}

/** When the marker was last set (ms), or null. */
function markedAt(marker: string): number | null {
  try { return fs.statSync(marker).mtimeMs; } catch { return null; }
}

/**
 * Clear the marker after a push that landed — unless memory was written again
 * after `pushStartedMs`: that write is not in what was pushed.
 */
export function clearUnpublishedMemory(repoPath: string, pushStartedMs: number): void {
  const m = unpublishedMarkerPath(repoPath);
  if (!m) return;
  const at = markedAt(m);
  if (at !== null && at <= pushStartedMs) {
    try { fs.unlinkSync(m); } catch { /* already gone */ }
  }
}

/** Whether this process may start a background publisher (never from a test run). */
function autoPublishAllowed(env: NodeJS.ProcessEnv): boolean {
  return !env.VITEST && env.NODE_ENV !== 'test' && env.ORIGIN_NO_AUTO_PUBLISH !== '1';
}

/**
 * Start `origin hooks publish-memory <repo>`, detached, unless one is already
 * running for this repo. The publisher waits a moment so a burst of writes
 * (a session end writes memory, todos and closures in a row) goes out as one
 * push, then publishes until nothing written is left unpushed.
 */
export function schedulePublish(repoPath: string, env: NodeJS.ProcessEnv = process.env): boolean {
  if (!autoPublishAllowed(env)) return false;
  const dir = commonGitDir(repoPath);
  if (!dir) return false;
  if (publisherRunning(dir)) return false;
  const entry = process.argv[1];
  if (!entry) return false;
  try {
    const child = spawn(process.execPath, [entry, 'hooks', 'publish-memory', repoPath], {
      detached: true, stdio: 'ignore', windowsHide: true,
      env: { ...env, ORIGIN_NO_AUTO_PUBLISH: '1' },
    });
    child.on('error', () => { /* the next write or session start tries again */ });
    child.unref();
    return true;
  } catch {
    return false;
  }
}

/** Record that memory was written here, and get it published. */
export function markMemoryWritten(repoPath: string, env: NodeJS.ProcessEnv = process.env): void {
  const m = unpublishedMarkerPath(repoPath);
  if (!m) return;
  try { fs.writeFileSync(m, new Date().toISOString() + '\n'); } catch { return; }
  schedulePublish(repoPath, env);
}

function publisherRunning(gitDir: string): boolean {
  const lock = path.join(gitDir, LOCK);
  try {
    const age = Date.now() - fs.statSync(lock).mtimeMs;
    return age < STALE_LOCK_MS;
  } catch {
    return false;
  }
}

/** Take the per-repo publisher lock; false when another publisher holds it. */
export function takePublishLock(repoPath: string): (() => void) | null {
  const dir = commonGitDir(repoPath);
  if (!dir) return null;
  const lock = path.join(dir, LOCK);
  try {
    fs.writeFileSync(lock, String(process.pid), { flag: 'wx' });
  } catch {
    if (publisherRunning(dir)) return null;
    try { fs.writeFileSync(lock, String(process.pid)); } catch { return null; }
  }
  return () => { try { fs.unlinkSync(lock); } catch { /* fine */ } };
}

/**
 * Is the local memory note ahead of what this clone last fetched from the
 * remote? Notes written before the marker existed are found this way. No
 * network: it compares against the staging ref the notes fetch fills.
 */
export function memoryAheadOfFetched(repoPath: string): boolean {
  const local = gitOrNull(['rev-parse', '--verify', '--quiet', 'refs/notes/origin-memory'], { cwd: repoPath, timeoutMs: 5_000 })?.trim();
  if (!local) return false;
  const fetched = gitOrNull(['rev-parse', '--verify', '--quiet', 'refs/notes/origin-memory-remote'], { cwd: repoPath, timeoutMs: 5_000 })?.trim();
  if (!fetched) return false; // never fetched: nothing to compare against, and the push decides anyway
  if (fetched === local) return false;
  // Ahead when the local note has commits the fetched one lacks.
  const count = gitOrNull(['rev-list', '--count', `${fetched}..${local}`], { cwd: repoPath, timeoutMs: 5_000 })?.trim();
  return !!count && Number(count) > 0;
}

/** At session start: publish what an earlier write (or an older CLI) left behind. */
export function publishLeftovers(repoPath: string, env: NodeJS.ProcessEnv = process.env): boolean {
  if (!hasUnpublishedMemory(repoPath) && !memoryAheadOfFetched(repoPath)) return false;
  return schedulePublish(repoPath, env);
}

/** How long the publisher waits for a burst of writes to settle. */
export const PUBLISH_DEBOUNCE_MS = 15_000;

/**
 * `origin hooks publish-memory <repo>`: push the memory notes until nothing
 * written is left unpushed. Three tries at most; a push that fails leaves the
 * marker for the next write or session start.
 */
export async function publishMemoryAction(repoPath: string, opts: { debounceMs?: number } = {}): Promise<void> {
  const release = takePublishLock(repoPath);
  if (!release) return;
  try {
    await new Promise((r) => setTimeout(r, opts.debounceMs ?? PUBLISH_DEBOUNCE_MS));
    const { publishMemoryNotes } = await import('./memory-transport.js');
    for (let attempt = 0; attempt < 3; attempt++) {
      const res = await publishMemoryNotes(repoPath, 'publish-memory');
      if (!res.pushed) return;
      // Written again while that push ran: go round once more.
      if (!hasUnpublishedMemory(repoPath)) return;
    }
  } finally {
    release();
  }
}
