// origin-record-fingerprint/1 (OR-21 / M1): the canonical byte form of a
// validated attribution record and its self-describing token. The golden
// vectors live in fixtures/record-fingerprint-v1.json, shared with the Python
// reader of integrations/rhodecode, and their expected digests were computed
// from the hand-written canonical text, not by this implementation.
import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import {
  RECORD_FINGERPRINT_LENGTH,
  RECORD_FINGERPRINT_PREFIX,
  canonicalRecordBytes,
  parseRecordFingerprint,
  recordFingerprint,
  sameRecordFingerprint,
} from '../attribution-record-fingerprint.js';
import { readRecord, validateFull } from '../attribution-record.js';
import { contributionIdentity } from '../attribution-line-reanchor.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const fixture = JSON.parse(fs.readFileSync(path.join(here, 'fixtures', 'record-fingerprint-v1.json'), 'utf-8'));

type Vector = { name: string; input: unknown; canonical?: string; fingerprint?: string; unavailable?: boolean; record?: boolean };
const vectors: Vector[] = fixture.vectors;
const byName = (name: string) => vectors.find((v) => v.name === name)!;

describe('golden vectors', () => {
  it('names the canonicalization it pins', () => {
    expect(fixture.canonicalization).toBe('origin-record-fingerprint/1');
    expect(vectors.length).toBeGreaterThan(10);
  });

  for (const v of vectors) {
    it(`${v.name}`, () => {
      if (v.unavailable) {
        expect(canonicalRecordBytes(v.input)).toBeNull();
        expect(recordFingerprint(v.input)).toBeNull();
        return;
      }
      expect(canonicalRecordBytes(v.input)!.toString('utf-8')).toBe(v.canonical);
      const token = recordFingerprint(v.input)!;
      expect(token).toBe(v.fingerprint);
      expect(token).toHaveLength(RECORD_FINGERPRINT_LENGTH);
      expect(token.startsWith(RECORD_FINGERPRINT_PREFIX)).toBe(true);
      expect(parseRecordFingerprint(token)).toEqual({ kind: 'ok', token });
    });
  }

  it('the record vectors are valid 1.0 records', () => {
    for (const v of vectors.filter((x) => x.record)) expect(validateFull(v.input).ok, v.name).toBe(true);
  });

  it('is 99 characters: a 35-character prefix and 64 lowercase hex', () => {
    expect(RECORD_FINGERPRINT_PREFIX).toBe('origin-record-fingerprint/1:sha256:');
    expect(RECORD_FINGERPRINT_PREFIX).toHaveLength(35);
    expect(RECORD_FINGERPRINT_LENGTH).toBe(99);
  });
});

describe('canonical form', () => {
  it('orders keys by code point, not by UTF-16 unit', () => {
    const astral = '\u{1F600}';
    const bmp = '｡';
    // A plain JS sort puts the astral key first; the canonical form does not.
    expect([astral, bmp].sort()).toEqual([astral, bmp]);
    expect(canonicalRecordBytes({ [astral]: 1, [bmp]: 2 })!.toString('utf-8')).toBe(`{"${bmp}":2,"${astral}":1}`);
  });

  it('object key order never matters, array order always does', () => {
    expect(recordFingerprint(byName('nested-key-reorder-a').input)).toBe(recordFingerprint(byName('nested-key-reorder-b').input));
    expect(recordFingerprint(byName('array-order-a').input)).not.toBe(recordFingerprint(byName('array-order-b').input));
  });

  it('is sensitive to a range, an agent, one character and one integer', () => {
    const tokens = ['record-base', 'record-range-changed', 'record-agent-changed', 'record-string-changed']
      .map((n) => recordFingerprint(byName(n).input));
    expect(new Set(tokens).size).toBe(4);
    const moved = { a: 1, b: 2 };
    const swapped = { a: 2, b: 1 };
    expect(recordFingerprint(moved)).not.toBe(recordFingerprint(swapped));
  });

  it('has no form for values JSON does not have', () => {
    for (const bad of [undefined, () => 1, 1n, new Date(0), new Map(), NaN, Infinity, [undefined], { a: undefined }]) {
      expect(recordFingerprint(bad as unknown)).toBeNull();
    }
  });

  it('never modifies its input', () => {
    const input = structuredClone(byName('record-base').input);
    const before = JSON.stringify(input);
    recordFingerprint(input);
    expect(JSON.stringify(input)).toBe(before);
  });
});

describe('parseRecordFingerprint', () => {
  for (const c of fixture.parse as Array<{ name: string; token: unknown; result: string }>) {
    it(`${c.name} → ${c.result}`, () => {
      expect(parseRecordFingerprint(c.token).kind).toBe(c.result);
    });
  }

  it('a /2 token with the same digest is never the same record as the /1 token', () => {
    const v1 = byName('record-base').fingerprint!;
    const v2 = v1.replace('/1:', '/2:');
    expect(v2.slice(-64)).toBe(v1.slice(-64));
    expect(parseRecordFingerprint(v2).kind).toBe('unsupported_fingerprint_protocol');
    expect(sameRecordFingerprint(v1, v2)).toBe(false);
    expect(sameRecordFingerprint(v1, v1.replace(':sha256:', ':sha512:'))).toBe(false);
    expect(sameRecordFingerprint(v1, v1)).toBe(true);
    expect(sameRecordFingerprint(v1.toUpperCase(), v1.toUpperCase())).toBe(false);
  });
});

// ─── The record a reader holds and the record a claim was proven on ─────────

const SHA = 'a'.repeat(40);
const base = () => structuredClone(byName('record-base').input) as any;
const envelope = (rec: unknown) => JSON.stringify({ origin: { sessionId: 'legacy', promptSummary: 'LEGACY PROMPT' }, attribution_record: rec });

describe('exact and projected records', () => {
  it('a newer 1.x record has the fingerprint of its 1.0 projection, which is the exact 1.0 record', () => {
    const exact = readRecord(base());
    const newer = { ...base(), schema_version: '1.4', future_top: { x: true } };
    newer.contributions[0].future_detail = 'dropped';
    const projected = readRecord(newer);
    expect(exact.status).toBe('exact');
    expect(projected.status).toBe('projected');
    expect(recordFingerprint((projected as any).record)).toBe(recordFingerprint((exact as any).record));
    expect(recordFingerprint((exact as any).record)).toBe(byName('record-base').fingerprint);
  });
});

describe('contributionIdentity carries the fingerprint of the same record', () => {
  it('adds recordFingerprint next to the identity it already returned', () => {
    expect(contributionIdentity(envelope(base()), SHA, 0)).toEqual({
      sessionId: 'session-agent',
      agentId: 'claude-code',
      modelId: 'claude-opus-4-6',
      recordFingerprint: byName('record-base').fingerprint,
    });
  });

  it('reads the projection of a newer 1.x note, never the envelope or the legacy payload', () => {
    const newer = { ...base(), schema_version: '1.2', extra: 1 };
    expect(contributionIdentity(envelope(newer), SHA, 0)?.recordFingerprint).toBe(byName('record-base').fingerprint);
  });

  it('a rewritten note with the same recorded_at gets another fingerprint', () => {
    const rewritten = base();
    rewritten.contributions[0].files[0].ranges[0].end_line = 6;
    expect(rewritten.recorded_at).toBe(base().recorded_at);
    expect(contributionIdentity(envelope(rewritten), SHA, 0)?.recordFingerprint).toBe(byName('record-range-changed').fingerprint);
  });

  it('proves nothing more than before: no identity, no fingerprint', () => {
    expect(contributionIdentity(null, SHA, 0)).toBeNull();
    expect(contributionIdentity('not json', SHA, 0)).toBeNull();
    expect(contributionIdentity(envelope(base()), 'b'.repeat(40), 0)).toBeNull();
    expect(contributionIdentity(envelope(base()), SHA, 1)).toBeNull();
    expect(contributionIdentity(envelope({ ...base(), schema_version: '2.0' }), SHA, 0)).toBeNull();
  });
});
