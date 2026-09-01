/**
 * The four GENERIC assignment rules (`*_KEY=`, `*_TOKEN=`, `*_SECRET=`,
 * `*_PASSWORD=`) match on the NAME being assigned, so they fired on any 10+
 * character value — including values that plainly cannot be a credential.
 *
 * This scanner BLOCKS commits. A blocker that cries wolf gets bypassed with
 * --no-verify, which is strictly worse than a narrower rule, so the false
 * positives matter as much as the misses. Real case, in this repo:
 *
 *   const PRICING_SETTING_KEY = 'model-pricing';   → "Key Assignment" → blocked
 *
 * Both directions are pinned here. The MISSES half is the more important one:
 * every filtered rule must still catch a credential-shaped value, and no vendor
 * pattern is filtered at all.
 */
import { describe, it, expect } from 'vitest';
import { isNonSecretAssignmentValue, GENERIC_ASSIGNMENT_RULES, PRE_COMMIT_PATTERNS } from '../commands/hooks.js';

// Assembled from fragments so no literal secret-shaped string sits in source.
const mk = (...p: string[]) => p.join('');

describe('generic assignment rules: values that are not secrets', () => {
  it('the case that blocked a real commit', () => {
    expect(isNonSecretAssignmentValue('model-pricing')).toBe(true);
  });

  it('skips references, because reading a secret from env is the CORRECT pattern', () => {
    for (const v of [
      'process.env.SESSION_ENCRYPTION_KEY',
      'import.meta.env.VITE_API_KEY',
      'Deno.env.get',
      '${DEPLOY_TOKEN}',
      '$DEPLOY_TOKEN',
      'getSecret(name)',
      'readFileSync(path)',
    ]) {
      expect(isNonSecretAssignmentValue(v), v).toBe(true);
    }
  });

  it('skips deliberate placeholders', () => {
    for (const v of ['xxxxxxxxxx', '<your-key-here>', 'your-token-here', 'changeme', 'placeholder', 'REDACTED', 'undefined']) {
      expect(isNonSecretAssignmentValue(v), v).toBe(true);
    }
  });

  it('skips kebab/snake WORD values', () => {
    for (const v of ['model-pricing', 'user_profile_cache', 'session-store-name']) {
      expect(isNonSecretAssignmentValue(v), v).toBe(true);
    }
  });
});

describe('generic assignment rules: still catches real secrets', () => {
  it('does NOT skip credential-shaped values', () => {
    for (const v of [
      mk('abc123', 'defghi', '12345678'),          // mixed alnum
      mk('wJalrXUtnFEMI', 'K7MDENG', 'bPxRfiCY'),  // base62 run
      mk('a1b2c3', 'd4e5f6', 'a7b8c9', 'd0e1f2'),  // hex-ish
      'supersecret',                                // one opaque lowercase run: no separator
      mk('deadbeef', 'cafebabe', '01234567'),
    ]) {
      expect(isNonSecretAssignmentValue(v), v).toBe(false);
    }
  });

  it('never applies the word-shape skip to a PASSWORD — a passphrase looks exactly like that', () => {
    const passphrase = 'correct-horse-battery-staple';
    expect(isNonSecretAssignmentValue(passphrase, true)).toBe(false);
    // The same shape under a *_KEY name is a constant, not a credential.
    expect(isNonSecretAssignmentValue(passphrase)).toBe(true);
  });

  it('an empty or whitespace value is not a finding', () => {
    expect(isNonSecretAssignmentValue('')).toBe(true);
    expect(isNonSecretAssignmentValue('   ')).toBe(true);
  });
});

describe('the filter is scoped to the generic rules only', () => {
  it('covers exactly the four name-based assignment rules', () => {
    expect([...GENERIC_ASSIGNMENT_RULES].sort()).toEqual([
      'Key Assignment', 'Password Assignment', 'Secret Assignment', 'Token Assignment',
    ]);
  });

  it('every filtered rule exists in the pattern list', () => {
    for (const name of GENERIC_ASSIGNMENT_RULES) {
      expect(PRE_COMMIT_PATTERNS.some((p) => p.name === name), name).toBe(true);
    }
  });

  it('vendor patterns are NOT filtered — their match is a credential SHAPE', () => {
    // If one of these were ever added to the filtered set, a real leak whose
    // value happened to look wordy would pass silently.
    for (const name of ['AWS Access Key', 'GitHub Token', 'Anthropic Key', 'OpenAI Key', 'Private Key', 'GCP API Key']) {
      expect(GENERIC_ASSIGNMENT_RULES.has(name), name).toBe(false);
    }
  });
});
