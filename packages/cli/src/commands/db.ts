import chalk from 'chalk';
import { execSync } from 'child_process';
import { insertPrompts, getPromptCount, type PromptRecord } from '../local-db.js';
import { deduplicateStore } from '../local-db.js';
import { getGitRoot } from '../session-state.js';
import { loadConfig } from '../config.js';

// ─── Helpers ──────────────────────────────────────────────────────────────

/**
 * Walk the origin-sessions branch and extract all prompts from prompts.md files.
 */
function importFromSessionsBranch(repoPath: string): PromptRecord[] {
  const records: PromptRecord[] = [];

  try {
    // List all session directories
    const listing = execSync(
      `git ls-tree --name-only refs/heads/origin-sessions sessions/`,
      {
        encoding: 'utf-8',
        cwd: repoPath,
        stdio: ['pipe', 'pipe', 'pipe'],
      },
    ).trim();

    if (!listing) return records;

    const dirs = listing.split('\n').filter(Boolean);

    for (const dir of dirs) {
      const sessionId = dir.replace('sessions/', '');

      // Read metadata for model info
      let model = 'unknown';
      let startedAt = '';
      try {
        const metaRaw = execSync(
          `git show refs/heads/origin-sessions:${dir}/metadata.json`,
          {
            encoding: 'utf-8',
            cwd: repoPath,
            stdio: ['pipe', 'pipe', 'pipe'],
          },
        ).trim();
        const meta = JSON.parse(metaRaw);
        model = meta.model || 'unknown';
        startedAt = meta.startedAt || '';
      } catch { /* ignore */ }

      // Read prompts.md
      try {
        const promptsMd = execSync(
          `git show refs/heads/origin-sessions:${dir}/prompts.md`,
          {
            encoding: 'utf-8',
            cwd: repoPath,
            stdio: ['pipe', 'pipe', 'pipe'],
          },
        ).trim();

        // Parse prompts from markdown
        const sections = promptsMd.split(/^## Prompt (\d+)/m);
        // sections[0] is header, then alternating: number, content
        for (let i = 1; i < sections.length; i += 2) {
          const promptIndex = parseInt(sections[i], 10) - 1;
          const content = sections[i + 1] || '';

          // Extract prompt text (before **Files changed:** section)
          const text = content.split('**Files changed:**')[0].trim();
          if (!text || text === '_No prompts recorded._') continue;

          // Extract files changed
          const filesChanged: string[] = [];
          const filesSection = content.split('**Files changed:**')[1];
          if (filesSection) {
            const fileLines = filesSection.split('---')[0].trim().split('\n');
            for (const line of fileLines) {
              const match = line.match(/^- `(.+)`$/);
              if (match) filesChanged.push(match[1]);
            }
          }

          records.push({
            id: `${sessionId}-${promptIndex}`,
            sessionId,
            promptIndex,
            promptText: text,
            timestamp: startedAt,
            model,
            repoPath,
            filesChanged,
          });
        }
      } catch { /* skip session */ }
    }
  } catch { /* branch doesn't exist */ }

  return records;
}

// ─── Commands ─────────────────────────────────────────────────────────────

/**
 * origin db import
 *
 * Walks origin-sessions branch and imports all prompts to local database.
 */
export async function dbImportCommand(opts?: { format?: string; file?: string }): Promise<void> {
  const cwd = process.cwd();
  const repoPath = getGitRoot(cwd);
  if (!repoPath) {
    console.error(chalk.red('Error: Not in a git repository.'));
    return;
  }

  // Handle agent-trace format
  const format = (opts?.format || '').toLowerCase();
  if (format === 'agent-trace') {
    const { importAgentTrace } = await import('../agent-trace.js');
    const fs = await import('fs');

    let input: string;
    if (opts?.file) {
      input = fs.readFileSync(opts.file, 'utf-8');
    } else {
      // Read from stdin
      input = fs.readFileSync(0, 'utf-8');
    }

    try {
      const traceData = JSON.parse(input);
      importAgentTrace(repoPath, traceData);
      console.log(chalk.green(`  Imported Agent Trace v${traceData.version} (${traceData.files?.length || 0} files) as git notes on ${traceData.vcs?.revision?.slice(0, 8) || 'unknown'}.`));
    } catch (err: any) {
      console.error(chalk.red(`Failed to import agent trace: ${err.message}`));
    }
    return;
  }

  // If checkpointRepo is configured, fetch origin-sessions from external repo first
  const config = loadConfig();
  if (config?.checkpointRepo) {
    console.log(chalk.gray(`Fetching origin-sessions from checkpoint repo...`));
    try {
      execSync(
        `git fetch ${config.checkpointRepo} origin-sessions:origin-sessions --force`,
        {
          encoding: 'utf-8',
          cwd: repoPath,
          stdio: ['pipe', 'pipe', 'pipe'],
          timeout: 30_000,
        },
      );
    } catch (err: any) {
      console.log(chalk.yellow(`Warning: Could not fetch from checkpoint repo: ${err.message}`));
    }
  }

  console.log(chalk.gray('Scanning origin-sessions branch...'));

  const records = importFromSessionsBranch(repoPath);
  if (records.length === 0) {
    console.log(chalk.gray('No prompts found on origin-sessions branch.'));
    return;
  }

  console.log(chalk.gray(`Found ${records.length} prompts from ${new Set(records.map(r => r.sessionId)).size} sessions.`));

  insertPrompts(records);

  const totalCount = getPromptCount();
  console.log(chalk.green(`Imported ${records.length} prompts. Local database now has ${totalCount} total prompts.`));
}

/**
 * origin db stats
 *
 * Show local database statistics.
 */
export async function dbStatsCommand(): Promise<void> {
  const promptCount = getPromptCount();
  const blobStats = deduplicateStore();

  console.log(chalk.bold('\n  Local Database Stats\n'));
  console.log(`  ${chalk.gray('Total prompts:')}  ${chalk.white(String(promptCount))}`);
  console.log(`  ${chalk.gray('Stored blobs:')}   ${chalk.white(String(blobStats.totalBlobs))}`);
  console.log(`  ${chalk.gray('Blob storage:')}   ${chalk.white(formatBytes(blobStats.totalSize))}`);
  console.log('');
}

function formatBytes(bytes: number): string {
  if (bytes === 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
}
