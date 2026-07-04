// Session → account ownership.
//
// Locally-captured sessions used to carry NO record of which Origin account
// created them. So after `origin login` into a different account, queued
// `local-*` sessions from the previous account got replayed by
// `origin sessions sync` and authenticated with the NEW key — silently
// re-homing the old account's work under the new one (the "sessions pulled
// into the new account" bug).
//
// Fix: stamp every session at capture time with the owning account
// (orgId + a fingerprint of the API key). The sync path then refuses to
// upload sessions that belong to a different account, `origin status` warns
// about them, and `origin sessions import` / `forget` let the user decide.

import crypto from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { loadConfig, type OriginConfig } from './config.js';
import { api } from './api.js';
import type { SessionState } from './session-state.js';

export interface SessionOwner {
  ownerOrgId: string;
  ownerKeyHash: string;
}

const SESSIONS_DIR = path.join(os.homedir(), '.origin', 'sessions');

/** Fingerprint an API key — sha256, first 16 hex chars. Never store the raw key. */
export function keyFingerprint(apiKey: string): string {
  return crypto.createHash('sha256').update(apiKey).digest('hex').slice(0, 16);
}

/** Owner identity derived from a config, or null when it can't authenticate
 *  anything (standalone / not logged in). */
export function ownerFromConfig(config: OriginConfig | null): SessionOwner | null {
  if (!config?.apiKey || !config?.orgId) return null;
  return { ownerOrgId: config.orgId, ownerKeyHash: keyFingerprint(config.apiKey) };
}

/** Owner identity of the currently-active account. */
export function currentOwner(): SessionOwner | null {
  return ownerFromConfig(loadConfig());
}

/** Stamp ownership the first time a session is written. First-write-wins:
 *  once stamped the owner is immutable, so a later account switch can never
 *  relabel a previous account's session as its own. No-op in standalone
 *  (no owner to attribute it to). */
export function ensureOwnerStamp(state: SessionState): void {
  if (state.ownerOrgId || state.ownerKeyHash) return; // already stamped
  const owner = currentOwner();
  if (!owner) return; // standalone / not logged in — leave unstamped
  state.ownerOrgId = owner.ownerOrgId;
  state.ownerKeyHash = owner.ownerKeyHash;
}

/** A session is "foreign" when it carries an owner stamp that differs from the
 *  account asking about it. Unstamped sessions (legacy, or captured in
 *  standalone before any login) are treated as belonging to the current
 *  account — we have no evidence otherwise. */
export function isForeignSession(
  state: { ownerOrgId?: string; ownerKeyHash?: string },
  owner: SessionOwner | null,
): boolean {
  if (!state.ownerOrgId && !state.ownerKeyHash) return false;
  if (!owner) return false;
  return state.ownerOrgId !== owner.ownerOrgId || state.ownerKeyHash !== owner.ownerKeyHash;
}

/** Backfill: stamp any UNSTAMPED queued session files with the given owner.
 *  Called at login when switching accounts so legacy sessions captured before
 *  this feature are attributed to the account that actually made them (the
 *  outgoing one) instead of leaking into the incoming account. Returns the
 *  number of files newly stamped. */
export function stampUnstampedQueuedSessions(owner: SessionOwner | null): number {
  if (!owner) return 0;
  let files: string[];
  try {
    files = fs.readdirSync(SESSIONS_DIR).filter((f) => f.endsWith('.json'));
  } catch {
    return 0;
  }
  let stamped = 0;
  for (const file of files) {
    const p = path.join(SESSIONS_DIR, file);
    try {
      const state = JSON.parse(fs.readFileSync(p, 'utf-8'));
      if (state.ownerOrgId || state.ownerKeyHash) continue; // already owned
      state.ownerOrgId = owner.ownerOrgId;
      state.ownerKeyHash = owner.ownerKeyHash;
      const tmp = `${p}.tmp.${process.pid}`;
      fs.writeFileSync(tmp, JSON.stringify(state, null, 2), { mode: 0o600 });
      fs.renameSync(tmp, p);
      stamped++;
    } catch { /* skip corrupt/unreadable */ }
  }
  return stamped;
}

/** Queued (never-uploaded) `local-*` sessions that belong to a DIFFERENT
 *  account than `owner`. These are exactly the ones at risk of leaking on
 *  resync — and the ones `origin sessions import`/`forget` act on. */
export function listForeignQueuedSessions(owner: SessionOwner | null): Array<{ file: string; state: any }> {
  const out: Array<{ file: string; state: any }> = [];
  let files: string[];
  try {
    files = fs.readdirSync(SESSIONS_DIR).filter((f) => f.endsWith('.json'));
  } catch {
    return out;
  }
  for (const file of files) {
    try {
      const state = JSON.parse(fs.readFileSync(path.join(SESSIONS_DIR, file), 'utf-8'));
      if (typeof state?.sessionId !== 'string' || !state.sessionId.startsWith('local-')) continue;
      if (isForeignSession(state, owner)) out.push({ file, state });
    } catch { /* skip */ }
  }
  return out;
}

/** Best-effort: tell the server how many foreign queued sessions remain so the
 *  dashboard can show (or clear) its import/forget banner. Returns the
 *  web-initiated `pendingAction` ('import' | 'forget' | null) the server is
 *  holding, so the caller can carry it out. Pass clearAction=true once it has
 *  been carried out. Never throws — this is a courtesy signal and must never
 *  block login/status/import/forget. */
export async function reportForeignSessionCount(clearAction = false): Promise<'import' | 'forget' | null> {
  try {
    const count = listForeignQueuedSessions(currentOwner()).length;
    const res = (await api.reportUnimportedSessions(count, clearAction)) as { pendingAction?: 'import' | 'forget' | null };
    return res?.pendingAction ?? null;
  } catch {
    return null; // offline / not authed — the banner just won't update this run
  }
}
