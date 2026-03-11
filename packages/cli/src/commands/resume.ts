import chalk from 'chalk';
import { execSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import { getGitRoot, getBranch, loadSessionState, listActiveSessions } from '../session-state.js';

const BRANCH = 'origin-sessions';

/**
 * origin resume [branch]
 *
 * Read session data from origin-sessions orphan branch.
 * Output markdown context block suitable for piping to claude/cursor.
 */
export async function resumeCommand(branch?: string, opts?: { json?: boolean }): Promise<void> {
  const cwd = process.cwd();
  const repoPath = getGitRoot(cwd);

  if (!repoPath) {
    console.error(chalk.red('Not inside a git repository.'));
    process.exit(1);
  }

  const execOpts = {
    encoding: 'utf-8' as const,
    cwd: repoPath,
    stdio: ['pipe', 'pipe', 'pipe'] as ['pipe', 'pipe', 'pipe'],
  };

  // Check if origin-sessions branch exists
  try {
    execSync(`git rev-parse refs/heads/${BRANCH}`, execOpts);
  } catch {
    console.error(chalk.yellow('No origin-sessions branch found. No session history available.'));
    process.exit(1);
  }

  // Find the target branch — use provided arg, current branch, or most recent session
  const targetBranch = branch || getBranch(cwd) || 'main';

  // List all sessions on origin-sessions branch
  let sessionDirs: string[] = [];
  try {
    const tree = execSync(
      `git ls-tree --name-only refs/heads/${BRANCH} sessions/`,
      execOpts,
    ).trim();
    sessionDirs = tree ? tree.split('\n').filter(Boolean) : [];
  } catch {
    console.error(chalk.yellow('No sessions found on origin-sessions branch.'));
    process.exit(1);
  }

  if (sessionDirs.length === 0) {
    console.error(chalk.yellow('No sessions found.'));
    process.exit(1);
  }

  // Find the most recent session matching the branch
  let bestSession: { dir: string; metadata: any } | null = null;
  let bestTimestamp = '';

  for (const dir of sessionDirs) {
    try {
      const metaRaw = execSync(
        `git show refs/heads/${BRANCH}:${dir}/metadata.json`,
        execOpts,
      ).trim();
      const metadata = JSON.parse(metaRaw);

      // Match by branch if specified, otherwise take most recent
      if (metadata.git?.branch === targetBranch || !branch) {
        if (!bestSession || metadata.endedAt > bestTimestamp || metadata.startedAt > bestTimestamp) {
          bestSession = { dir, metadata };
          bestTimestamp = metadata.endedAt || metadata.startedAt;
        }
      }
    } catch {
      // Skip sessions we can't read
    }
  }

  if (!bestSession) {
    console.error(chalk.yellow(`No session found for branch "${targetBranch}".`));
    // Show available branches
    const branches = new Set<string>();
    for (const dir of sessionDirs) {
      try {
        const metaRaw = execSync(
          `git show refs/heads/${BRANCH}:${dir}/metadata.json`,
          execOpts,
        ).trim();
        const metadata = JSON.parse(metaRaw);
        if (metadata.git?.branch) branches.add(metadata.git.branch);
      } catch { /* skip */ }
    }
    if (branches.size > 0) {
      console.log(chalk.gray(`\nAvailable branches with sessions: ${[...branches].join(', ')}`));
    }
    process.exit(1);
  }

  // Read prompts.md
  let promptsMd = '';
  try {
    promptsMd = execSync(
      `git show refs/heads/${BRANCH}:${bestSession.dir}/prompts.md`,
      execOpts,
    ).trim();
  } catch { /* no prompts file */ }

  // Read changes
  let changes: any = null;
  try {
    const changesRaw = execSync(
      `git show refs/heads/${BRANCH}:${bestSession.dir}/changes.json`,
      execOpts,
    ).trim();
    changes = JSON.parse(changesRaw);
  } catch { /* no changes file */ }

  const meta = bestSession.metadata;

  if (opts?.json) {
    // JSON output mode
    console.log(JSON.stringify({
      sessionId: meta.sessionId,
      model: meta.model,
      branch: meta.git?.branch,
      startedAt: meta.startedAt,
      endedAt: meta.endedAt,
      filesChanged: meta.filesChanged,
      prompts: promptsMd,
      changes: changes?.changes,
      headBefore: meta.git?.headBefore,
      headAfter: meta.git?.headAfter,
    }, null, 2));
    return;
  }

  // Generate markdown context block for piping to an AI agent
  const contextLines: string[] = [];
  contextLines.push('<context source="origin-resume">');
  contextLines.push('');
  contextLines.push(`# Resuming Session ${meta.sessionId?.slice(0, 8) || 'unknown'}`);
  contextLines.push('');
  contextLines.push(`**Model:** ${meta.model || 'unknown'}`);
  contextLines.push(`**Branch:** ${meta.git?.branch || 'unknown'}`);
  contextLines.push(`**Started:** ${meta.startedAt || 'unknown'}`);
  contextLines.push(`**Last HEAD:** ${meta.git?.headAfter || 'unknown'}`);
  contextLines.push('');

  if (meta.filesChanged && meta.filesChanged.length > 0) {
    contextLines.push('## Files Changed');
    contextLines.push('');
    for (const f of meta.filesChanged.slice(0, 50)) {
      contextLines.push(`- \`${f}\``);
    }
    if (meta.filesChanged.length > 50) {
      contextLines.push(`- ... and ${meta.filesChanged.length - 50} more`);
    }
    contextLines.push('');
  }

  if (promptsMd) {
    contextLines.push('## Previous Session Prompts');
    contextLines.push('');
    contextLines.push(promptsMd);
    contextLines.push('');
  }

  if (meta.summary) {
    contextLines.push('## Last Summary');
    contextLines.push('');
    contextLines.push(meta.summary);
    contextLines.push('');
  }

  contextLines.push('</context>');

  console.log(contextLines.join('\n'));
}
