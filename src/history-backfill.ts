/**
 * History backfill — push a local repo's pre-hook commit history to the API.
 *
 * The post-commit hook shadow-syncs only the commit just made, and for a
 * repo with no GitHub/GitLab connection that is the ONLY ingestion path:
 * the hosted server can't run git against the client's filesystem, so
 * commits made before Origin's hooks were installed (or pulled in from
 * another clone — `git pull` fires no post-commit) never reach the
 * dashboard — a 12-commit repo shows 3.
 *
 * Protocol: when history *might* be out of sync (no sync marker yet, a
 * multi-commit jump since the marker, or a rewritten HEAD), the hook
 * advertises the SHAs reachable from HEAD alongside its normal ingest;
 * the server answers with `unknownShas` (the ones it has no row for) and
 * this module extracts their metadata + patch from local git and pushes
 * them in size-bounded batches. A per-repo marker under ~/.origin (the
 * sandbox-safe state home — .git writes can be blocked, see #584) records
 * the synced HEAD so the steady-state commit path pays nothing beyond two
 * quick git queries.
 */
import fs from 'fs';
import os from 'os';
import path from 'path';
import crypto from 'crypto';
import { git, gitOrNull } from './utils/exec.js';

const SHA_RE = /^[0-9a-f]{7,40}$/i;

// How far back the hook advertises reachable history. Stays under the
// server's per-request recentShas validation cap (1000). Older history in
// a >500-commit repo is out of reach — callers log when the walk hits the
// cap so the truncation is at least visible in debug logs.
export const RECENT_SHAS_LIMIT = 500;
// Server-side MAX_COMMITS per /commits/ingest request.
const INGEST_BATCH = 200;
// Per-commit patch cap — same as the live post-commit path.
const MAX_DIFF_LEN = 500_000;
// Server truncates messages at 5000; don't ship more than it will keep.
const MAX_MESSAGE_LEN = 5000;
// Flush a batch once its serialized payload reaches this budget. Since #597
// /api/mcp genuinely accepts up to 50MB (the large-prefix parser now mounts
// before the global 2MB default — see apps/api/src/middleware/body-parsers.ts),
// this 1.2MB budget is a conservative margin, not a hard ceiling. Keeping it
// small bounds per-request memory and keeps each batch well inside the fetch
// timeout; an oversized batch would 413 and the backfill would never converge.
const BATCH_PAYLOAD_BUDGET = 1_200_000;
// Backfill requests carry MBs and the server upserts up to 200 rows per
// call — the hook-default 8s fetch timeout (sized for tiny live calls,
// #585) would abort them on ordinary uplinks, and the identical batch
// would be rebuilt and re-aborted on every future trigger.
export const BACKFILL_TIMEOUT_MS = 60_000;
// A fresh in-flight lock suppresses re-advertising so rapid consecutive
// commits don't run the same multi-MB backfill N times concurrently.
const LOCK_FRESH_MS = 10 * 60 * 1000;

export interface BackfillCommitPayload {
  sha: string;
  message?: string;
  author?: string;
  // Deliberately no `branch`: these commits were made on branches we can
  // no longer name (ancestry reachable from today's HEAD includes merged
  // feature work). Stamping the CURRENT branch on all of history would be
  // wrong and permanent — null lets a later provider sync fill it in.
  filesChanged?: string[];
  committedAt?: string;
  diff?: string;
}

export type IngestFn = (data: {
  repoPath: string;
  repoUrl?: string;
  // The advertise call (syncRepoHistory) sends the full reachable window;
  // backfill batches send a small server-KNOWN subset instead. The known
  // subset is what lets the server's basename-fallback confidence gate
  // corroborate each batch: batch commits are by definition unknown to the
  // server, so without it a moved no-remote checkout would resolve on the
  // advertise call but fail the gate on every batch — auto-registering a
  // duplicate repo row and landing the whole history there.
  recentShas?: string[];
  commits: BackfillCommitPayload[];
}) => Promise<any>;

// ─── Sync marker (~/.origin/history-sync) ─────────────────────────────────

interface SyncMarker {
  head: string;
  count: number;
  syncedAt: string;
}

function syncDir(): string {
  return path.join(os.homedir(), '.origin', 'history-sync');
}

function markerPath(repoPath: string): string {
  const key = crypto.createHash('sha256').update(repoPath).digest('hex').slice(0, 16);
  return path.join(syncDir(), `${key}.json`);
}

export function readSyncMarker(repoPath: string): SyncMarker | null {
  try {
    const raw = JSON.parse(fs.readFileSync(markerPath(repoPath), 'utf-8'));
    if (typeof raw?.head === 'string' && typeof raw?.count === 'number') return raw as SyncMarker;
  } catch { /* absent or corrupt — treat as never synced */ }
  return null;
}

export function writeSyncMarker(repoPath: string, head: string, count: number): void {
  try {
    fs.mkdirSync(syncDir(), { recursive: true });
    fs.writeFileSync(markerPath(repoPath), JSON.stringify({ head, count, syncedAt: new Date().toISOString() } satisfies SyncMarker));
  } catch { /* non-fatal — worst case we re-advertise next commit */ }
}

function lockPath(repoPath: string): string {
  return markerPath(repoPath).replace(/\.json$/, '.lock');
}

// ─── Failed-attempt backoff (session-start trigger only) ──────────────────
// The marker is written only after a CLEAN round, so a permanently failing
// ingest (403 unregistered repo on a team-scoped key, temp-path rejection)
// would otherwise make every session start fork a child, extract HEAD's
// full diff, and POST — forever. A failure stamp suppresses the
// session-start spawn for a backoff window; post-commit and forced
// `origin sync` ignore it, so real healing paths stay live.
const ATTEMPT_BACKOFF_MS = 6 * 60 * 60 * 1000;

function attemptStampPath(markerKey: string): string {
  return markerPath(markerKey).replace(/\.json$/, '.attempt');
}

export function writeAttemptStamp(markerKey: string): void {
  try {
    fs.mkdirSync(syncDir(), { recursive: true });
    fs.writeFileSync(attemptStampPath(markerKey), new Date().toISOString());
  } catch { /* non-fatal — worst case we retry sooner */ }
}

export function clearAttemptStamp(markerKey: string): void {
  try { fs.unlinkSync(attemptStampPath(markerKey)); } catch { /* ignore */ }
}

export function hasFreshFailedAttempt(markerKey: string): boolean {
  try {
    return Date.now() - fs.statSync(attemptStampPath(markerKey)).mtimeMs < ATTEMPT_BACKOFF_MS;
  } catch {
    return false;
  }
}

export function acquireBackfillLock(repoPath: string): boolean {
  const p = lockPath(repoPath);
  try {
    const age = Date.now() - fs.statSync(p).mtimeMs;
    if (age < LOCK_FRESH_MS) return false; // another hook's backfill is live
  } catch { /* no lock */ }
  try {
    fs.mkdirSync(syncDir(), { recursive: true });
    fs.writeFileSync(p, String(process.pid));
    return true;
  } catch {
    return true; // can't persist a lock — proceed rather than never backfill
  }
}

export function releaseBackfillLock(repoPath: string): void {
  try { fs.unlinkSync(lockPath(repoPath)); } catch { /* ignore */ }
}

/**
 * Decide whether this hook invocation should advertise recentShas at all.
 * Steady state (marker head is an ancestor and exactly one commit was
 * added) skips the advertisement entirely, so the per-commit cost of the
 * feature is two subprocess-fast git queries — not a 500-sha payload and
 * a 500-row server lookup on every commit forever.
 */
export function shouldAdvertiseHistory(repoPath: string, cwd: string): { advertise: boolean; head: string | null; count: number } {
  const head = gitOrNull(['rev-parse', 'HEAD'], { cwd })?.trim() || null;
  const countRaw = gitOrNull(['rev-list', '--count', 'HEAD'], { cwd })?.trim();
  const count = countRaw ? parseInt(countRaw, 10) : 0;
  if (!head || !Number.isFinite(count)) return { advertise: false, head, count: 0 };

  const marker = readSyncMarker(repoPath);
  if (!marker) return { advertise: true, head, count };

  // A jump of more than one commit since the marker means history arrived
  // outside the hook (pull, merge, cherry-pick sequence with hooks off).
  if (count > marker.count + 1) return { advertise: true, head, count };

  // A rewritten HEAD (rebase/amend chains) makes new SHAs the server has
  // never seen without growing the count. `merge-base --is-ancestor` exits
  // 0 when the marker head is still in our ancestry; anything else —
  // including the marker commit having been GC'd — means re-advertise.
  try {
    git(['merge-base', '--is-ancestor', marker.head, 'HEAD'], { cwd });
    return { advertise: false, head, count };
  } catch {
    return { advertise: true, head, count };
  }
}

/**
 * Standalone-trigger gate (session start): steady state is STRICT marker
 * equality — head and count unchanged since the last clean round. The
 * post-commit gate above tolerates a +1 count drift because the hook's own
 * request carries that one new commit; a standalone round has no such
 * carrier, so under the +1 slack a single `git pull`ed commit would report
 * "in-sync" and stay invisible until the next ≥2-commit jump — in a
 * pull-only repo (the exact case this trigger exists for) the freshest
 * pulled commit would always be one round behind. Strict equality also
 * skips the merge-base subprocess: an unchanged HEAD is provable by string
 * compare.
 */
export function shouldSyncStandalone(markerKey: string, cwd: string): { sync: boolean; head: string | null; count: number } {
  const head = gitOrNull(['rev-parse', 'HEAD'], { cwd })?.trim() || null;
  const countRaw = gitOrNull(['rev-list', '--count', 'HEAD'], { cwd })?.trim();
  const count = countRaw ? parseInt(countRaw, 10) : 0;
  if (!head || !Number.isFinite(count)) return { sync: false, head, count: 0 };
  const marker = readSyncMarker(markerKey);
  if (marker && marker.head === head && marker.count === count) return { sync: false, head, count };
  return { sync: true, head, count };
}

// ─── Commit extraction ─────────────────────────────────────────────────────

/**
 * Per-commit unified diff + touched files. The single shared implementation
 * of the fallback chain the live post-commit hook evolved over several bug
 * fixes (empty stdout on fresh branches, root commits, merges):
 *   1. `git diff <sha>~1..<sha>` — fast, non-root commits.
 *   2. `git diff-tree -p --root <sha>` — commit's own parent pointers, so
 *      it survives detached HEAD / shallow / weird-ref scenarios where (1)
 *      errors silently with empty stdout; --root covers the initial commit.
 *   3. `git show <sha> --format=` — last-resort, handles merge commits.
 */
export function extractCommitDiff(cwd: string, sha: string): { diff: string; filesChanged: string[] } {
  let filesChanged: string[] = [];
  const names = gitOrNull(['diff-tree', '--no-commit-id', '--name-only', '-r', '--root', sha], { cwd });
  if (names) filesChanged = names.trim().split('\n').filter(Boolean);

  let diff = gitOrNull(['diff', `${sha}~1..${sha}`], { cwd })?.trim() || '';
  if (!diff) {
    diff = gitOrNull(['diff-tree', '-p', '--root', '--no-color', sha], { cwd })?.trim() || '';
  }
  if (!diff) {
    diff = gitOrNull(['show', sha, '--format=', '--diff-merges=first-parent'], { cwd })?.trim() || '';
    if (diff && filesChanged.length === 0) {
      const showNames = gitOrNull(['show', sha, '--format=', '--name-only', '--diff-merges=first-parent'], { cwd });
      if (showNames) filesChanged = showNames.trim().split('\n').filter(Boolean);
    }
  }
  return { diff, filesChanged };
}

/** SHAs reachable from HEAD, newest first. Empty on any git failure. */
export function listRecentShas(cwd: string, limit: number = RECENT_SHAS_LIMIT): string[] {
  try {
    const out = git(['rev-list', `--max-count=${limit}`, 'HEAD'], { cwd });
    return out.trim().split('\n').filter((s) => SHA_RE.test(s));
  } catch {
    return [];
  }
}

/**
 * Extract one historical commit's ingest payload from local git.
 * Sends the FULL message body (not just the subject the live hook sends):
 * for backfilled commits the body's Co-Authored-By / agent trailers are
 * the only AI-attribution signal the server will ever get.
 */
export function buildCommitPayload(cwd: string, sha: string): BackfillCommitPayload | null {
  if (!SHA_RE.test(sha)) return null;
  const meta = gitOrNull(['log', '-1', '--format=%an%x1f%cI%x1f%B', sha], { cwd });
  if (meta === null) return null;
  const [author, committedAt, ...rest] = meta.split('\x1f');
  if (rest.length === 0) return null;
  const message = rest.join('\x1f').trim().slice(0, MAX_MESSAGE_LEN);

  const { diff, filesChanged } = extractCommitDiff(cwd, sha);

  return {
    sha,
    message,
    author,
    filesChanged,
    committedAt: committedAt || undefined,
    diff: diff ? diff.slice(0, MAX_DIFF_LEN) : undefined,
  };
}

/**
 * Ingest the server-reported unknown SHAs in payload-budgeted batches.
 * A failed batch is logged and skipped — later batches still get their
 * chance, and `failed` tells the caller not to write the sync marker so
 * the next trigger retries what's missing.
 */
export async function backfillUnknownCommits(opts: {
  repoPath: string;
  hookCwd: string;
  repoUrl?: string;
  unknownShas: string[];
  // SHAs the server acknowledged it already has (advertised − unknown) —
  // attached to every batch so the server's repo-resolution confidence
  // gate can prove shared history even though the batch's own commits are
  // all new to it.
  knownShas?: string[];
  ingest: IngestFn;
  onBatchError?: (err: unknown) => void;
}): Promise<{ accepted: number; failed: boolean }> {
  const shas = opts.unknownShas.filter((s) => typeof s === 'string' && SHA_RE.test(s));
  // One shared SHA already corroborates; 100 gives margin without bloating
  // every batch with the full 1000-entry window.
  const corroborate = (opts.knownShas || []).slice(0, 100);
  let accepted = 0;
  let failed = false;
  let batch: BackfillCommitPayload[] = [];
  let batchBytes = 0;

  const flush = async () => {
    if (batch.length === 0) return;
    const commits = batch;
    batch = [];
    batchBytes = 0;
    try {
      const res = await opts.ingest({
        repoPath: opts.repoPath,
        repoUrl: opts.repoUrl,
        ...(corroborate.length > 0 && { recentShas: corroborate }),
        commits,
      });
      accepted += typeof res?.ingested === 'number' ? res.ingested : 0;
    } catch (err) {
      failed = true;
      opts.onBatchError?.(err);
    }
  };

  for (const sha of shas) {
    const payload = buildCommitPayload(opts.hookCwd, sha);
    if (!payload) continue;
    batch.push(payload);
    // Budget the whole serialized commit, not just the diff — a giant
    // message or file list can 413 a batch just as surely as a patch.
    batchBytes += JSON.stringify(payload).length;
    if (batch.length >= INGEST_BATCH || batchBytes >= BATCH_PAYLOAD_BUDGET) await flush();
  }
  await flush();
  return { accepted, failed };
}

// ─── Standalone sync round (session-start child, `origin sync`) ───────────

export interface HistorySyncOutcome {
  status: 'no-git' | 'in-sync' | 'locked' | 'synced' | 'partial';
  /** SHAs advertised to the server (0 when the gate skipped the round). */
  advertised: number;
  /** SHAs the server reported it had no row for. */
  unknown: number;
  /** Commits the server accepted from the backfill. */
  accepted: number;
}

/**
 * One full advertise-and-backfill round, independent of any new commit —
 * the post-commit hook piggybacks its advertisement on the live commit's
 * ingest, but a repo used read-only (reviewing agents' branches, pulling
 * teammates' work) never fires post-commit, so its history gap persisted.
 * Run from the session-start hook's detached child and from `origin sync`.
 *
 * The ingest endpoint requires a non-empty commits[], so the round re-sends
 * the HEAD commit's payload as the carrier for recentShas — the server-side
 * upsert makes that idempotent, and when HEAD itself is unknown the full
 * payload (message body, author, patch) creates a complete row that the
 * update-only-backfills-patch upsert path could never repair afterwards.
 *
 * Same convergence rules as the post-commit path: the whole round runs
 * under the backfill lock, and the sync marker moves only after a round
 * with zero failed batches — a partial run re-advertises on the next
 * trigger (and stamps a failed attempt so the session-start spawner backs
 * off; see hasFreshFailedAttempt). `force` (manual `origin sync`) bypasses
 * the marker gate but still honors the lock.
 *
 * Marker and lock are keyed by the WORKING root (hookCwd) — the tree the
 * head/count actually describe. Keying by the canonical path made a main
 * checkout and a linked worktree with divergent HEADs ping-pong one shared
 * marker (each session start saw the other's head, re-advertised, and
 * rewrote it), so steady state was never reached.
 */
export async function syncRepoHistory(opts: {
  /** Canonical repo identity — the server-facing repoPath. */
  repoPath: string;
  /** Working-tree cwd for git reads AND the marker/lock key. */
  hookCwd: string;
  ingest: IngestFn;
  force?: boolean;
  log?: (message: string, data?: Record<string, unknown>) => void;
}): Promise<HistorySyncOutcome> {
  const log = opts.log ?? (() => { /* silent by default */ });
  const markerKey = opts.hookCwd;
  const none = (status: HistorySyncOutcome['status']): HistorySyncOutcome =>
    ({ status, advertised: 0, unknown: 0, accepted: 0 });

  const gate = shouldSyncStandalone(markerKey, opts.hookCwd);
  if (!gate.head) return none('no-git');
  if (!gate.sync && !opts.force) return none('in-sync');

  // Lock before the extraction: rev-list + the HEAD payload (up to 500KB of
  // diff via several git subprocesses) would otherwise be built and thrown
  // away by every concurrent loser of this race.
  if (!acquireBackfillLock(markerKey)) {
    log('history sync already in flight — skipping');
    return none('locked');
  }
  try {
    const recentShas = listRecentShas(opts.hookCwd);
    if (recentShas.length === 0) return none('no-git');
    if (recentShas.length >= RECENT_SHAS_LIMIT) {
      log('history window truncated at cap — older commits stay unsynced', { cap: RECENT_SHAS_LIMIT });
    }
    const head = buildCommitPayload(opts.hookCwd, gate.head);
    if (!head) return none('no-git');

    const repoUrl = gitOrNull(['config', '--get', 'remote.origin.url'], { cwd: opts.hookCwd })?.trim() || undefined;

    let unknownShas: string[];
    try {
      const res = await opts.ingest({ repoPath: opts.repoPath, repoUrl, recentShas, commits: [head] });
      unknownShas = Array.isArray(res?.unknownShas) ? (res.unknownShas as string[]) : [];
    } catch (err: any) {
      // Marker untouched — the next commit / forced sync retries; the stamp
      // keeps session starts from re-spawning into a persistent failure.
      log('history advertise ingest failed', { message: err?.message });
      writeAttemptStamp(markerKey);
      return { status: 'partial', advertised: recentShas.length, unknown: 0, accepted: 0 };
    }

    if (unknownShas.length === 0) {
      writeSyncMarker(markerKey, gate.head, gate.count);
      clearAttemptStamp(markerKey);
      return { status: 'synced', advertised: recentShas.length, unknown: 0, accepted: 0 };
    }

    const unknownSet = new Set(unknownShas);
    const { accepted, failed } = await backfillUnknownCommits({
      repoPath: opts.repoPath,
      hookCwd: opts.hookCwd,
      repoUrl,
      unknownShas,
      // Advertised SHAs the server acknowledged — the HEAD commit ingested
      // above is always among them, so even a first-ever sync corroborates.
      knownShas: recentShas.filter((s) => !unknownSet.has(s)),
      ingest: opts.ingest,
      onBatchError: (err: any) => log('history backfill batch failed — continuing', { message: err?.message }),
    });
    if (failed) {
      writeAttemptStamp(markerKey);
    } else {
      writeSyncMarker(markerKey, gate.head, gate.count);
      clearAttemptStamp(markerKey);
    }
    return { status: failed ? 'partial' : 'synced', advertised: recentShas.length, unknown: unknownShas.length, accepted };
  } finally {
    releaseBackfillLock(markerKey);
  }
}
