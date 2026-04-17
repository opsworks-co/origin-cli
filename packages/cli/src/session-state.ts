import fs from 'fs';
import path from 'path';
import os from 'os';
import crypto from 'crypto';
import { execSync, spawn } from 'child_process';
import { fileURLToPath } from 'url';

// ─── Types ─────────────────────────────────────────────────────────────────

/**
 * One entry per pre-tool-use / post-tool-use pair. The historical name was
 * `SubagentRecord` but this tracks ALL tool calls (Bash, Read, Edit, Task,
 * etc.) — not just Task-spawned sub-agents. Renamed in the R2 audit cleanup.
 *
 * Real sub-agent spawns (Claude Code Task tool) need their own record type
 * with model/subagent_type fields — see docs/notes/SUBAGENT_AUDIT.md (R3).
 */
export interface ToolCallRecord {
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
  headShaAtLastStop: string | null; // HEAD SHA after last prompt stop (for per-prompt diffs)
  prePromptSha: string | null;  // HEAD SHA before current prompt (for per-prompt git diffs)
  completedPromptMappings?: Array<{  // Accumulated per-prompt file change mappings
    promptIndex: number;
    promptText: string;
    filesChanged: string[];
    diff: string;
    uncommittedDiff?: string;
  }>;
  branch: string | null;      // Git branch at session start
  sessionTag?: string;        // Tag for concurrent session support
  // Ring buffer of tool-call pre/post records. Field kept as `subagents` for
  // backward compat with serialized session-state files. See R2 in
  // docs/notes/SUBAGENT_AUDIT.md.
  subagents?: ToolCallRecord[];
  tabCompletions?: TabCompletionStats;
  agentSystemPrompt?: string; // Cached agent system prompt for session resume
  activePolicies?: string[];  // Cached active policies for session resume
  prePromptDirtyFiles?: string[]; // Files that were already dirty (uncommitted) before current prompt
  enforcementRules?: Array<{ type: string; condition: string; action: string; severity: string }>;
  trailId?: string;           // Trail ID if session is linked to an active trail
  agentSlug?: string;         // Agent slug (claude-code, cursor, codex, gemini, etc.)
  status?: string;            // RUNNING | ENDED | COMPLETED
  endedAt?: string;           // ISO timestamp when session ended
  // Multi-repo support: when cwd contains multiple git repos
  repoPaths?: string[];       // All git repo roots discovered under cwd
  perRepoState?: Record<string, {
    headShaAtStart: string | null;
    headShaAtLastStop: string | null;
    prePromptSha: string | null;
    prePromptDirtyFiles: string[];
    branch: string | null;
  }>;
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

/**
 * Discover ALL git repos under a directory (immediate subdirectories).
 * Used when the cwd itself is not a git repo but contains multiple repos.
 */
export function discoverAllGitRoots(cwd?: string): string[] {
  const dir = cwd || process.cwd();

  // If the directory itself is a git repo, return just that
  const direct = getGitRoot(dir);
  if (direct) return [direct];

  const roots: string[] = [];

  // Check common workspace patterns
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
        if (found && !roots.includes(found)) roots.push(found);
      }
    } catch { /* ignore */ }
  }

  // Scan immediate subdirectories
  try {
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.name.startsWith('.')) continue;
      const candidate = path.join(dir, entry.name);
      if (fs.existsSync(path.join(candidate, '.git'))) {
        const found = getGitRoot(candidate);
        if (found && !roots.includes(found)) roots.push(found);
      }
    }
  } catch { /* ignore */ }

  return roots;
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
export function getStatePath(cwd?: string, sessionTag?: string): string {
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
  fs.mkdirSync(sessionsDir, { recursive: true, mode: 0o700 });
  const basename = sessionTag ? `${cwdHash}-${sessionTag}.json` : `${cwdHash}.json`;
  return path.join(sessionsDir, basename);
}

export function saveSessionState(state: SessionState, cwd?: string, sessionTag?: string): void {
  const statePath = getStatePath(cwd, sessionTag || state.sessionTag);
  const tmpStatePath = statePath + '.tmp.' + process.pid;
  fs.writeFileSync(tmpStatePath, JSON.stringify(state, null, 2), { mode: 0o600 });
  fs.renameSync(tmpStatePath, statePath);

  // Also mirror to ~/.origin/sessions/ for global discovery (origin sessions --all)
  // Always mark as RUNNING since this is an active save
  try {
    const globalDir = path.join(os.homedir(), '.origin', 'sessions');
    fs.mkdirSync(globalDir, { recursive: true, mode: 0o700 });
    const globalPath = path.join(globalDir, `${state.sessionId.slice(0, 12)}.json`);
    const globalState = { ...state, status: 'RUNNING' };
    const tmpGlobalPath = globalPath + '.tmp.' + process.pid;
    fs.writeFileSync(tmpGlobalPath, JSON.stringify(globalState, null, 2), { mode: 0o600 });
    fs.renameSync(tmpGlobalPath, globalPath);
  } catch { /* non-fatal */ }
}

export function loadSessionState(cwd?: string, sessionTag?: string): SessionState | null {
  const statePath = getStatePath(cwd, sessionTag);
  try {
    const parsed = JSON.parse(fs.readFileSync(statePath, 'utf-8'));
    if (!parsed || typeof parsed !== 'object' || !parsed.sessionId || !parsed.claudeSessionId) {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

export function clearSessionState(cwd?: string, sessionTag?: string): void {
  const statePath = getStatePath(cwd, sessionTag);
  try {
    // Instead of deleting, mark as ended and archive to ~/.origin/sessions/
    const raw = fs.readFileSync(statePath, 'utf-8');
    const state = JSON.parse(raw);
    state.status = 'ENDED';
    state.endedAt = new Date().toISOString();

    // Archive to ~/.origin/sessions/ so origin sessions --all can find it
    const archiveDir = path.join(os.homedir(), '.origin', 'sessions');
    fs.mkdirSync(archiveDir, { recursive: true, mode: 0o700 });
    const archivePath = path.join(archiveDir, `${state.sessionId.slice(0, 12)}.json`);
    const tmpArchivePath = archivePath + '.tmp.' + process.pid;
    fs.writeFileSync(tmpArchivePath, JSON.stringify(state), { mode: 0o600 });
    fs.renameSync(tmpArchivePath, archivePath);

    // Remove active state file
    fs.unlinkSync(statePath);
  } catch {
    // file doesn't exist or corrupt, try plain delete
    try { fs.unlinkSync(statePath); } catch { /* ignore */ }
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
            if (!state || typeof state !== 'object' || !state.sessionId) continue;
            // Extract sessionTag from filename: origin-session-TAG.json or origin-session.json
            if (!state.sessionTag) {
              const tagMatch = entry.match(/^origin-session-(.+)\.json$/);
              if (tagMatch) state.sessionTag = tagMatch[1];
            }
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
          if (!state || typeof state !== 'object' || !state.sessionId) continue;
          sessions.push(state);
        } catch { /* skip */ }
      }
    }
  } catch { /* ignore */ }

  return sessions;
}

/**
 * List sessions from ALL repos (for --all/--global flag).
 * Scans ~/.origin/sessions/ for both active and archived sessions.
 */
export function listAllActiveSessions(): SessionState[] {
  const sessions: SessionState[] = [];
  const seen = new Set<string>();

  // Scan ~/.origin/sessions/ — ALL files (active + archived)
  const sessionsDir = path.join(os.homedir(), '.origin', 'sessions');
  try {
    const entries = fs.readdirSync(sessionsDir);
    for (const entry of entries) {
      if (entry.endsWith('.json')) {
        try {
          const filePath = path.join(sessionsDir, entry);
          const state = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
          if (!state || typeof state !== 'object' || !state.sessionId) continue;
          if (seen.has(state.sessionId)) continue;
          seen.add(state.sessionId);

          // Auto-expire RUNNING sessions that are stale:
          // If status is not ENDED, check if the session is actually still alive
          if (state.status !== 'ENDED') {
            const STALE_MS = 3 * 60 * 60 * 1000; // 3 hours
            let isAlive = false;

            // Check 1: is there an active .git state file being updated?
            if (state.repoPath && state.sessionTag) {
              try {
                const gitStateFile = path.join(state.repoPath, `.git`, `origin-session-${state.sessionTag}.json`);
                const stat = fs.statSync(gitStateFile);
                if (Date.now() - stat.mtimeMs < STALE_MS) {
                  isAlive = true;
                }
              } catch { /* file gone or not accessible */ }
            }

            // Check 2: is the heartbeat daemon still running?
            if (!isAlive) {
              try {
                const heartbeatDir = path.join(os.homedir(), '.origin', 'heartbeats');
                const pidFile = path.join(heartbeatDir, `${state.sessionId}.pid`);
                if (fs.existsSync(pidFile)) {
                  const pid = parseInt(fs.readFileSync(pidFile, 'utf-8').trim(), 10);
                  if (pid > 0) {
                    process.kill(pid, 0); // existence check
                    isAlive = true;
                  }
                }
              } catch { /* process dead or pid file gone */ }
            }

            // Check 3: was the archive file itself recently updated?
            if (!isAlive) {
              try {
                const stat = fs.statSync(filePath);
                if (Date.now() - stat.mtimeMs < STALE_MS) {
                  isAlive = true;
                }
              } catch { /* ignore */ }
            }

            if (!isAlive) {
              state.status = 'ENDED';
              state.endedAt = state.endedAt || new Date().toISOString();
              // Persist the correction
              try {
                const tmpFilePath = filePath + '.tmp.' + process.pid;
                fs.writeFileSync(tmpFilePath, JSON.stringify(state), { mode: 0o600 });
                fs.renameSync(tmpFilePath, filePath);
              } catch { /* best effort */ }
            }
          }

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
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  return path.join(dir, `${sessionId}.pid`);
}

/**
 * Walk up the process tree to find an ancestor whose command matches a pattern.
 * Returns the PID of the matching ancestor, or 0 if not found.
 * Used to find the actual agent process (e.g. Codex, Gemini) since hooks are
 * spawned via shell wrappers that die immediately after the hook exits.
 */
function findAncestorPid(pattern: RegExp, maxDepth = 10): number {
  try {
    let pid = process.ppid || 0;
    for (let i = 0; i < maxDepth && pid > 1; i++) {
      // Get the command and parent of this PID
      const info = execSync(`ps -p ${pid} -o ppid=,command=`, {
        encoding: 'utf-8',
        stdio: ['pipe', 'pipe', 'pipe'],
      }).trim();
      if (pattern.test(info)) return pid;
      // Move to parent
      const ppid = parseInt(info.trim().split(/\s+/)[0], 10);
      if (isNaN(ppid) || ppid <= 1 || ppid === pid) break;
      pid = ppid;
    }
  } catch { /* ignore */ }
  return 0;
}

/**
 * Spawn a detached background process that pings the API every 30s.
 * Keeps the session marked as RUNNING even when idle between prompts.
 * Passes the parent PID and session state file path so the daemon can
 * self-terminate when the agent process dies or the session ends.
 */
export function startHeartbeat(sessionId: string, apiUrl: string, apiKey: string, stateFile?: string, agentSlug?: string): void {
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

    // For long-running agents (Claude Code, Windsurf), process.ppid IS the agent.
    // For IDE/fire-and-forget agents (Cursor, Codex, Gemini, Aider), hooks are
    // spawned via shell wrappers — process.ppid dies immediately. Walk up the
    // process tree to find the actual agent process so the heartbeat can detect
    // when it exits and end the session.
    // Long-running agents: process.ppid IS the agent (Claude Code, Windsurf)
    // IDE agents (Cursor, Codex): hooks are short-lived subprocesses — the parent
    // PID found by walking the tree is often an intermediate process that dies after
    // the hook exits. Passing it to the heartbeat causes the heartbeat to kill the
    // session after 30 seconds. For these agents, pass parentPid=0 so the heartbeat
    // relies on state file staleness (15 min) instead.
    // Claude Code hooks run via MCP subprocesses — process.ppid points to
    // a short-lived handler that dies after the hook returns, causing the
    // heartbeat to think the agent exited. Use pattern-based PID detection instead.
    const LONG_RUNNING_AGENTS = ['windsurf'];
    // Cursor is an Electron app — its process tree has short-lived helpers that
    // die immediately, causing false parent-death detection. Use stale file only.
    const STALE_FILE_ONLY_AGENTS = ['cursor'];
    const AGENT_PROCESS_PATTERNS: Record<string, RegExp> = {
      'claude-code': /claude/i,
      'gemini': /gemini/i,
      'aider': /aider/i,
      'codex': /codex/i,
    };

    let parentPid: number;
    if (agentSlug && LONG_RUNNING_AGENTS.includes(agentSlug)) {
      // For Claude Code / Windsurf, process.ppid is the agent itself
      parentPid = process.ppid || 0;
      // Verify the parent is actually alive
      if (parentPid > 0) {
        try { process.kill(parentPid, 0); } catch { parentPid = 0; }
      }
    } else if (agentSlug && STALE_FILE_ONLY_AGENTS.includes(agentSlug)) {
      // Cursor: can't reliably detect parent — use stale file check only
      parentPid = 0;
    } else {
      // For all other agents, walk the process tree to find the agent process.
      // If we find it, heartbeat monitors that PID. If not, fall back to stale file check.
      const pattern = agentSlug ? AGENT_PROCESS_PATTERNS[agentSlug] : undefined;
      parentPid = pattern ? findAncestorPid(pattern) : 0;
      // If pattern search failed, try to find the shell/terminal as a fallback
      // so the heartbeat dies when the terminal is closed
      if (parentPid <= 0) {
        parentPid = findAncestorPid(/bash|zsh|fish|sh$/i) || 0;
      }
    }

    const child = spawn(process.execPath, [heartbeatScript, sessionId, apiUrl, '', pidFile, String(parentPid), stateFile || ''], {
      detached: true,
      stdio: 'ignore',
      env: { ...process.env, ORIGIN_HEARTBEAT_API_KEY: apiKey },
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

/**
 * Check if the heartbeat daemon is still alive for a session.
 */
export function isHeartbeatAlive(sessionId: string): boolean {
  const pidFile = getHeartbeatPidFile(sessionId);
  try {
    if (!fs.existsSync(pidFile)) return false;
    const pid = parseInt(fs.readFileSync(pidFile, 'utf-8').trim(), 10);
    if (pid <= 0) return false;
    // signal 0 checks if process exists without actually sending a signal
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
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
