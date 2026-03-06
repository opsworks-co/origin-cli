import { loadConfig, loadAgentConfig } from '../config.js';
import { api } from '../api.js';
import { parseTranscript, estimateCost, formatTranscriptForDisplay, extractPromptFileMappings } from '../transcript.js';
import {
  saveSessionState,
  loadSessionState,
  clearSessionState,
  getGitRoot,
  getHeadSha,
  type SessionState,
} from '../session-state.js';
import { captureGitState } from '../git-capture.js';
import { writeLocalEntrypoint } from '../local-entrypoint.js';
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
  const repoPath = getGitRoot(hookCwd);
  if (!repoPath) {
    debugLog('session-start', 'SKIP: not a git repo', { hookCwd });
    return;
  }
  debugLog('session-start', 'repo path resolved', { repoPath });

  const claudeSessionId = input.session_id || '';
  const transcriptPath = input.transcript_path || '';
  const model = input.model || 'unknown';

  try {
    debugLog('session-start', 'calling api.startSession', { machineId: agentConfig.machineId, model, repoPath });
    const result = await api.startSession({
      machineId: agentConfig.machineId,
      prompt: '',
      model,
      repoPath,
      agentSlug: agentSlug || undefined,
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
    };

    saveSessionState(state, hookCwd);
    debugLog('session-start', 'state saved', { sessionId: result.sessionId });

    // Output system message to Claude Code
    const output = JSON.stringify({
      systemMessage: 'Origin: Session tracking active — prompts, files, and tokens will be captured.',
    });
    process.stdout.write(output);
  } catch (err: any) {
    debugLog('session-start', 'ERROR', { message: err.message, stack: err.stack });
    process.stderr.write(`[origin] session-start error: ${err.message}\n`);
  }
}

async function handleUserPromptSubmit(input: Record<string, any>): Promise<void> {
  debugLog('user-prompt-submit', 'begin', { hasPrompt: !!input.prompt, cwd: input.cwd });

  const hookCwd = input.cwd || process.cwd();
  const state = loadSessionState(hookCwd);
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

    saveSessionState(state, hookCwd);
    debugLog('user-prompt-submit', 'prompt saved', { promptCount: state.prompts.length, sessionId: state.sessionId });
  }
}

async function handleStop(input: Record<string, any>): Promise<void> {
  debugLog('stop', 'begin', { cwd: input.cwd });

  const config = loadConfig();
  const hookCwd = input.cwd || process.cwd();
  const state = loadSessionState(hookCwd);
  if (!config || !state) {
    debugLog('stop', 'ABORT: missing config or state', { hasConfig: !!config, hasState: !!state });
    return;
  }

  // Update transcript path if provided
  if (input.transcript_path) {
    state.transcriptPath = input.transcript_path;
    saveSessionState(state, hookCwd);
  }

  try {
    debugLog('stop', 'parsing transcript', { transcriptPath: state.transcriptPath });
    const parsed = parseTranscript(state.transcriptPath);

    // Format transcript for dashboard display (converts JSONL → [{role, content}] JSON)
    const displayTranscript = formatTranscriptForDisplay(state.transcriptPath);
    debugLog('stop', 'formatted transcript', { displayLength: displayTranscript.length });

    // Use prompts from transcript if we captured them, else from state
    const prompts = parsed.prompts.length > 0 ? parsed.prompts : state.prompts;
    const joinedPrompt = prompts.join('\n\n---\n\n');

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
  } catch (err: any) {
    debugLog('stop', 'ERROR', { message: err.message, stack: err.stack });
    process.stderr.write(`[origin] stop error: ${err.message}\n`);
  }
}

async function handleSessionEnd(input: Record<string, any>): Promise<void> {
  debugLog('session-end', 'begin', { cwd: input.cwd });

  const config = loadConfig();
  const hookCwd = input.cwd || process.cwd();
  const state = loadSessionState(hookCwd);
  if (!config || !state) {
    debugLog('session-end', 'ABORT: missing config or state', { hasConfig: !!config, hasState: !!state });
    return;
  }

  debugLog('session-end', 'state loaded', { sessionId: state.sessionId, promptCount: state.prompts.length });

  // Update transcript path if provided
  if (input.transcript_path) {
    state.transcriptPath = input.transcript_path;
  }

  try {
    const parsed = parseTranscript(state.transcriptPath);

    // Format transcript for dashboard display (converts JSONL → [{role, content}] JSON)
    const displayTranscript = formatTranscriptForDisplay(state.transcriptPath);
    debugLog('session-end', 'formatted transcript', { displayLength: displayTranscript.length });

    const prompts = parsed.prompts.length > 0 ? parsed.prompts : state.prompts;
    const joinedPrompt = prompts.join('\n\n---\n\n');

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
    });
    debugLog('session-end', 'api.endSession complete');

    // Write local entrypoint file to .origin/sessions/ (like Entire's .entire/ checkpoints)
    const apiUrl = config.apiUrl || 'https://origin-platform.fly.dev';
    writeLocalEntrypoint(state.repoPath, {
      sessionId: state.sessionId,
      model,
      startedAt: state.startedAt,
      endedAt: new Date().toISOString(),
      durationMs,
      costUsd,
      tokensUsed: parsed.tokensUsed,
      inputTokens: parsed.inputTokens,
      outputTokens: parsed.outputTokens,
      toolCalls: parsed.toolCalls,
      linesAdded: gitCapture.linesAdded,
      linesRemoved: gitCapture.linesRemoved,
      prompts,
      filesChanged: parsed.filesChanged,
      promptChanges: promptMappings.map((m) => ({
        prompt: m.promptText,
        files: m.filesChanged,
      })),
      git: {
        headBefore: gitCapture.headBefore || '',
        headAfter: gitCapture.headAfter || '',
        commitShas: gitCapture.commitShas,
      },
      summary: parsed.summary,
      originUrl: `${apiUrl}/sessions/${state.sessionId}`,
    });
  } catch (err: any) {
    debugLog('session-end', 'ERROR', { message: err.message, stack: err.stack });
    process.stderr.write(`[origin] session-end error: ${err.message}\n`);
  } finally {
    clearSessionState(hookCwd);
    debugLog('session-end', 'state cleared');
  }
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
      await handleUserPromptSubmit(input);
      break;
    case 'stop':
      await handleStop(input);
      break;
    case 'session-end':
      await handleSessionEnd(input);
      break;
    default:
      debugLog(event, 'unknown event');
      process.stderr.write(`[origin] unknown hook event: ${event}\n`);
  }

  debugLog(event, '=== HOOK COMPLETE ===');
}
