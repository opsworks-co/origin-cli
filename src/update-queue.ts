// ── Durable retry queue for session capture uploads ─────────────────────────
//
// The hooks used to fire-and-forget their PATCHes: if the API was down (or a
// deploy was mid-restart, or the laptop was offline) at stop/session-end time,
// the turn's capture — transcript, per-prompt diffs, editsJson, git state —
// was silently lost forever. That is the root of the "partial/empty session"
// class the server sweeps up after (#396/#397/#402): the data never arrived.
//
// This module makes the valuable uploads durable:
//
//   durableUpdateSession / durableEndSession — try the call; on a RETRIABLE
//   failure (network error, 5xx, 408/429) persist the payload to
//   ~/.origin/queue/ and return null instead of throwing. Callers proceed;
//   nothing is lost.
//
//   drainUpdateQueue — replay pending entries oldest-first. Runs
//   fire-and-forget from the slow hooks (session-start / stop / session-end /
//   post-commit), and durableUpdateSession drains the SAME session's backlog
//   before sending fresh state so per-session ordering holds (an old queued
//   capture must never land after a newer one).
//
// Deliberately NOT queued: heartbeat pings and mid-turn branch updates — the
// next tick supersedes them; queueing would just flood the dir.
//
// Failure classes:
//   • retriable  — no HTTP status (network/DNS/refused), 5xx, 408, 429.
//   • permanent  — any other 4xx (validation/auth/gone): entry is dropped,
//     since replaying can never succeed. (401 also triggers the api client's
//     background re-login; once healed, FUTURE captures flow again.)
//
// Caps (safety valves, generous for the realistic failure — an API deploy
// window of a few minutes): 25MB/entry, 60 entries, 72h age, 25 attempts.

import { spawn } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { api } from './api.js';
import { DEFAULT_FETCH_TIMEOUT_MS, timeoutForPayload } from './fetch-timeout.js';
import { fitSessionUpdateForServer } from './session-update-size.js';

export type QueueKind = 'updateSession' | 'endSession' | 'ingestCommits';

export interface QueueEntry {
  v: 1;
  kind: QueueKind;
  sessionId: string;
  payload: any;
  attempts: number;
  enqueuedAt: string;
  lastError?: string;
  /**
   * A session-to-date state (Stop's update): every row the session has, not a
   * slice. A newer snapshot of the same session makes an older one worthless —
   * replaying it could only put back what the newer one corrected.
   */
  snapshot?: boolean;
}

type Log = (event: string, message: string, data?: any) => void;
const noop: Log = () => {};

// A commit ingest carries a patch and the server writes it to SQLite; on a
// loaded box that round-trip has been measured at ~15s. Replays are background
// work with no user waiting, so give them the same room the history backfill
// takes.
const INGEST_REPLAY_TIMEOUT_MS = 60_000;

const MAX_ENTRY_BYTES = 25 * 1024 * 1024;
// Largest session update a hook replays itself, with its 8s fast-fail. A
// session PATCH past a few hundred KB cannot land inside 8s (see
// api.updateSession); larger ones go to the background drain.
export const HOOK_REPLAY_MAX_BYTES = 256 * 1024;
const MAX_QUEUE_ENTRIES = 60;
const MAX_AGE_MS = 72 * 60 * 60 * 1000;
const MAX_ATTEMPTS = 25;
const LOCK_STALE_MS = 5 * 60 * 1000;

function queueDir(): string {
  return path.join(os.homedir(), '.origin', 'queue');
}

export function isRetriableApiError(err: any): boolean {
  const status = err?.status;
  if (typeof status !== 'number') return true; // network/DNS/refused/abort
  if (status >= 500) return true;
  return status === 408 || status === 429;
}

/** Persist a failed upload. Returns true when the entry was written. */
export function enqueueFailedUpdate(
  kind: QueueKind,
  sessionId: string,
  payload: any,
  err: any,
  log: Log = noop,
  opts: { snapshot?: boolean } = {},
): boolean {
  return writeQueueEntry(kind, sessionId, payload, err, log, opts) !== null;
}

/** The entry writer behind enqueueFailedUpdate; returns the entry's file name so a caller can remove it. */
function writeQueueEntry(
  kind: QueueKind,
  sessionId: string,
  payload: any,
  err: any,
  log: Log = noop,
  opts: { snapshot?: boolean } = {},
): string | null {
  try {
    const entry: QueueEntry = {
      v: 1,
      kind,
      sessionId,
      // Queued exactly as it will be sent: api.updateSession fits editsJson to
      // the server's limit, so storing the unfitted copy only fills the disk.
      payload: kind === 'updateSession' ? fitSessionUpdateForServer(payload) : payload,
      attempts: 0,
      enqueuedAt: new Date().toISOString(),
      lastError: err?.message || String(err),
      ...(opts.snapshot ? { snapshot: true } : {}),
    };
    const body = JSON.stringify(entry);
    if (body.length > MAX_ENTRY_BYTES) {
      log('queue', 'entry exceeds size cap — dropped', { sessionId, kind, bytes: body.length });
      return null;
    }
    const dir = queueDir();
    fs.mkdirSync(dir, { recursive: true });
    // Enforce the entry cap by dropping the OLDEST entries first — recent
    // captures are more likely to still matter (and to supersede older ones).
    const existing = listEntryFiles(dir);
    while (existing.length >= MAX_QUEUE_ENTRIES) {
      const oldest = existing.shift()!;
      try { fs.unlinkSync(path.join(dir, oldest)); } catch { /* already gone */ }
      log('queue', 'queue full — dropped oldest entry', { dropped: oldest });
    }
    // Timestamp-first name keeps directory order == replay order.
    const name = `${Date.now()}-${process.pid}-${Math.random().toString(36).slice(2, 8)}.json`;
    fs.writeFileSync(path.join(dir, name), body);
    log('queue', 'enqueued failed upload for retry', {
      sessionId, kind, bytes: body.length, error: entry.lastError,
    });
    return name;
  } catch (e: any) {
    log('queue', 'enqueue itself failed (giving up on this payload)', { message: e?.message });
    return null;
  }
}

/** Drop one queue entry by the name persistUpdateBeforeWork returned. */
export function removeQueuedUpdate(name: string | null | undefined): void {
  if (!name) return;
  try { fs.unlinkSync(path.join(queueDir(), name)); } catch { /* already drained or gone */ }
}

/**
 * Remove this session's snapshots queued before `sentAt`, other than `keep`.
 * Called once a newer snapshot has been sent or queued: see
 * QueueEntry.snapshot. The time bound keeps a snapshot another hook queued
 * while this one was still sending.
 */
function dropSupersededSnapshots(sessionId: string, keep: string | null, sentAt: number, log: Log): void {
  const dir = queueDir();
  for (const name of listEntryFiles(dir)) {
    if (name === keep) continue;
    // Names start with their enqueue time (see writeQueueEntry).
    const queuedAt = Number(name.split('-')[0]);
    if (!Number.isFinite(queuedAt) || queuedAt > sentAt) continue;
    const entry = readEntry(path.join(dir, name));
    if (!entry || entry.sessionId !== sessionId || entry.kind !== 'updateSession' || !entry.snapshot) continue;
    try { fs.unlinkSync(path.join(dir, name)); } catch { continue; }
    log('queue', 'dropped a queued snapshot a newer one supersedes', { sessionId, dropped: name });
  }
}

function listEntryFiles(dir: string): string[] {
  try {
    return fs.readdirSync(dir).filter((f) => f.endsWith('.json')).sort();
  } catch {
    return [];
  }
}

function readEntry(file: string): QueueEntry | null {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf-8'));
    if (parsed?.v === 1 && parsed.sessionId && parsed.kind) return parsed as QueueEntry;
  } catch { /* corrupt */ }
  return null;
}

async function replayEntry(entry: QueueEntry, updateTimeoutMs: number): Promise<void> {
  if (entry.kind === 'updateSession') {
    await api.updateSession(entry.sessionId, entry.payload, { timeoutMs: updateTimeoutMs });
  } else if (entry.kind === 'ingestCommits') {
    // Replayed with the backfill timeout, not the hook default: this payload
    // carries a per-commit patch, and the 8s default is what dropped it in the
    // first place. See the shadow-ingest call in handlePostCommit.
    await api.ingestCommits(entry.payload, { timeoutMs: INGEST_REPLAY_TIMEOUT_MS });
  } else {
    await api.endSession(entry.payload);
  }
}

// Best-effort cross-process lock (mkdir is atomic). A crashed drain leaves a
// stale dir; anything older than LOCK_STALE_MS is reclaimed.
function acquireLock(dir: string): boolean {
  const lock = path.join(dir, '.drain.lock');
  try {
    fs.mkdirSync(lock);
    return true;
  } catch {
    try {
      const st = fs.statSync(lock);
      if (Date.now() - st.mtimeMs > LOCK_STALE_MS) {
        fs.rmdirSync(lock);
        fs.mkdirSync(lock);
        return true;
      }
    } catch { /* raced — someone else owns it */ }
    return false;
  }
}
function releaseLock(dir: string): void {
  try { fs.rmdirSync(path.join(dir, '.drain.lock')); } catch { /* fine */ }
}

export interface DrainResult {
  replayed: number;
  dropped: number;
  remaining: number;
  /** Entries left for a background drain: too large to land inside a hook. */
  deferred: number;
}

/**
 * Replay pending entries oldest-first. When an entry fails retriably, LATER
 * entries for the same session are skipped this round (per-session order must
 * hold); other sessions keep draining. `forSessionId` narrows the drain to one
 * session's backlog (used by durableUpdateSession before sending fresh state).
 *
 * A session update is replayed with a timeout sized to its payload only when
 * `background` says nobody is waiting on this process. Everywhere else it keeps
 * the 8s fast-fail a hook needs, so an entry that cannot upload in 8s is
 * DEFERRED rather than attempted: replayed with the same 8s that failed it,
 * it failed again on every hook, forever, and blocked every later update of
 * its session behind it (session 874ff028: 4.7MB Stop updates, each aborted at
 * 8s, queued, and re-aborted by the next hook's drain). `hooks drain-queue`
 * is the background drain.
 *
 * `skipSnapshots` leaves the session's queued snapshots alone: the caller is
 * about to send a newer one, which replaces them.
 */
export async function drainUpdateQueue(
  log: Log = noop,
  opts: { forSessionId?: string; background?: boolean; skipSnapshots?: boolean } = {},
): Promise<DrainResult> {
  const dir = queueDir();
  const result: DrainResult = { replayed: 0, dropped: 0, remaining: 0, deferred: 0 };
  const files = listEntryFiles(dir);
  if (files.length === 0) return result;
  if (!acquireLock(dir)) {
    result.remaining = files.length;
    return result; // another process is draining
  }
  try {
    const blockedSessions = new Set<string>();
    for (const name of files) {
      const file = path.join(dir, name);
      const entry = readEntry(file);
      if (!entry) {
        try { fs.unlinkSync(file); } catch { /* gone */ }
        result.dropped++;
        continue;
      }
      if (opts.forSessionId && entry.sessionId !== opts.forSessionId) continue;
      if (opts.skipSnapshots && entry.snapshot && entry.kind === 'updateSession') { result.remaining++; continue; }
      if (blockedSessions.has(entry.sessionId)) { result.remaining++; continue; }
      const age = Date.now() - new Date(entry.enqueuedAt).getTime();
      if (age > MAX_AGE_MS || entry.attempts >= MAX_ATTEMPTS) {
        try { fs.unlinkSync(file); } catch { /* gone */ }
        result.dropped++;
        log('queue', 'entry expired — dropped', { sessionId: entry.sessionId, attempts: entry.attempts });
        continue;
      }
      let updateTimeoutMs = DEFAULT_FETCH_TIMEOUT_MS;
      if (entry.kind === 'updateSession') {
        let bytes = 0;
        try { bytes = fs.statSync(file).size; } catch { /* unknown — treat as small */ }
        if (bytes > HOOK_REPLAY_MAX_BYTES && !opts.background) {
          // Order still holds: nothing later of this session goes ahead of it.
          blockedSessions.add(entry.sessionId);
          result.remaining++;
          result.deferred++;
          continue;
        }
        if (opts.background) updateTimeoutMs = timeoutForPayload(bytes);
      }
      try {
        await replayEntry(entry, updateTimeoutMs);
        try { fs.unlinkSync(file); } catch { /* gone */ }
        result.replayed++;
        log('queue', 'replayed queued upload', { sessionId: entry.sessionId, kind: entry.kind });
      } catch (err: any) {
        if (isRetriableApiError(err)) {
          entry.attempts++;
          entry.lastError = err?.message || String(err);
          try { fs.writeFileSync(file, JSON.stringify(entry)); } catch { /* keep old copy */ }
          blockedSessions.add(entry.sessionId);
          result.remaining++;
        } else {
          // Permanent failure — replaying can never succeed; drop it.
          try { fs.unlinkSync(file); } catch { /* gone */ }
          result.dropped++;
          log('queue', 'permanent failure — dropped', {
            sessionId: entry.sessionId, status: err?.status, error: err?.message,
          });
        }
      }
    }
  } finally {
    releaseLock(dir);
  }
  return result;
}

/**
 * The drain a hook runs: fast-fail replays, and when something was too large
 * to replay inside a hook, a detached `origin hooks drain-queue` to replay it
 * with room. Its lock (acquireLock) keeps a second one from running at once.
 */
export async function drainQueueFromHook(log: Log = noop): Promise<DrainResult> {
  const result = await drainUpdateQueue(log);
  if (result.deferred > 0) spawnBackgroundDrain(result.deferred, log);
  return result;
}

function spawnBackgroundDrain(deferred: number, log: Log): void {
  const bin = process.argv[1];
  if (!bin) return;
  try {
    const child = spawn(process.execPath, [bin, 'hooks', 'drain-queue'], {
      detached: true,
      stdio: 'ignore',
      // A detached console app opens its own window on Windows without this.
      windowsHide: true,
    });
    child.unref();
    log('queue', 'handed large queued uploads to a background drain', { deferred });
  } catch (err: any) {
    log('queue', 'background drain spawn failed', { message: err?.message });
  }
}

/** Why a fresh send is queued instead: it must not land ahead of a deferred older update. */
const BEHIND_DEFERRED = { message: 'queued behind a larger update of this session left for the background drain' };

/**
 * Write-ahead copy of a session PATCH, taken BEFORE work that might kill this
 * process (a slow `captureGitState`, a shadow commit waiting on index.lock).
 * `durableUpdateSession` only enqueues after a failed fetch; a SIGKILL during
 * git never reaches that catch, so the payload is gone.
 *
 * Cursor session e24477e2: Stop built 4–5 prompt mappings then died inside
 * `captureGitState({ fullContext: true })`; the overlapping next prompt's
 * submit matched the session and died the same way. Neither reached
 * `api.updateSession`.
 *
 * Returns the entry's name. The caller hands it to `durableUpdateSession` as
 * `supersedes` when it sends the real payload: the entry is removed before
 * the send, so a hook that finishes normally never replays a stale copy of
 * itself (a replayed prompt list overwrites the server's — last write wins —
 * and post-commit's copy carried a gitCapture). Only a hook that dies leaves
 * the entry for the next drain. `status` is stripped: a late replay of
 * `RUNNING` would reopen a session that has since ended.
 */
export function persistUpdateBeforeWork(
  sessionId: string,
  data: any,
  log: Log = noop,
): string | null {
  const payload = data && typeof data === 'object' ? { ...data } : data;
  if (payload && typeof payload === 'object') delete payload.status;
  return writeQueueEntry(
    'updateSession',
    sessionId,
    payload,
    { message: 'pre-persisted before work that may not finish' },
    log,
  );
}

/**
 * Durable updateSession: drains this session's queued
 * backlog first (ordering), then sends. Connection failures get one immediate
 * retry with the same payload and capture IDs. On retriable failure the payload is
 * queued and null is returned — callers treat null as "accepted for later".
 * Non-retriable errors and failed queue writes still throw.
 */
export async function durableUpdateSession(
  sessionId: string,
  data: any,
  log: Log = noop,
  opts: { supersedes?: string | null; logEvent?: string; snapshot?: boolean } = {},
): Promise<any | null> {
  // The write-ahead copy this payload replaces (persistUpdateBeforeWork).
  // Removed BEFORE the drain so it is neither replayed ahead of this send
  // nor left behind for a later one; a retriable failure below re-enqueues
  // the full payload, so nothing is lost in between.
  removeQueuedUpdate(opts.supersedes);
  const sentAt = Date.now();
  let deferred = 0;
  try {
    deferred = (await drainUpdateQueue(log, { forSessionId: sessionId, skipSnapshots: opts.snapshot === true })).deferred;
  } catch { /* drain is best-effort */ }
  if (deferred > 0) {
    // An older update of this session is still queued (too large for a hook).
    // Sent now, this one lands first and the older one then lands on top of it
    // — a session-to-date snapshot replaces the stored session diff. Queue
    // behind it; the background drain replays both in order.
    const queued = writeQueueEntry('updateSession', sessionId, data, BEHIND_DEFERRED, log, { snapshot: opts.snapshot });
    if (queued) {
      if (opts.snapshot) dropSupersededSnapshots(sessionId, queued, sentAt, log);
      spawnBackgroundDrain(deferred, log);
      return null;
    }
  }
  for (let attempt = 0; ; attempt++) {
    try {
      const res = await api.updateSession(sessionId, data);
      if (opts.snapshot) dropSupersededSnapshots(sessionId, null, sentAt, log);
      return res;
    } catch (err: any) {
      // A pooled socket may close just as fetch reuses it. Retry that transport
      // failure once, without reminting capture IDs. HTTP errors and timeouts
      // go straight to the existing queue policy; another timeout could exceed
      // the hook's wall-clock budget before it persists the capture.
      const code = err?.cause?.code ?? err?.code;
      const connectionFailure = typeof err?.status !== 'number'
        && err?.name !== 'AbortError' && err?.name !== 'TimeoutError'
        && (err?.message === 'fetch failed'
          || ['ECONNRESET', 'ECONNREFUSED', 'EPIPE', 'ENOTFOUND', 'EAI_AGAIN', 'UND_ERR_SOCKET'].includes(code))
        && !['ETIMEDOUT', 'UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_HEADERS_TIMEOUT', 'UND_ERR_BODY_TIMEOUT'].includes(code);
      log(opts.logEvent || 'queue', 'session update send failed', {
        sessionId, attempt: attempt + 1, error: err?.message, status: err?.status,
      });
      if (attempt === 0 && connectionFailure) {
        log(opts.logEvent || 'queue', 'retrying session update after connection failure', { sessionId });
        continue;
      }
      if (isRetriableApiError(err)) {
        const queued = writeQueueEntry('updateSession', sessionId, data, err, log, { snapshot: opts.snapshot });
        if (queued) {
          if (opts.snapshot) dropSupersededSnapshots(sessionId, queued, sentAt, log);
          return null;
        }
      }
      throw err;
    }
  }
}

/** endSession with the same durability contract as durableUpdateSession. */
export async function durableEndSession(
  sessionId: string,
  data: any,
  log: Log = noop,
): Promise<any | null> {
  let deferred = 0;
  try {
    deferred = (await drainUpdateQueue(log, { forSessionId: sessionId })).deferred;
  } catch { /* best-effort */ }
  if (deferred > 0 && enqueueFailedUpdate('endSession', sessionId, data, BEHIND_DEFERRED, log)) {
    spawnBackgroundDrain(deferred, log);
    return null;
  }
  try {
    return await api.endSession(data);
  } catch (err: any) {
    if (isRetriableApiError(err)) {
      enqueueFailedUpdate('endSession', sessionId, data, err, log);
      return null;
    }
    throw err;
  }
}
