// The write-journal ledger, for a producer that is not the Claude Code hook.
//
// Three producers used to know how to start a journal and apply it: the
// user-prompt-submit hook (a detached watcher, keyed on the session state),
// the transcript watcher (an in-process watcher, keyed on the session tag) and
// the heartbeat (read only — it never started one). Everyone else was on the
// legacy reconstruction: the Codex daemon never touched the ledger at all, and
// the Antigravity hook path short-circuits before the shared dispatcher, so
// neither of the two agents with the WORST evidence ever reached the module
// built for them.
//
// This file is the one place a long-lived producer (a daemon, a poll loop)
// asks for a journal and hands its rows to the ledger. The precedence rule is
// unchanged and lives in capture-from-ledger.ts: a row is replaced wholesale
// or left alone, never blended.
import { applyLedgerToMappings, type LedgerApplicableMapping } from './capture-from-ledger.js';
import {
  readJournalEntries, journalPathsForTag, startWriteJournal, markTurn,
  journalWatcherIsLive, type JournalWatcher,
} from './write-journal-watch.js';
import { turnIdsInJournal } from './write-journal.js';
import fs from 'fs';
import { readFileAtRev, gitIgnoredFiles } from './git-capture.js';
import { debugLog } from './debug-log.js';

/**
 * Write-journal watchers this process is holding open, keyed by session tag.
 *
 * Held IN-PROCESS rather than spawned. A daemon already runs for the life of
 * the session, so an in-process watcher needs no lock file, no orphan reaping
 * and no second node process per session.
 */
const journalWatchers = new Map<string, JournalWatcher>();
/** The lock refreshers that go with them — see ensureInProcessJournal. */
const lockRefreshers = new Map<string, NodeJS.Timeout>();
/** Same cadence as the detached watcher, so a reader's staleness rule fits both. */
const LOCK_REFRESH_MS = 15_000;

/** Bound the fleet: a box with dozens of stale transcripts must not open dozens
 *  of recursive watchers. Sessions past this simply keep the old behaviour. */
export const MAX_JOURNAL_WATCHERS = 12;

/** Test hook: release every in-process journal watcher this module holds. */
export function __stopAllJournalWatchers(): void {
  for (const tag of [...journalWatchers.keys()]) stopJournalWatcher(tag);
}

export function stopJournalWatcher(tag: string): void {
  const t = lockRefreshers.get(tag);
  if (t) { clearInterval(t); lockRefreshers.delete(tag); }
  const w = journalWatchers.get(tag);
  if (!w) return;
  try { w.stop(); } catch { /* already gone */ }
  journalWatchers.delete(tag);
  try { fs.unlinkSync(journalPathsForTag(tag).lockPath); } catch { /* not ours, or gone */ }
}

/** How many in-process watchers are open right now. Exposed for tests. */
export function openJournalWatcherCount(): number {
  return journalWatchers.size;
}

/**
 * Make sure this session is journalling, and mark the turn now in flight.
 *
 * Marks only the NEWEST turn, and only once. An earlier turn that was never
 * marked cannot be marked correctly after the fact — writes already in the log
 * would fall inside its span — so it is left unmarked and the ledger simply
 * declines to answer for it, which the caller treats as "fall back", not as
 * "the turn wrote nothing".
 *
 * The boundary here is POLL-BOUNDED, unlike the hook path where the mark is
 * written at prompt submit. A write landing between the real prompt and this
 * mark is attributed to the previous turn — the same soft edge the turn window
 * already has, so this is no worse on boundaries and exact on CONTENT, which is
 * the part the ledger is for.
 *
 * Never throws: the journal is an optimisation and must not break a poll.
 */
export function ensureInProcessJournal(
  tag: string,
  workRoot: string,
  turnIds: readonly string[],
): void {
  if (!tag || !workRoot) return;
  try {
    const { journalPath, snapshotDir, lockPath } = journalPathsForTag(tag);
    // The hook path may already have a DETACHED watcher on this journal. Two
    // watchers would both append, doubling every record, so defer to it and
    // only contribute the turn mark below.
    if (!journalWatchers.has(tag)
      && !journalWatcherIsLive(lockPath)
      && journalWatchers.size < MAX_JOURNAL_WATCHERS) {
      const w = startWriteJournal(workRoot, journalPath, { snapshotDir });
      // null = no recursive watch on this platform; leave the map empty so the
      // next poll can retry rather than caching the failure forever.
      if (w) {
        journalWatchers.set(tag, w);
        // OWN THE LOCK. The lock is how every producer tells the others a
        // recorder is live; an in-process watcher that held none was invisible
        // to the hook path, which then spawned a detached watcher beside it,
        // and both appended every write. Two identical records per write is
        // not harmless: the reclaim of a revealed turn took one copy and left
        // the other behind, so the turn read its own write as already there.
        const claim = (): void => { try { fs.writeFileSync(lockPath, String(process.pid)); } catch { /* best-effort */ } };
        claim();
        const timer = setInterval(claim, LOCK_REFRESH_MS);
        timer.unref?.();
        lockRefreshers.set(tag, timer);
      }
    }
    const latest = turnIds[turnIds.length - 1];
    if (!latest) return;
    const marked = new Set(turnIdsInJournal(readJournalEntries(journalPath)));
    if (!marked.has(latest)) markTurn(journalPath, latest);
  } catch { /* the journal is an optimisation; never break the poll */ }
}

/** What a producer knows about its session that the ledger needs. */
export interface ProducerLedgerInputs {
  /** Session tag the journal is keyed on — the same derivation the hook path uses. */
  tag: string;
  /** Working tree the session writes in; where `git show` runs. */
  workRoot: string;
  /** `promptTurnIds[i]` is the identity of prompt i. */
  promptTurnIds: readonly string[];
  /** Per-prompt baseline: the tree at the START of prompt i, dirt included. */
  promptShadows?: ReadonlyArray<{ promptIndex: number; shadowSha: string }>;
  /** Fallbacks when a prompt has no shadow of its own. */
  prePromptSha?: string | null;
  headShaAtStart?: string | null;
}

/**
 * Replace each row's capture with the ledger's, where the ledger has one.
 *
 * A row the ledger owns is marked `authoritative`: a ledger capture IS the
 * complete per-turn answer, which is what that flag means to the server —
 * replace the row wholesale rather than fill gaps. `diffSource: 'ledger'`
 * travels on the wire; the internal `ledgerOwned` marker is stripped so a
 * watcher payload carries nothing the server does not know.
 *
 * Returns how many rows it replaced. Never throws.
 */
export function applyLedgerToProducerRows(
  inputs: ProducerLedgerInputs,
  rows: Array<LedgerApplicableMapping & Record<string, unknown>>,
  via: string,
): number {
  const paths = journalPathsForTag(inputs.tag);
  const state = {
    writeJournalPath: paths.journalPath,
    writeSnapshotDir: paths.snapshotDir,
    promptTurnIds: [...inputs.promptTurnIds],
    promptShadows: inputs.promptShadows ? [...inputs.promptShadows] : undefined,
    prePromptSha: inputs.prePromptSha ?? null,
    headShaAtStart: inputs.headShaAtStart ?? null,
  };
  const replaced = applyLedgerToMappings(state, rows, {
    readEntries: readJournalEntries,
    readAtRev: inputs.workRoot
      ? (sha, file) => readFileAtRev(inputs.workRoot, sha, file)
      : undefined,
    ignoredFiles: inputs.workRoot
      ? (files) => gitIgnoredFiles(inputs.workRoot, files)
      : undefined,
    log: (event, data) => debugLog('ledger', event, { via, ...data }),
  });
  for (const row of rows) {
    if (!row.ledgerOwned) continue;
    delete row.ledgerOwned;
    row.authoritative = true;
  }
  if (replaced > 0) {
    debugLog('ledger', 'turns captured from the ledger this poll', { via, count: replaced, of: rows.length });
  }
  return replaced;
}

/**
 * The tag the HOOK path files a session under, given the watcher's tag.
 *
 * Every hook-driven agent stores its state at `.git/origin-session-<tag>.json`
 * with the bare tag (`agentSessionId.slice(0, 12)`). Antigravity's handler is
 * the exception: it prefixes `agy-`, and that prefixed tag is where its state
 * file, its minted turn ids and its journal all live. A watcher that reads the
 * bare tag for agy finds nothing, mints its own ids and marks its own journal —
 * two producers marking one tree under different names.
 */
export function hookStateTagFor(agentSlug: string, tag: string): string {
  if (agentSlug === 'antigravity' && !tag.startsWith('agy-')) return `agy-${tag}`;
  return tag;
}
