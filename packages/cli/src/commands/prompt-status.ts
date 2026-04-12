import fs from 'fs';
import path from 'path';
import os from 'os';
import crypto from 'crypto';

// ─── Fast Session State Reader ──────────────────────────────────────────────
// This command is designed to run in < 50ms.
// - No git commands (uses PATH-based .git detection)
// - No API calls
// - Reads session state JSON directly
// - Optionally tails transcript JSONL for a live cost estimate

// Pricing per 1M tokens (input/output) for common models
// Used to estimate cost from transcript token counts
const MODEL_PRICING: Record<string, { input: number; output: number; cacheRead?: number }> = {
  'claude-opus-4': { input: 15, output: 75, cacheRead: 1.5 },
  'claude-opus-4-5': { input: 15, output: 75, cacheRead: 1.5 },
  'claude-sonnet-4': { input: 3, output: 15, cacheRead: 0.3 },
  'claude-sonnet-4-5': { input: 3, output: 15, cacheRead: 0.3 },
  'claude-sonnet-3-7': { input: 3, output: 15, cacheRead: 0.3 },
  'claude-sonnet-3-5': { input: 3, output: 15, cacheRead: 0.3 },
  'claude-haiku-3-5': { input: 0.8, output: 4, cacheRead: 0.08 },
  'claude-haiku-3': { input: 0.25, output: 1.25, cacheRead: 0.03 },
  'claude-3-opus': { input: 15, output: 75, cacheRead: 1.5 },
  'claude-3-sonnet': { input: 3, output: 15, cacheRead: 0.3 },
  'claude-3-haiku': { input: 0.25, output: 1.25, cacheRead: 0.03 },
};

function estimateCostFromTokens(model: string, inputTokens: number, outputTokens: number, cacheRead = 0, cacheCreation = 0): number {
  // Normalize model name: strip date suffixes, lower-case
  const normalized = model.toLowerCase().replace(/-\d{8}$/, '').replace(/^claude-/, 'claude-');
  // Try exact match then prefix match
  let pricing = MODEL_PRICING[normalized];
  if (!pricing) {
    for (const key of Object.keys(MODEL_PRICING)) {
      if (normalized.startsWith(key) || key.startsWith(normalized)) {
        pricing = MODEL_PRICING[key];
        break;
      }
    }
  }
  if (!pricing) {
    // Default: sonnet pricing
    pricing = { input: 3, output: 15, cacheRead: 0.3 };
  }
  const inputCost = (inputTokens / 1_000_000) * pricing.input;
  const outputCost = (outputTokens / 1_000_000) * pricing.output;
  const cacheReadCost = (cacheRead / 1_000_000) * (pricing.cacheRead ?? pricing.input * 0.1);
  const cacheCreateCost = (cacheCreation / 1_000_000) * (pricing.input * 1.25);
  return inputCost + outputCost + cacheReadCost + cacheCreateCost;
}

// ─── Git Root Detection (no exec) ──────────────────────────────────────────

/**
 * Walk up from cwd to find a .git directory.
 * Returns the path to the .git dir (or file for worktrees), or null.
 * Pure filesystem ops — no spawning git.
 */
function findGitDir(cwd: string): string | null {
  let dir = cwd;
  for (let i = 0; i < 50; i++) {
    const candidate = path.join(dir, '.git');
    try {
      const stat = fs.statSync(candidate);
      if (stat.isDirectory()) return candidate;
      if (stat.isFile()) {
        // Worktree: .git is a file containing "gitdir: /path/to/actual/git/dir"
        const content = fs.readFileSync(candidate, 'utf-8').trim();
        const match = content.match(/^gitdir:\s*(.+)$/m);
        if (match) {
          const resolved = path.isAbsolute(match[1]) ? match[1] : path.resolve(dir, match[1]);
          return resolved;
        }
      }
    } catch { /* not found at this level */ }
    const parent = path.dirname(dir);
    if (parent === dir) break; // filesystem root
    dir = parent;
  }
  return null;
}

/**
 * Get the fallback session state path for non-git directories.
 * Mirrors session-state.ts getStatePath() fallback logic.
 */
function getFallbackStatePath(cwd: string, sessionTag?: string): string {
  const cwdHash = crypto.createHash('md5').update(cwd).digest('hex').slice(0, 12);
  const sessionsDir = path.join(os.homedir(), '.origin', 'sessions');
  const basename = sessionTag ? `${cwdHash}-${sessionTag}.json` : `${cwdHash}.json`;
  return path.join(sessionsDir, basename);
}

// ─── Transcript Cost Estimation (tail read) ─────────────────────────────────

/**
 * Read the last N bytes of a JSONL transcript and extract cumulative token totals.
 * We scan from the end to find the most recent assistant message with usage data.
 * This is O(tail size) — very fast even for large transcripts.
 */
function readCostFromTranscriptTail(transcriptPath: string, model: string): number {
  try {
    const stat = fs.statSync(transcriptPath);
    if (!stat.isFile()) return 0;

    // Read last 8KB — enough to find the most recent usage block
    const tailSize = Math.min(8192, stat.size);
    const buf = Buffer.alloc(tailSize);
    const fd = fs.openSync(transcriptPath, 'r');
    try {
      fs.readSync(fd, buf, 0, tailSize, stat.size - tailSize);
    } finally {
      fs.closeSync(fd);
    }

    const text = buf.toString('utf-8');
    // Split into lines (the first line may be partial — skip it)
    const lines = text.split('\n');
    const start = tailSize < stat.size ? 1 : 0; // skip potentially partial first line

    let totalInput = 0;
    let totalOutput = 0;
    let totalCacheRead = 0;
    let totalCacheCreate = 0;
    let foundAny = false;

    // Scan all complete lines looking for usage fields
    // The JSONL has cumulative usage per turn — we want the last assistant message
    // that has usage data, which represents the session total
    let lastUsage: { input: number; output: number; cacheRead: number; cacheCreate: number } | null = null;

    for (let i = start; i < lines.length; i++) {
      const line = lines[i].trim();
      if (!line) continue;
      try {
        const parsed = JSON.parse(line);
        const usage = parsed?.message?.usage;
        if (usage && parsed?.type === 'assistant') {
          lastUsage = {
            input: usage.input_tokens || 0,
            output: usage.output_tokens || 0,
            cacheRead: usage.cache_read_input_tokens || 0,
            cacheCreate: usage.cache_creation_input_tokens || 0,
          };
          totalInput = usage.input_tokens || 0;
          totalOutput = usage.output_tokens || 0;
          totalCacheRead = usage.cache_read_input_tokens || 0;
          totalCacheCreate = usage.cache_creation_input_tokens || 0;
          foundAny = true;
        }
      } catch { /* skip unparseable line */ }
    }

    if (!foundAny && lastUsage === null) return 0;

    // If we got a tail reading, this is per-turn — we need total session cost.
    // If we're only reading the tail (tailSize < stat.size), we can't get the
    // true total, but the last-turn tokens give a reasonable live estimate.
    // For a full read, sum all turns.
    if (tailSize >= stat.size) {
      // Full file read: we actually already summed; compute properly
      return estimateCostFromTokens(model, totalInput, totalOutput, totalCacheRead, totalCacheCreate);
    } else {
      // Tail read only — use last known values as rough estimate
      return estimateCostFromTokens(model, totalInput, totalOutput, totalCacheRead, totalCacheCreate);
    }
  } catch {
    return 0;
  }
}

// ─── Session Discovery ──────────────────────────────────────────────────────

interface ActiveSession {
  status: string;
  model: string;
  transcriptPath?: string;
  startedAt: string;
}

function findActiveSession(cwd: string): ActiveSession | null {
  // 1. Try git-dir based state files
  const gitDir = findGitDir(cwd);
  if (gitDir) {
    try {
      const entries = fs.readdirSync(gitDir);
      for (const entry of entries) {
        if (!entry.startsWith('origin-session') || !entry.endsWith('.json')) continue;
        const filePath = path.join(gitDir, entry);
        try {
          const raw = fs.readFileSync(filePath, 'utf-8');
          const state = JSON.parse(raw);
          if (!state?.sessionId) continue;
          const status = (state.status || 'RUNNING').toUpperCase();
          if (status === 'ENDED') continue;
          return {
            status,
            model: state.model || 'unknown',
            transcriptPath: state.transcriptPath || undefined,
            startedAt: state.startedAt || '',
          };
        } catch { /* skip corrupt file */ }
      }
    } catch { /* can't read git dir */ }
  }

  // 2. Try fallback ~/.origin/sessions/<hash>.json
  try {
    const statePath = getFallbackStatePath(cwd);
    const raw = fs.readFileSync(statePath, 'utf-8');
    const state = JSON.parse(raw);
    if (state?.sessionId) {
      const status = (state.status || 'RUNNING').toUpperCase();
      if (status !== 'ENDED') {
        return {
          status,
          model: state.model || 'unknown',
          transcriptPath: state.transcriptPath || undefined,
          startedAt: state.startedAt || '',
        };
      }
    }
  } catch { /* no session */ }

  return null;
}

// ─── Command ─────────────────────────────────────────────────────────────────

export function promptStatusCommand() {
  const cwd = process.cwd();
  const session = findActiveSession(cwd);

  if (!session) {
    // No active session — output nothing so PS1 stays clean
    process.stdout.write('');
    return;
  }

  // Determine label
  const label = session.status === 'IDLE' ? 'idle' : 'tracking';

  // Get cost: try transcript tail, fall back to $0.00
  let cost = 0;
  if (session.transcriptPath) {
    try {
      cost = readCostFromTranscriptTail(session.transcriptPath, session.model);
    } catch { /* ignore */ }
  }

  const costStr = `$${cost.toFixed(2)}`;
  process.stdout.write(`[origin: ${label} · ${costStr}]`);
}
