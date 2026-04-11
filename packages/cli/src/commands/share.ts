import chalk from 'chalk';
import fs from 'fs';
import { run, runDetailed, git, gitDetailed } from '../utils/exec.js';
import { getGitRoot } from '../session-state.js';
import { loadConfig } from '../config.js';
import { api } from '../api.js';

const BRANCH = 'origin-sessions';
const SAFE_ID = /^[a-zA-Z0-9_.-]+$/;

/**
 * origin share <session-id> [--prompt <index>] [--public]
 *
 * Generate markdown bundle from a session. Copy to clipboard (pbcopy/xclip).
 * With --public (or when connected to platform): create a public share URL.
 */
export async function shareCommand(sessionId: string, opts?: { prompt?: string; output?: string; public?: boolean }): Promise<void> {
  const config = loadConfig();
  const isConnected = !!config?.apiUrl && !!config?.apiKey;

  // If --public flag or connected to platform, create a public share link
  if (opts?.public || (isConnected && !opts?.output && !opts?.prompt)) {
    if (!isConnected) {
      console.error(chalk.red('Not connected to Origin platform. Run: origin login'));
      process.exit(1);
    }

    try {
      const result = await api.shareSession(sessionId) as { url: string; slug: string; expiresAt: string | null };
      console.log('');
      console.log(chalk.green('  Public share link created!'));
      console.log('');
      console.log(`  ${chalk.cyan(result.url)}`);
      console.log('');
      if (result.expiresAt) {
        console.log(chalk.gray(`  Expires: ${new Date(result.expiresAt).toLocaleDateString()}`));
      } else {
        console.log(chalk.gray('  Link never expires'));
      }
      console.log('');

      // Also copy to clipboard
      if (copyToClipboard(result.url)) {
        console.log(chalk.gray('  (copied to clipboard)'));
      }

      return;
    } catch (err: any) {
      console.error(chalk.red(`Failed to create share link: ${err.message}`));
      process.exit(1);
    }
  }

  // Fall back to local markdown bundle share
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
      console.error(chalk.yellow('No origin-sessions branch found.'));
      process.exit(1);
    }
  }

  // Find the session — match by prefix
  let sessionDir = '';
  try {
    const tree = git(
      ['ls-tree', '--name-only', `refs/heads/${BRANCH}`, 'sessions/'],
      gitOpts,
    ).trim();
    const dirs = tree ? tree.split('\n').filter(Boolean) : [];

    for (const dir of dirs) {
      const dirName = dir.replace('sessions/', '');
      if (!SAFE_ID.test(dirName)) continue;
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
    const raw = git(
      ['show', `refs/heads/${BRANCH}:${sessionDir}/metadata.json`],
      gitOpts,
    ).trim();
    metadata = JSON.parse(raw);
  } catch {
    console.error(chalk.red('Could not read session metadata.'));
    process.exit(1);
  }

  // Read prompts
  let promptsMd = '';
  try {
    promptsMd = git(
      ['show', `refs/heads/${BRANCH}:${sessionDir}/prompts.md`],
      gitOpts,
    ).trim();
  } catch { /* no prompts */ }

  // Read changes
  let changes: any = null;
  try {
    const raw = git(
      ['show', `refs/heads/${BRANCH}:${sessionDir}/changes.json`],
      gitOpts,
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
  if (copyToClipboard(bundle)) {
    console.log(chalk.green(`Session ${sessionId.slice(0, 8)} copied to clipboard!`));
  } else {
    // Fallback: print to stdout
    console.log(bundle);
  }
}

function copyToClipboard(text: string): boolean {
  try {
    if (process.platform === 'darwin') {
      run('pbcopy', [], { input: text });
      return true;
    } else if (process.platform === 'linux') {
      const r = runDetailed('xclip', ['-selection', 'clipboard'], { input: text });
      if (r.status === 0) return true;
      const r2 = runDetailed('xsel', ['--clipboard', '--input'], { input: text });
      return r2.status === 0;
    }
  } catch { /* ignore */ }
  return false;
}

function formatDuration(ms: number): string {
  const seconds = Math.floor(ms / 1000);
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);
  if (hours > 0) return `${hours}h ${minutes % 60}m`;
  if (minutes > 0) return `${minutes}m ${seconds % 60}s`;
  return `${seconds}s`;
}
