import chalk from 'chalk';
import readline from 'readline';
import { getGitRoot, loadSessionState } from '../session-state.js';
import { git, gitDetailed } from '../utils/exec.js';
import {
  listCheckpoints,
  listPermanentCheckpoints,
  findCheckpointById,
  checkpointDiff,
  createCheckpoint,
  snapshotRestoreCommand,
  snapshotCleanCommand,
  type CheckpointOptions,
  type SnapshotMeta,
} from './snapshot.js';

// ─── Helpers ──────────────────────────────────────────────────────────────

function timeSince(date: Date): string {
  const seconds = Math.floor((Date.now() - date.getTime()) / 1000);
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

function formatCost(cost?: number): string {
  if (!cost) return '';
  return `$${cost.toFixed(4)}`;
}

function confirm(question: string): Promise<boolean> {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    rl.question(question, (answer) => { rl.close(); resolve(answer.toLowerCase().startsWith('y')); });
  });
}

function selectCheckpoint(prompt: string): Promise<number | null> {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    rl.question(prompt, (answer) => { rl.close(); resolve(isNaN(parseInt(answer)) ? null : parseInt(answer)); });
  });
}

// ─── Unified Checkpoint Type ─────────────────────────────────────────────

interface UnifiedCheckpoint {
  id: string;
  type: 'snapshot' | 'commit' | 'permanent';
  timestamp: string;
  prompt?: string;
  model?: string;
  filesChanged: string[];
  treeSha?: string;
  commitSha?: string;
  message?: string;
  tokensUsed?: number;
  costUsd?: number;
  promptIndex?: number;
  checkpointType?: string;
  parentCheckpointId?: string;
  attribution?: {
    linesAdded: number;
    linesRemoved: number;
    aiPercentage: number;
  };
}

function snapshotToUnified(s: SnapshotMeta, type: 'snapshot' | 'permanent' = 'snapshot'): UnifiedCheckpoint {
  return {
    id: s.id,
    type,
    timestamp: s.timestamp,
    prompt: s.prompt,
    model: s.model,
    filesChanged: s.filesChanged,
    treeSha: s.treeSha,
    commitSha: s.commitSha,
    tokensUsed: s.tokensUsed,
    costUsd: s.costUsd,
    promptIndex: s.promptIndex,
    checkpointType: s.type,
    parentCheckpointId: s.parentCheckpointId,
    attribution: s.attribution ? {
      linesAdded: s.attribution.linesAdded,
      linesRemoved: s.attribution.linesRemoved,
      aiPercentage: s.attribution.aiPercentage,
    } : undefined,
  };
}

// ─── Commands ─────────────────────────────────────────────────────────────

/**
 * origin checkpoint list — Show all checkpoints in unified timeline
 */
export async function checkpointListCommand(opts?: { all?: boolean }): Promise<void> {
  const cwd = process.cwd();
  const repoPath = getGitRoot(cwd);
  if (!repoPath) {
    console.error(chalk.red('  Not a git repository.'));
    process.exit(1);
  }

  const state = loadSessionState(cwd);
  const sessionTag = state?.sessionTag;

  // 1. Shadow branch checkpoints (active session)
  const snapshots = listCheckpoints(repoPath, opts?.all ? undefined : sessionTag)
    .map(s => snapshotToUnified(s));

  // 2. Permanent checkpoints (condensed on commit)
  const permanent = opts?.all
    ? listPermanentCheckpoints(repoPath).map(s => snapshotToUnified(s, 'permanent'))
    : [];

  // 3. Commit-based checkpoints from session range
  const commits: UnifiedCheckpoint[] = [];
  if (state?.headShaAtStart) {
    try {
      const HEX = /^[a-fA-F0-9]{4,64}$/;
      const log = git(
        ['log', '--format=%H%x00%h%x00%s%x00%an%x00%aI', `${state.headShaAtStart}..HEAD`],
        { cwd: repoPath },
      ).trim();
      if (log) {
        for (const line of log.split('\n').filter(Boolean)) {
          const [sha, shortSha, message, , timestamp] = line.split('\0');
          let filesChanged: string[] = [];
          try {
            const files = git(['diff-tree', '--no-commit-id', '--name-only', '-r', sha], { cwd: repoPath }).trim();
            filesChanged = files ? files.split('\n').filter(Boolean) : [];
          } catch { /* ignore */ }

          // Check for Origin note
          let model: string | undefined;
          const r = gitDetailed(['notes', '--ref=origin', 'show', sha], { cwd: repoPath });
          if (r.status === 0) {
            try {
              const noteData = JSON.parse(r.stdout.trim());
              model = noteData?.origin?.model || noteData?.model;
            } catch { /* ignore */ }
          }

          // Check for Origin-Checkpoint trailer (bidirectional link)
          let linkedCheckpointId: string | undefined;
          try {
            const fullMsg = git(['log', '-1', '--format=%B', sha], { cwd: repoPath });
            const match = fullMsg.match(/Origin-Checkpoint:\s*(\w+)/);
            if (match) linkedCheckpointId = match[1];
          } catch { /* ignore */ }

          commits.push({
            id: shortSha,
            type: 'commit',
            timestamp,
            model,
            filesChanged,
            commitSha: sha,
            message: linkedCheckpointId ? `${message} [cp:${linkedCheckpointId.slice(0, 8)}]` : message,
          });
        }
      }
    } catch { /* ignore */ }
  }

  // Merge all, dedup by ID, sort by time
  const seenIds = new Set<string>();
  const unified: UnifiedCheckpoint[] = [];
  for (const cp of [...snapshots, ...permanent, ...commits]) {
    if (seenIds.has(cp.id)) continue;
    seenIds.add(cp.id);
    unified.push(cp);
  }
  unified.sort((a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime());

  if (unified.length === 0) {
    console.log(chalk.gray('\n  No checkpoints found.'));
    console.log(chalk.gray('  Checkpoints are auto-created after each AI prompt.\n'));
    return;
  }

  console.log(chalk.bold(`\n  Checkpoints${sessionTag ? ` (session: ${sessionTag})` : ''}\n`));

  for (let i = 0; i < unified.length; i++) {
    const cp = unified[i];
    const idx = String(i + 1).padStart(3);
    const age = timeSince(new Date(cp.timestamp));

    // Icons: ◉ shadow, ● commit, ◆ permanent
    const typeIcon = cp.type === 'permanent'
      ? chalk.magenta('◆')
      : cp.type === 'snapshot'
        ? chalk.blue('◉')
        : chalk.green('●');

    const typeLabel = cp.checkpointType
      ? chalk.gray(`[${cp.checkpointType}]`)
      : cp.type === 'commit'
        ? chalk.gray('[commit]')
        : cp.type === 'permanent'
          ? chalk.gray('[saved]')
          : chalk.gray('[snapshot]');

    const modelStr = cp.model ? chalk.cyan(` ${cp.model}`) : '';
    const costStr = cp.costUsd ? chalk.yellow(` ${formatCost(cp.costUsd)}`) : '';
    const tokenStr = cp.tokensUsed ? chalk.gray(` ${(cp.tokensUsed / 1000).toFixed(1)}k tok`) : '';
    const fileCount = cp.filesChanged.length;
    const fileStr = fileCount > 0 ? chalk.gray(` ${fileCount} file${fileCount === 1 ? '' : 's'}`) : '';
    const chainStr = cp.parentCheckpointId ? chalk.gray(` ← ${cp.parentCheckpointId.slice(0, 8)}`) : '';
    const attrStr = cp.attribution
      ? chalk.magenta(` ${cp.attribution.aiPercentage}% AI +${cp.attribution.linesAdded}/-${cp.attribution.linesRemoved}`)
      : '';

    console.log(`  ${idx}. ${typeIcon} ${chalk.yellow(cp.id)} ${chalk.gray(age)} ${typeLabel}${modelStr}${costStr}${tokenStr}${fileStr}${attrStr}${chainStr}`);

    // Prompt preview
    if (cp.prompt) {
      const preview = cp.prompt.slice(0, 80).replace(/\n/g, ' ');
      console.log(`       ${chalk.white('→')} ${chalk.gray(preview)}${cp.prompt.length > 80 ? '…' : ''}`);
    }

    // Commit message
    if (cp.message) {
      console.log(`       ${chalk.white('→')} ${chalk.gray(cp.message.slice(0, 80))}`);
    }

    // Show first few files
    if (cp.filesChanged.length > 0) {
      const shown = cp.filesChanged.slice(0, 3);
      for (const f of shown) {
        console.log(chalk.gray(`         ${f}`));
      }
      if (cp.filesChanged.length > 3) {
        console.log(chalk.gray(`         ... +${cp.filesChanged.length - 3} more`));
      }
    }
    console.log('');
  }

  // Prompt for restore
  const selection = await selectCheckpoint(
    chalk.white('  Enter checkpoint # to restore (or press Enter to cancel): '),
  );

  if (selection === null || selection < 1 || selection > unified.length) {
    console.log(chalk.gray('  Cancelled.'));
    return;
  }

  const selected = unified[selection - 1];

  if (selected.type === 'snapshot' || selected.type === 'permanent') {
    await snapshotRestoreCommand(selected.id);
  } else if (selected.commitSha) {
    const confirmed = await confirm(
      chalk.yellow(`\n  Restore to commit ${selected.id}? This will overwrite your working directory. [y/N] `),
    );
    if (!confirmed) {
      console.log(chalk.gray('  Cancelled.'));
      return;
    }

    // Safety: save current state first
    console.log(chalk.gray('  Saving current state before restore...'));
    createCheckpoint(repoPath, { type: 'manual', sessionTag: state?.sessionTag });

    try {
      git(['checkout', selected.commitSha, '--', '.'], { cwd: repoPath });
      console.log(chalk.green(`\n  Restored to commit ${selected.id}: ${selected.message || ''}`));
    } catch (err: any) {
      console.error(chalk.red(`  Failed to restore: ${err.message}`));
    }
  }
}

/**
 * origin checkpoint save — Manually save a checkpoint
 */
export async function checkpointSaveCommand(opts?: { message?: string }): Promise<void> {
  const cwd = process.cwd();
  const repoPath = getGitRoot(cwd);
  if (!repoPath) {
    console.error(chalk.red('  Not a git repository.'));
    process.exit(1);
  }

  const state = loadSessionState(cwd);
  const id = createCheckpoint(repoPath, {
    sessionTag: state?.sessionTag,
    type: 'manual',
    model: state?.model,
    prompt: opts?.message,
  });

  if (id) {
    console.log(chalk.green(`  Checkpoint saved: ${chalk.bold(id)}`));
  } else {
    console.log(chalk.yellow('  No changes to checkpoint (working tree matches last checkpoint).'));
  }
}

/**
 * origin checkpoint restore <id> — Restore to a checkpoint
 */
export async function checkpointRestoreCommand(id: string): Promise<void> {
  await snapshotRestoreCommand(id);
}

/**
 * origin checkpoint diff [fromId] [toId] — Show diff between checkpoints
 */
export async function checkpointDiffCommand(fromId?: string, toId?: string): Promise<void> {
  const cwd = process.cwd();
  const repoPath = getGitRoot(cwd);
  if (!repoPath) {
    console.error(chalk.red('  Not a git repository.'));
    process.exit(1);
  }

  if (!fromId) {
    const state = loadSessionState(cwd);
    const checkpoints = listCheckpoints(repoPath, state?.sessionTag);
    if (checkpoints.length === 0) {
      console.log(chalk.gray('  No checkpoints to diff against.'));
      return;
    }
    fromId = checkpoints[checkpoints.length - 1].id;
    console.log(chalk.gray(`  Diffing last checkpoint (${fromId}) against working tree...\n`));
  }

  const diff = checkpointDiff(repoPath, fromId, toId);
  if (diff === null) {
    console.error(chalk.red(`  Checkpoint not found: ${fromId}`));
    return;
  }

  if (!diff.trim()) {
    console.log(chalk.gray('  No differences.'));
    return;
  }

  for (const line of diff.split('\n')) {
    if (line.startsWith('+') && !line.startsWith('+++')) {
      console.log(chalk.green(line));
    } else if (line.startsWith('-') && !line.startsWith('---')) {
      console.log(chalk.red(line));
    } else if (line.startsWith('@@')) {
      console.log(chalk.cyan(line));
    } else if (line.startsWith('diff ')) {
      console.log(chalk.bold(line));
    } else {
      console.log(line);
    }
  }
}

/**
 * origin checkpoint clean — Remove all checkpoint branches
 */
export async function checkpointCleanCommand(): Promise<void> {
  await snapshotCleanCommand();
}
