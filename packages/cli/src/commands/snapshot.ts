import chalk from 'chalk';
import fs from 'fs';
import path from 'path';
import { git, gitDetailed } from '../utils/exec.js';
import { getGitRoot, getGitDir } from '../session-state.js';

const HEX = /^[a-fA-F0-9]{4,64}$/;
const SAFE_BRANCH = /^[a-zA-Z0-9_./-]+$/;

// ─── Types ────────────────────────────────────────────────────────────────

interface SnapshotMeta {
  id: string;
  timestamp: string;
  sessionTag: string;
  filesChanged: string[];
  treeSha: string;
  branch: string;
}

// ─── Helpers ──────────────────────────────────────────────────────────────

const SHADOW_PREFIX = 'origin/shadow/';

const gitOpts = (cwd: string) => ({ cwd });

function getSessionTag(repoPath: string): string {
  // Try to read session tag from active session state
  const gitDir = getGitDir(repoPath);
  if (gitDir) {
    const resolvedGitDir = path.isAbsolute(gitDir) ? gitDir : path.resolve(repoPath, gitDir);
    try {
      const entries = fs.readdirSync(resolvedGitDir);
      for (const entry of entries) {
        if (entry.startsWith('origin-session') && entry.endsWith('.json')) {
          const content = JSON.parse(fs.readFileSync(path.join(resolvedGitDir, entry), 'utf-8'));
          if (content.sessionTag) return content.sessionTag;
          if (content.sessionId) return content.sessionId.slice(0, 8);
        }
      }
    } catch { /* ignore */ }
  }
  // Fallback: use current branch + date
  try {
    const branch = git(['rev-parse', '--abbrev-ref', 'HEAD'], gitOpts(repoPath)).trim();
    return `${branch}-${new Date().toISOString().slice(0, 10)}`;
  } catch {
    return `session-${Date.now()}`;
  }
}

function shadowBranchName(sessionTag: string, timestamp: string): string {
  // Replace colons and other special chars for branch name safety
  const safestamp = timestamp.replace(/[:.]/g, '-');
  const safeTag = sessionTag.replace(/[^a-zA-Z0-9_.-]/g, '-');
  return `${SHADOW_PREFIX}${safeTag}-${safestamp}`;
}

function listShadowBranches(repoPath: string, sessionTag?: string): string[] {
  try {
    const safeTag = sessionTag ? sessionTag.replace(/[^a-zA-Z0-9_.-]/g, '-') : '';
    const pattern = safeTag
      ? `refs/heads/${SHADOW_PREFIX}${safeTag}-*`
      : `refs/heads/${SHADOW_PREFIX}*`;
    const output = git(
      ['for-each-ref', '--format=%(refname:short)', pattern],
      gitOpts(repoPath),
    ).trim();
    if (!output) return [];
    return output.split('\n').filter(Boolean);
  } catch {
    return [];
  }
}

function parseSnapshotMeta(repoPath: string, branch: string): SnapshotMeta | null {
  if (!SAFE_BRANCH.test(branch)) return null;
  try {
    const message = git(['log', '-1', '--format=%B', branch], gitOpts(repoPath));
    const meta = JSON.parse(message.trim());
    return meta as SnapshotMeta;
  } catch {
    return null;
  }
}

// ─── Commands ─────────────────────────────────────────────────────────────

/**
 * origin snapshot — manually save a snapshot of current working tree state
 */
export async function snapshotSaveCommand(): Promise<void> {
  const cwd = process.cwd();
  const repoPath = getGitRoot(cwd);

  if (!repoPath) {
    console.error(chalk.red('  Not a git repository.'));
    process.exit(1);
  }

  try {
    // Use git stash create to capture working tree state without affecting index
    let stashSha: string;
    try {
      stashSha = git(['stash', 'create'], gitOpts(repoPath)).trim();
    } catch {
      stashSha = '';
    }

    if (!stashSha) {
      // No changes to snapshot — use HEAD tree instead
      console.log(chalk.yellow('  No uncommitted changes to snapshot. Saving HEAD state.'));
      stashSha = git(['rev-parse', 'HEAD'], gitOpts(repoPath)).trim();
    }

    if (!HEX.test(stashSha)) {
      throw new Error('Invalid stash sha');
    }

    // Get the tree SHA from the stash/commit
    const treeSha = git(['rev-parse', `${stashSha}^{tree}`], gitOpts(repoPath)).trim();
    if (!HEX.test(treeSha)) {
      throw new Error('Invalid tree sha');
    }

    // Determine changed files
    let filesChanged: string[] = [];
    try {
      const diff = git(['diff', '--name-only', 'HEAD'], gitOpts(repoPath));
      const staged = git(['diff', '--name-only', '--cached', 'HEAD'], gitOpts(repoPath));
      const allFiles = new Set([
        ...diff.split('\n').filter(Boolean),
        ...staged.split('\n').filter(Boolean),
      ]);
      filesChanged = Array.from(allFiles);
    } catch { /* ignore */ }

    // Build metadata
    const sessionTag = getSessionTag(repoPath);
    const timestamp = new Date().toISOString();
    const id = `${Date.now().toString(36)}`;
    const branchName = shadowBranchName(sessionTag, timestamp);

    const meta: SnapshotMeta = {
      id,
      timestamp,
      sessionTag,
      filesChanged,
      treeSha,
      branch: branchName,
    };

    // Create orphan commit with the tree and metadata as the commit message
    const commitSha = git(
      ['commit-tree', treeSha, '-m', JSON.stringify(meta)],
      gitOpts(repoPath),
    ).trim();
    if (!HEX.test(commitSha)) {
      throw new Error('Invalid commit sha');
    }

    // Create the shadow branch pointing to this commit
    git(['branch', branchName, commitSha], gitOpts(repoPath));

    console.log(chalk.green(`  Snapshot saved: ${chalk.bold(id)}`));
    console.log(chalk.gray(`  Branch: ${branchName}`));
    console.log(chalk.gray(`  Tree:   ${treeSha.slice(0, 12)}`));
    if (filesChanged.length > 0) {
      console.log(chalk.gray(`  Files:  ${filesChanged.length} changed`));
    }
  } catch (err: any) {
    console.error(chalk.red(`  Failed to create snapshot: ${err.message}`));
    process.exit(1);
  }
}

/**
 * origin snapshot list — list all snapshots for current session
 */
export async function snapshotListCommand(): Promise<void> {
  const cwd = process.cwd();
  const repoPath = getGitRoot(cwd);

  if (!repoPath) {
    console.error(chalk.red('  Not a git repository.'));
    process.exit(1);
  }

  const sessionTag = getSessionTag(repoPath);
  const branches = listShadowBranches(repoPath, sessionTag);

  if (branches.length === 0) {
    // Also check all snapshots
    const allBranches = listShadowBranches(repoPath);
    if (allBranches.length === 0) {
      console.log(chalk.gray('  No snapshots found.'));
    } else {
      console.log(chalk.gray(`  No snapshots for current session. ${allBranches.length} snapshot(s) from other sessions exist.`));
      console.log(chalk.gray('  Use origin snapshot list --all to see all.'));
    }
    return;
  }

  console.log(chalk.bold(`\n  Snapshots for session: ${sessionTag}\n`));

  for (const branch of branches) {
    const meta = parseSnapshotMeta(repoPath, branch);
    if (meta) {
      const age = timeSince(new Date(meta.timestamp));
      const files = meta.filesChanged.length > 0
        ? chalk.gray(`${meta.filesChanged.length} files`)
        : chalk.gray('(clean)');
      console.log(`  ${chalk.cyan(meta.id)}  ${age}  ${files}  ${chalk.gray(meta.treeSha.slice(0, 8))}`);
    } else {
      console.log(`  ${chalk.gray(branch)}`);
    }
  }

  console.log('');
}

/**
 * origin snapshot restore <id> — restore working tree to a snapshot
 */
export async function snapshotRestoreCommand(id: string): Promise<void> {
  const cwd = process.cwd();
  const repoPath = getGitRoot(cwd);

  if (!repoPath) {
    console.error(chalk.red('  Not a git repository.'));
    process.exit(1);
  }

  // Find the snapshot branch matching this ID
  const allBranches = listShadowBranches(repoPath);
  let targetBranch: string | null = null;
  let targetMeta: SnapshotMeta | null = null;

  for (const branch of allBranches) {
    const meta = parseSnapshotMeta(repoPath, branch);
    if (meta && meta.id === id) {
      targetBranch = branch;
      targetMeta = meta;
      break;
    }
  }

  if (!targetBranch || !targetMeta) {
    console.error(chalk.red(`  Snapshot not found: ${id}`));
    console.log(chalk.gray('  Run: origin snapshot list'));
    process.exit(1);
  }

  try {
    // Save current state as a snapshot first (safety net)
    console.log(chalk.gray('  Saving current state before restore...'));
    await snapshotSaveCommand();

    if (!HEX.test(targetMeta.treeSha)) {
      throw new Error('Invalid tree sha in snapshot');
    }

    // Restore: use git read-tree + git checkout-index from the snapshot tree
    git(['read-tree', targetMeta.treeSha], gitOpts(repoPath));
    git(['checkout-index', '-a', '-f'], gitOpts(repoPath));

    // Reset index back to HEAD to avoid staged changes confusion
    git(['read-tree', 'HEAD'], gitOpts(repoPath));

    console.log(chalk.green(`\n  Restored to snapshot ${chalk.bold(id)} from ${timeSince(new Date(targetMeta.timestamp))}`));
    if (targetMeta.filesChanged.length > 0) {
      console.log(chalk.gray(`  Files affected: ${targetMeta.filesChanged.join(', ')}`));
    }
  } catch (err: any) {
    console.error(chalk.red(`  Failed to restore snapshot: ${err.message}`));
    process.exit(1);
  }
}

/**
 * origin snapshot clean — remove all shadow snapshot branches
 */
export async function snapshotCleanCommand(): Promise<void> {
  const cwd = process.cwd();
  const repoPath = getGitRoot(cwd);

  if (!repoPath) {
    console.error(chalk.red('  Not a git repository.'));
    process.exit(1);
  }

  const allBranches = listShadowBranches(repoPath);

  if (allBranches.length === 0) {
    console.log(chalk.gray('  No snapshots to clean.'));
    return;
  }

  console.log(chalk.bold(`\n  Removing ${allBranches.length} snapshot branch(es)...\n`));

  let removed = 0;
  for (const branch of allBranches) {
    if (!SAFE_BRANCH.test(branch)) {
      console.log(chalk.yellow(`  Skipped unsafe branch name: ${branch}`));
      continue;
    }
    const r = gitDetailed(['branch', '-D', branch], gitOpts(repoPath));
    if (r.status === 0) {
      removed++;
      console.log(chalk.gray(`  Removed: ${branch}`));
    } else {
      console.log(chalk.yellow(`  Failed to remove: ${branch}`));
    }
  }

  console.log(chalk.green(`\n  Cleaned ${removed} snapshot(s).\n`));
}

/**
 * Create a snapshot programmatically (used by auto-snapshot in hooks).
 * Returns the snapshot ID or null on failure.
 */
export function createAutoSnapshot(repoPath: string, sessionTag?: string): string | null {
  try {
    // Use git stash create to capture working tree state
    let stashSha: string;
    try {
      stashSha = git(['stash', 'create'], gitOpts(repoPath)).trim();
    } catch {
      stashSha = '';
    }

    if (!stashSha) {
      // No uncommitted changes — nothing to snapshot
      return null;
    }

    if (!HEX.test(stashSha)) return null;

    const treeSha = git(['rev-parse', `${stashSha}^{tree}`], gitOpts(repoPath)).trim();
    if (!HEX.test(treeSha)) return null;

    let filesChanged: string[] = [];
    try {
      const diff = git(['diff', '--name-only', 'HEAD'], gitOpts(repoPath));
      filesChanged = diff.split('\n').filter(Boolean);
    } catch { /* ignore */ }

    const tag = sessionTag || getSessionTag(repoPath);
    const timestamp = new Date().toISOString();
    const id = `${Date.now().toString(36)}`;
    const branchName = shadowBranchName(tag, timestamp);

    const meta: SnapshotMeta = {
      id,
      timestamp,
      sessionTag: tag,
      filesChanged,
      treeSha,
      branch: branchName,
    };

    const commitSha = git(
      ['commit-tree', treeSha, '-m', JSON.stringify(meta)],
      gitOpts(repoPath),
    ).trim();
    if (!HEX.test(commitSha)) return null;

    git(['branch', branchName, commitSha], gitOpts(repoPath));

    return id;
  } catch {
    return null;
  }
}

// ─── Utilities ────────────────────────────────────────────────────────────

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
