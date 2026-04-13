import chalk from 'chalk';
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { getGitRoot } from '../session-state.js';

// ── Types ───────────────────────────────────────────────────────────────────

interface Issue {
  id: string;
  title: string;
  description?: string;
  type: 'bug' | 'feature' | 'task' | 'chore';
  priority: number; // 1 = critical, 2 = high, 3 = medium, 4 = low
  status: 'open' | 'in-progress' | 'blocked' | 'closed';
  labels: string[];
  deps: string[];          // IDs of issues this depends on
  sessions: string[];      // linked session IDs
  createdAt: string;
  updatedAt: string;
  closedAt?: string;
}

// ── Helpers ─────────────────────────────────────────────────────────────────

function issuesDir(repoRoot: string): string {
  return path.join(repoRoot, '.origin', 'issues');
}

function ensureIssuesDir(repoRoot: string): string {
  const dir = issuesDir(repoRoot);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function generateId(): string {
  const hash = crypto.randomBytes(4).toString('hex').slice(0, 4);
  return `ori-${hash}`;
}

function loadIssue(filePath: string): Issue | null {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf-8'));
  } catch {
    return null;
  }
}

function saveIssue(repoRoot: string, issue: Issue): void {
  const dir = ensureIssuesDir(repoRoot);
  const file = path.join(dir, `${issue.id}.json`);
  fs.writeFileSync(file, JSON.stringify(issue, null, 2) + '\n');
}

function getAllIssues(repoRoot: string): Issue[] {
  const dir = issuesDir(repoRoot);
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir)
    .filter(f => f.endsWith('.json'))
    .map(f => loadIssue(path.join(dir, f)))
    .filter((i): i is Issue => i !== null)
    .sort((a, b) => a.priority - b.priority || new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime());
}

function findIssue(repoRoot: string, idOrPrefix: string): Issue | null {
  const issues = getAllIssues(repoRoot);
  return issues.find(i => i.id === idOrPrefix || i.id.startsWith(idOrPrefix)) || null;
}

function getRepoRoot(): string {
  const root = getGitRoot(process.cwd());
  if (!root) {
    console.log(chalk.red('Not inside a git repository.'));
    process.exit(1);
  }
  return root;
}

function priorityLabel(p: number): string {
  switch (p) {
    case 1: return chalk.red('P1 critical');
    case 2: return chalk.yellow('P2 high');
    case 3: return chalk.blue('P3 medium');
    case 4: return chalk.gray('P4 low');
    default: return chalk.gray(`P${p}`);
  }
}

function statusIcon(s: string): string {
  switch (s) {
    case 'open': return chalk.green('○');
    case 'in-progress': return chalk.cyan('◉');
    case 'blocked': return chalk.red('⊘');
    case 'closed': return chalk.gray('✓');
    default: return '?';
  }
}

function timeAgo(dateStr: string): string {
  const ms = Date.now() - new Date(dateStr).getTime();
  const mins = Math.floor(ms / 60000);
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

function isResolved(id: string, issues: Issue[]): boolean {
  const issue = issues.find(i => i.id === id);
  return issue ? issue.status === 'closed' : true; // missing deps treated as resolved
}

// ── Commands ────────────────────────────────────────────────────────────────

/**
 * origin issue create <title>
 */
export async function issueCreateCommand(
  title: string,
  opts?: { type?: string; priority?: string; label?: string[]; dep?: string[]; description?: string; json?: boolean }
): Promise<void> {
  const root = getRepoRoot();
  const now = new Date().toISOString();

  const issue: Issue = {
    id: generateId(),
    title,
    description: opts?.description,
    type: (opts?.type as Issue['type']) || 'task',
    priority: opts?.priority ? parseInt(opts.priority, 10) : 3,
    status: 'open',
    labels: opts?.label || [],
    deps: opts?.dep || [],
    sessions: [],
    createdAt: now,
    updatedAt: now,
  };

  saveIssue(root, issue);

  if (opts?.json) {
    console.log(JSON.stringify(issue, null, 2));
    return;
  }

  console.log(chalk.green(`✓ Created issue ${chalk.bold(issue.id)}: ${title}`));
  console.log(`  ${priorityLabel(issue.priority)}  ${chalk.gray(issue.type)}${issue.labels.length ? '  ' + issue.labels.map(l => chalk.cyan(`#${l}`)).join(' ') : ''}`);
}

/**
 * origin issue list
 */
export async function issueListCommand(
  opts?: { status?: string; priority?: string; label?: string; type?: string; json?: boolean }
): Promise<void> {
  const root = getRepoRoot();
  let issues = getAllIssues(root);

  if (opts?.status) issues = issues.filter(i => i.status === opts.status);
  else issues = issues.filter(i => i.status !== 'closed'); // default: hide closed

  if (opts?.priority) issues = issues.filter(i => i.priority === parseInt(opts.priority!, 10));
  if (opts?.label) issues = issues.filter(i => i.labels.includes(opts.label!));
  if (opts?.type) issues = issues.filter(i => i.type === opts.type);

  if (opts?.json) {
    console.log(JSON.stringify(issues, null, 2));
    return;
  }

  if (issues.length === 0) {
    console.log(chalk.gray('No issues found. Create one with: origin issue create "title"'));
    return;
  }

  console.log(`\n  ${chalk.bold('Issues')} (${issues.length})\n`);

  for (const issue of issues) {
    const icon = statusIcon(issue.status);
    const id = chalk.gray(issue.id);
    const pri = issue.priority <= 2 ? ` ${priorityLabel(issue.priority)}` : '';
    const labels = issue.labels.length ? '  ' + issue.labels.map(l => chalk.cyan(`#${l}`)).join(' ') : '';
    const sessions = issue.sessions.length ? chalk.gray(` · ${issue.sessions.length} session${issue.sessions.length > 1 ? 's' : ''}`) : '';
    const age = chalk.gray(timeAgo(issue.createdAt));

    console.log(`  ${icon} ${id}  ${issue.title}${pri}${labels}${sessions}`);
    console.log(`    ${chalk.gray(issue.type)}  ${age}${issue.deps.length ? chalk.gray(`  deps: ${issue.deps.join(', ')}`) : ''}`);
    console.log('');
  }
}

/**
 * origin issue show <id>
 */
export async function issueShowCommand(id: string, opts?: { json?: boolean }): Promise<void> {
  const root = getRepoRoot();
  const issue = findIssue(root, id);

  if (!issue) {
    console.log(chalk.red(`No issue found matching "${id}".`));
    return;
  }

  if (opts?.json) {
    console.log(JSON.stringify(issue, null, 2));
    return;
  }

  const allIssues = getAllIssues(root);

  console.log(`\n  ${chalk.bold(issue.id)}  ${issue.title}\n`);
  console.log(`  Status:     ${statusIcon(issue.status)} ${issue.status}`);
  console.log(`  Type:       ${issue.type}`);
  console.log(`  Priority:   ${priorityLabel(issue.priority)}`);
  if (issue.description) {
    console.log(`  Desc:       ${issue.description}`);
  }
  if (issue.labels.length) {
    console.log(`  Labels:     ${issue.labels.map(l => chalk.cyan(`#${l}`)).join(' ')}`);
  }
  if (issue.deps.length) {
    console.log(`  Depends on:`);
    for (const depId of issue.deps) {
      const dep = allIssues.find(i => i.id === depId);
      const resolved = dep?.status === 'closed';
      console.log(`    ${resolved ? chalk.green('✓') : chalk.red('○')} ${depId}${dep ? ` — ${dep.title}` : chalk.gray(' (not found)')}`);
    }
  }
  if (issue.sessions.length) {
    console.log(`  Sessions:   ${issue.sessions.map(s => chalk.gray(s.slice(0, 8))).join(', ')}`);
  }
  console.log(`  Created:    ${issue.createdAt} (${timeAgo(issue.createdAt)})`);
  console.log(`  Updated:    ${issue.updatedAt} (${timeAgo(issue.updatedAt)})`);
  if (issue.closedAt) {
    console.log(`  Closed:     ${issue.closedAt} (${timeAgo(issue.closedAt)})`);
  }
  console.log('');
}

/**
 * origin issue update <id>
 */
export async function issueUpdateCommand(
  id: string,
  opts?: { status?: string; priority?: string; title?: string; type?: string; label?: string[]; description?: string; json?: boolean }
): Promise<void> {
  const root = getRepoRoot();
  const issue = findIssue(root, id);

  if (!issue) {
    console.log(chalk.red(`No issue found matching "${id}".`));
    return;
  }

  if (opts?.status) issue.status = opts.status as Issue['status'];
  if (opts?.priority) issue.priority = parseInt(opts.priority, 10);
  if (opts?.title) issue.title = opts.title;
  if (opts?.type) issue.type = opts.type as Issue['type'];
  if (opts?.label) issue.labels = opts.label;
  if (opts?.description) issue.description = opts.description;
  if (issue.status === 'closed' && !issue.closedAt) issue.closedAt = new Date().toISOString();
  issue.updatedAt = new Date().toISOString();

  saveIssue(root, issue);

  if (opts?.json) {
    console.log(JSON.stringify(issue, null, 2));
    return;
  }

  console.log(chalk.green(`✓ Updated ${issue.id}: ${issue.title}`));
}

/**
 * origin issue close <id>
 */
export async function issueCloseCommand(id: string, opts?: { json?: boolean }): Promise<void> {
  const root = getRepoRoot();
  const issue = findIssue(root, id);

  if (!issue) {
    console.log(chalk.red(`No issue found matching "${id}".`));
    return;
  }

  issue.status = 'closed';
  issue.closedAt = new Date().toISOString();
  issue.updatedAt = issue.closedAt;
  saveIssue(root, issue);

  if (opts?.json) {
    console.log(JSON.stringify(issue, null, 2));
    return;
  }

  console.log(chalk.green(`✓ Closed ${issue.id}: ${issue.title}`));
}

/**
 * origin issue ready — show only issues with no unresolved dependencies
 */
export async function issueReadyCommand(opts?: { json?: boolean }): Promise<void> {
  const root = getRepoRoot();
  const allIssues = getAllIssues(root);
  const openIssues = allIssues.filter(i => i.status === 'open' || i.status === 'in-progress');

  const ready = openIssues.filter(issue => {
    if (issue.deps.length === 0) return true;
    return issue.deps.every(depId => isResolved(depId, allIssues));
  });

  // Sort by priority (P1 first)
  ready.sort((a, b) => a.priority - b.priority);

  if (opts?.json) {
    console.log(JSON.stringify(ready, null, 2));
    return;
  }

  if (ready.length === 0) {
    console.log(chalk.gray('No ready issues. All issues are either blocked or closed.'));
    return;
  }

  console.log(`\n  ${chalk.bold.green('Ready to work')} (${ready.length})\n`);

  for (const issue of ready) {
    const icon = statusIcon(issue.status);
    const id = chalk.gray(issue.id);
    const pri = priorityLabel(issue.priority);

    console.log(`  ${icon} ${id}  ${issue.title}  ${pri}`);
    if (issue.labels.length) {
      console.log(`    ${issue.labels.map(l => chalk.cyan(`#${l}`)).join(' ')}`);
    }
    console.log('');
  }
}

/**
 * origin issue blocked — show issues waiting on dependencies
 */
export async function issueBlockedCommand(opts?: { json?: boolean }): Promise<void> {
  const root = getRepoRoot();
  const allIssues = getAllIssues(root);
  const openIssues = allIssues.filter(i => i.status !== 'closed');

  const blocked = openIssues.filter(issue => {
    if (issue.deps.length === 0) return false;
    return issue.deps.some(depId => !isResolved(depId, allIssues));
  });

  if (opts?.json) {
    console.log(JSON.stringify(blocked, null, 2));
    return;
  }

  if (blocked.length === 0) {
    console.log(chalk.green('No blocked issues.'));
    return;
  }

  console.log(`\n  ${chalk.bold.red('Blocked')} (${blocked.length})\n`);

  for (const issue of blocked) {
    const id = chalk.gray(issue.id);
    const unresolvedDeps = issue.deps.filter(d => !isResolved(d, allIssues));

    console.log(`  ${chalk.red('⊘')} ${id}  ${issue.title}`);
    console.log(`    ${chalk.red('blocked by:')} ${unresolvedDeps.join(', ')}`);
    console.log('');
  }
}

/**
 * origin issue dep add <id> <blocks-id>
 */
export async function issueDepAddCommand(id: string, blocksId: string, opts?: { json?: boolean }): Promise<void> {
  const root = getRepoRoot();
  const issue = findIssue(root, id);

  if (!issue) {
    console.log(chalk.red(`No issue found matching "${id}".`));
    return;
  }

  if (!issue.deps.includes(blocksId)) {
    issue.deps.push(blocksId);
    issue.updatedAt = new Date().toISOString();
    saveIssue(root, issue);
  }

  if (opts?.json) {
    console.log(JSON.stringify(issue, null, 2));
    return;
  }

  console.log(chalk.green(`✓ ${issue.id} now depends on ${blocksId}`));
}

/**
 * origin issue dep remove <id> <dep-id>
 */
export async function issueDepRemoveCommand(id: string, depId: string, opts?: { json?: boolean }): Promise<void> {
  const root = getRepoRoot();
  const issue = findIssue(root, id);

  if (!issue) {
    console.log(chalk.red(`No issue found matching "${id}".`));
    return;
  }

  issue.deps = issue.deps.filter(d => d !== depId);
  issue.updatedAt = new Date().toISOString();
  saveIssue(root, issue);

  if (opts?.json) {
    console.log(JSON.stringify(issue, null, 2));
    return;
  }

  console.log(chalk.green(`✓ Removed dependency ${depId} from ${issue.id}`));
}

/**
 * origin issue dep tree <id>
 */
export async function issueDepTreeCommand(id: string, opts?: { json?: boolean }): Promise<void> {
  const root = getRepoRoot();
  const allIssues = getAllIssues(root);
  const issue = allIssues.find(i => i.id === id || i.id.startsWith(id));

  if (!issue) {
    console.log(chalk.red(`No issue found matching "${id}".`));
    return;
  }

  // Build dependency tree
  interface TreeNode { issue: Issue; children: TreeNode[] }

  function buildTree(issueId: string, visited: Set<string> = new Set()): TreeNode | null {
    if (visited.has(issueId)) return null; // prevent cycles
    visited.add(issueId);
    const iss = allIssues.find(i => i.id === issueId);
    if (!iss) return null;
    const children = iss.deps
      .map(d => buildTree(d, visited))
      .filter((n): n is TreeNode => n !== null);
    return { issue: iss, children };
  }

  const tree = buildTree(issue.id);

  if (opts?.json) {
    console.log(JSON.stringify(tree, null, 2));
    return;
  }

  function printTree(node: TreeNode, prefix: string = '', isLast: boolean = true): void {
    const connector = prefix === '' ? '' : isLast ? '└── ' : '├── ';
    const resolved = node.issue.status === 'closed';
    const icon = resolved ? chalk.green('✓') : chalk.yellow('○');
    console.log(`${prefix}${connector}${icon} ${chalk.gray(node.issue.id)} ${node.issue.title} ${chalk.gray(`[${node.issue.status}]`)}`);
    const childPrefix = prefix + (prefix === '' ? '' : isLast ? '    ' : '│   ');
    node.children.forEach((child, i) => {
      printTree(child, childPrefix, i === node.children.length - 1);
    });
  }

  console.log(`\n  Dependency tree for ${chalk.bold(issue.id)}\n`);
  if (tree) printTree(tree);
  console.log('');
}

/**
 * origin issue link <id> <session-id>
 */
export async function issueLinkCommand(id: string, sessionId: string, opts?: { json?: boolean }): Promise<void> {
  const root = getRepoRoot();
  const issue = findIssue(root, id);

  if (!issue) {
    console.log(chalk.red(`No issue found matching "${id}".`));
    return;
  }

  if (!issue.sessions.includes(sessionId)) {
    issue.sessions.push(sessionId);
    issue.updatedAt = new Date().toISOString();
    saveIssue(root, issue);
  }

  if (opts?.json) {
    console.log(JSON.stringify(issue, null, 2));
    return;
  }

  console.log(chalk.green(`✓ Linked session ${sessionId.slice(0, 8)} to ${issue.id}`));
}
