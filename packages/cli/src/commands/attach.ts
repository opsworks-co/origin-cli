import chalk from 'chalk';
import { execFileSync } from 'child_process';
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { loadConfig, loadAgentConfig } from '../config.js';
import { getGitRoot, getGitDir, getHeadSha, getBranch, saveSessionState, loadSessionState, listActiveSessions, startHeartbeat } from '../session-state.js';
import type { SessionState } from '../session-state.js';
import { api } from '../api.js';

// ─── Agent Detection ──────────────────────────────────────────────────────

interface AgentInfo {
  slug: string;
  displayName: string;
  pgrepPattern: string;
  pid?: number;
}

const KNOWN_AGENTS: AgentInfo[] = [
  { slug: 'claude-code', displayName: 'Claude Code', pgrepPattern: 'claude.*stream-json' },
  { slug: 'cursor', displayName: 'Cursor', pgrepPattern: 'cursor' },
  { slug: 'gemini-cli', displayName: 'Gemini CLI', pgrepPattern: 'gemini.*cli|/gemini ' },
  { slug: 'codex', displayName: 'Codex', pgrepPattern: 'codex' },
  { slug: 'copilot', displayName: 'GitHub Copilot', pgrepPattern: 'copilot.*cli|github-copilot' },
  { slug: 'windsurf', displayName: 'Windsurf', pgrepPattern: 'windsurf|codeium' },
  { slug: 'aider', displayName: 'Aider', pgrepPattern: 'aider' },
];

/**
 * Run pgrep safely, filtering out the current process tree.
 * Returns matched PIDs (excluding our own process).
 */
function safePgrepPids(pattern: string): number[] {
  const myPid = process.pid;
  const myPpid = process.ppid;
  try {
    const raw = execFileSync('pgrep', ['-f', pattern], {
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
    }).trim();
    if (!raw) return [];
    return raw
      .split('\n')
      .map(p => parseInt(p.trim(), 10))
      .filter(p => !isNaN(p) && p !== myPid && p !== myPpid);
  } catch {
    return [];
  }
}

function detectRunningAgents(): Array<AgentInfo & { pid: number }> {
  const found: Array<AgentInfo & { pid: number }> = [];
  for (const agent of KNOWN_AGENTS) {
    const pids = safePgrepPids(agent.pgrepPattern);
    if (pids.length > 0) {
      found.push({ ...agent, pid: pids[0] });
    }
  }
  return found;
}

function resolveAgentSlug(input: string): AgentInfo | null {
  const lower = input.toLowerCase();
  // Exact slug match
  const exact = KNOWN_AGENTS.find(a => a.slug === lower);
  if (exact) return exact;
  // Partial match (e.g. "claude" matches "claude-code", "gemini" matches "gemini-cli")
  const partial = KNOWN_AGENTS.find(a => a.slug.includes(lower) || a.displayName.toLowerCase().includes(lower));
  return partial || null;
}

// ─── Command ────────────────────────────────────────────────────────────────

export async function attachCommand(agent?: string) {
  const cwd = process.cwd();

  // 1. Check git repo
  const repoPath = getGitRoot(cwd);
  if (!repoPath) {
    console.error(chalk.red('\n  Error: Not inside a git repository.\n'));
    process.exit(1);
  }

  // 2. Check origin is initialized
  const config = loadConfig();
  const agentConfig = loadAgentConfig();
  if (!agentConfig) {
    console.error(chalk.red('\n  Error: Origin not initialized. Run `origin init` first.\n'));
    process.exit(1);
  }

  // 3. Check if there's already an active session
  const activeSessions = listActiveSessions(cwd);
  if (activeSessions.length > 0) {
    console.log(chalk.yellow('\n  Already tracking an active session in this repo:'));
    for (const s of activeSessions) {
      console.log(chalk.gray(`    Session: ${chalk.white(s.sessionId)}  Model: ${chalk.cyan(s.model)}`));
    }
    console.log(chalk.gray('\n  Use `origin status` to see details.\n'));
    return;
  }

  // 4. Detect running agents
  const running = detectRunningAgents();

  // 5. If agent specified, find it
  let target: (AgentInfo & { pid?: number }) | null = null;

  if (agent) {
    const resolved = resolveAgentSlug(agent);
    if (!resolved) {
      console.error(chalk.red(`\n  Unknown agent: ${agent}`));
      console.log(chalk.gray('  Supported agents: ' + KNOWN_AGENTS.map(a => a.slug).join(', ') + '\n'));
      process.exit(1);
    }
    // Check if it's actually running
    const match = running.find(r => r.slug === resolved.slug);
    if (match) {
      target = match;
    } else {
      // Agent specified but not detected — attach anyway (user knows best)
      target = resolved;
      console.log(chalk.yellow(`\n  Warning: ${resolved.displayName} not detected as running.`));
      console.log(chalk.gray('  Attaching anyway — hooks will capture on next commit.\n'));
    }
  } else if (running.length === 0) {
    console.log(chalk.yellow('\n  No running AI agents detected.'));
    console.log(chalk.gray('  Supported agents: ' + KNOWN_AGENTS.map(a => a.slug).join(', ')));
    console.log(chalk.gray('  You can specify one explicitly: origin attach <agent>\n'));
    process.exit(1);
  } else if (running.length === 1) {
    target = running[0];
  } else {
    // Multiple agents found
    console.log(chalk.yellow('\n  Multiple AI agents detected:\n'));
    for (const r of running) {
      console.log(chalk.gray(`    ${chalk.white(r.displayName)} (PID ${r.pid}) — ${chalk.cyan(`origin attach ${r.slug}`)}`));
    }
    console.log(chalk.gray('\n  Specify which agent to attach to.\n'));
    process.exit(1);
  }

  if (!target) return;

  // Show detection
  if (target.pid) {
    console.log(chalk.gray(`\n  Found: ${chalk.white(target.displayName)} (PID ${target.pid})`));
  }

  // 6. Create session
  const sessionId = crypto.randomUUID();
  const headSha = getHeadSha(cwd);
  const branch = getBranch(cwd);
  // Normalize slug: gemini-cli -> gemini for hooks compatibility
  const hookSlug = target.slug === 'gemini-cli' ? 'gemini' : target.slug;

  const state: SessionState = {
    sessionId,
    claudeSessionId: `attached-${sessionId.slice(0, 8)}`,
    transcriptPath: '',
    model: hookSlug,
    startedAt: new Date().toISOString(),
    prompts: [],
    repoPath,
    headShaAtStart: headSha,
    headShaAtLastStop: headSha,
    prePromptSha: headSha,
    branch,
    status: 'RUNNING',
  };

  // Save session state
  saveSessionState(state, cwd);

  // 7. Register with API if connected
  const connected = config?.mode !== 'standalone' && config?.apiKey && config?.apiUrl;
  if (connected) {
    try {
      const result = await api.startSession({
        machineId: agentConfig.machineId,
        prompt: '(attached mid-session)',
        model: hookSlug,
        repoPath,
        agentSlug: hookSlug,
        branch: branch || undefined,
        hostname: agentConfig.hostname,
      }) as any;
      // Update session ID from API response
      if (result?.sessionId) {
        state.sessionId = result.sessionId;
        saveSessionState(state, cwd);
      }
    } catch {
      // Non-fatal — session is tracked locally regardless
    }
  }

  // 8. Start heartbeat
  if (connected) {
    const stateFile = path.join(getGitDir(cwd) || '', 'origin-session.json');
    startHeartbeat(state.sessionId, config!.apiUrl, config!.apiKey, stateFile, hookSlug);
  }

  // 9. Success
  console.log(chalk.green(`  ✔ Attached to ${target.displayName} session.`));
  console.log(chalk.gray('  Origin will capture this session on next commit.\n'));
  console.log(chalk.gray(`  Session ID: ${chalk.white(state.sessionId)}`));
  if (branch) {
    console.log(chalk.gray(`  Branch:     ${chalk.yellow(branch)}`));
  }
  console.log('');
}
