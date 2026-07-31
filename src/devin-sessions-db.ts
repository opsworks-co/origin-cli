// LIVE Devin CLI capture, read from its own SQLite state DB.
//
// Why this exists (and why the ATIF transcript is not enough): Devin writes
// ~/.local/share/devin/cli/transcripts/<id>.json only when a CONVERSATION ENDS.
// While a conversation is open there is NO transcript file, so a turn's own Stop
// hook has nothing to read and the turn lands with no response, 0 tool calls and
// a prompt-text token ESTIMATE ("32 tokens", "No response captured").
//
// But Devin ALSO writes ~/.local/share/devin/cli/sessions.db continuously, and
// crucially it is keyed by the SAME id the hook receives on stdin
// (`session_id` = `sessions.id`, e.g. "debonair-gambler"). Verified live: while
// a conversation was still open, sessions.db already held the model, every
// user/assistant/tool message and per-message token metrics. So we read the DB
// and get real data DURING the turn — no waiting, and no prompt-text matching
// (the transcript filename never matched the hook's session_id anyway).
//
// Reads go through utils/sqlite.ts, the same reader Cursor/Codex use: sqlite3
// CLI on macOS/Linux (handles the -wal sidecar transparently) with a sql.js
// WASM fallback on Windows.
import fs from 'fs';
import os from 'os';
import path from 'path';
import { querySqlite } from './utils/sqlite.js';

export interface DevinLiveSessionData {
  model?: string;
  tokensUsed: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  toolCalls: number;
  prompts: string[];
  /**
   * Real submission time (ISO) of each user prompt, aligned to `prompts` by
   * index. Devin's own hook records the prompt LATE — at the Stop after the
   * turn's work, ~1s AFTER any commit the turn made — so the server's
   * timestamp-based commit attribution sees a commit as happening BEFORE its
   * producing prompt and credits the wrong (or no) turn. message_nodes carries
   * the true `metadata.created_at`; feeding it back fixes the ordering.
   */
  promptTimes: (string | undefined)[];
  /** JSON.stringify([{role, content}]) — display transcript, or undefined. */
  transcript?: string;
}

/** Locate Devin CLI's sessions.db (XDG / macOS / Windows), or null. */
export function findDevinSessionsDb(): string | null {
  const home = os.homedir();
  const bases: string[] = [];
  if (process.env.XDG_DATA_HOME) bases.push(process.env.XDG_DATA_HOME);
  bases.push(path.join(home, '.local', 'share'));
  if (process.env.LOCALAPPDATA) bases.push(process.env.LOCALAPPDATA);
  bases.push(path.join(home, 'AppData', 'Local'));
  for (const b of bases) {
    const p = path.join(b, 'devin', 'cli', 'sessions.db');
    try { if (fs.existsSync(p)) return p; } catch { /* skip */ }
  }
  return null;
}

const truncate = (s: string, max = 2000): string => (s.length > max ? s.slice(0, max) + '…' : s);

// Single-quote escape for a SQLite string literal. Session ids are word-word
// slugs, but never interpolate unescaped.
const sqlStr = (v: string): string => `'${v.replace(/'/g, "''")}'`;

const num = (v: any): number => {
  const n = typeof v === 'number' ? v : parseInt(String(v ?? ''), 10);
  return Number.isFinite(n) ? n : 0;
};

/**
 * Pure parse of the rows we pull out of sessions.db → session data. Split from
 * the query so it is unit-testable without a database.
 *
 * `messagesJson` is the ordered `message_nodes.chat_message` payloads. Rows are
 * DEDUPED by their message_id: the table stores a node per branch, so the same
 * assistant message appears more than once and naive summing double-counts
 * every token.
 */
export function parseDevinLiveMessages(
  messagesJson: string[],
  model?: string,
): DevinLiveSessionData {
  const seen = new Set<string>();
  const prompts: string[] = [];
  const promptTimes: (string | undefined)[] = [];
  const turns: Array<{ role: string; content: string }> = [];
  let inputTokens = 0;
  let outputTokens = 0;
  let cacheReadTokens = 0;
  let toolCalls = 0;

  for (const raw of messagesJson) {
    let m: any;
    try { m = JSON.parse(raw); } catch { continue; }
    if (!m || typeof m !== 'object') continue;
    const id = typeof m.message_id === 'string' ? m.message_id : '';
    if (id) {
      if (seen.has(id)) continue;   // branch duplicate — count once
      seen.add(id);
    }
    const role = String(m.role || '');
    if (role === 'system') continue;             // prompt scaffolding, not the turn
    const content = typeof m.content === 'string' ? m.content.trim() : '';

    if (role === 'tool') {
      toolCalls++;
      if (content) turns.push({ role: 'assistant', content: `[Tool] ${truncate(content, 500)}` });
      continue;
    }
    if (role === 'user') {
      if (content) {
        prompts.push(content);
        const created = typeof m?.metadata?.created_at === 'string' ? m.metadata.created_at : undefined;
        promptTimes.push(created);
        turns.push({ role: 'user', content: truncate(content) });
      }
      continue;
    }
    // assistant
    if (content) turns.push({ role: 'assistant', content: truncate(content) });
    const metrics = m?.metadata?.metrics;
    if (metrics && typeof metrics === 'object') {
      inputTokens += num(metrics.input_tokens);
      outputTokens += num(metrics.output_tokens);
      cacheReadTokens += num(metrics.cache_read_tokens);
    }
  }

  return {
    model: model || undefined,
    tokensUsed: inputTokens + outputTokens,
    inputTokens,
    outputTokens,
    cacheReadTokens,
    toolCalls,
    prompts,
    promptTimes,
    transcript: turns.length > 0 ? JSON.stringify(turns) : undefined,
  };
}

/**
 * Read a LIVE Devin conversation straight from sessions.db, keyed by the hook's
 * own `session_id`. Returns null when the DB / session isn't there (Devin not
 * installed, a non-Devin agent, or the reader unavailable) — every caller treats
 * null as "nothing to add" and falls back to the existing behaviour.
 *
 * `chat_message` is JSON containing newlines and `|`, which would shred the
 * reader's line/`|` row format — so it's pulled as hex and decoded here.
 */
export function readDevinLiveSession(
  sessionId: string,
  opts: { dbPath?: string } = {},
): DevinLiveSessionData | null {
  if (!sessionId) return null;
  const db = opts.dbPath || findDevinSessionsDb();
  if (!db) return null;
  try {
    const model = querySqlite(db, `SELECT model FROM sessions WHERE id = ${sqlStr(sessionId)};`).trim();
    const hexRows = querySqlite(
      db,
      `SELECT hex(chat_message) FROM message_nodes WHERE session_id = ${sqlStr(sessionId)} ORDER BY node_id;`,
    );
    const messages: string[] = [];
    for (const line of hexRows.split('\n')) {
      const hex = line.trim();
      if (!hex) continue;
      try { messages.push(Buffer.from(hex, 'hex').toString('utf-8')); } catch { /* skip */ }
    }
    if (messages.length === 0 && !model) return null;
    const data = parseDevinLiveMessages(messages, model || undefined);
    // Nothing worth reporting (session row exists but no usable turns yet).
    if (!data.transcript && data.tokensUsed === 0 && !data.model) return null;
    return data;
  } catch {
    return null;
  }
}
