// The watcher half of the write journal — see write-journal.ts for why.
//
// Deliberately small and defensive: it runs for the whole life of a session,
// in the user's repo, alongside their agent. It must never hold the agent up,
// never grow without bound, and never take the process down. Anything it
// cannot do, it stops doing — the turn window remains the fallback.
import * as fs from 'fs';
import * as path from 'path';
import { serializeRecord, parseJournal, trimJournal, type WriteRecord } from './write-journal.js';
import { shouldIgnoreFile, isOriginAutoManagedPath } from './ignore-patterns.js';

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
  return false;
}

export interface JournalWatcher {
  stop(): void;
}

/**
 * Watch `repoPath`, appending a record per observed write to `journalPath`.
 *
 * Returns null when recursive watching is unavailable — the caller then keeps
 * the window as its only source, which is the previous behaviour rather than a
 * regression.
 */
export function startWriteJournal(repoPath: string, journalPath: string): JournalWatcher | null {
  if (!repoPath || !journalPath) return null;
  const lastSeen = new Map<string, number>();
  let stopped = false;
  let watcher: fs.FSWatcher | null = null;

  const append = (rel: string): void => {
    const now = Date.now();
    const prev = lastSeen.get(rel);
    if (prev !== undefined && now - prev < DEBOUNCE_MS) return;
    lastSeen.set(rel, now);
    try {
      fs.appendFileSync(journalPath, serializeRecord({ file: rel, at: now }));
    } catch { /* journal is best-effort; never break the agent */ }
  };

  try {
    fs.mkdirSync(path.dirname(journalPath), { recursive: true });
    // recursive:true is native on macOS and Windows and supported on Linux
    // from Node 20. Where it is not, the constructor throws and we return null
    // rather than silently watching only the top directory — a half-watch
    // would produce a journal that looks complete and is not.
    watcher = fs.watch(repoPath, { recursive: true, persistent: false }, (_event, filename) => {
      if (stopped || !filename) return;
      const rel = String(filename).replace(/\\/g, '/');
      if (isJournalIgnored(rel)) return;
      // A directory event carries the directory name; only record real files.
      try {
        const st = fs.statSync(path.join(repoPath, rel));
        if (!st.isFile()) return;
      } catch {
        // Gone by the time we looked — a delete. Still this turn's doing.
      }
      append(rel);
    });
    watcher.on('error', () => { try { watcher?.close(); } catch { /* ignore */ } });
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

/** Read a journal, trimmed. Returns [] for a missing or unreadable file. */
export function readJournal(journalPath: string, now = Date.now()): WriteRecord[] {
  let text = '';
  try { text = fs.readFileSync(journalPath, 'utf-8'); } catch { return []; }
  return trimJournal(parseJournal(text), now, JOURNAL_KEEP_MS, JOURNAL_MAX_RECORDS);
}

/** Rewrite the journal with only the records worth keeping. */
export function compactJournal(journalPath: string, now = Date.now()): void {
  try {
    const kept = readJournal(journalPath, now);
    fs.writeFileSync(journalPath, kept.map(serializeRecord).join(''));
  } catch { /* best-effort */ }
}
