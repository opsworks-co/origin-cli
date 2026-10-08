// ── Redact secrets out of a turn's captured CONTENT before it leaves ───────
//
// Prompt text has always gone through redactSecrets before the API sees it
// (stop.ts "F9"), but a turn's file content — `diff`, `uncommittedDiff` and
// the `editsJson` tool-call capture — did not. An uncommitted `.env` edit went
// to the API verbatim and into changes.json on the `origin-sessions` branch,
// which is pushed to the repo's remote.
//
// Line counts and blame are derived from these texts, so redaction here must
// never change their LINE STRUCTURE: it runs line by line and only ever
// replaces text inside a line. (redactSecrets on a whole text can span a
// newline — `Bearer\s+…` — and would eat it.) editsJson is parsed and its
// string values redacted, so it stays valid JSON.

import { loadConfig } from './config.js';
import { redactSecrets } from './redaction.js';

/**
 * `text` with secrets redacted, its newlines untouched: the result has
 * exactly as many lines as the input, each one changed only within itself.
 */
export function redactSecretsByLine(text: string): string {
  if (!text) return text;
  // Whole-text pass first, as a cheap "anything here at all?" check — the
  // common diff holds no secret and should not pay a per-line scan.
  if (redactSecrets(text).foundCount === 0) return text;
  return text.split('\n').map((line) => redactSecrets(line).redacted).join('\n');
}

function redactJsonValue(v: unknown): unknown {
  if (typeof v === 'string') return redactSecretsByLine(v);
  if (Array.isArray(v)) return v.map(redactJsonValue);
  if (v && typeof v === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, val] of Object.entries(v)) out[k] = redactJsonValue(val);
    return out;
  }
  return v;
}

/**
 * A captured editsJson with secrets redacted in its string values. Returns
 * `raw` itself when nothing was found. A string that does not parse (an
 * already-truncated capture) is redacted as text — consumers treat it as
 * unparseable either way.
 */
export function redactEditsJson(raw: string): string {
  if (!raw || redactSecrets(raw).foundCount === 0) return raw;
  let parsed: unknown;
  try { parsed = JSON.parse(raw); } catch { return redactSecretsByLine(raw); }
  return JSON.stringify(redactJsonValue(parsed));
}

/** The content fields of one turn row, redacted. Other fields pass through. */
export function redactPromptChangeContent<T>(pc: T): T {
  if (!pc || typeof pc !== 'object') return pc;
  const row = pc as any;
  let out: any = null;
  const set = (key: string, value: string) => {
    if (value === row[key]) return;
    out = out || { ...row };
    out[key] = value;
  };
  if (typeof row.diff === 'string') set('diff', redactSecretsByLine(row.diff));
  if (typeof row.uncommittedDiff === 'string') set('uncommittedDiff', redactSecretsByLine(row.uncommittedDiff));
  if (typeof row.editsJson === 'string') set('editsJson', redactEditsJson(row.editsJson));
  return (out || pc) as T;
}

/** Same `secretRedaction` switch the prompt-text redaction honours. */
export function secretRedactionEnabled(): boolean {
  try { return loadConfig()?.secretRedaction !== false; } catch { return true; }
}

/**
 * A session update / end payload whose `promptChanges` carry no secrets in
 * their diffs or editsJson. Returns the input untouched when redaction is
 * off or nothing needed it.
 */
export function redactSessionPayloadContent<T>(data: T): T {
  const rows = (data as any)?.promptChanges;
  if (!Array.isArray(rows) || !secretRedactionEnabled()) return data;
  let changed = false;
  const promptChanges = rows.map((pc: any) => {
    const r = redactPromptChangeContent(pc);
    if (r !== pc) changed = true;
    return r;
  });
  return changed ? { ...(data as any), promptChanges } : data;
}
