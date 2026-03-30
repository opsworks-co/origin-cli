import fs from 'fs';
import path from 'path';
import { execSync } from 'child_process';
import { getGitRoot, getGitDir } from './session-state.js';

// ─── Types ─────────────────────────────────────────────────────────────────

export interface HandoffData {
  version: 1;
  sessionId: string;
  agentSlug: string;
  model: string;
  endedAt: string;
  branch: string | null;

  // What was done
  prompts: string[];            // Last prompts (truncated)
  summary: string | null;       // AI-generated or transcript summary
  filesChanged: string[];       // Files touched in the session
  linesAdded: number;
  linesRemoved: number;

  // Current task context
  lastPrompt: string;           // The last user prompt (full, up to 2000 chars)
  lastResponse: string | null;  // Summary of last AI response

  // Accumulated across sessions
  openTodos: string[];          // TODOs extracted from prompts
}

const HANDOFF_FILE = 'origin-handoff.json';

// ─── Write Handoff ─────────────────────────────────────────────────────────

export function writeHandoff(repoPath: string, data: HandoffData): void {
  const gitDir = getGitDir(repoPath);
  if (!gitDir) return;
  const handoffPath = path.isAbsolute(gitDir)
    ? path.join(gitDir, HANDOFF_FILE)
    : path.join(repoPath, gitDir, HANDOFF_FILE);
  try {
    fs.writeFileSync(handoffPath, JSON.stringify(data, null, 2), 'utf-8');
  } catch {
    // Non-fatal
  }
}

// ─── Read Handoff ──────────────────────────────────────────────────────────

export function readHandoff(repoPath: string): HandoffData | null {
  const gitDir = getGitDir(repoPath);
  if (!gitDir) return null;
  const handoffPath = path.isAbsolute(gitDir)
    ? path.join(gitDir, HANDOFF_FILE)
    : path.join(repoPath, gitDir, HANDOFF_FILE);
  try {
    if (!fs.existsSync(handoffPath)) return null;
    const raw = fs.readFileSync(handoffPath, 'utf-8');
    const data = JSON.parse(raw) as HandoffData;
    if (data.version !== 1) return null;
    return data;
  } catch {
    return null;
  }
}

// ─── Clear Handoff ─────────────────────────────────────────────────────────

export function clearHandoff(repoPath: string): boolean {
  const gitDir = getGitDir(repoPath);
  if (!gitDir) return false;
  const handoffPath = path.isAbsolute(gitDir)
    ? path.join(gitDir, HANDOFF_FILE)
    : path.join(repoPath, gitDir, HANDOFF_FILE);
  try {
    if (fs.existsSync(handoffPath)) {
      fs.unlinkSync(handoffPath);
      return true;
    }
    return false;
  } catch {
    return false;
  }
}

// ─── Build Handoff Context for System Prompt Injection ─────────────────────

export function buildHandoffContext(repoPath: string): string | null {
  const handoff = readHandoff(repoPath);
  if (!handoff) return null;

  // Only use handoff if it's less than 24 hours old
  const age = Date.now() - new Date(handoff.endedAt).getTime();
  if (age > 24 * 60 * 60 * 1000) return null;

  const parts: string[] = [];
  const ago = formatAge(age);

  parts.push(`Previous session context (${handoff.agentSlug}, ${ago} ago):`);

  if (handoff.summary) {
    parts.push(`Summary: ${handoff.summary.slice(0, 500)}`);
  }

  if (handoff.lastPrompt) {
    parts.push(`Last prompt: "${handoff.lastPrompt.slice(0, 300)}"`);
  }

  if (handoff.filesChanged.length > 0) {
    const files = handoff.filesChanged.slice(0, 15);
    parts.push(`Files in progress: ${files.join(', ')}${handoff.filesChanged.length > 15 ? ` (+${handoff.filesChanged.length - 15} more)` : ''}`);
  }

  if (handoff.linesAdded > 0 || handoff.linesRemoved > 0) {
    parts.push(`Changes: +${handoff.linesAdded} -${handoff.linesRemoved} lines`);
  }

  if (handoff.openTodos.length > 0) {
    const todos = handoff.openTodos.slice(0, 5);
    parts.push(`Open TODOs from previous session:\n${todos.map(t => `  - ${t}`).join('\n')}`);
  }

  return parts.join('\n');
}

// ─── Extract TODOs from Prompts ────────────────────────────────────────────

export function extractTodosFromPrompts(prompts: string[]): string[] {
  const todos: string[] = [];
  const patterns = [
    /\bTODO[:\s]+(.+?)(?:\n|$)/gi,
    /\bFIXME[:\s]+(.+?)(?:\n|$)/gi,
    /\bNOTE[:\s]+(.+?)(?:\n|$)/gi,
    /\bneed(?:s)? to (?:fix|add|implement|update|change|refactor|handle)\s+(.+?)(?:\.|,|\n|$)/gi,
    /\bwe (?:should|need to|have to|still need to)\s+(.+?)(?:\.|,|\n|$)/gi,
    /\blater[,:]?\s+(.+?)(?:\.|,|\n|$)/gi,
  ];

  for (const prompt of prompts) {
    for (const pattern of patterns) {
      pattern.lastIndex = 0;
      let match;
      while ((match = pattern.exec(prompt)) !== null) {
        const todo = match[1].trim();
        if (todo.length > 5 && todo.length < 200 && !todos.includes(todo)) {
          todos.push(todo);
        }
      }
    }
  }

  return todos.slice(0, 10); // Cap at 10
}

// ─── Helpers ───────────────────────────────────────────────────────────────

function formatAge(ms: number): string {
  const mins = Math.floor(ms / 60000);
  if (mins < 60) return `${mins}m`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h`;
  const days = Math.floor(hours / 24);
  return `${days}d`;
}
