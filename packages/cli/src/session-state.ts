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
