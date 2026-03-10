import fs from 'fs';
import { execSync } from 'child_process';

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
      encoding: 'utf-8' as const,
      cwd: repoPath,
      stdio: ['pipe', 'pipe', 'pipe'] as ['pipe', 'pipe', 'pipe'],
      maxBuffer: 5 * 1024 * 1024,
    };

    // Sanitize sessionId for use as directory name
    const safeId = data.sessionId.replace(/[^a-zA-Z0-9_-]/g, '_');
    const dir = `sessions/${safeId}`;

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
    try {
      const existingTree = execSync(
        `git rev-parse refs/heads/${BRANCH}^{tree}`,
        execOpts,
      ).trim();
      execSync(`git read-tree ${existingTree}`, indexOpts);
    } catch {
      // Branch doesn't exist yet — start with empty index (orphan)
    }

    // 2. Write each file as a blob and add to temp index
    for (const [filepath, content] of files) {
      const blobHash = execSync(
        `git hash-object -w --stdin`,
        { ...execOpts, input: content },
      ).trim();

      execSync(
        `git update-index --add --cacheinfo 100644,${blobHash},${filepath}`,
        indexOpts,
      );
    }

    // 3. Write the tree
    const treeHash = execSync(`git write-tree`, indexOpts).trim();

    // 4. Create the commit
    const firstPrompt = (data.prompts[0]?.text || 'AI coding session').slice(0, 80);
    const commitMsg = `session ${safeId.slice(0, 8)}: ${data.model} — ${firstPrompt}`;

    let parentArg = '';
    try {
      const parentHash = execSync(
        `git rev-parse refs/heads/${BRANCH}`,
        execOpts,
      ).trim();
      parentArg = `-p ${parentHash}`;
    } catch {
      // No parent — first commit on orphan branch
    }

    const commitHash = execSync(
      `git commit-tree ${treeHash} ${parentArg} -m -`,
      { ...execOpts, input: commitMsg },
    ).trim();

    // 5. Update the branch ref
    execSync(
      `git update-ref refs/heads/${BRANCH} ${commitHash}`,
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
 * Push the `origin-sessions` branch to remote so session data is visible on GitHub.
 * Never blocks or throws. 15s timeout.
 */
export function pushSessionBranch(repoPath: string): void {
  try {
    const execOpts = {
      encoding: 'utf-8' as const,
      cwd: repoPath,
      stdio: ['pipe', 'pipe', 'pipe'] as ['pipe', 'pipe', 'pipe'],
      timeout: 15_000,
    };

    // Check if remote exists
    try {
      execSync('git remote get-url origin', execOpts);
    } catch {
      return; // no remote — nothing to push
    }

    execSync(`git push origin ${BRANCH} --no-verify --quiet`, execOpts);
  } catch {
    // Never fail — push is best-effort
  }
}
