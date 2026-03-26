#!/usr/bin/env node
import { Command } from 'commander';
import { loginCommand } from './commands/login.js';
import { initCommand } from './commands/init.js';
import { statusCommand } from './commands/status.js';
import { policiesCommand } from './commands/policies.js';
import { syncCommand } from './commands/sync.js';
import { whoamiCommand } from './commands/whoami.js';
import { sessionsCommand, sessionDetailCommand, sessionEndCommand } from './commands/sessions.js';
import { reviewCommand } from './commands/review.js';
import { reviewPRCommand } from './commands/review-pr.js';
import { intentReviewCommand } from './commands/intent-review.js';
import { agentsCommand, agentCreateCommand } from './commands/agents.js';
import { reposCommand, repoAddCommand } from './commands/repos.js';
import { auditCommand } from './commands/audit.js';
import { statsCommand } from './commands/stats.js';
import { enableCommand } from './commands/enable.js';
import { disableCommand } from './commands/disable.js';
import { linkCommand } from './commands/link.js';
import { hooksCommand, handlePostCommit, handlePrePush, handlePreCommit } from './commands/hooks.js';
import { explainCommand } from './commands/explain.js';
import { askCommand } from './commands/ask.js';
import { promptsCommand } from './commands/prompts.js';
import { chatCommand } from './commands/chat.js';
import { webCommand } from './commands/web.js';
import { doctorCommand } from './commands/doctor.js';
import { resetCommand } from './commands/reset.js';
import { cleanCommand } from './commands/clean.js';
import { configGetCommand, configSetCommand, configListCommand } from './commands/config-cmd.js';
import { resumeCommand } from './commands/resume.js';
import { shareCommand } from './commands/share.js';
import { blameCommand } from './commands/blame.js';
import { diffCommand } from './commands/diff.js';
import { searchCommand } from './commands/search.js';
import { rewindCommand } from './commands/rewind.js';
import { trailCommand, trailListCommand, trailCreateCommand, trailUpdateCommand, trailAssignCommand, trailLabelCommand } from './commands/trail.js';
import { ciCheckCommand, ciSquashMergeCommand, ciGenerateWorkflowCommand } from './commands/ci.js';
import { pluginListCommand, pluginInstallCommand, pluginRemoveCommand } from './commands/plugin.js';
import { upgradeCommand } from './commands/upgrade.js';
import { analyzeCommand } from './commands/analyze.js';
import { dbImportCommand, dbStatsCommand } from './commands/db.js';
import { proxyInstallCommand, proxyUninstallCommand, proxyStatusCommand } from './commands/proxy.js';
import { verifyCommand } from './commands/verify.js';
import { ignoreListCommand, ignoreAddCommand, ignoreRemoveCommand, ignoreTestCommand } from './commands/ignore.js';
import { exportCommand } from './commands/export.js';
import { compareCommand } from './commands/compare.js';
import { reworkCommand } from './commands/rework.js';
import { reportCommand } from './commands/report.js';
import { backfillCommand } from './commands/backfill.js';
import { snapshotSaveCommand, snapshotListCommand, snapshotRestoreCommand, snapshotCleanCommand } from './commands/snapshot.js';
import { checkForUpdate } from './version-check.js';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const pkg = JSON.parse(readFileSync(join(__dirname, '..', 'package.json'), 'utf-8'));

const program = new Command();

program
  .name('origin')
  .description('Origin — AI Coding Agent Governance CLI')
  .version(pkg.version);

// ─── Setup ────────────────────────────────────────────────────────────────

program.command('login').description('Login to Origin').action(loginCommand);
program.command('init')
  .description('Register this machine as an agent host')
  .option('--standalone', 'Force standalone mode (skip API, even when logged in)')
  .action(initCommand);
program.command('enable')
  .description('Install Origin hooks for session tracking')
  .option('-a, --agent <agent>', 'Agent to enable (claude-code, cursor, gemini, windsurf, aider). Auto-detects if omitted.')
  .option('-g, --global', 'Install hooks globally (~/) so ALL repos are tracked automatically')
  .option('-l, --link <slug>', 'Link this repo to an Origin agent by slug (writes .origin.json)')
  .option('--no-chain', 'Replace existing hooks instead of chaining')
  .action(enableCommand);
program.command('disable')
  .description('Remove Origin hooks')
  .option('-g, --global', 'Remove global hooks from ~/  ')
  .action(disableCommand);
program.command('link [slug]')
  .description('Link this repo to an Origin agent (set .origin.json)')
  .option('--clear', 'Remove agent mapping')
  .option('--list', 'Show current link')
  .option('--unlink', 'Remove link')
  .action(linkCommand);
program.command('status').description('Show current status (active session, branch, repo info)').action(statusCommand);
program.command('whoami').description('Show current user and org info').action(whoamiCommand);

// ─── Session Management ──────────────────────────────────────────────────

program.command('explain [sessionId]')
  .description('Explain a coding session (prompts, files, cost, review)')
  .option('-c, --commit <sha>', 'Look up session by commit SHA (via git notes)')
  .option('-s, --short', 'Short output (skip prompt-change mapping)')
  .option('--summarize', 'Generate AI-powered summary (intent, outcome, learnings, friction)')
  .option('--json', 'Output as JSON')
  .action(explainCommand);
program.command('ask <query>')
  .description('Ask about AI-generated code — find the session and prompts behind any file or change')
  .option('-f, --file <path>', 'Ask about a specific file')
  .option('-l, --line <n>', 'Focus on a specific line number')
  .option('-s, --session <id>', 'Search within a specific session')
  .option('--limit <n>', 'Max results', '5')
  .action(askCommand);

program.command('prompts <file>')
  .description('Show AI prompts that led to changes in a file — like git log but for AI prompts')
  .option('-e, --expand', 'Show the actual code diff for each prompt')
  .option('--limit <n>', 'Max entries to show', '10')
  .action(promptsCommand);

program.command('chat')
  .description('Interactive AI assistant — ask questions about your AI-authored code in natural language')
  .option('-q, --question <text>', 'Ask a single question (non-interactive)')
  .action(chatCommand);

program.command('web')
  .description('Launch local web dashboard — AI attribution, sessions, and prompts in the browser')
  .option('-p, --port <n>', 'Port number', '3141')
  .action(webCommand);

program.command('doctor')
  .description('Scan for and fix stuck/orphaned sessions')
  .option('-f, --fix', 'Auto-fix issues found')
  .option('-v, --verbose', 'Show detailed diagnostic info')
  .action(doctorCommand);
program.command('reset')
  .description('Clear local session state for this repo')
  .option('-f, --force', 'Force clear even if session looks active')
  .action(resetCommand);
program.command('clean')
  .description('Remove orphaned branches, stale sessions, temp files')
  .option('--dry-run', 'Show what would be cleaned without deleting')
  .option('-f, --force', 'Skip confirmation')
  .action(cleanCommand);

// ─── Attribution & Blame ─────────────────────────────────────────────────

program.command('blame <file>')
  .description('Show AI vs human attribution per line (like git blame)')
  .option('-l, --line <range>', 'Show specific line range (e.g., 10-20)')
  .option('--json', 'Output as JSON')
  .action(blameCommand);

program.command('diff [range]')
  .description('Show diff with AI/human attribution annotations')
  .option('--ai-only', 'Only show AI-authored changes')
  .option('--human-only', 'Only show human-authored changes')
  .option('--json', 'Output as JSON')
  .action(diffCommand);

program.command('stats')
  .description('View attribution statistics for the current repo')
  .option('--local', 'Compute stats from local git data (default when in a repo)')
  .option('--dashboard', 'Show org-wide dashboard stats from Origin API')
  .option('-g, --global', 'Show stats across all repos (default: current repo only)')
  .option('-r, --range <range>', 'Commit range (e.g., HEAD~50..HEAD)')
  .action(statsCommand);

program.command('report')
  .description('Generate a markdown sprint report summarizing AI activity')
  .option('-r, --range <range>', 'Date range: 7d, 14d, or 30d', '7d')
  .option('-o, --output <file>', 'Write report to file instead of stdout')
  .option('-f, --format <format>', 'Output format: md, json, or csv', 'md')
  .action(reportCommand);

program.command('verify')
  .description('Health check — show agent config, repo config, mode, sessions, attribution')
  .option('--json', 'Output as JSON')
  .action(verifyCommand);

program.command('rework')
  .description('Detect AI-generated code that was reverted or heavily modified (rework hotspots)')
  .option('-d, --days <n>', 'Number of days to look back', '7')
  .option('-l, --limit <n>', 'Max results to show', '20')
  .action(reworkCommand);

program.command('compare <arg1> [arg2]')
  .description('Compare AI attribution between branches or commit ranges')
  .option('--json', 'Output as JSON')
  .action(compareCommand);

program.command('export')
  .description('Export session data as CSV, JSON, or Agent Trace v0.1.0')
  .option('-f, --format <format>', 'Output format (json, csv, agent-trace)', 'json')
  .option('-o, --output <file>', 'Write to file instead of stdout')
  .option('-l, --limit <n>', 'Limit number of sessions')
  .option('-m, --model <name>', 'Filter by model')
  .option('-s, --session <id>', 'Export only a specific session (agent-trace format)')
  .action(exportCommand);

const ignoreCmd = program.command('ignore').description('Manage file ignore patterns for Origin tracking');
ignoreCmd.action(ignoreListCommand);
ignoreCmd.command('add <pattern>').description('Add an ignore pattern to .origin.json').action(ignoreAddCommand);
ignoreCmd.command('remove <pattern>').description('Remove an ignore pattern').action(ignoreRemoveCommand);
ignoreCmd.command('test <filepath>').description('Test if a file would be ignored').action(ignoreTestCommand);

// ─── Backfill ─────────────────────────────────────────────────────────────

program.command('backfill')
  .description('Retroactively tag old commits with AI attribution by matching against agent history and heuristics')
  .option('-d, --days <n>', 'How far back to scan', '90')
  .option('--dry-run', 'Show results without tagging (default behavior)')
  .option('--apply', 'Actually write git notes')
  .option('--min-confidence <level>', 'Only tag commits above this confidence: high, medium, low', 'medium')
  .action(backfillCommand);

// ─── Search & Analysis ───────────────────────────────────────────────────

program.command('search <query>')
  .description('Full-text search across all AI prompt history')
  .option('-l, --limit <n>', 'Max results', '20')
  .option('--from <date>', 'Filter by date (e.g., 7d, 2w, 1m, or 2025-01-01)')
  .option('--agent <name>', 'Filter by agent (claude, cursor, gemini, codex, windsurf, aider)')
  .option('-m, --model <model>', 'Filter by model')
  .option('-r, --repo <path>', 'Filter by repo path')
  .action(searchCommand);

program.command('analyze')
  .description('Analyze AI prompting patterns and metrics')
  .option('-d, --days <n>', 'Number of days to analyze', '30')
  .option('-m, --model <model>', 'Filter by model')
  .option('-e, --export <path>', 'Export results to file')
  .option('--json', 'Output as JSON')
  .action(analyzeCommand);

// ─── Session Browsing ────────────────────────────────────────────────────

program.command('resume [branch]')
  .description('Resume an AI session from a previous branch')
  .option('--launch', 'Auto-launch the AI agent with context')
  .option('--json', 'Output context as JSON')
  .action(resumeCommand);

program.command('rewind')
  .description('Rewind to a previous AI checkpoint (time travel)')
  .option('-i, --interactive', 'Interactive checkpoint browser')
  .option('-t, --to <sha>', 'Rewind to specific commit SHA')
  .option('--list', 'List checkpoints without rewinding')
  .action(rewindCommand);

// ─── Snapshots ────────────────────────────────────────────────────────────

const snapshot = program.command('snapshot').description('Mid-session shadow snapshots (no commits)');
snapshot.action(snapshotSaveCommand);
snapshot.command('list')
  .description('List all snapshots for current session')
  .action(snapshotListCommand);
snapshot.command('restore <id>')
  .description('Restore working tree to a snapshot')
  .action(snapshotRestoreCommand);
snapshot.command('clean')
  .description('Remove all shadow snapshots')
  .action(snapshotCleanCommand);

program.command('share <sessionId>')
  .description('Create a shareable prompt bundle from a session')
  .option('-p, --prompt <index>', 'Share a specific prompt by index')
  .option('-o, --output <path>', 'Write to file instead of clipboard')
  .option('--public', 'Create a public share URL (requires platform connection)')
  .action(shareCommand);

// ─── Trail System ────────────────────────────────────────────────────────

const trail = program.command('trail').description('Branch-centric work tracking');
trail.action(trailCommand);
trail.command('list')
  .description('List all trails')
  .option('-s, --status <status>', 'Filter by status (active, review, done, paused)')
  .action(trailListCommand);
trail.command('create <name>')
  .description('Create a trail for the current branch')
  .option('-p, --priority <priority>', 'Priority (low, medium, high, critical)', 'medium')
  .option('-l, --label <labels...>', 'Labels to add')
  .action(trailCreateCommand);
trail.command('update')
  .description('Update the current trail')
  .option('-s, --status <status>', 'New status (active, review, done, paused)')
  .option('-p, --priority <priority>', 'New priority')
  .option('-t, --title <title>', 'New title')
  .action(trailUpdateCommand);
trail.command('assign <user>')
  .description('Assign a reviewer to the current trail')
  .action(trailAssignCommand);
trail.command('label <labels...>')
  .description('Add labels to the current trail')
  .action(trailLabelCommand);

// ─── Config ──────────────────────────────────────────────────────────────

const config = program.command('config').description('Manage Origin configuration');
config.command('get <key>')
  .description('Get a config value')
  .action(configGetCommand);
config.command('set <key> <value>')
  .description('Set a config value')
  .action(configSetCommand);
config.command('list')
  .description('List all config values')
  .action(configListCommand);

// ─── Database ────────────────────────────────────────────────────────────

const db = program.command('db').description('Local prompt database management');
db.command('import')
  .description('Import prompts from origin-sessions branch into local DB')
  .option('-f, --format <format>', 'Import format (default: origin-sessions, or agent-trace)')
  .option('--file <path>', 'Input file (for agent-trace format; otherwise reads stdin)')
  .action(dbImportCommand);
db.command('stats')
  .description('Show local database statistics')
  .action(dbStatsCommand);

// ─── CI/CD Integration ──────────────────────────────────────────────────

const ci = program.command('ci').description('CI/CD integration for AI attribution');
ci.command('check')
  .description('Report AI attribution stats (run in CI)')
  .option('-r, --range <range>', 'Commit range to check')
  .action(ciCheckCommand);
ci.command('squash-merge <baseBranch>')
  .description('Preserve attribution through squash merge')
  .action(ciSquashMergeCommand);
ci.command('generate-workflow')
  .description('Generate GitHub Actions workflow snippet')
  .action(ciGenerateWorkflowCommand);

// ─── Plugin System ───────────────────────────────────────────────────────

const plugin = program.command('plugin').description('External agent plugin management');
plugin.command('list')
  .description('List installed plugins')
  .action(pluginListCommand);
plugin.command('install <name> <command>')
  .description('Install an external agent plugin')
  .action(pluginInstallCommand);
plugin.command('remove <name>')
  .description('Remove an installed plugin')
  .action(pluginRemoveCommand);

// ─── Git Proxy ───────────────────────────────────────────────────────────

const proxy = program.command('proxy').description('Transparent git proxy for attribution tracking');
proxy.command('install')
  .description('Install git proxy wrapper (adds ~/.origin/bin to PATH)')
  .action(proxyInstallCommand);
proxy.command('uninstall')
  .description('Remove git proxy wrapper')
  .action(proxyUninstallCommand);
proxy.command('status')
  .description('Show proxy installation status')
  .action(proxyStatusCommand);

// ─── Upgrade ─────────────────────────────────────────────────────────────

program.command('upgrade')
  .description('Upgrade Origin CLI to latest version')
  .option('--check', 'Only check for updates, do not install')
  .action(upgradeCommand);

// ─── Internal Hook Handlers ──────────────────────────────────────────────

const hooks = program.command('hooks').description('Internal hook handlers (used by AI agents)');
hooks.command('claude-code <event>').description('Handle Claude Code hook event').action((event) => hooksCommand(event, 'claude-code'));
hooks.command('cursor <event>').description('Handle Cursor hook event').action((event) => hooksCommand(event, 'cursor'));
hooks.command('gemini <event>').description('Handle Gemini CLI hook event').action((event) => hooksCommand(event, 'gemini'));
hooks.command('codex <event>').description('Handle Codex CLI hook event').action((event) => hooksCommand(event, 'codex'));
hooks.command('windsurf <event>').description('Handle Windsurf hook event').action((event) => hooksCommand(event, 'windsurf'));
hooks.command('aider <event>').description('Handle Aider hook event').action((event) => hooksCommand(event, 'aider'));
hooks.command('git-pre-commit').description('Handle git pre-commit hook (secret scan)').action(() => handlePreCommit());
hooks.command('git-post-commit').description('Handle git post-commit hook').action(() => handlePostCommit());
hooks.command('git-pre-push').description('Handle git pre-push hook').action(() => handlePrePush());
hooks.command('git-post-rewrite').description('Handle git post-rewrite hook (rebase/amend)').action(async () => {
  const { preserveAttributionBatch, parseRewriteInput, handleCherryPick } = await import('./history-preservation.js');
  const { getGitRoot } = await import('./session-state.js');
  const repoPath = getGitRoot(process.cwd());
  if (!repoPath) return;
  // Read old-sha new-sha pairs from stdin
  let input = '';
  try {
    input = require('fs').readFileSync(0, 'utf-8');
  } catch { /* no stdin */ }
  if (input) {
    const mappings = parseRewriteInput(input);
    preserveAttributionBatch(repoPath, mappings);
  }
  // Also check for cherry-pick context
  handleCherryPick(repoPath);
});
hooks.command('git-post-checkout').description('Handle git post-checkout hook').action(async () => {
  const { handlePostCheckout } = await import('./history-preservation.js');
  const { getGitRoot } = await import('./session-state.js');
  const repoPath = getGitRoot(process.cwd());
  if (!repoPath) return;
  const args = process.argv.slice(process.argv.indexOf('git-post-checkout') + 1);
  const prevHead = args[0] || '';
  const newHead = args[1] || '';
  handlePostCheckout(repoPath, prevHead, newHead);
});

// ─── Sessions ────────────────────────────────────────────────────────────

const sessions = program.command('sessions').description('List coding sessions');
sessions
  .option('-s, --status <status>', 'Filter by status (unreviewed, approved, rejected, flagged)')
  .option('-m, --model <model>', 'Filter by model')
  .option('-l, --limit <n>', 'Max results', '20')
  .option('-a, --all', 'Show sessions from all repos (default: current repo only)')
  .option('-g, --global', 'Alias for --all')
  .action(sessionsCommand);

program.command('session <id>').description('View session detail').action(sessionDetailCommand);

sessions.command('end <sessionId>').description('End a running session').action(sessionEndCommand);

program.command('review <sessionId>')
  .description('Review a coding session')
  .option('--approve', 'Approve the session')
  .option('--reject', 'Reject the session')
  .option('--flag', 'Flag the session for review')
  .option('-n, --note <note>', 'Review note')
  .action(reviewCommand);

program.command('review-pr <url>')
  .description('Analyze AI sessions behind a GitHub PR')
  .action(reviewPRCommand);

program.command('intent-review [branch]')
  .description('Intent-based review — shows WHY code was written (prompts, reasoning, risk) not just WHAT changed')
  .option('-f, --format <format>', 'Output format: json, md (default: terminal)')
  .option('-o, --output <file>', 'Write output to file')
  .action(intentReviewCommand);

// ─── Repos ───────────────────────────────────────────────────────────────

const repos = program.command('repos').description('List repositories');
repos.action(reposCommand);

program.command('repo:add')
  .description('Add a repository')
  .requiredOption('--name <name>', 'Repository name')
  .requiredOption('--path <path>', 'Repository path')
  .option('--provider <provider>', 'Provider (local, github)', 'local')
  .action(repoAddCommand);

program.command('sync').description('Sync session data from current repo').action(syncCommand);

// ─── Agents ──────────────────────────────────────────────────────────────

const agents = program.command('agents').description('List agents');
agents.action(agentsCommand);

program.command('agent:create')
  .description('Create a new agent')
  .requiredOption('--name <name>', 'Agent name')
  .requiredOption('--slug <slug>', 'Agent slug')
  .requiredOption('--model <model>', 'AI model')
  .option('--description <desc>', 'Description')
  .action(agentCreateCommand);

// ─── Policies ────────────────────────────────────────────────────────────

program.command('policies').description('List active policies').action(policiesCommand);

// ─── Audit ───────────────────────────────────────────────────────────────

program.command('audit')
  .description('Generate compliance audit trail (SOC 2, ISO 27001, GDPR)')
  .option('--from <date>', 'Start date (YYYY-MM-DD, default: 30 days ago)')
  .option('--to <date>', 'End date (YYYY-MM-DD, default: today)')
  .option('--author <name>', 'Filter by author name')
  .option('--agent <name>', 'Filter by agent name')
  .option('-f, --format <format>', 'Output format: md, json, csv', 'md')
  .option('-o, --output <file>', 'Write to file instead of stdout')
  .action(auditCommand);

// ─── Versioning ──────────────────────────────────────────────────────────

program.command('policy:versions <id>')
  .description('View version history for a policy')
  .action(async (id: string) => {
    const chalk = (await import('chalk')).default;
    const { api } = await import('./api.js');
    try {
      const data = await api.getPolicyVersions(id);
      if (!data.versions?.length) {
        console.log(chalk.gray('No version history.'));
        return;
      }
      for (const v of data.versions) {
        console.log(`${chalk.bold(`v${v.version}`)} ${chalk.gray(v.changeType)} — ${chalk.gray(new Date(v.createdAt).toLocaleString())}`);
      }
    } catch (e: any) { console.error(chalk.red(e.message)); }
  });

program.command('agent:versions <id>')
  .description('View version history for an agent')
  .action(async (id: string) => {
    const chalk = (await import('chalk')).default;
    const { api } = await import('./api.js');
    try {
      const data = await api.getAgentVersions(id);
      if (!data.versions?.length) {
        console.log(chalk.gray('No version history.'));
        return;
      }
      for (const v of data.versions) {
        console.log(`${chalk.bold(`v${v.version}`)} ${chalk.gray(v.changeType)} — ${chalk.gray(new Date(v.createdAt).toLocaleString())}`);
      }
    } catch (e: any) { console.error(chalk.red(e.message)); }
  });

// ─── Notifications ───────────────────────────────────────────────────────

program.command('notifications')
  .description('View notifications')
  .option('--unread', 'Show unread only')
  .option('-l, --limit <n>', 'Max results', '20')
  .action(async (opts: any) => {
    const chalk = (await import('chalk')).default;
    const { api } = await import('./api.js');
    try {
      const params: Record<string, string> = { limit: opts.limit };
      if (opts.unread) params.unread = 'true';
      const data = await api.getNotifications(params);
      if (!data.notifications?.length) {
        console.log(chalk.gray('No notifications.'));
        return;
      }
      for (const n of data.notifications) {
        const unread = n.read ? ' ' : chalk.blue('●');
        console.log(`${unread} ${chalk.bold(n.title)} — ${n.message} ${chalk.gray(new Date(n.createdAt).toLocaleString())}`);
      }
      console.log(chalk.gray(`\n${data.total} total`));
    } catch (e: any) { console.error(chalk.red(e.message)); }
  });

// ─── Team / Users ────────────────────────────────────────────────────────

program.command('team')
  .description('List team members')
  .action(async () => {
    const chalk = (await import('chalk')).default;
    const { api } = await import('./api.js');
    try {
      const data = await api.getUsers();
      if (!data.users?.length) {
        console.log(chalk.gray('No team members.'));
        return;
      }
      for (const u of data.users) {
        const role = u.role === 'OWNER' ? chalk.magenta(u.role) : u.role === 'ADMIN' ? chalk.yellow(u.role) : chalk.blue(u.role);
        console.log(`  ${chalk.bold(u.name)} ${chalk.gray(`<${u.email}>`)} ${role} — ${u.sessions} sessions, ${u.reviews} reviews, $${u.totalCost.toFixed(2)}`);
      }
    } catch (e: any) { console.error(chalk.red(e.message)); }
  });

program.command('user <id>')
  .description('View user detail')
  .action(async (id: string) => {
    const chalk = (await import('chalk')).default;
    const { api } = await import('./api.js');
    try {
      const data = await api.getUser(id);
      const u = data.user;
      console.log(`\n  ${chalk.bold(u.name)} ${chalk.gray(`<${u.email}>`)}`);
      console.log(`  Role: ${u.role}  Member since: ${new Date(u.createdAt).toLocaleDateString()}`);
      console.log(`\n  Sessions: ${u.stats.sessions}  Reviews: ${u.stats.reviews}  Cost: $${u.stats.totalCost.toFixed(2)}  Lines: +${u.stats.linesAdded}`);
      if (data.sessions?.length) {
        console.log(chalk.gray('\n  Recent Sessions:'));
        for (const s of data.sessions.slice(0, 5)) {
          const status = s.review?.status || 'pending';
          console.log(`    ${chalk.blue(s.model)} ${s.repoName || '—'} $${s.costUsd.toFixed(2)} ${chalk.gray(status)} ${chalk.gray(new Date(s.createdAt).toLocaleString())}`);
        }
      }
    } catch (e: any) { console.error(chalk.red(e.message)); }
  });

// ─── Version Check (post-action) ────────────────────────────────────────

program.hook('postAction', async () => {
  try {
    const result = await checkForUpdate();
    if (result?.updateAvailable) {
      const chalk = (await import('chalk')).default;
      console.log(chalk.yellow(`\n  Update available: ${result.current} → ${result.latest}`));
      console.log(chalk.gray(`  Run: origin upgrade\n`));
    }
  } catch { /* never fail */ }
});

program.parse();
