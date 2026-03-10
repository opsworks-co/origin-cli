import fs from 'fs';
import path from 'path';
import os from 'os';
import crypto from 'crypto';
import { execSync } from 'child_process';

// ─── Types ─────────────────────────────────────────────────────────────────

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
function getStatePath(cwd?: string): string {
  // Try git dir first
  const gitDir = getGitDir(cwd);
  if (gitDir) {
    const resolvedGitDir = path.isAbsolute(gitDir) ? gitDir : path.resolve(cwd || process.cwd(), gitDir);
    return path.join(resolvedGitDir, 'origin-session.json');
  }

  // Fallback: store in ~/.origin/sessions/ keyed by cwd hash
  const effectiveCwd = cwd || process.cwd();
  const cwdHash = crypto.createHash('md5').update(effectiveCwd).digest('hex').slice(0, 12);
  const sessionsDir = path.join(os.homedir(), '.origin', 'sessions');
  fs.mkdirSync(sessionsDir, { recursive: true });
  return path.join(sessionsDir, `${cwdHash}.json`);
}

export function saveSessionState(state: SessionState, cwd?: string): void {
  const statePath = getStatePath(cwd);
  fs.writeFileSync(statePath, JSON.stringify(state, null, 2));
}

export function loadSessionState(cwd?: string): SessionState | null {
  const statePath = getStatePath(cwd);
  try {
    return JSON.parse(fs.readFileSync(statePath, 'utf-8'));
  } catch {
    return null;
  }
}

export function clearSessionState(cwd?: string): void {
  const statePath = getStatePath(cwd);
  try {
    fs.unlinkSync(statePath);
  } catch {
    // file doesn't exist, that's fine
  }
}
