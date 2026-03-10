import fs from 'fs';
import { execSync } from 'child_process';

// ─── Types ─────────────────────────────────────────────────────────────────

export interface LocalEntrypoint {
  sessionId: string;
  model: string;
  startedAt: string;
  endedAt: string;
  durationMs: number;
  costUsd: number;
  tokensUsed: number;
  inputTokens: number;
  outputTokens: number;
  toolCalls: number;
  linesAdded: number;
  linesRemoved: number;
  prompts: string[];
  filesChanged: string[];
  promptChanges: Array<{ prompt: string; files: string[] }>;
  git: {
    headBefore: string;
    headAfter: string;
    commitShas: string[];
  };
  summary: string;
  originUrl: string;
}

// ─── Constants ─────────────────────────────────────────────────────────────

const BRANCH = 'origin-sessions';

// ─── Git Plumbing ──────────────────────────────────────────────────────────

/**
 * Commit a session entrypoint JSON file to the `origin-sessions` orphan branch
 * using low-level git plumbing commands. This NEVER touches the working directory,
 * index, or current branch — it writes directly to git's object store.
 *
 * Flow:
 *   1. Write JSON content as a blob object
 *   2. Build a tree with all existing files + new file (using a temp index)
 *   3. Create a commit pointing to that tree
 *   4. Update the branch ref
 *
 * Never throws — silently fails so it can't break the session-end hook.
 */
export function writeLocalEntrypoint(repoPath: string, data: LocalEntrypoint): void {
  try {
    const execOpts = {
      encoding: 'utf-8' as const,
      cwd: repoPath,
      stdio: ['pipe', 'pipe', 'pipe'] as ['pipe', 'pipe', 'pipe'],
      maxBuffer: 5 * 1024 * 1024,
    };

    const content = JSON.stringify(data, null, 2) + '\n';

    // Filename: sanitized ISO timestamp + short SHA
    const timestamp = data.endedAt
      .replace(/:/g, '-')
      .replace(/\.\d+Z$/, 'Z');
    const shortSha = (data.git.headAfter || 'unknown').slice(0, 8);
    const filepath = `sessions/${timestamp}_${shortSha}.json`;

    // Use a temporary index file so we don't touch the real index
    const tmpIndex = `${repoPath}/.git/origin-tmp-index`;
    const envWithIndex = { ...process.env, GIT_INDEX_FILE: tmpIndex };
    const indexOpts = { ...execOpts, env: envWithIndex };

    // 1. Start from existing branch tree (if any)
    try {
      const existingTree = execSync(
        `git rev-parse refs/heads/${BRANCH}^{tree}`,
        execOpts,
      ).trim();
      // Seed the temp index from the existing tree
      execSync(`git read-tree ${existingTree}`, indexOpts);
    } catch {
      // Branch doesn't exist yet — start with empty index (orphan)
    }

    // 2. Write the JSON as a blob and add to temp index
    const blobHash = execSync(
      `git hash-object -w --stdin`,
      { ...execOpts, input: content },
    ).trim();

    execSync(
      `git update-index --add --cacheinfo 100644,${blobHash},${filepath}`,
      indexOpts,
    );

    // 3. Write the tree from the temp index
    const treeHash = execSync(`git write-tree`, indexOpts).trim();

    // 4. Create the commit
    const firstPrompt = (data.prompts[0] || 'AI coding session').slice(0, 80);
    const commitMsg = `session: ${data.model} — ${firstPrompt}`;

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
    // Never fail the session — this is a best-effort local write
  }
}
