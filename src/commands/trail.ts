import chalk from 'chalk';
import { api } from '../api.js';
import { isConnectedMode } from '../config.js';

// ─── Feature Trails (read-only CLI view over the server) ────────────────────
//
// Trails are a server/dashboard feature: created in the web UI (Sessions →
// Trails), scoped to a repo + branch patterns, and auto-collected from
// finished sessions server-side. The CLI used to keep its own parallel
// per-repo git-ref trail store; that has been retired so there is a SINGLE
// source of truth. The CLI now just reads trails from the API; creation and
// management happen in the dashboard.

interface ApiTrail {
  id: string;
  name: string;
  status: string;
  priority: string;
  repoName?: string | null;
  branch?: string | null;
  branches?: string[];
  labels?: string[];
  sessionCount?: number;
  totalCost?: number;
  updatedAt?: string;
}

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

const DASHBOARD_HINT = 'Create and manage trails in the Origin dashboard → Sessions → Trails.';

/** True (and prints guidance) when this machine isn't connected to a platform. */
function requireConnected(): boolean {
  if (isConnectedMode()) return true;
  console.log(chalk.gray('Feature Trails are managed in the Origin platform.'));
  console.log(chalk.gray('Connect with `origin login`, then use Sessions → Trails in the dashboard.'));
  return false;
}

function formatTrail(t: ApiTrail, verbose: boolean): string {
  const statusFn = STATUS_COLORS[t.status] || chalk.white;
  const priorityFn = PRIORITY_COLORS[t.priority] || chalk.white;
  const id = chalk.gray((t.id || '').slice(0, 12).padEnd(12));
  const status = statusFn((t.status || '').toUpperCase().padEnd(7));
  const priority = priorityFn((t.priority || '').padEnd(10));
  let line = `  ${id}  ${status}  ${priority}  ${chalk.bold(t.name)}`;
  if (verbose) {
    const branches = (t.branches && t.branches.length ? t.branches : (t.branch ? [t.branch] : []));
    if (t.repoName) line += `\n              ${chalk.gray('Repo:')} ${chalk.cyan(t.repoName)}`;
    if (branches.length) line += `\n              ${chalk.gray('Branches:')} ${branches.map((b) => chalk.cyan(b)).join(', ')}`;
    if (t.labels && t.labels.length) line += `\n              ${chalk.gray('Labels:')} ${t.labels.map((l) => chalk.magenta(l)).join(', ')}`;
    line += `\n              ${chalk.gray('Sessions:')} ${t.sessionCount ?? 0}  ${chalk.gray('Cost:')} $${(t.totalCost ?? 0).toFixed(2)}`;
  }
  return line;
}

/**
 * origin trail [list] — list the org's trails (read-only).
 */
export async function trailListCommand(
  opts?: { status?: string; label?: string; verbose?: boolean },
): Promise<void> {
  if (!requireConnected()) return;
  try {
    const params: Record<string, string> = {};
    if (opts?.status) params.status = opts.status;
    if (opts?.label) params.label = opts.label;
    const res = (await api.getTrails(params)) as { trails: ApiTrail[]; total: number };
    const trails = res?.trails || [];
    if (trails.length === 0) {
      console.log(chalk.gray('No trails yet.'));
      console.log(chalk.gray(`  ${DASHBOARD_HINT}`));
      return;
    }
    console.log(chalk.bold('\n  Trails\n'));
    console.log(chalk.gray(`  ${'ID'.padEnd(12)}  ${'Status'.padEnd(7)}  ${'Priority'.padEnd(10)}  Name`));
    console.log(chalk.gray('  ' + '─'.repeat(70)));
    for (const t of trails) console.log(formatTrail(t, !!opts?.verbose));
    console.log(chalk.gray(`\n  ${trails.length} of ${res.total} trail${res.total === 1 ? '' : 's'}.  ${DASHBOARD_HINT}\n`));
  } catch (err: any) {
    console.error(chalk.red(`Failed to fetch trails: ${err?.message || err}`));
  }
}

/** origin trail (no subcommand) — same read-only list. */
export async function trailCommand(opts?: { verbose?: boolean }): Promise<void> {
  return trailListCommand(opts);
}

/** Trail mutations now live in the dashboard — point the user there. */
function redirectToDashboard(): void {
  console.log(chalk.yellow('Trail creation and editing moved to the Origin dashboard.'));
  console.log(chalk.gray(`  ${DASHBOARD_HINT}`));
  console.log(chalk.gray('  Trails auto-collect sessions by repo + branch — pick a repo and one or'));
  console.log(chalk.gray('  more branches (use "feat/auth*" to match a prefix). View them with `origin trail list`.'));
}

// Signatures kept so the registered subcommands don't error; they now
// redirect to the dashboard (the single source of truth).
export async function trailCreateCommand(_name: string, _opts?: { priority?: string; label?: string }): Promise<void> {
  redirectToDashboard();
}
export async function trailUpdateCommand(_id?: string, _opts?: { status?: string; priority?: string }): Promise<void> {
  redirectToDashboard();
}
export async function trailAssignCommand(_user: string, _trailId?: string): Promise<void> {
  redirectToDashboard();
}
export async function trailLabelCommand(_label: string, _trailId?: string): Promise<void> {
  redirectToDashboard();
}
