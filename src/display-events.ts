// A turn's steps as structured records: each model call, each stretch of
// thinking, each tool call — when it started, how long it took, whether it
// failed, what it cost. They ride on the display transcript's USER message
// (the prompt that started the turn) as `events`, covering everything up to
// the next prompt, so they travel and are stored, encrypted and merged
// exactly like the rest of the transcript.
//
// Only what the agent's own log records is filled in. Claude Code and Codex
// write times, tool errors and per-call usage; an agent whose log lacks a
// field leaves it out, and a transcript with no `events` at all renders as
// it always has. Never inferred, never estimated.
//
// The public share page never reads these (it reads `parts` only): an input
// preview is a command line or a file path, which is not for strangers.

import { redactSecrets } from './redaction.js';

export interface DisplayEventTokens {
  /** Fresh (non-cached) input tokens. */
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}

export interface DisplayEvent {
  kind: 'model' | 'thinking' | 'tool';
  /** When the step started, epoch ms. */
  ts?: number;
  durationMs?: number;
  /** Tool name (kind 'tool'). */
  tool?: string;
  /** One line of the tool's input: a command, a path, a query. Secret-redacted. */
  input?: string;
  /** Present only when the agent's log says the step failed. */
  error?: true;
  /** Model that served the call (kind 'model'). */
  model?: string;
  tokens?: DisplayEventTokens;
}

/** A turn keeps at most this many; the rest are counted in `eventsDropped`. */
export const MAX_EVENTS_PER_TURN = 1000;

const MAX_INPUT_PREVIEW = 160;

/** A log timestamp (ISO string or epoch ms) as epoch ms, or undefined. */
export function eventTime(raw: unknown): number | undefined {
  if (typeof raw === 'number') return Number.isFinite(raw) && raw > 0 ? raw : undefined;
  if (typeof raw !== 'string' || !raw) return undefined;
  const ms = Date.parse(raw);
  return Number.isFinite(ms) ? ms : undefined;
}

/** `end - start` when both are known and the order is sane. */
export function spanMs(start: number | undefined, end: number | undefined): number | undefined {
  if (start === undefined || end === undefined) return undefined;
  const d = end - start;
  return d >= 0 ? d : undefined;
}

/** The first non-blank line of a tool's input, redacted, then cut short. */
export function inputPreview(text: unknown): string | undefined {
  if (typeof text !== 'string') return undefined;
  const line = text.split('\n').find((l) => l.trim())?.trim();
  if (!line) return undefined;
  // Redact before cutting: a cut secret no longer matches its pattern.
  const redacted = redactSecrets(line).redacted;
  return redacted.length > MAX_INPUT_PREVIEW ? redacted.slice(0, MAX_INPUT_PREVIEW - 1) + '…' : redacted;
}

/** Tokens, or undefined when the call reported none at all. */
export function eventTokens(t: DisplayEventTokens): DisplayEventTokens | undefined {
  return t.input || t.output || t.cacheRead || t.cacheWrite ? t : undefined;
}

/**
 * Add steps to a turn's prompt message, in the order they happened, keeping
 * at most MAX_EVENTS_PER_TURN and counting the rest.
 */
export function appendTurnEvents(target: { events?: DisplayEvent[]; eventsDropped?: number }, more: DisplayEvent[]): void {
  if (more.length === 0) return;
  const have = target.events || [];
  const room = Math.max(0, MAX_EVENTS_PER_TURN - have.length);
  if (room > 0) target.events = [...have, ...more.slice(0, room)];
  if (more.length > room) target.eventsDropped = (target.eventsDropped || 0) + more.length - room;
}
