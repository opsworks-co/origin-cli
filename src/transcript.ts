import fs from 'fs';
import os from 'os';
import path from 'path';
import { shouldIgnoreFile } from './ignore-patterns.js';

// ─── Types ─────────────────────────────────────────────────────────────────

interface ContentBlock {
  type: 'text' | 'tool_use' | 'tool_result';
  text?: string;
  name?: string;
  id?: string;
  input?: Record<string, any>;
}

interface MessageUsage {
  input_tokens?: number;
  output_tokens?: number;
  cache_read_input_tokens?: number;
  cache_creation_input_tokens?: number;
}

interface TranscriptLine {
  type: 'user' | 'assistant';
  uuid?: string;
  timestamp?: string;
  message: {
    id?: string;
    role?: string;
    content: string | ContentBlock[];
    usage?: MessageUsage;
    model?: string;
  };
}

export interface ParsedTranscript {
  prompts: string[];
  filesChanged: string[];
  tokensUsed: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  toolCalls: number;
  // Per-tool-name counts (Read, Edit, Bash, Grep, …) — the structured
  // breakdown the server stores so "Tool calls" doesn't depend on
  // re-parsing the display transcript text later.
  toolBreakdown: Array<{ name: string; count: number }>;
  // Files the agent READ (inspected) — distinct from filesChanged.
  filesRead: string[];
  summary: string;
  model: string;
  transcript: string;
}

// Tools that modify files — we extract file paths from these
const FILE_MODIFICATION_TOOLS = new Set([
  // Claude Code
  'Write',
  'Edit',
  'NotebookEdit',
  'mcp__acp__Write',
  'mcp__acp__Edit',
  // Gemini CLI
  'write_file',
  'replace',
  'WriteFile',
  // Codex CLI
  'write',
  'edit',
  'create',
  'apply_diff',
  'insert',
  'patch',
]);

// Read-style tools — we capture the inspected file path from these so the
// "Files read, not changed" view has structured data instead of relying on
// transcript-text markers.
const READ_TOOLS = new Set([
  'Read', 'NotebookRead', 'mcp__acp__Read',
  'read_file', 'ReadFile', 'view', 'cat',
]);

// Pull a file path out of a tool input regardless of which key the agent used.
function toolInputPath(input: any): string | undefined {
  if (!input || typeof input !== 'object') return undefined;
  const fp = input.file_path || input.notebook_path || input.path || input.filepath;
  return typeof fp === 'string' ? fp : undefined;
}

// Build the structured tool fields from accumulated counts + read paths.
function buildToolFields(
  counts: Map<string, number>,
  readSet: Set<string>,
): { toolBreakdown: Array<{ name: string; count: number }>; filesRead: string[] } {
  return {
    toolBreakdown: Array.from(counts.entries())
      .map(([name, count]) => ({ name, count }))
      .sort((a, b) => b.count - a.count),
    filesRead: Array.from(readSet).filter((f) => !shouldIgnoreFile(f)),
  };
}

// ─── Parser ────────────────────────────────────────────────────────────────

export function parseTranscript(transcriptPath: string, opts: { since?: Date | string | null } = {}): ParsedTranscript {
  // Resumed Claude Code sessions write the full conversation history into the
  // new transcript file, so summing every line double-counts the parent
  // session's tokens (we saw cache reads ~200M show up identically on a
  // chained child, inflating cost by ~2×). When `since` is provided, drop
  // entries whose `timestamp` predates it so each session reports only the
  // tokens it actually produced.
  const sinceMs = opts.since
    ? (typeof opts.since === 'string' ? new Date(opts.since) : opts.since).getTime()
    : 0;
  const result: ParsedTranscript = {
    prompts: [],
    filesChanged: [],
    tokensUsed: 0,
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheCreationTokens: 0,
    toolCalls: 0,
    toolBreakdown: [],
    filesRead: [],
    summary: '',
    model: '',
    transcript: '',
  };

  if (!fs.existsSync(transcriptPath)) {
    return result;
  }

  const raw = fs.readFileSync(transcriptPath, 'utf-8');
  result.transcript = raw;

  // Detect format: Gemini uses a single JSON object { "messages": [...] }, Claude/Cursor use JSONL.
  // JSONL also starts with '{' so we can't just check the first char.
  // Instead, try parsing as a single JSON object — if it has a messages/history array, it's Gemini.
  const trimmed = raw.trim();
  if (trimmed.startsWith('{') && !trimmed.includes('\n')) {
    return parseGeminiTranscript(raw, result);
  }
  if (trimmed.startsWith('{')) {
    try {
      const singleObj = JSON.parse(trimmed);
      if (singleObj.messages || singleObj.history) {
        return parseGeminiTranscript(raw, result);
      }
    } catch {
      // Not a single JSON object — fall through to JSONL parsing
    }
  }

  const lines = raw.split('\n').filter((line) => line.trim());

  // Track seen message IDs to deduplicate token usage (streaming can produce duplicates)
  const seenMessageIds = new Map<string, MessageUsage>();
  // Separate dedupe map for Gemini-shape JSONL entries. Gemini CLI
  // writes assistant turns twice with the same `id` and identical
  // `tokens` (stream-finalize double-flush). Without this, tokens
  // & cost double-count.
  type GeminiTokens = { input?: number; output?: number; cached?: number; thoughts?: number };
  const seenGeminiIds = new Map<string, GeminiTokens>();
  const filesSet = new Set<string>();
  const toolCounts = new Map<string, number>();
  const readFilesSet = new Set<string>();

  for (const line of lines) {
    let entry: TranscriptLine;
    try {
      entry = JSON.parse(line);
    } catch {
      continue; // skip malformed lines
    }

    if (sinceMs > 0 && entry.timestamp) {
      const t = Date.parse(entry.timestamp);
      if (Number.isFinite(t) && t < sinceMs) continue;
    }

    // Cursor's JSONL puts the role at the top level (`{"role":"user", ...}`);
    // Claude Code uses `{"type":"user", "message":{...}}` and an older shape
    // nests it as `message.role`. Check all three so one parser handles all.
    const type = entry.type || (entry as any).role || entry.message?.role;

    if (type === 'user') {
      let prompt = extractUserPrompt(entry);
      // Gemini JSONL puts content at the TOP level (`entry.content`)
      // not under `message`. extractUserPrompt only reads
      // `message?.content` — without this fallback every Gemini
      // prompt was dropped from the dashboard.
      if (!prompt && Array.isArray((entry as any).content)) {
        const texts = (entry as any).content
          .filter((b: any) => b && typeof b.text === 'string' && b.text)
          .map((b: any) => b.text)
          .join('\n');
        if (texts) prompt = cleanPrompt(texts);
      } else if (!prompt && typeof (entry as any).content === 'string') {
        prompt = cleanPrompt((entry as any).content);
      }
      if (prompt) {
        result.prompts.push(prompt);
      }
    }

    // Gemini JSONL — `type: "gemini"` (CLI format) or `type: "model"`
    // (Google AI API shape). Tokens + content live at the TOP level,
    // not nested under `message`, so the Anthropic branch above
    // doesn't see them. Cast through string for the comparison
    // because TranscriptLine.type is narrowed to 'user' | 'assistant'.
    const typeAny = type as string;
    if (typeAny === 'gemini' || typeAny === 'model') {
      const e = entry as any;
      const id: string = e.id || '';
      // Gemini CLI versions differ on where they put usage. Two known
      // shapes — accept either:
      //   • Legacy CLI: `tokens: { input, output, cached, thoughts }`
      //   • Newer CLI / Google AI SDK: `usageMetadata: {
      //       promptTokenCount, candidatesTokenCount,
      //       cachedContentTokenCount, thoughtsTokenCount }`
      // Without the SDK fallback every session on a recent Gemini CLI
      // reported absurdly low totals (user-observed: 24h / 8 prompts
      // → 352 total tokens, all from a single legacy-shape entry).
      let tokensAny: GeminiTokens | null = e.tokens || null;
      if (!tokensAny && e.usageMetadata && typeof e.usageMetadata === 'object') {
        const u = e.usageMetadata as Record<string, unknown>;
        const n = (k: string) => (typeof u[k] === 'number' ? (u[k] as number) : 0);
        // Google's `promptTokenCount` is the TOTAL prompt size and already
        // includes `cachedContentTokenCount` (cached tokens are a subset, not
        // additive). Downstream sums `input` into inputTokens and `cached`
        // into cacheReadTokens separately, so subtract the cached portion here
        // to get fresh (non-cached) input — otherwise cached tokens are
        // counted twice, inflating tokensUsed/cost.
        const cached = n('cachedContentTokenCount');
        tokensAny = {
          input: Math.max(0, n('promptTokenCount') - cached),
          output: n('candidatesTokenCount'),
          cached,
          thoughts: n('thoughtsTokenCount'),
        };
      }
      if (tokensAny && (!id || !seenGeminiIds.has(id))) {
        if (id) seenGeminiIds.set(id, tokensAny);
        else {
          // No id — use a synthetic key so the post-loop sum picks
          // it up. Collisions theoretically lose entries but Gemini
          // CLI always emits ids in practice.
          seenGeminiIds.set(`__noid__${seenGeminiIds.size}`, tokensAny);
        }
      }
      // Model name (first one wins, mirroring the Anthropic path)
      if (e.model && !result.model) result.model = e.model;
      // Surface the last assistant text as the session summary so
      // /sessions/:id headers don't render an empty subtitle.
      const c = e.content;
      if (typeof c === 'string' && c) {
        result.summary = c;
      } else if (Array.isArray(c)) {
        for (const part of c) {
          if (part?.text) result.summary = part.text;
          if (part?.functionCall) {
            result.toolCalls++;
            const name = part.functionCall.name || '';
            if (name) toolCounts.set(name, (toolCounts.get(name) || 0) + 1);
            const fp = toolInputPath(part.functionCall.args);
            if (fp && FILE_MODIFICATION_TOOLS.has(name)) filesSet.add(fp);
            if (fp && READ_TOOLS.has(name)) readFilesSet.add(fp);
          }
        }
      }
    }

    if (type === 'assistant') {
      // Extract model name
      if (entry.message?.model && !result.model) {
        result.model = entry.message.model;
      }

      // Process content blocks
      const content = entry.message?.content;
      if (Array.isArray(content)) {
        for (const block of content) {
          // Count tool calls
          if (block.type === 'tool_use') {
            result.toolCalls++;
            const name = block.name || '';
            if (name) toolCounts.set(name, (toolCounts.get(name) || 0) + 1);
            const fp = toolInputPath(block.input);
            // Extract file paths from file modification tools
            if (fp && FILE_MODIFICATION_TOOLS.has(name)) filesSet.add(fp);
            if (fp && READ_TOOLS.has(name)) readFilesSet.add(fp);
          }

          // Track last assistant text as summary
          if (block.type === 'text' && block.text) {
            result.summary = block.text;
          }
        }
      } else if (typeof content === 'string' && content) {
        result.summary = content;
      }

      // Track token usage (deduplicate by message ID — keep highest output_tokens)
      const usage = entry.message?.usage;
      if (usage) {
        const msgId = entry.message?.id || entry.uuid || '';
        const existing = seenMessageIds.get(msgId);
        if (!existing || (usage.output_tokens ?? 0) > (existing.output_tokens ?? 0)) {
          seenMessageIds.set(msgId, usage);
        }
      }
    }
  }

  // Sum deduplicated token usage (track cache tokens separately for accurate cost)
  for (const usage of seenMessageIds.values()) {
    result.inputTokens += usage.input_tokens ?? 0;
    result.cacheReadTokens += usage.cache_read_input_tokens ?? 0;
    result.cacheCreationTokens += usage.cache_creation_input_tokens ?? 0;
    result.outputTokens += usage.output_tokens ?? 0;
  }
  // Same for Gemini JSONL entries — id-deduped, then summed.
  // `thoughts` is billed at the output rate so it folds into
  // outputTokens. `cached` maps to cacheReadTokens (Gemini's
  // implicit cache, 25% of input cost).
  for (const t of seenGeminiIds.values()) {
    result.inputTokens += t.input ?? 0;
    result.outputTokens += (t.output ?? 0) + (t.thoughts ?? 0);
    result.cacheReadTokens += t.cached ?? 0;
  }
  // `tokensUsed` is the "real" fresh-tokens total. Cache reads/creations are
  // tracked on their own fields so they can be reported without inflating the
  // headline number (cache reads are volumetrically huge but charged at 10%).
  result.tokensUsed = result.inputTokens + result.outputTokens;

  // Deduplicated file list, filtered through ignore patterns
  result.filesChanged = Array.from(filesSet).filter(f => !shouldIgnoreFile(f));
  Object.assign(result, buildToolFields(toolCounts, readFilesSet));

  // Truncate summary to 500 chars
  if (result.summary.length > 500) {
    result.summary = result.summary.slice(0, 500) + '...';
  }

  return result;
}

// ─── Helpers ───────────────────────────────────────────────────────────────

function extractUserPrompt(entry: TranscriptLine): string | null {
  const content = entry.message?.content;

  if (typeof content === 'string') {
    return cleanPrompt(content);
  }

  if (Array.isArray(content)) {
    // Find text blocks in content array
    const texts = content
      .filter((b) => b.type === 'text' && b.text)
      .map((b) => b.text!)
      .join('\n');

    if (texts) {
      return cleanPrompt(texts);
    }
  }

  return null;
}

function cleanPrompt(text: string): string | null {
  // Drop entirely if this is our own AGENTS.md / CLAUDE.md echoing back from
  // the agent (Codex reads AGENTS.md natively and bundles it into the first
  // user turn — looked like a real prompt in the dashboard).
  if (text.includes('<!-- origin-managed -->') || /^#\s+AGENTS\.md instructions for /m.test(text)) {
    return null;
  }
  // Strip IDE-injected context tags (like Entire does)
  let cleaned = text
    .replace(/<ide_opened_file>[\s\S]*?<\/ide_opened_file>/g, '')
    .replace(/<ide_selected_text>[\s\S]*?<\/ide_selected_text>/g, '')
    .replace(/<ide_context>[\s\S]*?<\/ide_context>/g, '')
    // Strip Claude Code system reminders and hook feedback
    .replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, '')
    // Strip internal agent tags that leak when prompts overlap with active execution
    .replace(/<task-notification>[\s\S]*?<\/task-notification>/g, '')
    .replace(/<task-id>[\s\S]*?<\/task-id>/g, '')
    .replace(/<tool-use-id>[\s\S]*?<\/tool-use-id>/g, '')
    .replace(/<output-file>[\s\S]*?<\/output-file>/g, '')
    .replace(/<command-name>[\s\S]*?<\/command-name>/g, '')
    // Codex wraps AGENTS.md context in <INSTRUCTIONS>...</INSTRUCTIONS> on
    // its first user turn. Strip the envelope so real text that follows
    // (if any) still makes it through.
    .replace(/<INSTRUCTIONS>[\s\S]*?<\/INSTRUCTIONS>/g, '')
    // Cursor wraps every user prompt in <user_query>...</user_query> in its
    // agent-transcripts JSONL. Without stripping the envelope the dashboard
    // shows literal "<user_query> make little change and commit </user_query>"
    // instead of the user's actual text.
    .replace(/<user_query>([\s\S]*?)<\/user_query>/g, '$1')
    // Cursor prepends a <timestamp>...</timestamp> tag with the local time
    // to every user prompt in its agent-transcripts JSONL. Drop it — the
    // dashboard already shows the prompt's createdAt next to the turn
    // header, surfacing it again inside the prompt body is noise.
    .replace(/<timestamp>[\s\S]*?<\/timestamp>/g, '')
    // Codex's session-init envelope (kept here too as belt-and-suspenders).
    .replace(/<environment_context>[\s\S]*?<\/environment_context>/g, '')
    .replace(/<user_instructions>[\s\S]*?<\/user_instructions>/g, '')
    .trim();

  if (!cleaned) return null;

  // Skip prompts that are purely hook feedback or system messages
  if (isSystemMessage(cleaned)) return null;

  // Truncate very long prompts
  if (cleaned.length > 1000) {
    cleaned = cleaned.slice(0, 1000) + '...';
  }

  return cleaned;
}

/** Detect prompts that are actually system/hook messages, not real user input */
function isSystemMessage(text: string): boolean {
  const systemPatterns = [
    /^Stop hook feedback:/,
    /^Stop:Callback hook blocking error/,
    /^PostToolUse:.*hook/i,
    /^PreToolUse:.*hook/i,
    /^\[Image: original \d+x\d+/,
  ];
  return systemPatterns.some(p => p.test(text.trim()));
}

// ─── Gemini Transcript Parser ──────────────────────────────────────────────

// Gemini CLI transcript format:
// { sessionId, messages: [{ id, timestamp, type: "user"|"gemini", content, tokens?, model?, thoughts? }] }
// - User messages: type: "user", content: [{ text: "..." }]
// - Gemini messages: type: "gemini", content: "string", tokens: { input, output, cached, thoughts, tool, total }, model: "gemini-..."

interface GeminiMessage {
  id?: string;       // present on every entry — used to dedupe re-writes
  type?: string;     // "user" | "gemini" (actual Gemini CLI format)
  role?: string;     // "user" | "model" (Google AI API format — fallback)
  content?: string | Array<{ text?: string; functionCall?: { name: string; args?: Record<string, any> }; functionResponse?: any }>;
  parts?: Array<{ text?: string; functionCall?: { name: string; args?: Record<string, any> }; functionResponse?: any }>;
  tokens?: { input?: number; output?: number; cached?: number; thoughts?: number; tool?: number; total?: number };
  model?: string;
}

function parseGeminiTranscript(raw: string, result: ParsedTranscript): ParsedTranscript {
  try {
    const data = JSON.parse(raw);
    const messages: GeminiMessage[] = data.messages || data.history || [];
    const filesSet = new Set<string>();
    const toolCounts = new Map<string, number>();
    const readFilesSet = new Set<string>();
    // Gemini CLI writes some assistant turns twice with the same `id`
    // and identical `tokens` (looks like a stream-finalize double-flush
    // on its end). Without dedupe we summed both rows and reported
    // ~1.5–2× the real tokens / cost depending on how many turns the
    // session had streaming-then-finalize doubles. Same convention as
    // the Claude path (transcript.ts:123 `seenMessageIds`).
    const seenIds = new Set<string>();

    for (const msg of messages) {
      const msgType = msg.type || msg.role || '';
      const contentParts = msg.content || msg.parts;

      // User messages
      if (msgType === 'user') {
        if (Array.isArray(contentParts)) {
          for (const part of contentParts) {
            if (part.text) {
              const cleaned = cleanPrompt(part.text);
              if (cleaned) result.prompts.push(cleaned);
            }
          }
        } else if (typeof contentParts === 'string') {
          const cleaned = cleanPrompt(contentParts);
          if (cleaned) result.prompts.push(cleaned);
        }
      }

      // Model/Gemini messages
      if (msgType === 'gemini' || msgType === 'model') {
        // Content can be a string (Gemini CLI) or array of parts (Google AI API)
        if (typeof contentParts === 'string') {
          result.summary = contentParts;
        } else if (Array.isArray(contentParts)) {
          for (const part of contentParts) {
            if (part.text) {
              result.summary = part.text;
            }
            if (part.functionCall) {
              result.toolCalls++;
              const name = part.functionCall.name || '';
              if (name) toolCounts.set(name, (toolCounts.get(name) || 0) + 1);
              const fp = toolInputPath(part.functionCall.args);
              if (fp && FILE_MODIFICATION_TOOLS.has(name)) filesSet.add(fp);
              if (fp && READ_TOOLS.has(name)) readFilesSet.add(fp);
            }
          }
        }

        // Extract model name from individual messages
        if (msg.model && !result.model) {
          result.model = msg.model;
        }

        // Token counts per message — guarded by `seenIds` so a
        // duplicate write of the same `id` doesn't double-count.
        // Accepts either the legacy `tokens.{input,output,cached,
        // thoughts}` shape OR the newer Google AI SDK
        // `usageMetadata.{promptTokenCount,candidatesTokenCount,
        // cachedContentTokenCount,thoughtsTokenCount}` shape — see
        // the JSONL path above for why this fallback exists.
        const msgAny = msg as any;
        let t: { input?: number; output?: number; cached?: number; thoughts?: number } | null =
          msgAny.tokens || null;
        if (!t && msgAny.usageMetadata && typeof msgAny.usageMetadata === 'object') {
          const u = msgAny.usageMetadata as Record<string, unknown>;
          const n = (k: string) => (typeof u[k] === 'number' ? (u[k] as number) : 0);
          // `promptTokenCount` is the TOTAL prompt size and already includes
          // `cachedContentTokenCount` (subset, not additive). `input` and
          // `cached` are summed into separate fields downstream, so subtract
          // the cached portion to avoid double-counting it.
          const cached = n('cachedContentTokenCount');
          t = {
            input: Math.max(0, n('promptTokenCount') - cached),
            output: n('candidatesTokenCount'),
            cached,
            thoughts: n('thoughtsTokenCount'),
          };
        }
        if (t && (!msg.id || !seenIds.has(msg.id))) {
          if (msg.id) seenIds.add(msg.id);
          result.inputTokens += t.input ?? 0;
          result.cacheReadTokens += t.cached ?? 0;
          // Gemini 2.5 thinking models report reasoning in `thoughts` — count
          // those as output tokens since they're billed at the output rate.
          result.outputTokens += (t.output ?? 0) + (t.thoughts ?? 0);
        }
      }
    }

    // Fresh tokens only. Cache reads are 90% cheaper and volumetrically
    // huge — rolling them into `tokensUsed` inflated dashboard totals
    // 10x+ (same bug we fixed for Claude transcripts at line 184).
    result.tokensUsed = result.inputTokens + result.outputTokens;
    result.filesChanged = Array.from(filesSet).filter(f => !shouldIgnoreFile(f));
    Object.assign(result, buildToolFields(toolCounts, readFilesSet));
    if (!result.model) result.model = data.model || 'gemini';

    if (result.summary.length > 500) {
      result.summary = result.summary.slice(0, 500) + '...';
    }
  } catch {
    // Failed to parse as Gemini JSON — return empty result
  }

  return result;
}

// ─── Prompt → File Change Mappings ────────────────────────────────────────

export interface PromptFileMapping {
  promptIndex: number;
  promptText: string;       // Truncated to 1000 chars
  filesChanged: string[];   // Files modified after this prompt
  diff: string;             // Unified diff of committed edits from this prompt
  uncommittedDiff?: string; // Unified diff of uncommitted changes from this prompt
  commitSha?: string | null;
  treeSha?: string | null;
  // True when Stop decided this prompt was chat-only (no commits + no
  // transcript-level edits). Prevents downstream retroactive capture from
  // overwriting an intentionally-empty mapping with pre-existing dirty work.
  chatOnly?: boolean;
}

/**
 * Extract prompt-to-file-change mappings from a transcript.
 *
 * Partitions file-modifying tool calls by the preceding user prompt:
 * each user message starts a new "turn", and all file modifications
 * until the next user message are attributed to that prompt.
 */
export function extractPromptFileMappings(transcriptPath: string): PromptFileMapping[] {
  if (!fs.existsSync(transcriptPath)) {
    return [];
  }

  const raw = fs.readFileSync(transcriptPath, 'utf-8');
  const trimmed = raw.trim();

  // Detect format: Gemini uses a single JSON object { "messages": [...] }, Claude/Cursor use JSONL.
  // JSONL also starts with '{' so we can't just check the first char.
  if (trimmed.startsWith('{') && !trimmed.includes('\n')) {
    return extractGeminiPromptMappings(raw);
  }
  if (trimmed.startsWith('{')) {
    try {
      const singleObj = JSON.parse(trimmed);
      if (singleObj.messages || singleObj.history) {
        return extractGeminiPromptMappings(raw);
      }
    } catch {
      // Not a single JSON object — fall through to JSONL parsing
    }
  }

  // Claude/Cursor JSONL format
  const lines = raw.split('\n').filter((line) => line.trim());
  const mappings: PromptFileMapping[] = [];

  let currentPromptIndex = -1;
  let currentPromptText = '';
  let currentFiles = new Set<string>();
  let currentEdits: Array<{ file: string; toolName: string; input: Record<string, any> }> = [];

  for (const line of lines) {
    let entry: TranscriptLine;
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }

    // Cursor's JSONL puts the role at the top level (`{"role":"user", ...}`);
    // Claude Code uses `{"type":"user", "message":{...}}` and an older shape
    // nests it as `message.role`. Check all three so one parser handles all.
    const type = entry.type || (entry as any).role || entry.message?.role;

    if (type === 'user') {
      // In Claude Code JSONL, "user" entries can be:
      //  1. Actual human prompts (string content or text blocks)
      //  2. Tool results (content is [{type:"tool_result",...}]) — NOT real prompts
      // Only start a new turn when we find real human text.
      const prompt = extractUserPrompt(entry);
      if (prompt) {
        // Save previous mapping if it has files
        if (currentPromptIndex >= 0) {
          mappings.push({
            promptIndex: currentPromptIndex,
            promptText: currentPromptText,
            filesChanged: Array.from(currentFiles),
            diff: buildDiffFromEdits(currentEdits),
          });
        }

        // Start new turn
        currentPromptIndex++;
        currentPromptText = prompt.slice(0, 1000);
        currentFiles = new Set<string>();
        currentEdits = [];
      }
      // If no prompt text (tool_result entry), continue accumulating files in current turn
    }

    if (type === 'assistant') {
      // If assistant work appears before we've seen any user prompt (e.g.
      // transcript starts mid-session with a tool_result), synthesise
      // prompt-index 0 so file edits don't get discarded under a phantom
      // -1 bucket. The session/start prompt list still drives the UI
      // turn labels; this just makes sure files attach SOMEWHERE.
      if (currentPromptIndex < 0) {
        currentPromptIndex = 0;
        currentPromptText = currentPromptText || '';
      }
      const content = entry.message?.content;
      if (Array.isArray(content)) {
        for (const block of content) {
          if (block.type === 'tool_use' && block.name && FILE_MODIFICATION_TOOLS.has(block.name) && block.input) {
            const filePath = block.input.file_path || block.input.notebook_path || block.input.path;
            if (filePath && typeof filePath === 'string') {
              currentFiles.add(filePath);
              currentEdits.push({ file: filePath, toolName: block.name, input: block.input });
            }
          }
        }
      }
    }
  }

  // Push final mapping
  if (currentPromptIndex >= 0) {
    mappings.push({
      promptIndex: currentPromptIndex,
      promptText: currentPromptText,
      filesChanged: Array.from(currentFiles),
      diff: buildDiffFromEdits(currentEdits),
    });
  }

  // Don't filter out prompts with zero files — conversational turns are
  // valid data; the UI can show "No files modified" rather than hiding
  // the turn entirely. Previously filtering made the UI look empty for
  // tiny sessions where Claude replied without editing files.
  return mappings;
}

/**
 * Build a unified-diff-like string from Edit/Write tool call data.
 * For Edit calls: shows old_string → new_string as unified diff hunks.
 * For Write calls: shows file as created/rewritten (first 20 lines).
 * Truncates to 100KB max to keep database size reasonable.
 */
// Line-level LCS diff between two strings. Returns a sequence of ops the
// caller emits as ` `/`+`/`-` lines. Without this, buildDiffFromEdits dumped
// the WHOLE old_string as `-` lines and the WHOLE new_string as `+` lines,
// so a 2-line insertion inside a 3-line function got rendered as `-3 +5`
// (the surrounding lines re-appeared on both sides even though they didn't
// change). The dashboard then displayed the wrong line counts and rewrote
// the whole hunk in the per-prompt diff view.
//
// Bounded at 4000 lines per side — DP is O(m*n), and edit blocks past
// that size are usually file rewrites where the previous "dump both"
// representation is more useful than a multi-megabyte DP table.
function lineLevelDiff(
  oldLines: string[],
  newLines: string[],
): Array<{ type: 'context' | 'add' | 'remove'; line: string }> {
  const MAX = 4_000;
  if (oldLines.length > MAX || newLines.length > MAX) {
    return [
      ...oldLines.map((l) => ({ type: 'remove' as const, line: l })),
      ...newLines.map((l) => ({ type: 'add' as const, line: l })),
    ];
  }
  const m = oldLines.length;
  const n = newLines.length;
  // dp[i][j] = LCS length of oldLines[i..] and newLines[j..]
  const dp: number[][] = Array.from({ length: m + 1 }, () =>
    new Array(n + 1).fill(0),
  );
  for (let i = m - 1; i >= 0; i--) {
    for (let j = n - 1; j >= 0; j--) {
      if (oldLines[i] === newLines[j]) dp[i][j] = dp[i + 1][j + 1] + 1;
      else dp[i][j] = Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }
  const ops: Array<{ type: 'context' | 'add' | 'remove'; line: string }> = [];
  let i = 0;
  let j = 0;
  while (i < m && j < n) {
    if (oldLines[i] === newLines[j]) {
      ops.push({ type: 'context', line: oldLines[i] });
      i++;
      j++;
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      ops.push({ type: 'remove', line: oldLines[i] });
      i++;
    } else {
      ops.push({ type: 'add', line: newLines[j] });
      j++;
    }
  }
  while (i < m) ops.push({ type: 'remove', line: oldLines[i++] });
  while (j < n) ops.push({ type: 'add', line: newLines[j++] });
  return ops;
}

function buildDiffFromEdits(edits: Array<{ file: string; toolName: string; input: Record<string, any> }>): string {
  if (edits.length === 0) return '';

  const MAX_DIFF_SIZE = 100_000; // 100KB limit
  const parts: string[] = [];

  // Group edits by file to produce cleaner output
  const byFile = new Map<string, Array<{ toolName: string; input: Record<string, any> }>>();
  for (const edit of edits) {
    const existing = byFile.get(edit.file) || [];
    existing.push({ toolName: edit.toolName, input: edit.input });
    byFile.set(edit.file, existing);
  }

  for (const [filePath, fileEdits] of byFile) {
    const shortPath = shortenFilePath(filePath);
    parts.push(`diff --git a/${shortPath} b/${shortPath}`);

    for (const edit of fileEdits) {
      if (edit.toolName === 'Edit' || edit.toolName === 'mcp__acp__Edit' || edit.toolName === 'replace' || edit.toolName === 'edit') {
        const oldStr = edit.input.old_string || '';
        const newStr = edit.input.new_string || '';
        if (oldStr || newStr) {
          parts.push(`--- a/${shortPath}`);
          parts.push(`+++ b/${shortPath}`);
          parts.push('@@ @@');
          // LCS-based line diff so unchanged lines surrounding the actual
          // edit emit as ` ` context, not `-`/`+`. Matches what `git diff`
          // would have produced on the file pair.
          for (const op of lineLevelDiff(oldStr.split('\n'), newStr.split('\n'))) {
            const prefix = op.type === 'add' ? '+' : op.type === 'remove' ? '-' : ' ';
            parts.push(`${prefix}${op.line}`);
          }
        }
      } else if (edit.toolName === 'Write' || edit.toolName === 'mcp__acp__Write' || edit.toolName === 'write_file' || edit.toolName === 'WriteFile' || edit.toolName === 'write' || edit.toolName === 'create') {
        const content = edit.input.content || '';
        parts.push(`--- /dev/null`);
        parts.push(`+++ b/${shortPath}`);
        parts.push('@@ @@');
        // Show first 30 lines of new file content
        const contentLines = content.split('\n');
        const showLines = contentLines.slice(0, 30);
        for (const line of showLines) {
          parts.push(`+${line}`);
        }
        if (contentLines.length > 30) {
          parts.push(`+... (${contentLines.length - 30} more lines)`);
        }
      }
    }
  }

  let result = parts.join('\n');
  if (result.length > MAX_DIFF_SIZE) {
    result = result.slice(0, MAX_DIFF_SIZE) + '\n... (diff truncated)';
  }
  return result;
}

function shortenFilePath(filePath: string): string {
  // Strip common home directory prefixes to keep paths readable
  const home = '/Users/';
  const idx = filePath.indexOf(home);
  if (idx >= 0) {
    const afterHome = filePath.slice(idx + home.length);
    // Find the third slash to get user/project/rest
    const parts = afterHome.split('/');
    if (parts.length > 3) {
      return parts.slice(1).join('/'); // Drop username
    }
  }
  return filePath;
}

function extractGeminiPromptMappings(raw: string): PromptFileMapping[] {
  try {
    const data = JSON.parse(raw);
    const messages: GeminiMessage[] = data.messages || data.history || [];
    const mappings: PromptFileMapping[] = [];

    let currentPromptIndex = -1;
    let currentPromptText = '';
    let currentFiles = new Set<string>();
    let currentEdits: Array<{ file: string; toolName: string; input: Record<string, any> }> = [];

    for (const msg of messages) {
      if (msg.role === 'user' && msg.parts) {
        // Save previous mapping
        if (currentPromptIndex >= 0) {
          mappings.push({
            promptIndex: currentPromptIndex,
            promptText: currentPromptText,
            filesChanged: Array.from(currentFiles),
            diff: buildDiffFromEdits(currentEdits),
          });
        }

        currentPromptIndex++;
        const texts = msg.parts.filter((p) => p.text).map((p) => p.text!).join('\n');
        const cleaned = cleanPrompt(texts);
        currentPromptText = (cleaned || '').slice(0, 1000);
        currentFiles = new Set<string>();
        currentEdits = [];
      }

      if (msg.role === 'model' && msg.parts && currentPromptIndex >= 0) {
        for (const part of msg.parts) {
          if (part.functionCall) {
            const name = part.functionCall.name || '';
            if (FILE_MODIFICATION_TOOLS.has(name) && part.functionCall.args) {
              const fp = part.functionCall.args.file_path || part.functionCall.args.path;
              if (fp && typeof fp === 'string') {
                currentFiles.add(fp);
                currentEdits.push({ file: fp, toolName: name, input: part.functionCall.args || {} });
              }
            }
          }
        }
      }
    }

    // Push final mapping
    if (currentPromptIndex >= 0) {
      mappings.push({
        promptIndex: currentPromptIndex,
        promptText: currentPromptText,
        filesChanged: Array.from(currentFiles),
        diff: buildDiffFromEdits(currentEdits),
      });
    }

    return mappings.filter((m) => m.filesChanged.length > 0);
  } catch {
    return [];
  }
}

// ─── Transcript Formatter (for dashboard display) ────────────────────────

export interface DisplayMessage {
  role: 'user' | 'assistant';
  content: string;
}

/**
 * Convert raw transcript (JSONL or Gemini JSON) into a JSON string of
 * [{role, content}, ...] messages suitable for the web dashboard.
 *
 * Strips tool_use/tool_result blocks, keeps only human-readable text.
 * Returns a JSON string ready to store in the database, or '' if empty.
 */
/**
 * Options for formatting a transcript for dashboard display.
 *
 * `verbose` was added by recent hook handlers (call sites in commands/hooks.ts
 * pass `{ verbose: !!state.verboseCapture }`) but the implementation was never
 * landed — calls broke the production tsc build because the function only
 * accepted a single argument. Accept the option here so the build stays green;
 * actual verbose-mode formatting (richer tool-call detail, raw payloads, etc.)
 * is a follow-up — see issue tracker.
 */
export interface FormatTranscriptOptions {
  verbose?: boolean;
}

export function formatTranscriptForDisplay(
  transcriptPath: string,
  options?: FormatTranscriptOptions,
): string {
  if (!fs.existsSync(transcriptPath)) {
    return '';
  }

  const raw = fs.readFileSync(transcriptPath, 'utf-8');
  const trimmed = raw.trim();
  if (!trimmed) return '';

  const verbose = !!options?.verbose;
  let messages: DisplayMessage[] = [];

  // Detect format:
  //  - Gemini CLI's `~/.gemini/tmp/<proj>/chats/session-*.jsonl` — JSONL
  //    where each line is `{"type":"user|gemini|info|tool", "content":...}`
  //    or a `{"$set":...}` metadata update. Detected by sampling for
  //    `"type":"gemini"` or `"type":"user","content":[{"text"`.
  //  - Gemini (single JSON with messages/history) — older shape.
  //  - Claude JSONL — fallback.
  const firstLines = trimmed.split('\n', 5).join('\n');
  const looksLikeGeminiChatsJsonl =
    /\n?\{[^\n]*"type"\s*:\s*"(gemini|user|model|tool)"/.test(firstLines) ||
    /\{[^\n]*"\$set"\s*:/.test(firstLines);
  if (looksLikeGeminiChatsJsonl) {
    messages = formatGeminiChatsJsonl(raw, verbose);
  } else if (trimmed.startsWith('{') && !trimmed.includes('\n')) {
    messages = formatGeminiMessages(raw, verbose);
  } else if (trimmed.startsWith('{')) {
    try {
      const singleObj = JSON.parse(trimmed);
      if (singleObj.messages || singleObj.history) {
        messages = formatGeminiMessages(raw, verbose);
      } else {
        messages = formatJSONLMessages(raw, verbose);
      }
    } catch {
      messages = formatJSONLMessages(raw, verbose);
    }
  } else {
    messages = formatJSONLMessages(raw, verbose);
  }

  if (messages.length === 0) return '';

  return JSON.stringify(messages);
}

// Cap each tool arg/output blob so a single huge Read() doesn't bloat the
// upload — verbose mode keeps the full payload.
function makeTruncator(verbose: boolean): (s: string) => string {
  const max = verbose ? Number.MAX_SAFE_INTEGER : 2000;
  return (s: string) => (s.length > max ? s.slice(0, max) + `… [+${s.length - max} chars]` : s);
}

function serializeToolInput(input: Record<string, any>): string {
  // Prefer human-readable single-field commands (Bash/Read/Edit) before
  // falling back to a JSON dump of arbitrary tool args.
  if (typeof input.command === 'string') return input.command;
  if (typeof input.cmd === 'string') return input.cmd;
  if (input.file_path && (typeof input.old_string === 'string' || typeof input.new_string === 'string')) {
    // Edit tool — show the diff-style input
    const parts: string[] = [`file: ${input.file_path}`];
    if (typeof input.old_string === 'string') parts.push(`--- old\n${input.old_string}`);
    if (typeof input.new_string === 'string') parts.push(`+++ new\n${input.new_string}`);
    return parts.join('\n');
  }
  if (input.file_path && typeof input.content === 'string') {
    return `file: ${input.file_path}\n${input.content}`;
  }
  if (typeof input.file_path === 'string') return input.file_path;
  if (typeof input.path === 'string') return input.path;
  if (typeof input.notebook_path === 'string') return input.notebook_path;
  if (typeof input.pattern === 'string') return input.pattern;
  if (typeof input.url === 'string') return input.url;
  if (typeof input.query === 'string') return input.query;
  if (typeof input.prompt === 'string') return input.prompt;
  try { return JSON.stringify(input, null, 2); } catch { return ''; }
}

function serializeToolResult(content: any): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((b: any) => {
        if (typeof b === 'string') return b;
        if (b?.type === 'text' && typeof b.text === 'string') return b.text;
        if (typeof b?.text === 'string') return b.text;
        if (typeof b?.content === 'string') return b.content;
        return '';
      })
      .filter(Boolean)
      .join('\n');
  }
  if (content && typeof content === 'object' && typeof content.text === 'string') return content.text;
  try { return JSON.stringify(content, null, 2); } catch { return ''; }
}

function formatJSONLMessages(raw: string, verbose: boolean): DisplayMessage[] {
  const lines = raw.split('\n').filter((line) => line.trim());
  const messages: DisplayMessage[] = [];
  const truncate = makeTruncator(verbose);

  // First pass: collect tool_result blocks keyed by tool_use_id so we can
  // attach them inline with the corresponding [Tool: ...] line in the next
  // assistant message (Claude Code emits these as separate user-role entries).
  const resultByToolUseId = new Map<string, string>();
  for (const line of lines) {
    try {
      const entry = JSON.parse(line);
      const content = entry.message?.content;
      if (!Array.isArray(content)) continue;
      for (const block of content) {
        if (block?.type === 'tool_result' && typeof block.tool_use_id === 'string') {
          const text = serializeToolResult(block.content);
          if (text) resultByToolUseId.set(block.tool_use_id, text);
        }
      }
    } catch { /* ignore */ }
  }

  for (const line of lines) {
    let entry: TranscriptLine;
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }

    // Cursor's JSONL puts the role at the top level (`{"role":"user", ...}`);
    // Claude Code uses `{"type":"user", "message":{...}}` and an older shape
    // nests it as `message.role`. Check all three so one parser handles all.
    const type = entry.type || (entry as any).role || entry.message?.role;

    if (type === 'user') {
      const prompt = extractUserPrompt(entry);
      if (prompt) {
        messages.push({ role: 'user', content: prompt });
      }
    }

    if (type === 'assistant') {
      const content = entry.message?.content;
      let text = '';

      if (typeof content === 'string' && content) {
        text = content;
      } else if (Array.isArray(content)) {
        const parts: string[] = [];
        for (const block of content as any[]) {
          if (block.type === 'text' && block.text) {
            parts.push(block.text);
          } else if (block.type === 'thinking' && (block.thinking || block.text)) {
            // Claude extended thinking — render as a [Reasoning] block so the
            // web formatter highlights it separately from actions.
            const thoughtText = block.thinking || block.text || '';
            parts.push(`[Reasoning] ${truncate(thoughtText)}`);
          } else if (block.type === 'tool_use' && block.name) {
            const input = block.input || {};
            const argStr = serializeToolInput(input);
            // Keep the marker on its own line so the web formatter can group
            // [Tool: ...] + args + [Output] cleanly.
            parts.push(`[Tool: ${block.name}]`);
            if (argStr) parts.push(truncate(argStr));
            // Inline the matching tool_result if we found one.
            const resultText = block.id ? resultByToolUseId.get(block.id) : undefined;
            if (resultText) {
              parts.push(`[Output] ${truncate(resultText)}`);
            }
          }
        }
        text = parts.join('\n');
      }

      if (text.trim()) {
        const last = messages[messages.length - 1];
        if (last && last.role === 'assistant') {
          last.content += '\n\n' + text;
        } else {
          messages.push({ role: 'assistant', content: text });
        }
      }
    }
  }

  return messages;
}

/**
 * Format Gemini CLI's per-session chats JSONL transcript (the file at
 * `~/.gemini/tmp/<project-hash>/chats/session-*.jsonl`).
 *
 * Each line is a JSON object. We care about:
 *   {"type":"user","content":[{"text":"..."}]}
 *   {"type":"gemini","content":"<reply>","thoughts":[...],"toolCalls":[...]}
 *   {"type":"tool","content":[{"functionResponse":{...}}]}
 *   {"type":"info","content":"..."}    ← system messages, skip unless verbose
 *   {"$set":{...}}                      ← metadata, skip
 *
 * The same logical assistant turn often appears twice (a "thinking only"
 * row at id X, then an updated row at the same id with content +
 * toolCalls). We dedupe by id, keeping the row with the most data.
 */
function formatGeminiChatsJsonl(raw: string, verbose: boolean): DisplayMessage[] {
  const lines = raw.split('\n').filter(l => l.trim());
  const truncate = makeTruncator(verbose);
  // Dedupe assistant rows by id, keeping the one with the richest content.
  const byId = new Map<string, any>();
  const ordered: Array<{ id?: string; row: any }> = [];

  for (const line of lines) {
    let obj: any;
    try { obj = JSON.parse(line); } catch { continue; }
    if (!obj || typeof obj !== 'object') continue;
    if (obj.$set) continue; // metadata-only
    const type = obj.type;
    if (!type) continue;
    if (type === 'info' && !verbose) continue;
    const id = typeof obj.id === 'string' ? obj.id : undefined;
    if (id) {
      const prev = byId.get(id);
      const score = (o: any) =>
        ((o.content && o.content.length > 0) ? 1 : 0) +
        (Array.isArray(o.toolCalls) ? o.toolCalls.length * 2 : 0) +
        (Array.isArray(o.thoughts) ? 1 : 0);
      if (!prev || score(obj) > score(prev)) {
        byId.set(id, obj);
      }
      if (!prev) ordered.push({ id, row: obj });
    } else {
      ordered.push({ row: obj });
    }
  }

  const messages: DisplayMessage[] = [];
  for (const { id, row: original } of ordered) {
    const row = id ? byId.get(id) : original;
    if (!row) continue;
    const type = row.type;

    if (type === 'user') {
      const content = row.content;
      let text = '';
      if (Array.isArray(content)) {
        text = content
          .map((p: any) => (typeof p === 'string' ? p : (p?.text || '')))
          .filter(Boolean)
          .join('\n');
      } else if (typeof content === 'string') {
        text = content;
      }
      const cleaned = cleanPrompt(text);
      if (cleaned) messages.push({ role: 'user', content: cleaned });
      continue;
    }

    if (type === 'gemini' || type === 'model') {
      const parts: string[] = [];
      // Reasoning summaries
      if (Array.isArray(row.thoughts) && row.thoughts.length > 0) {
        const thoughtText = row.thoughts
          .map((t: any) => {
            if (typeof t === 'string') return t;
            const subject = typeof t?.subject === 'string' ? t.subject : '';
            const desc = typeof t?.description === 'string' ? t.description : '';
            return subject && desc ? `${subject}: ${desc}` : (subject || desc);
          })
          .filter(Boolean)
          .join('\n');
        if (thoughtText) parts.push(`[Reasoning] ${truncate(thoughtText)}`);
      }
      // Main response text
      if (typeof row.content === 'string' && row.content.trim()) {
        parts.push(row.content);
      }
      // Tool calls
      if (Array.isArray(row.toolCalls)) {
        for (const tc of row.toolCalls) {
          const name = tc?.name || tc?.functionCall?.name || 'tool';
          const args = tc?.args || tc?.functionCall?.args || {};
          parts.push(`[Tool: ${name}]`);
          const argStr = serializeToolInput(args || {});
          if (argStr) parts.push(truncate(argStr));
        }
      }
      if (parts.length > 0) {
        messages.push({ role: 'assistant', content: parts.join('\n') });
      }
      continue;
    }

    if (type === 'tool' || type === 'function') {
      const content = row.content;
      let outText = '';
      if (typeof content === 'string') outText = content;
      else if (Array.isArray(content)) {
        const buf: string[] = [];
        for (const p of content) {
          if (p?.functionResponse) {
            const resp = p.functionResponse.response ?? p.functionResponse.output ?? p.functionResponse;
            buf.push(typeof resp === 'string' ? resp : (() => { try { return JSON.stringify(resp, null, 2); } catch { return ''; } })());
          } else if (typeof p?.text === 'string') {
            buf.push(p.text);
          }
        }
        outText = buf.join('\n');
      }
      if (outText.trim()) {
        const formatted = `[Output] ${truncate(outText)}`;
        const last = messages[messages.length - 1];
        if (last && last.role === 'assistant') last.content += '\n' + formatted;
        else messages.push({ role: 'assistant', content: formatted });
      }
      continue;
    }

    if (type === 'info' && verbose) {
      const text = typeof row.content === 'string' ? row.content : '';
      // DisplayMessage doesn't have a system role; surface as assistant.
      if (text.trim()) messages.push({ role: 'assistant', content: `[System] ${truncate(text)}` });
    }
  }

  return messages;
}

function formatGeminiMessages(raw: string, verbose: boolean): DisplayMessage[] {
  try {
    const data = JSON.parse(raw);
    const msgs: GeminiMessage[] = data.messages || data.history || [];
    const messages: DisplayMessage[] = [];
    const truncate = makeTruncator(verbose);

    for (const msg of msgs) {
      const msgType = msg.type || msg.role || '';
      const contentParts = msg.content || msg.parts;

      if (msgType === 'user') {
        if (Array.isArray(contentParts)) {
          const texts = contentParts.filter((p: any) => p.text).map((p: any) => p.text!).join('\n');
          const cleaned = cleanPrompt(texts);
          if (cleaned) {
            messages.push({ role: 'user', content: cleaned });
          }
        } else if (typeof contentParts === 'string') {
          const cleaned = cleanPrompt(contentParts);
          if (cleaned) {
            messages.push({ role: 'user', content: cleaned });
          }
        }
        continue;
      }

      // Gemini's tool responses come back as `tool` or `function` role
      // messages — surface those as [Output] blocks so they pair with the
      // preceding [Tool: ...] line.
      if (msgType === 'tool' || msgType === 'function') {
        const responseText = (() => {
          if (typeof contentParts === 'string') return contentParts;
          if (!Array.isArray(contentParts)) return '';
          const out: string[] = [];
          for (const p of contentParts as any[]) {
            if (p?.functionResponse) {
              const resp = p.functionResponse.response ?? p.functionResponse.output ?? p.functionResponse;
              if (typeof resp === 'string') out.push(resp);
              else { try { out.push(JSON.stringify(resp, null, 2)); } catch { /* ignore */ } }
            } else if (typeof p?.text === 'string') {
              out.push(p.text);
            }
          }
          return out.join('\n');
        })();
        if (responseText.trim()) {
          const last = messages[messages.length - 1];
          const formatted = `[Output] ${truncate(responseText)}`;
          if (last && last.role === 'assistant') {
            last.content += '\n' + formatted;
          } else {
            messages.push({ role: 'assistant', content: formatted });
          }
        }
        continue;
      }

      if (msgType === 'gemini' || msgType === 'model') {
        if (typeof contentParts === 'string') {
          if (contentParts.trim()) {
            messages.push({ role: 'assistant', content: contentParts });
          }
        } else if (Array.isArray(contentParts)) {
          const parts: string[] = [];
          for (const part of contentParts as any[]) {
            // Reasoning takes priority over text — Gemini emits two shapes:
            //   {thought: true, text: "..."}             ← Google AI spec
            //   {thought: "string", text?: "..."}        ← Gemini CLI verbose log
            //   {thought: true, thoughtSignature: "..."} ← thinking summary
            // Without this branch, thought-only parts were silently dropped
            // and {thought:true,text:...} parts were emitted as plain text.
            const thoughtText =
              typeof part.thought === 'string' ? part.thought :
              part.thought === true ? (part.text || part.thoughtSummary || '') :
              '';
            if (thoughtText) {
              parts.push(`[Reasoning] ${truncate(thoughtText)}`);
            } else if (part.text) {
              parts.push(part.text);
            } else if (part.functionCall) {
              const args = part.functionCall.args || {};
              const argStr = serializeToolInput(args);
              parts.push(`[Tool: ${part.functionCall.name}]`);
              if (argStr) parts.push(truncate(argStr));
            } else if (part.functionResponse) {
              // Sometimes function responses are inlined in the same model
              // turn — surface them inline as [Output] too.
              const resp = part.functionResponse.response ?? part.functionResponse.output ?? part.functionResponse;
              const respStr = typeof resp === 'string' ? resp : (() => { try { return JSON.stringify(resp, null, 2); } catch { return ''; } })();
              if (respStr) parts.push(`[Output] ${truncate(respStr)}`);
            }
          }
          const text = parts.join('\n');
          if (text.trim()) {
            messages.push({ role: 'assistant', content: text });
          }
        }
      }
    }

    return messages;
  } catch {
    return [];
  }
}

// ─── Cost Estimation ───────────────────────────────────────────────────────

// Pricing per 1M tokens (input, output)
// Cache read = input × 0.1 (90% discount), cache creation = input × 1.25 (25% premium)
// Optional `cachedInput` overrides the provider's default cache-read
// multiplier when a model uses a non-standard discount (e.g. gpt-5.5's
// 90% cache discount vs the rest of OpenAI's 50%). Mirrors
// apps/api/src/utils/pricing.ts.
export type ModelPricing = Record<string, {
  input: number;
  output: number;
  cachedInput?: number;
}>;

const DEFAULT_MODEL_PRICING: ModelPricing = {
  // Anthropic — verified against https://www.anthropic.com/pricing on 2026-04-24.
  // Cache reads are billed at 10% of input; cache writes at 125% (handled in
  // estimateCost below). Per-1M-token rates in USD.
  // NOTE: keep this table in sync with packages/cli/src/commands/prompt-status.ts
  // until both are consolidated into a single pricing module.
  // bare "claude" brand (CLI fallback when real model unknown) → current Opus
  // default. Claude Code defaults to Opus — using Sonnet here slashed
  // recomputed costs of Opus sessions.
  //
  // Opus pricing is per-generation: Opus 4.5/4.6/4.7/4.8 are $5/$25; only
  // Opus 4.1 and older were $15/$75. The bare 'opus' key carries the
  // current-generation rate; legacy generations get explicit keys that win
  // the longest-substring match. Known gap: "claude-opus-4" (Opus 4.0,
  // retired June 2026) falls to the modern 'opus' rate — a "claude-opus-4"
  // key can't be used because it substring-matches every claude-opus-4-x ID
  // before the shorter modern keys.
  //
  // Haiku pricing is also per-generation: Haiku 4.5 is $1/$5; Haiku 3.5/4.0
  // were $0.80/$4. Unlike Opus, the bare 'haiku' key keeps the legacy rate
  // (most stored Haiku sessions predate 4.5) and the newer generation gets
  // the explicit 'haiku-4-5' key, which is longer than 'haiku' so it wins
  // the longest-substring match for "claude-haiku-4-5*" IDs. Known gap:
  // "claude-3-haiku" ($0.25/$1.25) also falls to the 'haiku' rate.
  'claude':    { input: 5,    output: 25 },  // bare brand → current Opus default
  'sonnet':    { input: 3,    output: 15 },
  'opus':      { input: 5,    output: 25 },  // Opus 4.5+
  'opus-4-1':  { input: 15,   output: 75 },  // legacy Opus 4.1
  '3-opus':    { input: 15,   output: 75 },  // legacy Claude 3 Opus
  'fable':     { input: 10,   output: 50 },  // Claude Fable 5
  'haiku':     { input: 0.80, output: 4  },  // legacy Haiku 3.5 / 4.0
  'haiku-4-5': { input: 1.00, output: 5  },  // Haiku 4.5
  // Google — pricing per 1M tokens (≤200K context tier where two tiers exist)
  'gemini-2.5-pro': { input: 1.25, output: 10 },
  'gemini-2.5-flash': { input: 0.30, output: 2.50 },      // was 0.15/3.50 — wrong
  'gemini-2.5-flash-lite': { input: 0.10, output: 0.40 },
  'gemini-3-pro': { input: 1.25, output: 10 },
  'gemini-3-flash': { input: 0.15, output: 0.60 },
  'gemini-3.5-pro': { input: 1.25, output: 10 },    // Antigravity flagship
  'gemini-3.5-flash': { input: 0.15, output: 0.60 }, // Antigravity default
  'gemini-2.0-flash': { input: 0.10, output: 0.40 },
  'gemini-2.0': { input: 0.10, output: 0.40 },
  // OpenAI (for Cursor users)
  'gpt-4o': { input: 2.50, output: 10 },
  'gpt-4o-mini': { input: 0.15, output: 0.60 },
  'o1': { input: 15, output: 60 },
  'o3': { input: 10, output: 40 },
  'o3-mini': { input: 1.10, output: 4.40 },
  'o4-mini': { input: 1.10, output: 4.40 },
  // OpenAI GPT-5 / Codex. gpt-5.5 has an explicit cachedInput rate
  // because its 90% cache discount doesn't match the OpenAI family
  // default of 50% (see estimateCost). Mirrors apps/api/src/utils/pricing.ts.
  'gpt-5':       { input: 2.00,  output: 8.00 },
  'gpt-5.3':     { input: 2.00,  output: 8.00 },
  'gpt-5.4':     { input: 3.00,  output: 12.00 },
  'gpt-5.5':     { input: 5.00,  output: 30.00, cachedInput: 0.50 },
  'gpt-5.5-pro': { input: 30.00, output: 180.00 },
  //   gpt-5.6 (GA 2026-07-09) — 3 tiers Sol/Terra/Luna, 90%-off cached input.
  //   Plain "gpt-5.6" = Sol (flagship), same rates as 5.5, per the
  //   plain-key = flagship convention (Codex's default). The tier keys win the
  //   longest-substring match for "gpt-5.6-terra" / "gpt-5.6-luna".
  'gpt-5.6':       { input: 5.00,  output: 30.00,  cachedInput: 0.50 },
  'gpt-5.6-terra': { input: 2.50,  output: 15.00,  cachedInput: 0.25 },
  'gpt-5.6-luna':  { input: 1.00,  output: 6.00,   cachedInput: 0.10 },
  'codex':       { input: 2.00,  output: 8.00 },
  // Cursor — default to sonnet pricing since most Cursor users are on claude-sonnet-4.
  // If getCursorModelFromDb resolves the real model, estimateCost will match a more
  // specific key (e.g. "gpt-4o") instead.
  'cursor': { input: 3, output: 15 },
  'composer': { input: 2.50, output: 10.00 },
};

// ── Dynamic pricing: API-served, disk-cached, defaults as fallback ──────────
//
// session-start fetches GET /api/pricing and calls setActivePricing — but
// every hook runs as a SEPARATE process, so a module-global alone only ever
// helped the session-start process. estimateCost actually runs in the
// stop/session-end processes, which never fetched → they silently used the
// baked-in table and the "dynamic pricing" was inert where it mattered.
//
// setActivePricing therefore persists the fetched table to
// ~/.origin/pricing.json, and every process lazily loads that cache (merged
// OVER the baked-in defaults, so models added in a newer CLI build survive an
// older cached table). Stale (>7d) or corrupt caches are ignored — the
// baked-in DEFAULT_MODEL_PRICING remains the offline floor, and the CI parity
// test (CLI ↔ API tables) keeps that floor honest.
const PRICING_CACHE_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

function pricingCachePath(): string {
  return path.join(os.homedir(), '.origin', 'pricing.json');
}

function loadCachedPricing(): ModelPricing | null {
  try {
    const raw = JSON.parse(fs.readFileSync(pricingCachePath(), 'utf-8'));
    if (!raw || typeof raw !== 'object' || typeof raw.fetchedAt !== 'string') return null;
    if (Date.now() - new Date(raw.fetchedAt).getTime() > PRICING_CACHE_MAX_AGE_MS) return null;
    if (!raw.pricing || typeof raw.pricing !== 'object') return null;
    return raw.pricing as ModelPricing;
  } catch {
    return null; // missing / corrupt — defaults apply
  }
}

let activePricing: ModelPricing | null = null; // resolved lazily per process

function ensurePricingLoaded(): ModelPricing {
  if (activePricing) return activePricing;
  const cached = loadCachedPricing();
  activePricing = cached ? { ...DEFAULT_MODEL_PRICING, ...cached } : DEFAULT_MODEL_PRICING;
  return activePricing;
}

export function setActivePricing(pricing: ModelPricing): void {
  activePricing = { ...DEFAULT_MODEL_PRICING, ...pricing };
  try {
    const dir = path.dirname(pricingCachePath());
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      pricingCachePath(),
      JSON.stringify({ fetchedAt: new Date().toISOString(), pricing }),
      { mode: 0o600 },
    );
  } catch {
    // Cache write is best-effort — this process still has the table in memory.
  }
}

export function getActivePricing(): ModelPricing {
  return ensurePricingLoaded();
}

export function getDefaultPricing(): ModelPricing {
  return { ...DEFAULT_MODEL_PRICING };
}

// Strip date/version suffixes so "claude-sonnet-4-5-20250929" → "claude-sonnet-4-5"
// and "gpt-4o-mini-2024-07-18" → "gpt-4o-mini". Keeps lookups deterministic.
function normalizeModelKey(model: string): string {
  return (model || '')
    .toLowerCase()
    .replace(/-\d{4}-\d{2}-\d{2}$/, '')   // OpenAI: gpt-4o-mini-2024-07-18
    .replace(/-\d{8}$/, '');               // Anthropic: claude-sonnet-4-5-20250929
}

// Bare-brand keys lose to specific family keys during substring search so
// "claude-sonnet-4-5" resolves to "sonnet" not "claude". Two-pass search.
const BARE_BRAND_KEYS = new Set(['claude', 'gemini', 'cursor', 'codex', 'composer']);

// Pick the pricing row + matched key for a model. Strategy:
//   1. Exact match (e.g. bare "claude" → Opus default)
//   2. Longest specific (non-bare-brand) key that is a substring
//   3. Longest bare-brand key that is a substring (e.g. "composer-2.5" → "composer")
//   4. Sonnet default
export function resolveModelPricing(
  model: string,
  pricing: ModelPricing = ensurePricingLoaded(),
): { input: number; output: number; cachedInput?: number; key: string } {
  const normalized = normalizeModelKey(model);
  if (pricing[normalized]) return { ...pricing[normalized], key: normalized };

  const allKeys = Object.keys(pricing).sort((a, b) => b.length - a.length);
  for (const key of allKeys) {
    if (!BARE_BRAND_KEYS.has(key) && normalized.includes(key)) return { ...pricing[key], key };
  }
  for (const key of allKeys) {
    if (BARE_BRAND_KEYS.has(key) && normalized.includes(key)) return { ...pricing[key], key };
  }
  return { ...(pricing['sonnet'] ?? DEFAULT_MODEL_PRICING['sonnet']), key: 'sonnet' };
}

// Cache discount/premium varies by provider:
//   • Anthropic   — read 0.10×, write 1.25× (cache writes are billed)
//   • Google      — read 0.25×, no write surcharge
//   • OpenAI      — read 0.50×, no write surcharge
// Mirrors cacheMultipliersFor() in apps/api/src/utils/pricing.ts.
function cacheMultipliersFor(modelKey: string): { read: number; write: number } {
  if (modelKey.startsWith('gemini')) return { read: 0.25, write: 1.00 };
  if (modelKey.startsWith('gpt-') || modelKey.startsWith('o1') ||
      modelKey.startsWith('o3') || modelKey.startsWith('o4') ||
      modelKey === 'codex' || modelKey === 'composer') return { read: 0.50, write: 1.00 };
  return { read: 0.10, write: 1.25 };
}

export function estimateCost(
  model: string,
  inputTokens: number,
  outputTokens: number,
  cacheReadTokens: number = 0,
  cacheCreationTokens: number = 0,
): number {
  const { input, output, cachedInput, key } = resolveModelPricing(model);
  const m = cacheMultipliersFor(key);
  // Prefer an explicit cached-input rate when the model row declares
  // one — gpt-5.5's 90% discount doesn't match the OpenAI family
  // default of 50% the multiplier would give.
  const effectiveCacheReadRate = cachedInput ?? input * m.read;
  const inputCost = (inputTokens / 1_000_000) * input;
  const cacheReadCost = (cacheReadTokens / 1_000_000) * effectiveCacheReadRate;
  const cacheCreationCost = (cacheCreationTokens / 1_000_000) * (input * m.write);
  const outputCost = (outputTokens / 1_000_000) * output;

  return parseFloat((inputCost + cacheReadCost + cacheCreationCost + outputCost).toFixed(4));
}

// ─── Image attachment extraction ─────────────────────────────────────────
//
// Walks a Claude/Cursor JSONL transcript and returns the inline image
// parts per prompt. Claude Code's user-message format puts image content
// in the same `content` array as text blocks, shape:
//
//   {type: 'image', source: {type: 'base64', media_type: 'image/png',
//                            data: '<base64>'}}
//
// Cursor's format is similar when it writes through the Claude Code
// transcript path. (For Cursor sessions that capture through Cursor's
// own SQLite, image extraction lives in a separate code path — Phase 2.)
//
// Returns `{promptIndex, mediaType, base64}` entries in order. The
// caller uploads each to the Origin API, gets back a stable id, and
// splices `[image:<id>]` into the prompt text at the right spot.

export interface ExtractedImage {
  promptIndex: number;
  /** Order of this image within its prompt (0-based). Lets the splicer
   *  put placeholders in the right spot when multiple images share one
   *  prompt. */
  imageIndex: number;
  mediaType: string;
  base64: string;
  /** Raw byte size after base64 decode — pre-checked so the caller
   *  doesn't waste a roundtrip on an over-cap image. */
  sizeBytes: number;
}

export function extractPromptImages(transcriptPath: string): ExtractedImage[] {
  if (!fs.existsSync(transcriptPath)) return [];
  let raw: string;
  try {
    raw = fs.readFileSync(transcriptPath, 'utf-8');
  } catch {
    return [];
  }
  const trimmed = raw.trim();

  // Format dispatch. Mirrors extractPromptFileMappings so the same
  // promptIndex assignments line up across both passes — file
  // attribution + image attribution must reach the same prompt index
  // for the splice step to put placeholders in the right spot.
  //
  //   Gemini  → single JSON object with `messages`/`history`
  //   Codex   → JSONL where each line wraps a `response_item` payload
  //   Cursor  → JSONL with `<image_files>` text markers (paths-on-disk)
  //   Claude  → JSONL with Anthropic-style content blocks (base64 inline)

  // Gemini detector: parses cleanly as ONE JSON object AND that object
  // has a `messages` / `history` array. We can't rely on the
  // "no newlines" shortcut — Codex rollouts are also single-line on
  // short conversations and would get misrouted otherwise.
  if (trimmed.startsWith('{')) {
    try {
      const obj = JSON.parse(trimmed);
      if (obj && (obj.messages || obj.history)) {
        return extractGeminiImages(raw);
      }
      // Parses as JSON but isn't a Gemini doc — fall through to JSONL
      // detection (the "doc" was probably a single Codex rollout
      // line).
    } catch {
      // Parse failed → multi-line JSONL; fall through.
    }
  }

  const lines = raw.split('\n').filter((line) => line.trim());

  // Sniff for Codex: first few non-empty lines wrap a response_item
  // payload. Codex rollouts are JSONL too, but the prompt content
  // lives at `payload.content[]` not `message.content[]` — the legacy
  // Claude/Cursor extractor would have walked past every user prompt.
  let looksLikeCodex = false;
  for (let i = 0; i < Math.min(8, lines.length); i++) {
    try {
      const e = JSON.parse(lines[i]);
      if (e?.payload && (e?.type === 'response_item' || e?.payload?.type === 'message')) {
        looksLikeCodex = true;
        break;
      }
    } catch { /* skip */ }
  }
  if (looksLikeCodex) return extractCodexImages(lines);

  // Default: Claude/Cursor JSONL (content blocks + Cursor's
  // <image_files> markers handled in the same pass).
  return extractClaudeCursorImages(lines);
}

// ─── Claude + Cursor JSONL extractor ────────────────────────────────────────
//
// Claude Code embeds base64 inline as Anthropic content blocks
// (`{type:'image', source:{media_type, data}}`). Cursor occasionally
// uses the same shape but more often saves the image to disk and
// injects a `<image_files>…/abs/path.png…</image_files>` text marker
// into the user prompt — same prompt, different storage. Both shapes
// are handled here so a single pass over the JSONL covers all
// Anthropic-style transcripts.

function extractClaudeCursorImages(lines: string[]): ExtractedImage[] {
  const out: ExtractedImage[] = [];
  let promptIndex = -1;
  let imageIndex = 0;

  for (const line of lines) {
    let entry: any;
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }
    const type = entry.type || entry.role || entry.message?.role;
    if (type !== 'user') continue;

    const content = entry.message?.content ?? entry.content;
    // String content can still carry a Cursor <image_files> marker.
    let textParts: string[] = [];
    let blocks: any[] = [];
    if (typeof content === 'string') {
      textParts = [content];
    } else if (Array.isArray(content)) {
      blocks = content;
      for (const b of content) {
        if (b && (b.type === 'text' || typeof b.text === 'string')) {
          textParts.push(typeof b.text === 'string' ? b.text : '');
        }
      }
    } else {
      continue;
    }

    // Bump the prompt index whenever this is a real user turn —
    // either text OR an image block. Image-only prompts (drag-and-
    // drop a screenshot with no caption) are common and must not be
    // silently dropped just because the text gate was too strict.
    const hasText = textParts.some((t) => t && t.trim().length > 0);
    const hasImageBlock = blocks.some((b: any) => b && b.type === 'image');
    const hasMarker = textParts.some((t) => t && /<image_files>[\s\S]*?<\/image_files>/.test(t));
    if (!hasText && !hasImageBlock && !hasMarker) continue;

    promptIndex++;
    imageIndex = 0;

    // (1) Anthropic-style base64 image blocks (Claude Code, sometimes
    //     Cursor) — already-decoded payloads.
    for (const block of blocks) {
      if (!block || block.type !== 'image') continue;
      const source = block.source || {};
      const mediaType = typeof source.media_type === 'string' ? source.media_type : 'image/png';
      const data = typeof source.data === 'string' ? source.data : '';
      if (!data) continue;
      const sizeBytes = Math.floor((data.length * 3) / 4);
      out.push({
        promptIndex,
        imageIndex: imageIndex++,
        mediaType,
        base64: data,
        sizeBytes,
      });
    }

    // (2) Cursor <image_files> markers — absolute paths to image
    //     files saved under `~/.cursor/projects/<ws>/assets/`. Read,
    //     base64-encode, and emit as if it were an inline block.
    //     Caps mirror the inline path: 5 MB per image (server cap)
    //     so we don't waste an upload on something the API will
    //     reject.
    const MAX_BYTES_PER_IMAGE = 5 * 1024 * 1024;
    for (const text of textParts) {
      if (!text) continue;
      const markers = text.match(/<image_files>[\s\S]*?<\/image_files>/g);
      if (!markers) continue;
      for (const marker of markers) {
        // Pull every absolute path with an image extension out of the
        // marker block. Cursor numbers them ("1. /Users/...png");
        // accept any token ending in a known extension so subtle
        // format changes (e.g. dashes, no trailing space) don't
        // silently drop captures.
        const paths = marker.match(/\/[^\s<>"]+\.(?:png|jpe?g|gif|webp|bmp|svg)/gi) || [];
        for (const p of paths) {
          try {
            const st = fs.statSync(p);
            if (!st.isFile()) continue;
            if (st.size > MAX_BYTES_PER_IMAGE) continue;
            const buf = fs.readFileSync(p);
            const ext = (p.split('.').pop() || 'png').toLowerCase();
            const mediaType =
              ext === 'jpg' || ext === 'jpeg' ? 'image/jpeg' :
              ext === 'gif' ? 'image/gif' :
              ext === 'webp' ? 'image/webp' :
              ext === 'bmp' ? 'image/bmp' :
              ext === 'svg' ? 'image/svg+xml' :
              'image/png';
            const base64 = buf.toString('base64');
            out.push({
              promptIndex,
              imageIndex: imageIndex++,
              mediaType,
              base64,
              sizeBytes: st.size,
            });
          } catch {
            // Path missing / unreadable — drop silently. Cursor sometimes
            // cleans up old assets; not worth a hard error.
          }
        }
      }
    }
  }
  return out;
}

// ─── Codex rollout extractor ────────────────────────────────────────────────
//
// Codex (~/.codex/sessions/.../rollout-*.jsonl) wraps every event as
// `{type: "response_item", payload: {type, role, content[]}}`. User
// prompts arrive as `payload.type === "message"` with `role === "user"`
// and content blocks like `{type: "input_image", image_url: "data:..."}`.
// The image_url is either a data URL string or an object with `url`.

function extractCodexImages(lines: string[]): ExtractedImage[] {
  const out: ExtractedImage[] = [];
  let promptIndex = -1;
  let imageIndex = 0;

  for (const line of lines) {
    let entry: any;
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }
    const payload = entry?.payload;
    if (!payload || payload.type !== 'message') continue;
    if (payload.role !== 'user' && payload.role !== 'human') continue;
    const content = payload.content;
    if (!Array.isArray(content)) continue;

    // Treat this as a real prompt if it carries text OR an image
    // block — same logic as the Claude/Cursor extractor. Skipping
    // on text-only would silently drop "drag a screenshot, hit
    // enter" prompts (no caption) that the user clearly meant as a
    // turn.
    const hasText = content.some(
      (b: any) =>
        b &&
        (b.type === 'text' || b.type === 'input_text' || b.type === 'output_text') &&
        typeof b.text === 'string' && b.text.trim().length > 0,
    );
    const hasImageBlock = content.some(
      (b: any) => b && (b.type === 'input_image' || b.type === 'image'),
    );
    if (!hasText && !hasImageBlock) continue;

    promptIndex++;
    imageIndex = 0;

    for (const block of content) {
      if (!block || (block.type !== 'input_image' && block.type !== 'image')) continue;
      // image_url can be either a string ("data:image/png;base64,…")
      // or an object `{url: "data:…"}`. Codex versions disagree.
      const url: string | undefined =
        typeof block.image_url === 'string'
          ? block.image_url
          : typeof block.image_url?.url === 'string'
            ? block.image_url.url
            : undefined;
      if (!url) continue;
      // We only support data URLs — Codex always emits them for pasted
      // images. Remote URLs would require a network fetch we don't
      // want from a stop hook.
      const m = url.match(/^data:([^;]+);base64,(.+)$/);
      if (!m) continue;
      const mediaType = m[1] || 'image/png';
      const data = m[2] || '';
      if (!data) continue;
      const sizeBytes = Math.floor((data.length * 3) / 4);
      out.push({
        promptIndex,
        imageIndex: imageIndex++,
        mediaType,
        base64: data,
        sizeBytes,
      });
    }
  }
  return out;
}

// ─── Gemini transcript extractor ────────────────────────────────────────────
//
// Gemini CLI stores a single JSON object with `messages` (or `history`)
// where each message has `parts: [{text}, {inlineData: {mimeType, data}}]`
// (the Google AI API shape). We follow the same convention as
// parseGeminiTranscript: walk user-role messages, count each as one
// prompt, then pull inline_data / inlineData blocks out.

function extractGeminiImages(raw: string): ExtractedImage[] {
  let data: any;
  try {
    data = JSON.parse(raw);
  } catch {
    return [];
  }
  const messages: any[] = data?.messages || data?.history || [];
  const out: ExtractedImage[] = [];
  let promptIndex = -1;
  let imageIndex = 0;

  for (const msg of messages) {
    const role = msg?.type || msg?.role;
    if (role !== 'user') continue;
    const parts: any[] = Array.isArray(msg?.parts)
      ? msg.parts
      : Array.isArray(msg?.content)
        ? msg.content
        : [];
    // Count this as a prompt if it carries text OR an inline image
    // part — Gemini supports image-only turns (drag a screenshot in
    // with no caption) and we shouldn't silently drop them.
    const hasText = parts.some(
      (p: any) => typeof p?.text === 'string' && p.text.trim().length > 0,
    ) || typeof msg?.content === 'string';
    const hasInline = parts.some((p: any) => p && (p.inlineData || p.inline_data));
    if (!hasText && !hasInline) continue;

    promptIndex++;
    imageIndex = 0;

    for (const part of parts) {
      // Google AI API: `inlineData` (camelCase) or `inline_data`
      // (snake) depending on language binding. Both ship the base64
      // straight in the JSON.
      const inline = part?.inlineData || part?.inline_data;
      if (!inline) continue;
      const mediaType = inline.mimeType || inline.mime_type || 'image/png';
      const b64 = typeof inline.data === 'string' ? inline.data : '';
      if (!b64) continue;
      const sizeBytes = Math.floor((b64.length * 3) / 4);
      out.push({
        promptIndex,
        imageIndex: imageIndex++,
        mediaType,
        base64: b64,
        sizeBytes,
      });
    }
  }
  return out;
}

