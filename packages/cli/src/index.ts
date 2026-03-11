#!/usr/bin/env node
import { Command } from 'commander';
import { loginCommand } from './commands/login.js';
import { initCommand } from './commands/init.js';
import { statusCommand } from './commands/status.js';
import { policiesCommand } from './commands/policies.js';
import { syncCommand } from './commands/sync.js';
import { whoamiCommand } from './commands/whoami.js';
import { sessionsCommand, sessionDetailCommand } from './commands/sessions.js';
import { reviewCommand } from './commands/review.js';
import { agentsCommand, agentCreateCommand } from './commands/agents.js';
import { reposCommand, repoAddCommand } from './commands/repos.js';
import { auditCommand } from './commands/audit.js';
import { statsCommand } from './commands/stats.js';
import { enableCommand } from './commands/enable.js';
import { disableCommand } from './commands/disable.js';
import { linkCommand } from './commands/link.js';
import { hooksCommand, handlePostCommit, handlePrePush } from './commands/hooks.js';
import { explainCommand } from './commands/explain.js';
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
import { checkForUpdate } from './version-check.js';

const program = new Command();

program
  .name('origin')
  .description('Origin — AI Coding Agent Governance CLI')
  .version('0.1.0');

// ─── Setup ────────────────────────────────────────────────────────────────

program.command('login').description('Login to Origin').action(loginCommand);
program.command('init').description('Register this machine as an agent host').action(initCommand);
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
  .description('View dashboard statistics with attribution breakdown')
  .option('--local', 'Compute stats from local git data')
  .option('-r, --range <range>', 'Commit range for local stats (e.g., HEAD~50..HEAD)')
  .action(statsCommand);

// ─── Search & Analysis ───────────────────────────────────────────────────

program.command('search <query>')
  .description('Search across all AI prompt history')
  .option('-m, --model <model>', 'Filter by model')
  .option('-r, --repo <path>', 'Filter by repo path')
  .option('-l, --limit <n>', 'Max results', '20')
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

program.command('share <sessionId>')
  .description('Create a shareable prompt bundle from a session')
  .option('-p, --prompt <index>', 'Share a specific prompt by index')
  .option('-o, --output <path>', 'Write to file instead of clipboard')
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
  .option('-c, --channel <channel>', 'Release channel (stable, beta, canary)', 'stable')
  .option('--check', 'Only check for updates, do not install')
  .action(upgradeCommand);

// ─── Internal Hook Handlers ──────────────────────────────────────────────

const hooks = program.command('hooks').description('Internal hook handlers (used by AI agents)');
hooks.command('claude-code <event>').description('Handle Claude Code hook event').action((event) => hooksCommand(event, 'claude-code'));
hooks.command('cursor <event>').description('Handle Cursor hook event').action((event) => hooksCommand(event, 'cursor'));
hooks.command('gemini <event>').description('Handle Gemini CLI hook event').action((event) => hooksCommand(event, 'gemini'));
hooks.command('windsurf <event>').description('Handle Windsurf hook event').action((event) => hooksCommand(event, 'windsurf'));
hooks.command('aider <event>').description('Handle Aider hook event').action((event) => hooksCommand(event, 'aider'));
hooks.command('git-post-commit').description('Handle git post-commit hook').action(() => handlePostCommit());
hooks.command('git-pre-push').description('Handle git pre-push hook').action(() => handlePrePush());

// ─── Sessions ────────────────────────────────────────────────────────────

const sessions = program.command('sessions').description('List coding sessions');
sessions
  .option('-s, --status <status>', 'Filter by status (unreviewed, approved, rejected, flagged)')
  .option('-m, --model <model>', 'Filter by model')
  .option('-l, --limit <n>', 'Max results', '20')
  .action(sessionsCommand);

program.command('session <id>').description('View session detail').action(sessionDetailCommand);

program.command('review <sessionId>')
  .description('Review a coding session')
  .option('--approve', 'Approve the session')
  .option('--reject', 'Reject the session')
  .option('--flag', 'Flag the session for review')
  .option('-n, --note <note>', 'Review note')
  .action(reviewCommand);

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
  .description('View audit log')
  .option('-a, --action <action>', 'Filter by action type')
  .option('-l, --limit <n>', 'Max results', '30')
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
