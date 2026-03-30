import { execSync } from 'child_process';
import { getGitRoot } from './session-state.js';

// ─── Types ─────────────────────────────────────────────────────────────────

export interface SessionMemoryEntry {
  sessionId: string;
  agentSlug: string;
  model: string;
  startedAt: string;
  endedAt: string;
  branch: string | null;
  summary: string;
  filesChanged: string[];
  promptCount: number;
  linesAdded: number;
  linesRemoved: number;
  openTodos: string[];
}

const MEMORY_REF = 'refs/notes/origin-memory';
const MEMORY_TAG = 'origin-memory-index';
const MAX_ENTRIES = 20; // Keep last 20 session summaries

// ─── Write Memory ──────────────────────────────────────────────────────────

export function writeSessionMemory(repoPath: string, entry: SessionMemoryEntry): void {
  try {
    const existing = readAllSessionMemory(repoPath);
    existing.push(entry);

    // Keep only the last MAX_ENTRIES
    const trimmed = existing.slice(-MAX_ENTRIES);
    const payload = JSON.stringify({ version: 1, sessions: trimmed }, null, 2);

    // Write to a blob in git notes using a well-known tag
    const execOpts = { cwd: repoPath, stdio: 'pipe' as const, timeout: 10000, encoding: 'utf-8' as const };

    // Get HEAD commit to attach note to (or use a fixed ref)
    const head = execSync('git rev-parse HEAD', execOpts).trim();
    if (!head) return;

    // Write the memory index as a note on a well-known ref
    // We use the root commit as anchor so it doesn't move with HEAD
    let rootCommit: string;
    try {
      rootCommit = execSync('git rev-list --max-parents=0 HEAD', execOpts).trim().split('\n')[0];
    } catch {
      rootCommit = head;
    }

    execSync(
      `git notes --ref=origin-memory add -f -m ${escapeShellArg(payload)} ${rootCommit}`,
      execOpts,
    );
  } catch {
    // Non-fatal — memory is nice-to-have
  }
}

// ─── Read Memory ───────────────────────────────────────────────────────────

export function readAllSessionMemory(repoPath: string): SessionMemoryEntry[] {
  try {
    const execOpts = { cwd: repoPath, stdio: 'pipe' as const, timeout: 10000, encoding: 'utf-8' as const };
    let rootCommit: string;
    try {
      rootCommit = execSync('git rev-list --max-parents=0 HEAD', execOpts).trim().split('\n')[0];
    } catch {
      return [];
    }

    const raw = execSync(`git notes --ref=origin-memory show ${rootCommit}`, execOpts).trim();
    const data = JSON.parse(raw);
    if (data.version === 1 && Array.isArray(data.sessions)) {
      return data.sessions;
    }
    return [];
  } catch {
    return [];
  }
}

/**
 * Read last N session memory entries for context injection.
 */
export function readRecentMemory(repoPath: string, count: number = 3): SessionMemoryEntry[] {
  const all = readAllSessionMemory(repoPath);
  return all.slice(-count);
}

// ─── Build Memory Context for System Prompt ────────────────────────────────

export function buildMemoryContext(repoPath: string): string | null {
  const recent = readRecentMemory(repoPath, 3);
  if (recent.length === 0) return null;

  const parts: string[] = ['Session history for this repo:'];

  for (const entry of recent) {
    const ago = formatAge(Date.now() - new Date(entry.endedAt).getTime());
    const line = `- [${ago} ago] ${entry.agentSlug}/${entry.model}: ${entry.summary.slice(0, 200)}`;
    parts.push(line);
    if (entry.filesChanged.length > 0) {
      parts.push(`  Files: ${entry.filesChanged.slice(0, 8).join(', ')}${entry.filesChanged.length > 8 ? ' ...' : ''}`);
    }
  }

  // Collect open TODOs across recent sessions
  const allTodos: string[] = [];
  for (const entry of recent) {
    if (entry.openTodos?.length > 0) {
      for (const todo of entry.openTodos) {
        if (!allTodos.includes(todo)) allTodos.push(todo);
      }
    }
  }
  if (allTodos.length > 0) {
    parts.push('\nOpen TODOs from previous sessions:');
    for (const todo of allTodos.slice(0, 5)) {
      parts.push(`  - ${todo}`);
    }
  }

  return parts.join('\n');
}

// ─── Clear Memory ──────────────────────────────────────────────────────────

export function clearSessionMemory(repoPath: string): boolean {
  try {
    const execOpts = { cwd: repoPath, stdio: 'pipe' as const, timeout: 10000, encoding: 'utf-8' as const };
    let rootCommit: string;
    try {
      rootCommit = execSync('git rev-list --max-parents=0 HEAD', execOpts).trim().split('\n')[0];
    } catch {
      return false;
    }
    execSync(`git notes --ref=origin-memory remove ${rootCommit}`, execOpts);
    return true;
  } catch {
    return false;
  }
}

// ─── Helpers ───────────────────────────────────────────────────────────────

function escapeShellArg(arg: string): string {
  return "'" + arg.replace(/'/g, "'\\''") + "'";
}

function formatAge(ms: number): string {
  const mins = Math.floor(ms / 60000);
  if (mins < 60) return `${mins}m`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h`;
  const days = Math.floor(hours / 24);
  return `${days}d`;
}
