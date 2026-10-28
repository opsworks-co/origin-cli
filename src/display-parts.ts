// An assistant message's share-safe parts: the agent's own words and the
// names of the tools it called, kept apart from the message's `content`
// (where tool inputs and outputs are inlined). The public share page shows
// only these — see DisplayMessage in transcript.ts and the API's
// utils/share-replies.ts. Every agent's transcript formatter builds them here.

import { redactSecrets } from './redaction.js';

export type DisplayPart = { text: string } | { tool: string };

/** The agent's own words, as a share-safe part: secret-redacted, never empty. */
export function replyTextPart(text: unknown): DisplayPart | null {
  if (typeof text !== 'string' || !text.trim()) return null;
  return { text: redactSecrets(text).redacted };
}

/** A tool the agent called — the name only, never its input or output. */
export function replyToolPart(name: unknown): DisplayPart | null {
  if (typeof name !== 'string' || !name.trim()) return null;
  return { tool: name.trim() };
}

/** `{ parts }` to spread into a message when there is any, else nothing. */
export function partsField(parts: Array<DisplayPart | null>): { parts?: DisplayPart[] } {
  const kept = parts.filter((p): p is DisplayPart => p !== null);
  return kept.length > 0 ? { parts: kept } : {};
}
