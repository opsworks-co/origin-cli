import { loadConfig, loadAgentConfig, saveAgentConfig, loadRepoConfig } from '../config.js';
import { detectTools } from '../tools-detector.js';
import { api } from '../api.js';
import { parseTranscript, estimateCost, formatTranscriptForDisplay, extractPromptFileMappings } from '../transcript.js';
import {
  saveSessionState,
  loadSessionState,
  clearSessionState,
  getGitRoot,
  discoverGitRoot,
  getHeadSha,
  getBranch,
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
  const agentConfig = loadAgentConfig();
  if (!config || !agentConfig) {
    debugLog('session-start', 'ABORT: missing config', { hasConfig: !!config, hasAgentConfig: !!agentConfig });
    return;
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

  const branch = getBranch(hookCwd);

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
      // Update server with new tool list
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
    } else {
      debugLog('session-start', 'tools unchanged', { tools: freshTools });
    }
  } catch (detectErr: any) {
    debugLog('session-start', 'tool detection failed (non-fatal)', { message: detectErr.message });
  }

  try {
    debugLog('session-start', 'calling api.startSession', { machineId: agentConfig.machineId, model, repoPath, agentSlug: finalAgentSlug, branch });
    const result = await api.startSession({
      machineId: agentConfig.machineId,
      prompt: '',
      model,
      repoPath,
      agentSlug: finalAgentSlug,
      branch: branch || undefined,
    });
    debugLog('session-start', 'api returned', { sessionId: result.sessionId });

    const state: SessionState = {
      sessionId: result.sessionId,
      claudeSessionId,
      transcriptPath,
      model,
      startedAt: new Date().toISOString(),
      prompts: [],
      repoPath,
      headShaAtStart: getHeadSha(hookCwd),
      branch,
    };

    saveSessionState(state, hookCwd);
    debugLog('session-start', 'state saved', { sessionId: result.sessionId });

    // Build system message with active policy summary
    let systemMsg = 'Origin: Session tracking active \u2014 prompts, files, and tokens will be captured.';
    if (result.activePolicies && Array.isArray(result.activePolicies) && result.activePolicies.length > 0) {
      systemMsg += '\n\nActive policies for this session:\n' +
        result.activePolicies.map((p: string) => `- ${p}`).join('\n');
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
  // Try direct cwd first, then discover git root for state lookup
  let state = loadSessionState(hookCwd);
  const resolvedCwd = !state ? discoverGitRoot(hookCwd) : hookCwd;
  if (!state && resolvedCwd) state = loadSessionState(resolvedCwd);

  // ── Auto-create session on resume ──────────────────────────────────────────
  // When Claude Code (or other agents) resume a session, SessionStart hook may
  // not fire again. If we have no state OR the Claude session ID changed (context
  // window reset), create a new Origin session on the fly.
  const incomingSessionId = input.session_id || '';
  const isResumedSession = state && incomingSessionId && state.claudeSessionId && state.claudeSessionId !== incomingSessionId;
  if (isResumedSession) {
    debugLog('user-prompt-submit', 'session ID changed — new context window detected', {
      old: state!.claudeSessionId,
      new: incomingSessionId,
      oldOriginSession: state!.sessionId,
    });
    state = null; // Force new session creation
  }
  if (!state) {
    debugLog('user-prompt-submit', 'no session state — attempting auto-create (resume scenario)', { hookCwd });
    const config = loadConfig();
    const agentConfig = loadAgentConfig();
    const repoPath = discoverGitRoot(hookCwd);
    if (config && agentConfig && repoPath) {
      try {
        const repoConfig = loadRepoConfig(repoPath);
        const finalAgentSlug = repoConfig?.agent || agentSlug || agentConfig.agentSlug || undefined;
        const branch = getBranch(hookCwd);
        const model = input.model || (finalAgentSlug === 'gemini' ? 'gemini' : finalAgentSlug === 'codex' ? 'codex' : 'claude');
        const result = await api.startSession({
          machineId: agentConfig.machineId,
          prompt: input.prompt || '',
          model,
          repoPath,
          agentSlug: finalAgentSlug,
          branch: branch || undefined,
        });
        debugLog('user-prompt-submit', 'auto-created session', { sessionId: result.sessionId });
        state = {
          sessionId: result.sessionId,
          claudeSessionId: input.session_id || '',
          transcriptPath: input.transcript_path || '',
          model,
          startedAt: new Date().toISOString(),
          prompts: [],
          repoPath,
          headShaAtStart: getHeadSha(hookCwd),
          branch,
        };
        saveSessionState(state, repoPath);
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

    saveSessionState(state, resolvedCwd || hookCwd);
    debugLog('user-prompt-submit', 'prompt saved', { promptCount: state.prompts.length, sessionId: state.sessionId });

    // ── Heartbeat: send incremental update to API on every prompt ──
    try {
      const config = loadConfig();
      if (config) {
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

async function handleStop(input: Record<string, any>): Promise<void> {
  debugLog('stop', 'begin', { cwd: input.cwd });

  const config = loadConfig();
  const hookCwd = input.cwd || process.cwd();
  let state = loadSessionState(hookCwd);
  const resolvedCwd = !state ? discoverGitRoot(hookCwd) : hookCwd;
  if (!state && resolvedCwd) state = loadSessionState(resolvedCwd);
  if (!config || !state) {
    debugLog('stop', 'ABORT: missing config or state', { hasConfig: !!config, hasState: !!state });
    return;
  }

  // Update transcript path if provided
  if (input.transcript_path) {
    state.transcriptPath = input.transcript_path;
    saveSessionState(state, hookCwd);
  }

  // Auto-discover Gemini transcript path if not already set
  if (!state.transcriptPath) {
    const discovered = discoverGeminiTranscriptPath();
    if (discovered) {
      state.transcriptPath = discovered;
      saveSessionState(state, hookCwd);
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

    // Write session files to origin-sessions branch + push on every Stop
    const apiUrl = config.apiUrl || 'https://origin-platform.fly.dev';
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

async function handleSessionEnd(input: Record<string, any>): Promise<void> {
  debugLog('session-end', 'begin', { cwd: input.cwd });

  const config = loadConfig();
  const hookCwd = input.cwd || process.cwd();
  let state = loadSessionState(hookCwd);
  const resolvedCwd = !state ? discoverGitRoot(hookCwd) : hookCwd;
  if (!state && resolvedCwd) state = loadSessionState(resolvedCwd);
  if (!config || !state) {
    debugLog('session-end', 'ABORT: missing config or state', { hasConfig: !!config, hasState: !!state });
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

    // Write session files to origin-sessions branch (directory per session)
    const apiUrl = config.apiUrl || 'https://origin-platform.fly.dev';
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
  } finally {
    clearSessionState(hookCwd);
    debugLog('session-end', 'state cleared');
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
  if (!config) {
    debugLog('post-commit', 'SKIP: no config');
    return;
  }

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
  const apiUrl = config.apiUrl || 'https://origin-platform.fly.dev';
  const state = loadSessionState(hookCwd);

  // Update local state if branch changed mid-session
  if (state && currentBranch && currentBranch !== state.branch) {
    debugLog('post-commit', 'branch changed', { from: state.branch, to: currentBranch });
    state.branch = currentBranch;
    saveSessionState(state, hookCwd);
  }

  // F13: Respect config.commitLinking setting (always|prompt|never)
  const commitLinkingConfig = config.commitLinking || 'always';
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

  try {
    writeGitNotes(repoPath, [commitSha], {
      sessionId: state?.sessionId || 'unknown',
      model: state?.model || 'unknown',
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

  // If there's an active Origin session, send incremental update
  if (state) {
    try {
      // Build incremental git capture
      const gitCapture = {
        headBefore: state.headShaAtStart || commitSha,
        headAfter: commitSha,
        commitShas: [commitSha],
        commitDetails: [{ sha: commitSha, message: commitMessage, author: commitAuthor, filesChanged }],
        diff: diff.length > 500_000 ? diff.slice(0, 500_000) : diff,
        diffTruncated: diff.length > 500_000,
        linesAdded,
        linesRemoved,
      };

      debugLog('post-commit', 'sending incremental update', { sessionId: state.sessionId, filesChanged: filesChanged.length });

      await api.updateSession(state.sessionId, {
        filesChanged: filesChanged.length > 0 ? filesChanged : undefined,
        branch: currentBranch || undefined,
        gitCapture,
      });
      debugLog('post-commit', 'API update complete');
    } catch (err: any) {
      debugLog('post-commit', 'API update error (non-fatal)', { message: err.message });
    }
  } else {
    debugLog('post-commit', 'no active session, skipped API update');
  }

  // Write full session entrypoint to origin-sessions branch on every commit
  // Parse transcript now (not just at session-end) so we capture tokens, cost, prompts, files
  if (state) {
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

async function handlePreToolUse(input: Record<string, any>): Promise<void> {
  debugLog('pre-tool-use', 'begin', { tool_name: input.tool_name, cwd: input.cwd });

  const hookCwd = input.cwd || process.cwd();
  let state = loadSessionState(hookCwd);
  const resolvedCwd = !state ? discoverGitRoot(hookCwd) : hookCwd;
  if (!state && resolvedCwd) state = loadSessionState(resolvedCwd);
  if (!state) {
    debugLog('pre-tool-use', 'ABORT: no session state');
    return;
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
  saveSessionState(state, resolvedCwd || hookCwd);
  debugLog('pre-tool-use', 'recorded', { toolCallId, toolName: record.toolName });
}

async function handlePostToolUse(input: Record<string, any>): Promise<void> {
  debugLog('post-tool-use', 'begin', { tool_name: input.tool_name, cwd: input.cwd });

  const hookCwd = input.cwd || process.cwd();
  let state = loadSessionState(hookCwd);
  const resolvedCwd = !state ? discoverGitRoot(hookCwd) : hookCwd;
  if (!state && resolvedCwd) state = loadSessionState(resolvedCwd);
  if (!state) {
    debugLog('post-tool-use', 'ABORT: no session state');
    return;
  }

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
      saveSessionState(state, resolvedCwd || hookCwd);
      debugLog('post-tool-use', 'updated', { toolCallId: record.toolCallId, toolName });
    }
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
      await handleStop(input);
      break;
    case 'session-end':
      await handleSessionEnd(input);
      break;
    case 'pre-tool-use':
      await handlePreToolUse(input);
      break;
    case 'post-tool-use':
      await handlePostToolUse(input);
      break;
    default:
      debugLog(event, 'unknown event');
      process.stderr.write(`[origin] unknown hook event: ${event}\n`);
  }

  debugLog(event, '=== HOOK COMPLETE ===');
}
