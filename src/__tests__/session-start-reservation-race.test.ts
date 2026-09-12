/**
 * session-start and user-prompt-submit must not both mint a session.
 *
 * `api.startSession` decides `sessionId`, and nothing reached disk until it
 * returned. On a slow or failing API that is a multi-second hole in which the
 * session does not exist as far as any other hook can tell. Cursor fires both
 * hooks within 5ms of each other, so the prompt hook lands in that hole, finds
 * nothing, and auto-creates a SECOND session for the same chat.
 *
 * Prod, Cursor on `baton`, 2026-08-30 — the two hooks started 5ms apart:
 *
 *   13:43:33.017  [session-start]       HOOK INVOKED
 *   13:43:33.022  [user-prompt-submit]  HOOK INVOKED
 *   13:43:33.097  [user-prompt-submit]  no state found
 *   13:43:36.680  [session-start]       pricing fetch failed (aborted)   ← 3.6s
 *   13:43:41.048  [session-start]       pricing fetch failed (aborted)   ← 4.4s
 *   13:43:41.366  [session-start]       calling api.startSession
 *   13:43:42.031  [user-prompt-submit]  auto-created session local-6e7a8d14…
 *   13:43:49.368  [session-start]       API failed, falling back to local
 *   13:43:49.609  [session-start]       state saved  local-9adc70bd…     ← 8.2s
 *   13:43:49.897  [user-prompt-submit]  updateSession: "Session not found"
 *
 * Two state files, two local sessions, one conversation. Three things had to
 * change: the pricing fetch stops blocking the hook, session-start publishes a
 * provisional row BEFORE the network call, and the prompt hook looks again
 * right before minting.
 */
import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { hooksSource } from './helpers/hooks-source.js';
import {
  preferRegisteredSessionId,
  isProvisionalSessionId,
  isPendingReservation,
  RESERVATION_PENDING_MS,
} from '../session-state.js';

describe('isProvisionalSessionId', () => {
  it('recognises the placeholder ids the CLI mints offline', () => {
    expect(isProvisionalSessionId('local-9adc70bd-a384-48ce')).toBe(true);
    expect(isProvisionalSessionId('02bfcbf3-4699-4f11-a258-8905b45aa6b8')).toBe(false);
    expect(isProvisionalSessionId(undefined)).toBe(false);
    expect(isProvisionalSessionId(null)).toBe(false);
  });
});

describe('preferRegisteredSessionId', () => {
  it('keeps the registered id when our own start failed', () => {
    // The whole point: session-start reserved `local-A`, a prompt hook adopted
    // it and registered it as `server-1`, then session-start's own call timed
    // out. Saving `local-A` would demote a live session back to local and
    // strand the prompt already filed against `server-1`.
    expect(preferRegisteredSessionId('local-A', 'server-1')).toBe('server-1');
  });

  it('keeps ours when we are the registered one', () => {
    // Our call succeeded; the file still holds the placeholder. Ours wins.
    expect(preferRegisteredSessionId('server-1', 'local-A')).toBe('server-1');
  });

  it('never swaps one registered id for another', () => {
    // Two real ids means something upstream is wrong; silently adopting the
    // file's would move the session mid-flight. Leave it alone.
    expect(preferRegisteredSessionId('server-1', 'server-2')).toBe('server-1');
  });

  it('keeps ours between two placeholders', () => {
    // Renumbering a local session a hook is already writing to helps nobody.
    expect(preferRegisteredSessionId('local-A', 'local-B')).toBe('local-A');
  });

  it('is a no-op when there is nothing on disk', () => {
    expect(preferRegisteredSessionId('local-A', undefined)).toBe('local-A');
    expect(preferRegisteredSessionId('local-A', null)).toBe('local-A');
    expect(preferRegisteredSessionId('local-A', 'local-A')).toBe('local-A');
  });
});

describe('isPendingReservation', () => {
  const at = (ms: number) => new Date(ms).toISOString();

  it('is true while session-start is still registering', () => {
    // An adopting hook must not register it too — that is the second row.
    expect(isPendingReservation(
      { pendingRegistration: true, startedAt: at(1_000) }, 1_000 + 5_000,
    )).toBe(true);
  });

  it('goes false once the reservation is stale', () => {
    // The start hook died mid-call. Past the bound, every prompt is a retry
    // point again — otherwise one crashed hook suppresses registration for the
    // whole conversation.
    expect(isPendingReservation(
      { pendingRegistration: true, startedAt: at(1_000) },
      1_000 + RESERVATION_PENDING_MS + 1,
    )).toBe(false);
  });

  it('covers the 16s the prod trace actually took', () => {
    // pricing (3.6s + 4.4s) + startSession (8.2s). A bound under this would
    // have let the prompt hook register alongside a live start.
    expect(isPendingReservation(
      { pendingRegistration: true, startedAt: at(0) }, 16_600,
    )).toBe(true);
  });

  it('is false for an ordinary session', () => {
    expect(isPendingReservation({ startedAt: at(0) }, 1)).toBe(false);
    expect(isPendingReservation(null)).toBe(false);
  });

  it('treats an unusable timestamp as pending rather than racing a live start', () => {
    expect(isPendingReservation({ pendingRegistration: true })).toBe(true);
    expect(isPendingReservation({ pendingRegistration: true, startedAt: 'nonsense' })).toBe(true);
  });
});

// The three changes are load-bearing together and each is invisible on its own:
// without the non-blocking pricing fetch the reservation still lands seconds
// late, without the reservation there is nothing to adopt, and without the
// re-check the prompt hook mints anyway. #1346 shipped a fix wired into one
// path while the bug was on another, so the wiring gets a guard.
describe('the three halves are wired', () => {
  const src = hooksSource();

  it('session-start reserves BEFORE it calls the API', () => {
    const reserve = src.indexOf("'reserved state before registering'");
    const call = src.indexOf("'calling api.startSession'");
    expect(reserve).toBeGreaterThan(-1);
    expect(call).toBeGreaterThan(-1);
    expect(reserve).toBeLessThan(call);
  });

  it('the reservation refuses to overwrite existing state at the same tag', () => {
    // A re-fired start (resume/compact) carries the SAME tag over a file
    // holding the conversation's prompts. Writing a bare row over it would
    // destroy them, and the carry-forward at the end reads that same file.
    expect(src).toContain("'not reserving — state already exists at this tag'");
  });

  it('a failed start reuses the reserved id instead of minting another', () => {
    const reserve = src.indexOf('let reservedSessionId');
    const fallback = src.indexOf('sessionId = reservedSessionId;', reserve);
    expect(reserve).toBeGreaterThan(-1);
    expect(fallback).toBeGreaterThan(reserve);
  });

  it('the pricing fetch no longer blocks the hook', () => {
    const idx = src.indexOf('api.getPricing()');
    expect(idx).toBeGreaterThan(-1);
    // `void … .then()`, not `await` — an awaited call is what put 8s in front
    // of the reservation.
    expect(src.slice(idx - 60, idx)).not.toContain('await');
    expect(src.slice(idx - 60, idx)).toContain('void');
  });

  it('user-prompt-submit looks again before auto-creating', () => {
    const recheck = src.indexOf("'session-start won the race — adopting its session instead of auto-creating'");
    const mint = src.indexOf("'auto-created session'");
    expect(recheck).toBeGreaterThan(-1);
    expect(mint).toBeGreaterThan(recheck);
  });

  it('session-start defers to an id a concurrent hook registered', () => {
    const save = src.indexOf('saveSessionState(state, saveCwd, sessionTag);');
    const prefer = src.lastIndexOf('preferRegisteredSessionId', save);
    expect(prefer).toBeGreaterThan(-1);
    expect(prefer).toBeLessThan(save);
  });
});

// The reservation was adoptable and then registered TWICE — once by
// session-start and once by the prompt hook that had adopted it (prod
// 2026-09-09, one Cursor chat: 5431ff0f on main and e24477e2 on the worktree).
// The pre-mint re-check above only covers the auto-create branch; the adopter
// that found the reservation on its first lookup went straight to
// ensureServerSession. And session-start's own save wrote its bare row over
// the adopter's prompt and worktree identity. Both halves get a guard.
describe('an adopted reservation is registered exactly once', () => {
  const src = hooksSource();

  it('ensureServerSession refuses a pending reservation', () => {
    const fn = src.indexOf('export async function ensureServerSession');
    const refuse = src.indexOf("'reservation still registering — leaving session/start to session-start'", fn);
    const mint = src.indexOf("'migrating local session to server'", fn);
    expect(fn).toBeGreaterThan(-1);
    expect(refuse).toBeGreaterThan(fn);
    expect(refuse).toBeLessThan(mint);
  });

  it('session-start folds an adopted reservation into its row before saving', () => {
    const call = src.indexOf("'calling api.startSession'");
    const merge = src.indexOf("'a concurrent hook adopted the reservation while session/start was in flight — keeping its turn and identity'");
    const save = src.indexOf('saveSessionState(state, saveCwd, sessionTag);');
    expect(merge).toBeGreaterThan(call);
    expect(merge).toBeLessThan(save);
    // Only a row THIS hook reserved — a re-fired start keeps its carry-forward.
    expect(src.slice(merge - 1500, merge)).toContain('reservedHere && onDisk && reservationAdoptedMeanwhile');
  });

  it('the reservation checks can see a Cursor row (empty claudeSessionId)', () => {
    // loadSessionState rejects a row with no claudeSessionId — every Cursor row.
    expect(src).not.toContain('loadSessionState(reservationCwd, sessionTag)');
    expect(src).toContain('readStateAtTag(reservationCwd, sessionTag)');
    expect(src).not.toContain('loadSessionState(saveCwd, sessionTag)');
    expect(src).toContain('readStateAtTag(saveCwd, sessionTag)');
  });

  it('the heartbeat starts on the id the file settled on, not the local variable', () => {
    const merge = src.indexOf("'a concurrent hook adopted the reservation");
    const hb = src.indexOf('startHeartbeat(state.sessionId, hbApiUrl, hbApiKey, stateFile, finalAgentSlug)', merge);
    expect(hb).toBeGreaterThan(merge);
  });

  it('the prompt hook pushes the identity it restamped once the id is registered', () => {
    const idx = src.indexOf("'session-start registered the reservation meanwhile — continuing on its id'");
    const ensure = src.indexOf("ensureServerSession(state, found!.saveCwd, agentSlug, 'user-prompt-submit')", idx);
    expect(idx).toBeGreaterThan(-1);
    expect(ensure).toBeGreaterThan(idx);
    expect(src.slice(idx, ensure)).toContain('durableUpdate(state.sessionId');
  });
});

describe('a pending reservation gets no server traffic on its placeholder id', () => {
  const src = hooksSource();

  it('user-prompt-submit skips the per-prompt update and the daemon while registration is in flight', () => {
    const guard = src.indexOf("'reservation still registering — no server update or daemon on the placeholder id'");
    const block = src.indexOf('if (config && isConnectedMode() && !registrationInFlight)', guard);
    const dispatch = src.indexOf("'heartbeat dispatched (fire-and-forget)'", block);
    expect(guard).toBeGreaterThan(-1);
    expect(block).toBeGreaterThan(guard);
    expect(dispatch).toBeGreaterThan(block);
  });
});
