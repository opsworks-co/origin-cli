// ── Cursor agent adapter: transcript discovery & model detection ────────────
// Extracted verbatim from commands/hooks.ts (R3 phase C). Knows Cursor's
// internals: the ai-code-tracking SQLite DB for the real model (hooks always
// send model:"default") and the agent-transcripts JSONL layout.
import fs from 'fs';
import os from 'os';
import path from 'path';
import { execFileSync } from 'child_process';
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

    // Use sqlite3 CLI to query — avoids native module dependency
    const sqlOpts = { encoding: 'utf-8' as const, stdio: ['pipe', 'pipe', 'pipe'] as ['pipe', 'pipe', 'pipe'], timeout: 2000 };
    const escapedId = conversationId.replace(/'/g, "''");
    const result = execFileSync('sqlite3', [dbPath, `SELECT model FROM conversation_summaries WHERE conversationId='${escapedId}' LIMIT 1`], sqlOpts).trim();
    if (result && result !== 'default' && result !== 'unknown') return result;

    // Fallback: check tracked_file_content or ai_code_hashes for this conversation
    const result2 = execFileSync('sqlite3', [dbPath, `SELECT DISTINCT model FROM tracked_file_content WHERE conversationId='${escapedId}' AND model IS NOT NULL AND model != '' LIMIT 1`], sqlOpts).trim();
    if (result2 && result2 !== 'default' && result2 !== 'unknown') return result2;

    const result3 = execFileSync('sqlite3', [dbPath, `SELECT DISTINCT model FROM ai_code_hashes WHERE conversationId='${escapedId}' AND model IS NOT NULL AND model != '' LIMIT 1`], sqlOpts).trim();
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
  tokensUsed: number;
  transcript: string;  // JSON stringified [{role, content}]
  jsonlPath: string;   // resolved on-disk path of the agent-transcript JSONL
}

/**
 * Resolve the on-disk path of a Cursor agent-transcript JSONL for a
 * conversation — same strict ID-anchored discovery + 30-minute staleness
 * guard discoverCursorTranscript uses, but returns the raw path so callers
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
    const transcriptFileFinal = matches[0];
    try {
      const stat = fs.statSync(transcriptFileFinal);
      if (Date.now() - stat.mtimeMs > 30 * 60 * 1000) {
        debugLog('cursor', 'findCursorTranscriptJsonl: matched file stale, refusing', {
          conversationId, ageMs: Date.now() - stat.mtimeMs,
        });
        return null;
      }
    } catch {
      return null;
    }
    return transcriptFileFinal;
  } catch {
    return null;
  }
}

/**
 * Cursor stores agent conversation transcripts as JSONL at:
 *   ~/.cursor/projects/<workspace>/agent-transcripts/<id>/<id>.jsonl
 *
 * Each line: { role: "user"|"assistant", message: { content: [{ type, text }] } }
 *
 * There are no token counts in these files, but we can compute accurate
 * estimates by counting the actual conversation text (much better than
 * the previous chars/4 heuristic that only counted user prompts).
 */
export function discoverCursorTranscript(conversationId?: string, hookCwd?: string, opts: { verbose?: boolean } = {}): CursorTranscriptData | null {
  try {
    // STRICT ID-anchored discovery + staleness guard live in the shared
    // resolver so capturePromptEdits and this token/display parser agree on
    // exactly which file is "the" transcript for this conversation.
    const transcriptFileFinal = findCursorTranscriptJsonl(conversationId);
    if (!transcriptFileFinal) return null;

    // Parse the JSONL
    const raw = fs.readFileSync(transcriptFileFinal, 'utf-8');
    const lines = raw.split('\n').filter(l => l.trim());

    const TRUNC = opts.verbose ? Number.MAX_SAFE_INTEGER : 2000;
    const truncate = (s: string) => s.length > TRUNC ? s.slice(0, TRUNC) + `… [+${s.length - TRUNC} chars]` : s;

    const turns: Array<{ role: string; content: string }> = [];
    let totalInputChars = 0;
    let totalOutputChars = 0;

    for (const line of lines) {
      try {
        const entry = JSON.parse(line);
        const role = entry.role || 'unknown';
        const content = entry.message?.content;

        // Cursor blocks: text, tool_use, tool_result, thinking
        // Pull out everything we can render — text + structured tool I/O —
        // so reviewers see what the agent ran, not just the narration.
        const parts: string[] = [];
        let plainText = '';

        if (typeof content === 'string') {
          plainText = content;
          parts.push(content);
        } else if (Array.isArray(content)) {
          for (const c of content as any[]) {
            const t = c?.type;
            if (t === 'text' && typeof c.text === 'string') {
              plainText += c.text;
              parts.push(c.text);
            } else if (t === 'thinking' && (c.thinking || c.text)) {
              parts.push(`[Reasoning] ${truncate(c.thinking || c.text || '')}`);
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

        // Token estimation uses plain text only (tool I/O isn't billed by Cursor)
        if (role === 'user') {
          totalInputChars += plainText.length;
        } else {
          totalOutputChars += plainText.length;
        }
      } catch {
        // skip malformed lines
      }
    }

    if (turns.length === 0) return null;

    // Token estimation from actual conversation text.
    // ~3.5 chars per token for code-heavy content (better than the old 4.0).
    // Input includes: user prompts + file context sent by Cursor (estimate 3x
    // the visible prompt text for attached files, codebase context, etc.)
    const CHARS_PER_TOKEN = 3.5;
    const CONTEXT_MULTIPLIER = 3;  // Cursor sends ~3x the prompt text as file context
    const visibleInputTokens = Math.round(totalInputChars / CHARS_PER_TOKEN);
    const estimatedInputTokens = visibleInputTokens * CONTEXT_MULTIPLIER;
    const estimatedOutputTokens = Math.round(totalOutputChars / CHARS_PER_TOKEN);
    const totalTokens = estimatedInputTokens + estimatedOutputTokens;

    debugLog('cursor', 'parsed agent transcript', {
      turns: turns.length,
      inputChars: totalInputChars,
      outputChars: totalOutputChars,
      estimatedInputTokens,
      estimatedOutputTokens,
      totalTokens,
    });

    return {
      inputTokens: estimatedInputTokens,
      outputTokens: estimatedOutputTokens,
      tokensUsed: totalTokens,
      transcript: JSON.stringify(turns),
      jsonlPath: transcriptFileFinal,
    };
  } catch (err) {
    debugLog('cursor', 'discoverCursorTranscript error', { error: String(err) });
    return null;
  }
}

