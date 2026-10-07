/**
 * Sealed prompts in git notes (opt-in, per repo).
 *
 * Git notes are read by anyone with the repository, so prompt text stays out
 * of them by default (prompt-privacy.ts). A repo can set
 * `"notesEncryptPrompts": true` in .origin.json instead: the prompt text a
 * note would carry is encrypted (AES-256-GCM) with the repo's data key for the
 * month, fetched from Origin, and only ciphertext reaches git. A reader asks
 * Origin to hand the key back, Origin checks repo access first, and a person
 * who loses access stops getting keys.
 *
 * Fail-closed everywhere: no key (offline, no access, server without the
 * feature) → the note is written metadata-only, never with clear text; a key
 * refused or a blob that does not open → the reader shows "not stored".
 *
 * The blob is bound (as GCM associated data) to its key id — repo + month —
 * not to the commit sha: rewrites (rebase, amend) carry notes onto new shas,
 * and a sha-bound blob would stop opening after every rebase.
 *
 * Keys are cached in ~/.origin/note-keys.json (owner-only), at most
 * KEY_TTL_MS: the bound on how long a revoked reader keeps reading.
 */
import crypto from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { writeSecret } from './config.js';
import { gitOrNull } from './utils/exec.js';

export const KEY_TTL_MS = 4 * 60 * 60 * 1000;
const CACHE_PATH = path.join(os.homedir(), '.origin', 'note-keys.json');
const ALG = 'A256GCM';

export interface SealedBlob { alg: typeof ALG; kid: string; nonce: string; ct: string }

/** The prompt-bearing fields a sealed note carries. */
export interface SealedPromptFields {
  promptSummary?: string;
  fullPrompt?: string;
  markers?: unknown;
  prompts?: Array<{ index: number; text?: string }>;
}

interface CachedKey { key: string; fetchedAt: number; validUntil?: number }
interface KeyCache { write: Record<string, CachedKey & { kid: string }>; read: Record<string, CachedKey> }

/**
 * The repo's own say, read directly: `notesEncryptPrompts` must be literally
 * true in a valid .origin.json. A team decides this for the repo; there is no
 * machine-wide switch.
 */
export function sealingRequested(repoPath: string): boolean {
  try {
    const cfg = JSON.parse(fs.readFileSync(path.join(repoPath, '.origin.json'), 'utf-8'));
    return !!cfg && typeof cfg === 'object' && !Array.isArray(cfg) && cfg.notesEncryptPrompts === true;
  } catch {
    return false;
  }
}

function readCache(): KeyCache {
  try {
    const c = JSON.parse(fs.readFileSync(CACHE_PATH, 'utf-8'));
    return { write: c?.write && typeof c.write === 'object' ? c.write : {}, read: c?.read && typeof c.read === 'object' ? c.read : {} };
  } catch {
    return { write: {}, read: {} };
  }
}

function writeCache(c: KeyCache, now: number): void {
  // Drop what has expired so the file never accumulates old keys.
  for (const [k, v] of Object.entries(c.write)) if (!fresh(v, now)) delete c.write[k];
  for (const [k, v] of Object.entries(c.read)) if (!fresh(v, now)) delete c.read[k];
  try {
    fs.mkdirSync(path.dirname(CACHE_PATH), { recursive: true, mode: 0o700 });
    writeSecret(CACHE_PATH, JSON.stringify(c));
  } catch { /* a cache that can't be written only costs a refetch */ }
}

function fresh(v: CachedKey | undefined, now: number): v is CachedKey {
  return !!v && typeof v.key === 'string' && now - v.fetchedAt < KEY_TTL_MS && (v.validUntil === undefined || now < v.validUntil);
}

function repoIdentity(repoPath: string): { remote: string; path: string; cacheKey: string } {
  const remote = gitOrNull(['remote', 'get-url', 'origin'], { cwd: repoPath }) || '';
  const root = gitOrNull(['rev-parse', '--show-toplevel'], { cwd: repoPath }) || repoPath;
  return { remote, path: root, cacheKey: crypto.createHash('sha256').update(remote || root).digest('hex').slice(0, 32) };
}

/**
 * Fetch this month's write key ahead of a note write (the note writer is
 * synchronous). Best-effort and silent: a failure leaves the cache as it was,
 * and the write then falls back to a metadata-only note.
 */
export async function ensureWriteKey(repoPath: string, fetchKey?: (q: { remote?: string; path?: string }) => Promise<{ kid: string; key: string; validUntil: string }>): Promise<void> {
  if (!sealingRequested(repoPath)) return;
  const now = Date.now();
  const id = repoIdentity(repoPath);
  const cache = readCache();
  if (fresh(cache.write[id.cacheKey], now)) return;
  try {
    const get = fetchKey ?? (async (q) => (await import('./api.js')).api.noteKeyCurrent(q));
    const r = await get({ remote: id.remote || undefined, path: id.path });
    if (!r?.kid || !r?.key) return;
    cache.write[id.cacheKey] = { kid: r.kid, key: r.key, fetchedAt: now, validUntil: Date.parse(r.validUntil) || undefined };
    writeCache(cache, now);
  } catch { /* offline, no access, server without the feature → metadata-only notes */ }
}

/** The cached write key for the repo, or null — never fetches. */
export function cachedWriteKey(repoPath: string): { kid: string; key: Buffer } | null {
  if (!sealingRequested(repoPath)) return null;
  const v = readCache().write[repoIdentity(repoPath).cacheKey];
  if (!fresh(v, Date.now()) || !(v as any).kid) return null;
  const key = Buffer.from(v.key, 'base64');
  return key.length === 32 ? { kid: (v as any).kid, key } : null;
}

export function seal(fields: SealedPromptFields, key: { kid: string; key: Buffer }): SealedBlob {
  const nonce = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', key.key, nonce);
  c.setAAD(Buffer.from(key.kid));
  const ct = Buffer.concat([c.update(Buffer.from(JSON.stringify(fields), 'utf-8')), c.final(), c.getAuthTag()]);
  return { alg: ALG, kid: key.kid, nonce: nonce.toString('base64'), ct: ct.toString('base64') };
}

/** Decrypt with a known key; null when it doesn't open (wrong key, tampered). */
export function openWithKey(blob: SealedBlob, key: Buffer): SealedPromptFields | null {
  try {
    if (blob?.alg !== ALG || typeof blob.ct !== 'string' || typeof blob.nonce !== 'string') return null;
    const raw = Buffer.from(blob.ct, 'base64');
    if (raw.length < 16) return null;
    const d = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(blob.nonce, 'base64'));
    d.setAAD(Buffer.from(blob.kid));
    d.setAuthTag(raw.subarray(raw.length - 16));
    const pt = Buffer.concat([d.update(raw.subarray(0, raw.length - 16)), d.final()]);
    const v = JSON.parse(pt.toString('utf-8'));
    return v && typeof v === 'object' ? v : null;
  } catch {
    return null;
  }
}

export function isSealedBlob(v: unknown): v is SealedBlob {
  return !!v && typeof v === 'object' && (v as any).alg === ALG && typeof (v as any).kid === 'string';
}

/**
 * Open the sealed blobs of many notes with ONE unwrap call for the keys not
 * cached: one call per month of history, not per commit. Missing / refused /
 * unopenable → that entry is null.
 */
export async function openSealedMany(
  blobs: SealedBlob[],
  unwrap?: (kids: string[]) => Promise<{ keys: Record<string, string> }>,
): Promise<Array<SealedPromptFields | null>> {
  const now = Date.now();
  const cache = readCache();
  const need = [...new Set(blobs.map((b) => b.kid))].filter((kid) => !fresh(cache.read[kid], now));
  if (need.length > 0) {
    try {
      const call = unwrap ?? (async (kids) => (await import('./api.js')).api.noteKeyUnwrap(kids));
      for (let i = 0; i < need.length; i += 64) {
        const r = await call(need.slice(i, i + 64));
        for (const [kid, key] of Object.entries(r?.keys ?? {})) cache.read[kid] = { key, fetchedAt: now };
      }
      writeCache(cache, now);
    } catch { /* offline or refused: what was cached still opens */ }
  }
  return blobs.map((b) => {
    const v = cache.read[b.kid];
    return fresh(v, now) ? openWithKey(b, Buffer.from(v.key, 'base64')) : null;
  });
}

/** For tests: where the cache lives. */
export const NOTE_KEY_CACHE_PATH = CACHE_PATH;

/**
 * A parsed note's `origin` object with its sealed prompt fields opened, when
 * this reader can get the key. Unchanged when there is nothing sealed, or no
 * key: it then reads exactly like a metadata-only note.
 */
export async function withOpenedPrompts<T extends Record<string, any>>(origin: T): Promise<T & { promptsUnsealed?: boolean }> {
  if (!origin || !isSealedBlob(origin.sealed) || origin.promptSummary) return origin;
  const [fields] = await openSealedMany([origin.sealed]);
  if (!fields) return origin;
  return {
    ...origin,
    promptSummary: fields.promptSummary ?? origin.promptSummary,
    fullPrompt: fields.fullPrompt ?? origin.fullPrompt,
    markers: fields.markers ?? origin.markers,
    prompts: Array.isArray(origin.prompts) && Array.isArray(fields.prompts)
      ? origin.prompts.map((p: any) => {
          const t = fields.prompts!.find((f) => f.index === p?.index)?.text;
          return t ? { ...p, text: t } : p;
        })
      : origin.prompts,
    promptsUnsealed: true,
  };
}
