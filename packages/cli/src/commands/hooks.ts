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
  getGitDir,
  getGitRoot,
  discoverGitRoot,
  getHeadSha,
  getBranch,
  startHeartbeat,
  stopHeartbeat,
  type SessionState,
  type SubagentRecord,
} from '../session-state.js';
import { captureGitState } from '../git-capture.js';
import { writeSessionFiles, pushSessionBranch, type PromptEntry, type PromptChange, type SessionWriteData } from '../local-entrypoint.js';
import { writeGitNotes } from '../git-notes.js';
import { redactSecrets } from '../redaction.js';
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
    fs.appendFileSync(DEBUG_LOG, line);
  } catch {
    // Never fail on logging
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
  gitCapture: { headBefore: string; headAfter: string; commitShas: string[]; linesAdded: number; linesRemoved: number };
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
  const repoRoot = state.repoPath || '';
  const allFiles = Array.from(new Set([
    ...parsed.filesChanged,
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
        debugLog('stdin', 'parsed', { keys: Object.keys(parsed), cwd: parsed.cwd, session_id: parsed.session_id });
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

// ─── Concurrent Session State Lookup ──────────────────────────────────────

/**
 * Find the correct session state for a hook invocation.
 *
 * With concurrent session support, each Claude Code window has its own
 * state file (tagged by sessionTag). This helper finds the right one by:
 * 1. Exact match on claudeSessionId (current or stored in state)
 * 2. Most recently started session (fallback for agent subprocesses
 *    that have a different session_id from the parent)
 *
 * Returns the state and the resolved cwd to use for saving.
 */
function findStateForHook(hookCwd: string, claudeSessionId?: string, agentSlug?: string): { state: SessionState; saveCwd: string } | null {
  const repoPath = discoverGitRoot(hookCwd) || hookCwd;

  // 1. If we have a claude session ID, try exact match
  if (claudeSessionId) {
    const found = findSessionByClaudeId(claudeSessionId, hookCwd)
      || (repoPath !== hookCwd ? findSessionByClaudeId(claudeSessionId, repoPath) : null);
    if (found) {
      debugLog('findStateForHook', 'exact match', { claudeSessionId, sessionId: found.sessionId, tag: found.sessionTag });
      return { state: found, saveCwd: found.repoPath || repoPath };
    }
  }

  // 2. Fall back to most recently started session for this repo
  //    (handles agent subprocesses with unknown session IDs)
  //    When agentSlug is provided, prefer sessions matching that agent's model
  //    to avoid closing Claude's session when Gemini ends (and vice versa).
  let sessions = listActiveSessions(hookCwd);
  if (sessions.length === 0 && repoPath !== hookCwd) {
    sessions = listActiveSessions(repoPath);
  }

  if (sessions.length > 0) {
    sessions.sort((a, b) => new Date(b.startedAt).getTime() - new Date(a.startedAt).getTime());

    // If we know the agent type, prefer sessions matching that model
    let best = sessions[0];
    if (agentSlug && sessions.length > 1) {
      const slugLower = agentSlug.toLowerCase();
      const modelMatch = sessions.find(s => {
        const m = (s.model || '').toLowerCase();
        return m.includes(slugLower) || slugLower.includes(m);
      });
      if (modelMatch) {
        best = modelMatch;
        debugLog('findStateForHook', 'agent-filtered match', { agentSlug, model: best.model, sessionId: best.sessionId });
      }
    }

    debugLog('findStateForHook', 'fallback to most recent', {
      claudeSessionId,
      agentSlug,
      matchedSessionId: best.sessionId,
      matchedClaudeId: best.claudeSessionId,
      matchedModel: best.model,
      tag: best.sessionTag,
      totalSessions: sessions.length,
    });
    return { state: best, saveCwd: best.repoPath || repoPath };
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

  // Use cwd from hook input (Claude Code passes this) or fall back to process.cwd()
  const hookCwd = input.cwd || process.cwd();
  debugLog('session-start', 'cwd resolved', { hookCwd, inputCwd: input.cwd, processCwd: process.cwd() });

  // Only track sessions in git repos — no repo means no code to govern
  // Use discoverGitRoot to handle cases where cwd is a parent of the actual repo
  // (e.g. Claude Code reports /project but the repo is /project/.openclaw/workspace/repo)
  const repoPath = discoverGitRoot(hookCwd);
  if (!repoPath) {
    debugLog('session-start', 'SKIP: not a git repo (even after discovery)', { hookCwd });
    return;
  }
  debugLog('session-start', 'repo path resolved', { repoPath, hookCwd, discovered: repoPath !== getGitRoot(hookCwd) });

  // Resolve agent slug: .origin.json → hook command slug → saved default → undefined
  const repoConfig = loadRepoConfig(repoPath);
  const finalAgentSlug = repoConfig?.agent || agentSlug || agentConfig.agentSlug || undefined;
  debugLog('session-start', 'agent resolved', {
    fromRepoConfig: repoConfig?.agent,
    fromHookCommand: agentSlug,
    fromSavedDefault: agentConfig.agentSlug,
    final: finalAgentSlug,
  });

  const claudeSessionId = input.session_id || '';
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
  if (!transcriptPath && (finalAgentSlug === 'gemini' || agentSlug === 'gemini')) {
    transcriptPath = discoverGeminiTranscriptPath() || '';
    if (transcriptPath) debugLog('session-start', 'auto-discovered transcript path', { transcriptPath });
  }

  // Resolve model: use stdin value, fall back to agent-specific default
  let model = input.model || '';
  if (!model || model === 'unknown') {
    // Default model name from agent slug so we never store 'unknown'
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
      branch,
      sessionTag,
      agentSystemPrompt,
      activePolicies,
      enforcementRules,
    };

    // Save to tagged file — each concurrent session gets its own state file
    saveSessionState(state, repoPath, sessionTag);
    debugLog('session-start', 'state saved', { sessionId, sessionTag });

    // Start background heartbeat daemon (only in connected mode)
    if (connected && config) {
      startHeartbeat(sessionId, config.apiUrl || 'https://getorigin.io', config.apiKey);
      debugLog('session-start', 'heartbeat started', { sessionId });
    }

    // Build system message: agent system prompt first, then tracking notice + policies
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

    const output = JSON.stringify({ systemMessage: systemMsg });
    process.stdout.write(output);
  } catch (err: any) {
    debugLog('session-start', 'ERROR', { message: err.message, stack: err.stack });
    // Show clear message if agent was rejected (strict mode)
    if (err.message?.includes('Unknown agent') || err.message?.includes('not registered')) {
      process.stderr.write(`[origin] Agent not registered. Ask your admin to add it in the Origin dashboard.\n`);
    } else {
      process.stderr.write(`[origin] session-start error: ${err.message}\n`);
    }
  }
}

async function handleUserPromptSubmit(input: Record<string, any>, agentSlug?: string): Promise<void> {
  debugLog('user-prompt-submit', 'begin', { hasPrompt: !!input.prompt, cwd: input.cwd });

  const hookCwd = input.cwd || process.cwd();

  // ── Find session state using concurrent-aware lookup ────────────────────────
  const found = findStateForHook(hookCwd, input.session_id);
  let state = found?.state || null;

  if (state) {
    // Update Claude session ID and transcript path if they changed
    // (agent subprocesses may have different session_id)
    const incomingSessionId = input.session_id || '';
    if (incomingSessionId && state.claudeSessionId !== incomingSessionId) {
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
        const finalAgentSlug = repoConfig?.agent || agentSlug || autoAgentConfig.agentSlug || undefined;
        const branch = getBranch(hookCwd);
        const model = input.model || (finalAgentSlug === 'gemini' ? 'gemini' : finalAgentSlug === 'codex' ? 'codex' : 'claude');
        const autoTag = (input.session_id || '').slice(0, 12) || `s${Date.now().toString(36)}`;

        let sessionId: string;
        if (isConnectedMode() && autoConfig) {
          const result = await api.startSession({
            machineId: autoAgentConfig.machineId,
            prompt: input.prompt || '',
            model,
            repoPath,
            agentSlug: finalAgentSlug,
            branch: branch || undefined,
          });
          sessionId = result.sessionId;
        } else {
          sessionId = `local-${crypto.randomUUID()}`;
        }

        debugLog('user-prompt-submit', 'auto-created session', { sessionId, sessionTag: autoTag });
        state = {
          sessionId,
          claudeSessionId: input.session_id || '',
          transcriptPath: input.transcript_path || '',
          model,
          startedAt: new Date().toISOString(),
          prompts: [],
          repoPath,
          headShaAtStart: getHeadSha(hookCwd),
          branch,
          sessionTag: autoTag,
        };
        saveSessionState(state, repoPath, autoTag);
      } catch (err: any) {
        debugLog('user-prompt-submit', 'auto-create failed', { message: err.message });
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
        const costUsd = parsed
          ? estimateCost(model, parsed.inputTokens, parsed.outputTokens, parsed.cacheReadTokens, parsed.cacheCreationTokens)
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
          model: model && model !== 'unknown' ? model : undefined,
          filesChanged: parsed?.filesChanged && parsed.filesChanged.length > 0 ? parsed.filesChanged : undefined,
          tokensUsed: parsed?.tokensUsed || undefined,
          inputTokens: parsed?.inputTokens || undefined,
          outputTokens: parsed?.outputTokens || undefined,
          toolCalls: parsed?.toolCalls || undefined,
          durationMs: durationMs > 0 ? durationMs : undefined,
          costUsd: costUsd > 0 ? costUsd : undefined,
          status: 'RUNNING',
        });
        debugLog('user-prompt-submit', 'heartbeat sent', { sessionId: state.sessionId, promptCount: state.prompts.length, costUsd });
      }
    } catch (err: any) {
      debugLog('user-prompt-submit', 'heartbeat error (non-fatal)', { message: err.message });
      // Non-fatal — don't block the agent
    }
  }
}

async function handleStop(input: Record<string, any>, agentSlug?: string): Promise<void> {
  debugLog('stop', 'begin', { cwd: input.cwd });

  const config = loadConfig();
  const connected = isConnectedMode();
  const hookCwd = input.cwd || process.cwd();
  const found = findStateForHook(hookCwd, input.session_id, agentSlug);
  const state = found?.state || null;
  if (!state) {
    debugLog('stop', 'ABORT: missing state', { hasConfig: !!config, hasState: !!state });
    return;
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
    const displayTranscript = formatTranscriptForDisplay(state.transcriptPath);
    debugLog('stop', 'formatted transcript', { displayLength: displayTranscript.length });

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
    const model = parsed.model || state.model;
    const costUsd = estimateCost(model, parsed.inputTokens, parsed.outputTokens, parsed.cacheReadTokens, parsed.cacheCreationTokens);

    // Extract prompt → file change mappings
    const promptMappings = extractPromptFileMappings(state.transcriptPath);
    debugLog('stop', 'prompt mappings', { count: promptMappings.length });

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
        filesChanged: parsed.filesChanged.length > 0 ? parsed.filesChanged : undefined,
        tokensUsed: parsed.tokensUsed || undefined,
        inputTokens: parsed.inputTokens || undefined,
        outputTokens: parsed.outputTokens || undefined,
        toolCalls: parsed.toolCalls || undefined,
        durationMs: durationMs > 0 ? durationMs : undefined,
        costUsd: costUsd > 0 ? costUsd : undefined,
        promptChanges: promptMappings.length > 0 ? promptMappings : undefined,
      });
      debugLog('stop', 'update complete');
    }

    // Write session files to origin-sessions branch + push on every Stop
    const apiUrl = config?.apiUrl || 'https://getorigin.io';
    const gitCapture = captureGitState(state.repoPath, state.headShaAtStart);
    const writeData = buildSessionWriteData({
      state, parsed, promptMappings, gitCapture,
      status: 'running', apiUrl,
    });
    writeSessionFiles(state.repoPath, writeData);
    pushSessionBranch(state.repoPath);
    debugLog('stop', 'session files written + pushed', { prompts: writeData.prompts.length, costUsd: writeData.costUsd });
  } catch (err: any) {
    debugLog('stop', 'ERROR', { message: err.message, stack: err.stack });
    process.stderr.write(`[origin] stop error: ${err.message}\n`);
  }
}

async function handleSessionEnd(input: Record<string, any>, agentSlug?: string): Promise<void> {
  debugLog('session-end', 'begin', { cwd: input.cwd });

  const config = loadConfig();
  const connected = isConnectedMode();
  const hookCwd = input.cwd || process.cwd();
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
    const model = parsed.model || state.model;
    const costUsd = estimateCost(model, parsed.inputTokens, parsed.outputTokens, parsed.cacheReadTokens, parsed.cacheCreationTokens);

    // Capture real git state: HEAD SHA, new commits, unified diff
    const gitCapture = captureGitState(state.repoPath, state.headShaAtStart);

    // Extract prompt → file change mappings from transcript
    const promptMappings = extractPromptFileMappings(state.transcriptPath);

    if (connected) {
      debugLog('session-end', 'calling api.endSession', {
        sessionId: state.sessionId,
        promptCount: prompts.length,
        filesCount: parsed.filesChanged.length,
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
        filesChanged: parsed.filesChanged.length > 0 ? parsed.filesChanged : undefined,
        tokensUsed: parsed.tokensUsed || undefined,
        inputTokens: parsed.inputTokens || undefined,
        outputTokens: parsed.outputTokens || undefined,
        toolCalls: parsed.toolCalls || undefined,
        durationMs: durationMs > 0 ? durationMs : undefined,
        costUsd: costUsd > 0 ? costUsd : undefined,
        gitCapture: gitCapture.diff ? gitCapture : undefined,
        promptChanges: promptMappings.length > 0 ? promptMappings : undefined,
        branch: getBranch(hookCwd) || undefined,
      });
      debugLog('session-end', 'api.endSession complete');
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
  // Pick the most recent session for trailer/notes (or null)
  let state = activeSessions.length > 0
    ? activeSessions.sort((a, b) => new Date(b.startedAt).getTime() - new Date(a.startedAt).getTime())[0]
    : null;

  // If no active session, detect if an AI agent CLI process is running
  // This handles cases where agent hooks didn't fire (e.g., Gemini CLI)
  if (!state) {
    let detectedModel: string | null = null;
    try {
      // Use pgrep for targeted process detection — look for CLI binaries, not desktop apps
      const checks = [
        { cmd: 'pgrep -f "gemini.*cli|/gemini "', model: 'gemini' },
        { cmd: 'pgrep -f "claude.*stream-json"', model: 'claude' },
        { cmd: 'pgrep -f "codex"', model: 'codex' },
        { cmd: 'pgrep -f "aider"', model: 'aider' },
        { cmd: 'pgrep -f "windsurf"', model: 'windsurf' },
        { cmd: 'pgrep -f "copilot.*cli|github-copilot"', model: 'copilot' },
        { cmd: 'pgrep -f "continue.*dev"', model: 'continue' },
        { cmd: 'pgrep -f "amp.*cli|/amp "', model: 'amp' },
        { cmd: 'pgrep -f "junie|jetbrains.*ai"', model: 'junie' },
        { cmd: 'pgrep -f "opencode"', model: 'opencode' },
        { cmd: 'pgrep -f "rovo.*dev"', model: 'rovo' },
        { cmd: 'pgrep -f "droid"', model: 'droid' },
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

  // Update branch on all active sessions if it changed
  for (const s of activeSessions) {
    if (currentBranch && currentBranch !== s.branch) {
      debugLog('post-commit', 'branch changed', { from: s.branch, to: currentBranch, sessionId: s.sessionId });
      s.branch = currentBranch;
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
  // Parse transcript now (not just at session-end) so we capture tokens, cost, prompts, files
  // Skip for detected (synthetic) sessions — they don't have transcripts
  if (state && state.transcriptPath) {
    const durationMs = Date.now() - new Date(state.startedAt).getTime();

    // Parse transcript for full metrics and write session files
    const parsed = parseTranscript(state.transcriptPath || '');
    const promptMappings = extractPromptFileMappings(state.transcriptPath || '');
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

  // Initialize subagents array if needed
  if (!state.subagents) state.subagents = [];

  const toolCallId = input.tool_call_id || `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
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

  // Push origin-sessions branch if it exists
  try {
    execSync('git rev-parse refs/heads/origin-sessions', execOpts);
    execSync('git push origin origin-sessions --no-verify --quiet', execOpts);
    debugLog('pre-push', 'pushed origin-sessions');
  } catch (err: any) {
    debugLog('pre-push', 'origin-sessions push skipped', { message: err.message });
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
