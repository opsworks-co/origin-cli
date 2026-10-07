/**
 * Prompt identity for Git notes without the prompt (OR-48/A8).
 *
 * A note may carry `sha256:<hex>` of a prompt in place of its text — but only
 * a hash a reader can check against the permissioned prompt record, which is
 * what an authorized reader gets from `<origin>/sessions/<id>?prompt=N`. That
 * text is NOT the prompt the hooks saw: every producer clips a PromptChange
 * row to SERVED_PROMPT_TEXT_MAX_CHARS, some producers redact secrets first and
 * others (transcript-watch, heartbeat) don't, the API strips agent envelopes
 * and trims on the way out (`stripPromptEnvelopes`), and an image upload later
 * rewrites `[image]` into `[image:<id>]`. A note writer cannot tell which of
 * those happened to the row.
 *
 * So a hash is written only for a prompt that every one of those steps leaves
 * unchanged — then the stored, served and hooked texts are the same string.
 * Anything else gets no hash: an absent `prompt_hash` is a valid v1 record, a
 * hash of some other text is a false integrity claim.
 *
 * The hash identifies a prompt, it does not hide it: a short or predictable
 * prompt can be recovered by hashing guesses.
 */

import { canonicalPromptHash } from './attribution-record.js';
import { redactSecrets } from './redaction.js';

/** Every CLI producer stores at most this many UTF-16 code units of a prompt (`.slice(0, 1000)`). */
export const SERVED_PROMPT_TEXT_MAX_CHARS = 1000;

export type PromptHashOmission =
  | 'no-text'
  | 'over-limit'
  | 'redaction'
  | 'whitespace'
  | 'envelope'
  | 'image-placeholder';

// Deliberately wider than the API's envelope list: any tag-like token, so a
// tag the API learns to strip later cannot make an old eligibility decision
// wrong. The parity test in apps/api checks the API's stripping against this.
const TAG_LIKE = /<\/?[A-Za-z_]/;
// Codex Desktop's attachment envelope, stripped by the API from the start of a line.
const CODEX_FILES_ENVELOPE = /^#\s*Files mentioned by the user:/im;
// `[image]` placeholders are rewritten to `[image:<id>]` after an upload.
const IMAGE_PLACEHOLDER = /\[image\b/i;

/**
 * Why `text` cannot be hashed as its permissioned prompt record, or null when
 * it can. Pure.
 */
export function promptHashOmission(text: string | null | undefined): PromptHashOmission | null {
  if (typeof text !== 'string' || text.length === 0) return 'no-text';
  if (text.length > SERVED_PROMPT_TEXT_MAX_CHARS) return 'over-limit';
  if (text !== text.trim()) return 'whitespace';
  if (TAG_LIKE.test(text) || CODEX_FILES_ENVELOPE.test(text)) return 'envelope';
  if (IMAGE_PLACEHOLDER.test(text)) return 'image-placeholder';
  if (redactSecrets(text).redacted !== text) return 'redaction';
  return null;
}

/**
 * `canonicalPromptHash(text)` when `text` is provably the text the
 * permissioned prompt record serves, otherwise undefined. `text` must be the
 * whole prompt as the hooks captured it — never a summary, a clipped copy or a
 * note's redacted field.
 */
export function provablePromptHash(text: string | null | undefined): string | undefined {
  if (promptHashOmission(text) !== null) return undefined;
  return canonicalPromptHash(text as string);
}

const PROMPT_HASH = /^sha256:[0-9a-f]{64}$/;

/** A value shaped like a canonical prompt hash. */
export function isPromptHash(value: unknown): value is string {
  return typeof value === 'string' && PROMPT_HASH.test(value);
}
