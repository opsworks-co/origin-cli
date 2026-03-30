import { loadConfig, loadAgentConfig, saveAgentConfig, loadRepoConfig, isConnectedMode, ensureConfigDir } from '../config.js';
import crypto from 'crypto';
import { detectTools } from '../tools-detector.js';
import { api } from '../api.js';
import { parseTranscript, estimateCost, formatTranscriptForDisplay, extractPromptFileMappings, setActivePricing } from '../transcript.js';
import {
  saveSessionState,
  loadSessionState,
  clearSessionState,
  findSessionByClaudeId,
  listActiveSessions,
  listAllActiveSessions,
  getGitDir,
  getGitRoot,
  discoverGitRoot,
  getHeadSha,
  getBranch,
  startHeartbeat,
  stopHeartbeat,
  isHeartbeatAlive,
  getStatePath,
  type SessionState,
  type SubagentRecord,
} from '../session-state.js';
import { captureGitState } from '../git-capture.js';
import { writeSessionFiles, pushSessionBranch, type PromptEntry, type PromptChange, type SessionWriteData } from '../local-entrypoint.js';
import { writeGitNotes } from '../git-notes.js';
import { redactSecrets } from '../redaction.js';
import { findTrailByBranch, addSessionToTrail } from '../trail-state.js';
import { buildAttributionContext, buildFileAttributionContext } from '../attribution.js';
import { writeHandoff, buildHandoffContext, extractTodosFromPrompts } from '../handoff.js';
import { writeSessionMemory, buildMemoryContext } from '../memory.js';
import { execSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import os from 'os';

// ─── Debug Logger ─────────────────────────────────────────────────────────

const DEBUG_LOG = path.join(os.homedir(), '.origin', 'hooks.log');

function debugLog(event: string, message: string, data?: any): void {
  try {
    const timestamp = new Date().toISOString();
    let line = `[${timestamp}] [${event}] ${message}`;
    if (data !== undefined) {
      line += ' ' + JSON.stringify(data, null, 0);
    }
    line += '\n';
    fs.appendFileSync(DEBUG_LOG, line, { mode: 0o600 });
  } catch {
    // Never fail on logging
  }
}

// ─── Cursor Model Detection ──────────────────────────────────────────────
// Cursor always sends model:"default" in hooks. Read the actual model from
// Cursor's internal SQLite database (~/.cursor/ai-tracking/ai-code-tracking.db).

function getCursorModelFromDb(conversationId: string): string | null {
  try {
    // Validate conversationId to prevent SQL injection via shell command
    if (!/^[a-zA-Z0-9_-]+$/.test(conversationId)) return null;

    const dbPath = path.join(os.homedir(), '.cursor', 'ai-tracking', 'ai-code-tracking.db');
    if (!fs.existsSync(dbPath)) return null;

    // Use sqlite3 CLI to query — avoids native module dependency
    const result = execSync(
      `sqlite3 "${dbPath}" "SELECT model FROM conversation_summaries WHERE conversationId='${conversationId.replace(/'/g, "''")}' LIMIT 1"`,
      { encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'], timeout: 2000 },
    ).trim();
    if (result && result !== 'default' && result !== 'unknown') return result;

    // Fallback: check tracked_file_content or ai_code_hashes for this conversation
    const result2 = execSync(
      `sqlite3 "${dbPath}" "SELECT DISTINCT model FROM tracked_file_content WHERE conversationId='${conversationId.replace(/'/g, "''")}' AND model IS NOT NULL AND model != '' LIMIT 1"`,
      { encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'], timeout: 2000 },
    ).trim();
    if (result2 && result2 !== 'default' && result2 !== 'unknown') return result2;

    const result3 = execSync(
      `sqlite3 "${dbPath}" "SELECT DISTINCT model FROM ai_code_hashes WHERE conversationId='${conversationId.replace(/'/g, "''")}' AND model IS NOT NULL AND model != '' LIMIT 1"`,
      { encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'], timeout: 2000 },
    ).trim();
    if (result3 && result3 !== 'default' && result3 !== 'unknown') return result3;
  } catch {
    // sqlite3 not available or DB locked — non-fatal
  }
  return null;
}

/**
 * Read Cursor conversation summary from its SQLite DB.
 * Returns { title, tldr, overview, summaryBullets } or null.
 * Used to populate session output when no transcript is available.
 */
function getCursorConversationSummary(conversationId: string): { title: string; tldr: string; overview: string; summaryBullets: string } | null {
  try {
    if (!/^[a-zA-Z0-9_-]+$/.test(conversationId)) return null;
    const dbPath = path.join(os.homedir(), '.cursor', 'ai-tracking', 'ai-code-tracking.db');
    if (!fs.existsSync(dbPath)) return null;

    const result = execSync(
      `sqlite3 -separator '|||' "${dbPath}" "SELECT title, tldr, overview, summaryBullets FROM conversation_summaries WHERE conversationId='${conversationId.replace(/'/g, "''")}' LIMIT 1"`,
      { encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'], timeout: 2000 },
    ).trim();
    if (!result) return null;
    const parts = result.split('|||');
    return {
      title: (parts[0] || '').trim(),
      tldr: (parts[1] || '').trim(),
      overview: (parts[2] || '').trim(),
      summaryBullets: (parts[3] || '').trim(),
    };
  } catch {
    return null;
  }
}

// ─── Session Write Helper ─────────────────────────────────────────────────

import type { ParsedTranscript, PromptFileMapping } from '../transcript.js';

/**
 * Assemble SessionWriteData from hook state + parsed transcript + git capture.
 * Shared by handleStop, handleSessionEnd, and handlePostCommit.
 */
function buildSessionWriteData(opts: {
  state: SessionState;
  parsed: ParsedTranscript;
  promptMappings: PromptFileMapping[];
  gitCapture: { headBefore: string; headAfter: string; commitShas: string[]; linesAdded: number; linesRemoved: number; commitDetails?: Array<{ filesChanged: string[] }> };
  status: 'running' | 'ended';
  apiUrl: string;
  extraFiles?: string[];
}): SessionWriteData {
  const { state, parsed, promptMappings, gitCapture, status, apiUrl, extraFiles } = opts;

  const prompts = parsed.prompts.length > 0 ? parsed.prompts : state.prompts;
  const model = parsed.model || state.model;
  const durationMs = Date.now() - new Date(state.startedAt).getTime();
  const branch = getBranch(state.repoPath) || state.branch || '';

  // Merge file lists and make paths relative to repo root
  // Fall back to git-captured files if transcript parsing found none
  const repoRoot = state.repoPath || '';
  let transcriptFiles = parsed.filesChanged;
  if (transcriptFiles.length === 0 && gitCapture.commitDetails) {
    const gitFiles = new Set<string>();
    for (const commit of gitCapture.commitDetails) {
      for (const f of commit.filesChanged) gitFiles.add(f);
    }
    transcriptFiles = Array.from(gitFiles);
  }
  const allFiles = Array.from(new Set([
    ...transcriptFiles,
    ...(extraFiles || []),
  ])).map(f => f.startsWith(repoRoot) ? f.slice(repoRoot.length + 1) : f);

  // Helper to make paths relative to repo root
  const rel = (f: string) => f.startsWith(repoRoot) ? f.slice(repoRoot.length + 1) : f;

  // Build PromptEntry[] — match prompts to their file changes
  const promptEntries: PromptEntry[] = prompts.map((text, i) => {
    const mapping = promptMappings.find(m => m.promptIndex === i);
    return {
      index: i + 1,
      text: typeof text === 'string' ? text : String(text),
      filesChanged: (mapping?.filesChanged || []).map(rel),
    };
  });

  // Build PromptChange[] from mappings
  const changes: PromptChange[] = promptMappings.map(m => ({
    promptIndex: m.promptIndex + 1,
    promptText: m.promptText.slice(0, 200),
    filesChanged: m.filesChanged.map(rel),
    diff: m.diff,
  }));

  return {
    sessionId: state.sessionId,
    model,
    startedAt: state.startedAt,
    endedAt: new Date().toISOString(),
    durationMs,
    status,
    costUsd: estimateCost(model, parsed.inputTokens, parsed.outputTokens, parsed.cacheReadTokens, parsed.cacheCreationTokens),
    tokensUsed: parsed.tokensUsed,
    inputTokens: parsed.inputTokens,
    outputTokens: parsed.outputTokens,
    toolCalls: parsed.toolCalls,
    linesAdded: gitCapture.linesAdded,
    linesRemoved: gitCapture.linesRemoved,
    prompts: promptEntries,
    filesChanged: allFiles,
    git: {
      branch,
      headBefore: gitCapture.headBefore || '',
      headAfter: gitCapture.headAfter || '',
      commitShas: gitCapture.commitShas,
    },
    summary: parsed.summary,
    originUrl: `${apiUrl}/sessions/${state.sessionId}`,
    changes,
  };
}

// ─── Stdin Reader ──────────────────────────────────────────────────────────

async function readStdin(): Promise<Record<string, any>> {
  return new Promise((resolve) => {
    let data = '';
    process.stdin.setEncoding('utf-8');
    process.stdin.on('data', (chunk: string) => { data += chunk; });
    process.stdin.on('end', () => {
      try {
        const parsed = JSON.parse(data);
        debugLog('stdin', 'parsed', { keys: Object.keys(parsed), cwd: parsed.cwd, session_id: parsed.session_id, model: parsed.model });
        resolve(parsed);
      } catch {
        debugLog('stdin', 'parse-failed', { dataLength: data.length, preview: data.slice(0, 200) });
        resolve({});
      }
    });
    // If stdin is already closed or not a TTY, resolve after a short timeout
    if (process.stdin.isTTY) {
      debugLog('stdin', 'isTTY=true, resolving empty');
      resolve({});
    }
  });
}

// ─── Shell Escape ─────────────────────────────────────────────────────────

function escapeShellArg(arg: string): string {
  return "'" + arg.replace(/'/g, "'\\''") + "'";
}

// ─── Agent-Model Mapping ──────────────────────────────────────────────────

/**
 * Maps agent slugs to regex patterns that match their model strings.
 * Used for reliable agent-to-session matching instead of fragile substring checks.
 */
const AGENT_MODEL_PATTERNS: Record<string, RegExp> = {
  'claude': /claude|anthropic|sonnet|opus|haiku/i,
  'gemini': /gemini|google/i,
  'cursor': /cursor|composer|gpt|openai/i,
  'codex': /codex/i,
  'aider': /aider/i,
  'windsurf': /windsurf|codeium/i,
  'copilot': /copilot/i,
  'continue': /continue/i,
  'amp': /amp/i,
  'junie': /junie|jetbrains/i,
  'opencode': /opencode/i,
  'rovo': /rovo/i,
  'droid': /droid/i,
};

/**
 * Check if a session's model field matches the given agent slug.
 */
function sessionMatchesAgent(session: SessionState, agentSlug: string): boolean {
  const model = (session.model || '').toLowerCase();
  const slug = agentSlug.toLowerCase();
  const pattern = AGENT_MODEL_PATTERNS[slug];
  if (pattern) return pattern.test(model);
  // Fallback for unknown agents: exact substring match
  return model.includes(slug) || slug.includes(model);
}

/**
 * Write Origin policies to agent-specific rules/instructions files.
 * Cursor: ~/.cursor/rules/origin.md
 * Codex: AGENTS.md in project root (Codex reads this natively)
 * Claude Code: uses systemMessage from stdout (no file needed)
 */
function writeAgentRulesFile(agentSlug: string, systemMsg: string, repoPath: string): void {
  if (!systemMsg || !agentSlug) return;

  let target: string | undefined;
  if (agentSlug === 'cursor') {
    target = path.join(os.homedir(), '.cursor', 'rules', 'origin.md');
  } else if (agentSlug === 'codex') {
    // Codex reads AGENTS.md from project root
    target = path.join(repoPath, 'AGENTS.md');
  }

  if (target) {
    fs.mkdirSync(path.dirname(target), { recursive: true });
    // For AGENTS.md, wrap with a marker so we only replace our section
    if (agentSlug === 'codex') {
      const marker = '<!-- origin-managed -->';
      const content = `${marker}\n${systemMsg}\n${marker}`;
      const existingContent = fs.existsSync(target) ? fs.readFileSync(target, 'utf-8') : '';
      const markerRegex = new RegExp(`${marker}[\\s\\S]*?${marker}`, 'g');
      if (existingContent.includes(marker)) {
        fs.writeFileSync(target, existingContent.replace(markerRegex, content));
      } else if (existingContent.trim()) {
        fs.writeFileSync(target, existingContent + '\n\n' + content);
      } else {
        fs.writeFileSync(target, content);
      }
    } else {
      fs.writeFileSync(target, systemMsg);
    }
    debugLog('session-start', 'agent rules file written', { agent: agentSlug, path: target });
  }
}

// ─── Concurrent Session State Lookup ──────────────────────────────────────

/**
 * Find the correct session state for a hook invocation.
 *
 * With concurrent session support, each Claude Code window has its own
 * state file (tagged by sessionTag). This helper finds the right one by:
 * 1. Exact match on claudeSessionId (current or stored in state)
 * 2. Agent-filtered match using model patterns (when agentSlug is provided)
 * 3. Single active session (unambiguous — safe to use)
 * 4. Returns null when multiple sessions exist and no reliable match is found,
 *    to avoid misattributing commits to the wrong session.
 *
 * Returns the state and the resolved cwd to use for saving.
 */
function findStateForHook(hookCwd: string, claudeSessionId?: string, agentSlug?: string): { state: SessionState; saveCwd: string } | null {
  const repoPath = discoverGitRoot(hookCwd) || hookCwd;

  // Debug: log what listActiveSessions finds
  const debugSessions1 = listActiveSessions(hookCwd);
  const debugSessions2 = hookCwd !== repoPath ? listActiveSessions(repoPath) : [];
  debugLog('findStateForHook', 'scanning', {
    hookCwd, repoPath,
    sessionsInHookCwd: debugSessions1.length,
    sessionsInRepoPath: debugSessions2.length,
    tags: [...debugSessions1, ...debugSessions2].map(s => s.sessionTag),
  });

  // 1. If we have a claude session ID, try exact match
  if (claudeSessionId) {
    const found = findSessionByClaudeId(claudeSessionId, hookCwd)
      || (repoPath !== hookCwd ? findSessionByClaudeId(claudeSessionId, repoPath) : null);
    if (found) {
      debugLog('findStateForHook', 'exact match', { claudeSessionId, sessionId: found.sessionId, tag: found.sessionTag });
      return { state: found, saveCwd: found.repoPath || repoPath };
    }
  }

  // 2. Fall back to active sessions for this repo
  let sessions = listActiveSessions(hookCwd);
  if (sessions.length === 0 && repoPath !== hookCwd) {
    sessions = listActiveSessions(repoPath);
  }

  if (sessions.length > 0) {
    sessions.sort((a, b) => new Date(b.startedAt).getTime() - new Date(a.startedAt).getTime());

    // Single session — no ambiguity, safe to use
    if (sessions.length === 1) {
      const best = sessions[0];
      debugLog('findStateForHook', 'single active session', { sessionId: best.sessionId, model: best.model, tag: best.sessionTag });
      return { state: best, saveCwd: best.repoPath || repoPath };
    }

    // Multiple sessions — require agent match to avoid misattribution
    if (agentSlug) {
      const matching = sessions.filter(s => sessionMatchesAgent(s, agentSlug));
      if (matching.length > 0) {
        const best = matching[0]; // already sorted by startedAt desc
        debugLog('findStateForHook', 'agent-filtered match', {
          agentSlug,
          model: best.model,
          sessionId: best.sessionId,
          tag: best.sessionTag,
          candidateCount: matching.length,
        });
        return { state: best, saveCwd: best.repoPath || repoPath };
      }
    }

    // Multiple sessions, no agent-specific match found.
    // If we know the agent slug, pick the most recent session — it's better than
    // returning null (which causes auto-create and duplicate sessions).
    if (agentSlug) {
      const best = sessions[0]; // already sorted by startedAt desc
      debugLog('findStateForHook', 'multiple sessions, using most recent', {
        agentSlug,
        sessionId: best.sessionId,
        model: best.model,
        tag: best.sessionTag,
        totalSessions: sessions.length,
      });
      return { state: best, saveCwd: best.repoPath || repoPath };
    }

    // No agent slug at all — truly ambiguous
    debugLog('findStateForHook', 'ambiguous: multiple sessions, no agent slug', {
      claudeSessionId,
      totalSessions: sessions.length,
      sessionModels: sessions.map(s => ({ id: s.sessionId, model: s.model })),
    });
    return null;
  }

  // 3. Legacy: try untagged state file (backward compat before concurrent support)
  const legacy = loadSessionState(hookCwd) || (repoPath !== hookCwd ? loadSessionState(repoPath) : null);
  if (legacy) {
    debugLog('findStateForHook', 'legacy untagged match', { sessionId: legacy.sessionId });
    return { state: legacy, saveCwd: legacy.repoPath || repoPath };
  }

  debugLog('findStateForHook', 'no state found', { hookCwd, repoPath, claudeSessionId });
  return null;
}

// ─── Gemini Transcript Discovery ──────────────────────────────────────────

/**
 * Gemini CLI stores transcripts in ~/.gemini/tmp/<workspace>/chats/session-*.json
 * If the hook doesn't receive transcript_path via stdin, try to find the most
 * recently modified session file.
 */
function discoverGeminiTranscriptPath(): string | null {
  try {
    const geminiTmpDir = path.join(os.homedir(), '.gemini', 'tmp');
    if (!fs.existsSync(geminiTmpDir)) return null;

    // Walk through workspace dirs to find the newest session file
    let newestFile = '';
    let newestMtime = 0;

    const workspaces = fs.readdirSync(geminiTmpDir);
    for (const ws of workspaces) {
      const chatsDir = path.join(geminiTmpDir, ws, 'chats');
      if (!fs.existsSync(chatsDir)) continue;
      const files = fs.readdirSync(chatsDir).filter(f => f.startsWith('session-') && f.endsWith('.json'));
      for (const f of files) {
        const fp = path.join(chatsDir, f);
        const stat = fs.statSync(fp);
        if (stat.mtimeMs > newestMtime) {
          newestMtime = stat.mtimeMs;
          newestFile = fp;
        }
      }
    }

    // Only use it if modified within the last 10 minutes (likely the active session)
    if (newestFile && (Date.now() - newestMtime) < 10 * 60 * 1000) {
      return newestFile;
    }
    return null;
  } catch {
    return null;
  }
}

// ─── Codex Session Data Discovery ─────────────────────────────────────────

interface CodexSessionData {
  model: string;
  tokensUsed: number;
  inputTokens: number;
  outputTokens: number;
  prompt: string;
}

/**
 * Codex CLI stores session data in ~/.codex/state_*.sqlite.
 * Extract the most recent thread's data using the sqlite3 CLI.
 */
function discoverCodexSessionData(repoPath: string): CodexSessionData | null {
  try {
    const codexDir = path.join(os.homedir(), '.codex');
    // Find the most recent state sqlite file
    const stateFiles = fs.readdirSync(codexDir)
      .filter(f => f.startsWith('state_') && f.endsWith('.sqlite'))
      .map(f => ({ name: f, path: path.join(codexDir, f), mtime: fs.statSync(path.join(codexDir, f)).mtimeMs }))
      .sort((a, b) => b.mtime - a.mtime);
    if (stateFiles.length === 0) return null;

    const dbPath = stateFiles[0].path;

    // Find the most recent thread matching this repo's cwd
    // Validate repoPath basename to prevent SQL/shell injection
    const repoBasename = path.basename(repoPath);
    if (!/^[a-zA-Z0-9_.\-]+$/.test(repoBasename)) return null;
    const escapedBasename = repoBasename.replace(/%/g, '\\%').replace(/_/g, '\\_');
    const threadQuery = `SELECT model, tokens_used, first_user_message FROM threads WHERE cwd LIKE '%${escapedBasename}%' ORDER BY updated_at DESC LIMIT 1;`;
    const raw = execSync(`sqlite3 "${dbPath}" "${threadQuery}"`, {
      encoding: 'utf-8',
      timeout: 3000,
      stdio: ['pipe', 'pipe', 'pipe'],
    }).trim();

    if (!raw) return null;
    const parts = raw.split('|');
    if (parts.length < 3) return null;

    return {
      model: parts[0] || 'codex',
      tokensUsed: parseInt(parts[1], 10) || 0,
      inputTokens: Math.round((parseInt(parts[1], 10) || 0) * 0.7), // estimate
      outputTokens: Math.round((parseInt(parts[1], 10) || 0) * 0.3),
      prompt: parts.slice(2).join('|') || '',
    };
  } catch {
    return null;
  }
}

// ─── Hook Handlers ─────────────────────────────────────────────────────────

async function handleSessionStart(input: Record<string, any>, agentSlug?: string): Promise<void> {
  debugLog('session-start', 'begin', { agentSlug, inputKeys: Object.keys(input) });

  const config = loadConfig();
  let agentConfig = loadAgentConfig();
  const connected = isConnectedMode();

  // In standalone mode, create minimal agent config if missing
  if (!agentConfig) {
    if (connected) {
      debugLog('session-start', 'ABORT: missing agent config (run origin init)', { hasConfig: !!config });
      return;
    }
    // Auto-create minimal agent config for standalone
    agentConfig = {
      machineId: crypto.randomUUID(),
      hostname: os.hostname(),
      detectedTools: detectTools(),
      orgId: 'local',
    };
    ensureConfigDir();
    saveAgentConfig(agentConfig);
    debugLog('session-start', 'auto-created agent config (standalone)', { machineId: agentConfig.machineId });
  }

  // Fetch latest model pricing from API (non-blocking, falls back to defaults)
  if (connected) {
    try {
      const { pricing } = await api.getPricing();
      if (pricing && typeof pricing === 'object') {
        setActivePricing(pricing);
        debugLog('session-start', 'pricing fetched from API', { models: Object.keys(pricing).length });
      }
    } catch (err: any) {
      debugLog('session-start', 'pricing fetch failed, using defaults', { error: err.message });
    }
  }

  // Skip background agents (Cursor fires session-start for background indexing agents)
  if (input.is_background_agent === true || input.is_background_agent === 'true') {
    debugLog('session-start', 'SKIP: background agent', { is_background_agent: input.is_background_agent });
    return;
  }

  // Use cwd from hook input (Claude Code passes this), or workspace_roots (Cursor),
  // or fall back to process.cwd()
  let hookCwd = input.cwd || process.cwd();
  // Cursor sends workspace_roots instead of cwd — ALWAYS prefer workspace_roots
  // because Cursor runs hooks from ~/.cursor/ (not the project dir) and process.cwd()
  // may point to a completely different repo.
  if (input.workspace_roots && Array.isArray(input.workspace_roots) && input.workspace_roots.length > 0) {
    const wsRoot = input.workspace_roots[0];
    if (typeof wsRoot === 'string' && getGitRoot(wsRoot)) {
      hookCwd = wsRoot;
    }
  }
  debugLog('session-start', 'cwd resolved', { hookCwd, inputCwd: input.cwd, workspaceRoots: input.workspace_roots, processCwd: process.cwd() });

  // Only track sessions in git repos — no repo means no code to govern
  // Use discoverGitRoot to handle cases where cwd is a parent of the actual repo
  // (e.g. Claude Code reports /project but the repo is /project/.openclaw/workspace/repo)
  const repoPath = discoverGitRoot(hookCwd);
  if (!repoPath) {
    debugLog('session-start', 'SKIP: not a git repo (even after discovery)', { hookCwd });
    return;
  }
  debugLog('session-start', 'repo path resolved', { repoPath, hookCwd, discovered: repoPath !== getGitRoot(hookCwd) });

  // Resolve agent slug: .origin.json → agentSlugs override → hook command slug → saved default → undefined
  const repoConfig = loadRepoConfig(repoPath);
  const baseSlug = repoConfig?.agent || agentSlug || agentConfig.agentSlug || undefined;
  // Apply per-tool slug override from config (e.g. agentSlugs.claude-code = "claude-front")
  // Check both the hook command slug and the resolved base slug as override keys
  const slugOverrides = config?.agentSlugs || {};
  const slugOverride = (agentSlug && slugOverrides[agentSlug]) || (baseSlug && slugOverrides[baseSlug]) || undefined;
  const finalAgentSlug = slugOverride || baseSlug;
  debugLog('session-start', 'agent resolved', {
    fromRepoConfig: repoConfig?.agent,
    fromHookCommand: agentSlug,
    fromSavedDefault: agentConfig.agentSlug,
    baseSlug,
    configAgentSlugs: slugOverrides,
    slugOverride: slugOverride || null,
    final: finalAgentSlug,
  });

  // Cursor sends session_id but it changes per conversation/prompt — not stable.
  // Only treat session_id as a stable identifier for agents that keep it consistent
  // (Claude Code, Windsurf). For others (Cursor, Codex, Gemini), ignore it.
  // Use the original hook command slug (agentSlug) for behavior checks, not the
  // overridden finalAgentSlug which may be a custom name like "claude-front".
  const agentsWithStableSessionId = ['claude-code', 'windsurf'];
  const hasStableSessionId = agentsWithStableSessionId.includes(agentSlug || '');
  const claudeSessionId = hasStableSessionId ? (input.session_id || '') : '';
  let transcriptPath = input.transcript_path || '';

  // ── Concurrent session support ─────────────────────────────────────────────
  // Each Claude Code window gets its own tagged state file so multiple sessions
  // on the same repo don't overwrite each other.
  // Generate a stable session tag from this Claude session ID.
  const sessionTag = claudeSessionId
    ? claudeSessionId.slice(0, 12)
    : `s${Date.now().toString(36)}`;
  debugLog('session-start', 'session tag', { sessionTag, claudeSessionId });

  // ── Deduplicate: skip if we already have an active session for this Claude session ──
  if (claudeSessionId) {
    const existing = findSessionByClaudeId(claudeSessionId, repoPath);
    if (existing && existing.sessionId) {
      debugLog('session-start', 'SKIP: session already exists for this Claude session', {
        existingSessionId: existing.sessionId,
        claudeSessionId,
      });
      return;
    }
  }

  // ── Clean up stale sessions for non-Claude agents (Gemini, Codex, etc.) ──────
  // These agents don't provide a session_id, so we can't deduplicate by ID.
  // If SessionEnd didn't fire (user Ctrl+C'd, terminal closed), old state files
  // linger and subsequent hooks attach to the wrong session.
  // On session-start, force-end any prior sessions for the same agent in this repo.
  // BUT for Cursor/Codex, session-start fires on every prompt — don't end previous,
  // just reuse the existing session.
  const agentsWithPerPromptSessionStart = ['cursor', 'codex'];
  if (!claudeSessionId && !agentsWithPerPromptSessionStart.includes(agentSlug || '')) {
    const staleSessions = agentSlug ? listActiveSessions(repoPath).filter(s => sessionMatchesAgent(s, agentSlug)) : listActiveSessions(repoPath);
    for (const stale of staleSessions) {
      debugLog('session-start', 'cleaning up stale session for same agent', {
        staleSessionId: stale.sessionId,
        staleTag: stale.sessionTag,
        agent: finalAgentSlug,
      });
      // Kill the old heartbeat so it stops pinging
      stopHeartbeat(stale.sessionId);
      if (connected && stale.sessionId) {
        try {
          const durationMs = Date.now() - new Date(stale.startedAt).getTime();
          await api.endSession({
            sessionId: stale.sessionId,
            prompt: stale.prompts.join('\n\n---\n\n') || undefined,
            durationMs: durationMs > 0 ? durationMs : undefined,
            branch: stale.branch || undefined,
          });
        } catch (err: any) {
          debugLog('session-start', 'stale session end failed (non-fatal)', { message: err.message });
        }
      }
      clearSessionState(repoPath, stale.sessionTag);
      if (repoPath !== hookCwd) clearSessionState(hookCwd, stale.sessionTag);
    }
  }

  // For Cursor: session-start fires on every prompt, so reuse existing session.
  // For Codex: session-start fires per conversation, so always create new session
  //   but clean up old orphaned ones first.
  // First, clean up orphaned sessions whose heartbeats died (e.g. Mac sleep).
  const agentsWithSessionReuse = ['cursor']; // Only Cursor reuses sessions
  if (agentsWithPerPromptSessionStart.includes(agentSlug || '')) {
    const allActive = listActiveSessions(repoPath).filter(s => sessionMatchesAgent(s, finalAgentSlug || ''));
    for (const s of allActive) {
      const hbPidFile = path.join(os.homedir(), '.origin', 'heartbeats', `${s.sessionId}.pid`);
      let heartbeatAlive = false;
      try {
        const hbPid = parseInt(fs.readFileSync(hbPidFile, 'utf-8').trim(), 10);
        if (hbPid > 0) { process.kill(hbPid, 0); heartbeatAlive = true; }
      } catch { /* pid file missing or process dead */ }
      if (!heartbeatAlive) {
        debugLog('session-start', 'ending orphaned session (heartbeat dead)', {
          sessionId: s.sessionId, tag: s.sessionTag, agent: finalAgentSlug,
        });
        stopHeartbeat(s.sessionId);
        if (connected && s.sessionId) {
          try {
            const durationMs = Date.now() - new Date(s.startedAt).getTime();
            await api.endSession({
              sessionId: s.sessionId,
              prompt: s.prompts.join('\n\n---\n\n') || undefined,
              durationMs: durationMs > 0 ? durationMs : undefined,
              branch: s.branch || undefined,
            });
          } catch {}
        }
        clearSessionState(repoPath, s.sessionTag);
        if (repoPath !== hookCwd) clearSessionState(hookCwd, s.sessionTag);
      }
    }

    // For Cursor only: look for a valid active session to reuse
    // Codex always gets a new session — skip reuse entirely.
    let existing: SessionState | null = null;
    if (agentsWithSessionReuse.includes(agentSlug || '')) {
      existing = listActiveSessions(repoPath).find(s => sessionMatchesAgent(s, agentSlug || '')) || null;
      // Also check global archive — the .git/ file might have been cleaned up
      if (!existing) {
        try {
          const archiveDir = path.join(os.homedir(), '.origin', 'sessions');
          const entries = fs.readdirSync(archiveDir).filter(f => f.endsWith('.json'));
          const MAX_AGE_MS = 24 * 60 * 60 * 1000; // 24 hours
          for (const entry of entries) {
            try {
              const s = JSON.parse(fs.readFileSync(path.join(archiveDir, entry), 'utf-8'));
              if (!s?.sessionId || !s?.startedAt) continue;
              if (Date.now() - new Date(s.startedAt).getTime() > MAX_AGE_MS) continue;
              if (s.status === 'ENDED' && s.endedAt) continue;
              if (s.repoPath === repoPath && sessionMatchesAgent(s, agentSlug || '')) {
                existing = s;
                break;
              }
            } catch { /* skip corrupt file */ }
          }
        } catch { /* no archive dir */ }
      }
    }
    if (existing) {
      debugLog('session-start', 'reusing existing session for per-prompt agent', {
        sessionId: existing.sessionId,
        tag: existing.sessionTag,
        agent: finalAgentSlug,
      });
      // Touch the state file to keep it fresh
      saveSessionState(existing, repoPath, existing.sessionTag);

      // Output system message
      let systemMsg = '';
      if (existing.agentSystemPrompt) systemMsg += existing.agentSystemPrompt + '\n\n';
      systemMsg += 'Origin: Session tracking active \u2014 prompts, files, and tokens will be captured.';
      if (existing.activePolicies && Array.isArray(existing.activePolicies) && existing.activePolicies.length > 0) {
        systemMsg += '\n\nActive policies for this session:\n' +
          existing.activePolicies.map((p: string) => `- ${p}`).join('\n');
      }
      try {
        const attributionCtx = buildAttributionContext(repoPath);
        if (attributionCtx) systemMsg += '\n\n' + attributionCtx;
      } catch {}
      const isCursorReuse = agentSlug === 'cursor';
      const outputKeyReuse = isCursorReuse ? 'additional_context' : 'systemMessage';
      process.stdout.write(JSON.stringify({ [outputKeyReuse]: systemMsg }));

      // Write rules file for reused sessions too
      try {
        writeAgentRulesFile(finalAgentSlug || '', systemMsg, repoPath);
      } catch {}

      return;
    }
  }

  // Clean up legacy untagged state file if it exists (one-time migration).
  // This prevents old untagged files from confusing concurrent lookups.
  const legacyState = loadSessionState(hookCwd) || loadSessionState(repoPath);
  if (legacyState && !legacyState.sessionTag) {
    debugLog('session-start', 'migrating legacy untagged session', {
      oldSessionId: legacyState.sessionId,
    });
    if (connected) {
      try {
        const durationMs = Date.now() - new Date(legacyState.startedAt).getTime();
        await api.endSession({
          sessionId: legacyState.sessionId,
          prompt: legacyState.prompts.join('\n\n---\n\n') || undefined,
          durationMs: durationMs > 0 ? durationMs : undefined,
          branch: legacyState.branch || undefined,
        });
      } catch (err: any) {
        debugLog('session-start', 'legacy session end failed (non-fatal)', { message: err.message });
      }
    }
    clearSessionState(hookCwd);
    if (repoPath !== hookCwd) clearSessionState(repoPath);
  }

  // Auto-discover Gemini transcript if not provided via stdin
  if (!transcriptPath && agentSlug === 'gemini') {
    transcriptPath = discoverGeminiTranscriptPath() || '';
    if (transcriptPath) debugLog('session-start', 'auto-discovered transcript path', { transcriptPath });
  }

  // Resolve model: use stdin value, fall back to Cursor DB, then agent default
  let model = input.model || '';
  if (!model || model === 'unknown' || model === 'default') {
    // Cursor always sends model:"default" — try to read real model from its SQLite DB
    if (agentSlug === 'cursor' && input.conversation_id) {
      const cursorModel = getCursorModelFromDb(input.conversation_id);
      if (cursorModel) {
        model = cursorModel;
        debugLog('session-start', 'model from Cursor DB', { model: cursorModel, conversationId: input.conversation_id });
      }
    }
  }
  if (!model || model === 'unknown' || model === 'default') {
    const AGENT_DEFAULT_MODELS: Record<string, string> = {
      'gemini': 'gemini',
      'claude-code': 'claude',
      'cursor': 'cursor',
      'windsurf': 'windsurf',
      'codex': 'codex',
      'aider': 'aider',
    };
    model = AGENT_DEFAULT_MODELS[finalAgentSlug || ''] || 'unknown';
  }

  // Extract git remote origin URL for smarter repo matching on the API side
  let repoUrl = '';
  try {
    repoUrl = execSync('git remote get-url origin', { cwd: repoPath, encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] }).trim();
    debugLog('session-start', 'git remote origin url', { repoUrl });
  } catch {
    debugLog('session-start', 'no git remote origin (non-fatal)');
  }

  const branch = getBranch(repoPath) || getBranch(hookCwd);
  debugLog('session-start', 'branch resolved', { branch, repoPath, hookCwd });

  // ── Re-detect tools on every session start ─────────────────────────────────
  try {
    const freshTools = detectTools();
    const oldTools = agentConfig.detectedTools || [];
    const changed = freshTools.length !== oldTools.length ||
      freshTools.some(t => !oldTools.includes(t)) ||
      oldTools.some(t => !freshTools.includes(t));

    if (changed) {
      debugLog('session-start', 'tools changed', { old: oldTools, new: freshTools });
      agentConfig.detectedTools = freshTools;
      agentConfig.lastToolDetection = new Date().toISOString();
      saveAgentConfig(agentConfig);
      // Update server with new tool list (only in connected mode)
      if (connected) {
        try {
          await api.registerMachine({
            hostname: agentConfig.hostname,
            machineId: agentConfig.machineId,
            detectedTools: freshTools,
          });
          debugLog('session-start', 'machine re-registered with updated tools');
        } catch (regErr: any) {
          debugLog('session-start', 'machine re-registration failed (non-fatal)', { message: regErr.message });
        }
      }
    } else {
      debugLog('session-start', 'tools unchanged', { tools: freshTools });
    }
  } catch (detectErr: any) {
    debugLog('session-start', 'tool detection failed (non-fatal)', { message: detectErr.message });
  }

  try {
    let sessionId: string;
    let agentSystemPrompt: string | undefined;
    let activePolicies: string[] | undefined;
    let enforcementRules: any[] | undefined;

    if (connected) {
      // ── Connected mode: register session with Origin platform ──
      try {
        debugLog('session-start', 'calling api.startSession', { machineId: agentConfig.machineId, model, repoPath, repoUrl, agentSlug: finalAgentSlug, branch });
        const result = await api.startSession({
          machineId: agentConfig.machineId,
          prompt: '',
          model,
          repoPath,
          repoUrl: repoUrl || undefined,
          agentSlug: finalAgentSlug,
          branch: branch || undefined,
          hostname: agentConfig.hostname || undefined,
        });
        sessionId = result.sessionId;
        agentSystemPrompt = result.agentSystemPrompt || undefined;
        activePolicies = result.activePolicies && Array.isArray(result.activePolicies) ? result.activePolicies : undefined;
        enforcementRules = result.enforcementRules && Array.isArray(result.enforcementRules) ? result.enforcementRules : undefined;
        debugLog('session-start', 'api returned', { sessionId });
      } catch (apiErr: any) {
        // API failed — fall back to local session instead of aborting entirely
        debugLog('session-start', 'API failed, falling back to local', { message: apiErr.message });
        process.stderr.write(`[origin] API error (falling back to local): ${apiErr.message}\n`);
        sessionId = `local-${crypto.randomUUID()}`;
      }
    } else {
      // ── Standalone mode: generate local session ID ──
      sessionId = `local-${crypto.randomUUID()}`;
      debugLog('session-start', 'standalone session', { sessionId });
    }

    const state: SessionState = {
      sessionId,
      claudeSessionId,
      transcriptPath,
      model,
      startedAt: new Date().toISOString(),
      prompts: [],
      repoPath,
      headShaAtStart: getHeadSha(hookCwd),
      headShaAtLastStop: null,
      branch,
      sessionTag,
      agentSystemPrompt,
      activePolicies,
      enforcementRules,
    };

    // Save to tagged file — each concurrent session gets its own state file
    saveSessionState(state, repoPath, sessionTag);
    debugLog('session-start', 'state saved', { sessionId, sessionTag });

    // Auto-attach session to active trail on the current branch
    if (branch) {
      try {
        const trail = findTrailByBranch(repoPath, branch);
        if (trail && (trail.status === 'active' || trail.status === 'review')) {
          addSessionToTrail(repoPath, trail.id, sessionId);
          state.trailId = trail.id;
          saveSessionState(state, repoPath, sessionTag);
          debugLog('session-start', 'auto-attached to trail', { trailId: trail.id, trailName: trail.name });
        }
      } catch (trailErr: any) {
        debugLog('session-start', 'trail auto-attach failed (non-fatal)', { message: trailErr.message });
      }
    }

    // Start background heartbeat daemon (both connected and standalone mode)
    // In standalone: heartbeat detects parent process death + state file staleness → auto-ends session
    {
      const stateFile = getStatePath(repoPath, sessionTag);
      const hbApiUrl = (connected && config) ? (config.apiUrl || 'https://getorigin.io') : '';
      const hbApiKey = (connected && config) ? config.apiKey : '';
      startHeartbeat(sessionId, hbApiUrl, hbApiKey, stateFile, finalAgentSlug);
      debugLog('session-start', 'heartbeat started', { sessionId, stateFile, agentSlug: finalAgentSlug, standalone: !connected });
    }

    // Build system message: agent system prompt first, then tracking notice + policies + attribution
    let systemMsg = '';
    if (agentSystemPrompt) {
      systemMsg += agentSystemPrompt + '\n\n';
    }
    systemMsg += 'Origin: Session tracking active \u2014 prompts, files, and tokens will be captured.';
    if (!connected) {
      systemMsg += ' (standalone mode)';
    }
    if (activePolicies && Array.isArray(activePolicies) && activePolicies.length > 0) {
      systemMsg += '\n\nActive policies for this session:\n' +
        activePolicies.map((p: string) => `- ${p}`).join('\n');
    }

    // Inject AI attribution context so the agent knows what other agents have done
    try {
      const attributionCtx = buildAttributionContext(repoPath);
      if (attributionCtx) {
        systemMsg += '\n\n' + attributionCtx;
        debugLog('session-start', 'attribution context injected', { length: attributionCtx.length });
      }
    } catch {
      // Non-fatal — skip attribution context if it fails
    }

    // Inject cross-agent handoff context (from previous session, possibly different agent)
    try {
      const handoffCtx = buildHandoffContext(repoPath);
      if (handoffCtx) {
        systemMsg += '\n\n' + handoffCtx;
        debugLog('session-start', 'handoff context injected', { length: handoffCtx.length });
      }
    } catch {
      // Non-fatal
    }

    // Inject session memory (last 3 session summaries for this repo)
    try {
      const memoryCtx = buildMemoryContext(repoPath);
      if (memoryCtx) {
        systemMsg += '\n\n' + memoryCtx;
        debugLog('session-start', 'memory context injected', { length: memoryCtx.length });
      }
    } catch {
      // Non-fatal
    }

    // Cursor uses `additional_context`, Claude Code / others use `systemMessage`
    const isCursor = agentSlug === 'cursor';
    const outputKey = isCursor ? 'additional_context' : 'systemMessage';
    const output = JSON.stringify({ [outputKey]: systemMsg });
    process.stdout.write(output);
    debugLog('session-start', 'system prompt injected', { key: outputKey, length: systemMsg.length });

    // Write rules files so agents natively see Origin policies
    if (systemMsg) {
      try {
        writeAgentRulesFile(finalAgentSlug || '', systemMsg, repoPath);
      } catch {
        // Non-fatal
      }
    }
  } catch (err: any) {
    debugLog('session-start', 'ERROR', { message: err.message, stack: err.stack });
    const status = err.status || 0;
    if (status === 401) {
      process.stderr.write(`[origin] Session blocked — invalid or expired API key. Run \`origin login\` to re-authenticate.\n`);
    } else if (status === 403) {
      process.stderr.write(`[origin] Session blocked — ${err.message}\n`);
    } else if (status === 429) {
      process.stderr.write(`[origin] Session blocked — budget limit reached. ${err.message}\n`);
    } else if (err.message?.includes('Unknown agent') || err.message?.includes('not registered')) {
      process.stderr.write(`[origin] Agent not registered. Ask your admin to add it in the Origin dashboard.\n`);
    } else {
      process.stderr.write(`[origin] session-start error: ${err.message}\n`);
    }
  }
}

async function handleUserPromptSubmit(input: Record<string, any>, agentSlug?: string): Promise<void> {
  debugLog('user-prompt-submit', 'begin', { hasPrompt: !!input.prompt, cwd: input.cwd, workspace_roots: input.workspace_roots });

  let hookCwd = input.cwd || process.cwd();
  // Cursor sends workspace_roots instead of cwd
  if (input.workspace_roots && Array.isArray(input.workspace_roots) && input.workspace_roots.length > 0) {
    const wsRoot = input.workspace_roots[0];
    debugLog('user-prompt-submit', 'workspace_roots check', { wsRoot, isString: typeof wsRoot === 'string', gitRoot: typeof wsRoot === 'string' ? getGitRoot(wsRoot) : null });
    if (typeof wsRoot === 'string' && getGitRoot(wsRoot)) {
      hookCwd = wsRoot;
    }
  }
  debugLog('user-prompt-submit', 'cwd resolved', { hookCwd });

  // ── Find session state using concurrent-aware lookup ────────────────────────
  // For agents with unstable session_id (Cursor, Codex), don't use it for lookup
  const stableAgents = ['claude-code', 'windsurf'];
  const lookupSessionId = stableAgents.includes(agentSlug || '') ? input.session_id : undefined;
  const found = findStateForHook(hookCwd, lookupSessionId, agentSlug);
  let state = found?.state || null;

  if (state) {
    // Update Claude session ID and transcript path if they changed
    // (agent subprocesses may have different session_id)
    const incomingSessionId = input.session_id || '';
    if (incomingSessionId && stableAgents.includes(agentSlug || '') && state.claudeSessionId !== incomingSessionId) {
      debugLog('user-prompt-submit', 'updating claudeSessionId', {
        old: state.claudeSessionId,
        new: incomingSessionId,
        originSession: state.sessionId,
        tag: state.sessionTag,
      });
      state.claudeSessionId = incomingSessionId;
    }
    if (input.transcript_path) state.transcriptPath = input.transcript_path;
    saveSessionState(state, found!.saveCwd, state.sessionTag);
  }
  if (!state) {
    // Before auto-creating, try to recover from archive (session state file may have been
    // deleted by a stale cleanup or heartbeat, but the archive still has the session).
    // Only for agents that REUSE sessions (Cursor). For Codex and others that create
    // new sessions per conversation, recovering old sessions causes stale headShaAtStart
    // which makes diffs show old changes.
    const agentsWithArchiveRecovery = ['cursor'];
    if (agentsWithArchiveRecovery.includes(agentSlug || '')) {
      try {
        const recoveryRepoPath = discoverGitRoot(hookCwd) || hookCwd;
        const archiveDir = path.join(os.homedir(), '.origin', 'sessions');
        const archiveEntries = fs.readdirSync(archiveDir).filter(f => f.endsWith('.json'));
        const MAX_RECOVERY_AGE_MS = 24 * 60 * 60 * 1000;
        let bestCandidate: SessionState | null = null;
        let bestAge = Infinity;
        for (const entry of archiveEntries) {
          try {
            const s = JSON.parse(fs.readFileSync(path.join(archiveDir, entry), 'utf-8'));
            if (!s?.sessionId || !s?.startedAt) continue;
            const age = Date.now() - new Date(s.startedAt).getTime();
            if (age > MAX_RECOVERY_AGE_MS) continue;
            if (s.status === 'ENDED' && s.endedAt) continue;
            if (s.repoPath !== recoveryRepoPath) continue;
            if (agentSlug && !sessionMatchesAgent(s, agentSlug)) continue;
            if (age < bestAge) {
              bestCandidate = s;
              bestAge = age;
            }
          } catch { /* skip */ }
        }
        if (bestCandidate) {
          debugLog('user-prompt-submit', 'recovered session from archive', {
            sessionId: bestCandidate.sessionId,
            tag: bestCandidate.sessionTag,
            ageMin: Math.round(bestAge / 60000),
          });
          // Restore the .git state file so subsequent hooks can find it
          saveSessionState(bestCandidate, recoveryRepoPath, bestCandidate.sessionTag);
          state = bestCandidate;
        }
      } catch { /* no archive dir — fall through to auto-create */ }
    }
  }
  if (!state) {
    // No existing session at all — auto-create one (first prompt without SessionStart)
    debugLog('user-prompt-submit', 'no session state — attempting auto-create', { hookCwd });
    const autoConfig = loadConfig();
    let autoAgentConfig = loadAgentConfig();
    const repoPath = discoverGitRoot(hookCwd);
    if (repoPath) {
      try {
        // Auto-create agent config in standalone mode
        if (!autoAgentConfig) {
          autoAgentConfig = {
            machineId: crypto.randomUUID(),
            hostname: os.hostname(),
            detectedTools: detectTools(),
            orgId: 'local',
          };
          ensureConfigDir();
          saveAgentConfig(autoAgentConfig);
        }
        const repoConfig = loadRepoConfig(repoPath);
        const baseSlug = repoConfig?.agent || agentSlug || autoAgentConfig.agentSlug || undefined;
        const autoSlugs = autoConfig?.agentSlugs || {};
        const slugOverride = (agentSlug && autoSlugs[agentSlug]) || (baseSlug && autoSlugs[baseSlug]) || undefined;
        const finalAgentSlug = slugOverride || baseSlug;
        const branch = getBranch(hookCwd);
        const model = input.model || (agentSlug === 'gemini' ? 'gemini' : agentSlug === 'codex' ? 'codex' : 'claude');
        const autoTag = (input.session_id || '').slice(0, 12) || `s${Date.now().toString(36)}`;

        // Get git remote URL for better repo matching on the server
        let repoUrl = '';
        try {
          repoUrl = execSync('git remote get-url origin', { cwd: repoPath, encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] }).trim();
        } catch { /* no remote — that's fine */ }

        let sessionId: string;
        let agentSystemPrompt: string | undefined;
        let activePolicies: string[] | undefined;
        let enforcementRules: any[] | undefined;
        if (isConnectedMode() && autoConfig) {
          const result = await api.startSession({
            machineId: autoAgentConfig.machineId,
            prompt: input.prompt || '',
            model,
            repoPath,
            repoUrl: repoUrl || undefined,
            agentSlug: finalAgentSlug,
            branch: branch || undefined,
          });
          sessionId = result.sessionId;
          agentSystemPrompt = result.agentSystemPrompt || undefined;
          activePolicies = result.activePolicies && Array.isArray(result.activePolicies) ? result.activePolicies : undefined;
          enforcementRules = result.enforcementRules && Array.isArray(result.enforcementRules) ? result.enforcementRules : undefined;
          debugLog('user-prompt-submit', 'api returned policies', { sessionId, policiesCount: activePolicies?.length || 0, rulesCount: enforcementRules?.length || 0 });
        } else {
          sessionId = `local-${crypto.randomUUID()}`;
        }

        debugLog('user-prompt-submit', 'auto-created session', { sessionId, sessionTag: autoTag, repoPath, repoUrl });
        state = {
          sessionId,
          claudeSessionId: input.session_id || '',
          transcriptPath: input.transcript_path || '',
          model,
          startedAt: new Date().toISOString(),
          prompts: [],
          repoPath,
          headShaAtStart: getHeadSha(hookCwd),
          headShaAtLastStop: null,
          branch,
          sessionTag: autoTag,
          agentSystemPrompt,
          activePolicies,
          enforcementRules,
        };
        saveSessionState(state, repoPath, autoTag);

        // Start heartbeat for auto-created sessions so they don't get cleaned up as stale
        const connected = isConnectedMode();
        if (connected && autoConfig) {
          const stateFile = getStatePath(repoPath, autoTag);
          startHeartbeat(sessionId, autoConfig.apiUrl || 'https://getorigin.io', autoConfig.apiKey, stateFile, finalAgentSlug);
          debugLog('user-prompt-submit', 'heartbeat started for auto-created session', { sessionId, stateFile, agentSlug: finalAgentSlug });
        }
      } catch (err: any) {
        debugLog('user-prompt-submit', 'auto-create failed, falling back to local', { message: err.message });
        const status = err.status || 0;
        if (status === 401) {
          process.stderr.write(`[origin] API key invalid — session tracked locally. Run \`origin login\`.\n`);
        } else if (status === 403) {
          process.stderr.write(`[origin] ${err.message} — session tracked locally.\n`);
        } else if (status === 429) {
          process.stderr.write(`[origin] Budget limit reached — session tracked locally.\n`);
        }
        // Always create a local fallback session so tracking continues
        if (!state && repoPath) {
          const fbId = `local-${crypto.randomUUID()}`;
          const fbModel = input.model || agentSlug || 'unknown';
          const fbBranch = getBranch(hookCwd);
          const fbTag = (input.session_id || '').slice(0, 12) || `s${Date.now().toString(36)}`;
          state = {
            sessionId: fbId,
            claudeSessionId: input.session_id || '',
            transcriptPath: input.transcript_path || '',
            model: fbModel,
            startedAt: new Date().toISOString(),
            prompts: [],
            repoPath,
            headShaAtStart: getHeadSha(hookCwd),
            headShaAtLastStop: null,
            branch: fbBranch,
            sessionTag: fbTag,
          };
          saveSessionState(state, repoPath, fbTag);
          debugLog('user-prompt-submit', 'local fallback session created', { sessionId: fbId, sessionTag: fbTag });
        }
      }
    }
  }

  if (!state) {
    debugLog('user-prompt-submit', 'ABORT: no session state', { hookCwd });
    return;
  }

  const prompt = input.prompt || '';
  if (prompt) {
    state.prompts.push(prompt);

    // Update transcript path if provided (may change between turns)
    if (input.transcript_path) {
      state.transcriptPath = input.transcript_path;
    }

    // Ensure session stays RUNNING (may have been auto-expired by listAllActiveSessions)
    state.status = 'RUNNING';
    saveSessionState(state, state.repoPath || hookCwd, state.sessionTag);
    debugLog('user-prompt-submit', 'prompt saved', { promptCount: state.prompts.length, sessionId: state.sessionId, tag: state.sessionTag });

    // ── Heartbeat: send incremental update to API on every prompt (connected mode only) ──
    try {
      const config = loadConfig();
      if (config && isConnectedMode()) {
        const durationMs = Date.now() - new Date(state.startedAt).getTime();

        // Try to parse transcript for live token/cost data
        let parsed: ParsedTranscript | null = null;
        let displayTranscript = '';
        try {
          if (state.transcriptPath) {
            parsed = parseTranscript(state.transcriptPath);
            displayTranscript = formatTranscriptForDisplay(state.transcriptPath);
          }
        } catch {
          // Transcript may not be readable mid-session for all agents
        }

        const model = parsed?.model || state.model;
        // Estimate tokens from prompt text when no transcript data exists (Codex, etc.)
        let hbInputTokens = parsed?.inputTokens || 0;
        let hbOutputTokens = parsed?.outputTokens || 0;
        let hbTokensUsed = parsed?.tokensUsed || 0;
        if (hbTokensUsed === 0 && state.prompts.length > 0) {
          const totalChars = state.prompts.reduce((sum, p) => sum + p.length, 0);
          hbInputTokens = Math.round(totalChars / 4);
          hbOutputTokens = hbInputTokens * 3;
          hbTokensUsed = hbInputTokens + hbOutputTokens;
        }
        const costUsd = hbTokensUsed > 0
          ? estimateCost(model, hbInputTokens, hbOutputTokens, parsed?.cacheReadTokens || 0, parsed?.cacheCreationTokens || 0)
          : 0;

        // Redact secrets from prompts
        const shouldRedact = config.secretRedaction !== false;
        const redactedPrompts = shouldRedact
          ? state.prompts.map(p => redactSecrets(p).redacted)
          : state.prompts;
        const joinedPrompt = redactedPrompts.join('\n\n---\n\n');

        await api.updateSession(state.sessionId, {
          prompt: joinedPrompt || undefined,
          transcript: displayTranscript || undefined,
          model: model && model !== 'unknown' && model !== 'default' ? model : undefined,
          filesChanged: parsed?.filesChanged && parsed.filesChanged.length > 0 ? parsed.filesChanged : undefined,
          tokensUsed: hbTokensUsed || undefined,
          inputTokens: hbInputTokens || undefined,
          outputTokens: hbOutputTokens || undefined,
          toolCalls: parsed?.toolCalls || undefined,
          durationMs: durationMs > 0 ? durationMs : undefined,
          costUsd: costUsd > 0 ? costUsd : undefined,
          status: 'RUNNING',
        });
        debugLog('user-prompt-submit', 'heartbeat sent', { sessionId: state.sessionId, promptCount: state.prompts.length, costUsd });

        // Restart heartbeat daemon if it died (e.g., Mac sleep killed it)
        if (!isHeartbeatAlive(state.sessionId)) {
          const saveCwd = found?.saveCwd || hookCwd;
          const stateFile = getStatePath(saveCwd, state.sessionTag);
          startHeartbeat(state.sessionId, config.apiUrl || 'https://getorigin.io', config.apiKey, stateFile, agentSlug);
          debugLog('user-prompt-submit', 'heartbeat daemon restarted (was dead)', { sessionId: state.sessionId, agentSlug });
        }
      }
    } catch (err: any) {
      debugLog('user-prompt-submit', 'heartbeat error (non-fatal)', { message: err.message });
      // Non-fatal — don't block the agent
    }
  }

  // ── Output system message for agents that read it from beforeSubmitPrompt (e.g. Cursor) ──
  // Cursor doesn't reliably consume systemMessage from sessionStart, so we also
  // inject it here on every prompt submission.
  try {
    let systemMsg = '';
    if (state.agentSystemPrompt) {
      systemMsg += state.agentSystemPrompt + '\n\n';
    }
    systemMsg += 'Origin: Session tracking active \u2014 prompts, files, and tokens will be captured.';
    if (!isConnectedMode()) {
      systemMsg += ' (standalone mode)';
    }
    if (state.activePolicies && Array.isArray(state.activePolicies) && state.activePolicies.length > 0) {
      systemMsg += '\n\nActive policies for this session:\n' +
        state.activePolicies.map((p: string) => `- ${p}`).join('\n');
    }

    // Inject repo-level attribution context
    const repoPath = state.repoPath || hookCwd;
    try {
      const attributionCtx = buildAttributionContext(repoPath);
      if (attributionCtx) {
        systemMsg += '\n\n' + attributionCtx;
      }
    } catch {}

    if (systemMsg) {
      // Cursor uses `additional_context`, Claude Code / others use `systemMessage`
      const cursorAgents = ['cursor'];
      const outputKey = (agentSlug && cursorAgents.includes(agentSlug)) ? 'additional_context' : 'systemMessage';
      const output = JSON.stringify({ [outputKey]: systemMsg });
      process.stdout.write(output);
      debugLog('user-prompt-submit', 'systemMessage injected', { key: outputKey, length: systemMsg.length });
    }
  } catch (sysErr: any) {
    debugLog('user-prompt-submit', 'systemMessage injection failed (non-fatal)', { message: sysErr.message });
  }
}

async function handleStop(input: Record<string, any>, agentSlug?: string): Promise<void> {
  debugLog('stop', 'begin', { cwd: input.cwd, inputModel: input.model, agentSlug });

  const config = loadConfig();
  const connected = isConnectedMode();
  let hookCwd = input.cwd || process.cwd();
  // Cursor sends workspace_roots instead of cwd
  if (input.workspace_roots && Array.isArray(input.workspace_roots) && input.workspace_roots.length > 0) {
    const wsRoot = input.workspace_roots[0];
    if (typeof wsRoot === 'string' && getGitRoot(wsRoot)) {
      hookCwd = wsRoot;
    }
  }
  let found = findStateForHook(hookCwd, input.session_id, agentSlug);
  let state = found?.state || null;
  // Recover from archive if .git state file is missing (Cursor/Codex sessions)
  if (!state) {
    try {
      const recoveryRepoPath = discoverGitRoot(hookCwd) || hookCwd;
      const archiveDir = path.join(os.homedir(), '.origin', 'sessions');
      const archiveEntries = fs.readdirSync(archiveDir).filter(f => f.endsWith('.json'));
      let bestCandidate: SessionState | null = null;
      let bestAge = Infinity;
      for (const entry of archiveEntries) {
        try {
          const s = JSON.parse(fs.readFileSync(path.join(archiveDir, entry), 'utf-8'));
          if (!s?.sessionId || !s?.startedAt) continue;
          const age = Date.now() - new Date(s.startedAt).getTime();
          if (age > 24 * 60 * 60 * 1000) continue;
          if (s.status === 'ENDED' && s.endedAt) continue;
          if (s.repoPath !== recoveryRepoPath) continue;
          if (agentSlug && !sessionMatchesAgent(s, agentSlug)) continue;
          if (age < bestAge) { bestCandidate = s; bestAge = age; }
        } catch { /* skip */ }
      }
      if (bestCandidate) {
        debugLog('stop', 'recovered session from archive', { sessionId: bestCandidate.sessionId, tag: bestCandidate.sessionTag });
        saveSessionState(bestCandidate, recoveryRepoPath, bestCandidate.sessionTag);
        state = bestCandidate;
        found = { state, saveCwd: recoveryRepoPath };
      }
    } catch { /* no archive */ }
  }
  if (!state) {
    debugLog('stop', 'ABORT: missing state', { hasConfig: !!config, hasState: !!state });
    return;
  }

  // Update model from stdin if it's a real model name (Cursor sends actual model in stop, not session-start)
  if (input.model && input.model !== 'default' && input.model !== 'unknown' && input.model !== 'cursor') {
    state.model = input.model;
    debugLog('stop', 'model updated from stdin', { model: input.model });
  }

  // Update transcript path if provided
  if (input.transcript_path) {
    state.transcriptPath = input.transcript_path;
    saveSessionState(state, found!.saveCwd, state.sessionTag);
  }

  // Auto-discover Gemini transcript path if not already set
  if (!state.transcriptPath) {
    const discovered = discoverGeminiTranscriptPath();
    if (discovered) {
      state.transcriptPath = discovered;
      saveSessionState(state, found!.saveCwd, state.sessionTag);
      debugLog('stop', 'auto-discovered transcript path', { discovered });
    }
  }

  try {
    debugLog('stop', 'parsing transcript', { transcriptPath: state.transcriptPath });
    const parsed = parseTranscript(state.transcriptPath);

    // Format transcript for dashboard display (converts JSONL → [{role, content}] JSON)
    let displayTranscript = formatTranscriptForDisplay(state.transcriptPath);
    debugLog('stop', 'formatted transcript', { displayLength: displayTranscript.length });

    // For Cursor: synthesize transcript from conversation_summaries DB when no real transcript
    if (!displayTranscript && agentSlug === 'cursor' && input.conversation_id) {
      const summary = getCursorConversationSummary(input.conversation_id);
      if (summary) {
        debugLog('stop', 'cursor summary from DB', { title: summary.title, hasTldr: !!summary.tldr });
        const turns: Array<{ role: string; content: string }> = [];
        // Add user prompts
        for (const p of state.prompts) {
          turns.push({ role: 'user', content: p });
          // Build a response from available summary data
          const responseParts: string[] = [];
          if (summary.tldr) responseParts.push(summary.tldr);
          if (summary.overview && summary.overview !== summary.tldr) responseParts.push(summary.overview);
          if (summary.summaryBullets) responseParts.push(summary.summaryBullets);
          if (responseParts.length > 0) {
            turns.push({ role: 'assistant', content: responseParts.join('\n\n') });
          }
        }
        if (turns.length > 0) {
          displayTranscript = JSON.stringify(turns);
        }
      }
    }

    // For Codex: supplement with data from its SQLite database when transcript is missing
    const codexData = (!state.transcriptPath && parsed.tokensUsed === 0)
      ? discoverCodexSessionData(state.repoPath)
      : null;
    if (codexData) {
      debugLog('stop', 'supplementing with Codex SQLite data', { model: codexData.model, tokens: codexData.tokensUsed });
      if (!parsed.model) parsed.model = codexData.model;
      parsed.tokensUsed = codexData.tokensUsed;
      parsed.inputTokens = codexData.inputTokens;
      parsed.outputTokens = codexData.outputTokens;
      if (codexData.prompt && state.prompts.length === 0) {
        state.prompts.push(codexData.prompt);
      }
    }

    // Estimate tokens from prompt text when no real token data exists (Codex, agents without transcripts)
    if (parsed.tokensUsed === 0 && state.prompts.length > 0) {
      const totalPromptChars = state.prompts.reduce((sum, p) => sum + p.length, 0);
      // ~4 chars per token for English, assume 3:1 output:input ratio for coding tasks
      const estimatedInputTokens = Math.round(totalPromptChars / 4);
      const estimatedOutputTokens = estimatedInputTokens * 3;
      parsed.inputTokens = estimatedInputTokens;
      parsed.outputTokens = estimatedOutputTokens;
      parsed.tokensUsed = estimatedInputTokens + estimatedOutputTokens;
      debugLog('stop', 'estimated tokens from prompt text', { totalPromptChars, estimatedInputTokens, estimatedOutputTokens });
    }

    // Use prompts from transcript if we captured them, else from state
    const prompts = parsed.prompts.length > 0 ? parsed.prompts : state.prompts;

    // F9: Redact secrets before sending to API
    const config_ = loadConfig();
    const shouldRedact = config_?.secretRedaction !== false; // default: true
    const redactedPrompts = shouldRedact
      ? prompts.map(p => redactSecrets(p).redacted)
      : prompts;
    const joinedPrompt = redactedPrompts.join('\n\n---\n\n');

    const durationMs = Date.now() - new Date(state.startedAt).getTime();
    // Prefer: stdin model → Cursor DB → transcript → state
    const stdinModel = (input.model && input.model !== 'default' && input.model !== 'unknown') ? input.model : '';
    let model = stdinModel || parsed.model || state.model;
    // If still generic, try Cursor's SQLite DB
    if ((!model || model === 'cursor' || model === 'default') && agentSlug === 'cursor' && input.conversation_id) {
      const cursorDbModel = getCursorModelFromDb(input.conversation_id);
      if (cursorDbModel) {
        model = cursorDbModel;
        debugLog('stop', 'model from Cursor DB', { model: cursorDbModel });
      }
    }
    const costUsd = estimateCost(model, parsed.inputTokens, parsed.outputTokens, parsed.cacheReadTokens, parsed.cacheCreationTokens);

    // Extract prompt → file change mappings
    let promptMappings = extractPromptFileMappings(state.transcriptPath);
    debugLog('stop', 'prompt mappings', { count: promptMappings.length });

    // Fall back to git-captured files if transcript parsing didn't find any
    // Use per-prompt baseline (headShaAtLastStop) so each prompt only shows its own changes
    const promptBaseline = state.headShaAtLastStop || state.headShaAtStart;
    const gitCapture = captureGitState(state.repoPath, promptBaseline);
    let filesChanged = parsed.filesChanged;
    if (filesChanged.length === 0 && gitCapture.commitDetails.length > 0) {
      const gitFiles = new Set<string>();
      for (const commit of gitCapture.commitDetails) {
        for (const f of commit.filesChanged) gitFiles.add(f);
      }
      filesChanged = Array.from(gitFiles);
      debugLog('stop', 'using git-captured files (transcript had none)', { count: filesChanged.length });
    }

    // Build prompt→file mappings for the current prompt.
    // Always merge with previously saved mappings so the API's deleteMany+recreate
    // doesn't lose older prompts.
    {
      const previousMappings = state.completedPromptMappings || [];
      const currentPromptIdx = prompts.length - 1;
      const currentPromptText = prompts[currentPromptIdx] || '';

      if (promptMappings.length === 0 && prompts.length > 0) {
        // No transcript-based mappings — synthesize from git for current prompt
        const currentMapping = {
          promptIndex: currentPromptIdx,
          promptText: currentPromptText.slice(0, 1000),
          filesChanged: filesChanged,
          diff: (gitCapture.diff || '').slice(0, 200_000),
        };
        promptMappings = [...previousMappings, currentMapping];
      } else if (promptMappings.length > 0 && previousMappings.length > 0) {
        // Transcript gave us mappings for current prompt — merge with saved previous ones.
        // Deduplicate by promptIndex (current prompt's data wins over saved).
        const currentIndices = new Set(promptMappings.map(pm => pm.promptIndex));
        const kept = previousMappings.filter(pm => !currentIndices.has(pm.promptIndex));
        promptMappings = [...kept, ...promptMappings];
      }

      debugLog('stop', 'prompt mappings (merged)', {
        currentPromptIdx,
        previousCount: previousMappings.length,
        totalCount: promptMappings.length,
        filesChanged: filesChanged.length,
      });
    }

    if (connected) {
      debugLog('stop', 'calling api.updateSession', {
        sessionId: state.sessionId,
        promptCount: prompts.length,
        model,
        tokensUsed: parsed.tokensUsed,
        inputTokens: parsed.inputTokens,
        outputTokens: parsed.outputTokens,
        cacheReadTokens: parsed.cacheReadTokens,
        cacheCreationTokens: parsed.cacheCreationTokens,
        costUsd,
        promptMappings: promptMappings.length,
      });
      await api.updateSession(state.sessionId, {
        prompt: joinedPrompt || undefined,
        transcript: displayTranscript || undefined,
        model: model !== 'unknown' ? model : undefined,
        filesChanged: filesChanged.length > 0 ? filesChanged : undefined,
        tokensUsed: parsed.tokensUsed || undefined,
        inputTokens: parsed.inputTokens || undefined,
        outputTokens: parsed.outputTokens || undefined,
        toolCalls: parsed.toolCalls || undefined,
        durationMs: durationMs > 0 ? durationMs : undefined,
        costUsd: costUsd > 0 ? costUsd : undefined,
        promptChanges: promptMappings.length > 0
          ? promptMappings.map(pm => ({
              ...pm,
              promptText: (pm.promptText || '').slice(0, 1000),
              diff: (pm.diff || '').slice(0, 100_000),
            }))
          : undefined,
      });
      debugLog('stop', 'update complete');

      // Send a heartbeat ping to keep the server-side session alive
      // (prevents the server's stale session cleanup from ending it)
      try {
        await api.pingSession(state.sessionId);
      } catch { /* non-fatal */ }
    }

    // Write git notes on any commits that don't have them yet
    // This is critical for agents like Codex that may bypass .git/hooks/post-commit
    try {
      const noteCommits = gitCapture.commitDetails
        .map(c => c.sha)
        .filter(sha => /^[a-fA-F0-9]+$/.test(sha));
      if (noteCommits.length > 0) {
        const execOptsNotes = { cwd: state.repoPath, encoding: 'utf-8' as const, stdio: ['pipe', 'pipe', 'pipe'] as ['pipe', 'pipe', 'pipe'] };
        // Only write notes for commits that don't already have them
        const missingNotes = noteCommits.filter(sha => {
          try {
            execSync(`git notes --ref=origin show ${sha}`, execOptsNotes);
            return false; // already has a note
          } catch {
            return true; // no note yet
          }
        });
        if (missingNotes.length > 0) {
          writeGitNotes(state.repoPath, missingNotes, {
            sessionId: state.sessionId,
            model: model || state.model || 'unknown',
            agentSlug: agentSlug || undefined,
            promptCount: prompts.length,
            promptSummary: prompts[prompts.length - 1] || '',
            tokensUsed: parsed.tokensUsed,
            costUsd,
            durationMs: durationMs > 0 ? durationMs : 0,
            linesAdded: gitCapture.linesAdded || 0,
            linesRemoved: gitCapture.linesRemoved || 0,
            originUrl: state.sessionId ? `${config?.apiUrl || 'https://getorigin.io'}/sessions/${state.sessionId}` : '',
          });
          debugLog('stop', 'git notes written for missing commits', { count: missingNotes.length });
        }
      }
    } catch (notesErr: any) {
      debugLog('stop', 'git notes error (non-fatal)', { message: notesErr.message });
    }

    // Update per-prompt baseline so next prompt only sees its own changes
    state.headShaAtLastStop = gitCapture.headAfter;
    // Save accumulated prompt mappings so next stop can include previous prompts' data
    if (promptMappings.length > 0) {
      state.completedPromptMappings = promptMappings.map(pm => ({
        promptIndex: pm.promptIndex,
        promptText: pm.promptText,
        filesChanged: pm.filesChanged,
        diff: pm.diff,
      }));
    }
    // Re-save state with RUNNING status FIRST so it survives any errors below
    state.status = 'RUNNING';
    saveSessionState(state, found!.saveCwd, state.sessionTag);

    // Write session files to origin-sessions branch + push on every Stop
    try {
      const apiUrl = config?.apiUrl || 'https://getorigin.io';
      const writeData = buildSessionWriteData({
        state, parsed, promptMappings, gitCapture,
        status: 'running', apiUrl,
      });
      writeSessionFiles(state.repoPath, writeData);
      pushSessionBranch(state.repoPath);
      debugLog('stop', 'session files written + pushed', { prompts: writeData.prompts.length, costUsd: writeData.costUsd });
    } catch (gitErr: any) {
      debugLog('stop', 'session files write/push failed (non-fatal)', { message: gitErr.message });
    }

    // Update handoff context after each prompt stop (always fresh for next agent)
    try {
      const todos = extractTodosFromPrompts(prompts);
      writeHandoff(state.repoPath, {
        version: 1,
        sessionId: state.sessionId,
        agentSlug: agentSlug || 'unknown',
        model: model || state.model || 'unknown',
        endedAt: new Date().toISOString(),
        branch: getBranch(found!.saveCwd) || state.branch,
        prompts: prompts.map(p => p.slice(0, 500)),
        summary: parsed.summary || null,
        filesChanged,
        linesAdded: gitCapture.linesAdded || 0,
        linesRemoved: gitCapture.linesRemoved || 0,
        lastPrompt: (prompts[prompts.length - 1] || '').slice(0, 2000),
        lastResponse: null,
        openTodos: todos,
      });
    } catch {
      // Non-fatal
    }
  } catch (err: any) {
    debugLog('stop', 'ERROR', { message: err.message, stack: err.stack });
    process.stderr.write(`[origin] stop error: ${err.message}\n`);
  }
}

async function handleSessionEnd(input: Record<string, any>, agentSlug?: string): Promise<void> {
  // Cursor fires sessionEnd after each prompt/task, NOT on actual exit.
  // Treat it as an update (like Stop) so the session stays RUNNING.
  // The heartbeat daemon detects when Cursor actually exits and ends the session.
  const agentsWithFakeSessionEnd = ['cursor', 'codex'];
  if (agentsWithFakeSessionEnd.includes(agentSlug || '')) {
    debugLog('session-end', 'redirecting to handleStop (fake sessionEnd for this agent)', { agentSlug });
    return handleStop(input, agentSlug);
  }

  debugLog('session-end', 'begin', { cwd: input.cwd });

  const config = loadConfig();
  const connected = isConnectedMode();
  let hookCwd = input.cwd || process.cwd();
  // Cursor sends workspace_roots instead of cwd
  if (input.workspace_roots && Array.isArray(input.workspace_roots) && input.workspace_roots.length > 0) {
    const wsRoot = input.workspace_roots[0];
    if (typeof wsRoot === 'string' && getGitRoot(wsRoot)) {
      hookCwd = wsRoot;
    }
  }
  const found = findStateForHook(hookCwd, input.session_id, agentSlug);
  const state = found?.state || null;
  if (!state) {
    debugLog('session-end', 'ABORT: missing state', { hasConfig: !!config, hasState: !!state });
    return;
  }

  debugLog('session-end', 'state loaded', { sessionId: state.sessionId, promptCount: state.prompts.length });

  // Update transcript path if provided
  if (input.transcript_path) {
    state.transcriptPath = input.transcript_path;
  }

  // Auto-discover Gemini transcript path if not already set
  if (!state.transcriptPath) {
    const discovered = discoverGeminiTranscriptPath();
    if (discovered) {
      state.transcriptPath = discovered;
      debugLog('session-end', 'auto-discovered transcript path', { discovered });
    }
  }

  try {
    const parsed = parseTranscript(state.transcriptPath);

    // Format transcript for dashboard display (converts JSONL → [{role, content}] JSON)
    const displayTranscript = formatTranscriptForDisplay(state.transcriptPath);
    debugLog('session-end', 'formatted transcript', { displayLength: displayTranscript.length });

    const prompts = parsed.prompts.length > 0 ? parsed.prompts : state.prompts;

    // F9: Redact secrets before sending to API
    const config_ = loadConfig();
    const shouldRedact = config_?.secretRedaction !== false; // default: true
    const redactedPrompts = shouldRedact
      ? prompts.map(p => redactSecrets(p).redacted)
      : prompts;
    const joinedPrompt = redactedPrompts.join('\n\n---\n\n');

    const durationMs = Date.now() - new Date(state.startedAt).getTime();
    // Prefer: stdin model → transcript → state
    const stdinModel2 = (input.model && input.model !== 'default' && input.model !== 'unknown') ? input.model : '';
    const model = stdinModel2 || parsed.model || state.model;
    const costUsd = estimateCost(model, parsed.inputTokens, parsed.outputTokens, parsed.cacheReadTokens, parsed.cacheCreationTokens);

    // Capture real git state: HEAD SHA, new commits, unified diff
    const gitCapture = captureGitState(state.repoPath, state.headShaAtStart);

    // Extract prompt → file change mappings from transcript
    const promptMappings = extractPromptFileMappings(state.transcriptPath);

    // Fall back to git-captured files if transcript parsing didn't find any
    let filesChanged = parsed.filesChanged;
    if (filesChanged.length === 0 && gitCapture.commitDetails.length > 0) {
      const gitFiles = new Set<string>();
      for (const commit of gitCapture.commitDetails) {
        for (const f of commit.filesChanged) gitFiles.add(f);
      }
      filesChanged = Array.from(gitFiles);
      debugLog('session-end', 'using git-captured files (transcript had none)', { count: filesChanged.length });
    }

    if (connected) {
      debugLog('session-end', 'calling api.endSession', {
        sessionId: state.sessionId,
        promptCount: prompts.length,
        filesCount: filesChanged.length,
        tokensUsed: parsed.tokensUsed,
        inputTokens: parsed.inputTokens,
        outputTokens: parsed.outputTokens,
        durationMs,
        costUsd,
        hasDiff: !!gitCapture.diff,
      });

      await api.endSession({
        sessionId: state.sessionId,
        prompt: joinedPrompt || undefined,
        summary: parsed.summary || undefined,
        transcript: displayTranscript || undefined,
        filesChanged: filesChanged.length > 0 ? filesChanged : undefined,
        tokensUsed: parsed.tokensUsed || undefined,
        inputTokens: parsed.inputTokens || undefined,
        outputTokens: parsed.outputTokens || undefined,
        toolCalls: parsed.toolCalls || undefined,
        durationMs: durationMs > 0 ? durationMs : undefined,
        costUsd: costUsd > 0 ? costUsd : undefined,
        gitCapture: gitCapture.diff ? gitCapture : undefined,
        promptChanges: promptMappings.length > 0
          ? promptMappings.map(pm => ({
              ...pm,
              promptText: (pm.promptText || '').slice(0, 1000),
              diff: (pm.diff || '').slice(0, 100_000),
            }))
          : undefined,
        branch: getBranch(hookCwd) || undefined,
      });
      debugLog('session-end', 'api.endSession complete');
    }

    // Auto-attach session to active trail (safety net for auto-created sessions)
    if (!state.trailId) {
      try {
        const endBranch = getBranch(hookCwd) || state.branch;
        if (endBranch) {
          const trail = findTrailByBranch(state.repoPath, endBranch);
          if (trail && (trail.status === 'active' || trail.status === 'review')) {
            addSessionToTrail(state.repoPath, trail.id, state.sessionId);
            debugLog('session-end', 'auto-attached to trail (late)', { trailId: trail.id });
          }
        }
      } catch (trailErr: any) {
        debugLog('session-end', 'trail auto-attach failed (non-fatal)', { message: trailErr.message });
      }
    }

    // Write session files to origin-sessions branch (directory per session)
    const apiUrl = config?.apiUrl || 'https://getorigin.io';
    const writeData = buildSessionWriteData({
      state, parsed, promptMappings, gitCapture,
      status: 'ended', apiUrl,
    });
    writeSessionFiles(state.repoPath, writeData);
    pushSessionBranch(state.repoPath);
    debugLog('session-end', 'session files written + pushed');

    // Write Git Notes with AI attribution metadata on each commit
    if (gitCapture.commitShas.length > 0) {
      try {
        writeGitNotes(state.repoPath, gitCapture.commitShas, {
          sessionId: state.sessionId,
          model,
          promptCount: prompts.length,
          promptSummary: prompts[0] || '',
          tokensUsed: parsed.tokensUsed,
          costUsd,
          durationMs,
          linesAdded: gitCapture.linesAdded,
          linesRemoved: gitCapture.linesRemoved,
          originUrl: `${apiUrl}/sessions/${state.sessionId}`,
        });
        debugLog('session-end', 'git notes written', { commitCount: gitCapture.commitShas.length });
      } catch (err: any) {
        debugLog('session-end', 'git notes error (non-fatal)', { message: err.message });
      }
    }

    // Write cross-agent handoff context for next session
    try {
      const todos = extractTodosFromPrompts(prompts);
      writeHandoff(state.repoPath, {
        version: 1,
        sessionId: state.sessionId,
        agentSlug: agentSlug || 'unknown',
        model,
        endedAt: new Date().toISOString(),
        branch: getBranch(hookCwd) || state.branch,
        prompts: prompts.map(p => p.slice(0, 500)),
        summary: parsed.summary || null,
        filesChanged,
        linesAdded: gitCapture.linesAdded,
        linesRemoved: gitCapture.linesRemoved,
        lastPrompt: (prompts[prompts.length - 1] || '').slice(0, 2000),
        lastResponse: null, // Could extract from transcript later
        openTodos: todos,
      });
      debugLog('session-end', 'handoff written', { filesCount: filesChanged.length, todosCount: todos.length });
    } catch (err: any) {
      debugLog('session-end', 'handoff write error (non-fatal)', { message: err.message });
    }

    // Write session memory entry for repo history
    try {
      const todos = extractTodosFromPrompts(prompts);
      writeSessionMemory(state.repoPath, {
        sessionId: state.sessionId,
        agentSlug: agentSlug || 'unknown',
        model,
        startedAt: state.startedAt,
        endedAt: new Date().toISOString(),
        branch: getBranch(hookCwd) || state.branch,
        summary: parsed.summary || prompts[0]?.slice(0, 200) || 'No summary',
        filesChanged,
        promptCount: prompts.length,
        linesAdded: gitCapture.linesAdded,
        linesRemoved: gitCapture.linesRemoved,
        openTodos: todos,
      });
      debugLog('session-end', 'session memory written');
    } catch (err: any) {
      debugLog('session-end', 'session memory error (non-fatal)', { message: err.message });
    }
  } catch (err: any) {
    debugLog('session-end', 'ERROR', { message: err.message, stack: err.stack });
    process.stderr.write(`[origin] session-end error: ${err.message}\n`);

    // Even if transcript parsing or other steps fail, still mark the session as ended
    // so it doesn't stay RUNNING forever on the dashboard.
    if (connected) {
      try {
        const durationMs = Date.now() - new Date(state.startedAt).getTime();
        await api.endSession({
          sessionId: state.sessionId,
          prompt: state.prompts.join('\n\n---\n\n') || undefined,
          durationMs: durationMs > 0 ? durationMs : undefined,
          branch: getBranch(hookCwd) || undefined,
        });
        debugLog('session-end', 'fallback endSession succeeded');
      } catch (fallbackErr: any) {
        debugLog('session-end', 'fallback endSession also failed', { message: fallbackErr.message });
      }
    }
  } finally {
    // Stop the heartbeat daemon
    stopHeartbeat(state.sessionId);
    debugLog('session-end', 'heartbeat stopped', { sessionId: state.sessionId });

    // Clear only THIS session's state file (tagged), not other concurrent sessions
    const saveCwd = found?.saveCwd || hookCwd;
    clearSessionState(saveCwd, state.sessionTag);
    debugLog('session-end', 'state cleared', { tag: state.sessionTag, saveCwd });
  }
}

// ─── Git Hook: Post-Commit ────────────────────────────────────────────────

/**
 * Called by .git/hooks/post-commit after every commit.
 * Sends incremental session data to the API so nothing is lost
 * even if the AI session never formally ends.
 */
export async function handlePostCommit(): Promise<void> {
  debugLog('post-commit', '=== GIT HOOK INVOKED ===', { pid: process.pid, cwd: process.cwd() });

  const config = loadConfig();
  const connected = isConnectedMode();

  const hookCwd = process.cwd();
  const repoPath = getGitRoot(hookCwd);
  if (!repoPath) {
    debugLog('post-commit', 'SKIP: not a git repo');
    return;
  }

  // Get latest commit info
  const execOpts = { encoding: 'utf-8' as const, cwd: repoPath, stdio: ['pipe', 'pipe', 'pipe'] as ['pipe', 'pipe', 'pipe'] };
  let commitSha: string, commitMessage: string, commitAuthor: string;
  try {
    commitSha = execSync('git rev-parse HEAD', execOpts).trim();
    commitMessage = execSync('git log -1 --format=%s', execOpts).trim();
    commitAuthor = execSync('git log -1 --format=%an', execOpts).trim();
  } catch (err: any) {
    debugLog('post-commit', 'ERROR: cannot read commit', { message: err.message });
    return;
  }

  debugLog('post-commit', 'commit info', { commitSha, commitMessage, commitAuthor });

  // Validate commitSha is a hex string to prevent shell injection
  if (!/^[a-fA-F0-9]+$/.test(commitSha)) {
    debugLog('post-commit', 'SKIP: invalid commit SHA', { commitSha });
    return;
  }

  // Get files changed in this commit
  let filesChanged: string[] = [];
  try {
    const raw = execSync(`git diff-tree --no-commit-id --name-only -r ${commitSha}`, execOpts).trim();
    filesChanged = raw ? raw.split('\n').filter(Boolean) : [];
  } catch { /* ignore */ }

  // Get diff for this single commit
  let diff = '';
  try {
    diff = execSync(`git diff ${commitSha}~1..${commitSha}`, execOpts).trim();
  } catch {
    try {
      // First commit in repo — no parent
      diff = execSync(`git show ${commitSha} --format= --diff-merges=first-parent`, execOpts).trim();
    } catch { /* ignore */ }
  }

  // Count lines
  let linesAdded = 0, linesRemoved = 0;
  if (diff) {
    for (const line of diff.split('\n')) {
      if (line.startsWith('+') && !line.startsWith('+++')) linesAdded++;
      if (line.startsWith('-') && !line.startsWith('---')) linesRemoved++;
    }
  }

  // Detect current branch (may have changed since session started)
  const currentBranch = getBranch(hookCwd);

  // Add Origin-Session trailer to commit message (like Entire's Entire-Checkpoint trailer)
  const apiUrl = config?.apiUrl || 'https://getorigin.io';

  // Get ALL active sessions for this repo (concurrent session support)
  const activeSessions = listActiveSessions(hookCwd);
  activeSessions.sort((a, b) => new Date(b.startedAt).getTime() - new Date(a.startedAt).getTime());

  // Pick the correct session — use process detection to disambiguate when multiple are active
  let state: SessionState | null = null;
  if (activeSessions.length === 1) {
    state = activeSessions[0];
  } else if (activeSessions.length > 1) {
    // Detect which agent made this commit via process detection
    let detectedSlug: string | null = null;
    const agentChecks = [
      { cmd: 'pgrep -f "claude.*stream-json"', slug: 'claude' },
      { cmd: 'pgrep -f "gemini.*cli|/gemini "', slug: 'gemini' },
      { cmd: 'pgrep -f "codex"', slug: 'codex' },
      { cmd: 'pgrep -f "aider"', slug: 'aider' },
      { cmd: 'pgrep -f "windsurf"', slug: 'windsurf' },
      { cmd: 'pgrep -f "copilot.*cli|github-copilot"', slug: 'copilot' },
      { cmd: 'pgrep -f "continue.*dev"', slug: 'continue' },
      { cmd: 'pgrep -f "amp.*cli|/amp "', slug: 'amp' },
      { cmd: 'pgrep -f "junie|jetbrains.*ai"', slug: 'junie' },
      { cmd: 'pgrep -f "opencode"', slug: 'opencode' },
      { cmd: 'pgrep -f "rovo.*dev"', slug: 'rovo' },
      { cmd: 'pgrep -f "droid"', slug: 'droid' },
    ];
    for (const check of agentChecks) {
      try {
        execSync(check.cmd, { stdio: ['pipe', 'pipe', 'pipe'] });
        detectedSlug = check.slug;
        break;
      } catch { /* no match */ }
    }

    if (detectedSlug) {
      const match = activeSessions.find(s => sessionMatchesAgent(s, detectedSlug!));
      if (match) {
        state = match;
        debugLog('post-commit', 'matched session via process detection', { detectedSlug, sessionId: match.sessionId, model: match.model });
      }
    }

    // If process detection didn't narrow it down, don't guess
    if (!state) {
      debugLog('post-commit', 'multiple sessions active, could not disambiguate', {
        totalSessions: activeSessions.length,
        sessionModels: activeSessions.map(s => ({ id: s.sessionId, model: s.model })),
      });
    }
  }

  // If no active session AND no sessions were found at all, detect AI agent process.
  // Only do this when there are truly zero sessions — if sessions exist but couldn't
  // be disambiguated, we already warned above and shouldn't guess via pgrep.
  if (!state && activeSessions.length === 0) {
    let detectedModel: string | null = null;
    try {
      // Use pgrep for targeted process detection — look for CLI binaries only,
      // not desktop apps (Cursor/VS Code have many helper processes that would match)
      const checks = [
        { cmd: 'pgrep -f "gemini.*cli|bin/gemini"', model: 'gemini' },
        { cmd: 'pgrep -f "claude.*stream-json"', model: 'claude' },
        { cmd: 'pgrep -f "codex"', model: 'codex' },
        { cmd: 'pgrep -f "bin/aider|aider.*--model"', model: 'aider' },
        { cmd: 'pgrep -f "copilot.*cli|github-copilot"', model: 'copilot' },
        { cmd: 'pgrep -f "amp.*cli|/amp "', model: 'amp' },
        { cmd: 'pgrep -f "opencode"', model: 'opencode' },
      ];
      for (const check of checks) {
        try {
          execSync(check.cmd, { stdio: ['pipe', 'pipe', 'pipe'] });
          detectedModel = check.model;
          break;
        } catch { /* pgrep exits 1 if no match */ }
      }
    } catch { /* ignore */ }

    if (detectedModel) {
      debugLog('post-commit', 'no active session but detected AI process', { detectedModel });
      // Create a synthetic state so notes get tagged as AI
      state = {
        sessionId: `detected-${detectedModel}-${Date.now().toString(36)}`,
        model: detectedModel,
        startedAt: new Date().toISOString(),
      } as any;
    }
  }

  // Update branch + accumulate filesChanged on all active sessions
  for (const s of activeSessions) {
    let changed = false;
    if (currentBranch && currentBranch !== s.branch) {
      debugLog('post-commit', 'branch changed', { from: s.branch, to: currentBranch, sessionId: s.sessionId });
      s.branch = currentBranch;
      changed = true;
    }
    // Accumulate files changed in session state so standalone sessions show file counts
    if (filesChanged.length > 0) {
      const existing = new Set((s as any).filesChanged || []);
      for (const f of filesChanged) existing.add(f);
      (s as any).filesChanged = Array.from(existing);
      (s as any).linesAdded = ((s as any).linesAdded || 0) + linesAdded;
      (s as any).linesRemoved = ((s as any).linesRemoved || 0) + linesRemoved;
      (s as any).commitCount = ((s as any).commitCount || 0) + 1;
      changed = true;
    }
    if (changed) {
      saveSessionState(s, s.repoPath || hookCwd, s.sessionTag);
    }
  }

  // F13: Respect config.commitLinking setting (always|prompt|never)
  const commitLinkingConfig = config?.commitLinking || 'always';
  if (state && commitLinkingConfig !== 'never') {
    try {
      // Only add trailer if not already present
      const fullMessage = execSync('git log -1 --format=%B', execOpts).trim();
      if (!fullMessage.includes('Origin-Session:')) {
        const shortId = state.sessionId.slice(0, 12);
        const trailer = `Origin-Session: ${shortId}`;
        // Amend the commit message to add the trailer
        const newMessage = fullMessage + '\n\n' + trailer;
        execSync(`git commit --amend -m ${escapeShellArg(newMessage)} --no-verify`, execOpts);
        debugLog('post-commit', 'added Origin-Session trailer', { shortId });
        // Re-read commit SHA since amend changes it
        commitSha = execSync('git rev-parse HEAD', execOpts).trim();
      }
    } catch (err: any) {
      debugLog('post-commit', 'trailer amend error (non-fatal)', { message: err.message });
    }
  }

  // Write git notes on this commit immediately
  // If model is missing/unknown, try pgrep detection as fallback
  let noteModel = state?.model || '';
  if (!noteModel || noteModel === 'unknown') {
    try {
      const fallbackChecks = [
        { cmd: 'pgrep -f "claude.*stream-json"', model: 'claude' },
        { cmd: 'pgrep -f "gemini.*cli|/gemini "', model: 'gemini' },
        { cmd: 'pgrep -f "codex"', model: 'codex' },
        { cmd: 'pgrep -f "aider"', model: 'aider' },
        { cmd: 'pgrep -f "windsurf"', model: 'windsurf' },
        { cmd: 'pgrep -f "copilot.*cli|github-copilot"', model: 'copilot' },
        { cmd: 'pgrep -f "amp.*cli|/amp "', model: 'amp' },
      ];
      for (const check of fallbackChecks) {
        try {
          execSync(check.cmd, { stdio: ['pipe', 'pipe', 'pipe'] });
          noteModel = check.model;
          break;
        } catch { /* no match */ }
      }
    } catch { /* ignore */ }
  }

  try {
    writeGitNotes(repoPath, [commitSha], {
      sessionId: state?.sessionId || 'unknown',
      model: noteModel || 'unknown',
      promptCount: state?.prompts?.length || 0,
      promptSummary: state?.prompts?.[state.prompts.length - 1] || '',
      tokensUsed: 0,
      costUsd: 0,
      durationMs: 0,
      linesAdded,
      linesRemoved,
      originUrl: state ? `${apiUrl}/sessions/${state.sessionId}` : '',
      checkpoint: true,
      checkpointAt: new Date().toISOString(),
      filesChanged,
    });
    debugLog('post-commit', 'git notes written');
  } catch (err: any) {
    debugLog('post-commit', 'git notes error (non-fatal)', { message: err.message });
  }

  // Send incremental update to ALL active sessions (concurrent support)
  if (activeSessions.length > 0) {
    const gitCapture = {
      headBefore: (state?.headShaAtStart) || commitSha,
      headAfter: commitSha,
      commitShas: [commitSha],
      commitDetails: [{ sha: commitSha, message: commitMessage, author: commitAuthor, filesChanged }],
      diff: diff.length > 500_000 ? diff.slice(0, 500_000) : diff,
      diffTruncated: diff.length > 500_000,
      linesAdded,
      linesRemoved,
    };

    if (connected) {
      for (const s of activeSessions) {
        try {
          debugLog('post-commit', 'sending incremental update', { sessionId: s.sessionId, filesChanged: filesChanged.length });
          await api.updateSession(s.sessionId, {
            filesChanged: filesChanged.length > 0 ? filesChanged : undefined,
            branch: currentBranch || undefined,
            gitCapture,
          });
          debugLog('post-commit', 'API update complete', { sessionId: s.sessionId });
        } catch (err: any) {
          debugLog('post-commit', 'API update error (non-fatal)', { sessionId: s.sessionId, message: err.message });
        }
      }
    }
  } else {
    debugLog('post-commit', 'no active sessions, skipped API update');
  }

  // Write full session entrypoint to origin-sessions branch on every commit
  // Parse transcript for full metrics (if available) so we capture tokens, cost, prompts, files
  // For agents without transcripts (e.g. Gemini), still write git data (files, lines)
  if (state && !state.sessionId.startsWith('detected-')) {
    const durationMs = Date.now() - new Date(state.startedAt).getTime();

    // Parse transcript for full metrics (or use empty defaults for agents without transcripts)
    const parsed = state.transcriptPath
      ? parseTranscript(state.transcriptPath)
      : { prompts: [], filesChanged: [], tokensUsed: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0, toolCalls: 0, summary: '', model: '', transcript: '' };
    const promptMappings = state.transcriptPath
      ? extractPromptFileMappings(state.transcriptPath)
      : [];
    const writeData = buildSessionWriteData({
      state, parsed, promptMappings,
      gitCapture: {
        headBefore: state.headShaAtStart || commitSha,
        headAfter: commitSha,
        commitShas: [commitSha],
        linesAdded,
        linesRemoved,
      },
      status: 'running', apiUrl,
      extraFiles: filesChanged,
    });
    writeSessionFiles(repoPath, writeData);
    pushSessionBranch(repoPath);
    debugLog('post-commit', 'session files written + pushed', {
      prompts: writeData.prompts.length,
      costUsd: writeData.costUsd,
      files: writeData.filesChanged.length,
    });
  }

  debugLog('post-commit', '=== GIT HOOK COMPLETE ===');
}

// ─── Pre-Tool-Use / Post-Tool-Use (F7: Subagent Tracking) ─────────────────

// ── Policy Enforcement Helpers ────────────────────────────────────────────

function matchGlob(pattern: string, filepath: string): boolean {
  const escaped = pattern
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*\*/g, '<<<GLOBSTAR>>>')
    .replace(/\*/g, '[^/]*')
    .replace(/<<<GLOBSTAR>>>/g, '.*')
    .replace(/\?/g, '.');
  return new RegExp(`^${escaped}$`).test(filepath);
}

/**
 * Extract file paths from tool input across different agents.
 * Claude: { file_path, command (grep for paths) }
 * Gemini: { path, file_path, command }
 */
function extractFilePaths(toolName: string, toolInput: Record<string, any>): string[] {
  const paths: string[] = [];

  // Direct file path fields (Read, Write, Edit tools)
  for (const key of ['file_path', 'path', 'filePath', 'filename', 'file']) {
    if (typeof toolInput[key] === 'string' && toolInput[key]) {
      paths.push(toolInput[key]);
    }
  }

  // Bash/shell commands — extract paths from common file operations
  const cmd = toolInput.command || toolInput.cmd || toolInput.script || '';
  if (typeof cmd === 'string' && cmd) {
    // Match common file access patterns: cat, less, head, tail, vim, nano, code, read, source
    const fileOps = /(?:cat|less|head|tail|vim|nano|code|source|rm|mv|cp|chmod|chown)\s+(?:-[a-zA-Z]*\s+)*([^\s|>&;]+)/g;
    let m;
    while ((m = fileOps.exec(cmd)) !== null) {
      if (m[1] && !m[1].startsWith('-')) paths.push(m[1]);
    }
  }

  return paths;
}

function enforceFileRestrictions(
  rules: Array<{ type: string; condition: string; action: string; severity: string }>,
  filePaths: string[],
  repoPath: string,
): { blocked: boolean; reason: string } | null {
  if (!rules || rules.length === 0 || filePaths.length === 0) return null;

  for (const rule of rules) {
    if (rule.type !== 'FILE_RESTRICTION') continue;
    if (rule.action.toUpperCase() !== 'BLOCK') continue;

    let cond: Record<string, unknown>;
    try { cond = JSON.parse(rule.condition); } catch { continue; }
    const pattern = cond.path as string | undefined;
    if (!pattern) continue;

    for (const fp of filePaths) {
      // Normalize: try both absolute and relative-to-repo
      const relPath = fp.startsWith('/') && repoPath
        ? fp.replace(repoPath + '/', '').replace(repoPath, '')
        : fp;
      const candidates = [fp, relPath, relPath.replace(/^\//, '')];

      for (const candidate of candidates) {
        if (matchGlob(pattern, candidate)) {
          return {
            blocked: true,
            reason: `[Origin Policy] Blocked: file "${candidate}" matches restricted pattern "${pattern}"`,
          };
        }
      }
    }
  }

  return null;
}

async function handlePreToolUse(input: Record<string, any>, agentSlug?: string): Promise<void> {
  debugLog('pre-tool-use', 'begin', { tool_name: input.tool_name, cwd: input.cwd });

  const hookCwd = input.cwd || process.cwd();
  const found = findStateForHook(hookCwd, input.session_id, agentSlug);
  if (!found) {
    debugLog('pre-tool-use', 'ABORT: no session state');
    return;
  }
  const { state, saveCwd } = found;

  // ── Policy Enforcement: FILE_RESTRICTION ──────────────────────────────
  if (state.enforcementRules && state.enforcementRules.length > 0) {
    const toolInput = input.tool_input || {};
    const filePaths = extractFilePaths(input.tool_name || '', toolInput);
    debugLog('pre-tool-use', 'extracted paths', { filePaths, toolName: input.tool_name });

    if (filePaths.length > 0) {
      const result = enforceFileRestrictions(state.enforcementRules, filePaths, state.repoPath);
      if (result?.blocked) {
        debugLog('pre-tool-use', 'BLOCKED by policy', { reason: result.reason });
        // Exit code 2 + stderr blocks the tool for both Claude Code and Gemini CLI
        process.stderr.write(result.reason + '\n');
        process.exit(2);
      }
    }
  }

  // ── Auto-Snapshot: save working tree before file-modifying tools ────────
  const toolNameLower = (input.tool_name || '').toLowerCase();
  if (['edit', 'write', 'patch', 'create', 'insert', 'replace', 'notebook_edit'].some(t => toolNameLower.includes(t))) {
    try {
      const cfg = loadConfig();
      if (cfg?.autoSnapshot && state.repoPath) {
        const { createAutoSnapshot } = await import('./snapshot.js');
        const snapId = createAutoSnapshot(state.repoPath, state.sessionTag);
        if (snapId) {
          debugLog('pre-tool-use', 'auto-snapshot created', { snapId, toolName: input.tool_name });
        }
      }
    } catch {
      // Non-fatal — never block the agent for snapshot failures
    }
  }

  // ── File Attribution Context ─────────────────────────────────────────────
  // When an agent reads or edits a file, inject per-file attribution so
  // the agent knows who wrote each part before modifying it.
  const toolName = (input.tool_name || '').toLowerCase();
  if (['read', 'edit', 'write', 'view'].some(t => toolName.includes(t))) {
    const toolInput = input.tool_input || {};
    const filePath = toolInput.file_path || toolInput.path || toolInput.filePath || toolInput.filename || '';
    if (filePath && state.repoPath) {
      try {
        const fileCtx = buildFileAttributionContext(state.repoPath, filePath);
        if (fileCtx) {
          // Output as JSON system message — Claude Code reads this from stdout
          const output = JSON.stringify({ systemMessage: fileCtx });
          process.stdout.write(output);
          debugLog('pre-tool-use', 'file attribution injected', { filePath, length: fileCtx.length });
        }
      } catch {
        // Non-fatal
      }
    }
  }

  // Initialize subagents array if needed
  if (!state.subagents) state.subagents = [];

  const toolCallId = input.tool_call_id || `${Date.now()}-${crypto.randomBytes(4).toString('hex')}`;
  const record: SubagentRecord = {
    toolCallId,
    toolName: input.tool_name || 'unknown',
    startedAt: new Date().toISOString(),
    prompt: input.tool_input ? JSON.stringify(input.tool_input).slice(0, 500) : undefined,
  };

  state.subagents.push(record);
  saveSessionState(state, saveCwd, state.sessionTag);
  debugLog('pre-tool-use', 'recorded', { toolCallId, toolName: record.toolName });
}

async function handlePostToolUse(input: Record<string, any>, agentSlug?: string): Promise<void> {
  debugLog('post-tool-use', 'begin', { tool_name: input.tool_name, cwd: input.cwd });

  const hookCwd = input.cwd || process.cwd();
  const found = findStateForHook(hookCwd, input.session_id, agentSlug);
  if (!found) {
    debugLog('post-tool-use', 'ABORT: no session state');
    return;
  }
  const { state, saveCwd } = found;

  if (state.subagents && state.subagents.length > 0) {
    // Find the matching pre-tool-use record (last unfinished one with matching tool name)
    const toolName = input.tool_name || 'unknown';
    const record = [...state.subagents].reverse().find(
      r => r.toolName === toolName && !r.endedAt
    );

    if (record) {
      record.endedAt = new Date().toISOString();
      if (input.tool_result) {
        record.result = typeof input.tool_result === 'string'
          ? input.tool_result.slice(0, 500)
          : JSON.stringify(input.tool_result).slice(0, 500);
      }
      saveSessionState(state, saveCwd, state.sessionTag);
      debugLog('post-tool-use', 'updated', { toolCallId: record.toolCallId, toolName });
    }
  }

  // ── Mid-session branch tracking ──────────────────────────────────────────
  // Check branch on every tool use — different agents use different tool names
  // (Claude: Bash, Gemini: shell/run_terminal_command, etc.)
  // getBranch() just reads .git/HEAD so it's cheap
  try {
    const repoPath = state.repoPath || saveCwd;
    const currentBranch = getBranch(repoPath);
    if (currentBranch && currentBranch !== state.branch) {
      debugLog('post-tool-use', 'branch changed', { from: state.branch, to: currentBranch });
      state.branch = currentBranch;
      saveSessionState(state, saveCwd, state.sessionTag);
      // Update server (connected mode only)
      if (isConnectedMode() && state.sessionId) {
        api.updateSession(state.sessionId, { branch: currentBranch }).catch(() => {});
      }
    }
  } catch {
    // non-fatal
  }
}

// ─── Git Hook: Pre-Commit (Secret Scan) ──────────────────────────────────

/**
 * Called by .git/hooks/pre-commit.
 * Scans staged diff for hardcoded secrets, API keys, and credentials.
 * Exits with code 1 to block the commit if secrets are found.
 */
export async function handlePreCommit(): Promise<void> {
  debugLog('pre-commit', '=== GIT HOOK INVOKED ===', { pid: process.pid, cwd: process.cwd() });

  const config = loadConfig();
  const hookCwd = process.cwd();
  const repoPath = getGitRoot(hookCwd);
  if (!repoPath) {
    debugLog('pre-commit', 'SKIP: not a git repo');
    return;
  }

  const repoConfig = loadRepoConfig(repoPath);

  const execOpts = {
    encoding: 'utf-8' as const,
    cwd: repoPath,
    stdio: ['pipe', 'pipe', 'pipe'] as ['pipe', 'pipe', 'pipe'],
    maxBuffer: 10 * 1024 * 1024, // 10MB for large diffs
  };

  // Get staged diff (full context for CONTENT_FILTER matching)
  let stagedDiff: string;
  try {
    stagedDiff = execSync('git diff --cached', execOpts).trim();
  } catch (err: any) {
    debugLog('pre-commit', 'ERROR: cannot read staged diff', { message: err.message });
    return; // Don't block on error
  }

  if (!stagedDiff) {
    debugLog('pre-commit', 'SKIP: empty staged diff');
    return;
  }

  // Get staged file list
  let stagedFiles: string[] = [];
  try {
    const raw = execSync('git diff --cached --name-only', execOpts).trim();
    stagedFiles = raw ? raw.split('\n') : [];
  } catch { /* ignore */ }

  // Get the commit message (from COMMIT_EDITMSG if available — works for commit-msg hook chain)
  let commitMessage = '';
  try {
    const msgFile = path.join(repoPath, '.git', 'COMMIT_EDITMSG');
    if (fs.existsSync(msgFile)) {
      commitMessage = fs.readFileSync(msgFile, 'utf-8').trim();
    }
  } catch { /* ignore */ }

  // ── Collect all violations from all policy checkers ──
  interface PolicyViolation {
    policyName: string;
    policyType: string;
    policyId?: string;
    ruleId?: string;
    action: string;
    severity: string;
    message: string;
  }
  const violations: PolicyViolation[] = [];

  // ── 1. Secret scanning (built-in, always runs unless disabled) ──
  if (config?.secretScan !== false && repoConfig?.secretScan !== false) {
    const addedLines = parseStagedDiffLines(stagedDiff);
    const seen = new Set<string>();

    for (const entry of addedLines) {
      const trimmed = entry.content.trim();
      if (trimmed.length < 5) continue;
      if (trimmed.startsWith('//') || trimmed.startsWith('#') || trimmed.startsWith('*') || trimmed.startsWith('<!--')) continue;

      for (const pattern of PRE_COMMIT_PATTERNS) {
        pattern.regex.lastIndex = 0;
        const match = pattern.regex.exec(entry.content);
        if (match) {
          const matchedValue = match[1] || match[0];
          const key = `${entry.file}:${entry.line}:${matchedValue}`;
          if (seen.has(key)) continue;
          seen.add(key);

          const redacted = matchedValue.length <= 8
            ? '****'
            : matchedValue.slice(0, 4) + '****' + matchedValue.slice(-4);

          violations.push({
            policyName: 'Secret Detection',
            policyType: 'SECRET_SCAN',
            action: 'BLOCK',
            severity: mapFindingSeverity(pattern.name).toUpperCase(),
            message: `${pattern.name} in ${entry.file}:${entry.line} — ${redacted}`,
          });
        }
      }
    }
  }

  // ── 2. Fetch org policies from Origin API and enforce locally ──
  const connected = isConnectedMode();
  if (connected) {
    try {
      const policies = await api.getPolicies() as Array<{
        id: string;
        name: string;
        type: string;
        rules: Array<{
          id: string;
          condition: string;
          action: string;
          severity: string;
          agentId: string | null;
          machineId: string | null;
          repoId: string | null;
        }>;
      }>;

      for (const policy of policies) {
        for (const rule of policy.rules) {
          let cond: Record<string, any> = {};
          try { cond = JSON.parse(rule.condition); } catch { continue; }

          switch (policy.type) {
            case 'FILE_RESTRICTION': {
              const pathPattern = cond.path as string | undefined;
              if (pathPattern) {
                for (const file of stagedFiles) {
                  if (matchGlobPreCommit(pathPattern, file)) {
                    violations.push({
                      policyName: policy.name,
                      policyType: policy.type,
                      policyId: policy.id,
                      ruleId: rule.id,
                      action: rule.action,
                      severity: rule.severity,
                      message: `File "${file}" matches restricted pattern "${pathPattern}"`,
                    });
                    break; // one match per rule is enough
                  }
                }
              }
              break;
            }

            case 'CONTENT_FILTER': {
              const pattern = cond.pattern as string | undefined;
              if (pattern) {
                try {
                  const flags = (cond.caseSensitive === false) ? 'gi' : 'g';
                  const regex = new RegExp(pattern, flags);
                  const matches = stagedDiff.match(regex);
                  if (matches && matches.length > 0) {
                    violations.push({
                      policyName: policy.name,
                      policyType: policy.type,
                      policyId: policy.id,
                      ruleId: rule.id,
                      action: rule.action,
                      severity: rule.severity,
                      message: `Diff content matches "${pattern}" (${matches.length} match${matches.length !== 1 ? 'es' : ''})`,
                    });
                  }
                } catch { /* invalid regex */ }
              }
              break;
            }

            case 'COMMIT_MESSAGE': {
              if (!commitMessage) break;
              const requiredPattern = cond.pattern as string | undefined;
              const blockedPattern = cond.blocked_pattern as string | undefined;

              if (requiredPattern) {
                try {
                  const regex = new RegExp(requiredPattern);
                  if (!regex.test(commitMessage)) {
                    violations.push({
                      policyName: policy.name,
                      policyType: policy.type,
                      policyId: policy.id,
                      ruleId: rule.id,
                      action: rule.action,
                      severity: rule.severity,
                      message: `Commit message does not match required format "${requiredPattern}"`,
                    });
                  }
                } catch { /* invalid regex */ }
              }

              if (blockedPattern) {
                try {
                  const flags = (cond.caseSensitive === false) ? 'i' : '';
                  const regex = new RegExp(blockedPattern, flags);
                  if (regex.test(commitMessage)) {
                    violations.push({
                      policyName: policy.name,
                      policyType: policy.type,
                      policyId: policy.id,
                      ruleId: rule.id,
                      action: rule.action,
                      severity: rule.severity,
                      message: `Commit message matches blocked pattern "${blockedPattern}"`,
                    });
                  }
                } catch { /* invalid regex */ }
              }
              break;
            }

            case 'REQUIRE_REVIEW': {
              // Check file path patterns only at pre-commit (cost/duration not available yet)
              const pathPattern = cond.path as string | undefined;
              if (pathPattern) {
                for (const file of stagedFiles) {
                  if (matchGlobPreCommit(pathPattern, file)) {
                    violations.push({
                      policyName: policy.name,
                      policyType: policy.type,
                      policyId: policy.id,
                      ruleId: rule.id,
                      action: 'REQUIRE_REVIEW',
                      severity: rule.severity,
                      message: `File "${file}" matches review pattern "${pathPattern}" — manual review required`,
                    });
                    break;
                  }
                }
              }
              break;
            }

            // COST_LIMIT and MODEL_ALLOWLIST not applicable at pre-commit time
          }
        }
      }
    } catch (err: any) {
      debugLog('pre-commit', 'Policy fetch failed (non-fatal)', { message: err.message });
      // Don't block on API failure — just skip policy checks
    }
  }

  // ── No violations? Pass. ──
  if (violations.length === 0) {
    debugLog('pre-commit', 'PASS: no violations');
    return;
  }

  // ── Report violations to API (Security tab) ──
  if (connected) {
    try {
      const sessions = listActiveSessions(repoPath);
      const activeSession = sessions[0];
      const sessionId = activeSession?.sessionId;

      // Report secret findings
      const secretFindings = violations.filter(v => v.policyType === 'SECRET_SCAN');
      if (sessionId && secretFindings.length > 0) {
        await api.reportSecrets(sessionId, secretFindings.map(f => ({
          type: 'GENERIC_SECRET',
          severity: f.severity.toLowerCase(),
          filePath: f.message.split(' in ')[1]?.split(' —')[0] || '',
          lineNumber: 0,
          match: f.message,
          ruleName: f.policyName,
        }))).catch(() => {});
      }

      // Report policy violations
      const policyViolations = violations.filter(v => v.policyId);
      for (const v of policyViolations) {
        await api.reportViolation({
          machineId: config?.machineId || 'unknown',
          policyId: v.policyId!,
          description: `[pre-commit] ${v.message}`,
          filepath: stagedFiles[0] || undefined,
        }).catch(() => {});
      }
    } catch (err: any) {
      debugLog('pre-commit', 'API report failed (non-fatal)', { message: err.message });
    }
  }

  // ── Check if any violations have BLOCK action ──
  const blockingViolations = violations.filter(
    v => v.action.toUpperCase() === 'BLOCK' || v.policyType === 'SECRET_SCAN'
  );
  const warningViolations = violations.filter(
    v => v.action.toUpperCase() !== 'BLOCK' && v.policyType !== 'SECRET_SCAN'
  );

  // Show warnings (non-blocking)
  if (warningViolations.length > 0) {
    process.stderr.write('\n');
    process.stderr.write('\x1b[1;33m  ⚠ Origin: policy warnings\x1b[0m\n');
    process.stderr.write('\n');
    for (const v of warningViolations) {
      process.stderr.write(`\x1b[33m    [${v.policyType}] ${v.policyName}\x1b[0m\n`);
      process.stderr.write(`    ${v.message}\n\n`);
    }
  }

  // Block commit if any blocking violations
  if (blockingViolations.length > 0) {
    process.stderr.write('\n');
    process.stderr.write('\x1b[1;31m  ✗ Origin: commit blocked by policy\x1b[0m\n');
    process.stderr.write('\n');

    for (const v of blockingViolations) {
      process.stderr.write(`\x1b[31m    [${v.policyType}] ${v.policyName}\x1b[0m\n`);
      process.stderr.write(`    ${v.message}\n\n`);
    }

    process.stderr.write(`\x1b[33m  ${blockingViolations.length} violation${blockingViolations.length !== 1 ? 's' : ''} found. Commit blocked.\x1b[0m\n`);
    process.stderr.write('\n');
    process.stderr.write('\x1b[2m  To bypass: git commit --no-verify\x1b[0m\n');
    process.stderr.write('\n');

    process.exit(1);
  }
}

// Map finding type names to API types
function mapFindingType(name: string): string {
  const map: Record<string, string> = {
    'AWS Access Key': 'AWS_SECRET', 'AWS Secret Key': 'AWS_SECRET',
    'Private Key': 'PRIVATE_KEY', 'GitHub Token': 'API_KEY', 'GitHub PAT': 'API_KEY',
    'OpenAI Key': 'API_KEY', 'Anthropic Key': 'API_KEY', 'Stripe Key': 'API_KEY',
    'Slack Token': 'API_KEY', 'JWT Token': 'JWT_TOKEN',
    'Connection String': 'CONNECTION_STRING', 'API Key': 'API_KEY',
    'Hardcoded Password': 'PASSWORD', 'npm Token': 'API_KEY', 'Bearer Token': 'API_KEY',
  };
  return map[name] || 'GENERIC_SECRET';
}

function mapFindingSeverity(name: string): string {
  const critical = ['AWS Access Key', 'AWS Secret Key', 'Private Key', 'GitHub Token', 'GitHub PAT', 'Connection String'];
  const high = ['OpenAI Key', 'Anthropic Key', 'Stripe Key', 'Slack Token', 'JWT Token', 'API Key', 'Hardcoded Password'];
  if (critical.includes(name)) return 'critical';
  if (high.includes(name)) return 'high';
  return 'medium';
}

// Patterns for pre-commit scanning (non-global flags for single match per line)
const PRE_COMMIT_PATTERNS = [
  { name: 'AWS Access Key', regex: /AKIA[0-9A-Z]{16}/ },
  { name: 'AWS Secret Key', regex: /(?:aws_secret_access_key|secret_key)\s*[:=]\s*['"]?([A-Za-z0-9/+=]{40})/i },
  { name: 'Private Key', regex: /-----BEGIN\s+(?:RSA\s+|EC\s+|DSA\s+|OPENSSH\s+)?PRIVATE\s+KEY-----/ },
  { name: 'GitHub Token', regex: /(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9_]{36,}/ },
  { name: 'GitHub PAT', regex: /github_pat_[A-Za-z0-9_]{50,}/ },
  { name: 'OpenAI Key', regex: /sk-[A-Za-z0-9]{32,}/ },
  { name: 'Anthropic Key', regex: /sk-ant-[A-Za-z0-9-]{32,}/ },
  { name: 'Stripe Key', regex: /sk_(?:live|test)_[A-Za-z0-9]{24,}/ },
  { name: 'Slack Token', regex: /xox[bpors]-[0-9]{10,}-[a-zA-Z0-9-]+/ },
  { name: 'JWT Token', regex: /eyJ[a-zA-Z0-9_-]{10,}\.eyJ[a-zA-Z0-9_-]{10,}\.[a-zA-Z0-9_-]{10,}/ },
  { name: 'Connection String', regex: /(?:mongodb(?:\+srv)?|postgres(?:ql)?|mysql|redis|amqp):\/\/[^\s'"]{10,}/i },
  { name: 'API Key', regex: /(?:api[_-]?key|apikey|api[_-]?secret|api[_-]?token)\s*[:=]\s*['"]([a-zA-Z0-9_\-]{20,})['"]/ },
  { name: 'Hardcoded Password', regex: /(?:password|passwd|pwd|db_password)\s*[:=]\s*['"]?([^'"\s]{8,})['"]?/i },
  { name: 'npm Token', regex: /npm_[A-Za-z0-9]{36,}/ },
  { name: 'Bearer Token', regex: /Bearer\s+[A-Za-z0-9_\-.]{20,}/ },
  // Generic *_TOKEN=, *_SECRET=, *_KEY=, *_PASSWORD= assignments
  { name: 'Token Assignment', regex: /\w+_TOKEN\s*[:=]\s*['"]?([A-Za-z0-9_\-/.+=]{10,})['"]?/i },
  { name: 'Secret Assignment', regex: /\w+_SECRET\s*[:=]\s*['"]?([A-Za-z0-9_\-/.+=]{10,})['"]?/i },
  { name: 'Key Assignment', regex: /\w+_(?:API_?)?KEY\s*[:=]\s*['"]?([A-Za-z0-9_\-/.+=]{10,})['"]?/i },
  { name: 'Password Assignment', regex: /\w+_PASSWORD\s*[:=]\s*['"]?([^\s'"]{8,})['"]?/i },
];

// Glob pattern matching for pre-commit policy checks
function matchGlobPreCommit(pattern: string, filepath: string): boolean {
  const escaped = pattern
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*\*/g, '<<<GLOBSTAR>>>')
    .replace(/\*/g, '[^/]*')
    .replace(/<<<GLOBSTAR>>>/g, '.*')
    .replace(/\?/g, '.');
  const regex = new RegExp(`^${escaped}$`);
  return regex.test(filepath);
}

// Parse staged diff into file + line + content entries
function parseStagedDiffLines(diff: string): Array<{ file: string; line: number; content: string }> {
  const lines = diff.split('\n');
  const result: Array<{ file: string; line: number; content: string }> = [];
  let currentFile = '';
  let currentLine = 0;

  for (const line of lines) {
    if (line.startsWith('+++ b/')) {
      currentFile = line.slice(6);
      continue;
    }
    if (line.startsWith('+++ ') || line.startsWith('--- ')) continue;

    const hunkMatch = line.match(/^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
    if (hunkMatch) {
      currentLine = parseInt(hunkMatch[1], 10);
      continue;
    }

    if (line.startsWith('diff ') || line.startsWith('index ') || line.startsWith('Binary ')) continue;

    if (line.startsWith('+') && !line.startsWith('++')) {
      result.push({ file: currentFile, line: currentLine, content: line.slice(1) });
      currentLine++;
      continue;
    }

    if (!line.startsWith('-')) {
      currentLine++;
    }
  }

  return result;
}

// ─── Git Hook: Pre-Push (F14) ─────────────────────────────────────────────

/**
 * Called by .git/hooks/pre-push.
 * Pushes origin-sessions branch and refs/notes/origin alongside the user's push.
 */
export async function handlePrePush(): Promise<void> {
  debugLog('pre-push', '=== GIT HOOK INVOKED ===');

  const hookCwd = process.cwd();
  const repoPath = getGitRoot(hookCwd);
  if (!repoPath) {
    debugLog('pre-push', 'SKIP: not a git repo');
    return;
  }

  const execOpts = {
    encoding: 'utf-8' as const,
    cwd: repoPath,
    stdio: ['pipe', 'pipe', 'pipe'] as ['pipe', 'pipe', 'pipe'],
    timeout: 15_000,
  };

  // Check if remote exists
  try {
    execSync('git remote get-url origin', execOpts);
  } catch {
    debugLog('pre-push', 'SKIP: no remote');
    return;
  }

  // In connected mode, session data goes to the API — don't push
  // origin-sessions branch to repo remote (may be public).
  const config = loadConfig();
  const connected = !!(config?.apiKey && config?.apiUrl);
  const strategy = config?.pushStrategy || 'auto';

  if (!connected || config?.checkpointRepo || strategy === 'always') {
    // Push origin-sessions branch if it exists (standalone mode only)
    try {
      execSync('git rev-parse refs/heads/origin-sessions', execOpts);
      execSync('git push origin origin-sessions --no-verify --quiet', execOpts);
      debugLog('pre-push', 'pushed origin-sessions');
    } catch (err: any) {
      debugLog('pre-push', 'origin-sessions push skipped', { message: err.message });
    }
  } else {
    debugLog('pre-push', 'SKIP origin-sessions push: connected mode');
  }

  // Push refs/notes/origin if they exist
  try {
    execSync('git rev-parse refs/notes/origin', execOpts);
    execSync('git push origin refs/notes/origin --no-verify --quiet', execOpts);
    debugLog('pre-push', 'pushed refs/notes/origin');
  } catch (err: any) {
    debugLog('pre-push', 'notes push skipped', { message: err.message });
  }

  debugLog('pre-push', '=== GIT HOOK COMPLETE ===');
}

// ─── Main Entry Point ──────────────────────────────────────────────────────

export async function hooksCommand(event: string, agentSlug?: string): Promise<void> {
  debugLog(event, '=== HOOK INVOKED ===', { pid: process.pid, argv: process.argv, cwd: process.cwd() });

  const input = await readStdin();

  switch (event) {
    case 'session-start':
      await handleSessionStart(input, agentSlug);
      break;
    case 'user-prompt-submit':
      await handleUserPromptSubmit(input, agentSlug);
      break;
    case 'stop':
      await handleStop(input, agentSlug);
      break;
    case 'session-end':
      await handleSessionEnd(input, agentSlug);
      break;
    case 'pre-tool-use':
      await handlePreToolUse(input, agentSlug);
      break;
    case 'post-tool-use':
      await handlePostToolUse(input, agentSlug);
      break;
    default:
      debugLog(event, 'unknown event');
      process.stderr.write(`[origin] unknown hook event: ${event}\n`);
  }

  debugLog(event, '=== HOOK COMPLETE ===');
}
