/**
 * Field-level encryption for sensitive session content (prompts, transcripts, diffs).
 *
 * Uses AES-256-GCM with a key from SESSION_ENCRYPTION_KEY env var (32-byte hex).
 *
 * Wire format:  enc:v1:<iv_hex>:<authTag_hex>:<ciphertext_hex>
 *
 * Backward compatible: rows written before encryption was enabled stay readable.
 * If SESSION_ENCRYPTION_KEY is unset, encrypt() is a pass-through and a warning
 * is logged once at boot.
 */

import crypto from 'crypto';

const PREFIX = 'enc:v1:';
const ALGO = 'aes-256-gcm';
const IV_LEN = 12;

let cachedKey: Buffer | null = null;
let warned = false;

function getKey(): Buffer | null {
  if (cachedKey) return cachedKey;
  const raw = process.env.SESSION_ENCRYPTION_KEY;
  if (!raw) {
    if (!warned) {
      console.warn(
        '[field-encryption] SESSION_ENCRYPTION_KEY not set — session prompts/transcripts/diffs will be stored in plaintext. ' +
          'Set a 32-byte hex key (openssl rand -hex 32) to enable encryption at rest.',
      );
      warned = true;
    }
    return null;
  }
  let buf: Buffer;
  try {
    buf = Buffer.from(raw, 'hex');
  } catch {
    throw new Error('[field-encryption] SESSION_ENCRYPTION_KEY must be hex-encoded');
  }
  if (buf.length !== 32) {
    throw new Error(
      `[field-encryption] SESSION_ENCRYPTION_KEY must decode to 32 bytes (got ${buf.length}). Generate with: openssl rand -hex 32`,
    );
  }
  cachedKey = buf;
  return buf;
}

export function isEncryptionEnabled(): boolean {
  return !!getKey();
}

export function isEncrypted(value: unknown): value is string {
  return typeof value === 'string' && value.startsWith(PREFIX);
}

/**
 * Encrypt a string. Returns the wire format. If no key is configured, returns
 * the input unchanged (so existing reads keep working).
 */
export function encryptField(plaintext: string | null | undefined): string | null | undefined {
  if (plaintext === null || plaintext === undefined) return plaintext;
  if (typeof plaintext !== 'string') return plaintext;
  if (plaintext === '') return plaintext;
  if (isEncrypted(plaintext)) return plaintext; // already encrypted
  const key = getKey();
  if (!key) return plaintext;

  const iv = crypto.randomBytes(IV_LEN);
  const cipher = crypto.createCipheriv(ALGO, key, iv);
  const ct = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${PREFIX}${iv.toString('hex')}:${tag.toString('hex')}:${ct.toString('hex')}`;
}

/**
 * Decrypt a string written with encryptField. If the value is not in our
 * envelope format, return it as-is (backward compat with plaintext rows).
 */
export function decryptField(value: string | null | undefined): string | null | undefined {
  if (value === null || value === undefined) return value;
  if (typeof value !== 'string') return value;
  if (!isEncrypted(value)) return value; // legacy plaintext
  const key = getKey();
  if (!key) {
    // Encryption was on when this row was written, but key is now missing.
    // Don't crash the read — return a marker so the caller can surface it.
    return '[encrypted: SESSION_ENCRYPTION_KEY missing]';
  }
  const parts = value.slice(PREFIX.length).split(':');
  if (parts.length !== 3) return value;
  try {
    const iv = Buffer.from(parts[0], 'hex');
    const tag = Buffer.from(parts[1], 'hex');
    const ct = Buffer.from(parts[2], 'hex');
    const decipher = crypto.createDecipheriv(ALGO, key, iv);
    decipher.setAuthTag(tag);
    const pt = Buffer.concat([decipher.update(ct), decipher.final()]);
    return pt.toString('utf8');
  } catch (err) {
    console.warn('[field-encryption] decrypt failed:', (err as Error).message);
    return '[encrypted: decrypt failed]';
  }
}

/**
 * Models + fields that get auto-encrypted on write and auto-decrypted on read.
 * Keep this list narrow — only fields that contain code, prompts, or diffs.
 */
export const ENCRYPTED_FIELDS: Record<string, string[]> = {
  CodingSession: ['prompt', 'transcript'],
  // editsJson is JSON-encoded PromptEdit[] carrying oldContent / newContent
  // snapshots of source files. It IS code, so it gets the same envelope
  // encryption as diff / promptText.
  PromptChange: ['promptText', 'diff', 'uncommittedDiff', 'editsJson'],
  SessionDiff: ['diff'],
  // Secrets used to verify inbound webhooks (HMAC key).
  Webhook: ['secret'],
  // OAuth access token / PAT / github_app installation token.
  IntegrationConfig: ['token'],
};

function transformRecord(model: string, record: any, fn: (s: string) => string | null | undefined): any {
  if (!record || typeof record !== 'object') return record;
  const fields = ENCRYPTED_FIELDS[model];
  if (!fields) return record;
  for (const field of fields) {
    if (field in record && typeof record[field] === 'string') {
      record[field] = fn(record[field]);
    }
  }
  return record;
}

export function encryptForWrite(model: string, data: any): any {
  return transformRecord(model, data, (s) => encryptField(s) as string);
}

export function decryptForRead(_model: string, data: any): any {
  decryptDeep(data);
  return data;
}

/**
 * Recursively walk a Prisma result and decrypt any string field that uses
 * our envelope format. This handles arbitrarily-nested includes without
 * needing to know which models the parent query was for.
 *
 * Cycles are not possible in Prisma JSON results, so a plain recursive
 * walk is safe. Depth is bounded for paranoia.
 */
function decryptDeep(node: any, depth = 0): void {
  if (depth > 12) return;
  if (node === null || node === undefined) return;
  if (Array.isArray(node)) {
    for (const item of node) decryptDeep(item, depth + 1);
    return;
  }
  if (typeof node !== 'object') return;
  for (const key of Object.keys(node)) {
    const v = node[key];
    if (typeof v === 'string') {
      if (isEncrypted(v)) node[key] = decryptField(v) as string;
    } else if (v && typeof v === 'object') {
      decryptDeep(v, depth + 1);
    }
  }
}
