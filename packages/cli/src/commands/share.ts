import chalk from 'chalk';
import { execSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { getGitRoot } from '../session-state.js';

const BRANCH = 'origin-sessions';

/**
 * origin share <session-id> [--prompt <index>]
 *
 * Generate markdown bundle from a session. Copy to clipboard (pbcopy/xclip).
 */
export async function shareCommand(sessionId: string, opts?: { prompt?: string; output?: string }): Promise<void> {
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
    console.error(chalk.yellow('No origin-sessions branch found.'));
    process.exit(1);
  }

  // Find the session — match by prefix
  let sessionDir = '';
  try {
    const tree = execSync(
      `git ls-tree --name-only refs/heads/${BRANCH} sessions/`,
      execOpts,
    ).trim();
    const dirs = tree ? tree.split('\n').filter(Boolean) : [];

    for (const dir of dirs) {
      const dirName = dir.replace('sessions/', '');
      if (dirName.startsWith(sessionId) || dirName === sessionId) {
        sessionDir = dir;
        break;
      }
    }
  } catch { /* ignore */ }

  if (!sessionDir) {
    console.error(chalk.red(`Session "${sessionId}" not found on origin-sessions branch.`));
    process.exit(1);
  }

  // Read metadata
  let metadata: any = {};
  try {
    const raw = execSync(
      `git show refs/heads/${BRANCH}:${sessionDir}/metadata.json`,
      execOpts,
    ).trim();
    metadata = JSON.parse(raw);
  } catch {
    console.error(chalk.red('Could not read session metadata.'));
    process.exit(1);
  }

  // Read prompts
  let promptsMd = '';
  try {
    promptsMd = execSync(
      `git show refs/heads/${BRANCH}:${sessionDir}/prompts.md`,
      execOpts,
    ).trim();
  } catch { /* no prompts */ }

  // Read changes
  let changes: any = null;
  try {
    const raw = execSync(
      `git show refs/heads/${BRANCH}:${sessionDir}/changes.json`,
      execOpts,
    ).trim();
    changes = JSON.parse(raw);
  } catch { /* no changes */ }

  // Build markdown bundle
  const lines: string[] = [];
  lines.push(`# Origin Session: ${metadata.sessionId?.slice(0, 8) || sessionId}`);
  lines.push('');
  lines.push(`| Field | Value |`);
  lines.push(`| --- | --- |`);
  lines.push(`| Model | ${metadata.model || 'unknown'} |`);
  lines.push(`| Branch | ${metadata.git?.branch || 'unknown'} |`);
  lines.push(`| Started | ${metadata.startedAt || 'unknown'} |`);
  lines.push(`| Ended | ${metadata.endedAt || 'unknown'} |`);
  lines.push(`| Duration | ${formatDuration(metadata.durationMs || 0)} |`);
  lines.push(`| Cost | $${(metadata.cost?.usd || 0).toFixed(4)} |`);
  lines.push(`| Tokens | ${(metadata.tokens?.total || 0).toLocaleString()} |`);
  lines.push(`| Lines | +${metadata.lines?.added || 0} / -${metadata.lines?.removed || 0} |`);
  lines.push('');

  if (metadata.filesChanged && metadata.filesChanged.length > 0) {
    lines.push('## Files Changed');
    lines.push('');
    for (const f of metadata.filesChanged) {
      lines.push(`- \`${f}\``);
    }
    lines.push('');
  }

  // If --prompt specified, only include that prompt
  if (opts?.prompt && changes?.changes) {
    const promptIndex = parseInt(opts.prompt, 10);
    const change = changes.changes.find((c: any) => c.promptIndex === promptIndex);
    if (change) {
      lines.push(`## Prompt ${promptIndex}`);
      lines.push('');
      lines.push(change.promptText);
      lines.push('');
      if (change.filesChanged?.length > 0) {
        lines.push('**Files:**');
        for (const f of change.filesChanged) {
          lines.push(`- \`${f}\``);
        }
        lines.push('');
      }
      if (change.diff) {
        lines.push('```diff');
        lines.push(change.diff.slice(0, 5000));
        lines.push('```');
        lines.push('');
      }
    } else {
      lines.push(`_Prompt ${promptIndex} not found._`);
      lines.push('');
    }
  } else if (promptsMd) {
    lines.push('## Prompts');
    lines.push('');
    lines.push(promptsMd);
    lines.push('');
  }

  if (metadata.summary) {
    lines.push('## Summary');
    lines.push('');
    lines.push(metadata.summary);
    lines.push('');
  }

  lines.push('---');
  lines.push(`_Shared via [Origin](${metadata.originUrl || 'https://getorigin.dev'})_`);

  const bundle = lines.join('\n');

  // Output to file or clipboard
  if (opts?.output) {
    fs.writeFileSync(opts.output, bundle);
    console.log(chalk.green(`Session bundle written to ${opts.output}`));
    return;
  }

  // Try to copy to clipboard
  try {
    if (process.platform === 'darwin') {
      execSync('pbcopy', { input: bundle, encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] });
      console.log(chalk.green(`Session ${sessionId.slice(0, 8)} copied to clipboard!`));
    } else if (process.platform === 'linux') {
      try {
        execSync('xclip -selection clipboard', { input: bundle, encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] });
      } catch {
        execSync('xsel --clipboard --input', { input: bundle, encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] });
      }
      console.log(chalk.green(`Session ${sessionId.slice(0, 8)} copied to clipboard!`));
    } else {
      // Windows or unsupported — print to stdout
      console.log(bundle);
    }
  } catch {
    // Fallback: print to stdout
    console.log(bundle);
  }
}

function formatDuration(ms: number): string {
  const seconds = Math.floor(ms / 1000);
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);
  if (hours > 0) return `${hours}h ${minutes % 60}m`;
  if (minutes > 0) return `${minutes}m ${seconds % 60}s`;
  return `${seconds}s`;
}
