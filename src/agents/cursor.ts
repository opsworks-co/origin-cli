// ── Cursor agent adapter: transcript discovery & model detection ────────────
// Extracted verbatim from commands/hooks.ts (R3 phase C). Knows Cursor's
// internals: the ai-code-tracking SQLite DB for the real model (hooks always
// send model:"default") and the agent-transcripts JSONL layout.
import fs from 'fs';
import os from 'os';
import path from 'path';
import { querySqlite } from '../utils/sqlite.js';
import { debugLog } from '../debug-log.js';
import type { PromptTimelineEntry } from './codex.js';

// ─── Cursor Model Detection ──────────────────────────────────────────────
// Cursor always sends model:"default" in hooks. Read the actual model from
// Cursor's internal SQLite database (~/.cursor/ai-tracking/ai-code-tracking.db).

export function getCursorModelFromDb(conversationId: string): string | null {
  try {
    // Validate conversationId to prevent SQL injection via shell command
    if (!/^[a-zA-Z0-9_-]+$/.test(conversationId)) return null;

    const dbPath = path.join(os.homedir(), '.cursor', 'ai-tracking', 'ai-code-tracking.db');
    if (!fs.existsSync(dbPath)) return null;

    // Cross-platform read (sqlite3 CLI on mac/linux, in-process sql.js on
    // Windows) — see utils/sqlite.ts. Avoids a native module dependency.
    const sqlOpts = { timeoutMs: 2000 };
    const escapedId = conversationId.replace(/'/g, "''");
    const result = querySqlite(dbPath, `SELECT model FROM conversation_summaries WHERE conversationId='${escapedId}' LIMIT 1`, sqlOpts).trim();
    if (result && result !== 'default' && result !== 'unknown') return result;

    // Fallback: check tracked_file_content or ai_code_hashes for this conversation
    const result2 = querySqlite(dbPath, `SELECT DISTINCT model FROM tracked_file_content WHERE conversationId='${escapedId}' AND model IS NOT NULL AND model != '' LIMIT 1`, sqlOpts).trim();
    if (result2 && result2 !== 'default' && result2 !== 'unknown') return result2;

    const result3 = querySqlite(dbPath, `SELECT DISTINCT model FROM ai_code_hashes WHERE conversationId='${escapedId}' AND model IS NOT NULL AND model != '' LIMIT 1`, sqlOpts).trim();
    if (result3 && result3 !== 'default' && result3 !== 'unknown') return result3;
  } catch {
    // sqlite3 not available or DB locked — non-fatal
  }
  return null;
}

// ─── Cursor Transcript Discovery ──────────────────────────────────────────

export interface CursorTranscriptData {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  tokensUsed: number;
  transcript: string;  // JSON stringified [{role, content}]
  jsonlPath: string;   // resolved on-disk path of the agent-transcript JSONL
}

/**
 * The on-disk agent-transcript folder is Cursor's STABLE conversation_id.
 * session_id rotates every turn and is not the JSONL name — preferring it
 * made discoverCursorTranscript miss, and Stop fell through to a
 * prompt-length guess (prod: 196 tokens / $0.00 on a 66-minute chat).
 */
export function cursorTranscriptLookupId(input: {
  session_id?: unknown;
  conversation_id?: unknown;
}): string | undefined {
  const conv = typeof input.conversation_id === 'string' ? input.conversation_id.trim() : '';
  if (conv) return conv;
  const sess = typeof input.session_id === 'string' ? input.session_id.trim() : '';
  return sess || undefined;
}

/**
 * Resolve the on-disk path of a Cursor agent-transcript JSONL for a
 * conversation — same strict ID-anchored discovery discoverCursorTranscript
 * uses, but returns the raw path so callers
 * that need to RE-PARSE the JSONL (capturePromptEdits, which walks per-turn
 * tool calls into isolated PromptEdits) can read it directly. Cursor never
 * routes its agent-transcript path through `input.transcript_path`, so
 * without this the per-prompt edit extractor runs against an empty/wrong
 * path, editsJson stays empty, and the dashboard falls back to the
 * cumulative working-tree pc.diff (prompt N shows prompt N-1's changes too).
 * Returns null when there's no fresh ID-matched file.
 */
export function findCursorTranscriptJsonl(conversationId?: string): string | null {
  try {
    const cursorProjectsDir = path.join(os.homedir(), '.cursor', 'projects');
    if (!fs.existsSync(cursorProjectsDir)) return null;
    if (!conversationId) {
      debugLog('cursor', 'findCursorTranscriptJsonl: no conversationId — refusing to guess');
      return null;
    }
    const matches: string[] = [];
    for (const ws of fs.readdirSync(cursorProjectsDir)) {
      const candidate = path.join(cursorProjectsDir, ws, 'agent-transcripts', conversationId, `${conversationId}.jsonl`);
      if (fs.existsSync(candidate)) matches.push(candidate);
    }
    if (matches.length === 0) {
      debugLog('cursor', 'findCursorTranscriptJsonl: no JSONL for conversationId', { conversationId });
      return null;
    }
    if (matches.length > 1) {
      debugLog('cursor', 'findCursorTranscriptJsonl: conversationId resolved in MULTIPLE workspaces — using first', {
        conversationId, matches,
      });
    }
    // An exact conversation-id match IS that chat, even if the last turn
    // ended more than 30 minutes ago. The stale refuse used to drop the
    // file and send Stop down the prompt-length fallback ($0.00).
    return matches[0];
  } catch {
    return null;
  }
}

/**
 * Sibling transcripts for the forked subagents a "Multitask" turn spawns.
 *
 * When Cursor forks a background agent it writes that agent's work to
 *   agent-transcripts/<conversationId>/subagents/<subagentSessionId>.jsonl
 * — a file the main `<id>/<id>.jsonl` never references. The subagent also runs
 * under a fresh per-turn `session_id` and fires no stop hook of its own, so if
 * we don't read these files its tool calls, edits and tokens are invisible:
 * the parent transcript parse simply ends at the fork point. Observed on a real
 * karamba session where the subagent's 4 StrReplace edits and its commit landed
 * exclusively in subagents/620d986f-….jsonl.
 *
 * Returns [] when there is no subagents dir (the common single-agent case).
 */
export function findCursorSubagentJsonls(mainJsonlPath: string): string[] {
  try {
    const subagentsDir = path.join(path.dirname(mainJsonlPath), 'subagents');
    if (!fs.existsSync(subagentsDir)) return [];
    const found = fs.readdirSync(subagentsDir)
      .filter(f => f.endsWith('.jsonl'))
      .map(f => path.join(subagentsDir, f))
      .sort();
    if (found.length) debugLog('cursor', 'found subagent transcripts', { count: found.length, subagentsDir });
    return found;
  } catch {
    return [];
  }
}

/**
 * Cursor stores agent conversation transcripts as JSONL at:
 *   ~/.cursor/projects/<workspace>/agent-transcripts/<id>/<id>.jsonl
 *
 * Each line: { role: "user"|"assistant", message: { content: [{ type, text }] } }
 *
 * There are no token counts in these files. Cursor also records tool CALLS
 * but almost never tool RESULTS, so a sum of visible text prices a
 * 66-minute / 42-tool session at ~200 tokens / $0.00.
 *
 * Estimate:
 *   • user / assistant / thinking / tool-call args from the JSONL
 *   • explicit tool_result blocks when present
 *   • Read / ReadFile bodies reconstructed from disk (offset/limit aware)
 *   • each assistant line is one billed request: new text is input,
 *     everything already seen is a cache read (Cursor's real bill)
 *
 * Still an estimate — no system prompt, and Shell/Grep output cannot be
 * recovered — so user prompt text keeps a small multiplier for injected
 * rules that never appear in the JSONL.
 */
export const CURSOR_CHARS_PER_TOKEN = 3.5;
export const CURSOR_PROMPT_CONTEXT_MULTIPLIER = 2;
/** Refuse to slurp a giant file into the estimate (binaries, generated). */
export const CURSOR_RECONSTRUCT_MAX_BYTES = 2 * 1024 * 1024;
export const CURSOR_RECONSTRUCT_MAX_CHARS = 200_000;

export interface CursorTokenEstimate {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  tokensUsed: number;
}

export function estimateCursorTokens(counts: {
  userChars: number;
  toolResultChars: number;
  assistantChars: number;
  thinkingChars: number;
  toolUseChars: number;
}): CursorTokenEstimate {
  const inputTokens =
    Math.round(Math.max(counts.userChars, 0) / CURSOR_CHARS_PER_TOKEN) * CURSOR_PROMPT_CONTEXT_MULTIPLIER +
    Math.round(Math.max(counts.toolResultChars, 0) / CURSOR_CHARS_PER_TOKEN);
  const outputTokens = Math.round(
    (Math.max(counts.assistantChars, 0) +
      Math.max(counts.thinkingChars, 0) +
      Math.max(counts.toolUseChars, 0)) / CURSOR_CHARS_PER_TOKEN,
  );
  return { inputTokens, outputTokens, cacheReadTokens: 0, tokensUsed: inputTokens + outputTokens };
}

function billedChars(value: unknown): number {
  if (typeof value === 'string') return value.length;
  if (value == null) return 0;
  try { return JSON.stringify(value).length; } catch { return 0; }
}

function charsToTokens(chars: number): number {
  return Math.round(Math.max(chars, 0) / CURSOR_CHARS_PER_TOKEN);
}

function isReadTool(name: unknown): boolean {
  const n = String(name || '').toLowerCase();
  return n === 'read' || n === 'readfile' || n === 'read_file';
}

function toolFilePath(input: unknown, cwd?: string): string | null {
  if (!input || typeof input !== 'object') return null;
  const rec = input as Record<string, unknown>;
  const raw = rec.path ?? rec.file_path ?? rec.target_file ?? rec.filePath;
  if (typeof raw !== 'string' || !raw.trim()) return null;
  const p = raw.trim();
  if (p.startsWith('/') || /^[A-Za-z]:[\\/]/.test(p)) return p;
  if (!cwd) return null;
  return path.resolve(cwd, p);
}

function reconstructReadChars(input: unknown, cwd?: string): number {
  const filePath = toolFilePath(input, cwd);
  if (!filePath) return 0;
  try {
    const st = fs.statSync(filePath);
    if (!st.isFile() || st.size <= 0 || st.size > CURSOR_RECONSTRUCT_MAX_BYTES) return 0;
    const buf = fs.readFileSync(filePath);
    // An image or other binary file is not text the model read — counting its
    // bytes as UTF-8 chars billed a 37 KB PNG as ~10k tokens on every request.
    if (buf.subarray(0, 8192).includes(0)) return 0;
    let text = buf.toString('utf-8');
    const rec = input && typeof input === 'object' ? input as Record<string, unknown> : {};
    const offset = typeof rec.offset === 'number' && rec.offset > 0 ? Math.floor(rec.offset) : 0;
    const limit = typeof rec.limit === 'number' && rec.limit > 0 ? Math.floor(rec.limit) : 0;
    if (offset || limit) {
      const lines = text.split('\n');
      const start = offset > 0 ? offset - 1 : 0;
      text = lines.slice(start, limit ? start + limit : undefined).join('\n');
    }
    return Math.min(text.length, CURSOR_RECONSTRUCT_MAX_CHARS);
  } catch {
    return 0;
  }
}

function toolResultChars(block: any): number {
  if (typeof block?.content === 'string') return block.content.length;
  if (Array.isArray(block?.content)) {
    return billedChars(block.content.map((b: any) => typeof b === 'string' ? b : (b?.text || b?.content || '')).filter(Boolean).join('\n'));
  }
  if (block?.content) return billedChars(block.content);
  return 0;
}

/**
 * Token buckets from Cursor JSONL. Reconstructs missing Read results and
 * bills each assistant line as a request (new text = input, prior = cache).
 */
export function measureCursorJsonlTokens(lines: string[], opts: { cwd?: string } = {}): CursorTokenEstimate {
  let pendingFreshChars = 0;
  let pendingResultChars = 0;
  let contextChars = 0;
  let inputTokens = 0;
  let outputTokens = 0;
  let cacheReadTokens = 0;
  let sawAssistant = false;

  const billRequest = (outputChars: number) => {
    const fresh = pendingFreshChars + pendingResultChars;
    inputTokens += charsToTokens(fresh);
    cacheReadTokens += charsToTokens(contextChars);
    contextChars += fresh + outputChars;
    outputTokens += charsToTokens(outputChars);
    pendingFreshChars = 0;
    pendingResultChars = 0;
    sawAssistant = true;
  };

  for (const line of lines) {
    if (!line.trim()) continue;
    let entry: any;
    try { entry = JSON.parse(line); } catch { continue; }
    const role = entry.role || 'unknown';
    const content = entry.message?.content;

    if (typeof content === 'string') {
      if (role === 'user') pendingFreshChars += content.length * CURSOR_PROMPT_CONTEXT_MULTIPLIER;
      else if (role === 'assistant') billRequest(content.length);
      continue;
    }
    if (!Array.isArray(content)) continue;

    if (role === 'user') {
      for (const c of content as any[]) {
        if (c?.type === 'text' && typeof c.text === 'string') {
          pendingFreshChars += c.text.length * CURSOR_PROMPT_CONTEXT_MULTIPLIER;
        } else if (c?.type === 'tool_result') {
          pendingResultChars += toolResultChars(c);
        }
      }
      continue;
    }
    if (role !== 'assistant') continue;

    let outputChars = 0;
    let sameMessageResults = 0;
    let reconstructed = 0;
    for (const c of content as any[]) {
      const t = c?.type;
      if (t === 'text' && typeof c.text === 'string') outputChars += c.text.length;
      else if (t === 'thinking') outputChars += billedChars(c.thinking || c.text || '');
      else if (t === 'tool_use') {
        outputChars += billedChars(c.input ?? c.arguments ?? '');
        if (isReadTool(c.name)) reconstructed += reconstructReadChars(c.input ?? c.arguments, opts.cwd);
      } else if (t === 'tool_result') {
        sameMessageResults += toolResultChars(c);
      }
    }
    // Fixture / rare shape: a tool_result recorded on the assistant line is
    // treated as this request's input. Reconstructed Read bodies arrive AFTER
    // the call, so they wait for the next request (or flush at the end).
    pendingResultChars += sameMessageResults;
    billRequest(outputChars);
    pendingResultChars += reconstructed;
  }

  if (!sawAssistant && pendingFreshChars + pendingResultChars > 0) {
    inputTokens += charsToTokens(pendingFreshChars + pendingResultChars);
  } else if (pendingResultChars > 0) {
    inputTokens += charsToTokens(pendingResultChars);
    cacheReadTokens += charsToTokens(contextChars);
  }

  return { inputTokens, outputTokens, cacheReadTokens, tokensUsed: inputTokens + outputTokens };
}

export function discoverCursorTranscript(conversationId?: string, hookCwd?: string, opts: { verbose?: boolean } = {}): CursorTranscriptData | null {
  try {
    // STRICT ID-anchored discovery lives in the shared resolver so
    // capturePromptEdits and this token/display parser agree on exactly
    // which file is "the" transcript for this conversation.
    const transcriptFileFinal = findCursorTranscriptJsonl(conversationId);
    if (!transcriptFileFinal) return null;

    // Parse the JSONL — main conversation first, then any forked-subagent
    // transcripts so a Multitask turn's background work is counted too.
    const readLines = (p: string) => {
      try { return fs.readFileSync(p, 'utf-8').split('\n').filter(l => l.trim()); }
      catch { return [] as string[]; }
    };
    const lines = [
      ...readLines(transcriptFileFinal),
      ...findCursorSubagentJsonls(transcriptFileFinal).flatMap(readLines),
    ];

    const TRUNC = opts.verbose ? Number.MAX_SAFE_INTEGER : 2000;
    const truncate = (s: string) => s.length > TRUNC ? s.slice(0, TRUNC) + `… [+${s.length - TRUNC} chars]` : s;

    const turns: Array<{ role: string; content: string }> = [];
    const estimated = measureCursorJsonlTokens(lines, { cwd: hookCwd });

    for (const line of lines) {
      try {
        const entry = JSON.parse(line);
        const role = entry.role || 'unknown';
        const content = entry.message?.content;

        // Cursor blocks: text, tool_use, tool_result, thinking
        // Pull out everything we can render — text + structured tool I/O —
        // so reviewers see what the agent ran, not just the narration.
        const parts: string[] = [];

        if (typeof content === 'string') {
          parts.push(content);
        } else if (Array.isArray(content)) {
          for (const c of content as any[]) {
            const t = c?.type;
            if (t === 'text' && typeof c.text === 'string') {
              parts.push(c.text);
            } else if (t === 'thinking' && (c.thinking || c.text)) {
              // Collapse internal blank lines — the web's reasoning block ends
              // at the first empty line, and thinking is usually multi-paragraph.
              parts.push(`[Reasoning] ${truncate((c.thinking || c.text || '').trim().replace(/\n{2,}/g, '\n'))}`);
            } else if (t === 'tool_use' && c.name) {
              const inp = c.input || {};
              const argStr =
                typeof inp.command === 'string' ? inp.command :
                typeof inp.cmd === 'string' ? inp.cmd :
                inp.file_path && (typeof inp.old_string === 'string' || typeof inp.new_string === 'string')
                  ? [`file: ${inp.file_path}`,
                     typeof inp.old_string === 'string' ? `--- old\n${inp.old_string}` : '',
                     typeof inp.new_string === 'string' ? `+++ new\n${inp.new_string}` : '']
                    .filter(Boolean).join('\n')
                  : (() => { try { return JSON.stringify(inp, null, 2); } catch { return ''; } })();
              parts.push(`[Tool: ${c.name}]`);
              if (argStr) parts.push(truncate(argStr));
            } else if (t === 'tool_result') {
              const out =
                typeof c.content === 'string' ? c.content :
                Array.isArray(c.content)
                  ? c.content.map((b: any) => typeof b === 'string' ? b : (b?.text || b?.content || '')).filter(Boolean).join('\n')
                  : '';
              if (out) parts.push(`[Output] ${truncate(out)}`);
            }
          }
        }

        const text = parts.join('\n').trim();
        if (!text) continue;

        // Strip XML wrappers like <user_query>...</user_query>
        const cleaned = text.replace(/<\/?user_query>/g, '').trim();
        if (!cleaned) continue;

        turns.push({ role, content: cleaned });
      } catch {
        // skip malformed lines
      }
    }

    if (turns.length === 0) return null;

    debugLog('cursor', 'parsed agent transcript', {
      turns: turns.length,
      estimatedInputTokens: estimated.inputTokens,
      estimatedOutputTokens: estimated.outputTokens,
      estimatedCacheReadTokens: estimated.cacheReadTokens,
      totalTokens: estimated.tokensUsed,
    });

    return {
      inputTokens: estimated.inputTokens,
      outputTokens: estimated.outputTokens,
      cacheReadTokens: estimated.cacheReadTokens,
      tokensUsed: estimated.tokensUsed,
      transcript: JSON.stringify(turns),
      jsonlPath: transcriptFileFinal,
    };
  } catch (err) {
    debugLog('cursor', 'discoverCursorTranscript error', { error: String(err) });
    return null;
  }
}

