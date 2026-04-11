import chalk from 'chalk';
import fs from 'fs';
import path from 'path';
import { git, gitDetailed } from '../utils/exec.js';
import { getGitRoot, getBranch, loadSessionState, listActiveSessions } from '../session-state.js';

const BRANCH = 'origin-sessions';
const SAFE_ID = /^[a-zA-Z0-9_.-]+$/;

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

  const gitOpts = { cwd: repoPath };

  // Check if origin-sessions branch exists
  {
    const r = gitDetailed(['rev-parse', `refs/heads/${BRANCH}`], gitOpts);
    if (r.status !== 0) {
      console.error(chalk.yellow('No origin-sessions branch found. No session history available.'));
      process.exit(1);
    }
  }

  // Find the target branch — use provided arg, current branch, or most recent session
  const targetBranch = branch || getBranch(cwd) || 'main';

  // List all sessions on origin-sessions branch
  let sessionDirs: string[] = [];
  {
    const r = gitDetailed(['ls-tree', '--name-only', `refs/heads/${BRANCH}`, 'sessions/'], gitOpts);
    if (r.status !== 0) {
      console.error(chalk.yellow('No sessions found on origin-sessions branch.'));
      process.exit(1);
    }
    const tree = r.stdout.trim();
    sessionDirs = tree ? tree.split('\n').filter(Boolean) : [];
  }

  if (sessionDirs.length === 0) {
    console.error(chalk.yellow('No sessions found.'));
    process.exit(1);
  }

  // Find the most recent session matching the branch
  let bestSession: { dir: string; metadata: any } | null = null;
  let bestTimestamp = '';

  for (const dir of sessionDirs) {
    const dirName = dir.replace(/^sessions\//, '');
    if (!SAFE_ID.test(dirName)) continue;
    try {
      const metaRaw = git(
        ['show', `refs/heads/${BRANCH}:${dir}/metadata.json`],
        gitOpts,
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
      const dirName = dir.replace(/^sessions\//, '');
      if (!SAFE_ID.test(dirName)) continue;
      try {
        const metaRaw = git(
          ['show', `refs/heads/${BRANCH}:${dir}/metadata.json`],
          gitOpts,
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

  // Read prompts.md (dir already validated above)
  let promptsMd = '';
  try {
    promptsMd = git(
      ['show', `refs/heads/${BRANCH}:${bestSession.dir}/prompts.md`],
      gitOpts,
    ).trim();
  } catch { /* no prompts file */ }

  // Read changes
  let changes: any = null;
  try {
    const changesRaw = git(
      ['show', `refs/heads/${BRANCH}:${bestSession.dir}/changes.json`],
      gitOpts,
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
