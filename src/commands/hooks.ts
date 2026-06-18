import { loadConfig, saveConfig, loadAgentConfig, saveAgentConfig, loadRepoConfig, isConnectedMode, ensureConfigDir } from '../config.js';
import { decidePushBlock } from '../push-block.js';
import crypto from 'crypto';
import { detectTools } from '../tools-detector.js';
import { api, readAuthStatus } from '../api.js';
import { parseTranscript, estimateCost, formatTranscriptForDisplay, extractPromptFileMappings, extractPromptImages, setActivePricing } from '../transcript.js';
import {
  saveSessionState,
  loadSessionState,
  clearSessionState,
  findSessionByClaudeId,
  listActiveSessions,
  listAllActiveSessions,
  getGitDir,
  getGitRoot,
  discoverGitRoot,
  discoverAllGitRoots,
  getHeadSha,
  getBranch,
  startHeartbeat,
  stopHeartbeat,
  isHeartbeatAlive,
  getStatePath,
  type SessionState,
  type ToolCallRecord,
} from '../session-state.js';
import { captureGitState, getDirtyFiles, createShadowCommit, MAX_PROMPT_DIFF_LEN } from '../git-capture.js';
import { backfillCodexPromptMappings } from '../codex-prompt-mapping.js';
import { writeSessionFiles, pushSessionBranch, type PromptEntry, type PromptChange, type SessionWriteData } from '../local-entrypoint.js';
import { writeGitNotes, shouldIncludePromptText, type PromptNoteEntry } from '../git-notes.js';
import { redactSecrets } from '../redaction.js';
import { buildAttributionContext, buildFileAttributionContext } from '../attribution.js';
import { writeHandoff, buildHandoffContext, extractTodosFromPrompts } from '../handoff.js';
import { writeSessionMemory, buildMemoryContext, readRecentMemory } from '../memory.js';
import { backfillAcceptanceForSession } from '../acceptance.js';
import { addTodosFromSession } from '../todo.js';
import {
  capturePromptEdits,
  extractEditsFromToolCall,
  anchorEditPositions,
  buildCapturesFromLedger,
  mergeLedgerWithTranscript,
} from '../prompt-capture/index.js';
import type { PromptCapture } from '../prompt-capture/index.js';
import { parseSessionLimits, buildDurationBlockMessage, sendDesktopNotification } from '../session-limits.js';
import {
  BUDGET_BLOCKING_AGENTS,
  writeBudgetLockNotice,
  clearBudgetLockNotice,
  buildBudgetBanner,
  buildBudgetWarningBanner,
} from '../budget-breach.js';
import { createSnapshot, condenseSnapshot, listSnapshots, condenseAndCleanupSession, cleanupSessionShadowBranch, type SnapshotMeta } from './snapshot.js';
import { execFileSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import os from 'os';
import * as fzstd from 'fzstd';

// ─── Helpers ──────────────────────────────────────────────────────────────

/**
 * Returns the tree SHA that represents the WORKING TREE state right now,
 * not just HEAD's committed tree. For Cursor mid-turn prompts the agent
 * edits files in the IDE without committing — `HEAD^{tree}` then points
 * at the pre-edit state, and the Restore button in the UI ends up with
 * no usable tree ref.
 *
 * `git stash create` writes the working tree to the object store as a
 * commit (without touching the stash list or the working tree itself).
 * Its tree IS the dirty working-tree state. Returns null when the tree
 * is clean (stash create returns empty) and we fall back to HEAD's
 * tree — same SHA the legacy code path would have used.
 */
function getWorkingTreeSha(repoPath: string): string | null {
  const HEX = /^[a-f0-9]{40}$/;
  try {
    const stashSha = execFileSync('git', ['stash', 'create'], {
      cwd: repoPath, encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'],
    }).trim();
    if (stashSha && HEX.test(stashSha)) {
      const treeSha = execFileSync('git', ['rev-parse', `${stashSha}^{tree}`], {
        cwd: repoPath, encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'],
      }).trim();
      if (HEX.test(treeSha)) return treeSha;
    }
  } catch { /* fall through to HEAD's tree */ }
  try {
    const headTree = execFileSync('git', ['rev-parse', 'HEAD^{tree}'], {
      cwd: repoPath, encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'],
    }).trim();
    if (HEX.test(headTree)) return headTree;
  } catch { /* ignore */ }
  return null;
}

// ─── Debug Logger ─────────────────────────────────────────────────────────

const DEBUG_LOG = path.join(os.homedir(), '.origin', 'hooks.log');
const LOG_MAX_BYTES = 5 * 1024 * 1024; // 5 MB

function rotateLogIfNeeded(logPath: string): void {
  try {
    const stats = fs.statSync(logPath);
    if (stats.size >= LOG_MAX_BYTES) {
      fs.renameSync(logPath, logPath + '.old');
    }
  } catch {
    // File may not exist yet — that's fine
  }
}

function debugLog(event: string, message: string, data?: any): void {
  try {
    rotateLogIfNeeded(DEBUG_LOG);
    const timestamp = new Date().toISOString();
    let line = `[${timestamp}] [${event}] ${message}`;
    if (data !== undefined) {
      line += ' ' + JSON.stringify(data, null, 0);
    }
    line += '\n';
    fs.appendFileSync(DEBUG_LOG, line, { mode: 0o600 });
  } catch {
    // Never fail on logging
  }
}

/**
 * Run a pgrep command safely, filtering out the current process (and its children)
 * to avoid false-positive matches when the pattern appears in our own argv.
 * Returns true if at least one *other* process matched.
 */
function safePgrep(pgrepCmd: string): boolean {
  const myPid = process.pid;
  const myPpid = process.ppid;
  // Parse command string into args for execFileSync (e.g. 'pgrep -f "pattern"')
  const parts = pgrepCmd.match(/(?:[^\s"]+|"[^"]*")+/g) || [];
  const cmd = parts[0] || 'pgrep';
  const args = parts.slice(1).map(a => a.replace(/^"|"$/g, ''));
  // Run pgrep, capture PIDs, filter out our own process tree
  const raw = execFileSync(cmd, args, { encoding: 'utf-8' as const, stdio: ['pipe', 'pipe', 'pipe'] as ['pipe', 'pipe', 'pipe'] }).trim();
  if (!raw) return false;
  const pids = raw.split('\n').map(p => parseInt(p.trim(), 10)).filter(p => !isNaN(p));
  const filtered = pids.filter(p => p !== myPid && p !== myPpid);
  return filtered.length > 0;
}

// ─── Diff Filtering ─────────────────────────────────────────────────────
// Filter a unified diff to exclude files that were already dirty before the prompt.

function filterUncommittedDiff(diffText: string, prePromptDirtyFiles: string[]): string {
  if (!diffText || prePromptDirtyFiles.length === 0) return diffText;
  const excludeSet = new Set(prePromptDirtyFiles);
  // Split on diff boundaries, keeping the delimiter
  const parts = diffText.split(/(?=^diff --git )/m);
  const kept: string[] = [];
  for (const part of parts) {
    const match = part.match(/^diff --git a\/(.*?) b\//);
    if (match && match[1] && excludeSet.has(match[1])) continue;
    kept.push(part);
  }
  return kept.join('').trim();
}

// Files we should NEVER attribute to this session in uncommitted-diff output:
// the union of (a) what was dirty at THIS prompt's baseline, (b) what was
// dirty when the session started, and (c) what ANOTHER concurrently-running
// session has touched (committed or uncommitted) that we have NOT touched
// ourselves. Per-prompt state (a) gets zeroed by the shadow trick on each
// prompt boundary; (b) survives the whole session; (c) is the mid-session
// concurrent-agent isolation — a file Agent B starts editing while Agent A
// is alive shouldn't leak into A's uncommittedDiff just because both
// sessions watch the same working tree.
// Build the per-prompt attribution rows that go inside the git note.
// One entry per prompt that produced ANY captured work this session.
// Pulls text from state.prompts, files/timestamp from
// state.completedPromptMappings (set by the stop hook for each turn),
// and agent/model from the session-level state — these don't change
// per prompt. Capped + redacted inside writeGitNotes; here we just
// build the raw shape.
function buildPromptNoteEntries(
  state: SessionState,
  agentSlug: string | undefined,
  model: string | undefined,
  editsByIndex?: Map<number, string> | null,
): PromptNoteEntry[] {
  const out: PromptNoteEntry[] = [];
  const mappings = state.completedPromptMappings || [];
  const prompts = state.prompts || [];
  const seen = new Set<number>();
  // Walk completedPromptMappings first (has files for each prompt that
  // actually touched the working tree), then add chat-only prompts from
  // state.prompts so the note records every turn. Author info is at
  // session level (already in commit's Co-Authored-By trailer) so we
  // don't repeat it per-entry. editsJson + tree/commit refs are pulled
  // from the same maps the stop hook populates; lets a different Origin
  // org pulling notes drive AI Blame via LCS replay instead of having
  // to fall back to block-matching pc.diff.
  for (const m of mappings) {
    if (seen.has(m.promptIndex)) continue;
    seen.add(m.promptIndex);
    out.push({
      index: m.promptIndex,
      text: m.promptText || prompts[m.promptIndex] || '',
      agent: agentSlug || state.agentSlug,
      model,
      files: m.filesChanged && m.filesChanged.length > 0 ? m.filesChanged : undefined,
      editsJson: editsByIndex?.get(m.promptIndex) || undefined,
      treeSha: (m as any).treeSha || undefined,
      commitSha: (m as any).commitSha || undefined,
    });
  }
  for (let i = 0; i < prompts.length; i++) {
    if (seen.has(i)) continue;
    if (!prompts[i]) continue;
    out.push({
      index: i,
      text: prompts[i],
      agent: agentSlug || state.agentSlug,
      model,
      editsJson: editsByIndex?.get(i) || undefined,
    });
  }
  return out.sort((a, b) => a.index - b.index);
}

function uncommittedExcludeUnion(state: SessionState): string[] {
  const set = new Set<string>();
  for (const f of state.prePromptDirtyFiles || []) set.add(f);
  for (const f of state.sessionStartDirtyFiles || []) set.add(f);
  // (c) Other-session-touched files. Iterate the active session registry on
  // this repo, gather their filesChanged / commit-derived filename lists,
  // and add any file we ourselves haven't touched. "Touched by us" is
  // defined as appearing in one of OUR completedPromptMappings.
  try {
    const repoPath = state.repoPath;
    if (repoPath) {
      const others = listActiveSessions(repoPath).filter((s) => s.sessionId !== state.sessionId);
      if (others.length > 0) {
        const ours = new Set<string>();
        for (const m of state.completedPromptMappings || []) {
          for (const f of m.filesChanged || []) ours.add(f);
        }
        for (const other of others) {
          for (const m of other.completedPromptMappings || []) {
            for (const f of m.filesChanged || []) {
              if (!ours.has(f)) set.add(f);
            }
          }
        }
      }
    }
  } catch { /* listActiveSessions is best-effort */ }
  return Array.from(set);
}

// Session-aware amend rescue. For each SHA already in
// state.sessionCommitShas (post-commit hook recorded these — so they
// genuinely belong to THIS session), check if it's still reachable
// from HEAD. If NOT — typical signal of `git commit --amend`, which
// orphans the pre-amend SHA and creates a new commit with the same
// parent — find the replacement (same parent, reachable from HEAD)
// and substitute it in place.
//
// Critically: this NEVER adds a SHA we didn't already own. The
// previous helper walked `git log session-start..HEAD` and added
// every reachable commit, which silently picked up concurrent
// sessions' work and polluted pc.diff. This version only ever
// MUTATES entries; it never inflates the list.
function rescueAmendedCommitShas(repoPath: string, state: SessionState): void {
  if (!state.sessionCommitShas || state.sessionCommitShas.length === 0) return;
  const gitOpts = {
    cwd: repoPath,
    encoding: 'utf-8' as const,
    stdio: ['pipe', 'pipe', 'pipe'] as ['pipe', 'pipe', 'pipe'],
    timeout: 5000,
  };
  const replacements = new Map<string, string>();
  for (const sha of state.sessionCommitShas) {
    if (!/^[a-fA-F0-9]{7,40}$/.test(sha)) continue;
    // Is the recorded sha still reachable from HEAD? merge-base
    // --is-ancestor exits 0 = ancestor, 1 = not ancestor, 2+ = error.
    let reachable = true;
    try {
      execFileSync('git', ['merge-base', '--is-ancestor', sha, 'HEAD'], gitOpts);
    } catch (err: any) {
      // execFileSync throws on non-zero exit. Status 1 = not reachable
      // (likely amended/rebased). Any other status (commit missing
      // from object DB, repo corrupt) — skip; we have nothing to do.
      reachable = false;
      if (err?.status !== undefined && err.status !== 1) continue;
    }
    if (reachable) continue;
    // Orphaned commit. Look for the amend replacement: same parent,
    // reachable from HEAD. We can still read the orphan's parent from
    // the object DB until git gc prunes it.
    let parent = '';
    try {
      parent = execFileSync('git', ['rev-parse', `${sha}^`], gitOpts).toString().trim();
    } catch { continue; }
    if (!parent || !/^[a-fA-F0-9]{7,40}$/.test(parent)) continue;
    // Walk first-parent history from parent..HEAD and take the first
    // commit whose parent matches `parent`. `--first-parent` keeps us
    // on the main line (avoids picking up merge-side commits as
    // amend candidates). If multiple amends stacked, the rescue
    // walks one step; subsequent calls would walk further if state
    // is persisted between captures.
    try {
      const out = execFileSync(
        'git',
        ['log', `${parent}..HEAD`, '--first-parent', '--format=%H %P'],
        gitOpts,
      ).toString().trim();
      for (const line of out.split('\n')) {
        const [candidate, ...parents] = line.split(' ');
        if (!/^[a-fA-F0-9]{7,40}$/.test(candidate || '')) continue;
        if (parents[0] === parent) {
          replacements.set(sha, candidate);
          break;
        }
      }
    } catch { /* parent unreachable — orphan irrecoverable */ }
  }
  if (replacements.size === 0) return;
  state.sessionCommitShas = state.sessionCommitShas.map((s) => replacements.get(s) ?? s);
  try {
    saveSessionState(state, state.repoPath || '', state.sessionTag);
  } catch { /* best-effort persistence */ }
}

// Compute the committed-side diff scoped to commits THIS session authored.
// Replaces `git diff prePromptSha...HEAD`, which picks up commits made by
// concurrently-running sessions once HEAD moves past this session's commits.
// Returns empty string when the session hasn't committed anything yet.
//
// rescueAmendedCommitShas runs FIRST so `git commit --amend` doesn't
// silently drop the session's committed work from blame. It only mutates
// SHAs we already owned; it never adds unrelated commits (that was the
// 3153d3b pollution mistake that broke every multi-session repo).
function sessionScopedCommittedDiff(
  repoPath: string,
  state: SessionState,
): string {
  rescueAmendedCommitShas(repoPath, state);
  const shas = state.sessionCommitShas || [];
  if (shas.length === 0) return '';
  const parts: string[] = [];
  for (const sha of shas) {
    if (!/^[a-fA-F0-9]{7,40}$/.test(sha)) continue;
    try {
      const out = execFileSync(
        'git',
        ['show', sha, '--format=', '--no-color'],
        { cwd: repoPath, encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'], timeout: 5000 },
      ).toString().trim();
      if (out) parts.push(out);
    } catch { /* commit may have been removed by a rebase; skip */ }
  }
  return parts.join('\n').trim();
}

// ─── Cursor Model Detection ──────────────────────────────────────────────
// Cursor always sends model:"default" in hooks. Read the actual model from
// Cursor's internal SQLite database (~/.cursor/ai-tracking/ai-code-tracking.db).

function getCursorModelFromDb(conversationId: string): string | null {
  try {
    // Validate conversationId to prevent SQL injection via shell command
    if (!/^[a-zA-Z0-9_-]+$/.test(conversationId)) return null;

    const dbPath = path.join(os.homedir(), '.cursor', 'ai-tracking', 'ai-code-tracking.db');
    if (!fs.existsSync(dbPath)) return null;

    // Use sqlite3 CLI to query — avoids native module dependency
    const sqlOpts = { encoding: 'utf-8' as const, stdio: ['pipe', 'pipe', 'pipe'] as ['pipe', 'pipe', 'pipe'], timeout: 2000 };
    const escapedId = conversationId.replace(/'/g, "''");
    const result = execFileSync('sqlite3', [dbPath, `SELECT model FROM conversation_summaries WHERE conversationId='${escapedId}' LIMIT 1`], sqlOpts).trim();
    if (result && result !== 'default' && result !== 'unknown') return result;

    // Fallback: check tracked_file_content or ai_code_hashes for this conversation
    const result2 = execFileSync('sqlite3', [dbPath, `SELECT DISTINCT model FROM tracked_file_content WHERE conversationId='${escapedId}' AND model IS NOT NULL AND model != '' LIMIT 1`], sqlOpts).trim();
    if (result2 && result2 !== 'default' && result2 !== 'unknown') return result2;

    const result3 = execFileSync('sqlite3', [dbPath, `SELECT DISTINCT model FROM ai_code_hashes WHERE conversationId='${escapedId}' AND model IS NOT NULL AND model != '' LIMIT 1`], sqlOpts).trim();
    if (result3 && result3 !== 'default' && result3 !== 'unknown') return result3;
  } catch {
    // sqlite3 not available or DB locked — non-fatal
  }
  return null;
}

/**
 * Read Cursor conversation summary from its SQLite DB.
 * Returns { title, tldr, overview, summaryBullets } or null.
 * Used to populate session output when no transcript is available.
 */
function getCursorConversationSummary(conversationId: string): { title: string; tldr: string; overview: string; summaryBullets: string } | null {
  try {
    if (!/^[a-zA-Z0-9_-]+$/.test(conversationId)) return null;
    const dbPath = path.join(os.homedir(), '.cursor', 'ai-tracking', 'ai-code-tracking.db');
    if (!fs.existsSync(dbPath)) return null;

    const escapedId = conversationId.replace(/'/g, "''");
    const result = execFileSync('sqlite3', ['-separator', '|||', dbPath, `SELECT title, tldr, overview, summaryBullets FROM conversation_summaries WHERE conversationId='${escapedId}' LIMIT 1`], { encoding: 'utf-8' as const, stdio: ['pipe', 'pipe', 'pipe'] as ['pipe', 'pipe', 'pipe'], timeout: 2000 }).trim();
    if (!result) return null;
    const parts = result.split('|||');
    return {
      title: (parts[0] || '').trim(),
      tldr: (parts[1] || '').trim(),
      overview: (parts[2] || '').trim(),
      summaryBullets: (parts[3] || '').trim(),
    };
  } catch {
    return null;
  }
}

// ─── Session Write Helper ─────────────────────────────────────────────────

import type { ParsedTranscript, PromptFileMapping } from '../transcript.js';

/**
 * Assemble SessionWriteData from hook state + parsed transcript + git capture.
 * Shared by handleStop, handleSessionEnd, and handlePostCommit.
 */
function buildSessionWriteData(opts: {
  state: SessionState;
  parsed: ParsedTranscript;
  promptMappings: PromptFileMapping[];
  gitCapture: { headBefore: string; headAfter: string; commitShas: string[]; linesAdded: number; linesRemoved: number; commitDetails?: Array<{ filesChanged: string[] }> };
  status: 'running' | 'ended';
  apiUrl: string;
  extraFiles?: string[];
  // Per-prompt PromptCapture JSON (apply_patch / Edit / replace payload),
  // keyed by promptIndex. Travels into changes.json so a different Origin
  // org importing this repo can drive AI Blame from the authoritative
  // edits instead of falling back to block-matching against pc.diff.
  promptEditsByIndex?: Map<number, string>;
}): SessionWriteData {
  const { state, parsed, promptMappings, gitCapture, status, apiUrl, extraFiles, promptEditsByIndex } = opts;

  const prompts = parsed.prompts.length > 0 ? parsed.prompts : state.prompts;
  const model = parsed.model || state.model;
  const durationMs = Date.now() - new Date(state.startedAt).getTime();
  const branch = getBranch(state.repoPath) || state.branch || '';

  // Merge file lists and make paths relative to repo root
  // Fall back to git-captured files if transcript parsing found none
  const repoRoot = state.repoPath || '';
  let transcriptFiles = parsed.filesChanged;
  if (transcriptFiles.length === 0 && gitCapture.commitDetails) {
    const gitFiles = new Set<string>();
    for (const commit of gitCapture.commitDetails) {
      for (const f of commit.filesChanged) gitFiles.add(f);
    }
    transcriptFiles = Array.from(gitFiles);
  }
  const allFiles = Array.from(new Set([
    ...transcriptFiles,
    ...(extraFiles || []),
  ])).map(f => f.startsWith(repoRoot) ? f.slice(repoRoot.length + 1) : f);

  // Helper to make paths relative to repo root
  const rel = (f: string) => f.startsWith(repoRoot) ? f.slice(repoRoot.length + 1) : f;

  // Build PromptEntry[] — match prompts to their file changes
  const promptEntries: PromptEntry[] = prompts.map((text, i) => {
    const mapping = promptMappings.find(m => m.promptIndex === i);
    return {
      index: i + 1,
      text: typeof text === 'string' ? text : String(text),
      filesChanged: (mapping?.filesChanged || []).map(rel),
    };
  });

  // Build PromptChange[] from mappings with snapshot metadata. Pulls the
  // per-prompt commit/tree/uncommitted refs straight off the mapping when
  // the stop hook attached them (typical for Claude/Cursor/Gemini); falls
  // back to gitCapture.headAfter for legacy synth paths. editsJson comes
  // from the parallel `promptEditsByIndex` map populated by
  // capturePromptEdits — same shape that ships to the API.
  const changes: PromptChange[] = promptMappings.map(m => {
    // Compute per-prompt line counts from diff
    const diffLines = (m.diff || '').split('\n');
    const added = diffLines.filter(l => l.startsWith('+') && !l.startsWith('+++')).length;
    const removed = diffLines.filter(l => l.startsWith('-') && !l.startsWith('---')).length;
    return {
      promptIndex: m.promptIndex + 1,
      promptText: m.promptText.slice(0, 200),
      filesChanged: m.filesChanged.map(rel),
      diff: m.diff,
      linesAdded: added,
      linesRemoved: removed,
      aiPercentage: 100, // All auto-captured prompts are AI-generated changes
      checkpointType: 'auto',
      commitSha: m.commitSha ?? gitCapture.headAfter ?? null,
      treeSha: m.treeSha ?? null,
      uncommittedDiff: m.uncommittedDiff ?? null,
      editsJson: promptEditsByIndex?.get(m.promptIndex) ?? null,
    };
  });

  return {
    sessionId: state.sessionId,
    model,
    startedAt: state.startedAt,
    endedAt: new Date().toISOString(),
    durationMs,
    status,
    costUsd: estimateCost(model, parsed.inputTokens, parsed.outputTokens, parsed.cacheReadTokens, parsed.cacheCreationTokens),
    tokensUsed: parsed.tokensUsed,
    inputTokens: parsed.inputTokens,
    outputTokens: parsed.outputTokens,
    cacheReadTokens: parsed.cacheReadTokens,
    cacheCreationTokens: parsed.cacheCreationTokens,
    toolCalls: parsed.toolCalls,
    linesAdded: gitCapture.linesAdded,
    linesRemoved: gitCapture.linesRemoved,
    prompts: promptEntries,
    filesChanged: allFiles,
    git: {
      branch,
      headBefore: gitCapture.headBefore || '',
      headAfter: gitCapture.headAfter || '',
      commitShas: gitCapture.commitShas,
    },
    summary: parsed.summary,
    originUrl: `${apiUrl}/sessions/${state.sessionId}`,
    changes,
  };
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
        debugLog('stdin', 'parsed', { keys: Object.keys(parsed), cwd: parsed.cwd, session_id: parsed.session_id, model: parsed.model });
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

// ─── Shell Escape ─────────────────────────────────────────────────────────

// escapeShellArg removed — execFileSync handles argument escaping safely

// ─── Agent-Model Mapping ──────────────────────────────────────────────────

/**
 * Bare agent-brand strings we stamp on a session at session-start when the
 * real model isn't known yet (e.g. claude-code's hook stdin has no `model`
 * field, so we fall back to "claude"). These are NOT real model identifiers.
 */
const BARE_BRAND_MODELS = new Set([
  'claude', 'gemini', 'cursor', 'codex', 'windsurf', 'aider',
  'copilot', 'amp', 'opencode', 'continue', 'junie', 'rovo', 'droid',
  'ai', 'unknown', 'default', '',
]);

/**
 * A "specific" model is a real provider model identifier
 * ("claude-opus-4-8", "gemini-2.5-pro", "gpt-5-codex") — i.e. not the bare
 * agent-brand fallback. Used to decide whether a value is worth persisting
 * onto the session record, so we never downgrade a captured real model back
 * to the brand.
 */
function isSpecificModel(model: string | undefined | null): boolean {
  if (!model) return false;
  return !BARE_BRAND_MODELS.has(model.trim().toLowerCase());
}

/**
 * Maps agent slugs to regex patterns that match their model strings.
 * Used for reliable agent-to-session matching instead of fragile substring checks.
 */
const AGENT_MODEL_PATTERNS: Record<string, RegExp> = {
  'claude': /claude|anthropic|sonnet|opus|haiku/i,
  'gemini': /gemini|google/i,
  'cursor': /cursor|composer|gpt|openai/i,
  'codex': /codex/i,
  'aider': /aider/i,
  'windsurf': /windsurf|codeium/i,
  'copilot': /copilot/i,
  'continue': /continue/i,
  'amp': /amp/i,
  'junie': /junie|jetbrains/i,
  'opencode': /opencode/i,
  'rovo': /rovo/i,
  'droid': /droid/i,
};

/**
 * Check if a session's model field matches the given agent slug.
 */
function sessionMatchesAgent(session: SessionState, agentSlug: string): boolean {
  // Prefer stored agent slug — most reliable, avoids model pattern collisions
  if (session.agentSlug) {
    return session.agentSlug.toLowerCase() === agentSlug.toLowerCase();
  }
  // Fallback to model pattern matching for old sessions without agentSlug
  const model = (session.model || '').toLowerCase();
  const slug = agentSlug.toLowerCase();
  const pattern = AGENT_MODEL_PATTERNS[slug];
  if (pattern) return pattern.test(model);
  // Fallback for unknown agents: exact substring match
  return model.includes(slug) || slug.includes(model);
}

/**
 * Write Origin policies to agent-specific rules/instructions files.
 * Cursor: ~/.cursor/rules/origin.md
 * Codex: AGENTS.md in project root (Codex reads this natively)
 * Claude Code: uses systemMessage from stdout (no file needed)
 */
function writeAgentRulesFile(agentSlug: string, systemMsg: string, repoPath: string): void {
  if (!systemMsg || !agentSlug) return;

  let target: string | undefined;
  let useMarker = false;
  if (agentSlug === 'claude-code') {
    // Claude Code reads .claude/settings.local.json instructions, but the most
    // reliable way to inject rules is via the project-level CLAUDE.md file.
    // Use a marker to manage our section without clobbering user content.
    target = path.join(repoPath, 'CLAUDE.md');
    useMarker = true;
  } else if (agentSlug === 'cursor') {
    target = path.join(os.homedir(), '.cursor', 'rules', 'origin.md');
  } else if (agentSlug === 'codex') {
    // Codex reads AGENTS.md from project root
    target = path.join(repoPath, 'AGENTS.md');
    useMarker = true;
  } else if (agentSlug === 'windsurf') {
    target = path.join(repoPath, '.windsurfrules');
    useMarker = true;
  } else if (agentSlug === 'gemini') {
    target = path.join(repoPath, 'GEMINI.md');
    useMarker = true;
  }

  if (target) {
    fs.mkdirSync(path.dirname(target), { recursive: true });
    if (useMarker) {
      // Wrap with markers so we only replace our section, preserving user content
      const marker = '<!-- origin-managed -->';
      const content = `${marker}\n${systemMsg}\n${marker}`;
      const existingContent = fs.existsSync(target) ? fs.readFileSync(target, 'utf-8') : '';
      const markerRegex = new RegExp(`${marker}[\\s\\S]*?${marker}`, 'g');
      if (existingContent.includes(marker)) {
        fs.writeFileSync(target, existingContent.replace(markerRegex, content));
      } else if (existingContent.trim()) {
        fs.writeFileSync(target, existingContent + '\n\n' + content);
      } else {
        fs.writeFileSync(target, content);
      }
    } else {
      fs.writeFileSync(target, systemMsg);
    }
    debugLog('session-start', 'agent rules file written', { agent: agentSlug, path: target });
  }
}

// ─── Origin authoring framework guidance ──────────────────────────────────
//
// Short instruction block appended to every agent's system prompt
// (and to AGENTS.md / GEMINI.md / .windsurfrules for file-driven
// agents) telling the model to emit structured [Origin: …] markers
// as it works. Path A of "GitHub for agents" — agents EMIT the
// reviewer-facing structure inline; the server-side synthesis
// (pr-reviewer-brief.ts) remains as a fallback for sessions whose
// agents didn't comply.
//
// Kept terse on purpose. Verbose instructions get diluted in long
// contexts; this fits in ~150 tokens. The marker names match the
// section headers on the reviewer's brief UI so the agent's mental
// model maps 1:1 to what the reviewer will see.
function buildOriginFrameworkGuidance(): string {
  return [
    'Origin authoring framework — emit these markers inline in your responses when there is real signal worth surfacing to the human reviewer. Don\'t force one per turn.',
    '',
    '  [Origin: Intent] <one sentence on WHY you\'re making this change>',
    '  [Origin: Decision] <choice you made> — <why>',
    '  [Origin: Open] <something you didn\'t finish, or aren\'t sure about>',
    '  [Origin: Verify] <something a human reviewer should check>',
    '',
    'Markers are parsed verbatim — keep the bracket format exact. Multi-line content is fine; the marker line itself must stay on one line. Be honest: do not claim verifications you didn\'t do. These appear on the PR review surface alongside Origin\'s server-synthesized summary; agent-emitted markers take precedence.',
  ].join('\n');
}

// ─── Per-agent context injection ──────────────────────────────────────────
//
// Build the stdout payload that delivers Origin's session context (policies,
// repo attribution, handoff/memory, and the authoring framework) to an
// agent. The channel differs per agent because each one's hook protocol
// surfaces hook output differently — getting this wrong means the model
// silently never sees the context:
//
//   • claude-code — a top-level `systemMessage` is shown to the HUMAN only;
//     the MODEL receives context exclusively via
//     hookSpecificOutput.additionalContext. We emit BOTH so the user sees
//     the banner (parity with Gemini) AND the model actually gets the
//     framework/policies. (This was the bug: Claude only ever got
//     `systemMessage`, so the model never received any of it.)
//   • cursor — reads `additional_context`.
//   • gemini / windsurf / others — read `systemMessage`.
//   • codex — renders hook stdout as warnings, so a full block spams the
//     warning area; it reads everything from AGENTS.md instead. Returns
//     null (callers keep their codex-only budget-banner branch).
//
// Returns the JSON string to write to stdout, or null when nothing should be
// written (codex, or empty context).
export function buildContextInjectionPayload(
  agentSlug: string | undefined,
  hookEventName: 'SessionStart' | 'UserPromptSubmit',
  systemMsg: string,
): string | null {
  if (!systemMsg) return null;
  if (agentSlug === 'codex') return null;
  if (agentSlug === 'claude-code') {
    return JSON.stringify({
      systemMessage: systemMsg,
      hookSpecificOutput: { hookEventName, additionalContext: systemMsg },
    });
  }
  if (agentSlug === 'cursor') {
    return JSON.stringify({ additional_context: systemMsg });
  }
  return JSON.stringify({ systemMessage: systemMsg });
}

// Anchor where the human-facing portion of the preamble begins. Everything
// before it (budget banner, agent system prompt) is either already surfaced
// on its own stderr line or is model-only config, not a user banner.
const PREAMBLE_VISIBLE_ANCHOR = 'Origin: Session tracking active';

// Mirror the Origin context block to STDERR so it's VISIBLE on the agent's
// initial screen. Gemini renders the stdout `systemMessage` as a banner, so
// the user sees the preamble there — but Claude Code, Codex, and Cursor do
// NOT render SessionStart stdout as a banner; they only surface hook STDERR
// (the same channel the budget banner already uses and which ships visibly
// today). Without this, the preamble reaches the model but never the human on
// those three. Gemini is skipped to avoid printing it twice. Additive: the
// stdout model-delivery payload (buildContextInjectionPayload) is unchanged.
export function emitVisiblePreamble(agentSlug: string | undefined, systemMsg: string): void {
  if (!systemMsg || agentSlug === 'gemini') return;
  const at = systemMsg.indexOf(PREAMBLE_VISIBLE_ANCHOR);
  const block = (at >= 0 ? systemMsg.slice(at) : systemMsg).trim();
  if (!block) return;
  const bold = '\x1b[1m', indigo = '\x1b[38;5;111m', dim = '\x1b[2m', reset = '\x1b[0m';
  const body = block.split('\n').map((l) => `${dim}│${reset} ${l}`).join('\n');
  process.stderr.write(`\n${bold}${indigo}◆ Origin${reset}\n${body}\n\n`);
}

// ─── Concurrent Session State Lookup ──────────────────────────────────────

/**
 * Find the correct session state for a hook invocation.
 *
 * With concurrent session support, each Claude Code window has its own
 * state file (tagged by sessionTag). This helper finds the right one by:
 * 1. Exact match on claudeSessionId (current or stored in state)
 * 2. Agent-filtered match using model patterns (when agentSlug is provided)
 * 3. Single active session (unambiguous — safe to use)
 * 4. Returns null when multiple sessions exist and no reliable match is found,
 *    to avoid misattributing commits to the wrong session.
 *
 * Returns the state and the resolved cwd to use for saving.
 */

// Agents whose stdin `session_id` is STABLE for the whole conversation
// (Claude Code, Windsurf). For every other agent the id is per-turn (Codex)
// or changes when the conversation is RESUMED in a new launch (Gemini), so
// passing it to findStateForHook forces an exact match that fails on resume.
// For those agents we pass `undefined`, which makes findStateForHook resolve
// via the agent-filtered fallback (the still-active same-agent session) instead
// of aborting.
//
// Bug this fixes: a resumed Gemini session stopped capturing per-prompt diffs.
// UserPromptSubmit already gated the id this way, but Stop / SessionEnd /
// PreToolUse passed the raw id — so after resume (new Gemini id) Stop hit
// "no exact match for stable claudeSessionId — new session needed" and
// ABORTed, never writing completedPromptMappings / advancing prePromptSha.
// Prompts kept growing (UserPromptSubmit worked) while diffs froze.
const STABLE_SESSION_ID_AGENTS = ['claude-code', 'windsurf'];
export function hookLookupSessionId(sessionId: string | undefined, agentSlug?: string): string | undefined {
  return STABLE_SESSION_ID_AGENTS.includes(agentSlug || '') ? sessionId : undefined;
}

/**
 * Compare two directory paths for identity, tolerating symlinks (macOS
 * /var → /private/var) and trailing-slash/relative differences. Used to
 * match a session's lastCwd against a git hook's cwd.
 */
function sameDir(a?: string | null, b?: string | null): boolean {
  if (!a || !b) return false;
  const norm = (p: string): string => {
    let r = p;
    try { r = fs.realpathSync(p); } catch { /* deleted dir — compare as-is */ }
    return path.resolve(r);
  };
  return norm(a) === norm(b);
}

/**
 * List candidate sessions for a BARE git hook (prepare-commit-msg,
 * post-commit, pre-push) — invocations that get no session_id/cwd on stdin
 * and must resolve the session from process.cwd() alone.
 *
 * Two worktree problems this solves (multi-session, parallel-worktree repos):
 *   1. A linked worktree has its own git dir (.git/worktrees/<name>) with no
 *      origin-session-*.json — the session registered its state under the
 *      MAIN repo's .git before the harness created the worktree. Fall back
 *      to repo-level sessions so the hook sees them at all.
 *   2. Several sessions are active at repo level. Narrow by each session's
 *      last-seen lifecycle-hook cwd (state.lastCwd): sessions whose lastCwd
 *      matches the hook's cwd exactly win; otherwise sessions known to be
 *      working elsewhere are dropped, keeping only those with unknown cwd
 *      (pre-upgrade state files). Worktrees are one-session-by-design, so an
 *      exact lastCwd match is the strongest signal we have.
 *
 * Exported for testing.
 */
export function listSessionsForGitHook(hookCwd: string): SessionState[] {
  let sessions = listActiveSessions(hookCwd);
  if (sessions.length === 0) {
    const mainRepo = getGitRoot(hookCwd); // collapses linked worktree → main repo
    if (mainRepo && !sameDir(mainRepo, hookCwd)) {
      sessions = listActiveSessions(mainRepo);
      if (sessions.length > 0) {
        debugLog('git-hook-sessions', 'worktree fallback to repo-level sessions', {
          hookCwd, mainRepo, count: sessions.length,
        });
      }
    }
  }
  if (sessions.length > 1) {
    const exact = sessions.filter(s => sameDir(s.lastCwd, hookCwd));
    if (exact.length > 0) {
      debugLog('git-hook-sessions', 'narrowed by lastCwd', {
        hookCwd, matched: exact.map(s => s.sessionId.slice(0, 12)),
      });
      return exact;
    }
    // No exact match — drop sessions demonstrably working elsewhere; keep
    // only those whose cwd is unknown (state files predating lastCwd).
    return sessions.filter(s => !s.lastCwd);
  }
  return sessions;
}

function findStateForHook(hookCwd: string, claudeSessionId?: string, agentSlug?: string): { state: SessionState; saveCwd: string } | null {
  const repoPath = discoverGitRoot(hookCwd) || hookCwd;

  // Debug: log what listActiveSessions finds
  const debugSessions1 = listActiveSessions(hookCwd);
  const debugSessions2 = hookCwd !== repoPath ? listActiveSessions(repoPath) : [];
  debugLog('findStateForHook', 'scanning', {
    hookCwd, repoPath,
    sessionsInHookCwd: debugSessions1.length,
    sessionsInRepoPath: debugSessions2.length,
    tags: [...debugSessions1, ...debugSessions2].map(s => s.sessionTag),
  });

  // 1. If we have a claude session ID, try exact match.
  // The caller only passes claudeSessionId for agents with STABLE per-conversation
  // ids (Claude Code, Windsurf). If exact match fails for a stable agent, the
  // conversation is genuinely new — DO NOT fall through to "most recent active",
  // which silently merges unrelated Claude Code windows into one platform session.
  //
  // Codex 0.130 is special: its stdin `session_id` is the PER-TURN thread id,
  // which differs between SessionStart and Stop for the same codex launch. So
  // when codex's stop hook fires with an ID that doesn't match what
  // SessionStart saved, that's NOT a new conversation — it's the same codex
  // window's next turn. Fall through to agent-filtered match instead of
  // dropping the hook (which used to abort handleStop with "no exact match",
  // leaving the session's tool calls / diffs unattached on the dashboard).
  if (claudeSessionId) {
    const found = findSessionByClaudeId(claudeSessionId, hookCwd)
      || (repoPath !== hookCwd ? findSessionByClaudeId(claudeSessionId, repoPath) : null);
    if (found) {
      debugLog('findStateForHook', 'exact match', { claudeSessionId, sessionId: found.sessionId, tag: found.sessionTag });
      return { state: found, saveCwd: found.repoPath || repoPath };
    }
    if (agentSlug === 'codex') {
      debugLog('findStateForHook', 'codex per-turn id mismatch — falling through to agent-filtered match', {
        claudeSessionId,
      });
      // intentionally NOT returning here; let the agent-filtered branch below run
    } else {
      debugLog('findStateForHook', 'no exact match for stable claudeSessionId — new session needed', { claudeSessionId, agentSlug });
      return null;
    }
  }

  // 2. Fall back to active sessions for this repo
  let sessions = listActiveSessions(hookCwd);
  if (sessions.length === 0 && repoPath !== hookCwd) {
    sessions = listActiveSessions(repoPath);
  }

  if (sessions.length > 0) {
    sessions.sort((a, b) => new Date(b.startedAt).getTime() - new Date(a.startedAt).getTime());

    // Whenever the caller knows the agent slug, ONLY accept a session whose
    // own slug matches. Previously a single-active-session shortcut returned
    // the existing session unconditionally — that caused a fresh Cursor hook
    // to attach its prompt to a still-active Gemini session in the same repo
    // and the new turn ended up rendered as Gemini.
    if (agentSlug) {
      let matching = sessions.filter(s => sessionMatchesAgent(s, agentSlug));
      if (matching.length > 1) {
        // Same-agent tie (e.g. two Gemini windows): prefer the session whose
        // last-seen lifecycle cwd matches this hook's cwd — disambiguates
        // parallel worktrees, where each session works in its own directory.
        const cwdMatched = matching.filter(s => sameDir(s.lastCwd, hookCwd));
        if (cwdMatched.length > 0) matching = cwdMatched;
      }
      if (matching.length > 0) {
        const best = matching[0]; // already sorted by startedAt desc
        debugLog('findStateForHook', 'agent-filtered match', {
          agentSlug,
          model: best.model,
          sessionId: best.sessionId,
          tag: best.sessionTag,
          candidateCount: matching.length,
          totalSessions: sessions.length,
        });
        return { state: best, saveCwd: best.repoPath || repoPath };
      }
      // No matching-agent session — fall through to legacy path / auto-create.
      // Returning the most-recent session of a *different* agent would cause
      // cross-agent prompt mixing (the bug we just fixed).
      debugLog('findStateForHook', 'no matching-agent session', {
        agentSlug,
        totalSessions: sessions.length,
        sessionAgents: sessions.map(s => ({ id: s.sessionId, slug: s.agentSlug, model: s.model })),
      });
      return null;
    }

    // No agent slug from the caller. Single session with unknown agent is
    // safe to use; multiple is ambiguous and bails so the caller can decide.
    if (sessions.length === 1) {
      const best = sessions[0];
      debugLog('findStateForHook', 'single active session (no agent slug)', { sessionId: best.sessionId, model: best.model, tag: best.sessionTag });
      return { state: best, saveCwd: best.repoPath || repoPath };
    }

    // Multiple sessions, no agent slug: a session whose last-seen lifecycle
    // cwd matches this hook's cwd is unambiguous (parallel-worktree case —
    // each session works in its own directory).
    const cwdMatched = sessions.filter(s => sameDir(s.lastCwd, hookCwd));
    if (cwdMatched.length === 1) {
      const best = cwdMatched[0];
      debugLog('findStateForHook', 'disambiguated by lastCwd', {
        hookCwd, sessionId: best.sessionId, model: best.model, tag: best.sessionTag,
      });
      return { state: best, saveCwd: best.repoPath || repoPath };
    }

    debugLog('findStateForHook', 'ambiguous: multiple sessions, no agent slug', {
      claudeSessionId,
      totalSessions: sessions.length,
      sessionModels: sessions.map(s => ({ id: s.sessionId, model: s.model })),
    });
    return null;
  }

  // 3. Legacy: try untagged state file (backward compat before concurrent support)
  const legacy = loadSessionState(hookCwd) || (repoPath !== hookCwd ? loadSessionState(repoPath) : null);
  if (legacy) {
    debugLog('findStateForHook', 'legacy untagged match', { sessionId: legacy.sessionId });
    return { state: legacy, saveCwd: legacy.repoPath || repoPath };
  }

  debugLog('findStateForHook', 'no state found', { hookCwd, repoPath, claudeSessionId });
  return null;
}

// ─── Gemini Transcript Discovery ──────────────────────────────────────────

/**
 * Gemini CLI has used several storage layouts across versions:
 *   - ~/.gemini/tmp/<workspace>/chats/session-*.json    (older)
 *   - ~/.gemini/tmp/<projectHash>/chats/session-*.json  (hash-based)
 *   - ~/.gemini/tmp/<projectHash>/checkpoints/*.json    (newer checkpoints)
 *   - ~/.gemini/projects/<projectHash>/checkpoints/*.json
 *
 * Walk every plausible location and pick the newest matching JSON. The hook
 * may also receive `transcript_path` via stdin — that wins over discovery.
 */
/**
 * Read the actual model identifier from a Gemini transcript file.
 *
 * Gemini CLI's hook stdin doesn't include `model`, so without this
 * the dashboard falls back to the bare brand string "gemini" and every
 * commit row reads "Gemini" instead of e.g. "Gemini 2.5 Pro".
 *
 * Gemini writes its session metadata in the FIRST JSONL line of the
 * chat file (header with model/projectId/created) and includes a
 * `model` field on each model-response event. We scan the file for
 * either signal — the LATEST event with a model field wins (mid-
 * session model switches via /chat command are then reflected).
 *
 * Returns null when no model is found OR when the file isn't a Gemini
 * chat (e.g. stale path). Caller falls back to the bare "gemini".
 */
function readGeminiModel(transcriptPath: string): string | null {
  if (!transcriptPath || !fs.existsSync(transcriptPath)) return null;
  let raw: string;
  try { raw = fs.readFileSync(transcriptPath, 'utf-8'); } catch { return null; }
  let latestModel: string | null = null;
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    let evt: any;
    try { evt = JSON.parse(line); } catch { continue; }
    // Header line at top of file usually has shape
    // { sessionId, model, projectId, created, ... }. The exact key
    // varies (`model`, `modelName`, `metadata.model`); accept any.
    const candidate =
      (typeof evt?.model === 'string' && evt.model) ||
      (typeof evt?.modelName === 'string' && evt.modelName) ||
      (typeof evt?.metadata?.model === 'string' && evt.metadata.model) ||
      (typeof evt?.payload?.model === 'string' && evt.payload.model) ||
      (typeof evt?.config?.model === 'string' && evt.config.model) ||
      null;
    if (candidate && candidate !== 'gemini' && candidate !== 'unknown') {
      latestModel = candidate;
    }
  }
  return latestModel;
}

function discoverGeminiTranscriptPath(opts: { maxAgeMs?: number; sessionId?: string } = {}): string | null {
  // Default: 60-minute window. Mid-session, Gemini may not touch its chat
  // file for many minutes between user prompts (it's only re-written on
  // /chat save or end-of-turn), so a 10-minute gate dropped active sessions.
  //
  // STRICT mode: when a sessionId is supplied, we only return a file whose
  // basename embeds that id. The legacy "newest file across all
  // .gemini/ dirs" fallback was the smoking gun for cross-conversation
  // contamination — Gemini happily kept stale chat files around and we'd
  // pick whichever was last touched, attributing some other chat's
  // prompts to the current session.
  //
  // sessionId-less calls are still supported for the no-stdin-id case
  // (e.g. plain `gemini` CLI invocations); those keep the legacy newest-
  // file behaviour but log every time it fires so we can tell when ID
  // anchoring isn't doing the work.
  const maxAgeMs = opts.maxAgeMs ?? 60 * 60 * 1000;
  try {
    const home = os.homedir();
    const candidateRoots: string[] = [
      path.join(home, '.gemini', 'tmp'),
      path.join(home, '.gemini', 'projects'),
    ];

    let newestFile = '';
    let newestMtime = 0;
    let idMatchedFile = '';
    let idMatchedMtime = 0;

    const consider = (fp: string, name: string) => {
      try {
        const stat = fs.statSync(fp);
        if (!stat.isFile()) return;
        if (opts.sessionId && name.includes(opts.sessionId)) {
          if (stat.mtimeMs > idMatchedMtime) {
            idMatchedMtime = stat.mtimeMs;
            idMatchedFile = fp;
          }
        }
        if (stat.mtimeMs > newestMtime) {
          newestMtime = stat.mtimeMs;
          newestFile = fp;
        }
      } catch { /* ignore */ }
    };

    const isSessionLike = (name: string) =>
      name.endsWith('.json') &&
      (name.startsWith('session-') || name.startsWith('checkpoint') || name.startsWith('chat'));

    for (const root of candidateRoots) {
      if (!fs.existsSync(root)) continue;
      let entries: string[] = [];
      try { entries = fs.readdirSync(root); } catch { continue; }
      for (const ws of entries) {
        const wsDir = path.join(root, ws);
        let isDir = false;
        try { isDir = fs.statSync(wsDir).isDirectory(); } catch { /* ignore */ }
        if (!isDir) continue;
        for (const sub of ['chats', 'checkpoints']) {
          const dir = path.join(wsDir, sub);
          if (!fs.existsSync(dir)) continue;
          let files: string[] = [];
          try { files = fs.readdirSync(dir); } catch { continue; }
          for (const f of files) {
            if (isSessionLike(f)) consider(path.join(dir, f), f);
          }
        }
      }
    }

    if (opts.sessionId) {
      if (idMatchedFile && (Date.now() - idMatchedMtime) < maxAgeMs) {
        return idMatchedFile;
      }
      debugLog('gemini', 'discoverGeminiTranscriptPath: no recent file for sessionId', {
        sessionId: opts.sessionId,
      });
      return null;
    }

    if (newestFile && (Date.now() - newestMtime) < maxAgeMs) {
      debugLog('gemini', 'discoverGeminiTranscriptPath: no sessionId, returning newest file', {
        file: newestFile,
      });
      return newestFile;
    }
    return null;
  } catch {
    return null;
  }
}

// ─── Cursor Transcript Discovery ──────────────────────────────────────────

interface CursorTranscriptData {
  inputTokens: number;
  outputTokens: number;
  tokensUsed: number;
  transcript: string;  // JSON stringified [{role, content}]
}

/**
 * Cursor stores agent conversation transcripts as JSONL at:
 *   ~/.cursor/projects/<workspace>/agent-transcripts/<id>/<id>.jsonl
 *
 * Each line: { role: "user"|"assistant", message: { content: [{ type, text }] } }
 *
 * There are no token counts in these files, but we can compute accurate
 * estimates by counting the actual conversation text (much better than
 * the previous chars/4 heuristic that only counted user prompts).
 */
function discoverCursorTranscript(conversationId?: string, hookCwd?: string, opts: { verbose?: boolean } = {}): CursorTranscriptData | null {
  try {
    const cursorProjectsDir = path.join(os.homedir(), '.cursor', 'projects');
    if (!fs.existsSync(cursorProjectsDir)) return null;

    // STRICT ID-anchored discovery. The mtime-prefer fallback that used
    // to live here would silently pick up another open chat's transcript
    // whenever Cursor's stdin sent a stale ID — producing dashboard
    // sessions captioned with prompts from a different conversation.
    //
    // Contract now: caller MUST pass the conversationId recorded at
    // session-start (state.agentSessionId). We look for ONLY that
    // directory. If the matching file doesn't exist, return null and
    // log the miss — the live user-prompt-submit path already has the
    // authoritative prompt text on stdin; we don't need the JSONL
    // sidecar for prompt capture, only for token estimation +
    // transcript display.
    if (!conversationId) {
      debugLog('cursor', 'discoverCursorTranscript: no conversationId — refusing to guess');
      return null;
    }

    // Walk every workspace looking for THIS conversation's directory.
    // Cursor sometimes records the same chat under a workspace dir whose
    // dash-encoded path doesn't quite match hookCwd (worktree shenanigans,
    // case sensitivity), so we trust the conversation_id over the
    // workspace path. ID collisions across workspaces would be a
    // Cursor bug we'd want to know about — log if it happens.
    const matches: string[] = [];
    const workspaces = fs.readdirSync(cursorProjectsDir);
    for (const ws of workspaces) {
      const candidate = path.join(cursorProjectsDir, ws, 'agent-transcripts', conversationId, `${conversationId}.jsonl`);
      if (fs.existsSync(candidate)) matches.push(candidate);
    }
    if (matches.length === 0) {
      debugLog('cursor', 'discoverCursorTranscript: no JSONL for conversationId', { conversationId });
      return null;
    }
    if (matches.length > 1) {
      debugLog('cursor', 'discoverCursorTranscript: conversationId resolved in MULTIPLE workspaces — using first', {
        conversationId, matches,
      });
    }
    const transcriptFileFinal = matches[0];
    // Sanity: refuse a transcript that hasn't been touched in 30 minutes.
    // The ID anchor already prevents cross-chat leakage; this guard
    // only catches "Cursor recreated this chat days ago, the dir still
    // exists" — rare but worth nothing-vs-stale.
    try {
      const stat = fs.statSync(transcriptFileFinal);
      if (Date.now() - stat.mtimeMs > 30 * 60 * 1000) {
        debugLog('cursor', 'discoverCursorTranscript: matched file stale, refusing', {
          conversationId, ageMs: Date.now() - stat.mtimeMs,
        });
        return null;
      }
    } catch {
      return null;
    }

    // Parse the JSONL
    const raw = fs.readFileSync(transcriptFileFinal, 'utf-8');
    const lines = raw.split('\n').filter(l => l.trim());

    const TRUNC = opts.verbose ? Number.MAX_SAFE_INTEGER : 2000;
    const truncate = (s: string) => s.length > TRUNC ? s.slice(0, TRUNC) + `… [+${s.length - TRUNC} chars]` : s;

    const turns: Array<{ role: string; content: string }> = [];
    let totalInputChars = 0;
    let totalOutputChars = 0;

    for (const line of lines) {
      try {
        const entry = JSON.parse(line);
        const role = entry.role || 'unknown';
        const content = entry.message?.content;

        // Cursor blocks: text, tool_use, tool_result, thinking
        // Pull out everything we can render — text + structured tool I/O —
        // so reviewers see what the agent ran, not just the narration.
        const parts: string[] = [];
        let plainText = '';

        if (typeof content === 'string') {
          plainText = content;
          parts.push(content);
        } else if (Array.isArray(content)) {
          for (const c of content as any[]) {
            const t = c?.type;
            if (t === 'text' && typeof c.text === 'string') {
              plainText += c.text;
              parts.push(c.text);
            } else if (t === 'thinking' && (c.thinking || c.text)) {
              parts.push(`[Reasoning] ${truncate(c.thinking || c.text || '')}`);
            } else if (t === 'tool_use' && c.name) {
              const inp = c.input || {};
              const argStr =
                typeof inp.command === 'string' ? inp.command :
                typeof inp.cmd === 'string' ? inp.cmd :
                inp.file_path && (typeof inp.old_string === 'string' || typeof inp.new_string === 'string')
                  ? [`file: ${inp.file_path}`,
                     typeof inp.old_string === 'string' ? `--- old\n${inp.old_string}` : '',
                     typeof inp.new_string === 'string' ? `+++ new\n${inp.new_string}` : '']
                    .filter(Boolean).join('\n')
                  : (() => { try { return JSON.stringify(inp, null, 2); } catch { return ''; } })();
              parts.push(`[Tool: ${c.name}]`);
              if (argStr) parts.push(truncate(argStr));
            } else if (t === 'tool_result') {
              const out =
                typeof c.content === 'string' ? c.content :
                Array.isArray(c.content)
                  ? c.content.map((b: any) => typeof b === 'string' ? b : (b?.text || b?.content || '')).filter(Boolean).join('\n')
                  : '';
              if (out) parts.push(`[Output] ${truncate(out)}`);
            }
          }
        }

        const text = parts.join('\n').trim();
        if (!text) continue;

        // Strip XML wrappers like <user_query>...</user_query>
        const cleaned = text.replace(/<\/?user_query>/g, '').trim();
        if (!cleaned) continue;

        turns.push({ role, content: cleaned });

        // Token estimation uses plain text only (tool I/O isn't billed by Cursor)
        if (role === 'user') {
          totalInputChars += plainText.length;
        } else {
          totalOutputChars += plainText.length;
        }
      } catch {
        // skip malformed lines
      }
    }

    if (turns.length === 0) return null;

    // Token estimation from actual conversation text.
    // ~3.5 chars per token for code-heavy content (better than the old 4.0).
    // Input includes: user prompts + file context sent by Cursor (estimate 3x
    // the visible prompt text for attached files, codebase context, etc.)
    const CHARS_PER_TOKEN = 3.5;
    const CONTEXT_MULTIPLIER = 3;  // Cursor sends ~3x the prompt text as file context
    const visibleInputTokens = Math.round(totalInputChars / CHARS_PER_TOKEN);
    const estimatedInputTokens = visibleInputTokens * CONTEXT_MULTIPLIER;
    const estimatedOutputTokens = Math.round(totalOutputChars / CHARS_PER_TOKEN);
    const totalTokens = estimatedInputTokens + estimatedOutputTokens;

    debugLog('cursor', 'parsed agent transcript', {
      turns: turns.length,
      inputChars: totalInputChars,
      outputChars: totalOutputChars,
      estimatedInputTokens,
      estimatedOutputTokens,
      totalTokens,
    });

    return {
      inputTokens: estimatedInputTokens,
      outputTokens: estimatedOutputTokens,
      tokensUsed: totalTokens,
      transcript: JSON.stringify(turns),
    };
  } catch (err) {
    debugLog('cursor', 'discoverCursorTranscript error', { error: String(err) });
    return null;
  }
}

// ─── Codex Session Data Discovery ─────────────────────────────────────────

interface CodexSessionData {
  model: string;
  tokensUsed: number;
  inputTokens: number;     // NON-cached prompt tokens
  outputTokens: number;    // visible output + reasoning (both billed at output rate)
  cacheReadTokens?: number; // cached prompt portion — billed at the model's cached rate
  toolCalls: number;
  prompt: string;
  prompts?: string[];   // all user prompts from the rollout, in order
  transcript?: string;  // full JSONL conversation for display
  cwd?: string;         // codex thread's actual cwd — drives repoPath correction
  rolloutPath?: string; // absolute path to the rollout JSONL(.zst) — feed to
                        // the new per-prompt PromptCapture extractor
}

/**
 * Codex CLI stores session data in two places:
 *
 * 1. **SQLite** (`~/.codex/state_*.sqlite`) — `threads` table has model,
 *    `tokens_used`, cwd, rollout_path. `tokens_used` is a single aggregate
 *    that can be 0 or drastically undercounted for short sessions.
 *
 * 2. **Rollout JSONL** (`~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl.zst`)
 *    — compressed event stream with per-turn `TokenCountEvent` entries
 *    containing `total_token_usage.{input_tokens,output_tokens,total_tokens}`
 *    and the full conversation (user messages, assistant responses, tool
 *    calls). This is the authoritative source.
 *
 * Strategy: query SQLite for the thread matching this repo, grab its
 * rollout_path, decompress and parse the JSONL for real token counts
 * and transcript. Fall back to SQLite `tokens_used` if rollout parsing fails.
 */
function discoverCodexSessionData(
  repoPath: string,
  opts: { verbose?: boolean; threadId?: string } = {},
): CodexSessionData | null {
  try {
    const codexDir = path.join(os.homedir(), '.codex');
    if (!fs.existsSync(codexDir)) return null;

    // ── Step 1: Find the matching thread from SQLite ───────────────────
    const stateFiles = fs.readdirSync(codexDir)
      .filter(f => f.startsWith('state_') && f.endsWith('.sqlite'))
      .map(f => ({ name: f, path: path.join(codexDir, f), mtime: fs.statSync(path.join(codexDir, f)).mtimeMs }))
      .sort((a, b) => b.mtime - a.mtime);
    if (stateFiles.length === 0) return null;

    const dbPath = stateFiles[0].path;

    // STRICT thread-id matching when the caller has one. session-start
    // queries SQLite ONCE by EXACT `cwd = repoPath` and stores threads.id
    // on state.agentSessionId. Every downstream hook passes that id in
    // here, and we read its row directly — no basename LIKE, no
    // "newest thread overall" fallback. Both of those used to make Codex
    // happily attribute work from one repo's thread to another repo's
    // session whenever the user ran codex against multiple repos in
    // parallel.
    //
    // When threadId is absent (session-start itself, first call before
    // anything's been stored), we fall back to EXACT cwd equality —
    // never `LIKE` — and never to "latest thread overall."
    const sqliteOpts = {
      encoding: 'utf-8' as const, timeout: 3000,
      stdio: ['pipe', 'pipe', 'pipe'] as ['pipe', 'pipe', 'pipe'],
    };

    let raw = '';
    if (opts.threadId && /^[A-Za-z0-9_-]+$/.test(opts.threadId)) {
      const byIdQuery = `SELECT id, model, tokens_used, rollout_path, cwd, first_user_message FROM threads WHERE id = '${opts.threadId}' LIMIT 1;`;
      raw = execFileSync('sqlite3', [dbPath, byIdQuery], sqliteOpts).trim();
      if (!raw) {
        debugLog('codex', 'discoverCodexSessionData: threadId not found in SQLite', { threadId: opts.threadId });
        return null;
      }
    } else {
      // No locked thread yet — match strictly on `cwd = repoPath`. The
      // exact match means concurrent codex threads in sibling repos
      // can't be confused for each other; if no row matches we bail
      // (callers expect null when nothing fits).
      const exactCwd = repoPath.replace(/'/g, "''"); // escape single-quote for SQL
      const byCwdQuery = `SELECT id, model, tokens_used, rollout_path, cwd, first_user_message FROM threads WHERE cwd = '${exactCwd}' ORDER BY updated_at DESC LIMIT 1;`;
      raw = execFileSync('sqlite3', [dbPath, byCwdQuery], sqliteOpts).trim();
      if (!raw) {
        debugLog('codex', 'discoverCodexSessionData: no thread for exact cwd', { repoPath });
        return null;
      }
    }

    const parts = raw.split('|');
    if (parts.length < 6) return null;

    const threadId = parts[0];
    const model = parts[1] || 'codex';
    const sqliteTokens = parseInt(parts[2], 10) || 0;
    const rolloutPath = parts[3] || '';
    const threadCwd = parts[4] || '';
    const rawPrompt = parts.slice(5).join('|') || '';
    // Codex's `first_user_message` column captures whatever the first
    // user-role event in the rollout contained — which is Codex's own
    // AGENTS.md replay or its environment-context wrapper, not anything
    // the user typed. Filter the echo out so it never reaches
    // state.prompts / the dashboard.
    const looksLikeOriginEcho =
      rawPrompt.includes('<!-- origin-managed -->') ||
      /^#\s+AGENTS\.md instructions for /m.test(rawPrompt);
    const stripped = rawPrompt
      .replace(/<INSTRUCTIONS>[\s\S]*?<\/INSTRUCTIONS>/g, '')
      .replace(/<environment_context>[\s\S]*?<\/environment_context>/g, '')
      .replace(/<user_instructions>[\s\S]*?<\/user_instructions>/g, '')
      .trim();
    const prompt = looksLikeOriginEcho ? '' : stripped;

    // Resolve the rollout file once so we can hand the absolute path to
    // the new per-prompt PromptCapture extractor (which decompresses .zst
    // and walks the rollout for [branch sha] markers + commit-walking).
    const absRolloutPath = (() => {
      if (rolloutPath && fs.existsSync(rolloutPath)) return rolloutPath;
      if (rolloutPath) {
        const abs = path.join(codexDir, rolloutPath);
        if (fs.existsSync(abs)) return abs;
      }
      try { return findCodexRolloutPath(repoPath, threadId); } catch { return null; }
    })();

    // ── Step 2: Try to parse the rollout JSONL for real token counts ──
    const rolloutResult = parseCodexRollout(codexDir, rolloutPath, threadId, { verbose: !!opts.verbose });
    if (rolloutResult) {
      debugLog('codex', 'parsed rollout JSONL', {
        inputTokens: rolloutResult.inputTokens,
        outputTokens: rolloutResult.outputTokens,
        total: rolloutResult.tokensUsed,
        turns: rolloutResult.turnCount,
      });
      return {
        model: rolloutResult.model || model,
        tokensUsed: rolloutResult.tokensUsed,
        inputTokens: rolloutResult.inputTokens,
        outputTokens: rolloutResult.outputTokens,
        cacheReadTokens: rolloutResult.cacheReadTokens,
        toolCalls: rolloutResult.toolCalls,
        prompt,
        prompts: rolloutResult.userPrompts,
        transcript: rolloutResult.transcript,
        cwd: threadCwd || undefined,
        rolloutPath: absRolloutPath || undefined,
      };
    }

    // ── Step 3: Fall back to SQLite tokens_used (may be 0 / undercount) ─
    debugLog('codex', 'rollout parse failed, using SQLite tokens_used', { sqliteTokens });
    return {
      model,
      tokensUsed: sqliteTokens,
      inputTokens: Math.round(sqliteTokens * 0.7),
      outputTokens: Math.round(sqliteTokens * 0.3),
      toolCalls: 0,
      prompt,
      cwd: threadCwd || undefined,
      rolloutPath: absRolloutPath || undefined,
    };
  } catch (err) {
    debugLog('codex', 'discoverCodexSessionData error', { error: String(err) });
    return null;
  }
}

/**
 * Parse a Codex rollout JSONL(.zst) file for real per-turn token usage
 * and conversation transcript.
 *
 * Rollout files live under ~/.codex/sessions/YYYY/MM/DD/ and can be either
 * plain .jsonl or zstd-compressed .jsonl.zst. Each line is a JSON event.
 *
 * Token events have a `total_token_usage` field with cumulative counts.
 * We take the max seen values as the final totals.
 */
/**
 * Extract user prompts with timestamps from the agent's session log so the
 * post-commit hook can attribute each commit to the prompt that produced
 * it. Codex/Gemini don't fire user-prompt-submit hooks, so without this
 * every commit ends up stamped with promptIndex 0 (the rest being filled
 * in only at session end).
 *
 * Returns prompts in chronological order with millisecond timestamps; the
 * index in the array IS the promptIndex used for downstream UI.
 */
interface PromptTimelineEntry {
  text: string;
  timestamp: number;
}

// Locate (without reading) the Codex rollout file for the current repo. Used
// by callers that need the path to hand to another module that does its own
// file IO (e.g. backfillCodexPromptMappings, which reads + decompresses the
// rollout inside its own process).
function findCodexRolloutPath(repoPath: string, threadId?: string): string | null {
  // STRICT path resolution. When a threadId is passed, only return its
  // rollout. Otherwise EXACT-cwd match — no basename LIKE, no "latest
  // overall" fallback. Both of those used to silently attribute a foreign
  // Codex thread's rollout to this session.
  try {
    const codexDir = path.join(os.homedir(), '.codex');
    if (!fs.existsSync(codexDir)) return null;
    const stateFiles = fs.readdirSync(codexDir)
      .filter(f => f.startsWith('state_') && f.endsWith('.sqlite'))
      .map(f => ({ path: path.join(codexDir, f), mtime: fs.statSync(path.join(codexDir, f)).mtimeMs }))
      .sort((a, b) => b.mtime - a.mtime);
    if (stateFiles.length === 0) return null;

    const sqliteOpts = {
      encoding: 'utf-8' as const, timeout: 3000,
      stdio: ['pipe', 'pipe', 'pipe'] as ['pipe', 'pipe', 'pipe'],
    };

    let raw = '';
    if (threadId && /^[A-Za-z0-9_-]+$/.test(threadId)) {
      const byIdQuery = `SELECT id, rollout_path FROM threads WHERE id = '${threadId}' LIMIT 1;`;
      raw = execFileSync('sqlite3', [stateFiles[0].path, byIdQuery], sqliteOpts).trim();
      if (!raw) {
        debugLog('codex', 'findCodexRolloutPath: threadId not in SQLite', { threadId });
        return null;
      }
    } else {
      const exactCwd = repoPath.replace(/'/g, "''");
      const byCwdQuery = `SELECT id, rollout_path FROM threads WHERE cwd = '${exactCwd}' ORDER BY updated_at DESC LIMIT 1;`;
      raw = execFileSync('sqlite3', [stateFiles[0].path, byCwdQuery], sqliteOpts).trim();
      if (!raw) return null;
    }
    const parts = raw.split('|');
    const resolvedThreadId = parts[0];
    const rolloutPath = parts[1] || '';

    if (rolloutPath && fs.existsSync(rolloutPath)) return rolloutPath;
    if (rolloutPath) {
      const abs = path.join(codexDir, rolloutPath);
      if (fs.existsSync(abs)) return abs;
    }
    // Last resort: the rollout file is named rollout-<id>-*.jsonl(.zst) in
    // ~/.codex/sessions/. Walk it by EXACT thread id only.
    const sessionsDir = path.join(codexDir, 'sessions');
    if (fs.existsSync(sessionsDir) && resolvedThreadId) {
      const latest = findLatestRollout(sessionsDir, resolvedThreadId);
      if (latest) return latest;
    }
    return null;
  } catch {
    return null;
  }
}

function readCodexRolloutFile(repoPath: string, threadId?: string): string | null {
  try {
    const rolloutFile = findCodexRolloutPath(repoPath, threadId);
    if (!rolloutFile) return null;

    if (rolloutFile.endsWith('.zst') || rolloutFile.endsWith('.zstd')) {
      const compressed = fs.readFileSync(rolloutFile);
      const decompressed = fzstd.decompress(new Uint8Array(compressed));
      return Buffer.from(decompressed).toString('utf-8');
    }
    return fs.readFileSync(rolloutFile, 'utf-8');
  } catch {
    return null;
  }
}

function getCodexPromptsTimeline(repoPath: string, threadId?: string): PromptTimelineEntry[] {
  const content = readCodexRolloutFile(repoPath, threadId);
  if (!content) return [];
  const out: PromptTimelineEntry[] = [];
  for (const line of content.split('\n')) {
    if (!line.trim()) continue;
    try {
      const event = JSON.parse(line);
      const eventType = event?.type || event?.event || '';
      if (eventType !== 'item.created' && eventType !== 'message') continue;
      const item = event?.data || event?.item || event;
      const role = item?.role || item?.type;
      if (role !== 'user' && role !== 'human') continue;
      const content_ = item?.content || item?.text || item?.message;
      const text = typeof content_ === 'string'
        ? content_
        : Array.isArray(content_)
          ? content_.map((c: any) => c?.text || c?.content || '').join('')
          : '';
      if (!text || !text.trim()) continue;
      // Drop the AGENTS.md / origin-managed echo: Codex reads AGENTS.md
      // natively and replays it as the first user-role message in the
      // rollout. The user-prompt-submit hook already filters this for
      // the live `prompt` capture path; we apply the same filter here
      // so the dashboard's session view doesn't show Origin's own
      // system block as turn 1.
      if (text.includes('<!-- origin-managed -->')) continue;
      if (/^#\s+AGENTS\.md instructions for /m.test(text)) continue;
      // Codex also wraps the AGENTS.md content in <INSTRUCTIONS>...</INSTRUCTIONS>
      // — if that's everything in the message, drop it.
      const stripped = text.replace(/<INSTRUCTIONS>[\s\S]*?<\/INSTRUCTIONS>/g, '').trim();
      if (!stripped) continue;
      // Codex events carry an ISO-ish timestamp on most variants.
      const tsRaw = event?.timestamp || event?.ts || event?.time || event?.created_at || item?.timestamp;
      const ts = tsRaw ? new Date(tsRaw).getTime() : NaN;
      out.push({ text: stripped, timestamp: Number.isFinite(ts) ? ts : 0 });
    } catch { /* skip */ }
  }
  // If timestamps are missing, preserve insertion order (the JSONL itself is
  // chronological).
  return out;
}

function getGeminiPromptsTimeline(transcriptPath: string): PromptTimelineEntry[] {
  if (!transcriptPath || !fs.existsSync(transcriptPath)) return [];
  try {
    const raw = fs.readFileSync(transcriptPath, 'utf-8');
    // Gemini transcripts are JSON arrays of {role, parts:[{text}], timestamp}
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    const out: PromptTimelineEntry[] = [];
    for (const m of parsed) {
      const role = m?.role;
      if (role !== 'user' && role !== 'human') continue;
      const text = typeof m.content === 'string'
        ? m.content
        : Array.isArray(m?.parts)
          ? m.parts.map((p: any) => p?.text || '').join('')
          : '';
      if (!text || !text.trim()) continue;
      const tsRaw = m?.timestamp || m?.ts || m?.created_at;
      const ts = tsRaw ? new Date(tsRaw).getTime() : 0;
      out.push({ text, timestamp: Number.isFinite(ts) ? ts : 0 });
    }
    return out;
  } catch {
    return [];
  }
}

/**
 * Pick the prompt that most likely produced this commit.
 *
 * 1. If we have explicit prompts in state (Claude path), use the latest one.
 * 2. Else discover the agent's prompts from its transcript (Codex/Gemini)
 *    and find the latest prompt whose timestamp ≤ the commit's timestamp.
 *    Falls back to the last prompt if no usable timestamps are present.
 */
function resolvePromptForCommit(
  state: SessionState | null,
  repoPath: string,
  commitTimestampMs: number,
): { promptIndex: number; promptText: string; total: number } {
  const fromState = state?.prompts || [];
  if (fromState.length > 0) {
    const idx = fromState.length - 1;
    return { promptIndex: idx, promptText: fromState[idx], total: fromState.length };
  }

  // Codex — anchored on the thread_id we locked at session-start so
  // concurrent codex threads in sibling repos can't pollute this timeline.
  const isCodex = !!state?.model && /gpt|codex|o1-|o3-|o4-/i.test(state.model);
  const codexThreadId = (state as any)?.agentSessionId || (state as any)?.claudeSessionId || undefined;
  let timeline: PromptTimelineEntry[] = isCodex ? getCodexPromptsTimeline(repoPath, codexThreadId) : [];

  // Gemini fallback
  if (timeline.length === 0 && state?.transcriptPath && fs.existsSync(state.transcriptPath)) {
    timeline = getGeminiPromptsTimeline(state.transcriptPath);
  }

  if (timeline.length === 0) {
    return { promptIndex: 0, promptText: '', total: 0 };
  }

  // Match commit to the latest prompt at-or-before commitTimestamp.
  let pickIdx = -1;
  for (let i = 0; i < timeline.length; i++) {
    const ts = timeline[i].timestamp;
    if (ts > 0 && ts <= commitTimestampMs) pickIdx = i;
    else if (ts === 0) pickIdx = i; // unknown timestamp — fall through
  }
  if (pickIdx < 0) pickIdx = timeline.length - 1;

  return {
    promptIndex: pickIdx,
    promptText: timeline[pickIdx].text,
    total: timeline.length,
  };
}

// Exported for the pricing-regression test suite — it asserts that
// a real rollout fixture parses into the documented token/cost shape
// (non-cached input, cached reads, reasoning folded into output).
// This is the only public consumer; production callers go through
// `discoverCodexSessionData` above.
export function parseCodexRollout(
  codexDir: string,
  rolloutPath: string,
  threadId: string,
  opts: { verbose?: boolean } = {},
): { tokensUsed: number; inputTokens: number; outputTokens: number; cacheReadTokens?: number; model?: string; turnCount: number; toolCalls: number; transcript?: string; userPrompts?: string[] } | null {
  try {
    // Try to resolve the rollout file
    let rolloutFile = '';

    if (rolloutPath && fs.existsSync(rolloutPath)) {
      rolloutFile = rolloutPath;
    } else if (rolloutPath) {
      // rollout_path might be relative to codexDir
      const abs = path.join(codexDir, rolloutPath);
      if (fs.existsSync(abs)) rolloutFile = abs;
    }

    // If no rollout_path, scan the sessions directory for most recent file
    // matching this thread ID
    if (!rolloutFile) {
      const sessionsDir = path.join(codexDir, 'sessions');
      if (fs.existsSync(sessionsDir)) {
        rolloutFile = findLatestRollout(sessionsDir, threadId);
      }
    }

    if (!rolloutFile) return null;

    // Read + decompress. Previously relied on `zstd` CLI or `python3+zstandard`
    // which many users don't have installed — token capture silently degraded
    // to character-based estimation. fzstd is a pure-JS decoder (~20KB) so this
    // path now works on any machine with just Node.
    let content: string;
    if (rolloutFile.endsWith('.zst') || rolloutFile.endsWith('.zstd')) {
      try {
        const compressed = fs.readFileSync(rolloutFile);
        const decompressed = fzstd.decompress(new Uint8Array(compressed));
        content = Buffer.from(decompressed).toString('utf-8');
      } catch (err) {
        debugLog('codex', 'fzstd decompress failed', { error: String(err) });
        return null;
      }
    } else {
      content = fs.readFileSync(rolloutFile, 'utf-8');
    }

    // Parse JSONL events
    const lines = content.split('\n').filter(l => l.trim());
    let maxInputTokens = 0;
    let maxOutputTokens = 0;
    // OpenAI's `input_tokens` includes the cached portion as a subset,
    // so we track `cached_input_tokens` separately and subtract on
    // the way out — the cost path needs them split (cached is billed
    // at $0.50/M for gpt-5.5, regular is $5/M).
    let maxCachedInputTokens = 0;
    // Codex/gpt-5 reasoning tokens land in a separate field but are
    // billed at the output rate. Add to outputTokens on the way out
    // so neither the cost nor the tokensUsed total under-reports.
    let maxReasoningOutputTokens = 0;
    let maxTotalTokens = 0;
    let model: string | undefined;
    let turnCount = 0;
    let toolCalls = 0;

    // Build transcript from conversation events
    const turns: Array<{ role: string; content: string }> = [];

    // Truncation budget for tool args/output. Verbose mode keeps the full
    // payload so reviewers can see exactly what the agent ran; default mode
    // keeps each side ≤ 2 KB so a long session's transcript stays uploadable.
    const TOOL_TRUNC = opts.verbose ? Number.MAX_SAFE_INTEGER : 2000;
    const truncate = (s: string, max: number = TOOL_TRUNC): string =>
      s.length > max ? s.slice(0, max) + `… [+${s.length - max} chars]` : s;

    // Pending tool calls keyed by call_id so we can attach their outputs
    // when the matching `function_call_output` arrives.
    const pendingTools = new Map<string, number>();  // call_id → turns[] index

    const extractMessageText = (content_: any): string => {
      if (typeof content_ === 'string') return content_;
      if (!Array.isArray(content_)) return '';
      return content_
        .map((c: any) => {
          if (!c) return '';
          if (typeof c === 'string') return c;
          // Codex content blocks: {type: "input_text"|"output_text", text: "..."}
          if (c.text) return c.text;
          if (c.content) return typeof c.content === 'string' ? c.content : '';
          return '';
        })
        .filter(Boolean)
        .join('');
    };

    for (const line of lines) {
      try {
        const event = JSON.parse(line);

        // Extract token usage from TokenCountEvent or turn.completed events.
        // Codex emits multiple shapes across versions — check the union.
        const tokenUsage =
          event?.total_token_usage ||
          event?.data?.total_token_usage ||
          event?.payload?.info?.total_token_usage ||
          event?.payload?.total_token_usage ||
          event?.payload?.usage ||
          event?.usage ||
          event?.data?.usage;

        if (tokenUsage) {
          const input = tokenUsage.input_tokens || tokenUsage.prompt_tokens || 0;
          const output = tokenUsage.output_tokens || tokenUsage.completion_tokens || 0;
          // Codex (responses-API) emits these on every TokenCountEvent.
          // OpenAI's older Chat Completions shape nests cache under
          // `prompt_tokens_details.cached_tokens`; cover both so we
          // don't silently drop cache info on legacy rollouts.
          const cached =
            tokenUsage.cached_input_tokens ||
            tokenUsage.prompt_tokens_details?.cached_tokens ||
            0;
          const reasoning =
            tokenUsage.reasoning_output_tokens ||
            tokenUsage.completion_tokens_details?.reasoning_tokens ||
            tokenUsage.reasoning_tokens ||
            0;
          const total = tokenUsage.total_tokens || (input + output);
          if (total > maxTotalTokens) {
            maxInputTokens = input;
            maxOutputTokens = output;
            maxCachedInputTokens = cached;
            maxReasoningOutputTokens = reasoning;
            maxTotalTokens = total;
          }
        }

        // Extract model from thread/turn/session events
        if (!model && (event?.model || event?.data?.model || event?.payload?.model)) {
          model = event.model || event.data?.model || event.payload?.model;
        }

        const eventType = event?.type || event?.event || '';
        const payload = event?.payload;
        const payloadType = payload?.type || '';

        // ── New-shape Codex rollouts: response_item events ────────────────
        // Each conversation item is wrapped as {type: "response_item", payload: {...}}.
        // The payload's `type` distinguishes message / reasoning / function_call /
        // function_call_output / local_shell_call.
        if (payloadType === 'message') {
          const role = payload.role || 'assistant';
          const text = extractMessageText(payload.content);
          if (text.trim()) {
            // Drop the AGENTS.md / origin-managed echo and Codex's
            // own <environment_context> session-init wrapper on
            // user-role turns. Codex replays both as the first user
            // events in the rollout; the dashboard renders the
            // whole transcript so without this they show up as
            // bogus turn 1 / 2 even though state.prompts filters them.
            const isUser = role === 'user' || role === 'human';
            const isEcho = isUser && (
              text.includes('<!-- origin-managed -->') ||
              /^#\s+AGENTS\.md instructions for /m.test(text)
            );
            if (!isEcho) {
              const cleaned = isUser
                ? text
                    .replace(/<INSTRUCTIONS>[\s\S]*?<\/INSTRUCTIONS>/g, '')
                    .replace(/<environment_context>[\s\S]*?<\/environment_context>/g, '')
                    .replace(/<user_instructions>[\s\S]*?<\/user_instructions>/g, '')
                    .trim()
                : text;
              if (cleaned) turns.push({ role, content: cleaned });
            }
          }
        } else if (payloadType === 'reasoning') {
          // Chain-of-thought summary — show as assistant reasoning so reviewers
          // can see the agent's plan, not just its actions.
          const summary = Array.isArray(payload.summary) ? payload.summary : [];
          const text = summary.map((s: any) => s?.text || '').filter(Boolean).join('\n\n');
          if (text.trim()) {
            turns.push({ role: 'assistant', content: `[Reasoning] ${text}` });
          }
        } else if (payloadType === 'function_call' || payloadType === 'local_shell_call') {
          toolCalls++;
          const tool = payload.name || (payloadType === 'local_shell_call' ? 'shell' : 'tool');
          const rawArgs = payload.arguments ?? payload.action ?? payload.command ?? '';
          const argStr = typeof rawArgs === 'string' ? rawArgs : JSON.stringify(rawArgs);
          const callId = payload.call_id || payload.id || '';
          const idx = turns.length;
          turns.push({ role: 'assistant', content: `[Tool: ${tool}] ${truncate(argStr)}` });
          if (callId) pendingTools.set(callId, idx);
        } else if (payloadType === 'function_call_output' || payloadType === 'local_shell_call_output') {
          const callId = payload.call_id || payload.id || '';
          const out = typeof payload.output === 'string'
            ? payload.output
            : (payload.output?.content
                ? (typeof payload.output.content === 'string'
                    ? payload.output.content
                    : JSON.stringify(payload.output.content))
                : JSON.stringify(payload.output ?? ''));
          if (out) {
            const idx = callId ? pendingTools.get(callId) : undefined;
            if (idx !== undefined) {
              turns[idx].content += `\n[Output] ${truncate(out)}`;
              pendingTools.delete(callId);
            } else {
              turns.push({ role: 'assistant', content: `[Output] ${truncate(out)}` });
            }
          }
        } else if (eventType === 'item.created' || eventType === 'message') {
          // ── Legacy/older-shape rollouts ─────────────────────────────────
          const item = event?.data || event?.item || event;
          const role = item?.role || item?.type;
          const content_ = item?.content || item?.text || item?.message;
          if (role && content_) {
            const text = extractMessageText(content_);
            if (text) {
              // Same AGENTS.md echo filter as the response_item path.
              const isUser = role === 'user' || role === 'human';
              const isEcho = isUser && (
                text.includes('<!-- origin-managed -->') ||
                /^#\s+AGENTS\.md instructions for /m.test(text)
              );
              if (!isEcho) {
                const cleaned = isUser
                  ? text
                      .replace(/<INSTRUCTIONS>[\s\S]*?<\/INSTRUCTIONS>/g, '')
                      .replace(/<environment_context>[\s\S]*?<\/environment_context>/g, '')
                      .replace(/<user_instructions>[\s\S]*?<\/user_instructions>/g, '')
                      .trim()
                  : text;
                if (cleaned) turns.push({ role, content: cleaned });
              }
            }
          }
        } else if (
          eventType === 'tool_call' || eventType === 'function_call' ||
          event?.data?.type === 'function_call' || event?.data?.type === 'shell'
        ) {
          toolCalls++;
          const tool = event?.data?.name || event?.data?.command || event?.name || 'tool';
          const args = event?.data?.arguments || event?.data?.args || '';
          const argStr = typeof args === 'string' ? args : JSON.stringify(args);
          turns.push({ role: 'assistant', content: `[Tool: ${tool}] ${truncate(argStr)}` });
        }

        // Track turns
        if (eventType === 'turn.completed' || eventType === 'turn.started') {
          turnCount++;
        }
      } catch {
        // Skip malformed lines
      }
    }

    // Don't bail when token usage hasn't fired yet — the rollout often
    // contains a fully-formed transcript before the TokenCountEvent
    // lands (especially when stop hooks fire mid-stream). Returning null
    // here used to drop the entire conversation; now we keep whatever
    // we parsed and let the next heartbeat / stop event refresh tokens.
    if (maxTotalTokens === 0 && turns.length === 0) return null;

    // Extract every cleaned user prompt in the order they appear. Used by
    // the Stop hook / heartbeat to grow state.prompts for Codex sessions,
    // since Codex's UserPromptSubmit hook is unreliable (Codex auto-trust
    // edge cases) and the singleton SQLite `first_user_message` only
    // surfaces prompt 0 — so without this every prompt after the first was
    // missing a per-prompt diff mapping on the dashboard.
    const userPrompts: string[] = [];
    for (const t of turns) {
      if (t.role === 'user' || t.role === 'human') {
        const cleaned = t.content.trim();
        if (cleaned) userPrompts.push(cleaned);
      }
    }

    // Split cached out of input, fold reasoning into output. This is
    // the contract the rest of the pipeline expects:
    //   inputTokens     — NON-cached prompt tokens (billed at full
    //                     model input rate)
    //   cacheReadTokens — cached subset (billed at the cached rate,
    //                     e.g. $0.50/M for gpt-5.5)
    //   outputTokens    — visible output + reasoning, both billed at
    //                     the output rate
    //   tokensUsed      — grand total including reasoning, so the
    //                     dashboard token column doesn't under-report
    //                     deep-thinking sessions
    const nonCachedInputTokens = Math.max(0, maxInputTokens - maxCachedInputTokens);
    const billableOutputTokens = maxOutputTokens + maxReasoningOutputTokens;
    const grandTotalTokens = nonCachedInputTokens + maxCachedInputTokens + billableOutputTokens;

    return {
      tokensUsed: grandTotalTokens,
      inputTokens: nonCachedInputTokens,
      outputTokens: billableOutputTokens,
      cacheReadTokens: maxCachedInputTokens,
      model,
      turnCount,
      toolCalls,
      transcript: turns.length > 0 ? JSON.stringify(turns) : undefined,
      userPrompts: userPrompts.length > 0 ? userPrompts : undefined,
    };
  } catch (err) {
    debugLog('codex', 'parseCodexRollout error', { error: String(err) });
    return null;
  }
}

/**
 * Scan ~/.codex/sessions/ for the most recent rollout file, optionally
 * matching a thread ID in the filename.
 */
function findLatestRollout(sessionsDir: string, threadId: string): string {
  let best = '';
  let bestMtime = 0;

  // sessions/YYYY/MM/DD/rollout-*.jsonl(.zst)
  try {
    const years = fs.readdirSync(sessionsDir).filter(d => /^\d{4}$/.test(d));
    for (const year of years.slice(-1)) {  // only check latest year
      const yearDir = path.join(sessionsDir, year);
      const months = fs.readdirSync(yearDir).filter(d => /^\d{2}$/.test(d));
      for (const month of months.slice(-2)) {  // last 2 months
        const monthDir = path.join(yearDir, month);
        const days = fs.readdirSync(monthDir).filter(d => /^\d{2}$/.test(d));
        for (const day of days) {
          const dayDir = path.join(monthDir, day);
          const files = fs.readdirSync(dayDir).filter(f => f.includes('rollout') || f.endsWith('.jsonl') || f.endsWith('.jsonl.zst'));
          for (const file of files) {
            const fp = path.join(dayDir, file);
            // Prefer files matching the thread ID
            if (threadId && file.includes(threadId)) return fp;
            const stat = fs.statSync(fp);
            if (stat.mtimeMs > bestMtime) {
              bestMtime = stat.mtimeMs;
              best = fp;
            }
          }
        }
      }
    }
  } catch {
    // ignore
  }

  return best;
}

// ─── Hook Handlers ─────────────────────────────────────────────────────────

async function handleSessionStart(input: Record<string, any>, agentSlug?: string): Promise<void> {
  debugLog('session-start', 'begin', { agentSlug, inputKeys: Object.keys(input) });

  const config = loadConfig();
  let agentConfig = loadAgentConfig();
  const connected = isConnectedMode();

  // In standalone mode, create minimal agent config if missing
  if (!agentConfig) {
    if (connected) {
      debugLog('session-start', 'ABORT: missing agent config (run origin enable)', { hasConfig: !!config });
      return;
    }
    // Auto-create minimal agent config for standalone
    agentConfig = {
      machineId: crypto.randomUUID(),
      hostname: os.hostname(),
      detectedTools: detectTools(),
      orgId: 'local',
    };
    ensureConfigDir();
    saveAgentConfig(agentConfig);
    debugLog('session-start', 'auto-created agent config (standalone)', { machineId: agentConfig.machineId });
  }

  // Fetch latest model pricing from API (non-blocking, falls back to defaults)
  if (connected) {
    try {
      const { pricing } = await api.getPricing();
      if (pricing && typeof pricing === 'object') {
        setActivePricing(pricing as Record<string, { input: number; output: number }>);
        debugLog('session-start', 'pricing fetched from API', { models: Object.keys(pricing).length });
      }
    } catch (err: any) {
      debugLog('session-start', 'pricing fetch failed, using defaults', { error: err.message });
    }
  }

  // Skip background agents (Cursor fires session-start for background indexing agents)
  if (input.is_background_agent === true || input.is_background_agent === 'true') {
    debugLog('session-start', 'SKIP: background agent', { is_background_agent: input.is_background_agent });
    return;
  }

  // Use cwd from hook input (Claude Code passes this), or workspace_roots (Cursor),
  // or fall back to process.cwd()
  let hookCwd = input.cwd || process.cwd();
  // Cursor sends workspace_roots instead of cwd — ALWAYS prefer workspace_roots
  // because Cursor runs hooks from ~/.cursor/ (not the project dir) and process.cwd()
  // may point to a completely different repo.
  if (input.workspace_roots && Array.isArray(input.workspace_roots) && input.workspace_roots.length > 0) {
    const wsRoot = input.workspace_roots[0];
    if (typeof wsRoot === 'string' && getGitRoot(wsRoot)) {
      hookCwd = wsRoot;
    }
  }
  debugLog('session-start', 'cwd resolved', { hookCwd, inputCwd: input.cwd, workspaceRoots: input.workspace_roots, processCwd: process.cwd() });

  // Use discoverGitRoot to handle cases where cwd is a parent of the actual repo
  // (e.g. Claude Code reports /project but the repo is /project/.openclaw/workspace/repo)
  const discoveredRoot = discoverGitRoot(hookCwd);
  let repoPath: string = discoveredRoot || hookCwd; // fall back to cwd for non-git projects
  let allRepoPaths: string[] | undefined;
  let isNonGitProject = false;
  if (!discoveredRoot) {
    // Check for multi-repo workspace (multiple git repos as subdirectories)
    const discovered = discoverAllGitRoots(hookCwd);
    if (discovered.length > 1) {
      allRepoPaths = discovered;
      repoPath = hookCwd;
      debugLog('session-start', 'multi-repo session detected', { repoPaths: discovered, workspacePath: hookCwd });
    } else if (discovered.length === 0) {
      // Non-git project: track session with basic data (no diffs/branches)
      isNonGitProject = true;
      repoPath = hookCwd;
      debugLog('session-start', 'non-git project, tracking without git data', { hookCwd });
    }
  }
  // Multi-repo support: if cwd itself is NOT a git repo but discoverGitRoot found one
  // in a subdirectory, check if there are MULTIPLE git repos under cwd.
  const directGitRoot = getGitRoot(hookCwd);
  if (discoveredRoot && !directGitRoot) {
    const discovered = discoverAllGitRoots(hookCwd);
    if (discovered.length > 1) {
      allRepoPaths = discovered;
      repoPath = hookCwd;
      debugLog('session-start', 'multi-repo session detected', { repoPaths: discovered, workspacePath: hookCwd });
    }
  }
  debugLog('session-start', 'repo path resolved', { repoPath, hookCwd, discovered: repoPath !== getGitRoot(hookCwd), multiRepo: !!allRepoPaths });

  // Ensure the git pre-commit hook is installed in this repo so
  // CONTENT_FILTER / secret-scan policies actually block commits.
  // User-reported (PR #156): a CONTENT_FILTER policy was configured
  // in the dashboard but Codex committed forbidden content because
  // the repo had never been `origin enable`'d — the per-repo
  // `.git/hooks/pre-commit` was missing, so the policy evaluator
  // never ran. The agent-level hooks (which DO fire because they
  // live in `~/.codex/hooks.json` or `~/.claude/settings.json`)
  // handle attribution but not enforcement. Auto-installing here
  // closes the gap for any agent the first time a session touches
  // a repo. Idempotent + silent — skips when already installed or
  // when `core.hooksPath` already routes through Origin's global
  // dir.
  if (!isNonGitProject && repoPath && !allRepoPaths) {
    try {
      const { ensurePolicyHookInstalled } = await import('./enable.js');
      const result = ensurePolicyHookInstalled(repoPath);
      if (result.installed) {
        debugLog('session-start', 'auto-installed policy pre-commit hook', { repoPath, reason: result.reason });
      } else {
        debugLog('session-start', 'policy hook not auto-installed', { repoPath, reason: result.reason });
      }
    } catch (err: any) {
      debugLog('session-start', 'policy hook auto-install failed (non-fatal)', { message: err?.message });
    }
  } else if (allRepoPaths) {
    // Multi-repo workspace — install in each discovered repo so
    // policies enforce on every commit regardless of which sub-repo
    // the agent edits.
    try {
      const { ensurePolicyHookInstalled } = await import('./enable.js');
      for (const r of allRepoPaths) {
        try {
          const result = ensurePolicyHookInstalled(r);
          if (result.installed) {
            debugLog('session-start', 'auto-installed policy pre-commit hook (multi-repo)', { repoPath: r, reason: result.reason });
          }
        } catch { /* per-repo failure non-fatal */ }
      }
    } catch (err: any) {
      debugLog('session-start', 'multi-repo policy hook auto-install failed (non-fatal)', { message: err?.message });
    }
  }

  // Resolve agent slug: .origin.json → agentSlugs override → hook command slug → saved default → undefined
  const repoConfig = loadRepoConfig(repoPath);
  const baseSlug = agentSlug || repoConfig?.agent || agentConfig.agentSlug || undefined;
  // Apply per-tool slug override from config (e.g. agentSlugs.claude-code = "claude-front")
  // Check both the hook command slug and the resolved base slug as override keys
  const slugOverrides = config?.agentSlugs || {};
  const slugOverride = (agentSlug && slugOverrides[agentSlug]) || (baseSlug && slugOverrides[baseSlug]) || undefined;
  const finalAgentSlug = slugOverride || baseSlug;
  debugLog('session-start', 'agent resolved', {
    fromRepoConfig: repoConfig?.agent,
    fromHookCommand: agentSlug,
    fromSavedDefault: agentConfig.agentSlug,
    baseSlug,
    configAgentSlugs: slugOverrides,
    slugOverride: slugOverride || null,
    final: finalAgentSlug,
  });

  // Resolve the agent's session identifier from stdin. Every agent now
  // gets one — it anchors all downstream discovery (Cursor agent-transcripts
  // dir name, Gemini file basename, Codex thread_id). Per-agent rules:
  //   • claude-code / windsurf: input.session_id (stable per session)
  //   • cursor: input.session_id or input.conversation_id (matches the
  //     agent-transcripts/<id>/ directory name)
  //   • gemini: input.session_id (matches the chats/session-<id>.json file)
  //   • codex: stdin id is unreliable (it's the per-turn thread id, often
  //     rotates), so we resolve threads.id from SQLite by EXACT cwd at the
  //     END of this session-start block (after repoPath is final).
  const agentsWithStableSessionId = ['claude-code', 'windsurf'];
  const hasStableSessionId = agentsWithStableSessionId.includes(agentSlug || '');
  // Cursor prefers `conversation_id` — stable per-chat and matches the
  // `agent-transcripts/<id>/` directory name. Cursor's `session_id`
  // rotates per turn, so picking it as the anchor would force a "new
  // chat" lock on every prompt. Other agents fall through to whichever
  // id stdin provides first.
  const stdinSessionId = agentSlug === 'cursor'
    ? ((typeof input.conversation_id === 'string' && input.conversation_id) ||
       (typeof input.session_id === 'string' && input.session_id) ||
       '')
    : ((typeof input.session_id === 'string' && input.session_id) ||
       (typeof input.conversation_id === 'string' && input.conversation_id) ||
       '');
  // claudeSessionId stays as the legacy field for findSessionByClaudeId
  // and serialized state compat — only populated for agents with truly
  // stable IDs that can be safely used for cross-hook state lookup.
  const claudeSessionId = hasStableSessionId ? (input.session_id || '') : '';
  // agentSessionId is the new authoritative-discovery anchor. Populated
  // for EVERY agent below. Cursor/Gemini get it from stdin; Codex gets it
  // from a SQLite exact-cwd query once repoPath is finalized.
  let agentSessionId: string = claudeSessionId || stdinSessionId || '';
  let transcriptPath = input.transcript_path || '';

  // ── Concurrent session support ─────────────────────────────────────────────
  // Each Claude Code window gets its own tagged state file so multiple sessions
  // on the same repo don't overwrite each other.
  // Generate a stable session tag from this Claude session ID.
  const sessionTag = claudeSessionId
    ? claudeSessionId.slice(0, 12)
    : `s${Date.now().toString(36)}`;
  debugLog('session-start', 'session tag', { sessionTag, claudeSessionId });

  // ── Deduplicate: skip if we already have an active session for this Claude session ──
  if (claudeSessionId) {
    const existing = findSessionByClaudeId(claudeSessionId, repoPath);
    if (existing && existing.sessionId) {
      debugLog('session-start', 'SKIP: session already exists for this Claude session', {
        existingSessionId: existing.sessionId,
        claudeSessionId,
      });
      return;
    }
  }

  // ── Clean up prior sessions for the SAME agent only ──────────────────────
  // NEVER touch sessions from other agents. If agentSlug is unknown, skip cleanup.
  // For Cursor/Codex (per-prompt session-start), skip this — they reuse below.
  const agentsWithPerPromptSessionStart = ['cursor', 'codex'];
  const effectiveSlug = finalAgentSlug || agentSlug || '';
  if (!claudeSessionId && effectiveSlug && !agentsWithPerPromptSessionStart.includes(effectiveSlug)) {
    const sameAgentSessions = listActiveSessions(repoPath).filter(s => sessionMatchesAgent(s, effectiveSlug));
    for (const stale of sameAgentSessions) {
      debugLog('session-start', 'cleaning up prior session for same agent', {
        staleSessionId: stale.sessionId,
        staleTag: stale.sessionTag,
        newAgent: effectiveSlug,
      });
      stopHeartbeat(stale.sessionId);
      if (connected && stale.sessionId) {
        try {
          const durationMs = Date.now() - new Date(stale.startedAt).getTime();
          await api.endSession({
            sessionId: stale.sessionId,
            prompt: stale.prompts.join('\n\n---\n\n') || undefined,
            durationMs: durationMs > 0 ? durationMs : undefined,
            branch: stale.branch || undefined,
          });
        } catch (err: any) {
          debugLog('session-start', 'stale session end failed (non-fatal)', { message: err.message });
        }
      }
      clearSessionState(repoPath, stale.sessionTag);
      if (repoPath !== hookCwd) clearSessionState(hookCwd, stale.sessionTag);
    }
  }

  // For Cursor/Codex: session-start fires on every prompt, so reuse existing session.
  // First, clean up orphaned sessions whose heartbeats died (e.g. Mac sleep).
  const agentsWithSessionReuse = ['cursor', 'codex']; // Reuse active sessions — prevent duplicates from rapid session-start fires
  if (agentsWithPerPromptSessionStart.includes(agentSlug || '')) {
    const allActive = listActiveSessions(repoPath).filter(s => sessionMatchesAgent(s, finalAgentSlug || ''));
    for (const s of allActive) {
      const hbPidFile = path.join(os.homedir(), '.origin', 'heartbeats', `${s.sessionId}.pid`);
      let heartbeatAlive = false;
      try {
        const hbPid = parseInt(fs.readFileSync(hbPidFile, 'utf-8').trim(), 10);
        if (hbPid > 0) { process.kill(hbPid, 0); heartbeatAlive = true; }
      } catch { /* pid file missing or process dead */ }
      // Don't kill sessions whose state file was recently updated — the session
      // is still active even if the heartbeat PID can't be verified (common for
      // Codex/Cursor where heartbeat may not have started yet or died briefly).
      if (!heartbeatAlive) {
        try {
          const stateFilePath = getStatePath(repoPath, s.sessionTag);
          const stat = fs.statSync(stateFilePath);
          const ageMs = Date.now() - stat.mtimeMs;
          if (ageMs < 2 * 60 * 60 * 1000) { // state file updated < 2 hours ago — don't treat as orphan
            heartbeatAlive = true; // treat as alive
            debugLog('session-start', 'session state file still fresh, skipping orphan cleanup', {
              sessionId: s.sessionId, ageMs,
            });
          }
        } catch { /* state file missing — proceed with cleanup */ }
      }
      if (!heartbeatAlive) {
        debugLog('session-start', 'ending orphaned session (heartbeat dead)', {
          sessionId: s.sessionId, tag: s.sessionTag, agent: finalAgentSlug,
        });
        stopHeartbeat(s.sessionId);
        if (connected && s.sessionId) {
          try {
            const durationMs = Date.now() - new Date(s.startedAt).getTime();
            await api.endSession({
              sessionId: s.sessionId,
              prompt: s.prompts.join('\n\n---\n\n') || undefined,
              durationMs: durationMs > 0 ? durationMs : undefined,
              branch: s.branch || undefined,
            });
          } catch {}
        }
        clearSessionState(repoPath, s.sessionTag);
        if (repoPath !== hookCwd) clearSessionState(hookCwd, s.sessionTag);
      }
    }

    // For Cursor/Codex: look for a valid active session to reuse
    let existing: SessionState | null = null;
    if (agentsWithSessionReuse.includes(agentSlug || '')) {
      existing = listActiveSessions(repoPath).find(s => sessionMatchesAgent(s, finalAgentSlug || agentSlug || '')) || null;
      // Also check global archive — the .git/ file might have been cleaned up
      if (!existing) {
        try {
          const archiveDir = path.join(os.homedir(), '.origin', 'sessions');
          const entries = fs.readdirSync(archiveDir).filter(f => f.endsWith('.json'));
          const MAX_AGE_MS = 24 * 60 * 60 * 1000; // 24 hours
          for (const entry of entries) {
            try {
              const s = JSON.parse(fs.readFileSync(path.join(archiveDir, entry), 'utf-8'));
              if (!s?.sessionId || !s?.startedAt) continue;
              if (Date.now() - new Date(s.startedAt).getTime() > MAX_AGE_MS) continue;
              if (s.status === 'ENDED' && s.endedAt) continue;
              if (s.repoPath === repoPath && sessionMatchesAgent(s, finalAgentSlug || agentSlug || '')) {
                existing = s;
                break;
              }
            } catch { /* skip corrupt file */ }
          }
        } catch { /* no archive dir */ }
      }
    }
    if (existing) {
      debugLog('session-start', 'reusing existing session for per-prompt agent', {
        sessionId: existing.sessionId,
        tag: existing.sessionTag,
        agent: finalAgentSlug,
        promptCount: existing.prompts.length,
      });

      // ── Per-prompt diff: capture previous prompt's changes ──
      const currentHead = getHeadSha(repoPath);
      // Capture when HEAD changed (commits) OR when HEAD is same (uncommitted-only changes).
      //
      // Cross-launch safety: if the previous prompt already has a
      // saved mapping (its own Stop hook captured it before the
      // previous Codex window quit), DON'T re-capture here. The
      // recovered prePromptSha can be hours old at this point and
      // any manual commits the user made between launches would
      // otherwise get attributed to that prompt — which is what
      // showed up as "diff for create-a-file-shit.txt includes 4
      // unrelated files" on the dashboard. Skip the retro capture
      // in that case; prePromptSha gets reset below either way.
      const prevPromptIdx = existing.prompts.length - 1;
      const prevAlreadyCaptured = !!(existing.completedPromptMappings || []).find(
        (m: any) => m.promptIndex === prevPromptIdx && (m.diff || m.uncommittedDiff),
      );
      if (existing.prePromptSha && currentHead && existing.prompts.length > 0 && !prevAlreadyCaptured) {
        try {
          const prevCapture = captureGitState(repoPath, existing.prePromptSha, { fullContext: true });
          const prevFilesSet = new Set<string>();
          for (const c of prevCapture.commitDetails) {
            for (const f of c.filesChanged) prevFilesSet.add(f);
          }
          if (prevCapture.diff) {
            for (const m of prevCapture.diff.matchAll(/^diff --git a\/(.*?) b\//gm)) {
              if (m[1]) prevFilesSet.add(m[1]);
            }
          }
          // Filter uncommitted diff against the prompt-baseline + session-start
          // pre-existing dirt union.
          const filteredUncommitted = filterUncommittedDiff(
            prevCapture.uncommittedDiff || '', uncommittedExcludeUnion(existing),
          );
          // Also include uncommitted file paths (filtered)
          if (filteredUncommitted) {
            for (const m of filteredUncommitted.matchAll(/^diff --git a\/(.*?) b\//gm)) {
              if (m[1]) prevFilesSet.add(m[1]);
            }
          }
          const prevFiles = Array.from(prevFilesSet);
          if (prevCapture.diff || filteredUncommitted || prevFiles.length > 0) {
            if (!existing.completedPromptMappings) existing.completedPromptMappings = [];
            const existingIdx = existing.completedPromptMappings.findIndex(m => m.promptIndex === prevPromptIdx);
            // Get current HEAD + working-tree SHA for restore support.
            // getWorkingTreeSha() returns the dirty working-tree's tree
            // when present (Cursor mid-turn case), HEAD's tree otherwise.
            let mappingCommitSha: string | null = null;
            let mappingTreeSha: string | null = null;
            try {
              mappingCommitSha = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repoPath, encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] }).trim();
            } catch { /* ignore */ }
            mappingTreeSha = getWorkingTreeSha(repoPath);
            // Scope committed side to commits this session authored (see
            // sessionScopedCommittedDiff). Same isolation rule as the
            // user-prompt-submit path.
            const reuseSessionCommitted = sessionScopedCommittedDiff(repoPath, existing);
            const reuseDiff = (reuseSessionCommitted +
              (filteredUncommitted ? '\n' + filteredUncommitted : '')).trim();
            const mapping = {
              promptIndex: prevPromptIdx,
              promptText: (existing.prompts[prevPromptIdx] || '').slice(0, 1000),
              filesChanged: prevFiles,
              diff: reuseDiff.slice(0, 200_000),
              uncommittedDiff: filteredUncommitted.slice(0, 200_000),
              commitSha: mappingCommitSha,
              treeSha: mappingTreeSha,
            };
            if (existingIdx >= 0) {
              // Don't clobber a non-empty mapping with an empty diff —
              // STOP from the previous launch already captured it.
              const prevExisting = existing.completedPromptMappings[existingIdx];
              const newHasDiff = !!(mapping.diff || mapping.uncommittedDiff);
              const existingHasDiff = !!(prevExisting.diff || (prevExisting as any).uncommittedDiff);
              if (newHasDiff || !existingHasDiff) {
                existing.completedPromptMappings[existingIdx] = mapping;
              }
            } else {
              existing.completedPromptMappings.push(mapping);
            }
            debugLog('session-start', 'captured per-prompt diff for previous prompt (reuse)', {
              promptIndex: prevPromptIdx, filesChanged: prevFiles.length,
            });
          }
        } catch (err: any) {
          debugLog('session-start', 'per-prompt diff capture failed (non-fatal)', { message: err.message });
        }
      }
      existing.prePromptSha = currentHead;
      existing.prePromptDirtyFiles = getDirtyFiles(repoPath);

      // ── Send accumulated data to API ──
      if (connected && existing.completedPromptMappings && existing.completedPromptMappings.length > 0) {
        try {
          // Session-level filesChanged: full session baseline
          const sessionCapture = captureGitState(repoPath, existing.headShaAtStart, { committedOnly: true });
          const sessionFilesSet = new Set<string>();
          for (const c of sessionCapture.commitDetails) {
            for (const f of c.filesChanged) sessionFilesSet.add(f);
          }
          const sessionFiles = Array.from(sessionFilesSet);
          const durationMs = Date.now() - new Date(existing.startedAt).getTime();
          await api.updateSession(existing.sessionId, {
            filesChanged: sessionFiles.length > 0 ? sessionFiles : undefined,
            durationMs: durationMs > 0 ? durationMs : undefined,
            promptChanges: existing.completedPromptMappings.map(pm => {
              const dl = (pm.diff || '').split('\n');
              return {
                ...pm,
                promptText: (pm.promptText || '').slice(0, 1000),
                diff: (pm.diff || '').slice(0, MAX_PROMPT_DIFF_LEN),
                uncommittedDiff: (pm.uncommittedDiff || '').slice(0, MAX_PROMPT_DIFF_LEN),
                linesAdded: dl.filter((l: string) => l.startsWith('+') && !l.startsWith('+++')).length,
                linesRemoved: dl.filter((l: string) => l.startsWith('-') && !l.startsWith('---')).length,
                aiPercentage: 100,
                checkpointType: 'auto',
                commitSha: (pm as any).commitSha || null,
                treeSha: (pm as any).treeSha || null,
              };
            }),
            status: 'RUNNING',
          });
          debugLog('session-start', 'sent accumulated promptChanges (reuse)', {
            count: existing.completedPromptMappings.length, sessionFiles: sessionFiles.length,
          });
        } catch (err: any) {
          debugLog('session-start', 'accumulated update failed (non-fatal)', { message: err.message });
        }
      }

      // Touch the state file to keep it fresh
      saveSessionState(existing, repoPath, existing.sessionTag);

      // Pre-prompt snapshots removed on purpose. The user-facing rule is
      // "snapshots only for prompts that change code AND get committed",
      // so capturing the pre-prompt working tree (no changes possible yet)
      // produced empty rows the user couldn't act on. The post-commit hook
      // condenses the latest stop-snapshot for each commit, which is the
      // right anchor for "what did this prompt change?"

      // Restart heartbeat to keep session alive between prompts
      const stateFileReuse = getStatePath(repoPath, existing.sessionTag);
      startHeartbeat(existing.sessionId, config?.apiUrl || 'https://getorigin.io', config?.apiKey || '', stateFileReuse, finalAgentSlug);

      // Output system message
      let systemMsg = '';
      // Budget banner FIRST \u2014 a resumed session under a breached cap must
      // open with the warning, same as a fresh one. The flag comes from
      // the persisted state (stamped by session-start / heartbeat pings).
      if (existing.budgetBlocked) {
        systemMsg += buildBudgetBanner(existing.budgetBlockReason || 'Hard budget cap exceeded') + '\n\n';
      }
      if (existing.agentSystemPrompt) systemMsg += existing.agentSystemPrompt + '\n\n';
      systemMsg += 'Origin: Session tracking active \u2014 prompts, files, and tokens will be captured.';
      if (existing.activePolicies && Array.isArray(existing.activePolicies) && existing.activePolicies.length > 0) {
        systemMsg += '\n\nActive policies for this session:\n' +
          existing.activePolicies.map((p: string) => `- ${p}`).join('\n');
      }
      try {
        const attributionCtx = buildAttributionContext(repoPath);
        if (attributionCtx) systemMsg += '\n\n' + attributionCtx;
      } catch {}
      // Framework guidance — same as the fresh-session path. Resumed
      // sessions still benefit from the [Origin: …] marker convention,
      // and re-emitting on resume is harmless (the model will see the
      // same guidance whether or not it saw it earlier).
      systemMsg += '\n\n' + buildOriginFrameworkGuidance();
      const reusePayload = buildContextInjectionPayload(agentSlug, 'SessionStart', systemMsg);
      if (reusePayload) {
        process.stdout.write(reusePayload);
      } else if (agentSlug === 'codex' && existing.budgetBlocked) {
        // Codex shows hook stdout as warnings — surface the banner there.
        process.stdout.write(buildBudgetBanner(existing.budgetBlockReason || 'Hard budget cap exceeded') + '\n');
      }
      // Visible preamble on resume too (parity with Gemini) — see emitVisiblePreamble.
      emitVisiblePreamble(agentSlug, systemMsg);

      // Write rules file for reused sessions too
      try {
        writeAgentRulesFile(finalAgentSlug || '', systemMsg, repoPath);
      } catch {}

      return;
    }
  }

  // Clean up legacy untagged state file if it exists (one-time migration).
  // This prevents old untagged files from confusing concurrent lookups.
  const legacyState = loadSessionState(hookCwd) || loadSessionState(repoPath);
  if (legacyState && !legacyState.sessionTag) {
    debugLog('session-start', 'migrating legacy untagged session', {
      oldSessionId: legacyState.sessionId,
    });
    if (connected) {
      try {
        const durationMs = Date.now() - new Date(legacyState.startedAt).getTime();
        await api.endSession({
          sessionId: legacyState.sessionId,
          prompt: legacyState.prompts.join('\n\n---\n\n') || undefined,
          durationMs: durationMs > 0 ? durationMs : undefined,
          branch: legacyState.branch || undefined,
        });
      } catch (err: any) {
        debugLog('session-start', 'legacy session end failed (non-fatal)', { message: err.message });
      }
    }
    clearSessionState(hookCwd);
    if (repoPath !== hookCwd) clearSessionState(repoPath);
  }

  // Auto-discover Gemini transcript if not provided via stdin. Anchor
  // on stdin session_id when available so we don't pick up a different
  // open Gemini chat whose file just happens to be newer.
  if (!transcriptPath && agentSlug === 'gemini') {
    transcriptPath = discoverGeminiTranscriptPath({
      sessionId: typeof input.session_id === 'string' ? input.session_id : undefined,
    }) || '';
    if (transcriptPath) debugLog('session-start', 'auto-discovered transcript path', { transcriptPath });
  }

  // Resolve model: use stdin value, fall back to Cursor DB, then agent default
  let model = input.model || '';
  if (!model || model === 'unknown' || model === 'default') {
    // Cursor always sends model:"default" — try to read real model from its SQLite DB
    if (agentSlug === 'cursor' && input.conversation_id) {
      const cursorModel = getCursorModelFromDb(input.conversation_id);
      if (cursorModel) {
        model = cursorModel;
        debugLog('session-start', 'model from Cursor DB', { model: cursorModel, conversationId: input.conversation_id });
      } else {
        debugLog('session-start', 'cursor model fallback (DB lookup failed)', { conversationId: input.conversation_id });
      }
    }
    // Gemini's hook stdin never includes `model` (Gemini CLI doesn't
    // expose it), so we'd fall back to the bare "gemini" string and
    // every commit row would display "Gemini" instead of the real
    // model (e.g. "Gemini 2.5 Pro"). Scan the transcript file for the
    // actual model identifier — Gemini writes it on the session
    // metadata line at the top of the chat file and/or on each
    // model-response event.
    if (agentSlug === 'gemini' && transcriptPath) {
      const geminiModel = readGeminiModel(transcriptPath);
      if (geminiModel) {
        model = geminiModel;
        debugLog('session-start', 'model from Gemini transcript', { model: geminiModel, transcriptPath });
      }
    }
  }
  if (!model || model === 'unknown' || model === 'default') {
    const AGENT_DEFAULT_MODELS: Record<string, string> = {
      'gemini': 'gemini',
      'claude-code': 'claude',
      'cursor': 'cursor',
      'windsurf': 'windsurf',
      'codex': 'codex',
      'aider': 'aider',
    };
    model = AGENT_DEFAULT_MODELS[finalAgentSlug || ''] || 'unknown';
  }

  // Extract git remote origin URL for smarter repo matching on the API side
  let repoUrl = '';
  try {
    repoUrl = execFileSync('git', ['remote', 'get-url', 'origin'], { cwd: repoPath, encoding: 'utf-8' as const, stdio: ['pipe', 'pipe', 'pipe'] as ['pipe', 'pipe', 'pipe'] }).trim();
    debugLog('session-start', 'git remote origin url', { repoUrl });
  } catch {
    debugLog('session-start', 'no git remote origin (non-fatal)');
  }

  const branch = getBranch(repoPath) || getBranch(hookCwd);
  debugLog('session-start', 'branch resolved', { branch, repoPath, hookCwd });

  // ── Re-detect tools on every session start ─────────────────────────────────
  try {
    const freshTools = detectTools();
    const oldTools = agentConfig.detectedTools || [];
    const changed = freshTools.length !== oldTools.length ||
      freshTools.some(t => !oldTools.includes(t)) ||
      oldTools.some(t => !freshTools.includes(t));

    if (changed) {
      debugLog('session-start', 'tools changed', { old: oldTools, new: freshTools });
      agentConfig.detectedTools = freshTools;
      agentConfig.lastToolDetection = new Date().toISOString();
      saveAgentConfig(agentConfig);
      // Update server with new tool list (only in connected mode)
      if (connected) {
        try {
          await api.registerMachine({
            hostname: agentConfig.hostname,
            machineId: agentConfig.machineId,
            detectedTools: freshTools,
          });
          debugLog('session-start', 'machine re-registered with updated tools');
        } catch (regErr: any) {
          debugLog('session-start', 'machine re-registration failed (non-fatal)', { message: regErr.message });
        }
      }
    } else {
      debugLog('session-start', 'tools unchanged', { tools: freshTools });
    }
  } catch (detectErr: any) {
    debugLog('session-start', 'tool detection failed (non-fatal)', { message: detectErr.message });
  }

  try {
    let sessionId: string;
    // Set when the server refused session/start with a 429 (hard budget
    // cap). The local fallback session is created anyway but flagged
    // budgetBlocked so every enforcement layer sees the lockout.
    let budgetRefusedReason: string | undefined;
    // Scoped SOFT-cap breach — warn-only (amber banner, no lockout).
    let budgetWarnReason: string | undefined;
    let agentSystemPrompt: string | undefined;
    let activePolicies: string[] | undefined;
    let enforcementRules: any[] | undefined;
    let verboseCapture = false;
    let apiStartedAt: string | undefined;

    if (connected) {
      // ── Connected mode: register session with Origin platform ──
      try {
        debugLog('session-start', 'calling api.startSession', { machineId: agentConfig.machineId, model, repoPath, repoUrl, agentSlug: finalAgentSlug, branch, multiRepo: !!allRepoPaths });
        const result = await api.startSession({
          machineId: agentConfig.machineId,
          prompt: '',
          model,
          repoPath,
          repoUrl: repoUrl || undefined,
          agentSlug: finalAgentSlug,
          branch: branch || undefined,
          hostname: agentConfig.hostname || undefined,
          additionalRepoPaths: allRepoPaths ? allRepoPaths.filter(p => p !== repoPath) : undefined,
          // Use the unified `agentSessionId` (= claudeSessionId || stdinSessionId
          // || cursor conversation_id) rather than `claudeSessionId` alone.
          // For Cursor this is the conversation_id captured from
          // input.conversation_id earlier; without it every new Cursor
          // thread on the same machine+repo collided into whatever prior
          // Cursor session was still RUNNING (user-reported May 27: new
          // Cursor thread reused session 5bd449fb, accumulating 7 prompts
          // across two distinct conversations on the same row).
          agentSessionId: agentSessionId || undefined,
        });
        sessionId = result.sessionId as string;
        agentSystemPrompt = (result.agentSystemPrompt as string) || undefined;
        activePolicies = result.activePolicies && Array.isArray(result.activePolicies) ? result.activePolicies : undefined;
        enforcementRules = result.enforcementRules && Array.isArray(result.enforcementRules) ? result.enforcementRules : undefined;
        verboseCapture = result.verboseCapture === true;
        // Use server startedAt if returned (deduped sessions preserve original start time)
        if (result.startedAt) {
          apiStartedAt = result.startedAt as string;
        }
        // Over-budget sessions are TRACKED with a warning, not refused —
        // the server creates the row (badged on the dashboard) and ships
        // the breach here so client-side gates lock work from prompt #1.
        const startBudget = (result as any).budget;
        if (startBudget?.blocked) {
          budgetRefusedReason = startBudget.message || 'Budget limit exceeded';
          process.stderr.write(
            `[origin] Budget limit reached — ${budgetRefusedReason}. This session is tracked but ` +
            `new AI work (including commits) is locked until the cap resets or an admin raises it.\n`,
          );
        } else if (startBudget?.warning) {
          // Scoped SOFT cap exceeded (this developer's user/agent/repo
          // limit). Purely informational: amber banner on the initial
          // screen + a desktop notification — nothing is locked.
          budgetWarnReason = startBudget.message || 'Soft budget cap exceeded';
          process.stderr.write(`[origin] Budget warning — ${budgetWarnReason}.\n`);
          sendDesktopNotification(
            'Origin — budget warning',
            `${budgetWarnReason}. Work continues (soft limit) — mind the spend.`,
          );
        }
        debugLog('session-start', 'api returned', { sessionId, deduped: !!result.startedAt, verboseCapture, budgetBlocked: !!startBudget?.blocked, budgetWarning: !!startBudget?.warning });
      } catch (apiErr: any) {
        // API failed — fall back to local session instead of aborting entirely.
        // AGENT_DISABLED is the expected response when an admin hasn't
        // toggled the agent on yet; in that case the platform also fired
        // notifications to the developer + admins, so the CLI just needs to
        // explain why the session stayed local.
        if (apiErr?.code === 'AGENT_DISABLED') {
          const agentName = apiErr?.body?.agent?.name || finalAgentSlug || 'this agent';
          debugLog('session-start', 'agent disabled, keeping session local', { agentName });
          process.stderr.write(`[origin] ${agentName} is disabled in your org — session kept local. An admin has been notified to enable it.\n`);
        } else if (apiErr?.status === 429) {
          // Hard budget cap refused the session. The fallback below still
          // creates a LOCAL session — that's deliberate (tracking should
          // degrade, not vanish) — but it must carry the lockout, or
          // agents whose hook protocols can't block (Codex, Cursor) sail
          // on with nothing in their way: user-reported, codex edited and
          // committed while all three hard caps sat at 110%. The flag
          // below feeds the prompt/tool gates AND the git pre-commit
          // gate, which blocks the commit for every agent.
          budgetRefusedReason = apiErr?.message || 'Budget limit exceeded';
          debugLog('session-start', 'budget 429 — local session will carry the lockout', { reason: budgetRefusedReason });
          process.stderr.write(
            `[origin] Session blocked — budget limit reached. ${budgetRefusedReason} ` +
            `New AI work (including commits) is locked until the cap resets or an admin raises it.\n`,
          );
        } else {
          debugLog('session-start', 'API failed, falling back to local', { message: apiErr.message });
          process.stderr.write(`[origin] API error (falling back to local): ${apiErr.message}\n`);
        }
        sessionId = `local-${crypto.randomUUID()}`;
      }
    } else {
      // ── Standalone mode: generate local session ID ──
      sessionId = `local-${crypto.randomUUID()}`;
      debugLog('session-start', 'standalone session', { sessionId });
    }

    // Look up the most recent session in this repo so we can record a
    // previousSessionId pointer in this session's git notes. Lets future
    // agents walk the chain of sessions across commits. We also stash the
    // prior session's startedAt so the acceptance backfill at session-end
    // can scope its commit scan instead of reading notes on every recent
    // commit in the repo.
    let previousSessionId: string | undefined;
    let previousSessionStartedAt: string | undefined;
    try {
      const recent = readRecentMemory(repoPath, 1);
      if (recent.length > 0 && recent[0].sessionId && recent[0].sessionId !== sessionId) {
        previousSessionId = recent[0].sessionId;
        previousSessionStartedAt = recent[0].startedAt;
      }
    } catch { /* non-fatal */ }

    // If the working tree is dirty at session-start, create a shadow commit
    // capturing that state. Using the shadow as `prePromptSha` (instead of
    // HEAD) means per-prompt `workingTreeDiff(prePromptSha → working tree)`
    // correctly EXCLUDES the pre-existing dirty content from prompt 1's
    // attribution — only edits the agent makes AFTER session-start show up
    // as added lines for prompt 1. Without this, the user-prompt-submit
    // retroactive capture for prompt 1 conflates pre-existing dirty edits
    // with the agent's actual prompt-1 work and attributes them all to P1.
    const sessionStartHead = getHeadSha(repoPath);
    const sessionStartDirty = getDirtyFiles(repoPath);
    let initialPrePromptSha = sessionStartHead;
    let initialPrePromptDirtyFiles = sessionStartDirty;
    // SHA of the dirty-tree snapshot taken at session start (full working
    // tree, tracked + untracked). The heartbeat diffs against this to keep
    // pre-existing dirt from being attributed to the session's prompts.
    let sessionStartShadowSha: string | null = null;
    if (sessionStartDirty.length > 0) {
      try {
        const startShadowTag = sessionTag || sessionId.slice(0, 12);
        const startShadow = createShadowCommit(repoPath, `start-${startShadowTag}`);
        if (startShadow) {
          initialPrePromptSha = startShadow;
          sessionStartShadowSha = startShadow;
          initialPrePromptDirtyFiles = [];
          debugLog('session-start', 'created session-start shadow', {
            shadow: startShadow.slice(0, 12),
            dirtyCount: sessionStartDirty.length,
          });
        }
      } catch (err: unknown) {
        debugLog('session-start', 'shadow creation failed (non-fatal)', {
          message: err instanceof Error ? err.message : String(err),
        });
      }
    }

    // For Codex, the stdin session_id is per-turn and rotates — useless as
    // an anchor. Query SQLite for the thread whose cwd EXACTLY matches the
    // session repoPath and use that thread.id. If we can't resolve one,
    // leave agentSessionId empty — downstream discovery will then bail
    // (returns null) rather than guess across threads.
    if (agentSlug === 'codex' && !agentSessionId) {
      try {
        const codexDir = path.join(os.homedir(), '.codex');
        const stateFiles = fs.existsSync(codexDir)
          ? fs.readdirSync(codexDir)
              .filter(f => f.startsWith('state_') && f.endsWith('.sqlite'))
              .map(f => ({ path: path.join(codexDir, f), mtime: fs.statSync(path.join(codexDir, f)).mtimeMs }))
              .sort((a, b) => b.mtime - a.mtime)
          : [];
        if (stateFiles.length > 0) {
          const exactCwd = repoPath.replace(/'/g, "''");
          const out = execFileSync('sqlite3', [
            stateFiles[0].path,
            `SELECT id FROM threads WHERE cwd = '${exactCwd}' ORDER BY updated_at DESC LIMIT 1;`,
          ], {
            encoding: 'utf-8' as const, timeout: 3000,
            stdio: ['pipe', 'pipe', 'pipe'] as ['pipe', 'pipe', 'pipe'],
          }).trim();
          if (out) {
            agentSessionId = out;
            debugLog('session-start', 'codex thread_id resolved from sqlite', {
              threadId: out.slice(0, 12), repoPath,
            });
          } else {
            debugLog('session-start', 'codex thread_id not found for repo — will rely on stdin per-hook', { repoPath });
          }
        }
      } catch (codexErr: unknown) {
        debugLog('session-start', 'codex thread_id resolve failed (non-fatal)', {
          message: codexErr instanceof Error ? codexErr.message : String(codexErr),
        });
      }
    }

    const state: SessionState = {
      sessionId,
      claudeSessionId,
      agentSessionId: agentSessionId || undefined,
      transcriptPath,
      model,
      startedAt: apiStartedAt || new Date().toISOString(),
      prompts: [],
      repoPath,
      lastCwd: hookCwd,
      headShaAtStart: sessionStartHead,
      sessionStartShadowSha,
      headShaAtLastStop: null,
      prePromptSha: initialPrePromptSha,
      prePromptDirtyFiles: initialPrePromptDirtyFiles,
      // Preserve the original dirty-at-start list separately. The per-prompt
      // tracking (prePromptDirtyFiles) gets reset on every prompt boundary
      // and zeroed by shadow creation, but we still need the start-time
      // snapshot at session-end to keep pre-existing pollution from another
      // agent's leftover working-tree edits out of THIS session's sessionDiff.
      sessionStartDirtyFiles: sessionStartDirty,
      branch,
      sessionTag,
      agentSlug: finalAgentSlug || agentSlug,
      agentSystemPrompt,
      activePolicies,
      enforcementRules,
      verboseCapture,
      previousSessionId,
      previousSessionStartedAt,
    };

    // Hard budget cap breached at start (server-reported budget payload,
    // or a legacy 429 refusal) — the session still tracks, but flagged
    // blocked so the prompt/tool gates (Claude Code / Gemini) and the git
    // pre-commit gate (every agent, incl. Codex/Cursor whose hooks can't
    // block) all enforce the lockout. The AGENTS.md notice is the
    // model-facing layer: Codex/Cursor read it natively and stop working
    // on their own instead of failing mysteriously at commit time.
    if (budgetRefusedReason) {
      state.budgetBlocked = true;
      state.budgetBlockReason = budgetRefusedReason;
      writeBudgetLockNotice(repoPath, budgetRefusedReason);
    } else {
      // Not breached — clear any notice left by a previous lockout so a
      // lifted cap doesn't keep scaring agents in this repo.
      clearBudgetLockNotice(repoPath);
    }

    // Multi-repo: store all repo paths and per-repo git state
    if (allRepoPaths && allRepoPaths.length > 1) {
      state.repoPaths = allRepoPaths;
      state.perRepoState = {};
      for (const rp of allRepoPaths) {
        state.perRepoState[rp] = {
          headShaAtStart: getHeadSha(rp),
          headShaAtLastStop: null,
          prePromptSha: getHeadSha(rp),
          prePromptDirtyFiles: getDirtyFiles(rp),
          branch: getBranch(rp),
        };
      }
      debugLog('session-start', 'multi-repo state initialized', {
        repoPaths: allRepoPaths,
        perRepoState: Object.fromEntries(
          Object.entries(state.perRepoState).map(([k, v]) => [path.basename(k), { head: v.headShaAtStart?.slice(0, 8), branch: v.branch }])
        ),
      });
    }

    // Save to tagged file — each concurrent session gets its own state file
    // For multi-repo sessions, save to hookCwd (parent dir) since it's not a git repo
    const saveCwd = allRepoPaths ? hookCwd : repoPath;
    saveSessionState(state, saveCwd, sessionTag);
    debugLog('session-start', 'state saved', { sessionId, sessionTag });

    // Trail auto-attach is now server-side (session/end matches the session
    // to repo-scoped Feature Trails by repo + branch) — the CLI no longer
    // maintains a parallel per-repo git-ref trail store. The Origin dashboard
    // is the single source of truth for trails.

    // Start background heartbeat daemon (both connected and standalone mode)
    // In standalone: heartbeat detects parent process death + state file staleness → auto-ends session
    {
      const stateFile = getStatePath(saveCwd, sessionTag);
      const hbApiUrl = (connected && config) ? (config.apiUrl || 'https://getorigin.io') : '';
      const hbApiKey = (connected && config) ? config.apiKey : '';
      startHeartbeat(sessionId, hbApiUrl, hbApiKey, stateFile, finalAgentSlug);
      debugLog('session-start', 'heartbeat started', { sessionId, stateFile, agentSlug: finalAgentSlug, standalone: !connected });
    }

    // Build system message: agent system prompt first, then tracking notice + policies + attribution
    let systemMsg = '';
    // Budget banner goes FIRST \u2014 a breached hard cap must be the very
    // first thing on the agent's initial screen, before any prompt or
    // tracking notice. Scoped soft-cap breaches get the amber warn-only
    // variant instead.
    if (budgetRefusedReason) {
      systemMsg += buildBudgetBanner(budgetRefusedReason) + '\n\n';
    } else if (budgetWarnReason) {
      systemMsg += buildBudgetWarningBanner(budgetWarnReason) + '\n\n';
    }
    if (agentSystemPrompt) {
      systemMsg += agentSystemPrompt + '\n\n';
    }
    systemMsg += 'Origin: Session tracking active \u2014 prompts, files, and tokens will be captured.';
    if (!connected) {
      systemMsg += ' (standalone mode)';
    }
    if (activePolicies && Array.isArray(activePolicies) && activePolicies.length > 0) {
      systemMsg += '\n\nActive policies for this session:\n' +
        activePolicies.map((p: string) => `- ${p}`).join('\n');
    }

    // Inject AI attribution context so the agent knows what other agents have done
    try {
      const attributionCtx = buildAttributionContext(repoPath);
      if (attributionCtx) {
        systemMsg += '\n\n' + attributionCtx;
        debugLog('session-start', 'attribution context injected', { length: attributionCtx.length });
      }
    } catch {
      // Non-fatal — skip attribution context if it fails
    }

    // Inject cross-agent handoff context (from previous session, possibly different agent)
    try {
      const handoffCtx = buildHandoffContext(repoPath);
      if (handoffCtx) {
        systemMsg += '\n\n' + handoffCtx;
        debugLog('session-start', 'handoff context injected', { length: handoffCtx.length });
      }
    } catch {
      // Non-fatal
    }

    // Inject session memory (last 3 session summaries for this repo)
    try {
      const memoryCtx = buildMemoryContext(repoPath);
      if (memoryCtx) {
        systemMsg += '\n\n' + memoryCtx;
        debugLog('session-start', 'memory context injected', { length: memoryCtx.length });
      }
    } catch {
      // Non-fatal
    }

    // Inject the Origin authoring framework — short prompt telling the
    // agent to emit structured `[Origin: …]` markers as it works so the
    // post-PR reviewer can scan intent / decisions / open questions /
    // verification steps without round-tripping through synthesis. Path
    // A of "GitHub for agents" (server-side synthesis is the Path B
    // fallback on existing PR detail; agent-emitted text takes
    // precedence when present). Goes LAST so it's the most recent
    // thing the agent reads — models tend to weight tail context more.
    systemMsg += '\n\n' + buildOriginFrameworkGuidance();
    debugLog('session-start', 'framework guidance injected');

    // Deliver the context through each agent's correct channel (see
    // buildContextInjectionPayload). Codex gets null here — it reads from
    // AGENTS.md — but we still surface the budget banner in its warning
    // area: "your cap is breached" belongs on the initial screen.
    const payload = buildContextInjectionPayload(agentSlug, 'SessionStart', systemMsg);
    if (payload) {
      process.stdout.write(payload);
    } else if (agentSlug === 'codex' && budgetRefusedReason) {
      process.stdout.write(buildBudgetBanner(budgetRefusedReason) + '\n');
    } else if (agentSlug === 'codex' && budgetWarnReason) {
      process.stdout.write(buildBudgetWarningBanner(budgetWarnReason) + '\n');
    }
    // Make the preamble VISIBLE for the agents that don't render stdout as a
    // banner (everyone but Gemini) — see emitVisiblePreamble.
    emitVisiblePreamble(agentSlug, systemMsg);
    debugLog('session-start', 'system prompt injected', { agent: agentSlug, length: systemMsg.length, budgetBanner: !!budgetRefusedReason, budgetWarnBanner: !!budgetWarnReason });

    // Write rules files so agents natively see Origin policies
    if (systemMsg) {
      try {
        writeAgentRulesFile(finalAgentSlug || '', systemMsg, repoPath);
      } catch {
        // Non-fatal
      }
    }
  } catch (err: any) {
    debugLog('session-start', 'ERROR', { message: err.message, stack: err.stack });
    const status = err.status || 0;
    if (status === 401) {
      process.stderr.write(`[origin] Session blocked — invalid or expired API key. Run \`origin login\` to re-authenticate.\n`);
    } else if (status === 403) {
      process.stderr.write(`[origin] Session blocked — ${err.message}\n`);
    } else if (status === 429) {
      process.stderr.write(`[origin] Session blocked — budget limit reached. ${err.message}\n`);
      // The refusal must leave a LOCAL trace. Codex/Cursor ignore hook
      // exit-2 blocking and don't reliably fire user-prompt-submit (whose
      // own 429 fallback would persist the lockout) — so without a state
      // file carrying budgetBlocked here, the agent kept editing and
      // committing past a breached hard cap with nothing in its way
      // (user-reported: codex committed while all three caps sat at
      // 110%). Persist a minimal local-only session flagged blocked so
      // the git pre-commit gate — which git enforces for EVERY agent —
      // has something to read.
      try {
        const scHookCwd = input.cwd || process.cwd();
        const scRepoPath = discoverGitRoot(scHookCwd) || getGitRoot(scHookCwd) || '';
        if (scRepoPath) {
          const fbId = `local-${crypto.randomUUID()}`;
          const fbTag = (input.session_id || '').slice(0, 12) || `s${Date.now().toString(36)}`;
          const fbState: SessionState = {
            sessionId: fbId,
            claudeSessionId: input.session_id || fbId,
            agentSessionId: input.session_id || undefined,
            transcriptPath: input.transcript_path || '',
            model: input.model || agentSlug || 'unknown',
            startedAt: new Date().toISOString(),
            prompts: [],
            repoPath: scRepoPath,
            lastCwd: scHookCwd,
            headShaAtStart: getHeadSha(scHookCwd),
            headShaAtLastStop: null,
            prePromptSha: getHeadSha(scHookCwd),
            branch: getBranch(scHookCwd),
            sessionTag: fbTag,
            agentSlug,
            budgetBlocked: true,
            budgetBlockReason: err?.message || 'Budget limit exceeded',
          };
          saveSessionState(fbState, scRepoPath, fbTag);
          writeBudgetLockNotice(scRepoPath, fbState.budgetBlockReason || 'Budget limit exceeded');
          debugLog('session-start', '429 — persisted local blocked state for the git-hook budget gate', {
            sessionTag: fbTag, repoPath: scRepoPath,
          });
        }
      } catch { /* stderr warning above already delivered */ }
    } else if (err.message?.includes('Unknown agent') || err.message?.includes('not registered')) {
      process.stderr.write(`[origin] Agent not registered. Ask your admin to add it in the Origin dashboard.\n`);
    } else {
      process.stderr.write(`[origin] session-start error: ${err.message}\n`);
    }
  }
}

// ─── Budget Lockout (layer-1 hard-cap enforcement) ─────────────────────────
//
// When the org breaches a hard (block:true) budget cap, the server reports
// it on session PATCH responses and heartbeat pings; the flag is persisted
// in session state. These helpers turn it into hook decisions: user-prompt-
// submit blocks new prompts and pre-tool-use blocks tool calls via exit 2
// (honored by Claude Code and Gemini CLI). Cursor/Codex hook protocols
// don't honor blocking exits, so they get a stderr warning — their commits
// are still gated by the policy pre-commit hook, and new sessions are
// refused server-side. Client-side enforcement is a guardrail, not a
// security boundary; ORIGIN_BUDGET_OVERRIDE=1 bypasses for emergencies.

// BUDGET_BLOCKING_AGENTS (agents whose hook protocol honors exit-2
// blocking) now lives in budget-breach.ts — shared with the heartbeat,
// which keeps non-blockable agents' sessions ALIVE on a breach so their
// continued burn stays tracked.

/** Pure decision: block, warn, or pass. Exported for tests. */
export function budgetLockoutDecision(opts: {
  budgetBlocked?: boolean;
  budgetBlockReason?: string;
  agentSlug?: string;
  overrideEnv?: string;
}): { block: boolean; warn: boolean; reason: string } {
  if (!opts.budgetBlocked) return { block: false, warn: false, reason: '' };
  const reason =
    `[Origin Budget] ${opts.budgetBlockReason || 'Hard budget cap exceeded'} — ` +
    `new AI work is blocked until the cap resets or an admin raises it. ` +
    `Emergency override: export ORIGIN_BUDGET_OVERRIDE=1`;
  if (opts.overrideEnv === '1') return { block: false, warn: true, reason };
  const slug = (opts.agentSlug || 'claude-code').toLowerCase();
  const canBlock = BUDGET_BLOCKING_AGENTS.has(slug);
  return { block: canBlock, warn: !canBlock, reason };
}

/** Persist the budget signal carried on a session PATCH response. */
function applyBudgetSignal(state: SessionState, apiResponse: unknown, saveCwd: string): void {
  const budget = (apiResponse as any)?.budget;
  if (!budget || typeof budget !== 'object') return;
  const blocked = !!budget.blocked;
  const reason = typeof budget.message === 'string' ? budget.message : undefined;
  if (!!state.budgetBlocked === blocked && state.budgetBlockReason === (blocked ? reason : undefined)) return;
  state.budgetBlocked = blocked;
  state.budgetBlockReason = blocked ? reason : undefined;
  if (!blocked) state.budgetBlockReported = undefined; // next episode reports again
  try { saveSessionState(state, saveCwd, state.sessionTag); } catch { /* non-fatal */ }
  debugLog('budget', blocked ? 'budget lockout SET' : 'budget lockout cleared', { reason });
}

/**
 * Hook-time gate. Re-checks the server while locked out (so the block
 * lifts the moment the period resets or an admin raises the cap — only
 * runs in the blocked state, so no steady-state API load), then blocks
 * or warns per the agent's capabilities. On re-check failure we keep
 * blocking: the last confirmed server state was "blocked", and the
 * override env is the documented escape hatch.
 */
async function enforceBudgetLockout(
  state: SessionState,
  agentSlug: string | undefined,
  saveCwd: string,
  hookName: string,
): Promise<void> {
  if (!state.budgetBlocked) return;
  if (isConnectedMode()) {
    try {
      const status = await api.getBudgetStatus(
        state.sessionId && !state.sessionId.startsWith('local-') ? state.sessionId : undefined,
      );
      if (!status.blocked) {
        state.budgetBlocked = false;
        state.budgetBlockReason = undefined;
        state.budgetBlockReported = undefined;
        try { saveSessionState(state, saveCwd, state.sessionTag); } catch { /* non-fatal */ }
        debugLog(hookName, 'budget lockout lifted by server re-check');
        return;
      }
      if (status.message) state.budgetBlockReason = status.message;
    } catch { /* keep blocking on re-check failure */ }
  }
  const decision = budgetLockoutDecision({
    budgetBlocked: state.budgetBlocked,
    budgetBlockReason: state.budgetBlockReason,
    agentSlug: agentSlug || state.agentSlug,
    overrideEnv: process.env.ORIGIN_BUDGET_OVERRIDE,
  });
  // Audit the lockout — once per episode, not per blocked call (a single
  // breach can block dozens of tool calls in one turn; one audit row +
  // admin notification carries the signal without the spam). The flag
  // clears with the lockout, so the next episode reports again.
  if ((decision.block || decision.warn) && !state.budgetBlockReported && isConnectedMode()) {
    try {
      const agentCfg = loadConfig();
      await api.reportViolation({
        machineId: agentCfg?.machineId || 'unknown',
        policyType: 'BUDGET_CAP',
        policyName: 'Hard budget cap',
        description: `[${hookName}] ${state.budgetBlockReason || 'Hard budget cap exceeded'} — ${decision.block ? 'blocked' : 'warned (agent cannot block)'}`,
        sessionId: state.sessionId && !state.sessionId.startsWith('local-') ? state.sessionId : undefined,
      });
      state.budgetBlockReported = true;
      try { saveSessionState(state, saveCwd, state.sessionTag); } catch { /* non-fatal */ }
    } catch { /* never block the block on reporting */ }
  }
  if (decision.block) {
    debugLog(hookName, 'BLOCKED by budget lockout', { reason: decision.reason });
    process.stderr.write(decision.reason + '\n');
    process.exit(2);
  }
  if (decision.warn) {
    debugLog(hookName, 'budget lockout warning (agent cannot block)', { reason: decision.reason });
    process.stderr.write(decision.reason + '\n');
  }
}

// ─── SESSION_LIMITS max-duration gate ───────────────────────────────────────
//
// Counterpart to the heartbeat's timer-side checks (see session-limits.ts
// for the full policy contract). Called from user-prompt-submit only:
// blocking at prompt boundaries forces the restart without ever cutting an
// in-flight turn. Same agent-capability gating as the budget lockout —
// exit 2 is honored by Claude Code and Gemini; other agents get a stderr
// warning and rely on the heartbeat notifications.
function enforceSessionDurationLimit(
  state: SessionState,
  agentSlug: string | undefined,
  hookName: string,
): void {
  const cfg = parseSessionLimits(state.enforcementRules);
  if (!cfg?.enforce || cfg.maxDurationMinutes === undefined || !state.startedAt) return;
  const ageMinutes = (Date.now() - new Date(state.startedAt).getTime()) / 60_000;
  if (!isFinite(ageMinutes) || ageMinutes < cfg.maxDurationMinutes) return;

  const message = buildDurationBlockMessage(cfg.maxDurationMinutes, ageMinutes);
  const slug = (agentSlug || state.agentSlug || 'claude-code').toLowerCase();
  if (BUDGET_BLOCKING_AGENTS.has(slug)) {
    debugLog(hookName, 'BLOCKED by SESSION_LIMITS max duration', {
      ageMinutes: Math.round(ageMinutes),
      maxDurationMinutes: cfg.maxDurationMinutes,
      sessionId: state.sessionId,
    });
    process.stderr.write(message + '\n');
    process.exit(2);
  }
  debugLog(hookName, 'SESSION_LIMITS max duration exceeded (agent cannot block)', {
    ageMinutes: Math.round(ageMinutes),
    maxDurationMinutes: cfg.maxDurationMinutes,
  });
  process.stderr.write(message + '\n');
}

// Self-heal a session that started in local-only mode. When the
// session-start API call can't reach/authenticate the server, start falls
// back to a `local-` sessionId and the session lives only on disk — it
// never appears in Origin until something re-registers it. Previously that
// only happened in the stop handler, so a session whose stop never ran
// cleanly (crash, end-before-stop, still-offline-at-stop) stayed invisible
// forever. This re-registers on the server and persists the real id back to
// state. Idempotent: no-op for server-id sessions, when disconnected, or
// when the call fails again (stays local, retried on the next hook).
// Returns true when a migration succeeded this call.
export async function ensureServerSession(
  state: SessionState,
  saveCwd: string,
  agentSlug: string | undefined,
  scope: string,
): Promise<boolean> {
  if (!isConnectedMode()) return false;
  if (!state.sessionId || !state.sessionId.startsWith('local-')) return false;
  try {
    const agentConfig = loadAgentConfig();
    if (!agentConfig?.machineId) return false;
    debugLog(scope, 'migrating local session to server', { local: state.sessionId });
    const startRes = await api.startSession({
      machineId: agentConfig.machineId,
      prompt: (state.prompts && state.prompts[0]) || '',
      model: isSpecificModel(state.model) ? state.model : 'claude',
      repoPath: state.repoPath || saveCwd,
      agentSlug,
      branch: state.branch || undefined,
      agentSessionId: (state as any).agentSessionId || state.claudeSessionId,
    } as any);
    const newId = (startRes as any)?.sessionId;
    if (typeof newId === 'string' && newId && !newId.startsWith('local-')) {
      debugLog(scope, 'local session migrated', { from: state.sessionId, to: newId });
      state.sessionId = newId;
      try { saveSessionState(state, saveCwd, state.sessionTag); } catch { /* non-fatal */ }
      return true;
    }
  } catch (err: any) {
    debugLog(scope, 'local→server migration failed (non-fatal)', { message: err?.message });
  }
  return false;
}

async function handleUserPromptSubmit(input: Record<string, any>, agentSlug?: string): Promise<void> {
  debugLog('user-prompt-submit', 'begin', { hasPrompt: !!input.prompt, cwd: input.cwd, workspace_roots: input.workspace_roots });

  let hookCwd = input.cwd || process.cwd();
  // Cursor sends workspace_roots instead of cwd
  if (input.workspace_roots && Array.isArray(input.workspace_roots) && input.workspace_roots.length > 0) {
    const wsRoot = input.workspace_roots[0];
    debugLog('user-prompt-submit', 'workspace_roots check', { wsRoot, isString: typeof wsRoot === 'string', gitRoot: typeof wsRoot === 'string' ? getGitRoot(wsRoot) : null });
    if (typeof wsRoot === 'string' && getGitRoot(wsRoot)) {
      hookCwd = wsRoot;
    }
  }
  debugLog('user-prompt-submit', 'cwd resolved', { hookCwd });

  // ── Find session state using concurrent-aware lookup ────────────────────────
  // For agents with unstable session_id (Cursor, Codex), don't use it for lookup
  const stableAgents = STABLE_SESSION_ID_AGENTS;
  const lookupSessionId = hookLookupSessionId(input.session_id, agentSlug);
  const found = findStateForHook(hookCwd, lookupSessionId, agentSlug);
  let state = found?.state || null;

  if (state) {
    // Update Claude session ID and transcript path if they changed
    // (agent subprocesses may have different session_id)
    const incomingSessionId = input.session_id || '';
    if (incomingSessionId && stableAgents.includes(agentSlug || '') && state.claudeSessionId !== incomingSessionId) {
      debugLog('user-prompt-submit', 'updating claudeSessionId', {
        old: state.claudeSessionId,
        new: incomingSessionId,
        originSession: state.sessionId,
        tag: state.sessionTag,
      });
      state.claudeSessionId = incomingSessionId;
    }
    // Cursor specifically: `conversation_id` is the stable per-chat id
    // (matches `agent-transcripts/<id>/` and persists across the
    // chat's prompts). `session_id` rotates per turn. When the user
    // opens a NEW chat in the same workspace, the workspace-scoped
    // findStateForHook would otherwise attach this prompt to the OLD
    // chat's session — mixing prompts and orphaning the new chat's
    // capture. Detach when locked agentSessionId disagrees with the
    // incoming conversation_id, forcing the auto-create branch below
    // to spin up a fresh Origin session for the new chat.
    //
    // Codex is NOT detached here — its stdin rotates per turn.
    if (agentSlug === 'cursor') {
      const incomingChatId =
        (typeof input.conversation_id === 'string' && input.conversation_id) ||
        (typeof input.session_id === 'string' && input.session_id) ||
        '';
      if (incomingChatId) {
        if (!state.agentSessionId) {
          state.agentSessionId = incomingChatId;
        } else if (state.agentSessionId !== incomingChatId) {
          debugLog('user-prompt-submit', 'cursor: new chat id — detaching from prior state', {
            locked: state.agentSessionId,
            incoming: incomingChatId,
            priorOriginSession: state.sessionId,
          });
          state = null;
        }
      }
    } else if (agentSlug === 'gemini') {
      // Gemini: each chat has its own transcript JSON at
      // `~/.gemini/...chats/session-<id>.json` and Gemini's stdin
      // sends transcript_path on every hook. When the user opens a
      // NEW chat in the same workspace, the workspace-scoped
      // findStateForHook returns the OLD Gemini session's state and
      // we'd silently append the new chat's prompt to it.
      // Detach when stdin's transcript_path doesn't match state's,
      // forcing the auto-create branch to start a fresh Origin
      // session for the new chat. transcript_path is the most
      // reliable signal here — Gemini's session_id field is
      // inconsistent across CLI versions but the transcript file
      // is always per-chat.
      const incomingTranscriptPath = typeof input.transcript_path === 'string' ? input.transcript_path : '';
      if (incomingTranscriptPath) {
        if (!state.transcriptPath) {
          state.transcriptPath = incomingTranscriptPath;
        } else if (state.transcriptPath !== incomingTranscriptPath) {
          debugLog('user-prompt-submit', 'gemini: new transcript_path — detaching from prior state', {
            locked: state.transcriptPath,
            incoming: incomingTranscriptPath,
            priorOriginSession: state.sessionId,
          });
          state = null;
        }
      }
    } else {
      // Other agents: just record stdin id when state has none (useful
      // for downstream discovery hooks that anchor on it).
      const stdinAgentId =
        (typeof input.session_id === 'string' && input.session_id) ||
        (typeof input.conversation_id === 'string' && input.conversation_id) ||
        '';
      if (state && !state.agentSessionId && stdinAgentId) {
        state.agentSessionId = stdinAgentId;
      }
    }
    if (state) {
      if (input.transcript_path) state.transcriptPath = input.transcript_path;
      saveSessionState(state, found!.saveCwd, state.sessionTag);
      // Self-heal a local-only session here too — every prompt is a retry
      // point, so a transient server outage at start no longer hides the
      // whole session from Origin until (or unless) stop runs.
      await ensureServerSession(state, found!.saveCwd, agentSlug, 'user-prompt-submit');
    }
  }
  if (!state) {
    // Before auto-creating, try to recover from archive (session state file may have been
    // deleted by a stale cleanup or heartbeat, but the archive still has the session).
    // Only for agents that REUSE sessions (Cursor). For Codex and others that create
    // new sessions per conversation, recovering old sessions causes stale headShaAtStart
    // which makes diffs show old changes.
    const agentsWithArchiveRecovery = ['cursor'];
    if (agentsWithArchiveRecovery.includes(agentSlug || '')) {
      try {
        const recoveryRepoPath = discoverGitRoot(hookCwd) || hookCwd;
        const archiveDir = path.join(os.homedir(), '.origin', 'sessions');
        const archiveEntries = fs.readdirSync(archiveDir).filter(f => f.endsWith('.json'));
        const MAX_RECOVERY_AGE_MS = 24 * 60 * 60 * 1000;
        let bestCandidate: SessionState | null = null;
        let bestAge = Infinity;
        for (const entry of archiveEntries) {
          try {
            const s = JSON.parse(fs.readFileSync(path.join(archiveDir, entry), 'utf-8'));
            if (!s?.sessionId || !s?.startedAt) continue;
            const age = Date.now() - new Date(s.startedAt).getTime();
            if (age > MAX_RECOVERY_AGE_MS) continue;
            if (s.status === 'ENDED' && s.endedAt) continue;
            if (s.repoPath !== recoveryRepoPath) continue;
            if (agentSlug && !sessionMatchesAgent(s, agentSlug)) continue;
            if (age < bestAge) {
              bestCandidate = s;
              bestAge = age;
            }
          } catch { /* skip */ }
        }
        if (bestCandidate) {
          debugLog('user-prompt-submit', 'recovered session from archive', {
            sessionId: bestCandidate.sessionId,
            tag: bestCandidate.sessionTag,
            ageMin: Math.round(bestAge / 60000),
          });
          // Restore the .git state file so subsequent hooks can find it
          saveSessionState(bestCandidate, recoveryRepoPath, bestCandidate.sessionTag);
          state = bestCandidate;
        }
      } catch { /* no archive dir — fall through to auto-create */ }
    }
  }
  if (!state) {
    // No existing session at all — auto-create one (first prompt without SessionStart)
    debugLog('user-prompt-submit', 'no session state — attempting auto-create', { hookCwd });
    const autoConfig = loadConfig();
    let autoAgentConfig = loadAgentConfig();
    const repoPath = discoverGitRoot(hookCwd);
    if (repoPath) {
      try {
        // Auto-create agent config in standalone mode
        if (!autoAgentConfig) {
          autoAgentConfig = {
            machineId: crypto.randomUUID(),
            hostname: os.hostname(),
            detectedTools: detectTools(),
            orgId: 'local',
          };
          ensureConfigDir();
          saveAgentConfig(autoAgentConfig);
        }
        const repoConfig = loadRepoConfig(repoPath);
        const baseSlug = agentSlug || repoConfig?.agent || autoAgentConfig.agentSlug || undefined;
        const autoSlugs = autoConfig?.agentSlugs || {};
        const slugOverride = (agentSlug && autoSlugs[agentSlug]) || (baseSlug && autoSlugs[baseSlug]) || undefined;
        const finalAgentSlug = slugOverride || baseSlug;
        const branch = getBranch(hookCwd);
        let model = input.model || (agentSlug === 'gemini' ? 'gemini' : agentSlug === 'codex' ? 'codex' : 'claude');
        // Override bare "gemini" with the real model identifier from
        // the transcript metadata when available (Gemini CLI doesn't
        // include `model` in hook stdin, so the fallback above lands
        // on the brand name instead of e.g. "gemini-2.5-pro").
        if ((model === 'gemini' || !model) && agentSlug === 'gemini') {
          const tp =
            (typeof input.transcript_path === 'string' && input.transcript_path) ||
            discoverGeminiTranscriptPath({
              sessionId: typeof input.session_id === 'string' ? input.session_id : undefined,
            }) ||
            '';
          if (tp) {
            const gm = readGeminiModel(tp);
            if (gm) model = gm;
          }
        }
        const autoTag = (input.session_id || '').slice(0, 12) || `s${Date.now().toString(36)}`;

        // Get git remote URL for better repo matching on the server
        let repoUrl = '';
        try {
          repoUrl = execFileSync('git', ['remote', 'get-url', 'origin'], { cwd: repoPath, encoding: 'utf-8' as const, stdio: ['pipe', 'pipe', 'pipe'] as ['pipe', 'pipe', 'pipe'] }).trim();
        } catch { /* no remote — that's fine */ }

        let sessionId: string;
        let agentSystemPrompt: string | undefined;
        let activePolicies: string[] | undefined;
        let enforcementRules: any[] | undefined;
        if (isConnectedMode() && autoConfig) {
          try {
            // Pass the stable conversation id for agents that have one so the
            // server's session dedup can match this auto-create against the
            // session-start row instead of minting a duplicate that later
            // collides with an unrelated conversation on the same repo+agent.
            const autoAgentSessionId = stableAgents.includes(agentSlug || '')
              ? (input.session_id || undefined)
              : undefined;
            const result = await api.startSession({
              machineId: autoAgentConfig.machineId,
              prompt: input.prompt || '',
              model,
              repoPath,
              repoUrl: repoUrl || undefined,
              agentSlug: finalAgentSlug,
              branch: branch || undefined,
              agentSessionId: autoAgentSessionId,
            });
            sessionId = result.sessionId as string;
            agentSystemPrompt = (result.agentSystemPrompt as string) || undefined;
            activePolicies = result.activePolicies && Array.isArray(result.activePolicies) ? result.activePolicies : undefined;
            enforcementRules = result.enforcementRules && Array.isArray(result.enforcementRules) ? result.enforcementRules : undefined;
            debugLog('user-prompt-submit', 'api returned policies', { sessionId, policiesCount: activePolicies?.length || 0, rulesCount: enforcementRules?.length || 0 });
          } catch (apiErr: any) {
            if (apiErr?.code === 'AGENT_DISABLED') {
              const agentName = apiErr?.body?.agent?.name || finalAgentSlug || 'this agent';
              process.stderr.write(`[origin] ${agentName} is disabled in your org — session kept local. An admin has been notified to enable it.\n`);
            } else {
              process.stderr.write(`[origin] API error (falling back to local): ${apiErr.message}\n`);
            }
            sessionId = `local-${crypto.randomUUID()}`;
          }
        } else {
          sessionId = `local-${crypto.randomUUID()}`;
        }

        debugLog('user-prompt-submit', 'auto-created session', { sessionId, sessionTag: autoTag, repoPath, repoUrl });
        // Same dirty-at-start tracking as the proper session-start path —
        // without it the heartbeat + session-snapshot filters can't exclude
        // another agent's leftover working-tree state from this session's
        // diffs (Codex's SessionStart hook is unreliable, so auto-create
        // through this path is the common case for Codex sessions).
        const autoSessionStartDirty = getDirtyFiles(hookCwd);
        let autoPrePromptSha = getHeadSha(hookCwd);
        let autoPrePromptDirtyFiles = autoSessionStartDirty;
        if (autoSessionStartDirty.length > 0) {
          try {
            const startShadowTag = autoTag || sessionId.slice(0, 12);
            const startShadow = createShadowCommit(hookCwd, `start-${startShadowTag}`);
            if (startShadow) {
              autoPrePromptSha = startShadow;
              autoPrePromptDirtyFiles = [];
              debugLog('user-prompt-submit', 'auto-create created session-start shadow', {
                shadow: startShadow.slice(0, 12), dirtyCount: autoSessionStartDirty.length,
              });
            }
          } catch (err: unknown) {
            debugLog('user-prompt-submit', 'auto-create shadow creation failed (non-fatal)', {
              message: err instanceof Error ? err.message : String(err),
            });
          }
        }
        state = {
          sessionId,
          claudeSessionId: input.session_id || '',
          transcriptPath: input.transcript_path || '',
          model,
          startedAt: new Date().toISOString(),
          prompts: [],
          repoPath,
          headShaAtStart: getHeadSha(hookCwd),
          headShaAtLastStop: null,
          prePromptSha: autoPrePromptSha,
          prePromptDirtyFiles: autoPrePromptDirtyFiles,
          sessionStartDirtyFiles: autoSessionStartDirty,
          branch,
          sessionTag: autoTag,
          agentSlug: finalAgentSlug || agentSlug,
          agentSystemPrompt,
          activePolicies,
          enforcementRules,
        };
        saveSessionState(state, repoPath, autoTag);

        // Start heartbeat for auto-created sessions so they don't get cleaned up as stale
        const connected = isConnectedMode();
        if (connected && autoConfig) {
          const stateFile = getStatePath(repoPath, autoTag);
          startHeartbeat(sessionId, autoConfig.apiUrl || 'https://getorigin.io', autoConfig.apiKey, stateFile, finalAgentSlug);
          debugLog('user-prompt-submit', 'heartbeat started for auto-created session', { sessionId, stateFile, agentSlug: finalAgentSlug });
        }
      } catch (err: any) {
        debugLog('user-prompt-submit', 'auto-create failed, falling back to local', { message: err.message });
        const status = err.status || 0;
        if (status === 401) {
          process.stderr.write(`[origin] API key invalid — session tracked locally. Run \`origin login\`.\n`);
        } else if (status === 403) {
          process.stderr.write(`[origin] ${err.message} — session tracked locally.\n`);
        } else if (status === 429) {
          process.stderr.write(`[origin] Budget limit reached — session tracked locally.\n`);
        }
        // Always create a local fallback session so tracking continues
        if (!state && repoPath) {
          const fbId = `local-${crypto.randomUUID()}`;
          const fbModel = input.model || agentSlug || 'unknown';
          const fbBranch = getBranch(hookCwd);
          const fbTag = (input.session_id || '').slice(0, 12) || `s${Date.now().toString(36)}`;
          const fbSessionStartDirty = getDirtyFiles(hookCwd);
          state = {
            sessionId: fbId,
            claudeSessionId: input.session_id || '',
            transcriptPath: input.transcript_path || '',
            model: fbModel,
            startedAt: new Date().toISOString(),
            prompts: [],
            repoPath,
            headShaAtStart: getHeadSha(hookCwd),
            headShaAtLastStop: null,
            prePromptSha: getHeadSha(hookCwd),
            prePromptDirtyFiles: getDirtyFiles(hookCwd),
            sessionStartDirtyFiles: fbSessionStartDirty,
            branch: fbBranch,
            sessionTag: fbTag,
          };
          // Hard cap refused the session server-side (429) — carry the
          // lockout into the fallback state so the budget gate below
          // blocks this very prompt instead of letting work continue
          // merely because tracking degraded to local.
          if (status === 429) {
            state.budgetBlocked = true;
            state.budgetBlockReason = err?.message || 'Budget limit exceeded';
          }
          saveSessionState(state, repoPath, fbTag);
          debugLog('user-prompt-submit', 'local fallback session created', { sessionId: fbId, sessionTag: fbTag });
        }
      }
    }
  }

  if (!state) {
    debugLog('user-prompt-submit', 'ABORT: no session state', { hookCwd });
    return;
  }

  // ── Budget lockout gate ──────────────────────────────────────────────
  // Blocks the prompt (exit 2) when a hard cap is breached, BEFORE any
  // bookkeeping — a blocked prompt never reaches the model, so it must
  // not be recorded as a turn either.
  if (state) {
    await enforceBudgetLockout(state, agentSlug, hookCwd, 'user-prompt-submit');
  }

  // ── SESSION_LIMITS max-duration gate ─────────────────────────────────
  // Team policy: sessions older than max_duration_minutes stop accepting
  // prompts (action: block). Enforced ONLY at prompt boundaries — never
  // mid-turn — so in-flight work is never cut off; the user finishes the
  // current turn, then the next prompt is refused with a message telling
  // them to start a fresh session. The heartbeat handles the time-based
  // notifications (idle notify, approaching-cap warning, max-idle auto-end).
  if (state) {
    enforceSessionDurationLimit(state, agentSlug, 'user-prompt-submit');
  }

  const rawPrompt = input.prompt || '';
  // If the raw prompt contains the literal Origin-managed marker, it's our own
  // AGENTS.md / CLAUDE.md content round-tripping through the agent (Codex
  // reads AGENTS.md natively and re-emits it as the first user turn). Drop
  // outright — it is never a real user input.
  const isOriginManagedEcho = rawPrompt.includes('<!-- origin-managed -->') ||
    /^#\s+AGENTS\.md instructions for /m.test(rawPrompt);
  // Filter out system/hook messages and internal agent tags that aren't real user prompts
  const prompt = isOriginManagedEcho ? '' : rawPrompt
    .replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, '')
    .replace(/<task-notification>[\s\S]*?<\/task-notification>/g, '')
    .replace(/<task-id>[\s\S]*?<\/task-id>/g, '')
    .replace(/<tool-use-id>[\s\S]*?<\/tool-use-id>/g, '')
    .replace(/<output-file>[\s\S]*?<\/output-file>/g, '')
    .replace(/<command-name>[\s\S]*?<\/command-name>/g, '')
    .replace(/<local-command-stdout>[\s\S]*?<\/local-command-stdout>/g, '')
    .replace(/<local-command-caveat>[\s\S]*?<\/local-command-caveat>/g, '')
    .replace(/<command-message>[\s\S]*?<\/command-message>/g, '')
    .replace(/<command-args>[\s\S]*?<\/command-args>/g, '')
    .replace(/<local-command-[^>]*>[\s\S]*?<\/local-command-[^>]*>/g, '')
    // Codex wraps AGENTS.md context in <INSTRUCTIONS>...</INSTRUCTIONS> on
    // its first user turn. Strip the envelope so any actual user text that
    // follows still makes it through. Same for <environment_context>
    // (Codex's session-init blob with cwd/shell/date) and
    // <user_instructions> (Codex's wrapper for AGENTS.md and friends).
    .replace(/<INSTRUCTIONS>[\s\S]*?<\/INSTRUCTIONS>/g, '')
    .replace(/<environment_context>[\s\S]*?<\/environment_context>/g, '')
    .replace(/<user_instructions>[\s\S]*?<\/user_instructions>/g, '')
    // Cursor wraps each user message in <user_query>...</user_query>. Keep
    // the inner text so the dashboard shows "make little change and commit"
    // instead of "<user_query> make little change and commit </user_query>".
    .replace(/<user_query>([\s\S]*?)<\/user_query>/g, '$1')
    .trim();
  const isSystemMsg = !prompt || /^Stop hook feedback:|^Stop:Callback hook blocking error|^PostToolUse:.*hook|^PreToolUse:.*hook/i.test(prompt);
  if (prompt && !isSystemMsg) {
    // ── Per-prompt diff: capture previous prompt's changes before recording new prompt ──
    const repoPath = state.repoPath || hookCwd;
    const currentHead = getHeadSha(repoPath);
    if (state.prePromptSha && currentHead && state.prompts.length > 0) {
      try {
        const prevPromptIdx = state.prompts.length - 1; // index of the prompt that just finished
        // Prefer the per-prompt shadow recorded by the heartbeat daemon at
        // the moment this prompt was detected in the rollout. That shadow
        // represents the working tree state at the START of this prompt
        // (= end of the previous prompt's work). Using it as the baseline
        // for `captureGitState` produces a per-prompt diff that contains
        // ONLY this prompt's work, even when no prompt-submit hook fired
        // (Codex auto-trust gating, Gemini IDE plug-in, etc.).
        const promptShadow = (state.promptShadows || []).find(
          (s) => s.promptIndex === prevPromptIdx,
        );
        const captureBaseline = promptShadow?.shadowSha || state.prePromptSha;
        // fullContext: per-prompt pc.diff feeds the blame route's
        // fallback path when sessionDiff doesn't cover the file (typical
        // for uncommitted work). Full-file context lets the replay
        // anchor every editsJson edit at an exact position instead of
        // falling through to content-keyed guessing.
        const prevGitCapture = captureGitState(repoPath, captureBaseline, { fullContext: true });
        // Extract filesChanged from commit details + diff headers
        const prevFilesSet = new Set<string>();
        for (const c of prevGitCapture.commitDetails) {
          for (const f of c.filesChanged) prevFilesSet.add(f);
        }
        if (prevGitCapture.diff) {
          for (const m of prevGitCapture.diff.matchAll(/^diff --git a\/(.*?) b\//gm)) {
            if (m[1]) prevFilesSet.add(m[1]);
          }
        }
        // Filter uncommitted diff against the prompt-baseline + session-start
        // pre-existing dirt union (see uncommittedExcludeUnion).
        const filteredUncommitted = filterUncommittedDiff(
          prevGitCapture.uncommittedDiff || '', uncommittedExcludeUnion(state),
        );
        if (filteredUncommitted) {
          for (const m of filteredUncommitted.matchAll(/^diff --git a\/(.*?) b\//gm)) {
            if (m[1]) prevFilesSet.add(m[1]);
          }
        }
        const prevFilesChanged = Array.from(prevFilesSet);
        if (prevGitCapture.diff || filteredUncommitted || prevFilesChanged.length > 0) {
          // Get current HEAD + working-tree SHA for restore support.
          let prevCommitSha: string | null = null;
          let prevTreeSha: string | null = null;
          try {
            prevCommitSha = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: state.repoPath || hookCwd, encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] }).trim();
          } catch { /* ignore */ }
          prevTreeSha = getWorkingTreeSha(state.repoPath || hookCwd);
          // Scope `committedDiff` to commits THIS session authored. Walking
          // the session's own commit list keeps concurrent agents isolated:
          // a heartbeat in this session no longer picks up a foreign agent's
          // commits even when HEAD has moved past ours.
          const sessionCommitted = sessionScopedCommittedDiff(repoPath, state);
          const diffText = (sessionCommitted +
            (filteredUncommitted ? '\n' + filteredUncommitted : '')).trim();
          const prevMapping = {
            promptIndex: prevPromptIdx,
            promptText: (state.prompts[prevPromptIdx] || '').slice(0, 1000),
            filesChanged: prevFilesChanged,
            diff: diffText.slice(0, 200_000),
            uncommittedDiff: filteredUncommitted.slice(0, 200_000),
            commitSha: prevCommitSha,
            treeSha: prevTreeSha,
          };
          if (!state.completedPromptMappings) state.completedPromptMappings = [];
          // Replace if same promptIndex exists, else append.
          // BUT: don't overwrite a non-empty existing diff with an empty
          // one — that happens when STOP already captured the previous
          // prompt's work and then set prePromptDirtyFiles to those files,
          // which causes filterUncommittedDiff here to strip everything
          // back out, leaving us with prevMapping.diff="" that would clobber
          // the good mapping STOP saved a second earlier.
          const existingIdx = state.completedPromptMappings.findIndex(m => m.promptIndex === prevPromptIdx);
          if (existingIdx >= 0) {
            const existing = state.completedPromptMappings[existingIdx];
            const newHasDiff = !!(prevMapping.diff || prevMapping.uncommittedDiff);
            const existingHasDiff = !!(existing.diff || (existing as any).uncommittedDiff);
            // Stop already marked this prompt as chat-only (no commits + no
            // transcript edits). Don't let the retroactive capture re-attribute
            // pre-existing dirty working-tree state to a turn the agent didn't
            // actually touch code on.
            const existingIsChatOnly = (existing as any).chatOnly === true;
            if (existingIsChatOnly) {
              debugLog('user-prompt-submit', 'kept existing chat-only mapping', {
                promptIndex: prevPromptIdx,
              });
            } else if (newHasDiff || !existingHasDiff) {
              state.completedPromptMappings[existingIdx] = prevMapping;
            } else {
              debugLog('user-prompt-submit', 'kept existing previous-prompt mapping (new diff was empty)', {
                promptIndex: prevPromptIdx,
              });
            }
          } else {
            state.completedPromptMappings.push(prevMapping);
          }
          debugLog('user-prompt-submit', 'captured per-prompt diff for previous prompt', {
            promptIndex: prevPromptIdx, filesChanged: prevFilesChanged.length,
            linesAdded: prevGitCapture.linesAdded, linesRemoved: prevGitCapture.linesRemoved,
            hadEmptyDiff: !(prevMapping.diff || prevMapping.uncommittedDiff),
          });
        }
      } catch (err: any) {
        debugLog('user-prompt-submit', 'per-prompt diff capture failed (non-fatal)', { message: err.message });
      }
    }
    // Record baseline for the NEW prompt. If the working tree is dirty at
    // this point, create a per-prompt shadow commit capturing the current
    // state. The next prompt's retroactive capture will then compute its
    // diff against THIS shadow — isolating only the new prompt's work and
    // excluding everything that was uncommitted before it started.
    //
    // Without this, multiple prompts share `prePromptSha = HEAD` while the
    // working tree accumulates uncommitted edits across prompts; the
    // resulting per-prompt `uncommittedDiff` for each prompt is cumulative
    // (= "all changes since HEAD"), which means prompt N's mapping
    // appears to include prompt N-1's, N-2's, ... work too.
    {
      const repo = state.repoPath || hookCwd;
      const dirty = getDirtyFiles(repo);
      if (dirty.length > 0) {
        try {
          const shadowTag = state.sessionTag || state.sessionId.slice(0, 12);
          const shadow = createShadowCommit(repo, `prompt-${shadowTag}`);
          if (shadow) {
            state.prePromptSha = shadow;
            state.prePromptDirtyFiles = [];
            debugLog('user-prompt-submit', 'anchored next-prompt baseline to shadow', {
              shadow: shadow.slice(0, 12), dirtyCount: dirty.length,
            });
          } else {
            // Shadow creation failed — fall back to HEAD + dirty list.
            state.prePromptSha = currentHead;
            state.prePromptDirtyFiles = dirty;
          }
        } catch {
          state.prePromptSha = currentHead;
          state.prePromptDirtyFiles = dirty;
        }
      } else {
        state.prePromptSha = currentHead;
        state.prePromptDirtyFiles = [];
      }
    }

    state.prompts.push(prompt);

    // Update transcript path if provided (may change between turns)
    if (input.transcript_path) {
      state.transcriptPath = input.transcript_path;
    }

    // ── Mid-session branch tracking ─────────────────────────────────────
    // Agents that don't fire PostToolUse (Codex) otherwise never get a
    // branch refresh until session-end, so sessions look stuck on the
    // branch they started on even after the agent `git checkout`s a new one.
    // getBranch() just reads .git/HEAD so it's cheap to do on every prompt.
    try {
      const repoPath = state.repoPath || hookCwd;
      const currentBranch = getBranch(repoPath);
      if (currentBranch && currentBranch !== state.branch) {
        debugLog('user-prompt-submit', 'branch changed', { from: state.branch, to: currentBranch });
        state.branch = currentBranch;
        if (isConnectedMode() && state.sessionId && !state.sessionId.startsWith('local-')) {
          api.updateSession(state.sessionId, { branch: currentBranch }).catch(() => {});
        }
      }
    } catch {
      // non-fatal
    }

    // Ensure session stays RUNNING (may have been auto-expired by listAllActiveSessions)
    state.status = 'RUNNING';
    saveSessionState(state, state.repoPath || hookCwd, state.sessionTag);
    debugLog('user-prompt-submit', 'prompt saved', { promptCount: state.prompts.length, sessionId: state.sessionId, tag: state.sessionTag });

    // ── Heartbeat: send incremental update to API on every prompt (connected mode only) ──
    try {
      const config = loadConfig();
      if (config && isConnectedMode()) {
        const durationMs = Date.now() - new Date(state.startedAt).getTime();

        // Try to parse transcript for live token/cost data
        let parsed: ParsedTranscript | null = null;
        let displayTranscript = '';
        try {
          if (state.transcriptPath) {
            parsed = parseTranscript(state.transcriptPath, { since: state.startedAt });
            displayTranscript = formatTranscriptForDisplay(state.transcriptPath, { verbose: !!state.verboseCapture });
          }
        } catch {
          // Transcript may not be readable mid-session for all agents
        }

        // For Codex: try reading the rollout JSONL for full transcript + token data
        if ((agentSlug === 'codex' || (state as any).agentSlug === 'codex')) {
          try {
            const codexData = discoverCodexSessionData(state.repoPath || hookCwd, {
              verbose: !!state.verboseCapture,
              threadId: state.agentSessionId || state.claudeSessionId || undefined,
            });
            if (codexData) {
              if (!displayTranscript && codexData.transcript) displayTranscript = codexData.transcript;
              if (!parsed && codexData.tokensUsed > 0) {
                parsed = {
                  prompts: [], filesChanged: [], summary: '', transcript: '',
                  model: codexData.model, tokensUsed: codexData.tokensUsed,
                  inputTokens: codexData.inputTokens, outputTokens: codexData.outputTokens,
                  // Codex now splits cached prompt tokens out of input.
                  // Carry through so estimateCost can bill them at the
                  // model's cached rate ($0.50/M on gpt-5.5).
                  cacheReadTokens: codexData.cacheReadTokens ?? 0,
                  cacheCreationTokens: 0,
                  toolCalls: 0,
                  toolBreakdown: [],
                  filesRead: [],
                };
              }
              // Sync state.prompts from the rollout so the dashboard sees
              // every prompt — not just the ones our hook captured. Codex's
              // UserPromptSubmit hook is unreliable (auto-trust gating), so
              // mirroring the rollout is the only way to guarantee the
              // prompt list grows turn-by-turn.
              const rolloutPrompts = codexData.prompts || [];
              if (rolloutPrompts.length > state.prompts.length) {
                state.prompts = rolloutPrompts;
                debugLog('user-prompt-submit', 'synced state.prompts from Codex rollout', {
                  rolloutCount: rolloutPrompts.length,
                });
              }
            }
          } catch { /* best effort */ }
        }

        // For Gemini: auto-discover the chat checkpoint file mid-session so
        // heartbeats upload the assistant text + tool I/O instead of just
        // user prompts. Stop-hook does the same lookup; running it here too
        // means the Session tab shows real content while the session is
        // still RUNNING (not just after it ends).
        if (!displayTranscript && agentSlug === 'gemini') {
          try {
            if (!state.transcriptPath) {
              const discovered = discoverGeminiTranscriptPath({
                sessionId: state.agentSessionId || state.claudeSessionId || undefined,
              });
              if (discovered) {
                state.transcriptPath = discovered;
                debugLog('user-prompt-submit', 'gemini transcript auto-discovered', { discovered });
              }
            }
            if (state.transcriptPath && fs.existsSync(state.transcriptPath)) {
              parsed = parseTranscript(state.transcriptPath, { since: state.startedAt });
              displayTranscript = formatTranscriptForDisplay(state.transcriptPath, { verbose: !!state.verboseCapture });
            }
          } catch { /* best effort */ }
        }

        // Synthesize transcript from captured prompts when no transcript file
        // exists. Interleave any assistant replies recorded on
        // state.promptResponses by the stop hook — otherwise a heartbeat that
        // fires after one prompt completes and another starts would push a
        // prompts-only transcript and clobber the response-rich one the
        // stop hook just persisted (mainly affects Gemini, whose transcript
        // file is unflushed mid-session so we depend on stop-hook captures).
        if (!displayTranscript && state.prompts.length > 0) {
          const turns: Array<{ role: string; content: string }> = [];
          if (state.agentSystemPrompt) {
            turns.push({ role: 'system', content: state.agentSystemPrompt });
          }
          const responses = state.promptResponses || [];
          for (let i = 0; i < state.prompts.length; i++) {
            turns.push({ role: 'user', content: state.prompts[i] });
            if (responses[i]) {
              turns.push({ role: 'assistant', content: responses[i] });
            }
          }
          displayTranscript = JSON.stringify(turns);
        }

        const model = parsed?.model || state.model;
        // Estimate tokens from prompt text when no transcript data exists (Codex, etc.)
        let hbInputTokens = parsed?.inputTokens || 0;
        let hbOutputTokens = parsed?.outputTokens || 0;
        let hbTokensUsed = parsed?.tokensUsed || 0;
        if (hbTokensUsed === 0 && state.prompts.length > 0) {
          const totalChars = state.prompts.reduce((sum, p) => sum + p.length, 0);
          hbInputTokens = Math.round(totalChars / 4);
          hbOutputTokens = hbInputTokens * 3;
          hbTokensUsed = hbInputTokens + hbOutputTokens;
        }
        const costUsd = hbTokensUsed > 0
          ? estimateCost(model, hbInputTokens, hbOutputTokens, parsed?.cacheReadTokens || 0, parsed?.cacheCreationTokens || 0)
          : 0;

        // Redact secrets from prompts
        const shouldRedact = config.secretRedaction !== false;
        const redactedPrompts = shouldRedact
          ? state.prompts.map(p => redactSecrets(p).redacted)
          : state.prompts;
        const joinedPrompt = redactedPrompts.join('\n\n---\n\n');

        // Fire-and-forget — Codex's user-prompt-submit hook has a 10s budget,
        // and awaiting this network call here was making the hook time out
        // (the heartbeat daemon already re-sends the same payload on its
        // own tick, so the data isn't lost — just delayed by up to 30s).
        // Shadow commit + state-file write already happened earlier in this
        // hook, so the per-prompt baseline is captured before we return.
        api.updateSession(state.sessionId, {
          prompt: joinedPrompt || undefined,
          transcript: displayTranscript || undefined,
          model: isSpecificModel(model) ? model : undefined,
          filesChanged: parsed?.filesChanged && parsed.filesChanged.length > 0 ? parsed.filesChanged : undefined,
          tokensUsed: hbTokensUsed > 0 ? hbTokensUsed : undefined,
          inputTokens: hbInputTokens > 0 ? hbInputTokens : undefined,
          outputTokens: hbOutputTokens > 0 ? hbOutputTokens : undefined,
          toolCalls: parsed?.toolCalls ? parsed.toolCalls : undefined,
          durationMs: durationMs > 0 ? durationMs : undefined,
          costUsd: costUsd > 0 ? costUsd : undefined,
          status: 'RUNNING',
          // Send accumulated per-prompt diffs so they appear immediately on the platform
          promptChanges: state.completedPromptMappings && state.completedPromptMappings.length > 0
            ? state.completedPromptMappings.map(pm => {
                const dl = (pm.diff || '').split('\n');
                return {
                  ...pm,
                  promptText: (pm.promptText || '').slice(0, 1000),
                  diff: (pm.diff || '').slice(0, MAX_PROMPT_DIFF_LEN),
                  linesAdded: dl.filter((l: string) => l.startsWith('+') && !l.startsWith('+++')).length,
                  linesRemoved: dl.filter((l: string) => l.startsWith('-') && !l.startsWith('---')).length,
                  aiPercentage: 100,
                  checkpointType: 'auto',
                };
              })
            : undefined,
        }).catch((err: any) => {
          debugLog('user-prompt-submit', 'background updateSession failed (non-fatal)', { message: err?.message });
        });
        debugLog('user-prompt-submit', 'heartbeat dispatched (fire-and-forget)', { sessionId: state.sessionId, promptCount: state.prompts.length, costUsd, promptChanges: state.completedPromptMappings?.length || 0 });

        // Restart heartbeat daemon if it died (e.g., Mac sleep killed it)
        if (!isHeartbeatAlive(state.sessionId)) {
          const saveCwd = found?.saveCwd || hookCwd;
          const stateFile = getStatePath(saveCwd, state.sessionTag);
          startHeartbeat(state.sessionId, config.apiUrl || 'https://getorigin.io', config.apiKey, stateFile, agentSlug);
          debugLog('user-prompt-submit', 'heartbeat daemon restarted (was dead)', { sessionId: state.sessionId, agentSlug });
        }
      }
    } catch (err: any) {
      debugLog('user-prompt-submit', 'heartbeat error (non-fatal)', { message: err.message });
      // Non-fatal — don't block the agent
    }
  }

  // ── Output system message for agents that read it from beforeSubmitPrompt (e.g. Cursor) ──
  // Cursor doesn't reliably consume systemMessage from sessionStart, so we also
  // inject it here on every prompt submission.
  try {
    let systemMsg = '';

    // Auth-broken warning. If a recent API call hit 401 the api.ts
    // layer writes an auth-status.json sentinel; bubble that up as
    // the first line of the systemMessage so the agent surfaces it
    // in the user's conversation instead of letting every hook
    // silently fail in hooks.log forever.
    try {
      const authStatus = readAuthStatus();
      if (authStatus?.state === 'unauthorized') {
        systemMsg +=
          '\u26a0 Origin: Your CLI API key is no longer valid (server returned 401). ' +
          'Run `origin login` in another terminal to re-authenticate \u2014 until then, ' +
          'Origin is not capturing this session.\n\n';
      } else if (authStatus?.state === 'unreachable') {
        systemMsg +=
          '\u26a0 Origin: Could not reach the API on the last call' +
          (authStatus.message ? ` (${authStatus.message})` : '') +
          '. Sessions will resume once the server is reachable again.\n\n';
      }
    } catch { /* status read is best-effort */ }

    // Mid-session scoped soft-cap warning — the heartbeat persisted it
    // from a ping payload. Surface the amber banner in the conversation
    // ONCE per distinct reason (budgetWarnShownFor records delivery), so
    // a crossing mid-session is visible without nagging every prompt.
    if (state.budgetWarnReason && state.budgetWarnShownFor !== state.budgetWarnReason) {
      systemMsg += buildBudgetWarningBanner(state.budgetWarnReason) + '\n\n';
      state.budgetWarnShownFor = state.budgetWarnReason;
      try { saveSessionState(state, state.repoPath || hookCwd, state.sessionTag); } catch { /* re-shows next prompt */ }
    }

    if (state.agentSystemPrompt) {
      systemMsg += state.agentSystemPrompt + '\n\n';
    }
    systemMsg += 'Origin: Session tracking active \u2014 prompts, files, and tokens will be captured.';
    if (!isConnectedMode()) {
      systemMsg += ' (standalone mode)';
    }
    if (state.activePolicies && Array.isArray(state.activePolicies) && state.activePolicies.length > 0) {
      systemMsg += '\n\nActive policies for this session:\n' +
        state.activePolicies.map((p: string) => `- ${p}`).join('\n');
    }

    // Inject repo-level attribution context
    const repoPath = state.repoPath || hookCwd;
    try {
      const attributionCtx = buildAttributionContext(repoPath);
      if (attributionCtx) {
        systemMsg += '\n\n' + attributionCtx;
      }
    } catch {}

    if (systemMsg) {
      const payload = buildContextInjectionPayload(agentSlug, 'UserPromptSubmit', systemMsg);
      if (payload) process.stdout.write(payload);
      debugLog('user-prompt-submit', 'context injected', { agent: agentSlug, length: systemMsg.length });
    }
  } catch (sysErr: any) {
    debugLog('user-prompt-submit', 'systemMessage injection failed (non-fatal)', { message: sysErr.message });
  }
}

async function handleStop(input: Record<string, any>, agentSlug?: string): Promise<void> {
  debugLog('stop', 'begin', { cwd: input.cwd, inputModel: input.model, agentSlug });

  const config = loadConfig();
  const connected = isConnectedMode();
  let hookCwd = input.cwd || process.cwd();
  // Cursor sends workspace_roots instead of cwd
  if (input.workspace_roots && Array.isArray(input.workspace_roots) && input.workspace_roots.length > 0) {
    const wsRoot = input.workspace_roots[0];
    if (typeof wsRoot === 'string' && getGitRoot(wsRoot)) {
      hookCwd = wsRoot;
    }
  }
  let found = findStateForHook(hookCwd, hookLookupSessionId(input.session_id, agentSlug), agentSlug);
  let state = found?.state || null;
  // Recover from archive if .git state file is missing (Cursor/Codex sessions)
  if (!state) {
    try {
      const recoveryRepoPath = discoverGitRoot(hookCwd) || hookCwd;
      const archiveDir = path.join(os.homedir(), '.origin', 'sessions');
      const archiveEntries = fs.readdirSync(archiveDir).filter(f => f.endsWith('.json'));
      let bestCandidate: SessionState | null = null;
      let bestAge = Infinity;
      for (const entry of archiveEntries) {
        try {
          const s = JSON.parse(fs.readFileSync(path.join(archiveDir, entry), 'utf-8'));
          if (!s?.sessionId || !s?.startedAt) continue;
          const age = Date.now() - new Date(s.startedAt).getTime();
          if (age > 24 * 60 * 60 * 1000) continue;
          if (s.status === 'ENDED' && s.endedAt) continue;
          if (s.repoPath !== recoveryRepoPath) continue;
          if (agentSlug && !sessionMatchesAgent(s, agentSlug)) continue;
          if (age < bestAge) { bestCandidate = s; bestAge = age; }
        } catch { /* skip */ }
      }
      if (bestCandidate) {
        debugLog('stop', 'recovered session from archive', { sessionId: bestCandidate.sessionId, tag: bestCandidate.sessionTag });
        saveSessionState(bestCandidate, recoveryRepoPath, bestCandidate.sessionTag);
        state = bestCandidate;
        found = { state, saveCwd: recoveryRepoPath };
      }
    } catch { /* no archive */ }
  }
  if (!state) {
    // Cursor 2.x edge case: if the user was running Cursor while their
    // hooks.json had the now-invalid `agentSessionStart` name, no session-
    // start state was created. After upgrading + restarting Cursor, the
    // first agent reply fires `stop` with valid hook config — but our
    // handler used to abort here because no in-progress state was on disk,
    // and the session never reached the dashboard. Auto-create from the
    // stop-hook payload as a last resort. Mirror the user-prompt-submit
    // auto-create path; gated on cursor + valid workspace + session_id so
    // we don't accidentally fabricate sessions for other agents.
    const canAutoCreate = agentSlug === 'cursor'
      && connected
      && typeof input.session_id === 'string'
      && Array.isArray(input.workspace_roots)
      && input.workspace_roots.length > 0;
    if (canAutoCreate) {
      try {
        const autoConfig = loadConfig();
        const autoAgentConfig = loadAgentConfig();
        if (autoConfig?.apiKey && autoAgentConfig?.machineId) {
          const wsRoot = input.workspace_roots[0];
          const repoPath = discoverGitRoot(wsRoot) || wsRoot;
          const branch = getBranch(repoPath);
          const startRes = await api.startSession({
            machineId: autoAgentConfig.machineId,
            prompt: '',
            model: (typeof input.model === 'string' && input.model !== 'cursor' && input.model !== 'default' && input.model !== 'unknown') ? input.model : 'cursor',
            repoPath,
            agentSlug: 'cursor',
            branch: branch || undefined,
            agentSessionId: input.session_id,
          } as any);
          const newSessionId = (startRes as any)?.sessionId;
          if (typeof newSessionId === 'string' && newSessionId) {
            const autoTag = (input.session_id as string).slice(0, 12);
            const synthesizedDirty = getDirtyFiles(repoPath);
            const synthesized: SessionState = {
              sessionId: newSessionId,
              claudeSessionId: input.session_id,
              transcriptPath: input.transcript_path || '',
              model: typeof input.model === 'string' ? input.model : 'cursor',
              startedAt: new Date().toISOString(),
              prompts: [],
              repoPath,
              headShaAtStart: getHeadSha(repoPath),
              headShaAtLastStop: null,
              prePromptSha: getHeadSha(repoPath),
              prePromptDirtyFiles: synthesizedDirty,
              sessionStartDirtyFiles: synthesizedDirty,
              branch: branch || null,
              sessionTag: autoTag,
              agentSlug: 'cursor',
            };
            saveSessionState(synthesized, repoPath, autoTag);
            state = synthesized;
            found = { state: synthesized, saveCwd: repoPath };
            debugLog('stop', 'auto-created cursor session from stop-hook payload', {
              sessionId: newSessionId, repoPath, agentSessionId: input.session_id,
            });
          }
        }
      } catch (err: any) {
        debugLog('stop', 'cursor auto-create failed', { message: err?.message });
      }
    }
    if (!state) {
      debugLog('stop', 'ABORT: missing state', { hasConfig: !!config, hasState: false });
      return;
    }
  }

  // For Codex specifically: the session may have been registered with a
  // misattributed repoPath when the user launched `codex` from `~` (or any
  // non-git directory). discoverGitRoot then walks into `.openclaw/workspace`
  // or whatever sibling git repo it finds first — so the session shows up on
  // the dashboard against the wrong repo, and the diff capture below runs
  // against a directory codex never touched (→ 0 files / 0 lines even when
  // codex committed). Codex itself records the thread's actual cwd in its
  // SQLite state DB; query for it and override state.repoPath if it differs.
  if (agentSlug === 'codex') {
    try {
      const codexData = discoverCodexSessionData(state.repoPath, {
        verbose: !!state.verboseCapture,
        threadId: state.agentSessionId || state.claudeSessionId || undefined,
      });
      const actualCwd = codexData?.cwd;
      if (actualCwd && actualCwd !== state.repoPath && fs.existsSync(actualCwd)) {
        debugLog('stop', 'codex repoPath correction', { from: state.repoPath, to: actualCwd });
        state.repoPath = actualCwd;
        saveSessionState(state, found!.saveCwd, state.sessionTag);
      }
    } catch (err: any) {
      debugLog('stop', 'codex cwd lookup failed (non-fatal)', { message: err?.message });
    }
  }

  // Update model from stdin if it's a real model name (Cursor sends actual model in stop, not session-start)
  if (input.model && input.model !== 'default' && input.model !== 'unknown' && input.model !== 'cursor') {
    state.model = input.model;
    debugLog('stop', 'model updated from stdin', { model: input.model });
  }

  // Update transcript path if provided
  if (input.transcript_path) {
    state.transcriptPath = input.transcript_path;
    saveSessionState(state, found!.saveCwd, state.sessionTag);
  }

  // Auto-discover Gemini transcript path if not already set
  if (!state.transcriptPath) {
    const discovered = discoverGeminiTranscriptPath({
      sessionId: state.agentSessionId || state.claudeSessionId || undefined,
    });
    if (discovered) {
      state.transcriptPath = discovered;
      saveSessionState(state, found!.saveCwd, state.sessionTag);
      debugLog('stop', 'auto-discovered transcript path', { discovered });
    }
  }

  try {
    debugLog('stop', 'parsing transcript', { transcriptPath: state.transcriptPath });
    const parsed = parseTranscript(state.transcriptPath, { since: state.startedAt });

    // Format transcript for dashboard display (converts JSONL → [{role, content}] JSON)
    let displayTranscript = formatTranscriptForDisplay(state.transcriptPath, { verbose: !!state.verboseCapture });
    debugLog('stop', 'formatted transcript', { displayLength: displayTranscript.length });

    // For Cursor: discover agent transcript JSONL for real conversation data + better token estimates
    if (agentSlug === 'cursor' && parsed.tokensUsed === 0) {
      // Prefer session_id (Cursor 2.x stop hook stdin) over conversation_id
      // (older shape). The Cursor agent-transcripts directory name IS the
      // session_id, so this is what lets the discovery find the right chat
      // instead of falling back to "the most recently modified jsonl".
      const cursorId = (typeof input.session_id === 'string' ? input.session_id : undefined)
        || (typeof input.conversation_id === 'string' ? input.conversation_id : undefined);
      const cursorData = discoverCursorTranscript(cursorId, state.repoPath, { verbose: !!state.verboseCapture });
      if (cursorData) {
        debugLog('stop', 'supplementing with Cursor transcript data', {
          tokens: cursorData.tokensUsed,
          hasTranscript: !!cursorData.transcript,
        });
        parsed.tokensUsed = cursorData.tokensUsed;
        parsed.inputTokens = cursorData.inputTokens;
        parsed.outputTokens = cursorData.outputTokens;
        if (cursorData.transcript && !displayTranscript) {
          displayTranscript = cursorData.transcript;
        }
      } else if (!displayTranscript && input.conversation_id) {
        // Fallback: use conversation_summaries DB for a minimal transcript
        const summary = getCursorConversationSummary(input.conversation_id);
        if (summary) {
          debugLog('stop', 'cursor summary from DB (fallback)', { title: summary.title });
          const turns: Array<{ role: string; content: string }> = [];
          for (const p of state.prompts) {
            turns.push({ role: 'user', content: p });
            const responseParts: string[] = [];
            if (summary.tldr) responseParts.push(summary.tldr);
            if (summary.overview && summary.overview !== summary.tldr) responseParts.push(summary.overview);
            if (summary.summaryBullets) responseParts.push(summary.summaryBullets);
            if (responseParts.length > 0) {
              turns.push({ role: 'assistant', content: responseParts.join('\n\n') });
            }
          }
          if (turns.length > 0) {
            displayTranscript = JSON.stringify(turns);
          }
        }
      }
    }

    // For Codex: supplement with data from its SQLite database / rollout JSONL.
    // Gate on agentSlug so we don't accidentally pull Codex data into a
    // different agent's session. Always run for Codex sessions — the rollout
    // is the authoritative source for both tokens AND the full transcript
    // (assistant text, reasoning, tool I/O), so even when we already have
    // tokens we still want the richer transcript.
    const codexData = (agentSlug === 'codex')
      ? discoverCodexSessionData(state.repoPath, {
          verbose: !!state.verboseCapture,
          threadId: state.agentSessionId || state.claudeSessionId || undefined,
        })
      : null;
    if (codexData) {
      debugLog('stop', 'supplementing with Codex data', {
        model: codexData.model,
        tokens: codexData.tokensUsed,
        toolCalls: codexData.toolCalls,
        hasTranscript: !!codexData.transcript,
      });
      if (!parsed.model) parsed.model = codexData.model;
      if (parsed.tokensUsed === 0) {
        parsed.tokensUsed = codexData.tokensUsed;
        parsed.inputTokens = codexData.inputTokens;
        parsed.outputTokens = codexData.outputTokens;
        // Carry through the cached portion so estimateCost picks
        // up the cached-input rate (gpt-5.5: $0.50/M vs $5/M).
        if (codexData.cacheReadTokens !== undefined) {
          parsed.cacheReadTokens = codexData.cacheReadTokens;
        }
      }
      if (codexData.toolCalls > 0 && parsed.toolCalls === 0) {
        parsed.toolCalls = codexData.toolCalls;
      }
      // Sync state.prompts with every user prompt the rollout knows about.
      // Codex's UserPromptSubmit hook is unreliable (auto-trust gating,
      // config.toml feature-flag drift), so we can't count on state.prompts
      // growing turn-by-turn from that path. The rollout JSONL is the
      // authoritative source — pull every cleaned user message in order and
      // adopt it as state.prompts when the rollout has at least as many
      // entries as we currently track. Falling back to the singleton SQLite
      // first_user_message only when no rollout prompts are available.
      const rolloutPrompts = codexData.prompts || [];
      if (rolloutPrompts.length > state.prompts.length) {
        state.prompts = rolloutPrompts;
        debugLog('stop', 'synced state.prompts from rollout', {
          rolloutCount: rolloutPrompts.length,
        });
      } else if (codexData.prompt && state.prompts.length === 0) {
        state.prompts.push(codexData.prompt);
      }
      // Prefer the rollout-parsed transcript over the synthesized-from-prompts
      // fallback — it includes assistant text, reasoning, and tool I/O.
      if (codexData.transcript) {
        displayTranscript = codexData.transcript;
        debugLog('stop', 'using Codex rollout transcript', { length: displayTranscript.length });
      }

      // Backfill per-prompt diffs from the rollout + git history. Codex's
      // user-prompt-submit hook is unreliable, so for prompts where it didn't
      // fire we have no captured diff — only prompts 0-1 typically get
      // captured. Without this, AI Blame shows only those two prompts.
      // backfillCodexPromptMappings prefers TURN-SCOPED commit attribution
      // (walks the rollout's function_call_output events for [branch sha]
      // markers and pins each commit to the turn that produced it). Falls
      // back to timestamp-based mapping only when the rollout doesn't
      // surface a SHA for a given commit. Timestamps alone race against the
      // user typing the next prompt before the agent's commit lands —
      // exactly the bug that caused prompt N's work to show up under
      // prompt N+1 in AI Blame.
      try {
        const codexThreadId = state.agentSessionId || state.claudeSessionId || undefined;
        const timeline = getCodexPromptsTimeline(state.repoPath, codexThreadId);
        if (timeline.length > 0 && state.headShaAtStart) {
          const currentHead = getHeadSha(state.repoPath) || state.headShaAtStart;
          const rolloutFile = findCodexRolloutPath(state.repoPath, codexThreadId) || undefined;
          const backfilled = backfillCodexPromptMappings({
            repoPath: state.repoPath,
            headShaAtStart: state.headShaAtStart,
            headShaAtEnd: currentHead,
            prompts: timeline.map(t => ({ text: t.text, timestamp: t.timestamp })),
            rolloutFile,
          });
          if (backfilled.length > 0) {
            if (!state.completedPromptMappings) state.completedPromptMappings = [];
            // Merge: turn-scoped backfill always wins. The previous policy
            // ("existing wins if it has any diff") preserved bad data from
            // racy user-prompt-submit captures that attributed cross-turn
            // commits to the wrong prompt — i.e. the very bug this fix is
            // for. The rollout's per-turn `[branch sha]` mapping is now the
            // authoritative source of truth; uncommittedDiff data the
            // backfill can't see is rare for Codex and not worth keeping
            // wrong attribution to recover.
            for (const bf of backfilled) {
              const existingIdx = state.completedPromptMappings.findIndex(
                m => m.promptIndex === bf.promptIndex,
              );
              if (existingIdx >= 0) {
                state.completedPromptMappings[existingIdx] = bf;
              } else {
                state.completedPromptMappings.push(bf);
              }
            }
            state.completedPromptMappings.sort((a, b) => a.promptIndex - b.promptIndex);
            debugLog('stop', 'codex per-prompt backfill', {
              timelineCount: timeline.length,
              backfilledCount: backfilled.length,
              totalMappings: state.completedPromptMappings.length,
            });
          }

          // Clean up two classes of bogus per-prompt mappings that
          // user-prompt-submit's retroactive capture path produces for
          // Codex sessions:
          //
          //   1. AGENTS.md-only mappings — the agent didn't touch any user
          //      file in this turn; the diff is just Origin's auto-created
          //      AGENTS.md being churned by the system. Counting that as
          //      "this prompt did work" misattributes a real prompt to
          //      bookkeeping noise.
          //
          //   2. Consecutive duplicates — when the user types prompt N+1
          //      before the agent finishes prompt N's work, the retroactive
          //      capture snapshots the SAME state for N and N+1, leaving
          //      pc[N+1] = pc[N]. Show as no-op so the real prompt's work
          //      doesn't get split across two attribution slots.
          //
          // Backfill's own output is unique per prompt (rollout SHAs are
          // 1:1), so neither pattern can be backfill-produced — safe to
          // clear without risking authentic data.
          if (state.completedPromptMappings && state.completedPromptMappings.length > 0) {
            const sorted = state.completedPromptMappings
              .slice()
              .sort((a, b) => a.promptIndex - b.promptIndex);
            let cleared = 0;
            const clearTarget = (idx: number) => {
              const target = state.completedPromptMappings!.find(m => m.promptIndex === idx);
              if (!target) return false;
              target.diff = '';
              (target as { uncommittedDiff?: string }).uncommittedDiff = '';
              target.filesChanged = [];
              return true;
            };
            // Pass 1 — AGENTS.md-only mappings.
            for (const m of sorted) {
              if (!m.diff) continue;
              const headers: string[] = [];
              for (const h of m.diff.matchAll(/^diff --git a\/(.+?)\s+b\/(.+)$/gm)) {
                headers.push(h[2]);
              }
              if (headers.length > 0 && headers.every(h => h === 'AGENTS.md')) {
                if (clearTarget(m.promptIndex)) cleared++;
              }
            }
            // Pass 2 — consecutive duplicates (compare pc.diff alone since
            // that's what the blame algorithm parses; uncommittedDiff is
            // metadata only).
            const sortedAfter = state.completedPromptMappings
              .slice()
              .sort((a, b) => a.promptIndex - b.promptIndex);
            for (let i = 1; i < sortedAfter.length; i++) {
              const prev = sortedAfter[i - 1];
              const curr = sortedAfter[i];
              const prevDiff = prev.diff || '';
              const currDiff = curr.diff || '';
              if (currDiff && currDiff === prevDiff) {
                if (clearTarget(curr.promptIndex)) cleared++;
              }
            }
            if (cleared > 0) {
              debugLog('stop', 'cleared bogus prompt mappings', { cleared });
            }
          }
        }
      } catch (err: unknown) {
        debugLog('stop', 'codex per-prompt backfill failed (non-fatal)', {
          message: err instanceof Error ? err.message : String(err),
        });
      }
    }

    // Gemini stop hook ships the assistant's reply on stdin as
    // `prompt_response`. Claude Code's stop hook uses `last_assistant_message`
    // for the same purpose. Both agents' transcript files are sometimes empty
    // / unflushed at stop time (especially Claude Code running inside a
    // .claude/worktrees/* worktree — the JSONL hasn't been finalized when
    // the stop hook fires). Capture either onto state.promptResponses so the
    // synthesized transcript below includes the assistant turn instead of
    // only the user prompt.
    const stopHookReply =
      (typeof input.prompt_response === 'string' && input.prompt_response.trim() && input.prompt_response) ||
      (typeof input.last_assistant_message === 'string' && input.last_assistant_message.trim() && input.last_assistant_message) ||
      '';
    if (stopHookReply) {
      if (!state.promptResponses) state.promptResponses = [];
      const currentIdx = Math.max(state.prompts.length - 1, 0);
      // Replace if we already have one for this index (in case Stop fires
      // twice for the same turn — rare but observed).
      state.promptResponses[currentIdx] = stopHookReply;
      debugLog('stop', 'captured stop-hook reply from stdin', {
        promptIndex: currentIdx,
        length: stopHookReply.length,
        source: input.prompt_response ? 'prompt_response' : 'last_assistant_message',
      });
    }

    // For Codex (and other agents without transcripts): synthesize displayTranscript from captured prompts
    if (!displayTranscript && state.prompts.length > 0) {
      const turns: Array<{ role: string; content: string }> = [];
      // Include the system message so users can see what context was injected
      if (state.agentSystemPrompt) {
        turns.push({ role: 'system', content: state.agentSystemPrompt });
      }
      const responses = state.promptResponses || [];
      for (let i = 0; i < state.prompts.length; i++) {
        turns.push({ role: 'user', content: state.prompts[i] });
        // Interleave the assistant reply we captured (Gemini, agents
        // without transcripts) so the dashboard shows the response.
        if (responses[i]) {
          turns.push({ role: 'assistant', content: responses[i] });
        }
      }
      displayTranscript = JSON.stringify(turns);
      debugLog('stop', 'synthesized transcript from prompts', {
        turnCount: turns.length, responseCount: responses.filter(Boolean).length,
      });
    }

    // Estimate tokens from prompt text when no real token data exists (Codex, agents without transcripts)
    if (parsed.tokensUsed === 0 && state.prompts.length > 0) {
      const totalPromptChars = state.prompts.reduce((sum, p) => sum + p.length, 0);
      // ~4 chars per token for English, assume 3:1 output:input ratio for coding tasks
      const estimatedInputTokens = Math.round(totalPromptChars / 4);
      const estimatedOutputTokens = estimatedInputTokens * 3;
      parsed.inputTokens = estimatedInputTokens;
      parsed.outputTokens = estimatedOutputTokens;
      parsed.tokensUsed = estimatedInputTokens + estimatedOutputTokens;
      debugLog('stop', 'estimated tokens from prompt text', { totalPromptChars, estimatedInputTokens, estimatedOutputTokens });
    }

    // Use prompts from transcript if we captured them, else from state
    const prompts = parsed.prompts.length > 0 ? parsed.prompts : state.prompts;

    // F9: Redact secrets before sending to API
    const config_ = loadConfig();
    const shouldRedact = config_?.secretRedaction !== false; // default: true
    const redactedPrompts = shouldRedact
      ? prompts.map(p => redactSecrets(p).redacted)
      : prompts;
    const joinedPrompt = redactedPrompts.join('\n\n---\n\n');

    const durationMs = Date.now() - new Date(state.startedAt).getTime();
    // Prefer: stdin model → Cursor DB → transcript → state
    const stdinModel = (input.model && input.model !== 'default' && input.model !== 'unknown') ? input.model : '';
    let model = stdinModel || parsed.model || state.model;
    // If still generic, try Cursor's SQLite DB
    if ((!model || model === 'cursor' || model === 'default') && agentSlug === 'cursor' && input.conversation_id) {
      const cursorDbModel = getCursorModelFromDb(input.conversation_id);
      if (cursorDbModel) {
        model = cursorDbModel;
        debugLog('stop', 'model from Cursor DB', { model: cursorDbModel });
      } else {
        // DB read failed or returned nothing — we'll bill at sonnet (cursor key) rates
        // but the real model could be cheaper (gpt-4o-mini) or more expensive. Log it
        // so we can spot systematic mispricing in aggregate.
        debugLog('stop', 'cursor model fallback (DB lookup failed)', {
          conversationId: input.conversation_id,
          finalModel: model || 'cursor',
        });
      }
    }
    const costUsd = estimateCost(model, parsed.inputTokens, parsed.outputTokens, parsed.cacheReadTokens, parsed.cacheCreationTokens);

    // Extract prompt → file change mappings
    let promptMappings = extractPromptFileMappings(state.transcriptPath);
    debugLog('stop', 'prompt mappings', { count: promptMappings.length });

    // Fall back to git-captured files if transcript parsing didn't find any
    // Use per-prompt baseline: prePromptSha (set at prompt start) > headShaAtLastStop > headShaAtStart
    const promptBaseline = state.prePromptSha || state.headShaAtLastStop || state.headShaAtStart;
    // fullContext: per-prompt diff feeds AI Blame's replay. Full-file
    // context lets every editsJson edit anchor at an exact position.
    const gitCapture = captureGitState(state.repoPath, promptBaseline, { fullContext: true });
    let filesChanged = parsed.filesChanged;
    if (filesChanged.length === 0 && gitCapture.commitDetails.length > 0) {
      const gitFiles = new Set<string>();
      for (const commit of gitCapture.commitDetails) {
        for (const f of commit.filesChanged) gitFiles.add(f);
      }
      filesChanged = Array.from(gitFiles);
      debugLog('stop', 'using git-captured files (transcript had none)', { count: filesChanged.length });
    }

    // Multi-repo: capture diffs from all repos and prefix file paths with repo dir name
    if (state.repoPaths && state.repoPaths.length > 1 && state.perRepoState) {
      const multiRepoFiles = new Set<string>();
      for (const rp of state.repoPaths) {
        const rpState = state.perRepoState[rp];
        if (!rpState) continue;
        const rpBaseline = rpState.prePromptSha || rpState.headShaAtLastStop || rpState.headShaAtStart;
        const rpCapture = captureGitState(rp, rpBaseline, { fullContext: true });
        const repoDir = path.basename(rp);
        for (const c of rpCapture.commitDetails) {
          for (const f of c.filesChanged) multiRepoFiles.add(`${repoDir}/${f}`);
        }
        if (rpCapture.uncommittedDiff) {
          const filteredUncommitted = filterUncommittedDiff(rpCapture.uncommittedDiff, rpState.prePromptDirtyFiles || []);
          if (filteredUncommitted) {
            for (const m of filteredUncommitted.matchAll(/^diff --git a\/(.*?) b\//gm)) {
              if (m[1]) multiRepoFiles.add(`${repoDir}/${m[1]}`);
            }
          }
        }
      }
      if (multiRepoFiles.size > 0) {
        filesChanged = Array.from(multiRepoFiles);
        debugLog('stop', 'multi-repo filesChanged', { count: filesChanged.length });
      }
    }

    // Build prompt→file mappings for the current prompt.
    // Always merge with previously saved mappings so the API's deleteMany+recreate
    // doesn't lose older prompts.
    {
      const previousMappings = state.completedPromptMappings || [];
      const currentPromptIdx = prompts.length - 1;
      const currentPromptText = prompts[currentPromptIdx] || '';

      if (promptMappings.length === 0 && prompts.length > 0) {
        // No transcript-based mappings — synthesize from git for current prompt.
        // Filter uncommitted diff against the prompt-baseline + session-start
        // pre-existing dirt union.
        const filteredUncommitted = filterUncommittedDiff(
          gitCapture.uncommittedDiff || '', uncommittedExcludeUnion(state),
        );
        // Hard gate: if the agent didn't commit anything AND the transcript
        // shows no Edit/Write tool calls, the user is just chatting and the
        // dirty working tree existed before this prompt. Attribute an empty
        // mapping so the dashboard reflects "no code changes" instead of
        // sweeping in unrelated uncommitted work. filteredUncommitted is the
        // backstop — when prePromptDirtyFiles missed something (path-format
        // drift, race after a stop reset, …), the absence of commits +
        // transcript edits is a stronger signal.
        const noCommits = (gitCapture.commitDetails?.length ?? 0) === 0;
        const noTranscriptEdits = parsed.filesChanged.length === 0;
        // Cursor mid-turn defense (mirrors the safety-net guard below):
        // working-tree edits without commits/transcript signal still
        // count as a code turn. filteredUncommitted is what's actually
        // attributable to THIS turn after the per-prompt exclude list
        // strips prior-turn carryover.
        const noUncommittedChanges =
          !filteredUncommitted &&
          !((gitCapture.workingTreeDiff || '').length > 0);
        if (noCommits && noTranscriptEdits && noUncommittedChanges) {
          const currentMapping = {
            promptIndex: currentPromptIdx,
            promptText: currentPromptText.slice(0, 1000),
            filesChanged: [] as string[],
            diff: '',
            uncommittedDiff: '',
            // Marker so the next user-prompt-submit's retroactive
            // capture path doesn't overwrite this with whatever dirty
            // working-tree state still exists.
            chatOnly: true as const,
          };
          promptMappings = [...previousMappings, currentMapping];
          debugLog('stop', 'chat-only prompt — synthesized empty mapping', {
            promptIndex: currentPromptIdx,
            uncommittedAfterFilter: filteredUncommitted.length,
          });
        } else {
          const uncommittedFiles: string[] = [];
          if (filteredUncommitted) {
            for (const m of filteredUncommitted.matchAll(/^diff --git a\/(.*?) b\//gm)) {
              if (m[1]) uncommittedFiles.push(m[1]);
            }
          }
          // When prePromptSha is a shadow commit, use workingTreeDiff —
          // committedDiff would be the reverse-direction text against the
          // shadow's content.
          const useWorkingTreeDiff = gitCapture.baselineIsShadow && gitCapture.workingTreeDiff;
          if (useWorkingTreeDiff) {
            // Pull file list out of the working-tree diff (which is what
            // we'll actually store) so filesChanged matches the diff.
            for (const m of gitCapture.workingTreeDiff.matchAll(/^diff --git a\/(.*?) b\//gm)) {
              if (m[1]) uncommittedFiles.push(m[1]);
            }
          }
          const allFiles = new Set([...filesChanged, ...uncommittedFiles]);
          const synthDiff = useWorkingTreeDiff
            ? gitCapture.workingTreeDiff
            : (((gitCapture.committedDiff || '') + (filteredUncommitted ? '\n' + filteredUncommitted : '')).trim());
          // Capture commit/tree SHAs so the commit-detail page can link
          // this prompt to the commit it produced.
          let synthCommitSha: string | null = null;
          let synthTreeSha: string | null = null;
          try {
            synthCommitSha = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: state.repoPath, encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] }).trim();
            synthTreeSha = getWorkingTreeSha(state.repoPath);
          } catch { /* ignore */ }
          const currentMapping = {
            promptIndex: currentPromptIdx,
            promptText: currentPromptText.slice(0, 1000),
            filesChanged: Array.from(allFiles),
            diff: synthDiff.slice(0, 200_000),
            uncommittedDiff: filteredUncommitted.slice(0, 200_000),
            commitSha: synthCommitSha,
            treeSha: synthTreeSha,
          };
          promptMappings = [...previousMappings, currentMapping];
        }
      } else if (promptMappings.length > 0 && previousMappings.length > 0) {
        // Transcript gave us mappings for current prompt — merge with saved previous ones.
        // Deduplicate by promptIndex (current prompt's data wins over saved).
        const currentIndices = new Set(promptMappings.map(pm => pm.promptIndex));
        const kept = previousMappings.filter(pm => !currentIndices.has(pm.promptIndex));
        promptMappings = [...kept, ...promptMappings];
      }

      // Safety net: ensure the CURRENT prompt has a mapping even if transcript
      // parsing missed it. Without this, the latest prompt shows empty on the
      // platform until the NEXT prompt fires (when user-prompt-submit captures it).
      if (prompts.length > 0 && !promptMappings.some(pm => pm.promptIndex === currentPromptIdx)) {
        const noCommits = (gitCapture.commitDetails?.length ?? 0) === 0;
        const noTranscriptEdits = parsed.filesChanged.length === 0;
        // A turn is only truly chat-only when NOTHING happened: no commits,
        // no transcript-reported edits, AND no working-tree changes the
        // CLI captured. Cursor mid-turn prompts pass `noCommits` and
        // `noTranscriptEdits` (Cursor's transcript doesn't expose
        // filesChanged), but the working tree IS dirty from its IDE
        // edits — without checking uncommittedDiff the turn falls into
        // the chat-only branch below and ends up with treeSha=null,
        // un-restorable in the UI.
        const noUncommittedChanges = !((gitCapture.uncommittedDiff || '').length > 0)
          && !((gitCapture.workingTreeDiff || '').length > 0);
        if (noCommits && noTranscriptEdits && noUncommittedChanges) {
          // Chat-only prompt — same gate as the synthesis branch above.
          promptMappings.push({
            promptIndex: currentPromptIdx,
            promptText: currentPromptText.slice(0, 1000),
            filesChanged: [] as string[],
            diff: '',
            uncommittedDiff: '',
            chatOnly: true as const,
          });
          debugLog('stop', 'safety-net empty mapping (chat-only prompt)', {
            promptIndex: currentPromptIdx,
          });
        } else {
          const filteredUncommitted = filterUncommittedDiff(
            gitCapture.uncommittedDiff || '', uncommittedExcludeUnion(state),
          );
          const uncommittedFiles: string[] = [];
          if (filteredUncommitted) {
            for (const m of filteredUncommitted.matchAll(/^diff --git a\/(.*?) b\//gm)) {
              if (m[1]) uncommittedFiles.push(m[1]);
            }
          }
          // Shadow baseline → prefer workingTreeDiff (see note in synthesis branch above).
          const useWorkingTreeDiff = gitCapture.baselineIsShadow && gitCapture.workingTreeDiff;
          if (useWorkingTreeDiff) {
            for (const m of gitCapture.workingTreeDiff.matchAll(/^diff --git a\/(.*?) b\//gm)) {
              if (m[1]) uncommittedFiles.push(m[1]);
            }
          }
          const allFiles = new Set([...filesChanged, ...uncommittedFiles]);
          const safetyDiff = useWorkingTreeDiff
            ? gitCapture.workingTreeDiff
            : (((gitCapture.committedDiff || '') + (filteredUncommitted ? '\n' + filteredUncommitted : '')).trim());
          // Capture commitSha + treeSha so the dashboard can link this prompt
          // to its commit on the commit-detail page. Without these the
          // "Prompts in this commit" panel says "No linked prompts" even
          // when the per-prompt mapping was captured correctly.
          let synthCommitSha: string | null = null;
          let synthTreeSha: string | null = null;
          try {
            synthCommitSha = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: state.repoPath, encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] }).trim();
            synthTreeSha = getWorkingTreeSha(state.repoPath);
          } catch { /* ignore */ }
          promptMappings.push({
            promptIndex: currentPromptIdx,
            promptText: currentPromptText.slice(0, 1000),
            filesChanged: Array.from(allFiles),
            diff: safetyDiff.slice(0, 200_000),
            uncommittedDiff: filteredUncommitted.slice(0, 200_000),
            commitSha: synthCommitSha,
            treeSha: synthTreeSha,
          } as any);
          debugLog('stop', 'synthesized current prompt mapping (safety net)', {
            promptIndex: currentPromptIdx, files: allFiles.size, shadowBaseline: gitCapture.baselineIsShadow,
            commitSha: synthCommitSha?.slice(0, 8) || null,
          });
        }
      }

      // Safety net for OLDER prompts (not just current). Codex doesn't
      // fire user-prompt-submit reliably; a rollout-sync can pop several
      // new entries into state.prompts at once (e.g. user typed 3 prompts
      // before any hook fired). Without this, state.completedPromptMappings
      // ends up with fewer entries than state.prompts and the dashboard
      // shows "3 prompts" but only N pcs. Fill every gap with a chatOnly
      // placeholder so prompt count matches mapping count — honest UI
      // ("no work captured for this turn") instead of phantom missing
      // entries that confuse the blame view.
      if (prompts.length > 0) {
        const haveIdx = new Set(promptMappings.map(pm => pm.promptIndex));
        for (let i = 0; i < prompts.length; i++) {
          if (haveIdx.has(i)) continue;
          promptMappings.push({
            promptIndex: i,
            promptText: (prompts[i] || '').slice(0, 1000),
            filesChanged: [] as string[],
            diff: '',
            uncommittedDiff: '',
            chatOnly: true as const,
          });
        }
        // Keep ordering stable for downstream consumers.
        promptMappings.sort((a, b) => a.promptIndex - b.promptIndex);
      }

      debugLog('stop', 'prompt mappings (merged)', {
        currentPromptIdx,
        previousCount: previousMappings.length,
        totalCount: promptMappings.length,
        filesChanged: filesChanged.length,
      });
    }

    // Compute session-level filesChanged from headShaAtStart (accumulated across all prompts)
    // This is separate from per-prompt filesChanged which uses promptBaseline
    let sessionFilesChanged = filesChanged; // default: per-prompt files
    if (state.repoPaths && state.repoPaths.length > 1 && state.perRepoState) {
      // Multi-repo: session-level files from all repos
      const sessionFilesSet = new Set<string>();
      for (const rp of state.repoPaths) {
        const rpState = state.perRepoState[rp];
        if (!rpState?.headShaAtStart) continue;
        try {
          const rpCapture = captureGitState(rp, rpState.headShaAtStart, { committedOnly: true });
          const repoDir = path.basename(rp);
          for (const c of rpCapture.commitDetails) {
            for (const f of c.filesChanged) sessionFilesSet.add(`${repoDir}/${f}`);
          }
        } catch { /* skip this repo */ }
      }
      if (sessionFilesSet.size > 0) {
        sessionFilesChanged = Array.from(sessionFilesSet);
        debugLog('stop', 'multi-repo session-level filesChanged', { count: sessionFilesChanged.length });
      }
    } else if (state.headShaAtStart && state.headShaAtStart !== promptBaseline) {
      try {
        const sessionCapture = captureGitState(state.repoPath, state.headShaAtStart, { committedOnly: true });
        const sessionFilesSet = new Set<string>();
        for (const c of sessionCapture.commitDetails) {
          for (const f of c.filesChanged) sessionFilesSet.add(f);
        }
        if (sessionCapture.diff) {
          for (const m of sessionCapture.diff.matchAll(/^diff --git a\/(.*?) b\//gm)) {
            if (m[1]) sessionFilesSet.add(m[1]);
          }
        }
        if (sessionFilesSet.size > 0) {
          sessionFilesChanged = Array.from(sessionFilesSet);
          debugLog('stop', 'session-level filesChanged from headShaAtStart', { count: sessionFilesChanged.length });
        }
      } catch (err: any) {
        debugLog('stop', 'session-level capture failed, using per-prompt files', { message: err.message });
      }
    }

    // Hoisted out of `if (connected)` so writeSessionFiles below (which
    // runs in both connected + disconnected modes) can pass editsJson
    // through to changes.json. Populated inside the connected block;
    // stays null when offline or when capture fails.
    let promptEditsByIndex: Map<number, string> | null = null;

    if (connected) {
      // Recovery: if the session was created in local-only mode (key
      // was dead at the time → `local-` prefix) and the key has since
      // recovered, register it server-side now so the rest of the
      // update lands on a real row instead of a 404. Persist the new
      // id back to state so future hooks use it directly.
      await ensureServerSession(state, hookCwd, agentSlug, 'stop');

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
      // Build a session-level gitCapture snapshot for agents whose .git
      // hooks don't fire reliably (Codex). Without this, sessionDiff is
      // never created, the blame endpoint falls back to line-number Map
      // attribution where later prompts overwrite earlier ones, and AI
      // Blame shows prompt 1's lines as belonging to prompt 2 for any
      // file both prompts touched. headBefore = session start so the API
      // can recognise this as a SNAPSHOT and replace (not append) the
      // existing sessionDiff.
      let sessionGitCapture: {
        headBefore: string; headAfter: string; commitShas: string[];
        diff: string; linesAdded: number; linesRemoved: number;
        commitDetails: Array<{ sha: string; message: string; author: string; filesChanged: string[] }>;
        snapshot: true;
      } | undefined;
      // Cursor's git commits don't reliably fire .git/hooks/post-commit
      // (sandbox / worktree isolation — same comment as in enable.ts). On
      // top of that, `git commit --amend` orphans the pre-amend SHA so the
      // post-commit ingest for the original commit goes stale anyway. Both
      // failure modes leave sessionCommits empty even though the user
      // committed, which surfaces every committed Cursor prompt as
      // "uncommitted" on the dashboard (user-reported May 28, or-test-2
      // "make little change and commit"). Treat Cursor like Codex/Gemini
      // and ship a session-level gitCapture snapshot at session-end —
      // walking git log from session start lifts every reachable commit
      // (including post-amend SHAs) into the MCP ingest path.
      const codexLikeAgents = new Set(['codex', 'gemini', 'cursor']);
      if (codexLikeAgents.has((agentSlug || state.agentSlug || '').toLowerCase()) && state.headShaAtStart) {
        try {
          // fullContext: AI Blame renders the entire file from this diff —
          // unlimited unified context means every line ships as context or
          // added, eliminating "N lines hidden" gaps in the view.
          const snap = captureGitState(state.repoPath, state.headShaAtStart, { fullContext: true });
          if (snap.committedDiff || snap.uncommittedDiff) {
            // Scope the committed side to commits THIS session authored.
            // `git diff session-start..HEAD` (used by captureGitState) picks
            // up commits made by a concurrent session once HEAD has moved
            // past ours — sessionScopedCommittedDiff walks the post-commit-
            // recorded list and rebuilds the diff from this session's own
            // commits only, which is the right unit of "what this session
            // did" for a Full Session Diff display.
            const filteredUncommitted = filterUncommittedDiff(
              snap.uncommittedDiff || '',
              uncommittedExcludeUnion(state),
            );
            // Codex bypasses .git/hooks/post-commit on some installs, so
            // sessionCommitShas can be empty even when the session produced
            // real commits — sessionScopedCommittedDiff then returns "" and
            // fullDiff collapses to just the uncommitted slice, dropping every
            // committed prompt from sessionDiff (and the AI Blame view). Fall
            // back to snap.committedDiff (= git diff session-start..HEAD)
            // when the session-scoped walk produces nothing.
            let sessionCommitted = sessionScopedCommittedDiff(state.repoPath, state);
            if (!sessionCommitted && snap.committedDiff) {
              sessionCommitted = snap.committedDiff;
            }
            const fullDiff = (sessionCommitted +
              (filteredUncommitted ? '\n' + filteredUncommitted : '')).trim();
            sessionGitCapture = {
              headBefore: state.headShaAtStart,
              headAfter: snap.headAfter || state.headShaAtStart,
              commitShas: (snap.commitDetails || []).map(c => c.sha),
              diff: fullDiff.slice(0, 500_000),
              linesAdded: snap.linesAdded || 0,
              linesRemoved: snap.linesRemoved || 0,
              commitDetails: snap.commitDetails || [],
              snapshot: true,
            };
            debugLog('stop', 'session-level gitCapture snapshot built', {
              diffLen: sessionGitCapture.diff.length,
              commitCount: sessionGitCapture.commitShas.length,
              linesAdded: sessionGitCapture.linesAdded,
              linesRemoved: sessionGitCapture.linesRemoved,
              filteredOutFiles: (state.sessionStartDirtyFiles || []).length,
            });
          }
        } catch (snapErr: unknown) {
          debugLog('stop', 'session-level gitCapture failed (non-fatal)', {
            message: snapErr instanceof Error ? snapErr.message : String(snapErr),
          });
        }
      }

      // ─── New per-prompt PromptCapture pipeline ────────────────────────
      // Run the agent-specific extractor and produce an authoritative
      // PromptEdit[] per prompt. The server stores this JSON on
      // PromptChange.editsJson and computes the displayed per-prompt diff
      // + AI Blame attribution from it via LCS, bypassing the legacy
      // block-matching heuristics that conflate cross-prompt changes.
      // `promptEditsByIndex` is declared at function scope above so the
      // writeSessionFiles call below `if (connected)` can also pick it up.
      try {
        const slug = (agentSlug || state.agentSlug || '').toLowerCase();
        const captureAgent =
          slug === 'codex' ? 'codex' :
          slug === 'cursor' ? 'cursor' :
          slug === 'gemini' ? 'gemini' :
          'claude';
        const capTranscript =
          captureAgent === 'codex' ? (codexData?.rolloutPath || state.transcriptPath)
            : state.transcriptPath;
        // For Codex, hand the extractor the pre-resolved per-prompt
        // timeline (text + ms timestamp) from the same rollout walker
        // already used elsewhere for commit attribution. Without this,
        // the extractor re-reads the rollout and falls back to "all
        // commits go to the last prompt" whenever a timestamp couldn't
        // be parsed — exactly the bug that left prompt N+1's diff
        // showing up under prompt N.
        let codexPromptsForCapture: Array<{ text: string; timestamp: number }> | undefined;
        if (captureAgent === 'codex') {
          try {
            const codexThreadId = state.agentSessionId || state.claudeSessionId || undefined;
            const timeline = getCodexPromptsTimeline(state.repoPath, codexThreadId);
            if (timeline.length > 0) {
              codexPromptsForCapture = timeline.map((t) => ({
                text: t.text || '',
                timestamp: t.timestamp || 0,
              }));
            }
          } catch (tlErr: unknown) {
            debugLog('stop', 'codex timeline fetch for capturePromptEdits failed', {
              message: tlErr instanceof Error ? tlErr.message : String(tlErr),
            });
          }
        }
        const transcriptCaptures = capturePromptEdits({
          agent: captureAgent,
          repoPath: state.repoPath,
          transcriptPath: capTranscript,
          codexPrompts: codexPromptsForCapture,
          sessionCommitShas: state.sessionCommitShas || [],
          headShaAtStart: state.headShaAtStart || undefined,
          headShaAtEnd: gitCapture.headAfter || undefined,
        });
        const captures = applyLiveLedger(transcriptCaptures, state, 'stop');
        if (captures.length > 0) {
          promptEditsByIndex = new Map();
          for (const cap of captures) {
            // Anchor any edit the live ledger didn't already position
            // (transcript-only agents like Gemini) against the final
            // on-disk file. Already-anchored live edits are skipped.
            if (state.repoPath) anchorEditPositions(cap.edits, state.repoPath);
            promptEditsByIndex.set(cap.promptIndex, JSON.stringify(cap));
          }
          debugLog('stop', 'capturePromptEdits ok', {
            agent: captureAgent,
            captured: captures.length,
            totalEdits: captures.reduce((n, c) => n + c.edits.length, 0),
          });
        }
      } catch (capErr: unknown) {
        debugLog('stop', 'capturePromptEdits failed (non-fatal)', {
          message: capErr instanceof Error ? capErr.message : String(capErr),
        });
      }

      const updateRes = await api.updateSession(state.sessionId, {
        prompt: joinedPrompt || undefined,
        transcript: displayTranscript || undefined,
        // Only send a specific model (mirrors session-end). When the parse
        // found nothing (resumed session, empty transcript), state.model is
        // the bare brand "claude" — sending it would overwrite a real
        // identifier (e.g. "claude-fable-5") stored by an earlier update.
        model: isSpecificModel(model) ? model : undefined,
        filesChanged: sessionFilesChanged.length > 0 ? sessionFilesChanged : undefined,
        tokensUsed: parsed.tokensUsed > 0 ? parsed.tokensUsed : undefined,
        inputTokens: parsed.inputTokens > 0 ? parsed.inputTokens : undefined,
        outputTokens: parsed.outputTokens > 0 ? parsed.outputTokens : undefined,
        cacheReadTokens: parsed.cacheReadTokens > 0 ? parsed.cacheReadTokens : undefined,
        cacheCreationTokens: parsed.cacheCreationTokens > 0 ? parsed.cacheCreationTokens : undefined,
        toolCalls: parsed.toolCalls > 0 ? parsed.toolCalls : undefined,
        // Structured per-tool breakdown + files-read so the server stores
        // them directly instead of re-parsing the display transcript (which
        // is prompt-only for synthesized/aggregated sessions → "0 / None").
        toolBreakdown: parsed.toolBreakdown.length > 0 ? parsed.toolBreakdown : undefined,
        filesRead: mergeFilesRead(parsed.filesRead, state.filesRead),
        durationMs: durationMs > 0 ? durationMs : undefined,
        costUsd: costUsd > 0 ? costUsd : undefined,
        gitCapture: sessionGitCapture,
        promptChanges: promptMappings.length > 0
          ? promptMappings.map(pm => ({
              ...pm,
              promptText: (pm.promptText || '').slice(0, 1000),
              diff: (pm.diff || '').slice(0, MAX_PROMPT_DIFF_LEN),
              editsJson: promptEditsByIndex?.get(pm.promptIndex) || undefined,
            }))
          : undefined,
      });
      debugLog('stop', 'update complete');

      // Persist the budget lockout signal the PATCH response carried, so
      // the NEXT prompt / tool call gets blocked when a hard cap was
      // breached by this turn's spend.
      applyBudgetSignal(state, updateRes, hookCwd);

      // Send a heartbeat ping to keep the server-side session alive
      // (prevents the server's stale session cleanup from ending it)
      try {
        await api.pingSession(state.sessionId);
      } catch { /* non-fatal */ }

      // Image attachments (Phase 1 — Claude / Cursor pastes).
      //
      // The server gates uploads on the user's `captureImages` opt-in
      // flag (default false). We always try here and stop on the first
      // 403 — that keeps the CLI simple (no need to fetch the user's
      // preference) and means flipping the toggle in Settings takes
      // effect on the next prompt without a CLI restart.
      //
      // Caps: 5 MB per image, 50 MB per session enforced server-side.
      // We also skip locally if a base64 payload would exceed 5 MB
      // after decode, to save the roundtrip.
      try {
        const images = extractPromptImages(state.transcriptPath);
        if (images.length > 0) {
          debugLog('stop', 'image upload begin', { count: images.length });
          let optedOut = false;
          for (const img of images) {
            if (optedOut) break;
            if (img.sizeBytes > 5 * 1024 * 1024) {
              debugLog('stop', 'image too large, skip', { promptIndex: img.promptIndex, sizeBytes: img.sizeBytes });
              continue;
            }
            try {
              await api.uploadAttachment(state.sessionId, {
                promptIndex: img.promptIndex,
                mediaType: img.mediaType,
                base64: img.base64,
              });
            } catch (uploadErr: any) {
              const status = uploadErr?.status || uploadErr?.code;
              if (status === 403 || /disabled/i.test(uploadErr?.message || '')) {
                debugLog('stop', 'image capture disabled for user — stopping', {});
                optedOut = true;
              } else {
                debugLog('stop', 'image upload failed (non-fatal)', {
                  promptIndex: img.promptIndex,
                  message: uploadErr?.message || String(uploadErr),
                });
              }
            }
          }
        }
      } catch (imgErr: any) {
        debugLog('stop', 'image extraction failed (non-fatal)', { message: imgErr?.message });
      }
    }

    // Write git notes on any commits that don't have them yet
    // This is critical for agents like Codex that may bypass .git/hooks/post-commit
    try {
      const noteCommits = gitCapture.commitDetails
        .map(c => c.sha)
        .filter(sha => /^[a-fA-F0-9]+$/.test(sha));
      if (noteCommits.length > 0) {
        const execOptsNotes = { cwd: state.repoPath, encoding: 'utf-8' as const, stdio: ['pipe', 'pipe', 'pipe'] as ['pipe', 'pipe', 'pipe'] };
        // Only write notes for commits that don't already have them
        const missingNotes = noteCommits.filter(sha => {
          try {
            execFileSync('git', ['notes', '--ref=origin', 'show', sha], execOptsNotes);
            return false; // already has a note
          } catch {
            return true; // no note yet
          }
        });
        if (missingNotes.length > 0) {
          writeGitNotes(state.repoPath, missingNotes, {
            sessionId: state.sessionId,
            model: model || state.model || 'unknown',
            agentSlug: agentSlug || state.agentSlug,
            promptCount: prompts.length,
            promptSummary: prompts[prompts.length - 1] || '',
            fullPrompt: prompts[prompts.length - 1] || undefined,
            previousSessionId: state.previousSessionId,
            filesRead: state.filesRead,
            prompts: buildPromptNoteEntries(state, agentSlug || state.agentSlug, model || state.model, promptEditsByIndex),
            tokensUsed: parsed.tokensUsed,
            costUsd,
            durationMs: durationMs > 0 ? durationMs : 0,
            linesAdded: gitCapture.linesAdded || 0,
            linesRemoved: gitCapture.linesRemoved || 0,
            originUrl: state.sessionId ? `${config?.apiUrl || 'https://getorigin.io'}/sessions/${state.sessionId}` : '',
          });
          debugLog('stop', 'git notes written for missing commits', { count: missingNotes.length });
        }
      }
    } catch (notesErr: any) {
      debugLog('stop', 'git notes error (non-fatal)', { message: notesErr.message });
    }

    // Update per-prompt baselines so next prompt only sees its own changes.
    //
    // CRITICAL: if the working tree is dirty at end of this prompt, we
    // can't just use HEAD as the next prompt's baseline — when the next
    // prompt commits those still-dirty files, diff(HEAD..nextHEAD) would
    // include the previous prompt's work, falsely attributing it to the
    // next prompt.
    //
    // Fix: create a shadow commit whose tree = (HEAD's tree + all dirty
    // files), and use that as prePromptSha. Then diff(shadowSha..nextHEAD)
    // only includes content the next prompt actually introduced, since
    // the previous prompt's dirty content is already in the shadow tree.
    state.headShaAtLastStop = gitCapture.headAfter;
    {
      const dirty = getDirtyFiles(state.repoPath);
      if (dirty.length > 0) {
        const shadowTag = state.sessionTag || state.sessionId.slice(0, 12);
        const shadowSha = createShadowCommit(state.repoPath, shadowTag);
        if (shadowSha) {
          state.prePromptSha = shadowSha;
          // dirty files are now captured in the shadow tree, so the next
          // prompt's filterUncommittedDiff should treat the tree as clean.
          state.prePromptDirtyFiles = [];
          debugLog('stop', 'shadow commit anchored next-prompt baseline', {
            shadowSha: shadowSha.slice(0, 12), dirtyCount: dirty.length, head: gitCapture.headAfter.slice(0, 12),
          });
        } else {
          // Shadow creation failed — fall back to old behavior (will
          // potentially double-attribute uncommitted work).
          state.prePromptSha = gitCapture.headAfter;
          state.prePromptDirtyFiles = dirty;
          debugLog('stop', 'shadow commit failed, using HEAD as baseline (next prompt may double-attribute)', {
            dirtyCount: dirty.length,
          });
        }
      } else {
        state.prePromptSha = gitCapture.headAfter;
        state.prePromptDirtyFiles = [];
      }
    }
    // Multi-repo: update per-repo baselines
    if (state.repoPaths && state.repoPaths.length > 1 && state.perRepoState) {
      for (const rp of state.repoPaths) {
        const rpState = state.perRepoState[rp];
        if (!rpState) continue;
        const rpHead = getHeadSha(rp);
        rpState.headShaAtLastStop = rpHead;
        const rpDirty = getDirtyFiles(rp);
        if (rpDirty.length > 0) {
          const rpShadowTag = `${state.sessionTag || state.sessionId.slice(0, 12)}-${path.basename(rp)}`;
          const rpShadow = createShadowCommit(rp, rpShadowTag);
          if (rpShadow) {
            rpState.prePromptSha = rpShadow;
            rpState.prePromptDirtyFiles = [];
          } else {
            rpState.prePromptSha = rpHead;
            rpState.prePromptDirtyFiles = rpDirty;
          }
        } else {
          rpState.prePromptSha = rpHead;
          rpState.prePromptDirtyFiles = [];
        }
      }
    }
    // Save accumulated prompt mappings so next stop can include previous prompts' data
    if (promptMappings.length > 0) {
      state.completedPromptMappings = promptMappings.map(pm => ({
        promptIndex: pm.promptIndex,
        promptText: pm.promptText,
        filesChanged: pm.filesChanged,
        diff: pm.diff,
        uncommittedDiff: pm.uncommittedDiff,
      }));
    }
    // Auto-snapshot: save working tree state after each AI turn.
    //
    // createSnapshot() is already idempotent: it does `git stash create`
    // to capture the working tree, and returns null when the tree is
    // clean (nothing to snapshot) OR when the resulting tree SHA matches
    // the last snapshot on the session's shadow branch (no change since
    // last turn). That's the authoritative "did anything change?" test.
    //
    // We used to gate on `gitCapture.linesAdded + linesRemoved > 0` to
    // suppress chat-only turns. But that gate locks out Cursor mid-turn
    // prompts: the agent edits files in the IDE, the working tree is
    // dirty, but `linesAdded` derives from a baseline-vs-HEAD diff that
    // doesn't see uncommitted edits the same way Claude's hook does.
    // Result: every prompt after Cursor's session-start landed with
    // `treeSha: null` and "No snapshot" disabled on the Restore button.
    //
    // Removing the outer gate and trusting createSnapshot's dedup gives
    // every code-changing prompt a tree ref — for every agent — without
    // re-introducing the empty-snapshot rows the gate was meant to
    // suppress.
    try {
      const cpId = createSnapshot(state.repoPath, {
        sessionTag: state.sessionTag,
        prompt: prompts.length > 0 ? prompts[prompts.length - 1] : undefined,
        model: model || state.model,
        tokensUsed: parsed.tokensUsed || 0,
        costUsd: costUsd || 0,
        promptIndex: prompts.length,
        type: 'auto',
        linesAdded: gitCapture.linesAdded || 0,
        linesRemoved: gitCapture.linesRemoved || 0,
        transcriptPath: state.transcriptPath,
      });
      if (cpId) {
        debugLog('stop', 'auto-snapshot created', {
          snapshotId: cpId,
          promptIndex: prompts.length,
          lines: (gitCapture.linesAdded || 0) + (gitCapture.linesRemoved || 0),
        });
      } else {
        debugLog('stop', 'auto-snapshot skipped by createSnapshot dedup (clean tree or unchanged from last)', {
          promptIndex: prompts.length,
        });
      }
    } catch (cpErr: any) {
      debugLog('stop', 'auto-snapshot failed (non-fatal)', { message: cpErr.message });
    }

    // Re-save state with RUNNING status FIRST so it survives any errors below
    state.status = 'RUNNING';
    saveSessionState(state, found!.saveCwd, state.sessionTag);

    // Write session files to origin-sessions branch + push on every Stop.
    // Pass promptEditsByIndex through so changes.json carries the
    // authoritative editsJson for each prompt — lets a different Origin
    // org importing this repo run AI Blame against the LCS-replay path
    // instead of falling back to block-matching pc.diff.
    try {
      const apiUrl = config?.apiUrl || 'https://getorigin.io';
      const writeData = buildSessionWriteData({
        state, parsed, promptMappings, gitCapture,
        status: 'running', apiUrl,
        promptEditsByIndex: promptEditsByIndex ?? undefined,
      });
      writeSessionFiles(state.repoPath, writeData);
      pushSessionBranch(state.repoPath);
      debugLog('stop', 'session files written + pushed', { prompts: writeData.prompts.length, costUsd: writeData.costUsd });
    } catch (gitErr: any) {
      debugLog('stop', 'session files write/push failed (non-fatal)', { message: gitErr.message });
    }

    // Update handoff context after each prompt stop (always fresh for next agent)
    try {
      const todos = extractTodosFromPrompts(prompts);
      writeHandoff(state.repoPath, {
        version: 1,
        sessionId: state.sessionId,
        agentSlug: agentSlug || 'unknown',
        model: model || state.model || 'unknown',
        endedAt: new Date().toISOString(),
        branch: getBranch(found!.saveCwd) || state.branch,
        prompts: prompts.map(p => p.slice(0, 500)),
        summary: parsed.summary || null,
        filesChanged,
        linesAdded: gitCapture.linesAdded || 0,
        linesRemoved: gitCapture.linesRemoved || 0,
        lastPrompt: (prompts[prompts.length - 1] || '').slice(0, 2000),
        lastResponse: null,
        openTodos: todos,
      });
    } catch {
      // Non-fatal
    }
  } catch (err: any) {
    debugLog('stop', 'ERROR', { message: err.message, stack: err.stack });
    process.stderr.write(`[origin] stop error: ${err.message}\n`);
  }
}

async function handleSessionEnd(input: Record<string, any>, agentSlug?: string): Promise<void> {
  // Many agents fire sessionEnd after each prompt/task, NOT on actual exit.
  // Treat it as an update (like Stop) so the session stays RUNNING.
  // The heartbeat daemon detects when the agent actually exits and ends the session.
  const agentsWithFakeSessionEnd = ['cursor', 'codex', 'claude-code'];
  if (agentsWithFakeSessionEnd.includes(agentSlug || '')) {
    debugLog('session-end', 'redirecting to handleStop (fake sessionEnd for this agent)', { agentSlug });
    return handleStop(input, agentSlug);
  }

  debugLog('session-end', 'begin', { cwd: input.cwd });

  const config = loadConfig();
  const connected = isConnectedMode();
  let hookCwd = input.cwd || process.cwd();
  // Cursor sends workspace_roots instead of cwd
  if (input.workspace_roots && Array.isArray(input.workspace_roots) && input.workspace_roots.length > 0) {
    const wsRoot = input.workspace_roots[0];
    if (typeof wsRoot === 'string' && getGitRoot(wsRoot)) {
      hookCwd = wsRoot;
    }
  }
  const found = findStateForHook(hookCwd, hookLookupSessionId(input.session_id, agentSlug), agentSlug);
  const state = found?.state || null;
  if (!state) {
    debugLog('session-end', 'ABORT: missing state', { hasConfig: !!config, hasState: !!state });
    return;
  }

  debugLog('session-end', 'state loaded', { sessionId: state.sessionId, promptCount: state.prompts.length });

  // Self-heal a local-only session before we try to end it — otherwise
  // api.endSession on a `local-` id 404s and the whole session is lost
  // from Origin (the exact "I don't see this session" gap).
  await ensureServerSession(state, found!.saveCwd, agentSlug, 'session-end');

  // Update transcript path if provided
  if (input.transcript_path) {
    state.transcriptPath = input.transcript_path;
  }

  // Auto-discover Gemini transcript path if not already set
  if (!state.transcriptPath) {
    const discovered = discoverGeminiTranscriptPath({
      sessionId: state.agentSessionId || state.claudeSessionId || undefined,
    });
    if (discovered) {
      state.transcriptPath = discovered;
      debugLog('session-end', 'auto-discovered transcript path', { discovered });
    }
  }

  try {
    const parsed = parseTranscript(state.transcriptPath, { since: state.startedAt });

    // Format transcript for dashboard display (converts JSONL → [{role, content}] JSON)
    let displayTranscript = formatTranscriptForDisplay(state.transcriptPath, { verbose: !!state.verboseCapture });
    debugLog('session-end', 'formatted transcript', { displayLength: displayTranscript.length });

    const prompts = parsed.prompts.length > 0 ? parsed.prompts : state.prompts;

    // For agents without transcripts (Codex, Gemini, etc.): synthesize
    // displayTranscript from captured prompts AND any assistant replies
    // captured at stop-time (Gemini's `prompt_response`).
    if (!displayTranscript && state.prompts.length > 0) {
      const turns: Array<{ role: string; content: string }> = [];
      if (state.agentSystemPrompt) {
        turns.push({ role: 'system', content: state.agentSystemPrompt });
      }
      const responses = state.promptResponses || [];
      for (let i = 0; i < state.prompts.length; i++) {
        turns.push({ role: 'user', content: state.prompts[i] });
        if (responses[i]) {
          turns.push({ role: 'assistant', content: responses[i] });
        }
      }
      displayTranscript = JSON.stringify(turns);
      debugLog('session-end', 'synthesized transcript from prompts', {
        turnCount: turns.length, responseCount: responses.filter(Boolean).length,
      });
    }

    // F9: Redact secrets before sending to API
    const config_ = loadConfig();
    const shouldRedact = config_?.secretRedaction !== false; // default: true
    const redactedPrompts = shouldRedact
      ? prompts.map(p => redactSecrets(p).redacted)
      : prompts;
    const joinedPrompt = redactedPrompts.join('\n\n---\n\n');

    const durationMs = Date.now() - new Date(state.startedAt).getTime();
    // Prefer: stdin model → transcript → state
    const stdinModel2 = (input.model && input.model !== 'default' && input.model !== 'unknown') ? input.model : '';
    const model = stdinModel2 || parsed.model || state.model;
    const costUsd = estimateCost(model, parsed.inputTokens, parsed.outputTokens, parsed.cacheReadTokens, parsed.cacheCreationTokens);

    // Capture real git state: HEAD SHA, new commits, unified diff. The
    // session-end snapshot powers AI Blame's full-file render, so capture
    // with unlimited unified context — every unchanged line ships as
    // context so the UI never has to fall back to "N lines hidden".
    const gitCapture = captureGitState(state.repoPath, state.headShaAtStart, { fullContext: true });

    // Extract prompt → file change mappings from transcript
    let promptMappings = extractPromptFileMappings(state.transcriptPath);

    // Fall back to git-captured files if transcript parsing didn't find any
    let filesChanged = parsed.filesChanged;
    if (filesChanged.length === 0 && gitCapture.commitDetails.length > 0) {
      const gitFiles = new Set<string>();
      for (const commit of gitCapture.commitDetails) {
        for (const f of commit.filesChanged) gitFiles.add(f);
      }
      filesChanged = Array.from(gitFiles);
      debugLog('session-end', 'using git-captured files (transcript had none)', { count: filesChanged.length });
    }

    // Multi-repo: capture session-level files from all repos
    if (state.repoPaths && state.repoPaths.length > 1 && state.perRepoState) {
      const multiRepoFiles = new Set<string>();
      for (const rp of state.repoPaths) {
        const rpState = state.perRepoState[rp];
        if (!rpState?.headShaAtStart) continue;
        try {
          const rpCapture = captureGitState(rp, rpState.headShaAtStart, { fullContext: true });
          const repoDir = path.basename(rp);
          for (const c of rpCapture.commitDetails) {
            for (const f of c.filesChanged) multiRepoFiles.add(`${repoDir}/${f}`);
          }
          if (rpCapture.uncommittedDiff) {
            for (const m of rpCapture.uncommittedDiff.matchAll(/^diff --git a\/(.*?) b\//gm)) {
              if (m[1]) multiRepoFiles.add(`${repoDir}/${m[1]}`);
            }
          }
        } catch { /* skip this repo */ }
      }
      if (multiRepoFiles.size > 0) {
        filesChanged = Array.from(multiRepoFiles);
        debugLog('session-end', 'multi-repo filesChanged', { count: filesChanged.length });
      }
    }

    // Capture diff for the last prompt if prePromptSha exists
    if (state.prePromptSha && prompts.length > 0) {
      const lastPromptIdx = prompts.length - 1;
      const lastPromptCapture = captureGitState(state.repoPath, state.prePromptSha, { fullContext: true });
      const lastFilesSet = new Set<string>();
      for (const c of lastPromptCapture.commitDetails) {
        for (const f of c.filesChanged) lastFilesSet.add(f);
      }
      if (lastPromptCapture.diff) {
        for (const m of lastPromptCapture.diff.matchAll(/^diff --git a\/(.*?) b\//gm)) {
          if (m[1]) lastFilesSet.add(m[1]);
        }
      }
      // Filter uncommitted diff against the prompt-baseline + session-start
      // pre-existing dirt union.
      const filteredUncommitted = filterUncommittedDiff(
        lastPromptCapture.uncommittedDiff || '', uncommittedExcludeUnion(state),
      );
      if (filteredUncommitted) {
        for (const m of filteredUncommitted.matchAll(/^diff --git a\/(.*?) b\//gm)) {
          if (m[1]) lastFilesSet.add(m[1]);
        }
      }
      if (lastPromptCapture.diff || filteredUncommitted || lastFilesSet.size > 0) {
        if (!state.completedPromptMappings) state.completedPromptMappings = [];
        // Scope committed side to commits this session authored (see
        // sessionScopedCommittedDiff).
        const sessionCommitted = sessionScopedCommittedDiff(state.repoPath, state);
        // Capture commit/tree SHAs so the commit-detail page can link the
        // last prompt to the commit it produced.
        let lastCommitSha: string | null = null;
        let lastTreeSha: string | null = null;
        try {
          lastCommitSha = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: state.repoPath, encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] }).trim();
        } catch { /* ignore */ }
        lastTreeSha = getWorkingTreeSha(state.repoPath);
        const lastMapping = {
          promptIndex: lastPromptIdx,
          promptText: (prompts[lastPromptIdx] || '').slice(0, 1000),
          filesChanged: Array.from(lastFilesSet),
          diff: ((sessionCommitted + (filteredUncommitted ? '\n' + filteredUncommitted : '')).trim()).slice(0, 200_000),
          uncommittedDiff: filteredUncommitted.slice(0, 200_000),
          commitSha: lastCommitSha,
          treeSha: lastTreeSha,
        };
        const existingIdx = state.completedPromptMappings.findIndex(m => m.promptIndex === lastPromptIdx);
        if (existingIdx >= 0) {
          state.completedPromptMappings[existingIdx] = lastMapping;
        } else {
          state.completedPromptMappings.push(lastMapping);
        }
        debugLog('session-end', 'captured last prompt diff', {
          promptIndex: lastPromptIdx, filesChanged: lastFilesSet.size,
        });
      }
    }

    // Merge transcript-based mappings with git-based completedPromptMappings
    {
      const savedMappings = state.completedPromptMappings || [];
      if (promptMappings.length > 0 && savedMappings.length > 0) {
        const transcriptIndices = new Set(promptMappings.map(pm => pm.promptIndex));
        const kept = savedMappings.filter(pm => !transcriptIndices.has(pm.promptIndex));
        promptMappings = [...kept, ...promptMappings];
      } else if (promptMappings.length === 0 && savedMappings.length > 0) {
        promptMappings = savedMappings;
      }
      debugLog('session-end', 'prompt mappings merged', {
        transcriptCount: extractPromptFileMappings(state.transcriptPath).length,
        savedCount: savedMappings.length,
        totalCount: promptMappings.length,
      });
    }

    // Hoisted so writeSessionFiles below the `if (connected)` block can
    // pass editsJson into changes.json (mirrors the stop-hook hoist).
    let promptEditsByIndex: Map<number, string> | null = null;

    if (connected) {
      debugLog('session-end', 'calling api.endSession', {
        sessionId: state.sessionId,
        promptCount: prompts.length,
        filesCount: filesChanged.length,
        tokensUsed: parsed.tokensUsed,
        inputTokens: parsed.inputTokens,
        outputTokens: parsed.outputTokens,
        durationMs,
        costUsd,
        hasDiff: !!gitCapture.diff,
        promptMappings: promptMappings.length,
      });

      // ─── New per-prompt PromptCapture pipeline ────────────────────────
      // Gemini (and any other agent that hits handleSessionEnd directly)
      // runs the agent-specific extractor here so each PromptChange row
      // carries editsJson — the server-side blame computes the displayed
      // diff and attribution from this directly.
      // `promptEditsByIndex` is declared at function scope above so the
      // writeSessionFiles call below `if (connected)` can also pick it up.
      try {
        const slug = (agentSlug || state.agentSlug || '').toLowerCase();
        const captureAgent =
          slug === 'codex' ? 'codex' :
          slug === 'cursor' ? 'cursor' :
          slug === 'gemini' ? 'gemini' :
          'claude';
        // Mirror the Codex codexPrompts wiring from handleStop so this
        // entry point (Gemini-shaped session end, occasionally Codex
        // when fakeSessionEnd kicks in) also feeds the extractor a
        // reliable per-prompt timeline.
        let codexPromptsForCapture: Array<{ text: string; timestamp: number }> | undefined;
        if (captureAgent === 'codex') {
          try {
            const codexThreadId = state.agentSessionId || state.claudeSessionId || undefined;
            const timeline = getCodexPromptsTimeline(state.repoPath, codexThreadId);
            if (timeline.length > 0) {
              codexPromptsForCapture = timeline.map((t) => ({
                text: t.text || '',
                timestamp: t.timestamp || 0,
              }));
            }
          } catch { /* non-fatal */ }
        }
        const transcriptCaptures = capturePromptEdits({
          agent: captureAgent,
          repoPath: state.repoPath,
          transcriptPath: state.transcriptPath,
          codexPrompts: codexPromptsForCapture,
          sessionCommitShas: state.sessionCommitShas || [],
          headShaAtStart: state.headShaAtStart || undefined,
          headShaAtEnd: gitCapture.headAfter || undefined,
        });
        const captures = applyLiveLedger(transcriptCaptures, state, 'session-end');
        if (captures.length > 0) {
          promptEditsByIndex = new Map();
          for (const cap of captures) {
            // Anchor transcript-only edits (e.g. Gemini) against the
            // final on-disk file; live edits are already positioned.
            if (state.repoPath) anchorEditPositions(cap.edits, state.repoPath);
            promptEditsByIndex.set(cap.promptIndex, JSON.stringify(cap));
          }
          debugLog('session-end', 'capturePromptEdits ok', {
            agent: captureAgent,
            captured: captures.length,
            totalEdits: captures.reduce((n, c) => n + c.edits.length, 0),
          });
        }
      } catch (capErr: unknown) {
        debugLog('session-end', 'capturePromptEdits failed (non-fatal)', {
          message: capErr instanceof Error ? capErr.message : String(capErr),
        });
      }

      await api.endSession({
        sessionId: state.sessionId,
        prompt: joinedPrompt || undefined,
        summary: parsed.summary || undefined,
        transcript: displayTranscript || undefined,
        // Upgrade the session's model to the real identifier resolved from
        // the transcript (e.g. "claude-opus-4-8"). session/start often only
        // had the bare brand ("claude"), so without this the commit list
        // shows "Claude · Claude" instead of "Claude · Opus 4.8". Only send
        // a specific model so we never downgrade a real value to the brand.
        model: isSpecificModel(model) ? model : undefined,
        filesChanged: filesChanged.length > 0 ? filesChanged : undefined,
        tokensUsed: parsed.tokensUsed > 0 ? parsed.tokensUsed : undefined,
        inputTokens: parsed.inputTokens > 0 ? parsed.inputTokens : undefined,
        outputTokens: parsed.outputTokens > 0 ? parsed.outputTokens : undefined,
        cacheReadTokens: parsed.cacheReadTokens > 0 ? parsed.cacheReadTokens : undefined,
        cacheCreationTokens: parsed.cacheCreationTokens > 0 ? parsed.cacheCreationTokens : undefined,
        toolCalls: parsed.toolCalls > 0 ? parsed.toolCalls : undefined,
        // See the stop handler — structured tool/files data so the PR-detail
        // "behind the work" view doesn't depend on transcript-text markers.
        toolBreakdown: parsed.toolBreakdown.length > 0 ? parsed.toolBreakdown : undefined,
        filesRead: mergeFilesRead(parsed.filesRead, state.filesRead),
        durationMs: durationMs > 0 ? durationMs : undefined,
        costUsd: costUsd > 0 ? costUsd : undefined,
        gitCapture: gitCapture.diff ? gitCapture : undefined,
        promptChanges: promptMappings.length > 0
          ? promptMappings.map(pm => ({
              ...pm,
              promptText: (pm.promptText || '').slice(0, 1000),
              diff: (pm.diff || '').slice(0, MAX_PROMPT_DIFF_LEN),
              editsJson: promptEditsByIndex?.get(pm.promptIndex) || undefined,
            }))
          : undefined,
        branch: getBranch(hookCwd) || undefined,
      });
      debugLog('session-end', 'api.endSession complete');
    }

    // Trail attachment is handled server-side at session/end now (see
    // services/trails.ts) — no CLI-side git-ref trail store to update.

    // Write session files to origin-sessions branch (directory per session).
    // Pass promptEditsByIndex so changes.json ships the authoritative
    // per-prompt edits — see the equivalent stop-hook block for rationale.
    const apiUrl = config?.apiUrl || 'https://getorigin.io';
    const writeData = buildSessionWriteData({
      state, parsed, promptMappings, gitCapture,
      status: 'ended', apiUrl,
      promptEditsByIndex: promptEditsByIndex ?? undefined,
    });
    writeSessionFiles(state.repoPath, writeData);
    pushSessionBranch(state.repoPath);
    debugLog('session-end', 'session files written + pushed');

    // Write Git Notes with AI attribution metadata on each commit
    if (gitCapture.commitShas.length > 0) {
      try {
        writeGitNotes(state.repoPath, gitCapture.commitShas, {
          sessionId: state.sessionId,
          model,
          agentSlug: agentSlug || state.agentSlug,
          promptCount: prompts.length,
          promptSummary: prompts[0] || '',
          fullPrompt: prompts[prompts.length - 1] || prompts[0] || undefined,
          previousSessionId: state.previousSessionId,
          filesRead: state.filesRead,
          prompts: buildPromptNoteEntries(state, agentSlug || state.agentSlug, model, promptEditsByIndex),
          tokensUsed: parsed.tokensUsed,
          costUsd,
          durationMs,
          linesAdded: gitCapture.linesAdded,
          linesRemoved: gitCapture.linesRemoved,
          originUrl: `${apiUrl}/sessions/${state.sessionId}`,
        });
        debugLog('session-end', 'git notes written', { commitCount: gitCapture.commitShas.length });
      } catch (err: any) {
        debugLog('session-end', 'git notes error (non-fatal)', { message: err.message });
      }
    }

    // Backfill acceptance for the *previous* session's commits. Now that
    // this session has ended, any of the prior session's lines that were
    // overwritten (or kept) here will be reflected. Writes to a separate
    // ref (refs/notes/origin-acceptance) so original notes stay immutable.
    if (state.previousSessionId) {
      try {
        const written = backfillAcceptanceForSession(state.repoPath, state.previousSessionId, {
          sinceIso: state.previousSessionStartedAt,
        });
        if (written > 0) {
          debugLog('session-end', 'acceptance backfill written', {
            previousSessionId: state.previousSessionId,
            commitsAnnotated: written,
          });
        }
      } catch (err: any) {
        debugLog('session-end', 'acceptance backfill error (non-fatal)', { message: err.message });
      }
    }

    // Write cross-agent handoff context for next session
    try {
      const todos = extractTodosFromPrompts(prompts);
      writeHandoff(state.repoPath, {
        version: 1,
        sessionId: state.sessionId,
        agentSlug: agentSlug || 'unknown',
        model,
        endedAt: new Date().toISOString(),
        branch: getBranch(hookCwd) || state.branch,
        prompts: prompts.map(p => p.slice(0, 500)),
        summary: parsed.summary || null,
        filesChanged,
        linesAdded: gitCapture.linesAdded,
        linesRemoved: gitCapture.linesRemoved,
        lastPrompt: (prompts[prompts.length - 1] || '').slice(0, 2000),
        lastResponse: null, // Could extract from transcript later
        openTodos: todos,
      });
      debugLog('session-end', 'handoff written', { filesCount: filesChanged.length, todosCount: todos.length });
    } catch (err: any) {
      debugLog('session-end', 'handoff write error (non-fatal)', { message: err.message });
    }

    // Write session memory entry for repo history
    try {
      const todos = extractTodosFromPrompts(prompts);
      writeSessionMemory(state.repoPath, {
        sessionId: state.sessionId,
        agentSlug: agentSlug || 'unknown',
        model,
        startedAt: state.startedAt,
        endedAt: new Date().toISOString(),
        branch: getBranch(hookCwd) || state.branch,
        summary: parsed.summary || prompts[0]?.slice(0, 200) || 'No summary',
        filesChanged,
        promptCount: prompts.length,
        linesAdded: gitCapture.linesAdded,
        linesRemoved: gitCapture.linesRemoved,
        openTodos: todos,
      });
      debugLog('session-end', 'session memory written');
    } catch (err: any) {
      debugLog('session-end', 'session memory error (non-fatal)', { message: err.message });
    }

    // Extract and store TODOs from prompts
    try {
      const todosAdded = addTodosFromSession(
        state.sessionId, prompts, state.repoPath,
        getBranch(hookCwd) || state.branch,
      );
      if (todosAdded > 0) {
        debugLog('session-end', 'todos extracted', { count: todosAdded });
      }
    } catch {
      // Non-fatal
    }
  } catch (err: any) {
    debugLog('session-end', 'ERROR', { message: err.message, stack: err.stack });
    process.stderr.write(`[origin] session-end error: ${err.message}\n`);

    // Even if transcript parsing or other steps fail, still mark the session as ended
    // so it doesn't stay RUNNING forever on the dashboard.
    if (connected) {
      try {
        const durationMs = Date.now() - new Date(state.startedAt).getTime();
        await api.endSession({
          sessionId: state.sessionId,
          prompt: state.prompts.join('\n\n---\n\n') || undefined,
          durationMs: durationMs > 0 ? durationMs : undefined,
          branch: getBranch(hookCwd) || undefined,
        });
        debugLog('session-end', 'fallback endSession succeeded');
      } catch (fallbackErr: any) {
        debugLog('session-end', 'fallback endSession also failed', { message: fallbackErr.message });
      }
    }
  } finally {
    // Final session-end snapshot removed. By the time we reach here the
    // post-commit hook has already condensed the per-commit snapshots; an
    // additional "session-end" row at this point captures whatever happens
    // to be in the working tree — which for sessions that ended without a
    // final commit is just unstaged scratch. Keeping it created the empty
    // rows the user reported in the snapshots list. The condensation /
    // shadow-cleanup below still runs.

    // Condense all session snapshots to permanent branch + clean up shadow branch
    try {
      const headSha = getHeadSha(state.repoPath) || 'unknown';
      const { condensed, cleaned } = condenseAndCleanupSession(
        state.repoPath,
        state.sessionTag || '',
        headSha,
        state.transcriptPath,
      );
      debugLog('session-end', 'snapshots condensed + shadow cleaned', { condensed, cleaned });
    } catch (cpErr: any) {
      debugLog('session-end', 'snapshot condensation failed (non-fatal)', { message: cpErr.message });
    }

    // Stop the heartbeat daemon
    stopHeartbeat(state.sessionId);
    debugLog('session-end', 'heartbeat stopped', { sessionId: state.sessionId });

    // Clear only THIS session's state file (tagged), not other concurrent sessions
    const saveCwd = found?.saveCwd || hookCwd;
    clearSessionState(saveCwd, state.sessionTag);
    debugLog('session-end', 'state cleared', { tag: state.sessionTag, saveCwd });
  }
}

// ─── Git Hook: Post-Commit ────────────────────────────────────────────────

/**
 * Pick, among several concurrently-active sessions the post-commit hook
 * couldn't tell apart by agent process, the one whose recorded edits best
 * overlap the committed files. Recency-weighted: the latest prompt's files
 * count ×3, the last three ×2, older ×1 — so the session that JUST edited
 * what landed in the commit wins, even if an older session touched the same
 * files earlier. Returns null when no session's edits overlap (caller then
 * declines to guess). Matches on basename so repo-relative vs absolute paths
 * in the two sources still line up.
 */
export function pickSessionByFileOverlap<
  T extends { completedPromptMappings?: Array<{ filesChanged?: string[] }> },
>(candidates: T[], commitFiles: string[]): T | null {
  if (candidates.length === 0 || commitFiles.length === 0) return null;
  const baseOf = (f: string): string => f.split('/').pop() || f;
  const commitBasenames = new Set(commitFiles.map(baseOf));
  let best: T | null = null;
  let bestScore = 0;
  for (const s of candidates) {
    const mappings = s.completedPromptMappings || [];
    let score = 0;
    for (let i = 0; i < mappings.length; i++) {
      const fromEnd = mappings.length - 1 - i;
      const weight = fromEnd === 0 ? 3 : fromEnd < 3 ? 2 : 1;
      for (const f of (mappings[i].filesChanged || [])) {
        if (commitBasenames.has(baseOf(f))) score += weight;
      }
    }
    if (score > bestScore) { bestScore = score; best = s; }
  }
  return bestScore > 0 ? best : null;
}

/**
 * Called by .git/hooks/post-commit after every commit.
 * Sends incremental session data to the API so nothing is lost
 * even if the AI session never formally ends.
 */
export async function handlePostCommit(): Promise<void> {
  debugLog('post-commit', '=== GIT HOOK INVOKED ===', { pid: process.pid, cwd: process.cwd() });

  const config = loadConfig();
  const connected = isConnectedMode();

  const hookCwd = process.cwd();
  const repoPath = getGitRoot(hookCwd);
  if (!repoPath) {
    debugLog('post-commit', 'SKIP: not a git repo');
    return;
  }

  // Get latest commit info. Run git in hookCwd, NOT repoPath: getGitRoot
  // collapses a linked worktree to the main repo, whose HEAD is a different
  // commit than the one just made in the worktree. Git runs this hook from
  // the top of the working tree where the commit happened, so hookCwd always
  // resolves the right HEAD; sha-addressed commands work from either since
  // worktrees share the object store.
  const execOpts = { encoding: 'utf-8' as const, cwd: hookCwd, stdio: ['pipe', 'pipe', 'pipe'] as ['pipe', 'pipe', 'pipe'] };
  let commitSha: string, commitMessage: string, commitAuthor: string;
  try {
    commitSha = execFileSync('git', ['rev-parse', 'HEAD'], execOpts).trim();
    commitMessage = execFileSync('git', ['log', '-1', '--format=%s'], execOpts).trim();
    commitAuthor = execFileSync('git', ['log', '-1', '--format=%an'], execOpts).trim();
  } catch (err: any) {
    debugLog('post-commit', 'ERROR: cannot read commit', { message: err.message });
    return;
  }

  debugLog('post-commit', 'commit info', { commitSha, commitMessage, commitAuthor });

  // Validate commitSha is a hex string to prevent shell injection
  if (!/^[a-fA-F0-9]+$/.test(commitSha)) {
    debugLog('post-commit', 'SKIP: invalid commit SHA', { commitSha });
    return;
  }

  // Get files changed in this commit
  let filesChanged: string[] = [];
  try {
    const raw = execFileSync('git', ['diff-tree', '--no-commit-id', '--name-only', '-r', commitSha], execOpts).trim();
    filesChanged = raw ? raw.split('\n').filter(Boolean) : [];
  } catch { /* ignore */ }

  // Get diff for this single commit. Try three strategies in order:
  //   1. `git diff <sha>~1..<sha>` — fast, works for non-root commits.
  //   2. `git diff-tree -p --root <sha>` — uses the commit's own parent
  //      pointers (no `~1` lookup), so survives detached HEAD / shallow
  //      / weird-ref scenarios where (1) errors silently with empty stdout.
  //   3. `git show <sha> --format=` — last-resort, handles merge commits.
  // The CLI used to give up after (1) and (3) when (1) returned empty
  // stdout without throwing (some Codex worktrees do this on freshly
  // created branches), so commit.patch stayed NULL and the dashboard
  // had to fall back to the session-level aggregate.
  let diff = '';
  try {
    diff = execFileSync('git', ['diff', `${commitSha}~1..${commitSha}`], execOpts).trim();
  } catch { /* try fallback below */ }
  if (!diff) {
    try {
      diff = execFileSync('git', ['diff-tree', '-p', '--root', '--no-color', commitSha], execOpts).trim();
    } catch { /* try fallback below */ }
  }
  if (!diff) {
    try {
      diff = execFileSync('git', ['show', commitSha, '--format=', '--diff-merges=first-parent'], execOpts).trim();
    } catch { /* give up — commit.patch stays null and the dashboard falls back */ }
  }
  if (!diff) {
    debugLog('post-commit', 'WARN: empty per-commit diff after all three strategies', { commitSha });
  }

  // Count lines
  let linesAdded = 0, linesRemoved = 0;
  if (diff) {
    for (const line of diff.split('\n')) {
      if (line.startsWith('+') && !line.startsWith('+++')) linesAdded++;
      if (line.startsWith('-') && !line.startsWith('---')) linesRemoved++;
    }
  }

  // Detect current branch (may have changed since session started)
  const currentBranch = getBranch(hookCwd);

  // Add Origin-Session trailer to commit message (like Entire's Entire-Snapshot trailer)
  const apiUrl = config?.apiUrl || 'https://getorigin.io';

  // ── Shadow-sync: post commit metadata to API regardless of session state ──
  // The session-aware path below only fires when an Origin session was active
  // for this commit. That misses: (a) commits made by AI without Origin
  // running, (b) plain human commits, (c) commits done while the heartbeat
  // process had died. Without shadow-sync the dashboard's repo view stays
  // empty until `git push` triggers the GitHub/GitLab webhook. Fire-and-
  // forget so a slow API call doesn't hold up the user's commit.
  if (connected) {
    try {
      let repoUrl: string | undefined;
      try {
        repoUrl = execFileSync('git', ['config', '--get', 'remote.origin.url'], execOpts).trim() || undefined;
      } catch { /* no remote, fine */ }
      const committedAtIso = (() => {
        try {
          return execFileSync('git', ['log', '-1', '--format=%cI'], execOpts).trim() || undefined;
        } catch { return undefined; }
      })();
      api.ingestCommits({
        repoPath,
        repoUrl,
        commits: [{
          sha: commitSha,
          message: commitMessage,
          author: commitAuthor,
          branch: currentBranch || null,
          filesChanged,
          additions: linesAdded,
          deletions: linesRemoved,
          committedAt: committedAtIso,
          // Per-commit unified diff so commit-detail can show what THIS
          // commit changed instead of the session aggregate. Capped at
          // 500KB to stay sane on accidental large commits.
          diff: diff ? diff.slice(0, 500_000) : undefined,
        }],
      })
        .then((r) => debugLog('post-commit', 'shadow ingest ok', { ingested: r?.ingested, repoId: r?.repoId }))
        .catch((err: any) => debugLog('post-commit', 'shadow ingest failed (non-fatal)', { message: err?.message }));
    } catch (err: any) {
      debugLog('post-commit', 'shadow ingest setup failed', { message: err?.message });
    }
  }

  // Get ALL active sessions for this repo (concurrent session support).
  // Worktree-aware: falls back to the main repo's state files when the hook
  // runs inside a linked worktree, then narrows by last-seen lifecycle cwd
  // so a sibling session in another worktree isn't credited with this commit.
  const activeSessions = listSessionsForGitHook(hookCwd);
  activeSessions.sort((a, b) => new Date(b.startedAt).getTime() - new Date(a.startedAt).getTime());

  // Pick the correct session — use process detection to disambiguate when multiple are active
  let state: SessionState | null = null;
  if (activeSessions.length === 1) {
    state = activeSessions[0];
  } else if (activeSessions.length > 1) {
    // Detect which agent made this commit via process detection
    let detectedSlug: string | null = null;
    const agentChecks = [
      { cmd: 'pgrep -f "claude.*stream-json"', slug: 'claude' },
      { cmd: 'pgrep -f "gemini.*cli|/gemini "', slug: 'gemini' },
      { cmd: 'pgrep -f "codex"', slug: 'codex' },
      { cmd: 'pgrep -f "aider"', slug: 'aider' },
      { cmd: 'pgrep -f "windsurf"', slug: 'windsurf' },
      { cmd: 'pgrep -f "copilot.*cli|github-copilot"', slug: 'copilot' },
      { cmd: 'pgrep -f "continue.*dev"', slug: 'continue' },
      { cmd: 'pgrep -f "amp.*cli|/amp "', slug: 'amp' },
      { cmd: 'pgrep -f "junie|jetbrains.*ai"', slug: 'junie' },
      { cmd: 'pgrep -f "opencode"', slug: 'opencode' },
      { cmd: 'pgrep -f "rovo.*dev"', slug: 'rovo' },
      { cmd: 'pgrep -f "droid"', slug: 'droid' },
    ];
    for (const check of agentChecks) {
      try {
        if (safePgrep(check.cmd)) {
          detectedSlug = check.slug;
          break;
        }
      } catch { /* no match */ }
    }

    // Narrow to the agent that made this commit. When process detection
    // matches exactly one session, that's our answer. When it matches
    // several (e.g. two concurrent Gemini sessions in the same repo) — or
    // doesn't fire at all — fall through to the file-overlap tiebreak below
    // rather than blindly taking the first.
    let candidates = activeSessions;
    if (detectedSlug) {
      const matched = activeSessions.filter(s => sessionMatchesAgent(s, detectedSlug!));
      if (matched.length > 0) candidates = matched;
    }
    if (candidates.length === 1) {
      state = candidates[0];
      debugLog('post-commit', 'matched single candidate session', { detectedSlug, sessionId: state.sessionId, model: state.model });
    } else if (candidates.length > 1 && filesChanged.length > 0) {
      // Multiple same-agent sessions are active and process detection can't
      // tell them apart. Attribute the commit to the session whose RECENT
      // edits overlap the committed files — the committing session is the
      // one that just edited what landed in the commit. Without this we'd
      // take an arbitrary (newest-started) session and credit the commit to
      // the wrong agent, surfacing as a false "uncommitted" badge on the
      // session that actually did the work (user-reported: a Gemini commit
      // attributed to a sibling Gemini session running in the same repo).
      const best = pickSessionByFileOverlap(candidates, filesChanged);
      if (best) {
        state = best;
        debugLog('post-commit', 'disambiguated by file overlap', { sessionId: best.sessionId, model: best.model });
      }
    }

    // If neither process detection nor file overlap narrowed it down, don't guess.
    if (!state) {
      debugLog('post-commit', 'multiple sessions active, could not disambiguate', {
        totalSessions: activeSessions.length,
        sessionModels: activeSessions.map(s => ({ id: s.sessionId, model: s.model })),
      });
    }
  }

  // If no active session AND no sessions were found at all, detect AI agent process.
  // Only do this when there are truly zero sessions — if sessions exist but couldn't
  // be disambiguated, we already warned above and shouldn't guess via pgrep.
  if (!state && activeSessions.length === 0) {
    let detectedModel: string | null = null;
    try {
      // Use pgrep for targeted process detection — look for CLI binaries only,
      // not desktop apps (Cursor/VS Code have many helper processes that would match)
      const checks = [
        { cmd: 'pgrep -f "gemini.*cli|bin/gemini"', model: 'gemini' },
        { cmd: 'pgrep -f "claude.*stream-json"', model: 'claude' },
        { cmd: 'pgrep -f "codex"', model: 'codex' },
        { cmd: 'pgrep -f "bin/aider|aider.*--model"', model: 'aider' },
        { cmd: 'pgrep -f "copilot.*cli|github-copilot"', model: 'copilot' },
        { cmd: 'pgrep -f "amp.*cli|/amp "', model: 'amp' },
        { cmd: 'pgrep -f "opencode"', model: 'opencode' },
      ];
      for (const check of checks) {
        try {
          if (safePgrep(check.cmd)) {
            detectedModel = check.model;
            break;
          }
        } catch { /* pgrep exits 1 if no match */ }
      }
    } catch { /* ignore */ }

    if (detectedModel) {
      debugLog('post-commit', 'no active session but detected AI process', { detectedModel });
      // Create a synthetic state so notes get tagged as AI
      state = {
        sessionId: `detected-${detectedModel}-${Date.now().toString(36)}`,
        model: detectedModel,
        startedAt: new Date().toISOString(),
      } as any;
    }
  }

  // Attribute this commit to the picked session so future diff computations
  // can scope `committedDiff` to commits this session actually authored.
  // Without this, a heartbeat in session A computes `git diff prePromptSha
  // ...HEAD` and picks up commits made by concurrently-running session B
  // (HEAD has moved past A's commits), then credits B's work to A in AI
  // Blame. Persisted to state file so heartbeat / user-prompt-submit /
  // session-end snapshots can all read it.
  if (state && state.sessionTag) {
    if (!state.sessionCommitShas) state.sessionCommitShas = [];
    if (!state.sessionCommitShas.includes(commitSha)) {
      state.sessionCommitShas.push(commitSha);
      try {
        saveSessionState(state, state.repoPath || hookCwd, state.sessionTag);
      } catch { /* non-fatal */ }
      debugLog('post-commit', 'recorded commit on session', {
        sessionId: state.sessionId, commitSha: commitSha.slice(0, 8),
        totalForSession: state.sessionCommitShas.length,
      });
    }
  }

  // Update branch + accumulate filesChanged on all active sessions
  for (const s of activeSessions) {
    let changed = false;
    if (currentBranch && currentBranch !== s.branch) {
      debugLog('post-commit', 'branch changed', { from: s.branch, to: currentBranch, sessionId: s.sessionId });
      s.branch = currentBranch;
      changed = true;
    }
    // Accumulate files changed in session state so standalone sessions show file counts
    if (filesChanged.length > 0) {
      const existing = new Set((s as any).filesChanged || []);
      for (const f of filesChanged) existing.add(f);
      (s as any).filesChanged = Array.from(existing);
      (s as any).linesAdded = ((s as any).linesAdded || 0) + linesAdded;
      (s as any).linesRemoved = ((s as any).linesRemoved || 0) + linesRemoved;
      (s as any).commitCount = ((s as any).commitCount || 0) + 1;
      changed = true;
    }
    if (changed) {
      saveSessionState(s, s.repoPath || hookCwd, s.sessionTag);
    }
  }

  // F13: Respect config.commitLinking setting (always|prompt|never)
  const commitLinkingConfig = config?.commitLinking || 'always';

  // Condense active snapshots to permanent storage + add bidirectional linking
  let latestSnapshotId: string | undefined;
  if (state && state.sessionTag) {
    try {
      const snapshots = listSnapshots(repoPath, state.sessionTag);
      if (snapshots.length > 0) {
        const latest = snapshots[snapshots.length - 1];
        latestSnapshotId = latest.id;
        // Condense to permanent orphan branch with transcript (like Entire's entire/snapshots/v1)
        condenseSnapshot(repoPath, latest.id, latest, commitSha, state.transcriptPath);
        debugLog('post-commit', 'condensed snapshot to permanent branch', { snapshotId: latest.id, hasTranscript: !!state.transcriptPath });
      }
    } catch (cpErr: any) {
      debugLog('post-commit', 'snapshot condensation failed (non-fatal)', { message: cpErr.message });
    }
  }

  // Trailer insertion moved to prepare-commit-msg (see handlePrepareCommitMsg).
  // Writing trailers via `git commit --amend --no-verify` was removed because:
  //   1. Amend mutates the commit SHA, which creates divergence for pushed commits.
  //   2. --no-verify skips the pre-commit secret scanner.
  //   3. Amend breaks GPG signatures unless re-signed (which --no-verify doesn't do).
  // The trailer is now part of the commit from the moment git creates it.

  // Write git notes on this commit immediately
  // If model is missing/unknown, try pgrep detection as fallback
  let noteModel = state?.model || '';
  if (!noteModel || noteModel === 'unknown') {
    try {
      const fallbackChecks = [
        { cmd: 'pgrep -f "claude.*stream-json"', model: 'claude' },
        { cmd: 'pgrep -f "gemini.*cli|/gemini "', model: 'gemini' },
        { cmd: 'pgrep -f "codex"', model: 'codex' },
        { cmd: 'pgrep -f "aider"', model: 'aider' },
        { cmd: 'pgrep -f "windsurf"', model: 'windsurf' },
        { cmd: 'pgrep -f "copilot.*cli|github-copilot"', model: 'copilot' },
        { cmd: 'pgrep -f "amp.*cli|/amp "', model: 'amp' },
      ];
      for (const check of fallbackChecks) {
        try {
          if (safePgrep(check.cmd)) {
            noteModel = check.model;
            break;
          }
        } catch { /* no match */ }
      }
    } catch { /* ignore */ }
  }

  try {
    writeGitNotes(repoPath, [commitSha], {
      sessionId: state?.sessionId || 'unknown',
      model: noteModel || 'unknown',
      agentSlug: state?.agentSlug,
      promptCount: state?.prompts?.length || 0,
      promptSummary: state?.prompts?.[state.prompts.length - 1] || '',
      fullPrompt: state?.prompts?.[state.prompts.length - 1] || undefined,
      previousSessionId: state?.previousSessionId,
      filesRead: state?.filesRead,
      prompts: state ? buildPromptNoteEntries(state, state.agentSlug, noteModel || state.model) : undefined,
      tokensUsed: 0,
      costUsd: 0,
      durationMs: 0,
      linesAdded,
      linesRemoved,
      originUrl: state ? `${apiUrl}/sessions/${state.sessionId}` : '',
      snapshot: true,
      snapshotAt: new Date().toISOString(),
      filesChanged,
    });
    debugLog('post-commit', 'git notes written');
  } catch (err: any) {
    debugLog('post-commit', 'git notes error (non-fatal)', { message: err.message });
  }

  // Send incremental update to ALL active sessions (concurrent support).
  //
  // For the SessionDiff (what powers AI Blame "By File"), recapture the
  // session-to-date diff with full file context so the dashboard renders
  // whole files instead of "N lines hidden" gaps. Sent as snapshot:true so
  // the server REPLACES sessionDiff with this canonical state — matches what
  // the session-end stop hook already does (see line ~3808 / ~4167), just
  // refreshed every commit instead of only at session end.
  if (activeSessions.length > 0) {
    let sessionToDateDiff = '';
    let sessionLinesAdded = linesAdded;
    let sessionLinesRemoved = linesRemoved;
    if (state?.headShaAtStart && state.headShaAtStart !== commitSha) {
      try {
        // hookCwd, not repoPath: the session-to-date diff must read the
        // committing working tree's HEAD (worktree-safe, see execOpts above).
        const snap = captureGitState(hookCwd, state.headShaAtStart, { fullContext: true });
        if (snap.committedDiff) {
          sessionToDateDiff = snap.committedDiff;
          sessionLinesAdded = snap.linesAdded || linesAdded;
          sessionLinesRemoved = snap.linesRemoved || linesRemoved;
        }
      } catch (err: any) {
        debugLog('post-commit', 'fullContext snapshot failed (non-fatal)', { message: err?.message });
      }
    }
    const gitCapture: {
      headBefore: string; headAfter: string; commitShas: string[];
      commitDetails: Array<{ sha: string; message: string; author: string; filesChanged: string[] }>;
      diff: string; diffTruncated: boolean; linesAdded: number; linesRemoved: number;
      snapshot?: boolean;
    } = sessionToDateDiff
      ? {
          headBefore: state?.headShaAtStart || commitSha,
          headAfter: commitSha,
          commitShas: [commitSha],
          commitDetails: [{ sha: commitSha, message: commitMessage, author: commitAuthor, filesChanged }],
          diff: sessionToDateDiff.length > 500_000 ? sessionToDateDiff.slice(0, 500_000) : sessionToDateDiff,
          diffTruncated: sessionToDateDiff.length > 500_000,
          linesAdded: sessionLinesAdded,
          linesRemoved: sessionLinesRemoved,
          snapshot: true,
        }
      : {
          headBefore: (state?.headShaAtStart) || commitSha,
          headAfter: commitSha,
          commitShas: [commitSha],
          commitDetails: [{ sha: commitSha, message: commitMessage, author: commitAuthor, filesChanged }],
          diff: diff.length > 500_000 ? diff.slice(0, 500_000) : diff,
          diffTruncated: diff.length > 500_000,
          linesAdded,
          linesRemoved,
        };

    // Resolve the commit's timestamp once, outside the per-session loop.
    // resolvePromptForCommit() uses it to match the commit to the prompt
    // that most likely produced it (Codex/Gemini path).
    let commitTimestampMs = Date.now();
    try {
      const iso = execFileSync('git', ['log', '-1', '--format=%cI', commitSha], execOpts).trim();
      const parsed = iso ? new Date(iso).getTime() : NaN;
      if (Number.isFinite(parsed)) commitTimestampMs = parsed;
    } catch { /* fall back to wallclock */ }

    if (connected) {
      for (const s of activeSessions) {
        // Pick the prompt this commit belongs to. Claude path uses
        // s.prompts (populated on user-prompt-submit). Codex/Gemini have
        // no submit hook — resolvePromptForCommit walks their transcript
        // and picks the latest prompt timestamped at-or-before this
        // commit. Fixes "all commits attributed to prompt #1" for
        // Codex sessions with multiple prompts.
        const resolved = resolvePromptForCommit(s, repoPath, commitTimestampMs);
        const latestPromptIdx = resolved.promptIndex;
        const latestPromptText = resolved.promptText;
        const perPromptUpdate = {
          promptIndex: latestPromptIdx,
          promptText: latestPromptText.slice(0, 1000),
          filesChanged,
          diff: diff.length > MAX_PROMPT_DIFF_LEN ? diff.slice(0, MAX_PROMPT_DIFF_LEN) : diff,
          linesAdded,
          linesRemoved,
          commitSha,
        };
        try {
          debugLog('post-commit', 'sending incremental update', {
            sessionId: s.sessionId,
            filesChanged: filesChanged.length,
            attributedPromptIdx: latestPromptIdx,
            commitSha,
          });
          await api.updateSession(s.sessionId, {
            filesChanged: filesChanged.length > 0 ? filesChanged : undefined,
            branch: currentBranch || undefined,
            gitCapture,
            promptChanges: latestPromptText ? [perPromptUpdate] : undefined,
          });
          debugLog('post-commit', 'API update complete', { sessionId: s.sessionId });
        } catch (err: any) {
          debugLog('post-commit', 'API update error (non-fatal)', { sessionId: s.sessionId, message: err.message });
        }
      }
    }
  } else {
    debugLog('post-commit', 'no active sessions, skipped API update');
  }

  // Write full session entrypoint to origin-sessions branch on every commit
  // Parse transcript for full metrics (if available) so we capture tokens, cost, prompts, files
  // For agents without transcripts (e.g. Gemini), still write git data (files, lines)
  if (state && !state.sessionId.startsWith('detected-')) {
    const durationMs = Date.now() - new Date(state.startedAt).getTime();

    // Parse transcript for full metrics (or use empty defaults for agents without transcripts)
    const parsed = state.transcriptPath
      ? parseTranscript(state.transcriptPath, { since: state.startedAt })
      : { prompts: [], filesChanged: [], tokensUsed: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0, toolCalls: 0, toolBreakdown: [], filesRead: [], summary: '', model: '', transcript: '' };
    const promptMappings = state.transcriptPath
      ? extractPromptFileMappings(state.transcriptPath)
      : [];
    const writeData = buildSessionWriteData({
      state, parsed, promptMappings,
      gitCapture: {
        headBefore: state.headShaAtStart || commitSha,
        headAfter: commitSha,
        commitShas: [commitSha],
        linesAdded,
        linesRemoved,
      },
      status: 'running', apiUrl,
      extraFiles: filesChanged,
    });
    writeSessionFiles(repoPath, writeData);
    pushSessionBranch(repoPath);
    debugLog('post-commit', 'session files written + pushed', {
      prompts: writeData.prompts.length,
      costUsd: writeData.costUsd,
      files: writeData.filesChanged.length,
    });
  }

  debugLog('post-commit', '=== GIT HOOK COMPLETE ===');
}

// ─── Pre-Tool-Use / Post-Tool-Use (F7: Subagent Tracking) ─────────────────

// ── Policy Enforcement Helpers ────────────────────────────────────────────

function matchGlob(pattern: string, filepath: string): boolean {
  const escaped = pattern
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*\*/g, '<<<GLOBSTAR>>>')
    .replace(/\*/g, '[^/]*')
    .replace(/<<<GLOBSTAR>>>/g, '.*')
    .replace(/\?/g, '.');
  return new RegExp(`^${escaped}$`).test(filepath);
}

/**
 * Extract file paths from tool input across different agents.
 * Claude: { file_path, command (grep for paths) }
 * Gemini: { path, file_path, command }
 */
function extractFilePaths(toolName: string, toolInput: Record<string, any>): string[] {
  const paths: string[] = [];

  // Direct file path fields (Read, Write, Edit tools)
  for (const key of ['file_path', 'path', 'filePath', 'filename', 'file']) {
    if (typeof toolInput[key] === 'string' && toolInput[key]) {
      paths.push(toolInput[key]);
    }
  }

  // Bash/shell commands — extract paths from common file operations
  const cmd = toolInput.command || toolInput.cmd || toolInput.script || '';
  if (typeof cmd === 'string' && cmd) {
    // Match common file access patterns: cat, less, head, tail, vim, nano, code, read, source
    const fileOps = /(?:cat|less|head|tail|vim|nano|code|source|rm|mv|cp|chmod|chown)\s+(?:-[a-zA-Z]*\s+)*([^\s|>&;]+)/g;
    let m;
    while ((m = fileOps.exec(cmd)) !== null) {
      if (m[1] && !m[1].startsWith('-')) paths.push(m[1]);
    }
  }

  return paths;
}

function enforceFileRestrictions(
  rules: Array<{
    type: string; condition: string; action: string; severity: string;
    policyId?: string; ruleId?: string; policyName?: string;
  }>,
  filePaths: string[],
  repoPath: string,
): { blocked: boolean; reason: string; file: string; policyId?: string; policyName?: string } | null {
  if (!rules || rules.length === 0 || filePaths.length === 0) return null;

  for (const rule of rules) {
    if (rule.type !== 'FILE_RESTRICTION') continue;
    if (rule.action.toUpperCase() !== 'BLOCK') continue;

    let cond: Record<string, unknown>;
    try { cond = JSON.parse(rule.condition); } catch { continue; }
    const pattern = cond.path as string | undefined;
    if (!pattern) continue;

    for (const fp of filePaths) {
      // Normalize: try both absolute and relative-to-repo
      const relPath = fp.startsWith('/') && repoPath
        ? fp.replace(repoPath + '/', '').replace(repoPath, '')
        : fp;
      const candidates = [fp, relPath, relPath.replace(/^\//, '')];

      for (const candidate of candidates) {
        if (matchGlob(pattern, candidate)) {
          return {
            blocked: true,
            reason: `[Origin Policy] Blocked: file "${candidate}" matches restricted pattern "${pattern}"`,
            file: candidate,
            policyId: rule.policyId,
            policyName: rule.policyName,
          };
        }
      }
    }
  }

  return null;
}

/**
 * Lazy multi-repo attribution.
 *
 * Resolves each file path to its containing git repo. If any path lives in
 * a repo that isn't yet attached to this session, notifies the API to attach
 * it and tracks per-repo git state locally. This is how we pick up sibling
 * repos the agent actually touches — without blindly attaching every repo
 * under the cwd at session-start.
 */
async function attachReposForFiles(
  state: SessionState,
  filePaths: string[],
  saveCwd: string,
): Promise<void> {
  if (!filePaths.length) return;
  if (!state.sessionId || state.sessionId.startsWith('local-')) return;
  if (!isConnectedMode()) return;

  const attached = new Set<string>();
  if (state.repoPath) attached.add(state.repoPath);
  for (const rp of state.repoPaths || []) attached.add(rp);

  const newRoots = new Set<string>();
  for (const fp of filePaths) {
    if (!fp) continue;
    const abs = path.isAbsolute(fp) ? fp : path.resolve(state.repoPath || saveCwd, fp);
    let dir: string;
    try {
      dir = fs.statSync(abs).isDirectory() ? abs : path.dirname(abs);
    } catch {
      dir = path.dirname(abs);
    }
    const root = getGitRoot(dir);
    if (!root || attached.has(root) || newRoots.has(root)) continue;
    newRoots.add(root);
  }
  if (newRoots.size === 0) return;

  let mutated = false;
  for (const root of newRoots) {
    try {
      await api.attachRepo(state.sessionId, root);
    } catch (err: any) {
      debugLog('attach-repo', 'failed (non-fatal)', { root, error: err?.message });
      continue;
    }
    if (!state.repoPaths) state.repoPaths = state.repoPath ? [state.repoPath] : [];
    state.repoPaths.push(root);
    if (!state.perRepoState) state.perRepoState = {};
    state.perRepoState[root] = {
      headShaAtStart: getHeadSha(root),
      headShaAtLastStop: null,
      prePromptSha: getHeadSha(root),
      prePromptDirtyFiles: getDirtyFiles(root),
      branch: getBranch(root),
    };
    mutated = true;
    debugLog('attach-repo', 'attached', { root, sessionId: state.sessionId });
  }
  if (mutated) saveSessionState(state, saveCwd, state.sessionTag);
}

async function handlePreToolUse(input: Record<string, any>, agentSlug?: string): Promise<void> {
  debugLog('pre-tool-use', 'begin', { tool_name: input.tool_name, cwd: input.cwd });

  const hookCwd = input.cwd || process.cwd();
  const found = findStateForHook(hookCwd, hookLookupSessionId(input.session_id, agentSlug), agentSlug);
  if (!found) {
    debugLog('pre-tool-use', 'ABORT: no session state');
    return;
  }
  const { state, saveCwd } = found;

  // Track the session's last-seen cwd. The harness can move a session into a
  // linked git worktree after session-start; bare git hooks (prepare-commit-msg,
  // post-commit) then rely on lastCwd to match the worktree commit back to
  // this session. Persisted by the unconditional save at the end of this hook.
  if (hookCwd && state.lastCwd !== hookCwd) {
    debugLog('pre-tool-use', 'lastCwd updated', { from: state.lastCwd, to: hookCwd });
    state.lastCwd = hookCwd;
  }

  // Extract file paths once — used for both lazy repo attach and policy enforcement.
  const toolInput = input.tool_input || {};
  const filePaths = extractFilePaths(input.tool_name || '', toolInput);
  if (filePaths.length > 0) {
    debugLog('pre-tool-use', 'extracted paths', { filePaths, toolName: input.tool_name });
  }

  // ── Lazy multi-repo attach ──────────────────────────────────────────────
  // If the agent touches a file in a sibling repo, attach it now instead of
  // attaching every repo under cwd upfront (the old behavior bundled unrelated
  // projects into a single session).
  if (filePaths.length > 0) {
    try {
      await attachReposForFiles(state, filePaths, saveCwd);
    } catch {
      // non-fatal — attribution is best-effort
    }
  }

  // ── Live policy refresh (A) ───────────────────────────────────────────
  // Before enforcing on a file op, pull the current rule set if our cached
  // copy is stale. The heartbeat already refreshes rules from its ping, but
  // it isn't always running (Codex/Cursor, or a just-started session), so we
  // backstop here — TTL-throttled so a burst of tool calls doesn't hammer the
  // API. This is what makes a policy created AFTER the session started take
  // effect: a session that began with zero policies has empty enforcementRules
  // and would otherwise never re-check. Best-effort — a failed refresh falls
  // back to the cached rules and never blocks the agent.
  const POLICY_REFRESH_TTL_MS = 30_000;
  if (
    filePaths.length > 0 &&
    isConnectedMode() &&
    state.sessionId && !state.sessionId.startsWith('local-') &&
    Date.now() - (state.enforcementRulesFetchedAt || 0) > POLICY_REFRESH_TTL_MS
  ) {
    try {
      const fresh = await api.refreshSessionPolicies(state.sessionId);
      state.enforcementRules = fresh.enforcementRules;
      if (fresh.activePolicies) state.activePolicies = fresh.activePolicies;
      state.enforcementRulesFetchedAt = Date.now();
      saveSessionState(state, saveCwd, state.sessionTag);
    } catch { /* keep cached rules — never block the agent on a refresh blip */ }
  }

  // ── Policy Enforcement: FILE_RESTRICTION ──────────────────────────────
  if (state.enforcementRules && state.enforcementRules.length > 0 && filePaths.length > 0) {
    const result = enforceFileRestrictions(state.enforcementRules, filePaths, state.repoPath);
    if (result?.blocked) {
      debugLog('pre-tool-use', 'BLOCKED by policy', { reason: result.reason });
      // Report to the audit pipeline before exiting — these blocks used
      // to be enforced silently, leaving no trace for admins. Awaited
      // (with catch) since process.exit below would drop an in-flight
      // request; the tool is blocked either way, so the latency is paid
      // only on violations.
      if (isConnectedMode()) {
        try {
          const agentCfg = loadConfig();
          await api.reportViolation({
            machineId: agentCfg?.machineId || 'unknown',
            policyId: result.policyId,
            policyType: 'FILE_RESTRICTION',
            policyName: result.policyName,
            description: `[pre-tool-use] ${result.reason.replace(/^\[Origin Policy\] /, '')}`,
            filepath: result.file,
            sessionId: state.sessionId && !state.sessionId.startsWith('local-') ? state.sessionId : undefined,
          });
        } catch { /* never block the block on reporting */ }
      }
      // Exit code 2 + stderr blocks the tool for both Claude Code and Gemini CLI
      process.stderr.write(result.reason + '\n');
      process.exit(2);
    }
  }

  // ── Budget lockout gate ────────────────────────────────────────────────
  // Blocks tool calls mid-session once a hard cap is breached (the flag
  // is set by the heartbeat ping or the previous turn's stop PATCH), so
  // a running session stops doing work instead of overshooting the cap
  // until the next session start.
  await enforceBudgetLockout(state, agentSlug, saveCwd, 'pre-tool-use');

  // ── Auto-Snapshot: save working tree before file-modifying tools ────────
  const toolNameLower = (input.tool_name || '').toLowerCase();
  if (['edit', 'write', 'patch', 'create', 'insert', 'replace', 'notebook_edit'].some(t => toolNameLower.includes(t))) {
    try {
      const cfg = loadConfig();
      if (cfg?.autoSnapshot && state.repoPath) {
        const { createAutoSnapshot } = await import('./snapshot.js');
        const snapId = createAutoSnapshot(state.repoPath, state.sessionTag);
        if (snapId) {
          debugLog('pre-tool-use', 'auto-snapshot created', { snapId, toolName: input.tool_name });
          // Fire-and-forget upload so the dashboard timeline can mark a dot.
          // Non-fatal — snapshots stay locally even if upload fails.
          if (isConnectedMode() && state.sessionId && !state.sessionId.startsWith('local-')) {
            api.uploadSnapshot(state.sessionId, {
              snapshotId: snapId,
              type: 'auto',
              takenAt: new Date().toISOString(),
              promptIndex: Math.max(0, (state.prompts?.length || 1) - 1),
              commitSha: getHeadSha(state.repoPath) || undefined,
            }).catch(() => { /* non-fatal */ });
          }
        }
      }
    } catch {
      // Non-fatal — never block the agent for snapshot failures
    }
  }

  // ── File Attribution Context ─────────────────────────────────────────────
  // When an agent reads or edits a file, inject per-file attribution so
  // the agent knows who wrote each part before modifying it.
  const toolName = (input.tool_name || '').toLowerCase();
  const isReadStyle = ['read', 'view', 'open', 'cat', 'grep', 'glob'].some(t => toolName.includes(t));
  const isWriteStyle = ['edit', 'write', 'patch', 'create', 'insert', 'replace', 'notebook_edit'].some(t => toolName.includes(t));
  if (isReadStyle || isWriteStyle) {
    const toolInput = input.tool_input || {};
    const filePath = toolInput.file_path || toolInput.path || toolInput.filePath || toolInput.filename || '';
    if (filePath && state.repoPath) {
      try {
        const fileCtx = buildFileAttributionContext(state.repoPath, filePath);
        if (fileCtx) {
          // Output as JSON system message — Claude Code reads this from stdout
          const output = JSON.stringify({ systemMessage: fileCtx });
          process.stdout.write(output);
          debugLog('pre-tool-use', 'file attribution injected', { filePath, length: fileCtx.length });
        }
      } catch {
        // Non-fatal
      }
    }
  }

  // ── Track files the agent has loaded into context ────────────────────────
  // Persisted into git notes at session-end as `filesRead` so the next
  // agent can see what the prior agent looked at, not just what it changed.
  // Dedup on the *normalized* (repo-relative) form so we don't double-count
  // when the same file is read via both absolute and relative paths across
  // pre-tool-use invocations.
  if (isReadStyle && filePaths.length > 0) {
    if (!state.filesRead) state.filesRead = [];
    const cap = 100;
    const seen = new Set(state.filesRead);
    for (const fp of filePaths) {
      if (!fp) continue;
      const rel = state.repoPath && fp.startsWith(state.repoPath + '/')
        ? fp.slice(state.repoPath.length + 1)
        : fp;
      if (seen.has(rel)) continue;
      state.filesRead.push(rel);
      seen.add(rel);
      if (state.filesRead.length >= cap) break;
    }
  }

  // Initialize tool-call ring if needed
  if (!state.subagents) state.subagents = [];

  // Prefer the agent-provided ID so post-tool-use can match unambiguously
  // even when tool calls run in parallel (R1 in SUBAGENT_AUDIT.md).
  const toolCallId = input.tool_call_id || input.tool_use_id ||
    `${Date.now()}-${crypto.randomBytes(4).toString('hex')}`;
  const record: ToolCallRecord = {
    toolCallId,
    toolName: input.tool_name || 'unknown',
    startedAt: new Date().toISOString(),
    prompt: input.tool_input ? JSON.stringify(input.tool_input).slice(0, 500) : undefined,
  };

  state.subagents.push(record);
  saveSessionState(state, saveCwd, state.sessionTag);
  debugLog('pre-tool-use', 'recorded', { toolCallId, toolName: record.toolName });
}

// ─── Live edit capture (PostToolUse ledger) ───────────────────────────────
//
// Record each Edit/Write/MultiEdit the instant its PostToolUse hook fires,
// stamped with the active prompt. This is the authoritative source for
// per-prompt blame: the exact tool inputs, before the transcript can
// truncate them, drift in format, or lag behind on disk. Merged with the
// transcript capture at Stop/session-end so shell/commit edits are still
// covered. Kill-switch: ORIGIN_LIVE_CAPTURE=0.
// Largest single edit (old + new content) we keep in the ledger. Bigger
// edits are SKIPPED, not clamped: a clamped copy would no longer byte-match
// the transcript's full record of the same tool call, so the merge couldn't
// dedupe them and the file would be counted twice. Skipping lets the
// transcript capture (full content) own oversized edits cleanly.
const LIVE_EDIT_CONTENT_MAX = 96 * 1024;
const LIVE_EDIT_MAX_ENTRIES = 2000;      // hard cap on ledger entry count
// Total content-byte budget for the ledger. The state file is rewritten on
// every tool call AND re-read on every hook, so an unbounded ledger would
// drag the agent down. Past this, new edits fall back to the transcript
// capture (no data loss — the transcript still records them).
const LIVE_EDIT_MAX_TOTAL_BYTES = 6 * 1024 * 1024;

function liveCaptureEnabled(): boolean {
  return process.env.ORIGIN_LIVE_CAPTURE !== '0';
}

// Union of files-read from the transcript parse and the hook-captured
// state.filesRead (pre-tool-use records Read-style tools live). Deduped,
// capped, undefined when empty so the API payload stays clean.
function mergeFilesRead(fromTranscript: string[], fromState?: string[]): string[] | undefined {
  const set = new Set<string>();
  for (const f of fromTranscript || []) if (f) set.add(f);
  for (const f of fromState || []) if (f) set.add(f);
  if (set.size === 0) return undefined;
  return Array.from(set).slice(0, 500);
}

function editContentBytes(e: { oldContent?: string; newContent?: string }): number {
  return (e.oldContent?.length || 0) + (e.newContent?.length || 0);
}

// Rough content-byte size of the existing ledger. Bounded by the entry cap,
// so this stays cheap (a few thousand string-length reads at worst).
function liveLedgerBytes(state: SessionState): number {
  let n = 0;
  for (const entry of state.liveEdits || []) {
    for (const e of entry.edits) n += editContentBytes(e);
  }
  return n;
}

/**
 * Pull edits from a PostToolUse payload and append them to the session's
 * live ledger, tagged with the current prompt index. Returns true when the
 * ledger changed (caller persists). Never throws.
 */
function recordLiveEdits(state: SessionState, input: Record<string, any>, repoPath: string): boolean {
  if (!liveCaptureEnabled()) return false;
  try {
    const toolName = String(input.tool_name || '');
    if (!toolName) return false;
    // Claude Code PostToolUse → tool_input; other agents vary, so fall back.
    const toolInput =
      (input.tool_input && typeof input.tool_input === 'object') ? input.tool_input
        : (input.toolInput && typeof input.toolInput === 'object') ? input.toolInput
          : (input.tool_response && typeof input.tool_response === 'object' && input.tool_response.input) ? input.tool_response.input
            : {};
    const promptIndex = (state.prompts?.length || 0) - 1;
    if (promptIndex < 0) return false;
    const agentLabel = state.agentSlug === 'cursor' ? 'cursor' : 'claude';
    // warnUnknown=false: this fires for EVERY tool (Read/Grep/Bash…) in a
    // fresh per-call process, so the unknown-tool note would spam stderr.
    const extracted = extractEditsFromToolCall(toolName, toolInput, repoPath, agentLabel, false);
    if (extracted.length === 0) return false;
    // Drop oversized edits (see LIVE_EDIT_CONTENT_MAX) — the transcript owns
    // those at full fidelity. Keeping a clamped copy would break merge dedup.
    const edits = extracted.filter((e) => editContentBytes(e) <= LIVE_EDIT_CONTENT_MAX);
    if (edits.length === 0) {
      debugLog('post-tool-use', 'live edit too large, deferring to transcript', { tool: toolName });
      return false;
    }
    // Stamp each edit with its real file line BEFORE storing. PostToolUse
    // fires after the tool wrote the file, so the on-disk content reflects
    // the edit and we can read the true position the blame gutter shows.
    // Without this the server synthesizes line numbers from line 1.
    anchorEditPositions(edits, repoPath);
    if (!state.liveEdits) state.liveEdits = [];
    if (state.liveEdits.length >= LIVE_EDIT_MAX_ENTRIES || liveLedgerBytes(state) >= LIVE_EDIT_MAX_TOTAL_BYTES) {
      // Ledger full — fall back to the transcript capture for this edit (it
      // records the same tool call, so nothing is actually lost).
      debugLog('post-tool-use', 'live ledger full, deferring to transcript', { entries: state.liveEdits.length });
      return false;
    }
    state.liveEdits.push({
      promptIndex,
      toolName,
      capturedAt: new Date().toISOString(),
      edits,
    });
    debugLog('post-tool-use', 'live edit captured', { promptIndex, tool: toolName, edits: edits.length });
    return true;
  } catch (err: any) {
    debugLog('post-tool-use', 'live capture failed (non-fatal)', { message: err?.message });
    return false;
  }
}

/**
 * Layer the live ledger over a transcript capture at Stop/session-end. When
 * the ledger has entries (Claude/Cursor PostToolUse fired), its exact
 * tool-call edits win and the transcript supplies shell/commit backfill and
 * prompt text. Empty ledger (e.g. Codex, or ORIGIN_LIVE_CAPTURE=0) → the
 * transcript capture passes through unchanged.
 */
function applyLiveLedger(captures: PromptCapture[], state: SessionState, scope: string): PromptCapture[] {
  if (!liveCaptureEnabled() || !state.liveEdits || state.liveEdits.length === 0) return captures;
  const ledger = buildCapturesFromLedger(state.liveEdits);
  if (ledger.length === 0) return captures;
  const merged = mergeLedgerWithTranscript(ledger, captures);
  debugLog(scope, 'merged live ledger with transcript', {
    ledgerPrompts: ledger.length,
    transcriptPrompts: captures.length,
    mergedPrompts: merged.length,
    ledgerEdits: ledger.reduce((n, c) => n + c.edits.length, 0),
  });
  return merged;
}

async function handlePostToolUse(input: Record<string, any>, agentSlug?: string): Promise<void> {
  debugLog('post-tool-use', 'begin', { tool_name: input.tool_name, cwd: input.cwd });

  const hookCwd = input.cwd || process.cwd();
  const found = findStateForHook(hookCwd, hookLookupSessionId(input.session_id, agentSlug), agentSlug);
  if (!found) {
    debugLog('post-tool-use', 'ABORT: no session state');
    return;
  }
  const { state, saveCwd } = found;

  // Keep lastCwd current for bare git hooks (see handlePreToolUse). Saved
  // immediately — the saves below only fire when a record matched or the
  // branch changed, and a commit's prepare-commit-msg hook may run before
  // either happens again.
  if (hookCwd && state.lastCwd !== hookCwd) {
    debugLog('post-tool-use', 'lastCwd updated', { from: state.lastCwd, to: hookCwd });
    state.lastCwd = hookCwd;
    saveSessionState(state, saveCwd, state.sessionTag);
  }

  if (state.subagents && state.subagents.length > 0) {
    // Match the post-use to its pre-use record.
    //
    // Prefer toolCallId (R1 fix — parallel tool calls with the same toolName
    // used to race through the reverse-find-by-name path). Fall back to the
    // name-based reverse-find for agents that don't propagate an ID through
    // both hooks (e.g., some older Gemini / Aider builds).
    const toolName = input.tool_name || 'unknown';
    const toolCallId = input.tool_call_id || input.tool_use_id;
    const record = toolCallId
      ? state.subagents.find((r) => r.toolCallId === toolCallId)
      : [...state.subagents].reverse().find((r) => r.toolName === toolName && !r.endedAt);

    if (record) {
      record.endedAt = new Date().toISOString();
      if (input.tool_result) {
        record.result = typeof input.tool_result === 'string'
          ? input.tool_result.slice(0, 500)
          : JSON.stringify(input.tool_result).slice(0, 500);
      }
      saveSessionState(state, saveCwd, state.sessionTag);
      debugLog('post-tool-use', 'updated', { toolCallId: record.toolCallId, toolName });
    }
  }

  // ── Mid-session branch tracking ──────────────────────────────────────────
  // Check branch on every tool use — different agents use different tool names
  // (Claude: Bash, Gemini: shell/run_terminal_command, etc.)
  // getBranch() just reads .git/HEAD so it's cheap
  try {
    const repoPath = state.repoPath || saveCwd;
    const currentBranch = getBranch(repoPath);
    if (currentBranch && currentBranch !== state.branch) {
      debugLog('post-tool-use', 'branch changed', { from: state.branch, to: currentBranch });
      state.branch = currentBranch;
      saveSessionState(state, saveCwd, state.sessionTag);
      // Update server (connected mode only)
      if (isConnectedMode() && state.sessionId) {
        api.updateSession(state.sessionId, { branch: currentBranch }).catch(() => {});
      }
    }
  } catch {
    // non-fatal
  }

  // ── Live edit ledger ──────────────────────────────────────────────────────
  // Capture this tool call's edits in real time, tagged with the active
  // prompt. Authoritative source for per-prompt blame at Stop/end.
  if (recordLiveEdits(state, input, state.repoPath || saveCwd)) {
    saveSessionState(state, saveCwd, state.sessionTag);
  }
}

// ─── Cursor: afterFileEdit ───────────────────────────────────────────────
//
// Fires after every Cursor edit (StrReplace / Write / etc.). Cursor's git
// commits don't reliably trigger the global post-commit hook (sandbox /
// worktree isolation), so user-prompt-submit's retroactive capture path
// runs against an empty working tree at next-prompt time and the dashboard
// shows "0 files" for the prompt. We work around that by capturing the
// working tree against the per-prompt shadow on every file edit — same
// content as the heartbeat's pushInflightDiff, but triggered by the edit
// event so it fires even when no shell commands have run.
async function handleAfterFileEdit(input: Record<string, any>, agentSlug?: string): Promise<void> {
  debugLog('after-file-edit', 'begin', { cwd: input.cwd, file: input.file_path || input.path });

  const hookCwd = input.cwd || process.cwd();
  const found = findStateForHook(hookCwd, hookLookupSessionId(input.session_id, agentSlug), agentSlug);
  if (!found) {
    debugLog('after-file-edit', 'ABORT: no session state');
    return;
  }
  const { state, saveCwd } = found;
  if (!state.repoPath || !state.prePromptSha) {
    debugLog('after-file-edit', 'ABORT: missing repoPath or prePromptSha');
    return;
  }
  const promptIdx = (state.prompts?.length || 0) - 1;
  if (promptIdx < 0) {
    debugLog('after-file-edit', 'ABORT: no current prompt');
    return;
  }

  try {
    // Re-capture working tree against the per-prompt shadow so the current
    // prompt's mapping reflects whatever Cursor just wrote to disk.
    const promptShadow = (state.promptShadows || []).find((s) => s.promptIndex === promptIdx);
    const captureBaseline = promptShadow?.shadowSha || state.prePromptSha;
    const capture = captureGitState(state.repoPath, captureBaseline, { fullContext: true });

    const filteredUncommitted = filterUncommittedDiff(
      capture.uncommittedDiff || '', uncommittedExcludeUnion(state),
    );
    const sessionCommitted = sessionScopedCommittedDiff(state.repoPath, state);
    const fullDiff = (sessionCommitted + (filteredUncommitted ? '\n' + filteredUncommitted : '')).trim();
    if (!fullDiff) {
      debugLog('after-file-edit', 'no diff against shadow, skipping');
      return;
    }

    const filesChanged = new Set<string>();
    for (const m of fullDiff.matchAll(/^diff --git a\/(.*?) b\//gm)) {
      if (m[1]) filesChanged.add(m[1]);
    }
    // Filesystem path the hook reported, if any — useful when the diff lags.
    if (typeof input.file_path === 'string') filesChanged.add(input.file_path);
    if (typeof input.path === 'string') filesChanged.add(input.path);

    let commitSha: string | null = null;
    let treeSha: string | null = null;
    try {
      commitSha = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: state.repoPath, encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] }).trim();
      treeSha = execFileSync('git', ['rev-parse', 'HEAD^{tree}'], { cwd: state.repoPath, encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] }).trim();
    } catch { /* ignore */ }

    if (!state.completedPromptMappings) state.completedPromptMappings = [];
    const promptText = (state.prompts?.[promptIdx] || '').slice(0, 1000);
    const mapping = {
      promptIndex: promptIdx,
      promptText,
      filesChanged: Array.from(filesChanged),
      diff: fullDiff.slice(0, 200_000),
      uncommittedDiff: filteredUncommitted.slice(0, 200_000),
      commitSha,
      treeSha,
    };
    const existingIdx = state.completedPromptMappings.findIndex((m) => m.promptIndex === promptIdx);
    if (existingIdx >= 0) {
      state.completedPromptMappings[existingIdx] = mapping;
    } else {
      state.completedPromptMappings.push(mapping);
    }
    saveSessionState(state, saveCwd, state.sessionTag);
    debugLog('after-file-edit', 'updated mapping', {
      promptIndex: promptIdx,
      filesChanged: filesChanged.size,
      diffLen: fullDiff.length,
    });

    // Push to API immediately so the dashboard reflects the edit without
    // waiting for the next heartbeat tick.
    if (isConnectedMode() && state.sessionId) {
      try {
        const dl = fullDiff.split('\n');
        await api.updateSession(state.sessionId, {
          promptChanges: state.completedPromptMappings.map((pm) => ({
            ...pm,
            promptText: (pm.promptText || '').slice(0, 1000),
            diff: (pm.diff || '').slice(0, MAX_PROMPT_DIFF_LEN),
            uncommittedDiff: (pm.uncommittedDiff || '').slice(0, MAX_PROMPT_DIFF_LEN),
            linesAdded: dl.filter((l: string) => l.startsWith('+') && !l.startsWith('+++')).length,
            linesRemoved: dl.filter((l: string) => l.startsWith('-') && !l.startsWith('---')).length,
            aiPercentage: 100,
            checkpointType: 'auto',
          })),
          status: 'RUNNING',
        });
        debugLog('after-file-edit', 'api updated');
      } catch (apiErr: any) {
        debugLog('after-file-edit', 'api update failed (non-fatal)', { message: apiErr?.message });
      }
    }
  } catch (err: any) {
    debugLog('after-file-edit', 'capture failed (non-fatal)', { message: err?.message });
  }
}

// ─── Git Hook: Pre-Commit (Secret Scan) ──────────────────────────────────

/**
 * Decide whether a policy applies to the commit being made, based on its
 * per-agent assignments. Mirrors shouldSkipPolicy in the server's
 * policy-engine (inverted: returns true when the policy SHOULD enforce):
 *   - no assignments → org-wide, applies to every commit
 *   - assigned → applies only when one of the assigned agents has an
 *     active session in this repo; human commits (no active agent
 *     session) skip agent-scoped policies
 * Exported for tests.
 */
export function policyAppliesToCommit(
  assignedAgents: Array<{ slug?: string | null }> | undefined,
  activeAgentSlugs: Set<string>,
): boolean {
  const assigned = assignedAgents || [];
  if (assigned.length === 0) return true;
  return assigned.some((a) => !!a.slug && activeAgentSlugs.has(a.slug.toLowerCase()));
}

/**
 * Called by .git/hooks/pre-commit.
 * Scans staged diff for hardcoded secrets, API keys, and credentials.
 * Exits with code 1 to block the commit if secrets are found.
 */
/**
 * Pure decision for the pre-commit budget gate. Exported for tests.
 *
 * Blocks when any candidate Origin session for this repo/worktree is
 * flagged budgetBlocked. Sessions only exist for AI agents, so a plain
 * human commit in a repo with no locked AI session passes untouched.
 * ORIGIN_BUDGET_OVERRIDE=1 is the documented emergency escape hatch
 * (same as the prompt/tool gates).
 */
export function preCommitBudgetDecision(
  sessions: Array<Pick<SessionState, 'sessionId' | 'budgetBlocked' | 'budgetBlockReason'>>,
  overrideEnv: string | undefined,
): { block: boolean; reason: string } {
  if (overrideEnv === '1') return { block: false, reason: '' };
  const locked = sessions.find((s) => s.budgetBlocked);
  if (!locked) return { block: false, reason: '' };
  return {
    block: true,
    reason:
      `[Origin Budget] Commit blocked — ${locked.budgetBlockReason || 'hard budget cap exceeded'}. ` +
      `New AI work is locked until the cap resets or an admin raises it. ` +
      `Emergency override: ORIGIN_BUDGET_OVERRIDE=1 git commit ...`,
  };
}

export async function handlePreCommit(): Promise<void> {
  debugLog('pre-commit', '=== GIT HOOK INVOKED ===', { pid: process.pid, cwd: process.cwd() });

  const config = loadConfig();
  const hookCwd = process.cwd();
  const repoPath = getGitRoot(hookCwd);
  if (!repoPath) {
    debugLog('pre-commit', 'SKIP: not a git repo');
    return;
  }

  // ── 0. Budget hard-cap gate — the agent-agnostic choke point ─────────
  // Hook-protocol blocking (exit 2 on prompt/tool hooks) only works for
  // Claude Code and Gemini; Codex and Cursor ignore it. Git itself,
  // however, honors a non-zero pre-commit exit no matter which agent is
  // driving — so this is where a breached hard cap actually stops work
  // from landing for EVERY agent. The lockout flag comes from session
  // state (stamped by the heartbeat ping, the session PATCH path, or the
  // 429-refused session-start fallback). Worktree-aware lookup so an
  // agent committing from a sibling worktree is still matched.
  try {
    const candidates = listSessionsForGitHook(hookCwd);
    const lockedCandidate = candidates.find((s) => s.budgetBlocked);
    if (lockedCandidate && isConnectedMode()) {
      // Re-check the server while locked (mirrors enforceBudgetLockout):
      // the block must lift the moment an admin raises the cap or the
      // period resets — a stale flag in a lingering state file must not
      // keep blocking commits. On re-check failure keep blocking; the
      // last confirmed server state was "blocked".
      try {
        const status = await api.getBudgetStatus(
          lockedCandidate.sessionId && !lockedCandidate.sessionId.startsWith('local-')
            ? lockedCandidate.sessionId
            : undefined,
        );
        if (!status.blocked) {
          lockedCandidate.budgetBlocked = false;
          lockedCandidate.budgetBlockReason = undefined;
          try { saveSessionState(lockedCandidate, lockedCandidate.repoPath || repoPath, lockedCandidate.sessionTag); } catch { /* non-fatal */ }
          clearBudgetLockNotice(lockedCandidate.repoPath || repoPath);
          debugLog('pre-commit', 'budget lockout lifted by server re-check');
        } else if (status.message) {
          lockedCandidate.budgetBlockReason = status.message;
        }
      } catch { /* keep blocking on re-check failure */ }
    }
    const decision = preCommitBudgetDecision(candidates, process.env.ORIGIN_BUDGET_OVERRIDE);
    if (decision.block) {
      debugLog('pre-commit', 'BLOCKED by budget lockout', { reason: decision.reason });
      process.stderr.write('\n' + decision.reason + '\n\n');
      process.exit(1);
    }
  } catch (gateErr: any) {
    // The gate must never break commits on its own bugs — fall through
    // to the normal policy checks.
    debugLog('pre-commit', 'budget gate check failed (non-fatal)', { message: gateErr?.message });
  }

  const repoConfig = loadRepoConfig(repoPath);

  const execOpts = {
    encoding: 'utf-8' as const,
    cwd: repoPath,
    stdio: ['pipe', 'pipe', 'pipe'] as ['pipe', 'pipe', 'pipe'],
    maxBuffer: 10 * 1024 * 1024, // 10MB for large diffs
  };

  // Get staged diff (full context for CONTENT_FILTER matching)
  let stagedDiff: string;
  try {
    stagedDiff = execFileSync('git', ['diff', '--cached'], execOpts).trim();
  } catch (err: any) {
    debugLog('pre-commit', 'ERROR: cannot read staged diff', { message: err.message });
    return; // Don't block on error
  }

  if (!stagedDiff) {
    debugLog('pre-commit', 'SKIP: empty staged diff');
    return;
  }

  // Get staged file list
  let stagedFiles: string[] = [];
  try {
    const raw = execFileSync('git', ['diff', '--cached', '--name-only'], execOpts).trim();
    stagedFiles = raw ? raw.split('\n') : [];
  } catch { /* ignore */ }

  // Get the commit message (from COMMIT_EDITMSG if available — works for commit-msg hook chain)
  let commitMessage = '';
  try {
    const msgFile = path.join(repoPath, '.git', 'COMMIT_EDITMSG');
    if (fs.existsSync(msgFile)) {
      commitMessage = fs.readFileSync(msgFile, 'utf-8').trim();
    }
  } catch { /* ignore */ }

  // ── Collect all violations from all policy checkers ──
  interface PolicyViolation {
    policyName: string;
    policyType: string;
    policyId?: string;
    ruleId?: string;
    action: string;
    severity: string;
    message: string;
  }
  const violations: PolicyViolation[] = [];

  // ── 1. Secret scanning (built-in, always runs unless disabled) ──
  if (config?.secretScan !== false && repoConfig?.secretScan !== false) {
    const addedLines = parseStagedDiffLines(stagedDiff);
    const seen = new Set<string>();

    // Skip minified/bundled build artifacts — they trigger false positives on
    // vendor library internals, example code in docs, and React/chart internals.
    const SCAN_SKIP_PATHS = [
      '/dist/', '/build/', '/public/', '/web-dist/',
      '.min.js', '.min.css', '.bundle.js', '.chunk.js',
      'node_modules/', 'vendor/', '.tgz',
    ];

    for (const entry of addedLines) {
      // Skip build artifacts and vendor bundles
      if (SCAN_SKIP_PATHS.some(p => entry.file.includes(p))) continue;
      const trimmed = entry.content.trim();
      if (trimmed.length < 5) continue;
      if (trimmed.startsWith('//') || trimmed.startsWith('#') || trimmed.startsWith('*') || trimmed.startsWith('<!--')) continue;

      for (const pattern of PRE_COMMIT_PATTERNS) {
        pattern.regex.lastIndex = 0;
        const match = pattern.regex.exec(entry.content);
        if (match) {
          const matchedValue = match[1] || match[0];
          const key = `${entry.file}:${entry.line}:${matchedValue}`;
          if (seen.has(key)) continue;
          seen.add(key);

          const redacted = matchedValue.length <= 8
            ? '****'
            : matchedValue.slice(0, 4) + '****' + matchedValue.slice(-4);

          violations.push({
            policyName: 'Secret Detection',
            policyType: 'SECRET_SCAN',
            action: 'BLOCK',
            severity: mapFindingSeverity(pattern.name).toUpperCase(),
            message: `${pattern.name} in ${entry.file}:${entry.line} — ${redacted}`,
          });
        }
      }
    }
  }

  // ── 2. Fetch org policies from Origin API and enforce locally ──
  const connected = isConnectedMode();
  if (connected) {
    try {
      const policies = await api.getPolicies() as Array<{
        id: string;
        name: string;
        type: string;
        assignedAgents?: Array<{ id: string; name: string; slug: string }>;
        rules: Array<{
          id: string;
          condition: string;
          action: string;
          severity: string;
          agentId: string | null;
          machineId: string | null;
          repoId: string | null;
        }>;
      }>;

      // Active AI session agent(s) in this repo — the scope context for
      // per-agent policy assignments. Empty set = human commit (no agent
      // session running here).
      const activeAgentSlugs = new Set(
        listActiveSessions(repoPath)
          .map((s) => (s.agentSlug || '').toLowerCase())
          .filter(Boolean),
      );

      for (const policy of policies) {
        // Honor per-agent assignments — mirrors shouldSkipPolicy in the
        // server's policy-engine. No assignments = org-wide, enforce for
        // every commit. Assigned = enforce only when one of the assigned
        // agents has an active session in this repo; human commits (no
        // active agent session) skip agent-scoped policies. Without this
        // filter, a policy scoped to specific agents blocked EVERY commit
        // in the org, including hand-typed ones.
        if (!policyAppliesToCommit(policy.assignedAgents, activeAgentSlugs)) {
          debugLog('pre-commit', 'skipping agent-scoped policy (no assigned agent active)', {
            policy: policy.name,
            assigned: (policy.assignedAgents || []).map((a) => a.slug),
            active: [...activeAgentSlugs],
          });
          continue;
        }

        for (const rule of policy.rules) {
          let cond: Record<string, any> = {};
          try { cond = JSON.parse(rule.condition); } catch { continue; }

          switch (policy.type) {
            case 'FILE_RESTRICTION': {
              const pathPattern = cond.path as string | undefined;
              if (pathPattern) {
                for (const file of stagedFiles) {
                  if (matchGlobPreCommit(pathPattern, file)) {
                    violations.push({
                      policyName: policy.name,
                      policyType: policy.type,
                      policyId: policy.id,
                      ruleId: rule.id,
                      action: rule.action,
                      severity: rule.severity,
                      message: `File "${file}" matches restricted pattern "${pathPattern}"`,
                    });
                    break; // one match per rule is enough
                  }
                }
              }
              break;
            }

            case 'CONTENT_FILTER': {
              const pattern = cond.pattern as string | undefined;
              if (pattern) {
                try {
                  const flags = (cond.caseSensitive === false) ? 'gi' : 'g';
                  const regex = new RegExp(pattern, flags);
                  const matches = stagedDiff.match(regex);
                  if (matches && matches.length > 0) {
                    violations.push({
                      policyName: policy.name,
                      policyType: policy.type,
                      policyId: policy.id,
                      ruleId: rule.id,
                      action: rule.action,
                      severity: rule.severity,
                      message: `Diff content matches "${pattern}" (${matches.length} match${matches.length !== 1 ? 'es' : ''})`,
                    });
                  }
                } catch { /* invalid regex */ }
              }
              break;
            }

            case 'COMMIT_MESSAGE': {
              if (!commitMessage) break;
              const requiredPattern = cond.pattern as string | undefined;
              const blockedPattern = cond.blocked_pattern as string | undefined;

              if (requiredPattern) {
                try {
                  const regex = new RegExp(requiredPattern);
                  if (!regex.test(commitMessage)) {
                    violations.push({
                      policyName: policy.name,
                      policyType: policy.type,
                      policyId: policy.id,
                      ruleId: rule.id,
                      action: rule.action,
                      severity: rule.severity,
                      message: `Commit message does not match required format "${requiredPattern}"`,
                    });
                  }
                } catch { /* invalid regex */ }
              }

              if (blockedPattern) {
                try {
                  const flags = (cond.caseSensitive === false) ? 'i' : '';
                  const regex = new RegExp(blockedPattern, flags);
                  if (regex.test(commitMessage)) {
                    violations.push({
                      policyName: policy.name,
                      policyType: policy.type,
                      policyId: policy.id,
                      ruleId: rule.id,
                      action: rule.action,
                      severity: rule.severity,
                      message: `Commit message matches blocked pattern "${blockedPattern}"`,
                    });
                  }
                } catch { /* invalid regex */ }
              }
              break;
            }

            case 'REQUIRE_REVIEW': {
              // Check file path patterns only at pre-commit (cost/duration not available yet)
              const pathPattern = cond.path as string | undefined;
              if (pathPattern) {
                for (const file of stagedFiles) {
                  if (matchGlobPreCommit(pathPattern, file)) {
                    violations.push({
                      policyName: policy.name,
                      policyType: policy.type,
                      policyId: policy.id,
                      ruleId: rule.id,
                      action: 'REQUIRE_REVIEW',
                      severity: rule.severity,
                      message: `File "${file}" matches review pattern "${pathPattern}" — manual review required`,
                    });
                    break;
                  }
                }
              }
              break;
            }

            // COST_LIMIT and MODEL_ALLOWLIST not applicable at pre-commit time
          }
        }
      }
    } catch (err: any) {
      debugLog('pre-commit', 'Policy fetch failed (non-fatal)', { message: err.message });
      // Don't block on API failure — just skip policy checks
    }
  }

  // ── No violations? Pass. ──
  if (violations.length === 0) {
    debugLog('pre-commit', 'PASS: no violations');
    return;
  }

  // ── Report violations to API (Security tab) ──
  if (connected) {
    try {
      const sessions = listActiveSessions(repoPath);
      const activeSession = sessions[0];
      const sessionId = activeSession?.sessionId;

      // Report secret findings
      const secretFindings = violations.filter(v => v.policyType === 'SECRET_SCAN');
      if (sessionId && secretFindings.length > 0) {
        await api.reportSecrets(sessionId, secretFindings.map(f => ({
          type: 'GENERIC_SECRET',
          severity: f.severity.toLowerCase(),
          filePath: f.message.split(' in ')[1]?.split(' —')[0] || '',
          lineNumber: 0,
          match: f.message,
          ruleName: f.policyName,
        }))).catch(() => {});
      }

      // Report policy violations. policyType rides along so the stats
      // violations-by-type histogram attributes these correctly — without
      // it, every pre-commit report landed in the "UNKNOWN" bucket.
      const policyViolations = violations.filter(v => v.policyId);
      for (const v of policyViolations) {
        await api.reportViolation({
          machineId: config?.machineId || 'unknown',
          policyId: v.policyId!,
          policyType: v.policyType,
          policyName: v.policyName,
          description: `[pre-commit] ${v.message}`,
          filepath: stagedFiles[0] || undefined,
          sessionId: sessionId && !sessionId.startsWith('local-') ? sessionId : undefined,
        }).catch(() => {});
      }
    } catch (err: any) {
      debugLog('pre-commit', 'API report failed (non-fatal)', { message: err.message });
    }
  }

  // ── Check if any violations have BLOCK action ──
  const blockingViolations = violations.filter(
    v => v.action.toUpperCase() === 'BLOCK' || v.policyType === 'SECRET_SCAN'
  );
  const warningViolations = violations.filter(
    v => v.action.toUpperCase() !== 'BLOCK' && v.policyType !== 'SECRET_SCAN'
  );

  // Show warnings (non-blocking)
  if (warningViolations.length > 0) {
    process.stderr.write('\n');
    process.stderr.write('\x1b[1;33m  ⚠ Origin: policy warnings\x1b[0m\n');
    process.stderr.write('\n');
    for (const v of warningViolations) {
      process.stderr.write(`\x1b[33m    [${v.policyType}] ${v.policyName}\x1b[0m\n`);
      process.stderr.write(`    ${v.message}\n\n`);
    }
  }

  // Block commit if any blocking violations
  if (blockingViolations.length > 0) {
    process.stderr.write('\n');
    process.stderr.write('\x1b[1;31m  ✗ Origin: commit blocked by policy\x1b[0m\n');
    process.stderr.write('\n');

    for (const v of blockingViolations) {
      process.stderr.write(`\x1b[31m    [${v.policyType}] ${v.policyName}\x1b[0m\n`);
      process.stderr.write(`    ${v.message}\n\n`);
    }

    process.stderr.write(`\x1b[33m  ${blockingViolations.length} violation${blockingViolations.length !== 1 ? 's' : ''} found. Commit blocked.\x1b[0m\n`);
    process.stderr.write('\n');
    process.stderr.write('\x1b[2m  To bypass: git commit --no-verify\x1b[0m\n');
    process.stderr.write('\n');

    process.exit(1);
  }
}

// Map finding type names to API types
function mapFindingType(name: string): string {
  const map: Record<string, string> = {
    'AWS Access Key': 'AWS_SECRET', 'AWS Secret Key': 'AWS_SECRET',
    'Private Key': 'PRIVATE_KEY', 'GitHub Token': 'API_KEY', 'GitHub PAT': 'API_KEY',
    'OpenAI Key': 'API_KEY', 'Anthropic Key': 'API_KEY', 'Stripe Key': 'API_KEY',
    'Slack Token': 'API_KEY', 'JWT Token': 'JWT_TOKEN',
    'Connection String': 'CONNECTION_STRING', 'API Key': 'API_KEY',
    'Hardcoded Password': 'PASSWORD', 'npm Token': 'API_KEY', 'Bearer Token': 'API_KEY',
  };
  return map[name] || 'GENERIC_SECRET';
}

function mapFindingSeverity(name: string): string {
  const critical = ['AWS Access Key', 'AWS Secret Key', 'Private Key', 'GitHub Token', 'GitHub PAT', 'Connection String'];
  const high = ['OpenAI Key', 'Anthropic Key', 'Stripe Key', 'Slack Token', 'JWT Token', 'API Key', 'Hardcoded Password'];
  if (critical.includes(name)) return 'critical';
  if (high.includes(name)) return 'high';
  return 'medium';
}

// Patterns for pre-commit scanning (non-global flags for single match per line)
// Patterns are exported as a named const so the test file can iterate them and
// so the README's advertised count can be regenerated with a one-liner:
//   node -e "console.log(require('./dist/commands/hooks').PRE_COMMIT_PATTERNS.length)"
export const PRE_COMMIT_PATTERNS = [
  { name: 'AWS Access Key', regex: /AKIA[0-9A-Z]{16}/ },
  { name: 'AWS Secret Key', regex: /(?:aws_secret_access_key|secret_key)\s*[:=]\s*['"]?([A-Za-z0-9/+=]{40})/i },
  { name: 'Private Key', regex: /-----BEGIN\s+(?:RSA\s+|EC\s+|DSA\s+|OPENSSH\s+)?PRIVATE\s+KEY-----/ },
  { name: 'GitHub Token', regex: /(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9_]{36,}/ },
  { name: 'GitHub PAT', regex: /github_pat_[A-Za-z0-9_]{50,}/ },
  { name: 'OpenAI Key', regex: /sk-[A-Za-z0-9]{32,}/ },
  { name: 'Anthropic Key', regex: /sk-ant-[A-Za-z0-9-]{32,}/ },
  { name: 'Stripe Key', regex: /sk_(?:live|test)_[A-Za-z0-9]{24,}/ },
  { name: 'Slack Token', regex: /xox[bpors]-[0-9]{10,}-[a-zA-Z0-9-]+/ },
  { name: 'JWT Token', regex: /eyJ[a-zA-Z0-9_-]{10,}\.eyJ[a-zA-Z0-9_-]{10,}\.[a-zA-Z0-9_-]{10,}/ },
  { name: 'Connection String', regex: /(?:mongodb(?:\+srv)?|postgres(?:ql)?|mysql|redis|amqp):\/\/[^\s'"]{10,}/i },
  { name: 'API Key', regex: /(?:api[_-]?key|apikey|api[_-]?secret|api[_-]?token)\s*[:=]\s*['"]([a-zA-Z0-9_\-]{20,})['"]/ },
  { name: 'Hardcoded Password', regex: /(?:password|passwd|pwd|db_password)\s*[:=]\s*['"]?([^'"\s]{8,})['"]?/i },
  { name: 'npm Token', regex: /npm_[A-Za-z0-9]{36,}/ },
  { name: 'Bearer Token', regex: /Bearer\s+[A-Za-z0-9_\-.]{20,}/ },
  // Generic *_TOKEN=, *_SECRET=, *_KEY=, *_PASSWORD= assignments
  { name: 'Token Assignment', regex: /\w+_TOKEN\s*[:=]\s*['"]?([A-Za-z0-9_\-/.+=]{10,})['"]?/i },
  { name: 'Secret Assignment', regex: /\w+_SECRET\s*[:=]\s*['"]?([A-Za-z0-9_\-/.+=]{10,})['"]?/i },
  { name: 'Key Assignment', regex: /\w+_(?:API_?)?KEY\s*[:=]\s*['"]?([A-Za-z0-9_\-/.+=]{10,})['"]?/i },
  { name: 'Password Assignment', regex: /\w+_PASSWORD\s*[:=]\s*['"]?([^\s'"]{8,})['"]?/i },
  // ── Cloud provider credentials ──
  { name: 'GCP Service Account', regex: /"type"\s*:\s*"service_account"[\s\S]{0,500}"private_key"\s*:/ },
  { name: 'GCP API Key', regex: /AIza[0-9A-Za-z_-]{35}/ },
  { name: 'Azure Storage Key', regex: /(?:AccountKey|SharedAccessKey)=([A-Za-z0-9+/=]{64,})/ },
  { name: 'Cloudflare API Token', regex: /(?:cloudflare[_-]?api[_-]?token|CF_API_TOKEN)\s*[:=]\s*['"]?([A-Za-z0-9_-]{40})['"]?/i },
  // ── Comms / messaging ──
  { name: 'Twilio Account SID', regex: /\bAC[a-f0-9]{32}\b/ },
  { name: 'Twilio Auth Token', regex: /\bSK[a-f0-9]{32}\b/ },
  { name: 'SendGrid API Key', regex: /SG\.[A-Za-z0-9_-]{22,}\.[A-Za-z0-9_-]{43,}/ },
  { name: 'Mailgun Key', regex: /\bkey-[a-f0-9]{32}\b/ },
  { name: 'Discord Bot Token', regex: /[MN][A-Za-z0-9_-]{23}\.[A-Za-z0-9_-]{6}\.[A-Za-z0-9_-]{27,}/ },
  { name: 'Telegram Bot Token', regex: /\b\d{9,10}:[A-Za-z0-9_-]{35}\b/ },
  // ── Infrastructure / PaaS ──
  { name: 'DigitalOcean Token', regex: /\bdop_v1_[a-f0-9]{64}\b/ },
  { name: 'Heroku API Key', regex: /(?:heroku[_-]?api[_-]?key|HEROKU_API_KEY)\s*[:=]\s*['"]?([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})['"]?/i },
  { name: 'Firebase Server Key', regex: /AAAA[A-Za-z0-9_-]{7}:APA91b[A-Za-z0-9_-]{100,}/ },
  // ── Payments ──
  { name: 'Square Token', regex: /\bsq0(?:atp|csp|idp)-[A-Za-z0-9_-]{22,}\b/ },
  { name: 'PayPal Access Token', regex: /access_token\$production\$[a-z0-9]{16}\$[a-f0-9]{32}/ },
  // ── Observability / APM ──
  { name: 'Datadog API Key', regex: /(?:dd[_-]?api[_-]?key|DATADOG_API_KEY)\s*[:=]\s*['"]?([a-f0-9]{32})['"]?/i },
  { name: 'Datadog App Key', regex: /(?:dd[_-]?app[_-]?key|DATADOG_APP_KEY)\s*[:=]\s*['"]?([a-f0-9]{40})['"]?/i },
  { name: 'New Relic Key', regex: /\bNRAK-[A-Z0-9]{27}\b/ },
  { name: 'PagerDuty Key', regex: /(?:pagerduty[_-]?api[_-]?key|PAGERDUTY_API_KEY)\s*[:=]\s*['"]?([yuzn][A-Za-z0-9_-]{19,})['"]?/i },
  // ── Dev tools ──
  { name: 'Snyk Token', regex: /(?:snyk[_-]?token|SNYK_TOKEN)\s*[:=]\s*['"]?([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})['"]?/i },
  { name: 'npmrc Auth', regex: /\/\/[^/\s]+\/:_authToken=([A-Za-z0-9_+=-]{16,})/ },
  // ── Generic high-value ──
  { name: 'Password Hash', regex: /\w+_PASSWORD_HASH\s*[:=]\s*['"]?(\$2[aby]?\$[0-9]{2}\$[A-Za-z0-9./]{53}|[A-Za-z0-9+/=]{40,})['"]?/i },
];

// Glob pattern matching for pre-commit policy checks
function matchGlobPreCommit(pattern: string, filepath: string): boolean {
  const escaped = pattern
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*\*/g, '<<<GLOBSTAR>>>')
    .replace(/\*/g, '[^/]*')
    .replace(/<<<GLOBSTAR>>>/g, '.*')
    .replace(/\?/g, '.');
  const regex = new RegExp(`^${escaped}$`);
  return regex.test(filepath);
}

// Parse staged diff into file + line + content entries
function parseStagedDiffLines(diff: string): Array<{ file: string; line: number; content: string }> {
  const lines = diff.split('\n');
  const result: Array<{ file: string; line: number; content: string }> = [];
  let currentFile = '';
  let currentLine = 0;

  for (const line of lines) {
    if (line.startsWith('+++ b/')) {
      currentFile = line.slice(6);
      continue;
    }
    if (line.startsWith('+++ ') || line.startsWith('--- ')) continue;

    const hunkMatch = line.match(/^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
    if (hunkMatch) {
      currentLine = parseInt(hunkMatch[1], 10);
      continue;
    }

    if (line.startsWith('diff ') || line.startsWith('index ') || line.startsWith('Binary ')) continue;

    if (line.startsWith('+') && !line.startsWith('++')) {
      result.push({ file: currentFile, line: currentLine, content: line.slice(1) });
      currentLine++;
      continue;
    }

    if (!line.startsWith('-')) {
      currentLine++;
    }
  }

  return result;
}

// ─── Git Hook: Pre-Push (F14) ─────────────────────────────────────────────

// ─── Git Hook: Prepare-Commit-Msg ────────────────────────────────────────
//
// Fires BEFORE the commit is made, so the trailer is part of the commit from
// the start. Replaces the old post-commit `--amend --no-verify` dance which
// mutated commit SHAs, bypassed the secret scanner, and invalidated GPG
// signatures. See docs/notes/SUBAGENT_AUDIT.md for the amend rationale and
// its removal.
//
// Invocation: `origin hooks git-prepare-commit-msg <msgFile> [source] [sha]`
//   msgFile — path to .git/COMMIT_EDITMSG
//   source  — one of: message, template, merge, squash, commit (optional)
//   sha     — commit SHA when source=commit (rebase/amend) (optional)
//
// Skip conditions:
//   • source=merge  — merge commit; user didn't write this message
//   • source=squash — squash merge; combining existing commits
//   • source=commit — rebase or --amend; already has trailers if applicable

/**
 * Resolve an agent display name from a model identifier.
 * Kept alongside the legacy post-commit block for consistency.
 */
function resolveAgentDisplayName(model: string | undefined): string {
  const m = (model || '').toLowerCase();
  // Check specific / composite names BEFORE generic ones. "copilot-gpt4" must
  // resolve to Copilot, not Cursor. "amp-claude-opus" must resolve to Amp.
  if (m.includes('copilot')) return 'Copilot';
  if (m.includes('amp')) return 'Amp';
  if (m.includes('junie')) return 'Junie';
  if (m.includes('opencode')) return 'Opencode';
  if (m.includes('aider')) return 'Aider';
  if (m.includes('windsurf')) return 'Windsurf';
  if (m.includes('codex')) return 'Codex';
  if (m.includes('gemini')) return 'Gemini CLI';
  if (m.includes('claude') || m.includes('sonnet') || m.includes('opus')) return 'Claude Code';
  if (m.includes('gpt') || m.includes('o1-') || m.includes('o3-') || m.includes('o4-')) return 'Cursor';
  return model || 'AI';
}

/**
 * Build the Origin trailer lines for a session. Returns array of
 * "Name: Value" strings (no trailing newlines). Each line is suitable for
 * `git interpret-trailers --trailer=<line>`.
 *
 * Exported for testing.
 */
export function buildOriginTrailers(
  sessionId: string,
  model: string | undefined,
  promptCount: number,
  latestSnapshotId?: string | null,
): string[] {
  const shortId = sessionId.slice(0, 12);
  const agentName = resolveAgentDisplayName(model);
  const parts = [shortId, agentName];
  if (promptCount > 0) parts.push(promptCount === 1 ? '1 prompt' : `${promptCount} prompts`);
  const trailers: string[] = [`Origin-Session: ${parts.join(' | ')}`];
  if (latestSnapshotId) trailers.push(`Origin-Snapshot: ${latestSnapshotId}`);
  return trailers;
}

/**
 * Pick the single active session for this commit.
 * Mirrors the logic in handlePostCommit — kept separate to avoid coupling
 * that function's many other responsibilities.
 */
function pickActiveSessionForCommit(hookCwd: string): SessionState | null {
  // Worktree-aware lookup: falls back to the main repo's sessions when the
  // hook runs inside a linked worktree (whose own git dir holds no state
  // files), then narrows multiple candidates by last-seen lifecycle cwd.
  const activeSessions = listSessionsForGitHook(hookCwd);
  activeSessions.sort((a, b) => new Date(b.startedAt).getTime() - new Date(a.startedAt).getTime());
  if (activeSessions.length === 0) return null;
  if (activeSessions.length === 1) return activeSessions[0];

  // Multiple sessions — disambiguate via process detection.
  const agentChecks = [
    { cmd: 'pgrep -f "claude.*stream-json"', slug: 'claude' },
    { cmd: 'pgrep -f "gemini.*cli|/gemini "', slug: 'gemini' },
    { cmd: 'pgrep -f "codex"', slug: 'codex' },
    { cmd: 'pgrep -f "aider"', slug: 'aider' },
    { cmd: 'pgrep -f "windsurf"', slug: 'windsurf' },
    { cmd: 'pgrep -f "copilot.*cli|github-copilot"', slug: 'copilot' },
    { cmd: 'pgrep -f "continue.*dev"', slug: 'continue' },
    { cmd: 'pgrep -f "amp.*cli|/amp "', slug: 'amp' },
    { cmd: 'pgrep -f "junie|jetbrains.*ai"', slug: 'junie' },
    { cmd: 'pgrep -f "opencode"', slug: 'opencode' },
    { cmd: 'pgrep -f "rovo.*dev"', slug: 'rovo' },
    { cmd: 'pgrep -f "droid"', slug: 'droid' },
  ];
  for (const check of agentChecks) {
    try {
      if (safePgrep(check.cmd)) {
        const match = activeSessions.find((s) => sessionMatchesAgent(s, check.slug));
        if (match) return match;
      }
    } catch { /* no match */ }
  }
  // Ambiguous — don't guess.
  return null;
}

/**
 * Called by .git/hooks/prepare-commit-msg.
 * Adds Origin-Session and Origin-Snapshot trailers to COMMIT_EDITMSG
 * before the commit is created. Never throws.
 */
export async function handlePrepareCommitMsg(
  msgFile: string,
  source?: string,
): Promise<void> {
  debugLog('prepare-commit-msg', '=== GIT HOOK INVOKED ===', { msgFile, source });

  // Skip cases where we shouldn't be adding trailers:
  //   merge   — merge commit, author didn't write this
  //   squash  — squash merge, user is combining commits
  //   commit  — amend or rebase, existing message already has trailers if applicable
  if (source === 'merge' || source === 'squash' || source === 'commit') {
    debugLog('prepare-commit-msg', 'skip — source excluded', { source });
    return;
  }

  try {
    if (!msgFile || !fs.existsSync(msgFile)) {
      debugLog('prepare-commit-msg', 'skip — msgFile missing', { msgFile });
      return;
    }

    const hookCwd = process.cwd();
    const repoPath = getGitRoot(hookCwd);
    if (!repoPath) {
      debugLog('prepare-commit-msg', 'skip — not a git repo');
      return;
    }

    // Respect commitLinking config
    const config = loadConfig();
    const commitLinkingConfig = config?.commitLinking || 'always';
    if (commitLinkingConfig === 'never') {
      debugLog('prepare-commit-msg', 'skip — commitLinking=never');
      return;
    }

    const state = pickActiveSessionForCommit(hookCwd);
    if (!state) {
      debugLog('prepare-commit-msg', 'skip — no unambiguous active session');
      return;
    }

    // Check existing message for Origin-Session trailer. If present AND the
    // session ID matches, we're done (interpret-trailers addIfDifferent would
    // also handle this but a fast-path avoids the subprocess).
    let existing: string;
    try {
      existing = fs.readFileSync(msgFile, 'utf-8');
    } catch (readErr: any) {
      debugLog('prepare-commit-msg', 'could not read msg file (non-fatal)', { message: readErr.message });
      return;
    }
    const shortId = state.sessionId.slice(0, 12);
    if (existing.includes(`Origin-Session: ${shortId}`)) {
      debugLog('prepare-commit-msg', 'trailer already present for this session');
      return;
    }

    // Find latest snapshot for the Origin-Snapshot trailer.
    let latestSnapshotId: string | undefined;
    if (state.sessionTag) {
      try {
        const snapshots = listSnapshots(repoPath, state.sessionTag);
        if (snapshots.length > 0) latestSnapshotId = snapshots[snapshots.length - 1].id;
      } catch { /* no snapshots is fine */ }
    }

    const trailers = buildOriginTrailers(
      state.sessionId,
      state.model,
      state.prompts?.length || 0,
      latestSnapshotId,
    );

    // Use git interpret-trailers to add the trailers in-place. This handles:
    //   • Placing trailers after existing Co-Authored-By / Signed-off-by lines
    //   • Adding the blank line separator if needed
    //   • De-duplication via --if-exists=addIfDifferent (if a trailer with the
    //     same name+value already exists, it's not added again)
    const args = [
      'interpret-trailers',
      '--in-place',
      '--if-exists=addIfDifferent',
      '--if-missing=add',
    ];
    for (const t of trailers) args.push(`--trailer=${t}`);
    args.push(msgFile);

    try {
      execFileSync('git', args, {
        cwd: repoPath,
        encoding: 'utf-8',
        stdio: ['pipe', 'pipe', 'pipe'],
        timeout: 5000,
      });
      debugLog('prepare-commit-msg', 'trailers written', {
        sessionId: shortId,
        snapshotId: latestSnapshotId,
        trailerCount: trailers.length,
      });
    } catch (trailerErr: any) {
      debugLog('prepare-commit-msg', 'interpret-trailers failed (non-fatal)', { message: trailerErr.message });
    }
  } catch (err: any) {
    // Never fail the commit because of Origin's trailer hook.
    debugLog('prepare-commit-msg', 'top-level error (non-fatal)', { message: err.message });
  }
}

/**
 * Called by .git/hooks/pre-push.
 * Pushes origin-sessions branch and refs/notes/origin alongside the user's push.
 */
export async function handlePrePush(): Promise<void> {
  debugLog('pre-push', '=== GIT HOOK INVOKED ===');

  const hookCwd = process.cwd();
  const repoPath = getGitRoot(hookCwd);
  if (!repoPath) {
    debugLog('pre-push', 'SKIP: not a git repo');
    return;
  }

  const execOpts = {
    encoding: 'utf-8' as const,
    cwd: repoPath,
    stdio: ['pipe', 'pipe', 'pipe'] as ['pipe', 'pipe', 'pipe'],
    timeout: 15_000,
  };

  // Check if remote exists
  try {
    execFileSync('git', ['remote', 'get-url', 'origin'], execOpts);
  } catch {
    debugLog('pre-push', 'SKIP: no remote');
    return;
  }

  // In connected mode, session data goes to the API — don't push
  // origin-sessions branch to repo remote (may be public).
  const config = loadConfig();
  const connected = !!(config?.apiKey && config?.apiUrl);
  const strategy = config?.pushStrategy || 'auto';

  // ── Agent-disabled push gate ──────────────────────────────────────
  // When the org opted in (Org.pushBlockMode) and the developer's coding
  // agent is disabled in Origin, abort the push. Team connected keys only —
  // solo keys self-manage their auto-enabled agents (the server also
  // bypasses them). Best-effort + fail policy lives in decidePushBlock:
  // a blocked decision exits non-zero so git aborts the push.
  if (config && connected && config.keyType !== 'solo' && config.accountType !== 'developer') {
    // The whole gate is wrapped so an internal bug (config read, etc.) can
    // NEVER abort a legitimate push — only the deliberate process.exit(1)
    // below blocks, and process.exit isn't catchable. Governance must fail
    // open on its own errors; the real backstop is the PR merge gate.
    try {
      const repoConfig = loadRepoConfig(repoPath);
      const agentCfg = loadAgentConfig();
      const slug = repoConfig?.agent || agentCfg?.agentSlug || undefined;

      let reachable = true;
      let allowed: boolean | undefined;
      let agentName: string | null = null;
      let serverMode: string | undefined;
      // Bound the check — a slow/down API must never stall the developer's
      // push; on timeout we treat it as unreachable and apply the fail policy.
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 3000);
      try {
        const r = (await api.pushCheck(slug, controller.signal)) as { allowed?: boolean; agentName?: string | null; mode?: string };
        allowed = r?.allowed;
        agentName = r?.agentName ?? null;
        serverMode = r?.mode;
      } catch {
        reachable = false; // network/API error/timeout — apply cached fail policy
      } finally {
        clearTimeout(timeout);
      }

      // Refresh the cached mode whenever we reached the server, so a later
      // offline push applies the org's real fail policy.
      if (reachable && serverMode && serverMode !== config.pushBlockMode) {
        try { saveConfig({ ...config, pushBlockMode: serverMode }); } catch { /* cache is best-effort */ }
      }

      const decision = decidePushBlock({ reachable, allowed, agentName, cachedMode: config.pushBlockMode });
      if (decision.block) {
        console.error(`\n  ✖ Origin: push blocked — ${decision.reason}.`);
        console.error('    Ask an admin to enable your agent in Origin, then push again.');
        console.error('    To override this one push: git push --no-verify\n');
        debugLog('pre-push', 'BLOCKED', { reason: decision.reason, slug, reachable });
        process.exit(1);
      }
      debugLog('pre-push', 'push gate passed', { reachable, allowed, slug });
    } catch (err: any) {
      // Fail open on any unexpected internal error — never block a push due
      // to a gate bug.
      debugLog('pre-push', 'push gate errored — allowing push', { message: err?.message });
    }
  }

  // Push the origin-sessions branch whenever prompt portability is on (the
  // default) — connected OR standalone. The branch carries the full per-prompt
  // payloads (+ diffs) that let AI blame survive a clone or a re-connect to a
  // DIFFERENT Origin org: the server imports it on connect. This used to be
  // skipped in connected mode ("data goes to the API"), which meant a repo
  // connected to another org had no branch to import → no cross-org prompts/
  // blame, and developers had to `git push origin origin-sessions` by hand.
  // Privacy opt-out is the SAME flag that governs notes: notesIncludePrompts
  // = false (per repo/machine) suppresses both. snapshotRepo / pushStrategy
  // 'always' stay as explicit escape hatches.
  const pushSessionsBranch =
    shouldIncludePromptText(repoPath) || config?.snapshotRepo || strategy === 'always';
  if (pushSessionsBranch) {
    try {
      execFileSync('git', ['rev-parse', 'refs/heads/origin-sessions'], execOpts);
      execFileSync('git', ['push', 'origin', 'origin-sessions', '--no-verify', '--quiet'], execOpts);
      debugLog('pre-push', 'pushed origin-sessions');
    } catch (err: any) {
      debugLog('pre-push', 'origin-sessions push skipped', { message: err.message });
    }
  } else {
    debugLog('pre-push', 'SKIP origin-sessions push: prompt portability opted out');
  }

  // Push refs/notes/origin if they exist
  let hasLocalNotes = false;
  try {
    execFileSync('git', ['rev-parse', '--verify', '--quiet', 'refs/notes/origin'], execOpts);
    hasLocalNotes = true;
  } catch {
    debugLog('pre-push', 'SKIP notes push: no local refs/notes/origin');
  }
  if (hasLocalNotes) {
    const pushNotes = () =>
      execFileSync('git', ['push', 'origin', 'refs/notes/origin', '--no-verify', '--quiet'], execOpts);
    try {
      pushNotes();
      debugLog('pre-push', 'pushed refs/notes/origin');
    } catch (err: any) {
      // Almost always a non-fast-forward rejection: another worktree or
      // machine pushed newer notes since we last synced (each post-commit
      // appends to the shared notes ref). Fetch the remote notes, merge them
      // into ours, and retry the push ONCE. Strategy `ours` keeps the local
      // note when both sides annotated the SAME commit — notes are per-commit
      // JSON written by the committing machine, so ours is the authoritative
      // one here and line-level strategies (cat_sort_uniq) would corrupt it.
      try {
        execFileSync('git', ['fetch', '--no-tags', 'origin', '+refs/notes/origin:refs/notes/origin-remote'], execOpts);
        execFileSync('git', ['notes', '--ref=refs/notes/origin', 'merge', '-s', 'ours', 'refs/notes/origin-remote'], execOpts);
        pushNotes();
        debugLog('pre-push', 'pushed refs/notes/origin after merging remote notes');
      } catch (retryErr: any) {
        debugLog('pre-push', 'notes push skipped', { message: err.message, retryMessage: retryErr.message });
      }
    }
  }

  debugLog('pre-push', '=== GIT HOOK COMPLETE ===');
}

// ─── Main Entry Point ──────────────────────────────────────────────────────

/**
 * Self-heal duplicate Origin hook registrations across settings layers.
 *
 * Claude Code merges hooks from ~/.claude/settings.json (user) with
 * <cwd>/.claude/settings.json and ancestor directories. When `origin enable`
 * was run at multiple layers, the same `origin hooks claude-code <event>`
 * command ended up registered in both — and Claude fired the hook once per
 * registration. Every API call doubled, every state-file write doubled,
 * every heartbeat doubled. We saw the symptom as consecutive-PID twin
 * invocations on every event in ~/.origin/hooks.log.
 *
 * Resolution: user-level wins (broader scope, what `origin enable` defaults
 * to). If the local layer also has Origin hooks, strip them and write the
 * file back. Idempotent — once cleaned, subsequent invocations skip the
 * write. Claude won't re-read settings.json mid-session, so the current
 * conversation still doubles; the next session-start picks up the cleaned
 * config.
 */
function dedupeOriginHookLayers(event: string): void {
  const userSettingsPath = path.join(os.homedir(), '.claude', 'settings.json');
  // Read user-level. Bail unless it has Origin hooks — without a user-level
  // registration there's nothing to dedupe against.
  let userHasOrigin = false;
  try {
    const raw = fs.readFileSync(userSettingsPath, 'utf-8');
    const parsed = JSON.parse(raw);
    userHasOrigin = settingsHaveOriginClaudeHooks(parsed);
  } catch { /* user file missing or unreadable — skip dedupe */ }
  if (!userHasOrigin) return;

  // Walk up from cwd looking for .claude/settings.json files at the project
  // root and any intermediate worktree. Cap at 8 levels — repos don't nest
  // deeper than that in practice and infinite-loop protection is cheap.
  const visited = new Set<string>();
  let dir = process.cwd();
  for (let i = 0; i < 8; i++) {
    if (visited.has(dir)) break;
    visited.add(dir);
    const localSettingsPath = path.join(dir, '.claude', 'settings.json');
    if (localSettingsPath !== userSettingsPath && fs.existsSync(localSettingsPath)) {
      try {
        const raw = fs.readFileSync(localSettingsPath, 'utf-8');
        const parsed = JSON.parse(raw);
        if (settingsHaveOriginClaudeHooks(parsed)) {
          stripOriginClaudeHooksFromSettings(parsed);
          fs.writeFileSync(localSettingsPath, JSON.stringify(parsed, null, 2) + '\n');
          debugLog(event, 'AUTO-DEDUPED Origin hooks from local settings (user-level kept)', {
            removedFrom: localSettingsPath,
          });
        }
      } catch { /* unreadable — leave alone, user can fix manually */ }
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
}

function settingsHaveOriginClaudeHooks(parsed: any): boolean {
  if (!parsed || typeof parsed !== 'object' || !parsed.hooks) return false;
  for (const event of Object.keys(parsed.hooks)) {
    const entries = parsed.hooks[event];
    if (!Array.isArray(entries)) continue;
    for (const entry of entries) {
      if (!entry?.hooks || !Array.isArray(entry.hooks)) continue;
      for (const h of entry.hooks) {
        if (typeof h?.command === 'string' && h.command.includes('origin hooks claude-code')) {
          return true;
        }
      }
    }
  }
  return false;
}

function stripOriginClaudeHooksFromSettings(parsed: any): void {
  if (!parsed?.hooks) return;
  for (const event of Object.keys(parsed.hooks)) {
    const entries = parsed.hooks[event];
    if (!Array.isArray(entries)) continue;
    parsed.hooks[event] = entries.filter((entry: any) => {
      if (!entry?.hooks || !Array.isArray(entry.hooks)) return true;
      return !entry.hooks.some((h: any) =>
        typeof h?.command === 'string' && h.command.includes('origin hooks claude-code')
      );
    });
    // Drop the event key entirely when nothing else lives there — keeps
    // settings.json clean rather than leaving { "SessionStart": [] }.
    if (parsed.hooks[event].length === 0) {
      delete parsed.hooks[event];
    }
  }
}

/**
 * Self-heal for agents whose hook config is a flat JSON file at a known path.
 * Cursor / Windsurf use .cursor/hooks.json and .windsurf/hooks.json respectively.
 * Both files use the same schema: { version, hooks: { eventName: [{command}] } }
 * The dedup logic is simpler than Claude's layered settings: we check if BOTH the
 * user-level file (~/<dir>/hooks.json) AND a project-level file (./<dir>/hooks.json)
 * contain Origin commands for the same agent. If so, strip the project-level copy
 * (user-level wins, same rationale as the Claude dedupe).
 */
function dedupeAgentFlatHooks(event: string, agentDir: string, agentSlug: string): void {
  const userHooksPath = path.join(os.homedir(), agentDir, 'hooks.json');
  const originCmdSubstring = `origin hooks ${agentSlug}`;

  let userHasOrigin = false;
  try {
    const raw = fs.readFileSync(userHooksPath, 'utf-8');
    const parsed = JSON.parse(raw);
    userHasOrigin = flatHooksHaveOriginCommand(parsed, originCmdSubstring);
  } catch { return; }
  if (!userHasOrigin) return;

  // Walk cwd → root looking for project-level copies.
  const visited = new Set<string>();
  let dir = process.cwd();
  for (let i = 0; i < 8; i++) {
    if (visited.has(dir)) break;
    visited.add(dir);
    const localPath = path.join(dir, agentDir, 'hooks.json');
    if (localPath !== userHooksPath && fs.existsSync(localPath)) {
      try {
        const raw = fs.readFileSync(localPath, 'utf-8');
        const parsed = JSON.parse(raw);
        if (flatHooksHaveOriginCommand(parsed, originCmdSubstring)) {
          stripFlatHooksOriginCommand(parsed, originCmdSubstring);
          fs.writeFileSync(localPath, JSON.stringify(parsed, null, 2) + '\n');
          debugLog(event, `AUTO-DEDUPED ${agentSlug} hooks from local file (user-level kept)`, {
            removedFrom: localPath,
          });
        }
      } catch { /* unreadable — skip */ }
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
}

function flatHooksHaveOriginCommand(parsed: any, substring: string): boolean {
  if (!parsed?.hooks || typeof parsed.hooks !== 'object') return false;
  for (const entries of Object.values(parsed.hooks)) {
    if (!Array.isArray(entries)) continue;
    for (const h of entries) {
      if (typeof h?.command === 'string' && h.command.includes(substring)) return true;
    }
  }
  return false;
}

function stripFlatHooksOriginCommand(parsed: any, substring: string): void {
  if (!parsed?.hooks) return;
  for (const eventName of Object.keys(parsed.hooks)) {
    const entries = parsed.hooks[eventName];
    if (!Array.isArray(entries)) continue;
    parsed.hooks[eventName] = entries.filter(
      (h: any) => !(typeof h?.command === 'string' && h.command.includes(substring))
    );
    if (parsed.hooks[eventName].length === 0) delete parsed.hooks[eventName];
  }
}

export async function hooksCommand(event: string, agentSlug?: string): Promise<void> {
  debugLog(event, '=== HOOK INVOKED ===', { pid: process.pid, argv: process.argv, cwd: process.cwd() });

  // Self-heal duplicate registrations. Each agent has its own dedupe strategy:
  //   claude-code  — layered .claude/settings.json across user / project /
  //                  worktree layers (Claude merges all of them)
  //   cursor       — flat .cursor/hooks.json at user vs project level
  //   windsurf     — flat .windsurf/hooks.json at user vs project level
  //   gemini/codex — their settings files don't layer the same way; the
  //                  installer already dedupes on write, so skip here.
  // All paths are cheap (2-3 stat calls + maybe one read) and only write
  // when a duplicate actually exists.
  if (agentSlug === 'claude-code') {
    try { dedupeOriginHookLayers(event); } catch (err: any) {
      debugLog(event, 'dedupe check failed (non-fatal)', { message: err?.message });
    }
  } else if (agentSlug === 'cursor') {
    try { dedupeAgentFlatHooks(event, '.cursor', 'cursor'); } catch (err: any) {
      debugLog(event, 'cursor dedupe check failed (non-fatal)', { message: err?.message });
    }
  } else if (agentSlug === 'windsurf') {
    try { dedupeAgentFlatHooks(event, '.windsurf', 'windsurf'); } catch (err: any) {
      debugLog(event, 'windsurf dedupe check failed (non-fatal)', { message: err?.message });
    }
  }

  const input = await readStdin();

  switch (event) {
    case 'session-start':
      await handleSessionStart(input, agentSlug);
      break;
    case 'user-prompt-submit':
      await handleUserPromptSubmit(input, agentSlug);
      break;
    case 'stop':
      await handleStop(input, agentSlug);
      break;
    case 'session-end':
      await handleSessionEnd(input, agentSlug);
      break;
    case 'pre-tool-use':
      await handlePreToolUse(input, agentSlug);
      break;
    case 'post-tool-use':
      await handlePostToolUse(input, agentSlug);
      break;
    case 'after-file-edit':
      await handleAfterFileEdit(input, agentSlug);
      break;
    default:
      debugLog(event, 'unknown event');
      process.stderr.write(`[origin] unknown hook event: ${event}\n`);
  }

  debugLog(event, '=== HOOK COMPLETE ===');
}
