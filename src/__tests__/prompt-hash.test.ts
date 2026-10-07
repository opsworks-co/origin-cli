/**
 * OR-48/A8: a Git note names a prompt by `sha256:` hash only when the hash is
 * provably over the text the permissioned prompt record serves. These pin the
 * v1 canonicalization (schema README vectors) and every reason the CLI must
 * write no hash at all. apps/api's prompt-hash-eligibility-parity test checks
 * the same rule against the API's own transformations.
 */
import { describe, it, expect } from 'vitest';
import { canonicalPromptHash } from '../attribution-record.js';
import {
  SERVED_PROMPT_TEXT_MAX_CHARS,
  isPromptHash,
  promptHashOmission,
  provablePromptHash,
} from '../prompt-hash.js';

describe('provablePromptHash — eligible prompts use the v1 canonical hash', () => {
  it('matches every test vector of the schema README', () => {
    expect(provablePromptHash('Add a retry to the upload client.'))
      .toBe('sha256:512d6c38f4066df65fc7c9606eee8e56db8f744938c23e1cb473524cb72a6947');
    expect(provablePromptHash('Also cover the timeout path with a test.\r\nKeep the public API unchanged.'))
      .toBe('sha256:fe415a6ebb38d75f3ff8685e31a4ae1181db8f304f65cb8647f4f2a4e56257ea');
    expect(provablePromptHash('Café menu: rename the route'))
      .toBe('sha256:592a611b697d52267ee802619b568864905785626befc57e619940a74be34e13');
    expect(provablePromptHash('Café menu: rename the route'))
      .toBe('sha256:592a611b697d52267ee802619b568864905785626befc57e619940a74be34e13');
  });

  it('distinguishes inner whitespace and is a well-formed hash', () => {
    const a = provablePromptHash('fix the  tests');
    const b = provablePromptHash('fix the tests');
    expect(a).not.toBe(b);
    expect(isPromptHash(a)).toBe(true);
    expect(a).toBe(canonicalPromptHash('fix the  tests'));
  });

  it('a prompt exactly at the stored limit is still whole, and eligible', () => {
    expect(provablePromptHash('x'.repeat(SERVED_PROMPT_TEXT_MAX_CHARS))).toBe(canonicalPromptHash('x'.repeat(SERVED_PROMPT_TEXT_MAX_CHARS)));
  });
});

describe('provablePromptHash — fail closed', () => {
  const cases: Array<[string, string | null | undefined, string]> = [
    ['empty', '', 'no-text'],
    ['missing', undefined, 'no-text'],
    ['over the stored limit (the record holds a clipped copy)', 'x'.repeat(SERVED_PROMPT_TEXT_MAX_CHARS + 1), 'over-limit'],
    ['leading whitespace (the API trims)', ' fix the tests', 'whitespace'],
    ['trailing newline (the API trims)', 'fix the tests\n', 'whitespace'],
    ['an agent envelope (the API strips it)', '<user_query>fix the tests</user_query>', 'envelope'],
    ['a system reminder', 'fix it <system_reminder>be brief</system_reminder>', 'envelope'],
    ['any tag-like token, even one the API does not strip today', 'render <Button> in the header', 'envelope'],
    ['the Codex files envelope', '# Files mentioned by the user:\n- a.ts\n## My request: fix it', 'envelope'],
    ['an image placeholder (relinked after upload)', 'what is wrong in [image]', 'image-placeholder'],
    ['a resolved image placeholder', 'see [image:abc123]', 'image-placeholder'],
    ['a secret the producers may or may not redact', 'use ghp_' + 'a'.repeat(36) + ' to push', 'redaction'],
  ];
  for (const [name, text, reason] of cases) {
    it(`${name} → no hash`, () => {
      expect(promptHashOmission(text)).toBe(reason);
      expect(provablePromptHash(text)).toBeUndefined();
    });
  }

  it('never hashes a truncated prefix as if it were the prompt', () => {
    const whole = 'y'.repeat(SERVED_PROMPT_TEXT_MAX_CHARS + 500);
    expect(provablePromptHash(whole)).toBeUndefined();
    // The clipped copy a producer stores is a different string; the writer
    // never hashes it, because it is not the captured prompt.
    expect(provablePromptHash(whole)).not.toBe(canonicalPromptHash(whole.slice(0, SERVED_PROMPT_TEXT_MAX_CHARS)));
  });
});
