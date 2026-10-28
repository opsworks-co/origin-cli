// ---------------------------------------------------------------------------
// Origin CLI — canonical fingerprint of one attribution record (OR-21 / M1)
// ---------------------------------------------------------------------------
// A re-anchored line claim is proven on one note snapshot. A reader that keeps
// the claim (the RhodeCode store) must later tell whether the record it holds
// for the source revision is still exactly that record — `recorded_at` cannot,
// a note may be rewritten with the same timestamp. This module gives every
// validated record one self-describing token:
//
//   origin-record-fingerprint/1:sha256:<64 lowercase hex>      (99 characters)
//
// `/1` names the canonical byte form below, `sha256` the hash. A token of any
// other version or algorithm is never comparable to a `/1` token, even when the
// digest is the same.
//
// Canonical form `/1` (UTF-8, no whitespace) — identical in the Python reader
// of integrations/rhodecode, pinned by __tests__/fixtures/record-fingerprint-v1.json:
//
//   object   {"key":value,...}, keys ordered by Unicode code point
//   array    [value,...] in order
//   string   "..." escaping only `"`, `\` and U+0000..U+001F (as \u00xx, lowercase)
//   number   a safe integer in decimal; -0 is 0
//   literal  true, false, null
//
// Anything else — a non-integer or unsafe number, a string with an unpaired
// surrogate, a non-JSON value — has no fingerprint (null): callers fail closed.
// ---------------------------------------------------------------------------

import { createHash } from 'crypto';

export const RECORD_FINGERPRINT_PREFIX = 'origin-record-fingerprint/1:sha256:';
export const RECORD_FINGERPRINT_LENGTH = RECORD_FINGERPRINT_PREFIX.length + 64;

const TOKEN_SHAPE = /^origin-record-fingerprint\/([1-9][0-9]{0,3}):([a-z0-9-]{1,32}):([\s\S]*)$/;
const TOKEN_V1 = /^origin-record-fingerprint\/1:sha256:[0-9a-f]{64}$/;

class NotCanonical extends Error {}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) return false;
  const proto = Object.getPrototypeOf(v);
  return proto === Object.prototype || proto === null;
}

// UTF-8 byte order is Unicode code point order, so comparing the encoded keys
// orders astral-plane keys correctly where UTF-16 code units would not.
// A key with an unpaired surrogate only sorts somewhere here; canonicalString
// rejects it right after, so the record still has no fingerprint.
function byCodePoint(a: string, b: string): number {
  return Buffer.compare(Buffer.from(a, 'utf-8'), Buffer.from(b, 'utf-8'));
}

function canonicalString(s: string): string {
  let out = '"';
  // `for...of` walks code points: a paired surrogate arrives as one astral
  // character, an unpaired one alone — which has no UTF-8 form.
  for (const ch of s) {
    const cp = ch.codePointAt(0)!;
    if (cp >= 0xd800 && cp <= 0xdfff) throw new NotCanonical();
    if (ch === '"') out += '\\"';
    else if (ch === '\\') out += '\\\\';
    else if (cp < 0x20) out += '\\u' + cp.toString(16).padStart(4, '0');
    else out += ch;
  }
  return out + '"';
}

function canonical(value: unknown): string {
  if (value === null) return 'null';
  if (value === true) return 'true';
  if (value === false) return 'false';
  if (typeof value === 'number') {
    if (!Number.isSafeInteger(value)) throw new NotCanonical();
    return Object.is(value, -0) ? '0' : String(value);
  }
  if (typeof value === 'string') return canonicalString(value);
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  if (isPlainObject(value)) {
    const keys = Object.keys(value).sort(byCodePoint);
    return '{' + keys.map((k) => canonicalString(k) + ':' + canonical(value[k])).join(',') + '}';
  }
  throw new NotCanonical();
}

/** The canonical `/1` bytes of a JSON value, or null when it has none. */
export function canonicalRecordBytes(value: unknown): Buffer | null {
  try {
    return Buffer.from(canonical(value), 'utf-8');
  } catch (err) {
    if (err instanceof NotCanonical) return null;
    throw err;
  }
}

/**
 * The `/1` token of a validated record (an exact 1.0 record or the 1.0
 * projection `readRecord` returns), or null when the record has no canonical
 * form. Never throws on a JSON value.
 */
export function recordFingerprint(record: unknown): string | null {
  const bytes = canonicalRecordBytes(record);
  if (bytes === null) return null;
  return RECORD_FINGERPRINT_PREFIX + createHash('sha256').update(bytes).digest('hex');
}

export type RecordFingerprintParse =
  | { kind: 'ok'; token: string }
  | { kind: 'protocol_error' }
  | { kind: 'unsupported_fingerprint_protocol' };

/**
 * Strict reading of a token, in order: not of the general
 * `origin-record-fingerprint/<n>:<alg>:<digest>` shape → protocol_error; a
 * version other than 1 or an algorithm other than sha256 →
 * unsupported_fingerprint_protocol; anything but exactly 64 lowercase hex
 * after `/1:sha256:` → protocol_error.
 */
export function parseRecordFingerprint(token: unknown): RecordFingerprintParse {
  if (typeof token !== 'string') return { kind: 'protocol_error' };
  const m = TOKEN_SHAPE.exec(token);
  if (!m) return { kind: 'protocol_error' };
  if (m[1] !== '1' || m[2] !== 'sha256') return { kind: 'unsupported_fingerprint_protocol' };
  return TOKEN_V1.test(token) ? { kind: 'ok', token } : { kind: 'protocol_error' };
}

/** Two tokens name the same record: both parse as `/1` and are equal byte for byte. */
export function sameRecordFingerprint(a: unknown, b: unknown): boolean {
  return parseRecordFingerprint(a).kind === 'ok' && parseRecordFingerprint(b).kind === 'ok' && a === b;
}
