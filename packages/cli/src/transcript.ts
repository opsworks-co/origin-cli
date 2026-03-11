import fs from 'fs';
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
  summary: string;
  model: string;
  transcript: string;
}

// Tools that modify files — we extract file paths from these
const FILE_MODIFICATION_TOOLS = new Set([
  'Write',
  'Edit',
  'NotebookEdit',
  'mcp__acp__Write',
  'mcp__acp__Edit',
]);

// ─── Parser ────────────────────────────────────────────────────────────────

export function parseTranscript(transcriptPath: string): ParsedTranscript {
  const result: ParsedTranscript = {
    prompts: [],
    filesChanged: [],
    tokensUsed: 0,
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheCreationTokens: 0,
    toolCalls: 0,
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
  const filesSet = new Set<string>();

  for (const line of lines) {
    let entry: TranscriptLine;
    try {
      entry = JSON.parse(line);
    } catch {
      continue; // skip malformed lines
    }

    const type = entry.type || entry.message?.role;

    if (type === 'user') {
      const prompt = extractUserPrompt(entry);
      if (prompt) {
        result.prompts.push(prompt);
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

            // Extract file paths from file modification tools
            if (block.name && FILE_MODIFICATION_TOOLS.has(block.name) && block.input) {
              const filePath = block.input.file_path || block.input.notebook_path || block.input.path;
              if (filePath && typeof filePath === 'string') {
                filesSet.add(filePath);
              }
            }
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
  result.tokensUsed = result.inputTokens + result.cacheReadTokens + result.cacheCreationTokens + result.outputTokens;

  // Deduplicated file list, filtered through ignore patterns
  result.filesChanged = Array.from(filesSet).filter(f => !shouldIgnoreFile(f));

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
  // Strip IDE-injected context tags (like Entire does)
  let cleaned = text
    .replace(/<ide_opened_file>[\s\S]*?<\/ide_opened_file>/g, '')
    .replace(/<ide_selected_text>[\s\S]*?<\/ide_selected_text>/g, '')
    .replace(/<ide_context>[\s\S]*?<\/ide_context>/g, '')
    .trim();

  if (!cleaned) return null;

  // Truncate very long prompts
  if (cleaned.length > 1000) {
    cleaned = cleaned.slice(0, 1000) + '...';
  }

  return cleaned;
}

// ─── Gemini Transcript Parser ──────────────────────────────────────────────

// Gemini CLI transcript format:
// { sessionId, messages: [{ id, timestamp, type: "user"|"gemini", content, tokens?, model?, thoughts? }] }
// - User messages: type: "user", content: [{ text: "..." }]
// - Gemini messages: type: "gemini", content: "string", tokens: { input, output, cached, thoughts, tool, total }, model: "gemini-..."

interface GeminiMessage {
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
              if (FILE_MODIFICATION_TOOLS.has(name) && part.functionCall.args) {
                const fp = part.functionCall.args.file_path || part.functionCall.args.path;
                if (fp && typeof fp === 'string') filesSet.add(fp);
              }
            }
          }
        }

        // Extract model name from individual messages
        if (msg.model && !result.model) {
          result.model = msg.model;
        }

        // Token counts per message
        if (msg.tokens) {
          result.inputTokens += msg.tokens.input ?? 0;
          result.cacheReadTokens += msg.tokens.cached ?? 0;
          result.outputTokens += msg.tokens.output ?? 0;
        }
      }
    }

    result.tokensUsed = result.inputTokens + result.cacheReadTokens + result.outputTokens;
    result.filesChanged = Array.from(filesSet).filter(f => !shouldIgnoreFile(f));
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
  diff: string;             // Unified diff of edits from this prompt
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

    const type = entry.type || entry.message?.role;

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

    if (type === 'assistant' && currentPromptIndex >= 0) {
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

  // Filter out prompts with no file changes (unless it's the only prompt)
  return mappings.filter((m) => m.filesChanged.length > 0);
}

/**
 * Build a unified-diff-like string from Edit/Write tool call data.
 * For Edit calls: shows old_string → new_string as unified diff hunks.
 * For Write calls: shows file as created/rewritten (first 20 lines).
 * Truncates to 100KB max to keep database size reasonable.
 */
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
      if (edit.toolName === 'Edit' || edit.toolName === 'mcp__acp__Edit') {
        const oldStr = edit.input.old_string || '';
        const newStr = edit.input.new_string || '';
        if (oldStr || newStr) {
          parts.push(`--- a/${shortPath}`);
          parts.push(`+++ b/${shortPath}`);
          parts.push('@@ @@');
          // Show old lines with - prefix
          for (const line of oldStr.split('\n')) {
            parts.push(`-${line}`);
          }
          // Show new lines with + prefix
          for (const line of newStr.split('\n')) {
            parts.push(`+${line}`);
          }
        }
      } else if (edit.toolName === 'Write' || edit.toolName === 'mcp__acp__Write') {
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
export function formatTranscriptForDisplay(transcriptPath: string): string {
  if (!fs.existsSync(transcriptPath)) {
    return '';
  }

  const raw = fs.readFileSync(transcriptPath, 'utf-8');
  const trimmed = raw.trim();
  if (!trimmed) return '';

  let messages: DisplayMessage[] = [];

  // Detect format: Gemini (single JSON with messages/history) vs Claude JSONL
  if (trimmed.startsWith('{') && !trimmed.includes('\n')) {
    messages = formatGeminiMessages(raw);
  } else if (trimmed.startsWith('{')) {
    try {
      const singleObj = JSON.parse(trimmed);
      if (singleObj.messages || singleObj.history) {
        messages = formatGeminiMessages(raw);
      } else {
        messages = formatJSONLMessages(raw);
      }
    } catch {
      messages = formatJSONLMessages(raw);
    }
  } else {
    messages = formatJSONLMessages(raw);
  }

  if (messages.length === 0) return '';

  return JSON.stringify(messages);
}

function formatJSONLMessages(raw: string): DisplayMessage[] {
  const lines = raw.split('\n').filter((line) => line.trim());
  const messages: DisplayMessage[] = [];

  for (const line of lines) {
    let entry: TranscriptLine;
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }

    const type = entry.type || entry.message?.role;

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
        // Collect text blocks, summarize tool_use blocks
        const parts: string[] = [];
        for (const block of content) {
          if (block.type === 'text' && block.text) {
            parts.push(block.text);
          } else if (block.type === 'tool_use' && block.name) {
            // Show tool usage as a compact note
            const input = block.input || {};
            const filePath = input.file_path || input.notebook_path || input.command || '';
            if (filePath) {
              parts.push(`[Tool: ${block.name} → ${typeof filePath === 'string' ? filePath.split('/').pop() : ''}]`);
            } else {
              parts.push(`[Tool: ${block.name}]`);
            }
          }
        }
        text = parts.join('\n');
      }

      if (text.trim()) {
        // Merge consecutive assistant messages
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

function formatGeminiMessages(raw: string): DisplayMessage[] {
  try {
    const data = JSON.parse(raw);
    const msgs: GeminiMessage[] = data.messages || data.history || [];
    const messages: DisplayMessage[] = [];

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
      }

      if (msgType === 'gemini' || msgType === 'model') {
        if (typeof contentParts === 'string') {
          if (contentParts.trim()) {
            messages.push({ role: 'assistant', content: contentParts });
          }
        } else if (Array.isArray(contentParts)) {
          const parts: string[] = [];
          for (const part of contentParts) {
            if (part.text) {
              parts.push(part.text);
            } else if (part.functionCall) {
              parts.push(`[Tool: ${part.functionCall.name}]`);
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
const MODEL_PRICING: Record<string, { input: number; output: number }> = {
  // Anthropic
  'sonnet': { input: 3, output: 15 },
  'opus': { input: 15, output: 75 },
  'haiku': { input: 0.25, output: 1.25 },
  // Google
  'gemini-2.5-pro': { input: 1.25, output: 10 },
  'gemini-2.5-flash': { input: 0.15, output: 0.60 },
  'gemini-3-pro': { input: 1.25, output: 10 },
  'gemini-3-flash': { input: 0.15, output: 0.60 },
  'gemini-2.0': { input: 0.10, output: 0.40 },
  // OpenAI (for Cursor users)
  'gpt-4o': { input: 2.50, output: 10 },
  'gpt-4o-mini': { input: 0.15, output: 0.60 },
  'o1': { input: 15, output: 60 },
  'o3': { input: 10, output: 40 },
  'o3-mini': { input: 1.10, output: 4.40 },
  'o4-mini': { input: 1.10, output: 4.40 },
};

export function estimateCost(
  model: string,
  inputTokens: number,
  outputTokens: number,
  cacheReadTokens: number = 0,
  cacheCreationTokens: number = 0,
): number {
  const modelLower = model.toLowerCase();

  let pricing = MODEL_PRICING['sonnet']; // default to sonnet pricing
  for (const [key, value] of Object.entries(MODEL_PRICING)) {
    if (modelLower.includes(key)) {
      pricing = value;
      break;
    }
  }

  const inputCost = (inputTokens / 1_000_000) * pricing.input;
  const cacheReadCost = (cacheReadTokens / 1_000_000) * (pricing.input * 0.1);
  const cacheCreationCost = (cacheCreationTokens / 1_000_000) * (pricing.input * 1.25);
  const outputCost = (outputTokens / 1_000_000) * pricing.output;

  return parseFloat((inputCost + cacheReadCost + cacheCreationCost + outputCost).toFixed(4));
}
