import fs from 'fs';
import path from 'path';
import os from 'os';
import crypto from 'crypto';
import { execSync, spawn } from 'child_process';
import { fileURLToPath } from 'url';

// ─── Types ─────────────────────────────────────────────────────────────────

export interface SubagentRecord {
  toolCallId: string;
  toolName: string;
  startedAt: string;
  endedAt?: string;
  prompt?: string;
  result?: string;
}

export interface TabCompletionStats {
  count: number;
  acceptedCount: number;
  totalCharsGenerated: number;
  avgAcceptanceRate: number;
}

export interface SessionState {
  sessionId: string;          // Origin API session ID
  claudeSessionId: string;    // Claude Code's session ID
  transcriptPath: string;     // Path to JSONL transcript file
  model: string;
  startedAt: string;          // ISO timestamp
  prompts: string[];          // Accumulated user prompts
  repoPath: string;           // Git repo root path OR working directory
  headShaAtStart: string | null; // HEAD commit SHA when session started (null if no git)
  branch: string | null;      // Git branch at session start
  sessionTag?: string;        // Tag for concurrent session support
  subagents?: SubagentRecord[];
  tabCompletions?: TabCompletionStats;
  agentSystemPrompt?: string; // Cached agent system prompt for session resume
  activePolicies?: string[];  // Cached active policies for session resume
  enforcementRules?: Array<{ type: string; condition: string; action: string; severity: string }>;
}

// ─── Git Directory ─────────────────────────────────────────────────────────

export function getGitDir(cwd?: string): string | null {
  try {
    return execSync('git rev-parse --git-dir', { encoding: 'utf-8', cwd: cwd || undefined, stdio: ['pipe', 'pipe', 'pipe'] }).trim();
  } catch {
    return null;
  }
}

export function getGitRoot(cwd?: string): string | null {
  try {
    return execSync('git rev-parse --show-toplevel', { encoding: 'utf-8', cwd: cwd || undefined, stdio: ['pipe', 'pipe', 'pipe'] }).trim();
  } catch {
    return null;
  }
}

/**
 * Try harder to find a git repo when the cwd itself isn't one.
 * Checks immediate subdirectories and common workspace patterns.
 * Useful when Claude Code reports a project root that's a parent of the actual repo.
 */
export function discoverGitRoot(cwd?: string): string | null {
  const dir = cwd || process.cwd();

  // 1. Direct check
  const direct = getGitRoot(dir);
  if (direct) return direct;

  // 2. Check common workspace patterns (e.g. .openclaw/workspace/*)
  const workspacePatterns = [
    path.join(dir, '.openclaw', 'workspace'),
    path.join(dir, 'workspace'),
  ];
  for (const wsDir of workspacePatterns) {
    try {
      if (!fs.existsSync(wsDir)) continue;
      const entries = fs.readdirSync(wsDir, { withFileTypes: true });
      for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        const candidate = path.join(wsDir, entry.name);
        const found = getGitRoot(candidate);
        if (found) return found;
      }
    } catch { /* ignore */ }
  }

  // 3. Scan immediate subdirectories (one level deep)
  try {
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.name.startsWith('.')) continue;
      const candidate = path.join(dir, entry.name);
      if (fs.existsSync(path.join(candidate, '.git'))) {
        return getGitRoot(candidate);
      }
    }
  } catch { /* ignore */ }

  return null;
}

export function getHeadSha(cwd?: string): string | null {
  try {
    return execSync('git rev-parse HEAD', { encoding: 'utf-8', cwd: cwd || undefined, stdio: ['pipe', 'pipe', 'pipe'] }).trim();
  } catch {
    return null;
  }
}

export function getBranch(cwd?: string): string | null {
  try {
    return execSync('git rev-parse --abbrev-ref HEAD', { encoding: 'utf-8', cwd: cwd || undefined, stdio: ['pipe', 'pipe', 'pipe'] }).trim() || null;
  } catch {
    return null;
  }
}

// ─── Session State Persistence ─────────────────────────────────────────────

/**
 * Get the path for storing session state.
 * Prefers .git/origin-session.json if in a git repo.
 * Falls back to ~/.origin/sessions/<cwd-hash>.json otherwise.
 */
function getStatePath(cwd?: string, sessionTag?: string): string {
  const suffix = sessionTag ? `origin-session-${sessionTag}.json` : 'origin-session.json';

  // Try git dir first
  const gitDir = getGitDir(cwd);
  if (gitDir) {
    const resolvedGitDir = path.isAbsolute(gitDir) ? gitDir : path.resolve(cwd || process.cwd(), gitDir);
    return path.join(resolvedGitDir, suffix);
  }

  // Fallback: store in ~/.origin/sessions/ keyed by cwd hash
  const effectiveCwd = cwd || process.cwd();
  const cwdHash = crypto.createHash('md5').update(effectiveCwd).digest('hex').slice(0, 12);
  const sessionsDir = path.join(os.homedir(), '.origin', 'sessions');
  fs.mkdirSync(sessionsDir, { recursive: true });
  const basename = sessionTag ? `${cwdHash}-${sessionTag}.json` : `${cwdHash}.json`;
  return path.join(sessionsDir, basename);
}

export function saveSessionState(state: SessionState, cwd?: string, sessionTag?: string): void {
  const statePath = getStatePath(cwd, sessionTag || state.sessionTag);
  fs.writeFileSync(statePath, JSON.stringify(state, null, 2));
}

export function loadSessionState(cwd?: string, sessionTag?: string): SessionState | null {
  const statePath = getStatePath(cwd, sessionTag);
  try {
    return JSON.parse(fs.readFileSync(statePath, 'utf-8'));
  } catch {
    return null;
  }
}

export function clearSessionState(cwd?: string, sessionTag?: string): void {
  const statePath = getStatePath(cwd, sessionTag);
  try {
    fs.unlinkSync(statePath);
  } catch {
    // file doesn't exist, that's fine
  }
}

// ─── Concurrent Session Support ──────────────────────────────────────────

/**
 * List all active sessions in a git repo (or cwd).
 * Scans for all origin-session*.json files.
 */
export function listActiveSessions(cwd?: string): SessionState[] {
  const sessions: SessionState[] = [];

  // Check git dir
  const gitDir = getGitDir(cwd);
  if (gitDir) {
    const resolvedGitDir = path.isAbsolute(gitDir) ? gitDir : path.resolve(cwd || process.cwd(), gitDir);
    try {
      const entries = fs.readdirSync(resolvedGitDir);
      for (const entry of entries) {
        if (entry.startsWith('origin-session') && entry.endsWith('.json')) {
          try {
            const state = JSON.parse(fs.readFileSync(path.join(resolvedGitDir, entry), 'utf-8'));
            sessions.push(state);
          } catch { /* skip corrupt files */ }
        }
      }
    } catch { /* ignore */ }
    return sessions;
  }

  // Check fallback dir
  const sessionsDir = path.join(os.homedir(), '.origin', 'sessions');
  try {
    const effectiveCwd = cwd || process.cwd();
    const cwdHash = crypto.createHash('md5').update(effectiveCwd).digest('hex').slice(0, 12);
    const entries = fs.readdirSync(sessionsDir);
    for (const entry of entries) {
      if (entry.startsWith(cwdHash) && entry.endsWith('.json')) {
        try {
          const state = JSON.parse(fs.readFileSync(path.join(sessionsDir, entry), 'utf-8'));
          sessions.push(state);
        } catch { /* skip */ }
      }
    }
  } catch { /* ignore */ }

  return sessions;
}

/**
 * Find a session by its Claude session ID.
 * Useful for concurrent sessions where multiple origin-session files exist.
 */
export function findSessionByClaudeId(claudeSessionId: string, cwd?: string): SessionState | null {
  // Try the default (untagged) session first
  const defaultState = loadSessionState(cwd);
  if (defaultState?.claudeSessionId === claudeSessionId) return defaultState;

  // Search all active sessions
  const sessions = listActiveSessions(cwd);
  return sessions.find(s => s.claudeSessionId === claudeSessionId) || null;
}

/**
 * Clear all session state files (e.g., after session-end).
 */
// ─── Heartbeat Daemon ───────────────────────────────────────────────────────

function getHeartbeatPidFile(sessionId: string): string {
  const dir = path.join(os.homedir(), '.origin', 'heartbeats');
  fs.mkdirSync(dir, { recursive: true });
  return path.join(dir, `${sessionId}.pid`);
}

/**
 * Spawn a detached background process that pings the API every 30s.
 * Keeps the session marked as RUNNING even when idle between prompts.
 */
export function startHeartbeat(sessionId: string, apiUrl: string, apiKey: string): void {
  const pidFile = getHeartbeatPidFile(sessionId);

  // Kill any existing heartbeat for this session
  stopHeartbeat(sessionId);

  try {
    // Resolve the heartbeat script path (sibling to this file in dist/)
    const __filename = fileURLToPath(import.meta.url);
    const __dirname = path.dirname(__filename);
    const heartbeatScript = path.join(__dirname, 'heartbeat.js');

    if (!fs.existsSync(heartbeatScript)) {
      // Fallback: script not found (dev mode or missing build)
      return;
    }

    const child = spawn(process.execPath, [heartbeatScript, sessionId, apiUrl, apiKey, pidFile], {
      detached: true,
      stdio: 'ignore',
    });
    child.unref();
  } catch {
    // Non-fatal — session tracking still works, just no keepalive
  }
}

/**
 * Kill the heartbeat daemon for a session.
 */
export function stopHeartbeat(sessionId: string): void {
  const pidFile = getHeartbeatPidFile(sessionId);
  try {
    if (fs.existsSync(pidFile)) {
      const pid = parseInt(fs.readFileSync(pidFile, 'utf-8').trim(), 10);
      if (pid > 0) {
        try { process.kill(pid, 'SIGTERM'); } catch { /* already dead */ }
      }
      fs.unlinkSync(pidFile);
    }
  } catch {
    // Ignore
  }
}

export function clearAllSessionStates(cwd?: string): void {
  const gitDir = getGitDir(cwd);
  if (gitDir) {
    const resolvedGitDir = path.isAbsolute(gitDir) ? gitDir : path.resolve(cwd || process.cwd(), gitDir);
    try {
      const entries = fs.readdirSync(resolvedGitDir);
      for (const entry of entries) {
        if (entry.startsWith('origin-session') && entry.endsWith('.json')) {
          try { fs.unlinkSync(path.join(resolvedGitDir, entry)); } catch { /* ignore */ }
        }
      }
    } catch { /* ignore */ }
  }
}
