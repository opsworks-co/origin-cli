import fs from 'fs';
import { git, gitDetailed, gitOrNull } from './utils/exec.js';
import { loadConfig } from './config.js';

// ─── Types ─────────────────────────────────────────────────────────────────

/** Session-level metrics → sessions/{sessionId}/metadata.json */
export interface SessionMetadata {
  version: 1;
  sessionId: string;
  model: string;
  startedAt: string;
  endedAt: string;
  durationMs: number;
  status: 'running' | 'ended';
  tokens: { total: number; input: number; output: number };
  cost: { usd: number };
  toolCalls: number;
  lines: { added: number; removed: number };
  filesChanged: string[];
  git: {
    branch: string;
    headBefore: string;
    headAfter: string;
    commitShas: string[];
  };
  summary: string;
  originUrl: string;
}

/** A single prompt for building prompts.md */
export interface PromptEntry {
  index: number;          // 1-based
  text: string;
  filesChanged: string[];
}

/** Per-prompt change record → sessions/{sessionId}/changes.json */
export interface PromptChange {
  promptIndex: number;    // 1-based, matches ## Prompt N in prompts.md
  promptText: string;     // first 200 chars
  filesChanged: string[];
  diff: string;           // unified diff
}

export interface SessionChanges {
  version: 1;
  sessionId: string;
  changes: PromptChange[];
}

/** Unified input — callers assemble this, we derive all 3 files from it */
export interface SessionWriteData {
  sessionId: string;
  model: string;
  startedAt: string;
  endedAt: string;
  durationMs: number;
  status: 'running' | 'ended';
  costUsd: number;
  tokensUsed: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens?: number;
  cacheCreationTokens?: number;
  toolCalls: number;
  linesAdded: number;
  linesRemoved: number;
  prompts: PromptEntry[];
  filesChanged: string[];
  git: {
    branch: string;
    headBefore: string;
    headAfter: string;
    commitShas: string[];
  };
  summary: string;
  originUrl: string;
  changes: PromptChange[];
}

// ─── Constants ─────────────────────────────────────────────────────────────

const BRANCH = 'origin-sessions';

// ─── File Builders ─────────────────────────────────────────────────────────

function buildMetadataJson(data: SessionWriteData): string {
  const metadata: SessionMetadata = {
    version: 1,
    sessionId: data.sessionId,
    model: data.model,
    startedAt: data.startedAt,
    endedAt: data.endedAt,
    durationMs: data.durationMs,
    status: data.status,
    tokens: {
      total: data.tokensUsed,
      input: data.inputTokens,
      output: data.outputTokens,
    },
    cost: { usd: data.costUsd },
    toolCalls: data.toolCalls,
    lines: { added: data.linesAdded, removed: data.linesRemoved },
    filesChanged: data.filesChanged,
    git: data.git,
    summary: data.summary,
    originUrl: data.originUrl,
  };
  return JSON.stringify(metadata, null, 2) + '\n';
}

function formatDuration(ms: number): string {
  const seconds = Math.floor(ms / 1000);
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);
  if (hours > 0) return `${hours}h ${minutes % 60}m`;
  if (minutes > 0) return `${minutes}m ${seconds % 60}s`;
  return `${seconds}s`;
}

function buildPromptsMd(data: SessionWriteData): string {
  const lines: string[] = [];
  lines.push(`# Session ${data.sessionId.slice(0, 8)}`);
  lines.push('');
  lines.push(`**Model:** ${data.model}  `);
  lines.push(`**Started:** ${data.startedAt}  `);
  lines.push(`**Duration:** ${formatDuration(data.durationMs)}  `);
  lines.push(`**Cost:** $${data.costUsd.toFixed(4)}  `);
  lines.push(`**Tokens:** ${data.tokensUsed.toLocaleString()}  `);
  lines.push(`**Status:** ${data.status}  `);
  lines.push('');
  lines.push('---');
  lines.push('');

  if (data.prompts.length === 0) {
    lines.push('_No prompts recorded._');
    lines.push('');
  }

  for (const prompt of data.prompts) {
    lines.push(`## Prompt ${prompt.index}`);
    lines.push('');
    lines.push(prompt.text);
    lines.push('');
    if (prompt.filesChanged.length > 0) {
      lines.push('**Files changed:**');
      for (const f of prompt.filesChanged) {
        lines.push(`- \`${f}\``);
      }
      lines.push('');
    }
    lines.push('---');
    lines.push('');
  }

  return lines.join('\n');
}

function buildChangesJson(data: SessionWriteData): string {
  const changes: SessionChanges = {
    version: 1,
    sessionId: data.sessionId,
    changes: data.changes,
  };
  return JSON.stringify(changes, null, 2) + '\n';
}

// ─── Git Plumbing ──────────────────────────────────────────────────────────

/**
 * Write session files to the `origin-sessions` orphan branch using git plumbing.
 *
 * Creates/updates a directory per session:
 *   sessions/{sessionId}/metadata.json
 *   sessions/{sessionId}/prompts.md
 *   sessions/{sessionId}/changes.json
 *
 * Uses a temp index scoped by PID to avoid races between Stop and PostCommit hooks.
 * Never touches the working directory or current branch. Never throws.
 */
export function writeSessionFiles(repoPath: string, data: SessionWriteData): void {
  try {
    const execOpts = {
      cwd: repoPath,
      timeoutMs: 10_000,
      maxBuffer: 5 * 1024 * 1024,
    };

    // Sanitize sessionId for use as directory name
    const safeId = data.sessionId.replace(/[^a-zA-Z0-9_-]/g, '_');
    const dir = `sessions/${safeId}`;

    // "Don't downgrade" guard: if the branch already has this session's
    // metadata with MORE prompts than we're about to write, skip the write.
    // This prevents the workspace post-commit hook (stale session with 0 prompts)
    // from overwriting good data written by the Stop hook (18+ prompts).
    try {
      const existingMeta = git(
        ['show', `refs/heads/${BRANCH}:${dir}/metadata.json`],
        execOpts,
      ).trim();
      const existing = JSON.parse(existingMeta) as SessionMetadata;
      // Always let 'ended' status overwrite 'running' — session-end has final data
      if (data.status === 'running' && existing.status === 'ended') {
        return; // Don't downgrade ended → running
      }
      // For same status, skip if existing data is richer
      if (data.status === existing.status && existing.cost.usd > data.costUsd && data.prompts.length === 0) {
        return;
      }
    } catch {
      // No existing data for this session — proceed with write
    }

    // Build file contents
    const files: Array<[string, string]> = [
      [`${dir}/metadata.json`, buildMetadataJson(data)],
      [`${dir}/prompts.md`, buildPromptsMd(data)],
      [`${dir}/changes.json`, buildChangesJson(data)],
    ];

    // PID-scoped temp index to avoid races
    const tmpIndex = `${repoPath}/.git/origin-tmp-index-${process.pid}`;
    const envWithIndex = { ...process.env, GIT_INDEX_FILE: tmpIndex };
    const indexOpts = { ...execOpts, env: envWithIndex };

    // 1. Seed temp index from existing branch tree (if any)
    const existingTree = gitOrNull(['rev-parse', `refs/heads/${BRANCH}^{tree}`], execOpts);
    if (existingTree && /^[a-fA-F0-9]+$/.test(existingTree)) {
      try {
        git(['read-tree', existingTree], indexOpts);
      } catch { /* best effort */ }
    }

    // 2. Write each file as a blob and add to temp index
    for (const [filepath, content] of files) {
      const blobRes = gitDetailed(['hash-object', '-w', '--stdin'], { ...execOpts, input: content });
      if (blobRes.status !== 0) continue;
      const blobHash = blobRes.stdout.trim();
      if (!/^[a-fA-F0-9]+$/.test(blobHash)) continue;

      git(
        ['update-index', '--add', '--cacheinfo', `100644,${blobHash},${filepath}`],
        indexOpts,
      );
    }

    // 3. Write the tree
    const treeHash = git(['write-tree'], indexOpts).trim();
    if (!/^[a-fA-F0-9]+$/.test(treeHash)) return;

    // 4. Create the commit
    const firstPrompt = (data.prompts[0]?.text || 'AI coding session').slice(0, 80);
    const commitMsg = `session ${safeId.slice(0, 8)}: ${data.model} — ${firstPrompt}`;

    const parentHash = gitOrNull(['rev-parse', `refs/heads/${BRANCH}`], execOpts);
    const commitArgs = ['commit-tree', treeHash];
    if (parentHash && /^[a-fA-F0-9]+$/.test(parentHash)) {
      commitArgs.push('-p', parentHash);
    }
    commitArgs.push('-m', commitMsg);
    const commitRes = gitDetailed(commitArgs, execOpts);
    if (commitRes.status !== 0) return;
    const commitHash = commitRes.stdout.trim();
    if (!/^[a-fA-F0-9]+$/.test(commitHash)) return;

    // 5. Update the branch ref
    git(
      ['update-ref', `refs/heads/${BRANCH}`, commitHash],
      execOpts,
    );

    // 6. Clean up temp index
    try {
      fs.unlinkSync(tmpIndex);
    } catch {
      // ignore cleanup errors
    }
  } catch {
    // Never fail — best-effort local write
  }
}

/**
 * Add fetch refspecs to the repo's `origin` remote so `git fetch` pulls
 * Origin's session branch and notes ref by default. Without this, the
 * data lives on the remote but a fresh clone never sees it locally.
 *
 * Idempotent — only adds each refspec if not already present. Never
 * throws.
 */
export function configureGitFetchForOrigin(repoPath: string): void {
  try {
    const execOpts = { cwd: repoPath, timeoutMs: 5_000 };

    // Bail if there's no `origin` remote.
    const remote = gitDetailed(['remote', 'get-url', 'origin'], execOpts);
    if (remote.status !== 0) return;

    const refspecs = [
      '+refs/notes/origin:refs/notes/origin',
      '+refs/heads/origin-sessions:refs/heads/origin-sessions',
    ];

    // Read existing fetch refspecs once to avoid duplicates.
    const existing = gitOrNull(['config', '--get-all', 'remote.origin.fetch'], execOpts) || '';
    const existingLines = new Set(existing.split('\n').map((s) => s.trim()).filter(Boolean));

    for (const refspec of refspecs) {
      if (existingLines.has(refspec)) continue;
      try {
        git(['config', '--add', 'remote.origin.fetch', refspec], execOpts);
      } catch { /* best-effort */ }
    }
  } catch {
    // Never fail — config is best-effort
  }
}

/**
 * Push the `origin-sessions` branch AND `refs/notes/origin` to remote so
 * session data + per-commit blame travel with the repo. Any clone of the
 * repo can then have its prompts/snapshots restored without needing the
 * original Origin account that captured them.
 *
 * Never blocks or throws. 15s timeout.
 *
 * Respects config.pushStrategy:
 *   - 'auto' (default): push automatically
 *   - 'prompt': skip (user will push manually or via pre-push hook)
 *   - 'false': never push
 */
export function pushSessionBranch(repoPath: string): void {
  try {
    const config = loadConfig();
    const strategy = config?.pushStrategy || 'auto';
    if (strategy === 'false') return;
    if (strategy === 'prompt') return;

    const execOpts = {
      cwd: repoPath,
      timeoutMs: 15_000,
    };

    const snapshotRepo = config?.snapshotRepo;

    // Single helper so we apply the same shell-injection guard to both the
    // session branch and the notes ref.
    const pushTo = (target: string, refspec: string) => {
      if (target.startsWith('-')) return;
      if (!/^[a-zA-Z0-9_./:@+%~=-]+$/.test(target)) return;
      try {
        git(['push', '--no-verify', '--quiet', '--', target, refspec], execOpts);
      } catch {
        // Swallow — push is best-effort. Common harmless failures: no
        // remote, no permissions, branch already up to date.
      }
    };

    const target = snapshotRepo || 'origin';
    if (!snapshotRepo) {
      // Validate the origin remote exists; otherwise nothing to push.
      const remote = gitDetailed(['remote', 'get-url', 'origin'], execOpts);
      if (remote.status !== 0) return;
      // Make sure this repo's git config will also *fetch* notes + the
      // session branch on `git fetch` / `git pull`. Idempotent.
      configureGitFetchForOrigin(repoPath);
    }

    // 1) Session branch (prompts + snapshots).
    pushTo(target, BRANCH);
    // 2) Git notes ref (per-commit blame). Push as the same ref name so
    //    a fresh clone can fetch it back with refs/notes/origin.
    pushTo(target, 'refs/notes/origin:refs/notes/origin');
  } catch {
    // Never fail — push is best-effort
  }
}
