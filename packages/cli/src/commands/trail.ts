import chalk from 'chalk';
import {
  type Trail,
  generateTrailId,
  readTrail,
  listTrails,
  writeTrail,
  findTrailByBranch,
} from '../trail-state.js';
import { getGitRoot, getBranch } from '../session-state.js';

// ─── Helpers ──────────────────────────────────────────────────────────────

const STATUS_COLORS: Record<string, (s: string) => string> = {
  active: chalk.green,
  review: chalk.yellow,
  done: chalk.blue,
  paused: chalk.gray,
};

const PRIORITY_COLORS: Record<string, (s: string) => string> = {
  low: chalk.gray,
  medium: chalk.white,
  high: chalk.yellow,
  critical: chalk.red,
};

function formatTrailSummary(trail: Trail, verbose: boolean = false): string {
  const statusFn = STATUS_COLORS[trail.status] || chalk.white;
  const priorityFn = PRIORITY_COLORS[trail.priority] || chalk.white;
  const id = chalk.gray(trail.id.slice(0, 12));
  const status = statusFn(trail.status.toUpperCase().padEnd(7));
  const priority = priorityFn(trail.priority);
  const name = chalk.bold(trail.name);
  const branch = chalk.cyan(trail.branch);
  const sessions = chalk.gray(`${trail.sessions.length} sessions`);

  let line = `  ${id}  ${status}  ${priority.padEnd(10)}  ${name}`;
  if (verbose) {
    line += `\n           ${chalk.gray('Branch:')} ${branch}  ${sessions}`;
    if (trail.labels.length > 0) {
      line += `\n           ${chalk.gray('Labels:')} ${trail.labels.map(l => chalk.magenta(l)).join(', ')}`;
    }
    if (trail.reviewers.length > 0) {
      line += `\n           ${chalk.gray('Reviewers:')} ${trail.reviewers.join(', ')}`;
    }
    line += `\n           ${chalk.gray('Updated:')} ${new Date(trail.updatedAt).toLocaleString()}`;
  }
  return line;
}

// ─── Commands ─────────────────────────────────────────────────────────────

/**
 * origin trail (no subcommand) — show current trail for this branch
 */
export async function trailCommand(opts?: { verbose?: boolean }): Promise<void> {
  const cwd = process.cwd();
  const repoPath = getGitRoot(cwd);
  if (!repoPath) {
    console.error(chalk.red('Error: Not in a git repository.'));
    return;
  }

  const branch = getBranch(cwd);
  if (!branch) {
    console.error(chalk.red('Error: Could not determine current branch.'));
    return;
  }

  const trail = findTrailByBranch(repoPath, branch);
  if (!trail) {
    console.log(chalk.gray(`No trail associated with branch "${branch}".`));
    console.log(chalk.gray('Create one with: origin trail create <name>'));
    return;
  }

  console.log(chalk.bold('\n  Current Trail\n'));
  console.log(formatTrailSummary(trail, true));
  console.log('');
}

/**
 * origin trail list [--status <status>] [--label <label>]
 */
export async function trailListCommand(
  opts?: { status?: string; label?: string; verbose?: boolean },
): Promise<void> {
  const cwd = process.cwd();
  const repoPath = getGitRoot(cwd);
  if (!repoPath) {
    console.error(chalk.red('Error: Not in a git repository.'));
    return;
  }

  let trails = listTrails(repoPath);

  // Apply filters
  if (opts?.status) {
    trails = trails.filter(t => t.status === opts.status);
  }
  if (opts?.label) {
    trails = trails.filter(t => t.labels.includes(opts.label!));
  }

  if (trails.length === 0) {
    console.log(chalk.gray('No trails found.'));
    return;
  }

  console.log(chalk.bold('\n  Trails\n'));
  console.log(chalk.gray(`  ${'ID'.padEnd(14)}  ${'Status'.padEnd(9)}  ${'Priority'.padEnd(10)}  Name`));
  console.log(chalk.gray('  ' + '─'.repeat(70)));

  for (const trail of trails) {
    console.log(formatTrailSummary(trail, opts?.verbose));
  }
  console.log(chalk.gray(`\n  ${trails.length} trail${trails.length === 1 ? '' : 's'}\n`));
}

/**
 * origin trail create <name> [--priority <p>] [--label <l>]
 */
export async function trailCreateCommand(
  name: string,
  opts?: { priority?: string; label?: string },
): Promise<void> {
  const cwd = process.cwd();
  const repoPath = getGitRoot(cwd);
  if (!repoPath) {
    console.error(chalk.red('Error: Not in a git repository.'));
    return;
  }

  const branch = getBranch(cwd);
  if (!branch) {
    console.error(chalk.red('Error: Could not determine current branch.'));
    return;
  }

  // Check if a trail already exists for this branch
  const existing = findTrailByBranch(repoPath, branch);
  if (existing) {
    console.log(chalk.yellow(`A trail already exists for branch "${branch}": ${existing.name} (${existing.id.slice(0, 12)})`));
    return;
  }

  const priority = (opts?.priority || 'medium') as Trail['priority'];
  if (!['low', 'medium', 'high', 'critical'].includes(priority)) {
    console.error(chalk.red(`Invalid priority "${priority}". Use: low, medium, high, critical`));
    return;
  }

  const labels = opts?.label ? [opts.label] : [];
  const now = new Date().toISOString();

  const trail: Trail = {
    id: generateTrailId(),
    name,
    branch,
    repoPath,
    status: 'active',
    priority,
    labels,
    reviewers: [],
    sessions: [],
    createdAt: now,
    updatedAt: now,
  };

  writeTrail(repoPath, trail);
  console.log(chalk.green(`Trail created: ${trail.name} (${trail.id.slice(0, 12)})`));
  console.log(chalk.gray(`  Branch: ${branch}`));
  console.log(chalk.gray(`  Priority: ${priority}`));
  if (labels.length > 0) {
    console.log(chalk.gray(`  Labels: ${labels.join(', ')}`));
  }
}

/**
 * origin trail update [id] --status <status> [--priority <p>]
 */
export async function trailUpdateCommand(
  id?: string,
  opts?: { status?: string; priority?: string },
): Promise<void> {
  const cwd = process.cwd();
  const repoPath = getGitRoot(cwd);
  if (!repoPath) {
    console.error(chalk.red('Error: Not in a git repository.'));
    return;
  }

  // Find trail by ID or current branch
  let trail: Trail | null = null;
  if (id) {
    // Try full ID first, then prefix match
    trail = readTrail(repoPath, id);
    if (!trail) {
      const trails = listTrails(repoPath);
      trail = trails.find(t => t.id.startsWith(id)) || null;
    }
  } else {
    const branch = getBranch(cwd);
    if (branch) {
      trail = findTrailByBranch(repoPath, branch);
    }
  }

  if (!trail) {
    console.error(chalk.red('Error: Trail not found. Specify an ID or be on a branch with an associated trail.'));
    return;
  }

  let updated = false;

  if (opts?.status) {
    const validStatuses = ['active', 'review', 'done', 'paused'];
    if (!validStatuses.includes(opts.status)) {
      console.error(chalk.red(`Invalid status "${opts.status}". Use: ${validStatuses.join(', ')}`));
      return;
    }
    trail.status = opts.status as Trail['status'];
    updated = true;
  }

  if (opts?.priority) {
    const validPriorities = ['low', 'medium', 'high', 'critical'];
    if (!validPriorities.includes(opts.priority)) {
      console.error(chalk.red(`Invalid priority "${opts.priority}". Use: ${validPriorities.join(', ')}`));
      return;
    }
    trail.priority = opts.priority as Trail['priority'];
    updated = true;
  }

  if (!updated) {
    console.log(chalk.yellow('Nothing to update. Use --status or --priority.'));
    return;
  }

  trail.updatedAt = new Date().toISOString();
  writeTrail(repoPath, trail);
  console.log(chalk.green(`Trail updated: ${trail.name}`));
  console.log(formatTrailSummary(trail, true));
}

/**
 * origin trail assign <user> [trailId]
 */
export async function trailAssignCommand(
  user: string,
  trailId?: string,
): Promise<void> {
  const cwd = process.cwd();
  const repoPath = getGitRoot(cwd);
  if (!repoPath) {
    console.error(chalk.red('Error: Not in a git repository.'));
    return;
  }

  let trail: Trail | null = null;
  if (trailId) {
    trail = readTrail(repoPath, trailId);
    if (!trail) {
      const trails = listTrails(repoPath);
      trail = trails.find(t => t.id.startsWith(trailId)) || null;
    }
  } else {
    const branch = getBranch(cwd);
    if (branch) {
      trail = findTrailByBranch(repoPath, branch);
    }
  }

  if (!trail) {
    console.error(chalk.red('Error: Trail not found.'));
    return;
  }

  if (!trail.reviewers.includes(user)) {
    trail.reviewers.push(user);
    trail.updatedAt = new Date().toISOString();
    writeTrail(repoPath, trail);
    console.log(chalk.green(`Assigned ${user} as reviewer on trail "${trail.name}".`));
  } else {
    console.log(chalk.gray(`${user} is already a reviewer on trail "${trail.name}".`));
  }
}

/**
 * origin trail label <label> [trailId]
 */
export async function trailLabelCommand(
  label: string,
  trailId?: string,
): Promise<void> {
  const cwd = process.cwd();
  const repoPath = getGitRoot(cwd);
  if (!repoPath) {
    console.error(chalk.red('Error: Not in a git repository.'));
    return;
  }

  let trail: Trail | null = null;
  if (trailId) {
    trail = readTrail(repoPath, trailId);
    if (!trail) {
      const trails = listTrails(repoPath);
      trail = trails.find(t => t.id.startsWith(trailId)) || null;
    }
  } else {
    const branch = getBranch(cwd);
    if (branch) {
      trail = findTrailByBranch(repoPath, branch);
    }
  }

  if (!trail) {
    console.error(chalk.red('Error: Trail not found.'));
    return;
  }

  if (!trail.labels.includes(label)) {
    trail.labels.push(label);
    trail.updatedAt = new Date().toISOString();
    writeTrail(repoPath, trail);
    console.log(chalk.green(`Added label "${label}" to trail "${trail.name}".`));
  } else {
    console.log(chalk.gray(`Label "${label}" already exists on trail "${trail.name}".`));
  }
}
