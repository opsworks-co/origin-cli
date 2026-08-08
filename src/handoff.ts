import fs from 'fs';
import path from 'path';
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

// ─── Echo-loop guards ────────────────────────────────────────────────────────
//
// A "check your memory" turn produces an answer that IS a recap of the injected
// memory/repo-activity context. If that answer becomes the session summary and
// gets written to the handoff, the next session injects it as "Previous session
// context", the next agent recaps THAT, and so on — memory-about-memory that
// compounds and drags stale bits forward forever. Two guards break the loop:
//   1. handoffRepresentsWork() — a chat-only turn (no files, no line changes)
//      must NOT overwrite the last real handoff (write-side gate).
//   2. isRecapSummary() — never inject a summary that is itself an Origin recap
//      (read-side guard; also self-heals recap handoffs already on disk).
const RECAP_MARKERS = /\b(from origin memory|prior work in this repo|recent agent activity|most[-\s]touched ai files|recent sessions|top ai[-\s]?modified|repository ai context)\b/i;

export function isRecapSummary(summary: string | null | undefined): boolean {
  return !!summary && RECAP_MARKERS.test(summary);
}

/**
 * True when a handoff describes REAL work worth carrying to the next session —
 * files touched or lines changed. A chat-only Q&A turn (e.g. "what's in my
 * memory?") represents no work and should neither be written (it would clobber
 * the last real handoff) nor injected.
 */
export function handoffRepresentsWork(data: Pick<HandoffData, 'filesChanged' | 'linesAdded' | 'linesRemoved'>): boolean {
  return (data.filesChanged?.length || 0) > 0 || (data.linesAdded || 0) > 0 || (data.linesRemoved || 0) > 0;
}

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

  const didWork = handoffRepresentsWork(handoff);
  const parts: string[] = [];
  const ago = formatAge(age);

  parts.push(`Previous session context (${handoff.agentSlug}, ${ago} ago):`);

  // Only surface the summary + last prompt when the session did real work AND
  // the summary isn't itself an Origin recap. Otherwise this is a chat-only or
  // "what's in my memory?" turn whose "summary" is just echoed context — the
  // exact input to the compounding memory-about-memory loop.
  if (handoff.summary && didWork && !isRecapSummary(handoff.summary)) {
    parts.push(`Summary: ${handoff.summary.slice(0, 500)}`);
  }

  if (handoff.lastPrompt && didWork) {
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

  // Nothing but the header survived — a chat-only / recap turn with no work and
  // no carried TODOs. There's nothing to hand off; injecting a bare header (or,
  // worse, an echoed recap) is what fed the loop. Skip it entirely.
  if (parts.length <= 1) return null;

  return parts.join('\n');
}

// ─── Extract TODOs from Prompts ────────────────────────────────────────────

// A dev verb that turns a loose "we need to …" into an actual work item. The
// unanchored "we need to <anything>" pattern used to capture conversational
// instructions ("we need to switch gh user … but switch it back after") as
// durable TODOs, which then got injected into every future session.
const TODO_VERB = 'fix|add|implement|update|change|refactor|handle|support|remove|delete|migrate|test|document|clean up|wire|hook up|rename|split|extract';

// Hedged / conversational phrasing signals a passing thought, not a firm TODO.
const TODO_HEDGE = /\b(i believe|i think|i guess|maybe|probably|not sure|for now|nvm|never mind)\b/i;

export function extractTodosFromPrompts(prompts: string[]): string[] {
  const todos: string[] = [];
  const patterns = [
    // Explicit markers — high precision, keep as-is.
    /\bTODO[:\s]+(.+?)(?:\n|$)/gi,
    /\bFIXME[:\s]+(.+?)(?:\n|$)/gi,
    /\bNOTE[:\s]+(.+?)(?:\n|$)/gi,
    // Intent phrasing, but ONLY when anchored to a dev verb, so plain
    // conversational instructions don't leak in.
    new RegExp(String.raw`\b(?:we )?(?:should|need(?:s)? to|have to|still need to) ((?:${TODO_VERB})\s+.+?)(?:\.|,|\n|$)`, 'gi'),
  ];

  for (const prompt of prompts) {
    for (const pattern of patterns) {
      pattern.lastIndex = 0;
      let match;
      while ((match = pattern.exec(prompt)) !== null) {
        const todo = match[1].trim();
        if (todo.length > 5 && todo.length < 200 && !TODO_HEDGE.test(todo) && !todos.includes(todo)) {
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
