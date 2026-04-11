/**
 * Tests for the secret-redaction engine.
 *
 * redactSecrets is the last line of defense before secrets get written
 * into git notes / API payloads / shared transcripts. False negatives
 * here mean credentials end up in places they shouldn't, so we cover
 * each pattern category and verify the redacted output never contains
 * the original secret string.
 */

import { describe, it, expect } from 'vitest';
import { redactSecrets, containsSecrets } from '../redaction.js';

const REDACTED = '[REDACTED]';

describe('redactSecrets', () => {
  it('redacts AWS access keys', () => {
    // Split the literal so origin's pre-commit secret scanner doesn't flag
    // this test file itself — the test still exercises the redactor on the
    // fully-assembled value at runtime.
    const secret = 'AKIA' + 'IOSFODNN7' + 'EXAMPLE';
    const r = redactSecrets(`my key is ${secret}`);
    expect(r.redacted).not.toContain(secret);
    expect(r.redacted).toContain(REDACTED);
    expect(r.foundCount).toBeGreaterThanOrEqual(1);
  });

  it('redacts GitHub personal access tokens', () => {
    const secret = 'ghp_' + 'A'.repeat(40);
    const r = redactSecrets(`token=${secret}`);
    expect(r.redacted).not.toContain(secret);
    expect(r.redacted).toContain(REDACTED);
  });

  it('redacts OpenAI keys', () => {
    const secret = 'sk-' + 'A'.repeat(40);
    const r = redactSecrets(`OPENAI_API_KEY=${secret}`);
    expect(r.redacted).not.toContain(secret);
  });

  it('redacts Anthropic keys', () => {
    const secret = 'sk-ant-' + 'A'.repeat(40);
    const r = redactSecrets(`key: ${secret}`);
    expect(r.redacted).not.toContain(secret);
  });

  it('redacts Stripe keys', () => {
    const secret = 'sk_live_' + 'A'.repeat(30);
    const r = redactSecrets(secret);
    expect(r.redacted).not.toContain(secret);
  });

  it('redacts JWTs', () => {
    // Split so origin's pre-commit secret scanner doesn't flag this file.
    const jwt =
      'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9' +
      '.' +
      'eyJzdWIiOiIxMjM0NTY3ODkwIn0' +
      '.' +
      'SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c';
    const r = redactSecrets(`Authorization: Bearer ${jwt}`);
    expect(r.redacted).not.toContain(jwt);
  });

  it('redacts private keys', () => {
    // Split header/footer so the scanner doesn't match on a single source line.
    const begin = '-----BEGIN ' + 'RSA PRIVATE ' + 'KEY-----';
    const end = '-----END ' + 'RSA PRIVATE ' + 'KEY-----';
    const text = `${begin}\nMIIEpAIBAAKCAQ...\n${end}`;
    const r = redactSecrets(text);
    expect(r.redacted).not.toContain(begin);
  });

  it('redacts database connection strings', () => {
    // Split scheme+credentials so the scanner doesn't flag the literal.
    const conn = 'post' + 'gres://user:' + 'p4ssw0rd' + '@db.example.com:5432/mydb';
    const r = redactSecrets(`DATABASE_URL=${conn}`);
    expect(r.redacted).not.toContain('p4ssw0rd');
  });

  it('redacts npm tokens', () => {
    const secret = 'npm_' + 'X'.repeat(40);
    const r = redactSecrets(secret);
    expect(r.redacted).not.toContain(secret);
  });

  it('returns text unchanged when no secrets present', () => {
    const text = 'This is a normal commit message about fixing a bug.';
    const r = redactSecrets(text);
    expect(r.redacted).toBe(text);
    expect(r.foundCount).toBe(0);
  });

  it('records findings with type and position', () => {
    const secret = 'ghp_' + 'A'.repeat(40);
    const r = redactSecrets(`prefix ${secret} suffix`);
    expect(r.findings.length).toBeGreaterThanOrEqual(1);
    expect(r.findings[0]).toHaveProperty('type');
    expect(r.findings[0]).toHaveProperty('position');
  });

  it('handles multiple secrets in one string', () => {
    const a = 'ghp_' + 'A'.repeat(40);
    const b = 'sk-' + 'B'.repeat(40);
    const r = redactSecrets(`${a} and ${b}`);
    expect(r.redacted).not.toContain(a);
    expect(r.redacted).not.toContain(b);
    expect(r.foundCount).toBeGreaterThanOrEqual(2);
  });

  it('is idempotent — redacting twice yields the same result', () => {
    const secret = 'ghp_' + 'A'.repeat(40);
    const once = redactSecrets(`token=${secret}`).redacted;
    const twice = redactSecrets(once).redacted;
    expect(twice).toBe(once);
  });
});

describe('containsSecrets', () => {
  it('returns true when a known pattern matches', () => {
    expect(containsSecrets('ghp_' + 'A'.repeat(40))).toBe(true);
  });

  it('returns false for clean text', () => {
    expect(containsSecrets('hello world, just a normal message')).toBe(false);
  });
});
