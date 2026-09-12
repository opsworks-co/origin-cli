// The watcher half of the write journal — see write-journal.ts for why.
//
// Deliberately small and defensive: it runs for the whole life of a session,
// in the user's repo, alongside their agent. It must never hold the agent up,
// never grow without bound, and never take the process down. Anything it
// cannot do, it stops doing — the turn window remains the fallback.
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as crypto from 'crypto';
import { normalizePath } from './paths.js';
import {
  serializeRecord, serializeTurnMark, serializeFence, parseJournal, parseJournalEntries, trimJournal,
  type WriteRecord, type JournalEntry,
} from './write-journal.js';
import { shouldIgnoreFile, isOriginAutoManagedPath } from './ignore-patterns.js';
import { snapshotFile, storeBytes, pruneUnreferenced, MAX_STORE_BYTES } from './write-journal-store.js';
import { debugLog } from './debug-log.js';

/** Retention: comfortably longer than any single turn, far shorter than a session. */
export const JOURNAL_KEEP_MS = 6 * 60 * 60 * 1000;
export const JOURNAL_MAX_RECORDS = 20_000;
/** Collapse repeated writes to one file; editors and compilers fire in bursts. */
export const DEBOUNCE_MS = 250;

/**
 * Paths never worth recording.
 *
 * `.git` is the important one: every git command rewrites index/refs/logs, so
 * watching it turns a quiet repo into thousands of events per commit and
 * drowns the real writes. The rest is the usual build churn, plus Origin's own
 * managed files so the tool does not journal itself.
 */
export function isJournalIgnored(relPath: string): boolean {
  if (!relPath) return true;
  const p = relPath.replace(/\\/g, '/');
  if (p === '.git' || p.startsWith('.git/') || p.includes('/.git/')) return true;
  if (isOriginAutoManagedPath(p)) return true;
  if (shouldIgnoreFile(p)) return true;
  if (isAtomicWriteTemp(p)) return true;
  return false;
}

/**
 * Scratch files from an atomic write — created, renamed away, never the work.
 *
 * A tool that replaces a file safely writes `foo.ts.tmp.<pid>.<rand>` and
 * renames it over `foo.ts`. The watcher sees BOTH: a create for the temp name
 * and a delete when the rename removes it. Journalled, that becomes a file the
 * turn "deleted" — observed on a real session, whose turn carried
 * `hooks.ts.tmp.4017.a5d6febb3c37` and `_tmp_14780_986518add…` alongside its
 * genuine edits.
 *
 * Deliberately narrow: only shapes that carry a pid or a random suffix, so a
 * real file someone named `tmp.ts` or `temp/config.json` is untouched. A missed
 * temp file is noise in one turn; a wrongly-ignored real file is work that
 * vanishes, and the second is much worse.
 */
export function isAtomicWriteTemp(relPath: string): boolean {
  const base = relPath.split('/').pop() || '';
  return (
    // foo.ts.tmp.4017.a5d6febb3c37  (Claude Code, and our own snapshot writes)
    /\.tmp\.\d+\.[a-z0-9]+$/i.test(base)
    // _tmp_14780_986518add3a23ecd52a4d7f54550993f
    || /^_tmp_\d+_[a-f0-9]{8,}$/i.test(base)
    // foo.ts.<6+ random>.tmp / .swp / .swx — editors' in-place buffers
    || /\.[a-z0-9]{6,}\.tmp$/i.test(base)
    || /^\..*\.sw[a-z]$/i.test(base)
  );
}

export interface JournalWatcher {
  stop(): void;
}

/**
 * A short, stable fingerprint of a working tree, for the journal filename.
 *
 * Normalised first, so a symlinked temp root (/tmp → /private/tmp) and an 8.3
 * short path on Windows fingerprint the same as their real directory — the
 * same equality `samePath` gives, which is what every other tree comparison in
 * the capture path uses. Case-folded on the two case-insensitive platforms for
 * the same reason `samePath` folds there.
 */
export function journalRootSlug(root: string): string {
  const norm = normalizePath(root);
  const keyed = (process.platform === 'win32' || process.platform === 'darwin')
    ? norm.toLowerCase()
    : norm;
  return crypto.createHash('sha256').update(keyed).digest('hex').slice(0, 8);
}

/**
 * Where a session's journal and snapshot store live — keyed by its tag AND the
 * working tree it is recording.
 *
 * Shared so the hook path (which CREATES them) and every reader compute the
 * same paths. Deriving them independently is how one writer ends up journalling
 * to a file nobody reads — the failure mode this codebase already has a guard
 * for in paths.ts.
 *
 * The ROOT is in the key because a tag alone does not identify a journal. A tag
 * is derived from the conversation, and one conversation can be claimed for two
 * different working trees — a session registered under the main checkout before
 * its worktree existed, a producer that derives the repo differently from the
 * hook path. Both then resolved to ONE `<tag>.jsonl`, and the second claimant
 * found the first's lock fresh and silently deferred to it. Its watcher was
 * watching a tree the session never wrote in, so every write was invisible:
 * the journal held one turn mark and zero records, the lock stayed fresh
 * because the wrong-tree watcher kept refreshing it, and no hook ever logged a
 * spawn. Reproduced exactly by claiming one tag for two trees.
 *
 * `root` is optional only so a caller that genuinely has no tree (a cleanup
 * sweep) can still name the legacy path; every creating caller passes one.
 *
 * A session whose state file already holds a `writeJournalPath` keeps reading
 * THAT path, so journals written before this keep resolving — they are
 * ephemeral anyway, and nothing migrates.
 */
export function journalPathsForTag(tag: string, root?: string | null): { journalPath: string; snapshotDir: string; lockPath: string } {
  const dir = path.join(os.homedir(), '.origin', 'journals');
  const key = root ? `${tag}-${journalRootSlug(root)}` : tag;
  return {
    journalPath: path.join(dir, `${key}.jsonl`),
    snapshotDir: path.join(dir, `${key}.snapshots`),
    lockPath: path.join(dir, `${key}.lock`),
  };
}

/** A lock touched within this window means a watcher is alive; older is a corpse. */
export const JOURNAL_WATCH_LOCK_STALE_MS = 60_000;

/**
 * Is a DETACHED journal watcher already running for this session?
 *
 * Two watchers on one journal would both append, doubling every record. The
 * hook path spawns a detached watcher and heartbeats this lock; anything that
 * wants to start its own must ask first.
 */
export function journalWatcherIsLive(lockPath: string, now = Date.now()): boolean {
  try {
    return now - fs.statSync(lockPath).mtimeMs <= JOURNAL_WATCH_LOCK_STALE_MS;
  } catch {
    return false;
  }
}

export interface JournalOptions {
  /**
   * Where to keep content snapshots. When set, each observed write also stores
   * the file's content, which is what lets a turn's diff be READ rather than
   * reconstructed. Omit to keep the original path-and-time-only behaviour.
   */
  snapshotDir?: string;
  /** Test seam. */
  now?: () => number;
  /**
   * Whether this watcher may hold the process open by itself.
   *
   * TRUE for exactly one caller: the detached `hooks journal-watch` process,
   * which exists for nothing else and must not exit while it watches. Every
   * other caller — hooks, the transcript watcher, tests — is a guest inside a
   * process with its own reasons to live and its own time to die, and a watcher
   * that outlives its owner there is a leak that nothing can clear.
   *
   * Defaults from ORIGIN_JOURNAL_IS_WATCHER, which the spawn sets, so the one
   * caller that needs it gets it without having to remember to ask.
   */
  holdProcessOpen?: boolean;
}

/**
 * Append a turn boundary to the journal.
 *
 * Called by whatever knows a turn has begun — the user-prompt-submit hook, or
 * the transcript watcher for an agent that fires none. Cheap enough to call on
 * every turn and safe to call twice: `turnSpan` honours the LAST mark for an id.
 *
 * Never throws. A missing mark costs a turn its exact attribution and falls
 * back to the time window; a thrown error would cost the user their agent.
 */
export function markTurn(journalPath: string, turnId: string, at = Date.now(), reclaim?: string[]): void {
  if (!journalPath || !turnId) return;
  try {
    fs.mkdirSync(path.dirname(journalPath), { recursive: true });
    fs.appendFileSync(journalPath, serializeTurnMark(reclaim && reclaim.length > 0 ? { at, turnId, reclaim } : { at, turnId }));
  } catch { /* best-effort, exactly like the writes */ }
}

export function fenceJournal(journalPath: string): void {
  try { if (journalPath) fs.appendFileSync(journalPath, serializeFence(Date.now())); } catch { /* best effort */ }
}

/**
 * Watch `repoPath`, appending a record per observed write to `journalPath`.
 *
 * Returns null when recursive watching is unavailable — the caller then keeps
 * the window as its only source, which is the previous behaviour rather than a
 * regression.
 */
export function startWriteJournal(
  repoPath: string,
  journalPath: string,
  opts: JournalOptions = {},
): JournalWatcher | null {
  if (!repoPath || !journalPath) return null;
  const lastSeen = new Map<string, number>();
  const now = opts.now ?? Date.now;
  // A journal that cannot be appended silently downgrades every turn to the
  // legacy reconstruction. Say so once per watcher, not per keystroke.
  let appendFailureLogged = false;
  let stopped = false;
  let watcher: fs.FSWatcher | null = null;

  // Running total, seeded once. `storeBytes` walks the whole store, which is
  // fine on a hook but not on every keystroke-triggered write event.
  const snapshotDir = opts.snapshotDir;
  let used = snapshotDir ? storeBytes(snapshotDir) : 0;

  // A write that lands inside another's debounce window is DEFERRED, never
  // dropped. The old `return` threw it away: an agent that appends to a file
  // twice in one command (`cat >> README.md` then `cat >> README.md`, or an
  // edit followed by a formatter) produced two events milliseconds apart, the
  // first was snapshotted mid-way and the second was ignored — so the journal
  // held a 62-line README for a turn that committed 68 lines, and the missing
  // six surfaced as the NEXT turn's work when that turn touched the file.
  // Prod vodka 944f7048, commit 0fcb7076. A trailing re-check at the end of the
  // window re-reads the file once, after the burst has settled.
  const pending = new Map<string, NodeJS.Timeout>();
  // What the last record for each file described — its content hash when a
  // store is attached, its mtime otherwise. The trailing re-read appends only
  // when that changed: Linux emits several inotify events per write, and a
  // re-read that recorded the same content again put a duplicate in the
  // journal, which shifted every "wait for N records" downstream.
  const lastKey = new Map<string, string>();
  const append = (rel: string, gone: boolean, mtime?: number, onlyIfChanged = false): void => {
    const t = now();
    const prev = lastSeen.get(rel);
    if (prev !== undefined && t - prev < DEBOUNCE_MS) {
      if (!pending.has(rel)) {
        const timer = setTimeout(() => {
          pending.delete(rel);
          if (stopped) return;
          let laterMtime: number | undefined;
          let laterGone = false;
          try {
            const st = fs.statSync(path.join(repoPath, rel));
            if (!st.isFile()) return;
            if (Number.isFinite(st.mtimeMs)) laterMtime = st.mtimeMs;
          } catch { laterGone = true; }
          lastSeen.delete(rel);
          append(rel, laterGone, laterMtime, true);
        }, Math.max(1, DEBOUNCE_MS - (t - prev)));
        timer.unref?.();
        pending.set(rel, timer);
      }
      return;
    }
    lastSeen.set(rel, t);

    const rec: WriteRecord = { file: rel, at: t };
    if (typeof mtime === 'number' && Number.isFinite(mtime)) rec.mtime = mtime;
    if (gone) {
      rec.gone = true;
    } else if (snapshotDir) {
      // A delete is recorded as a delete, never as a write of empty content —
      // an empty file exists and a deleted one does not.
      const put = snapshotFile(snapshotDir, path.join(repoPath, rel), {
        maxStoreBytes: MAX_STORE_BYTES,
        currentStoreBytes: used,
      });
      if (put) {
        if (put.hash) rec.hash = put.hash;
        rec.size = put.size;
        if (put.retained) rec.retained = true;
        if (put.outcome === 'stored') used += put.size;
      }
    }
    const key = gone ? 'gone' : (rec.hash || (rec.mtime !== undefined ? `m:${rec.mtime}` : ''));
    if (onlyIfChanged && key && lastKey.get(rel) === key) return;
    if (key) lastKey.set(rel, key);
    try {
      fs.appendFileSync(journalPath, serializeRecord(rec));
    } catch (err: unknown) {
      // Best-effort — never break the agent — but a journal that stops
      // recording makes the ledger decline every turn from here on, and that
      // fallback is invisible unless this line exists.
      if (!appendFailureLogged) {
        appendFailureLogged = true;
        debugLog('journal', 'write-journal append failed; the ledger will decline this session\'s turns', {
          journalPath, message: err instanceof Error ? err.message : String(err),
        });
      }
    }
  };

  try {
    fs.mkdirSync(path.dirname(journalPath), { recursive: true });
    // recursive:true is native on macOS and Windows and supported on Linux
    // from Node 20. Where it is not, the constructor throws and we return null
    // rather than silently watching only the top directory — a half-watch
    // would produce a journal that looks complete and is not.
    //
    // persistent:TRUE, and it matters more than it looks. The watcher runs in a
    // process spawned for no other purpose, and a non-persistent watcher does
    // not hold the event loop open. With `persistent:false` that process had
    // NOTHING referencing the loop — the idle timer is deliberately unref'd and
    // the caller's `await new Promise(() => {})` never settles — so node exited
    // with code 13 ("unsettled top-level await") the instant it started. It
    // wrote no records and never even created its own lock file, which is why
    // nothing looked broken: the journal was simply always empty, and every
    // caller treats an empty journal as "no journal here, use the window".
    // Verified by running the built binary: it exited immediately before this
    // change and stays up after it.
    watcher = fs.watch(repoPath, { recursive: true, persistent: true }, (_event, filename) => {
      if (stopped || !filename) return;
      const rel = String(filename).replace(/\\/g, '/');
      if (isJournalIgnored(rel)) return;
      // A directory event carries the directory name; only record real files.
      let gone = false;
      // The file's OWN last-write time, which is not the same fact as "an event
      // fired". fs.watch on Windows reports events for files whose bytes never
      // changed, and without this the journal cannot tell those apart from real
      // writes — see WriteRecord.mtime for what that cost.
      let mtime: number | undefined;
      try {
        const st = fs.statSync(path.join(repoPath, rel));
        if (!st.isFile()) return;
        if (Number.isFinite(st.mtimeMs)) mtime = st.mtimeMs;
      } catch {
        // Gone by the time we looked — a delete. Still this turn's doing.
        gone = true;
      }
      append(rel, gone, mtime);
    });
    watcher.on('error', () => { try { watcher?.close(); } catch { /* ignore */ } });

    // …but only the dedicated watcher PROCESS may be held open by it.
    //
    // `persistent: true` above is right for that process and wrong for every
    // other caller, because it applies to all of them. A hook, the transcript
    // watcher or a test now cannot exit while a watcher is open — so a watcher
    // that is never closed does not leak quietly any more, it hangs the whole
    // process.
    //
    // That is what it did. `Vitest (workspace)` hung on every run from the
    // commit that made this persistent, on the Linux runner only, while macOS
    // stayed green — the tests finished and the process would not exit.
    // Unbounded, so its logs could not be downloaded, so the cause could not be
    // read off CI for as long as it lasted.
    //
    // `unref()` keeps the watcher fully functional — events still fire, the
    // journal is still written — and stops it being a reason for the process to
    // stay alive. A missed close is a leak again rather than a hang, which is
    // the failure mode a caller can survive.
    const holdOpen = opts.holdProcessOpen ?? (process.env.ORIGIN_JOURNAL_IS_WATCHER === '1');
    if (!holdOpen) {
      // Not on every Node/platform combination; a watcher without it simply
      // keeps the old behaviour rather than failing to start.
      try { (watcher as unknown as { unref?: () => void }).unref?.(); } catch { /* ignore */ }
    }
  } catch {
    return null;
  }

  return {
    stop(): void {
      stopped = true;
      try { watcher?.close(); } catch { /* ignore */ }
    },
  };
}

/** Read a journal's writes, trimmed. Returns [] for a missing or unreadable file. */
export function readJournal(journalPath: string, now = Date.now()): WriteRecord[] {
  let text = '';
  try { text = fs.readFileSync(journalPath, 'utf-8'); } catch { return []; }
  return trimJournal(parseJournal(text), now, JOURNAL_KEEP_MS, JOURNAL_MAX_RECORDS);
}

/** Read the full ordered log — writes AND turn marks. Order is preserved. */
export function readJournalEntries(journalPath: string): JournalEntry[] {
  let text = '';
  try { text = fs.readFileSync(journalPath, 'utf-8'); } catch { return []; }
  return parseJournalEntries(text);
}

/**
 * Rewrite the journal with only the entries worth keeping.
 *
 * TURN MARKS ARE ALWAYS KEPT. They are a few dozen bytes each and they are the
 * spine of the log: dropping one silently merges two turns' writes into the
 * earlier turn's span, which is precisely the mis-attribution this design was
 * built to make impossible. Only writes age out, and a write aged out of a
 * turn already captured costs nothing — its `beforeHash` simply becomes
 * unknown, which the reader resolves from git rather than guessing.
 */
export function compactJournal(journalPath: string, now = Date.now(), snapshotDir?: string): void {
  try {
    const entries = readJournalEntries(journalPath);
    if (entries.length === 0) return;
    const writes = entries.filter((e): e is { kind: 'write' } & WriteRecord => e.kind === 'write');
    const keep = new Set(
      trimJournal(writes.map(({ kind: _k, ...r }) => r), now, JOURNAL_KEEP_MS, JOURNAL_MAX_RECORDS)
        .map((r) => `${r.file}\u0000${r.at}`),
    );
    const out: string[] = [];
    for (const e of entries) {
      if (e.kind === 'turn') { out.push(serializeTurnMark(e)); continue; }
      if (e.kind === 'fence') { out.push(serializeFence(e.at)); continue; }
      const { kind: _k, ...rec } = e;
      if (keep.has(`${rec.file}\u0000${rec.at}`)) out.push(serializeRecord(rec));
    }
    fs.writeFileSync(journalPath, out.join(''));
    // Whatever the compacted journal no longer names can go. Done here because
    // this is the only moment a hash stops being reachable.
    if (snapshotDir) {
      const live: string[] = [];
      for (const e of parseJournalEntries(out.join(''))) if (e.kind === 'write' && e.hash) live.push(e.hash);
      pruneUnreferenced(snapshotDir, live);
    }
  } catch { /* best-effort */ }
}
