// ── Codex agent adapter: session discovery & rollout parsing ────────────────
// Extracted verbatim from commands/hooks.ts (R3 phase B). Everything Codex-
// specific about FINDING session data lives here: the ~/.codex SQLite thread
// lookup, rollout file resolution/decompression, the per-turn prompt
// timeline, and the rollout parser that recovers prompts/tokens/commit
// markers. hooks.ts orchestrates; this module knows where Codex keeps things.
import fs from 'fs';
import os from 'os';
import path from 'path';
import { execFileSync } from 'child_process';
import * as fzstd from 'fzstd';
import { debugLog } from '../debug-log.js';

// ─── Codex Session Data Discovery ─────────────────────────────────────────

export interface CodexSessionData {
  model: string;
  tokensUsed: number;
  inputTokens: number;     // NON-cached prompt tokens
  outputTokens: number;    // visible output + reasoning (both billed at output rate)
  cacheReadTokens?: number; // cached prompt portion — billed at the model's cached rate
  toolCalls: number;
  prompt: string;
  prompts?: string[];   // all user prompts from the rollout, in order
  transcript?: string;  // full JSONL conversation for display
  cwd?: string;         // codex thread's actual cwd — drives repoPath correction
  rolloutPath?: string; // absolute path to the rollout JSONL(.zst) — feed to
                        // the new per-prompt PromptCapture extractor
}

/**
 * Codex CLI stores session data in two places:
 *
 * 1. **SQLite** (`~/.codex/state_*.sqlite`) — `threads` table has model,
 *    `tokens_used`, cwd, rollout_path. `tokens_used` is a single aggregate
 *    that can be 0 or drastically undercounted for short sessions.
 *
 * 2. **Rollout JSONL** (`~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl.zst`)
 *    — compressed event stream with per-turn `TokenCountEvent` entries
 *    containing `total_token_usage.{input_tokens,output_tokens,total_tokens}`
 *    and the full conversation (user messages, assistant responses, tool
 *    calls). This is the authoritative source.
 *
 * Strategy: query SQLite for the thread matching this repo, grab its
 * rollout_path, decompress and parse the JSONL for real token counts
 * and transcript. Fall back to SQLite `tokens_used` if rollout parsing fails.
 */
/**
 * True when a Codex thread is one of Codex's own internal LLM subroutines
 * (the ambient-suggestion safety filter, title generation, output summarizer)
 * rather than a user coding session. The Codex UI app logs each of these as its
 * own `threads` row, so without this every one is captured as a duplicate
 * session (e.g. a "gpt-5.4-mini / no repo / 0 tools" row whose prompt is
 * "You are an expert at upholding safety and compliance standards for Codex
 * ambient suggestions…"). Matches the thread's first_user_message — Codex's
 * meta prompts are stable strings a real user never sends — with a corroborated
 * mini-model / system-style / no-tools fallback for variants we lack an exact
 * string for. Exported for testing.
 */
export function isCodexInternalSubroutine(o: { model?: string | null; prompt?: string | null; toolCalls?: number }): boolean {
  const p = (o.prompt || '').trim();
  if (!p) return false;
  const KNOWN = [
    /Codex ambient suggestions/i,
    /You are an expert at upholding safety and compliance standards/i,
    /Generate a (?:short|concise|brief) title/i,
    /Summariz(?:e|ing) the (?:command|shell|tool) output/i,
  ];
  if (KNOWN.some((re) => re.test(p))) return true;
  // Corroborated heuristic: a mini model running a one-shot, system-style
  // classifier prompt with zero tool calls is the shape of an internal
  // meta-call — real coding work either uses tools or a natural user prompt.
  const isMini = /-mini\b/i.test(o.model || '');
  const systemStyle = /^(You are |You will |You'll be given |You are going to |Given the following)/i.test(p);
  if (isMini && systemStyle && (o.toolCalls ?? 0) === 0) return true;
  return false;
}

export function discoverCodexSessionData(
  repoPath: string,
  opts: { verbose?: boolean; threadId?: string } = {},
): CodexSessionData | null {
  try {
    const codexDir = path.join(os.homedir(), '.codex');
    if (!fs.existsSync(codexDir)) return null;

    // ── Step 1: Find the matching thread from SQLite ───────────────────
    const stateFiles = fs.readdirSync(codexDir)
      .filter(f => f.startsWith('state_') && f.endsWith('.sqlite'))
      .map(f => ({ name: f, path: path.join(codexDir, f), mtime: fs.statSync(path.join(codexDir, f)).mtimeMs }))
      .sort((a, b) => b.mtime - a.mtime);
    if (stateFiles.length === 0) return null;

    const dbPath = stateFiles[0].path;

    // STRICT thread-id matching when the caller has one. session-start
    // queries SQLite ONCE by EXACT `cwd = repoPath` and stores threads.id
    // on state.agentSessionId. Every downstream hook passes that id in
    // here, and we read its row directly — no basename LIKE, no
    // "newest thread overall" fallback. Both of those used to make Codex
    // happily attribute work from one repo's thread to another repo's
    // session whenever the user ran codex against multiple repos in
    // parallel.
    //
    // When threadId is absent (session-start itself, first call before
    // anything's been stored), we fall back to EXACT cwd equality —
    // never `LIKE` — and never to "latest thread overall."
    const sqliteOpts = {
      encoding: 'utf-8' as const, timeout: 3000,
      stdio: ['pipe', 'pipe', 'pipe'] as ['pipe', 'pipe', 'pipe'],
    };

    let raw = '';
    if (opts.threadId && /^[A-Za-z0-9_-]+$/.test(opts.threadId)) {
      const byIdQuery = `SELECT id, model, tokens_used, rollout_path, cwd, first_user_message FROM threads WHERE id = '${opts.threadId}' LIMIT 1;`;
      raw = execFileSync('sqlite3', [dbPath, byIdQuery], sqliteOpts).trim();
      if (!raw) {
        debugLog('codex', 'discoverCodexSessionData: threadId not found in SQLite', { threadId: opts.threadId });
        return null;
      }
    } else {
      // No locked thread yet — match strictly on `cwd = repoPath`. The
      // exact match means concurrent codex threads in sibling repos
      // can't be confused for each other; if no row matches we bail
      // (callers expect null when nothing fits).
      const exactCwd = repoPath.replace(/'/g, "''"); // escape single-quote for SQL
      const byCwdQuery = `SELECT id, model, tokens_used, rollout_path, cwd, first_user_message FROM threads WHERE cwd = '${exactCwd}' ORDER BY updated_at DESC LIMIT 1;`;
      raw = execFileSync('sqlite3', [dbPath, byCwdQuery], sqliteOpts).trim();
      if (!raw) {
        debugLog('codex', 'discoverCodexSessionData: no thread for exact cwd', { repoPath });
        return null;
      }
    }

    const parts = raw.split('|');
    if (parts.length < 6) return null;

    const threadId = parts[0];
    const model = parts[1] || 'codex';
    const sqliteTokens = parseInt(parts[2], 10) || 0;
    const rolloutPath = parts[3] || '';
    const threadCwd = parts[4] || '';
    const rawPrompt = parts.slice(5).join('|') || '';
    // Codex's `first_user_message` column captures whatever the first
    // user-role event in the rollout contained — which is Codex's own
    // AGENTS.md replay or its environment-context wrapper, not anything
    // the user typed. Filter the echo out so it never reaches
    // state.prompts / the dashboard.
    const looksLikeOriginEcho =
      rawPrompt.includes('<!-- origin-managed -->') ||
      /^#\s+AGENTS\.md instructions for /m.test(rawPrompt);
    const stripped = rawPrompt
      .replace(/<INSTRUCTIONS>[\s\S]*?<\/INSTRUCTIONS>/g, '')
      .replace(/<environment_context>[\s\S]*?<\/environment_context>/g, '')
      .replace(/<user_instructions>[\s\S]*?<\/user_instructions>/g, '')
      .trim();
    const prompt = looksLikeOriginEcho ? '' : stripped;

    // Resolve the rollout file once so we can hand the absolute path to
    // the new per-prompt PromptCapture extractor (which decompresses .zst
    // and walks the rollout for [branch sha] markers + commit-walking).
    const absRolloutPath = (() => {
      if (rolloutPath && fs.existsSync(rolloutPath)) return rolloutPath;
      if (rolloutPath) {
        const abs = path.join(codexDir, rolloutPath);
        if (fs.existsSync(abs)) return abs;
      }
      try { return findCodexRolloutPath(repoPath, threadId); } catch { return null; }
    })();

    // ── Step 2: Try to parse the rollout JSONL for real token counts ──
    const rolloutResult = parseCodexRollout(codexDir, rolloutPath, threadId, { verbose: !!opts.verbose });

    // Drop Codex's own internal subroutine threads (ambient-suggestion safety
    // filter, title generation, etc.) so they don't get captured as duplicate
    // sessions. Uses the raw first_user_message + effective model/tool-calls.
    if (isCodexInternalSubroutine({
      model: rolloutResult?.model || model,
      prompt: rawPrompt,
      toolCalls: rolloutResult?.toolCalls ?? 0,
    })) {
      debugLog('codex', 'discoverCodexSessionData: internal subroutine thread — skipping capture', { threadId, model: rolloutResult?.model || model });
      return null;
    }

    if (rolloutResult) {
      debugLog('codex', 'parsed rollout JSONL', {
        inputTokens: rolloutResult.inputTokens,
        outputTokens: rolloutResult.outputTokens,
        total: rolloutResult.tokensUsed,
        turns: rolloutResult.turnCount,
      });
      return {
        model: rolloutResult.model || model,
        tokensUsed: rolloutResult.tokensUsed,
        inputTokens: rolloutResult.inputTokens,
        outputTokens: rolloutResult.outputTokens,
        cacheReadTokens: rolloutResult.cacheReadTokens,
        toolCalls: rolloutResult.toolCalls,
        prompt,
        prompts: rolloutResult.userPrompts,
        transcript: rolloutResult.transcript,
        cwd: threadCwd || undefined,
        rolloutPath: absRolloutPath || undefined,
      };
    }

    // ── Step 3: Fall back to SQLite tokens_used (may be 0 / undercount) ─
    debugLog('codex', 'rollout parse failed, using SQLite tokens_used', { sqliteTokens });
    return {
      model,
      tokensUsed: sqliteTokens,
      inputTokens: Math.round(sqliteTokens * 0.7),
      outputTokens: Math.round(sqliteTokens * 0.3),
      toolCalls: 0,
      prompt,
      cwd: threadCwd || undefined,
      rolloutPath: absRolloutPath || undefined,
    };
  } catch (err) {
    debugLog('codex', 'discoverCodexSessionData error', { error: String(err) });
    return null;
  }
}

/**
 * Parse a Codex rollout JSONL(.zst) file for real per-turn token usage
 * and conversation transcript.
 *
 * Rollout files live under ~/.codex/sessions/YYYY/MM/DD/ and can be either
 * plain .jsonl or zstd-compressed .jsonl.zst. Each line is a JSON event.
 *
 * Token events have a `total_token_usage` field with cumulative counts.
 * We take the max seen values as the final totals.
 */
/**
 * Extract user prompts with timestamps from the agent's session log so the
 * post-commit hook can attribute each commit to the prompt that produced
 * it. Codex/Gemini don't fire user-prompt-submit hooks, so without this
 * every commit ends up stamped with promptIndex 0 (the rest being filled
 * in only at session end).
 *
 * Returns prompts in chronological order with millisecond timestamps; the
 * index in the array IS the promptIndex used for downstream UI.
 */
export interface PromptTimelineEntry {
  text: string;
  timestamp: number;
}

// Locate (without reading) the Codex rollout file for the current repo. Used
// by callers that need the path to hand to another module that does its own
// file IO (e.g. backfillCodexPromptMappings, which reads + decompresses the
// rollout inside its own process).
export function findCodexRolloutPath(repoPath: string, threadId?: string): string | null {
  // STRICT path resolution. When a threadId is passed, only return its
  // rollout. Otherwise EXACT-cwd match — no basename LIKE, no "latest
  // overall" fallback. Both of those used to silently attribute a foreign
  // Codex thread's rollout to this session.
  try {
    const codexDir = path.join(os.homedir(), '.codex');
    if (!fs.existsSync(codexDir)) return null;
    const stateFiles = fs.readdirSync(codexDir)
      .filter(f => f.startsWith('state_') && f.endsWith('.sqlite'))
      .map(f => ({ path: path.join(codexDir, f), mtime: fs.statSync(path.join(codexDir, f)).mtimeMs }))
      .sort((a, b) => b.mtime - a.mtime);
    if (stateFiles.length === 0) return null;

    const sqliteOpts = {
      encoding: 'utf-8' as const, timeout: 3000,
      stdio: ['pipe', 'pipe', 'pipe'] as ['pipe', 'pipe', 'pipe'],
    };

    let raw = '';
    if (threadId && /^[A-Za-z0-9_-]+$/.test(threadId)) {
      const byIdQuery = `SELECT id, rollout_path FROM threads WHERE id = '${threadId}' LIMIT 1;`;
      raw = execFileSync('sqlite3', [stateFiles[0].path, byIdQuery], sqliteOpts).trim();
      if (!raw) {
        debugLog('codex', 'findCodexRolloutPath: threadId not in SQLite', { threadId });
        return null;
      }
    } else {
      const exactCwd = repoPath.replace(/'/g, "''");
      const byCwdQuery = `SELECT id, rollout_path FROM threads WHERE cwd = '${exactCwd}' ORDER BY updated_at DESC LIMIT 1;`;
      raw = execFileSync('sqlite3', [stateFiles[0].path, byCwdQuery], sqliteOpts).trim();
      if (!raw) return null;
    }
    const parts = raw.split('|');
    const resolvedThreadId = parts[0];
    const rolloutPath = parts[1] || '';

    if (rolloutPath && fs.existsSync(rolloutPath)) return rolloutPath;
    if (rolloutPath) {
      const abs = path.join(codexDir, rolloutPath);
      if (fs.existsSync(abs)) return abs;
    }
    // Last resort: the rollout file is named rollout-<id>-*.jsonl(.zst) in
    // ~/.codex/sessions/. Walk it by EXACT thread id only.
    const sessionsDir = path.join(codexDir, 'sessions');
    if (fs.existsSync(sessionsDir) && resolvedThreadId) {
      const latest = findLatestRollout(sessionsDir, resolvedThreadId);
      if (latest) return latest;
    }
    return null;
  } catch {
    return null;
  }
}

export function readCodexRolloutFile(repoPath: string, threadId?: string): string | null {
  try {
    const rolloutFile = findCodexRolloutPath(repoPath, threadId);
    if (!rolloutFile) return null;

    if (rolloutFile.endsWith('.zst') || rolloutFile.endsWith('.zstd')) {
      const compressed = fs.readFileSync(rolloutFile);
      const decompressed = fzstd.decompress(new Uint8Array(compressed));
      return Buffer.from(decompressed).toString('utf-8');
    }
    return fs.readFileSync(rolloutFile, 'utf-8');
  } catch {
    return null;
  }
}

export function getCodexPromptsTimeline(repoPath: string, threadId?: string): PromptTimelineEntry[] {
  const content = readCodexRolloutFile(repoPath, threadId);
  if (!content) return [];
  const out: PromptTimelineEntry[] = [];
  for (const line of content.split('\n')) {
    if (!line.trim()) continue;
    try {
      const event = JSON.parse(line);
      const eventType = event?.type || event?.event || '';
      if (eventType !== 'item.created' && eventType !== 'message') continue;
      const item = event?.data || event?.item || event;
      const role = item?.role || item?.type;
      if (role !== 'user' && role !== 'human') continue;
      const content_ = item?.content || item?.text || item?.message;
      const text = typeof content_ === 'string'
        ? content_
        : Array.isArray(content_)
          ? content_.map((c: any) => c?.text || c?.content || '').join('')
          : '';
      if (!text || !text.trim()) continue;
      // Drop the AGENTS.md / origin-managed echo: Codex reads AGENTS.md
      // natively and replays it as the first user-role message in the
      // rollout. The user-prompt-submit hook already filters this for
      // the live `prompt` capture path; we apply the same filter here
      // so the dashboard's session view doesn't show Origin's own
      // system block as turn 1.
      if (text.includes('<!-- origin-managed -->')) continue;
      if (/^#\s+AGENTS\.md instructions for /m.test(text)) continue;
      // Codex also wraps the AGENTS.md content in <INSTRUCTIONS>...</INSTRUCTIONS>
      // — if that's everything in the message, drop it.
      const stripped = text.replace(/<INSTRUCTIONS>[\s\S]*?<\/INSTRUCTIONS>/g, '').trim();
      if (!stripped) continue;
      // Codex events carry an ISO-ish timestamp on most variants.
      const tsRaw = event?.timestamp || event?.ts || event?.time || event?.created_at || item?.timestamp;
      const ts = tsRaw ? new Date(tsRaw).getTime() : NaN;
      out.push({ text: stripped, timestamp: Number.isFinite(ts) ? ts : 0 });
    } catch { /* skip */ }
  }
  // If timestamps are missing, preserve insertion order (the JSONL itself is
  // chronological).
  return out;
}


// Exported for the pricing-regression test suite — it asserts that
// a real rollout fixture parses into the documented token/cost shape
// (non-cached input, cached reads, reasoning folded into output).
// This is the only public consumer; production callers go through
// `discoverCodexSessionData` above.
export function parseCodexRollout(
  codexDir: string,
  rolloutPath: string,
  threadId: string,
  opts: { verbose?: boolean } = {},
): { tokensUsed: number; inputTokens: number; outputTokens: number; cacheReadTokens?: number; model?: string; turnCount: number; toolCalls: number; transcript?: string; userPrompts?: string[] } | null {
  try {
    // Try to resolve the rollout file
    let rolloutFile = '';

    if (rolloutPath && fs.existsSync(rolloutPath)) {
      rolloutFile = rolloutPath;
    } else if (rolloutPath) {
      // rollout_path might be relative to codexDir
      const abs = path.join(codexDir, rolloutPath);
      if (fs.existsSync(abs)) rolloutFile = abs;
    }

    // If no rollout_path, scan the sessions directory for most recent file
    // matching this thread ID
    if (!rolloutFile) {
      const sessionsDir = path.join(codexDir, 'sessions');
      if (fs.existsSync(sessionsDir)) {
        rolloutFile = findLatestRollout(sessionsDir, threadId);
      }
    }

    if (!rolloutFile) return null;

    // Read + decompress. Previously relied on `zstd` CLI or `python3+zstandard`
    // which many users don't have installed — token capture silently degraded
    // to character-based estimation. fzstd is a pure-JS decoder (~20KB) so this
    // path now works on any machine with just Node.
    let content: string;
    if (rolloutFile.endsWith('.zst') || rolloutFile.endsWith('.zstd')) {
      try {
        const compressed = fs.readFileSync(rolloutFile);
        const decompressed = fzstd.decompress(new Uint8Array(compressed));
        content = Buffer.from(decompressed).toString('utf-8');
      } catch (err) {
        debugLog('codex', 'fzstd decompress failed', { error: String(err) });
        return null;
      }
    } else {
      content = fs.readFileSync(rolloutFile, 'utf-8');
    }

    // Parse JSONL events
    const lines = content.split('\n').filter(l => l.trim());
    let maxInputTokens = 0;
    let maxOutputTokens = 0;
    // OpenAI's `input_tokens` includes the cached portion as a subset,
    // so we track `cached_input_tokens` separately and subtract on
    // the way out — the cost path needs them split (cached is billed
    // at $0.50/M for gpt-5.5, regular is $5/M).
    let maxCachedInputTokens = 0;
    // Codex/gpt-5 reasoning tokens land in a separate field but are
    // billed at the output rate. Add to outputTokens on the way out
    // so neither the cost nor the tokensUsed total under-reports.
    let maxReasoningOutputTokens = 0;
    let maxTotalTokens = 0;
    let model: string | undefined;
    let turnCount = 0;
    let toolCalls = 0;

    // Build transcript from conversation events
    const turns: Array<{ role: string; content: string }> = [];

    // Truncation budget for tool args/output. Verbose mode keeps the full
    // payload so reviewers can see exactly what the agent ran; default mode
    // keeps each side ≤ 2 KB so a long session's transcript stays uploadable.
    const TOOL_TRUNC = opts.verbose ? Number.MAX_SAFE_INTEGER : 2000;
    const truncate = (s: string, max: number = TOOL_TRUNC): string =>
      s.length > max ? s.slice(0, max) + `… [+${s.length - max} chars]` : s;

    // Pending tool calls keyed by call_id so we can attach their outputs
    // when the matching `function_call_output` arrives.
    const pendingTools = new Map<string, number>();  // call_id → turns[] index

    const extractMessageText = (content_: any): string => {
      if (typeof content_ === 'string') return content_;
      if (!Array.isArray(content_)) return '';
      return content_
        .map((c: any) => {
          if (!c) return '';
          if (typeof c === 'string') return c;
          // Codex content blocks: {type: "input_text"|"output_text", text: "..."}
          if (c.text) return c.text;
          if (c.content) return typeof c.content === 'string' ? c.content : '';
          return '';
        })
        .filter(Boolean)
        .join('');
    };

    for (const line of lines) {
      try {
        const event = JSON.parse(line);

        // Extract token usage from TokenCountEvent or turn.completed events.
        // Codex emits multiple shapes across versions — check the union.
        const tokenUsage =
          event?.total_token_usage ||
          event?.data?.total_token_usage ||
          event?.payload?.info?.total_token_usage ||
          event?.payload?.total_token_usage ||
          event?.payload?.usage ||
          event?.usage ||
          event?.data?.usage;

        if (tokenUsage) {
          const input = tokenUsage.input_tokens || tokenUsage.prompt_tokens || 0;
          const output = tokenUsage.output_tokens || tokenUsage.completion_tokens || 0;
          // Codex (responses-API) emits these on every TokenCountEvent.
          // OpenAI's older Chat Completions shape nests cache under
          // `prompt_tokens_details.cached_tokens`; cover both so we
          // don't silently drop cache info on legacy rollouts.
          const cached =
            tokenUsage.cached_input_tokens ||
            tokenUsage.prompt_tokens_details?.cached_tokens ||
            0;
          const reasoning =
            tokenUsage.reasoning_output_tokens ||
            tokenUsage.completion_tokens_details?.reasoning_tokens ||
            tokenUsage.reasoning_tokens ||
            0;
          const total = tokenUsage.total_tokens || (input + output);
          if (total > maxTotalTokens) {
            maxInputTokens = input;
            maxOutputTokens = output;
            maxCachedInputTokens = cached;
            maxReasoningOutputTokens = reasoning;
            maxTotalTokens = total;
          }
        }

        // Extract model from thread/turn/session events
        if (!model && (event?.model || event?.data?.model || event?.payload?.model)) {
          model = event.model || event.data?.model || event.payload?.model;
        }

        const eventType = event?.type || event?.event || '';
        const payload = event?.payload;
        const payloadType = payload?.type || '';

        // ── New-shape Codex rollouts: response_item events ────────────────
        // Each conversation item is wrapped as {type: "response_item", payload: {...}}.
        // The payload's `type` distinguishes message / reasoning / function_call /
        // function_call_output / local_shell_call.
        if (payloadType === 'message') {
          const role = payload.role || 'assistant';
          const text = extractMessageText(payload.content);
          if (text.trim()) {
            // Drop the AGENTS.md / origin-managed echo and Codex's
            // own <environment_context> session-init wrapper on
            // user-role turns. Codex replays both as the first user
            // events in the rollout; the dashboard renders the
            // whole transcript so without this they show up as
            // bogus turn 1 / 2 even though state.prompts filters them.
            const isUser = role === 'user' || role === 'human';
            const isEcho = isUser && (
              text.includes('<!-- origin-managed -->') ||
              /^#\s+AGENTS\.md instructions for /m.test(text)
            );
            if (!isEcho) {
              const cleaned = isUser
                ? text
                    .replace(/<INSTRUCTIONS>[\s\S]*?<\/INSTRUCTIONS>/g, '')
                    .replace(/<environment_context>[\s\S]*?<\/environment_context>/g, '')
                    .replace(/<user_instructions>[\s\S]*?<\/user_instructions>/g, '')
                    .trim()
                : text;
              if (cleaned) turns.push({ role, content: cleaned });
            }
          }
        } else if (payloadType === 'reasoning') {
          // Chain-of-thought summary — show as assistant reasoning so reviewers
          // can see the agent's plan, not just its actions.
          const summary = Array.isArray(payload.summary) ? payload.summary : [];
          const text = summary.map((s: any) => s?.text || '').filter(Boolean).join('\n\n');
          if (text.trim()) {
            turns.push({ role: 'assistant', content: `[Reasoning] ${text}` });
          }
        } else if (payloadType === 'function_call' || payloadType === 'local_shell_call') {
          toolCalls++;
          const tool = payload.name || (payloadType === 'local_shell_call' ? 'shell' : 'tool');
          const rawArgs = payload.arguments ?? payload.action ?? payload.command ?? '';
          const argStr = typeof rawArgs === 'string' ? rawArgs : JSON.stringify(rawArgs);
          const callId = payload.call_id || payload.id || '';
          const idx = turns.length;
          turns.push({ role: 'assistant', content: `[Tool: ${tool}] ${truncate(argStr)}` });
          if (callId) pendingTools.set(callId, idx);
        } else if (payloadType === 'function_call_output' || payloadType === 'local_shell_call_output') {
          const callId = payload.call_id || payload.id || '';
          const out = typeof payload.output === 'string'
            ? payload.output
            : (payload.output?.content
                ? (typeof payload.output.content === 'string'
                    ? payload.output.content
                    : JSON.stringify(payload.output.content))
                : JSON.stringify(payload.output ?? ''));
          if (out) {
            const idx = callId ? pendingTools.get(callId) : undefined;
            if (idx !== undefined) {
              turns[idx].content += `\n[Output] ${truncate(out)}`;
              pendingTools.delete(callId);
            } else {
              turns.push({ role: 'assistant', content: `[Output] ${truncate(out)}` });
            }
          }
        } else if (eventType === 'item.created' || eventType === 'message') {
          // ── Legacy/older-shape rollouts ─────────────────────────────────
          const item = event?.data || event?.item || event;
          const role = item?.role || item?.type;
          const content_ = item?.content || item?.text || item?.message;
          if (role && content_) {
            const text = extractMessageText(content_);
            if (text) {
              // Same AGENTS.md echo filter as the response_item path.
              const isUser = role === 'user' || role === 'human';
              const isEcho = isUser && (
                text.includes('<!-- origin-managed -->') ||
                /^#\s+AGENTS\.md instructions for /m.test(text)
              );
              if (!isEcho) {
                const cleaned = isUser
                  ? text
                      .replace(/<INSTRUCTIONS>[\s\S]*?<\/INSTRUCTIONS>/g, '')
                      .replace(/<environment_context>[\s\S]*?<\/environment_context>/g, '')
                      .replace(/<user_instructions>[\s\S]*?<\/user_instructions>/g, '')
                      .trim()
                  : text;
                if (cleaned) turns.push({ role, content: cleaned });
              }
            }
          }
        } else if (
          eventType === 'tool_call' || eventType === 'function_call' ||
          event?.data?.type === 'function_call' || event?.data?.type === 'shell'
        ) {
          toolCalls++;
          const tool = event?.data?.name || event?.data?.command || event?.name || 'tool';
          const args = event?.data?.arguments || event?.data?.args || '';
          const argStr = typeof args === 'string' ? args : JSON.stringify(args);
          turns.push({ role: 'assistant', content: `[Tool: ${tool}] ${truncate(argStr)}` });
        }

        // Track turns
        if (eventType === 'turn.completed' || eventType === 'turn.started') {
          turnCount++;
        }
      } catch {
        // Skip malformed lines
      }
    }

    // Don't bail when token usage hasn't fired yet — the rollout often
    // contains a fully-formed transcript before the TokenCountEvent
    // lands (especially when stop hooks fire mid-stream). Returning null
    // here used to drop the entire conversation; now we keep whatever
    // we parsed and let the next heartbeat / stop event refresh tokens.
    if (maxTotalTokens === 0 && turns.length === 0) return null;

    // Extract every cleaned user prompt in the order they appear. Used by
    // the Stop hook / heartbeat to grow state.prompts for Codex sessions,
    // since Codex's UserPromptSubmit hook is unreliable (Codex auto-trust
    // edge cases) and the singleton SQLite `first_user_message` only
    // surfaces prompt 0 — so without this every prompt after the first was
    // missing a per-prompt diff mapping on the dashboard.
    const userPrompts: string[] = [];
    for (const t of turns) {
      if (t.role === 'user' || t.role === 'human') {
        const cleaned = t.content.trim();
        if (cleaned) userPrompts.push(cleaned);
      }
    }

    // Split cached out of input, fold reasoning into output. This is
    // the contract the rest of the pipeline expects:
    //   inputTokens     — NON-cached prompt tokens (billed at full
    //                     model input rate)
    //   cacheReadTokens — cached subset (billed at the cached rate,
    //                     e.g. $0.50/M for gpt-5.5)
    //   outputTokens    — visible output + reasoning, both billed at
    //                     the output rate
    //   tokensUsed      — grand total including reasoning, so the
    //                     dashboard token column doesn't under-report
    //                     deep-thinking sessions
    const nonCachedInputTokens = Math.max(0, maxInputTokens - maxCachedInputTokens);
    const billableOutputTokens = maxOutputTokens + maxReasoningOutputTokens;
    const grandTotalTokens = nonCachedInputTokens + maxCachedInputTokens + billableOutputTokens;

    return {
      tokensUsed: grandTotalTokens,
      inputTokens: nonCachedInputTokens,
      outputTokens: billableOutputTokens,
      cacheReadTokens: maxCachedInputTokens,
      model,
      turnCount,
      toolCalls,
      transcript: turns.length > 0 ? JSON.stringify(turns) : undefined,
      userPrompts: userPrompts.length > 0 ? userPrompts : undefined,
    };
  } catch (err) {
    debugLog('codex', 'parseCodexRollout error', { error: String(err) });
    return null;
  }
}

/**
 * Scan ~/.codex/sessions/ for the most recent rollout file, optionally
 * matching a thread ID in the filename.
 */
export function findLatestRollout(sessionsDir: string, threadId: string): string {
  let best = '';
  let bestMtime = 0;

  // sessions/YYYY/MM/DD/rollout-*.jsonl(.zst)
  try {
    const years = fs.readdirSync(sessionsDir).filter(d => /^\d{4}$/.test(d));
    for (const year of years.slice(-1)) {  // only check latest year
      const yearDir = path.join(sessionsDir, year);
      const months = fs.readdirSync(yearDir).filter(d => /^\d{2}$/.test(d));
      for (const month of months.slice(-2)) {  // last 2 months
        const monthDir = path.join(yearDir, month);
        const days = fs.readdirSync(monthDir).filter(d => /^\d{2}$/.test(d));
        for (const day of days) {
          const dayDir = path.join(monthDir, day);
          const files = fs.readdirSync(dayDir).filter(f => f.includes('rollout') || f.endsWith('.jsonl') || f.endsWith('.jsonl.zst'));
          for (const file of files) {
            const fp = path.join(dayDir, file);
            // Prefer files matching the thread ID
            if (threadId && file.includes(threadId)) return fp;
            const stat = fs.statSync(fp);
            if (stat.mtimeMs > bestMtime) {
              bestMtime = stat.mtimeMs;
              best = fp;
            }
          }
        }
      }
    }
  } catch {
    // ignore
  }

  return best;
}

// ─── Hook Handlers ─────────────────────────────────────────────────────────

