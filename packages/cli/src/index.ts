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
import { hooksCommand, handlePostCommit } from './commands/hooks.js';

const program = new Command();

program
  .name('origin')
  .description('Origin — AI Coding Agent Governance CLI')
  .version('0.1.0');

// Setup
program.command('login').description('Login to Origin').action(loginCommand);
program.command('init').description('Register this machine as an agent host').action(initCommand);
program.command('enable')
  .description('Install Origin hooks for session tracking in this repo')
  .option('-a, --agent <agent>', 'Agent to enable (claude-code, cursor, gemini). Auto-detects if omitted.')
  .action(enableCommand);
program.command('disable').description('Remove Origin hooks from this repo').action(disableCommand);
program.command('status').description('Show current status').action(statusCommand);
program.command('whoami').description('Show current user and org info').action(whoamiCommand);

// Internal hook handlers (called by agent hooks, not by users directly)
const hooks = program.command('hooks').description('Internal hook handlers (used by AI agents)');
hooks.command('claude-code <event>').description('Handle Claude Code hook event').action((event) => hooksCommand(event, 'claude-code'));
hooks.command('cursor <event>').description('Handle Cursor hook event').action((event) => hooksCommand(event, 'cursor'));
hooks.command('gemini <event>').description('Handle Gemini CLI hook event').action((event) => hooksCommand(event, 'gemini'));
hooks.command('git-post-commit').description('Handle git post-commit hook').action(() => handlePostCommit());

// Sessions
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

// Repos
const repos = program.command('repos').description('List repositories');
repos.action(reposCommand);

program.command('repo:add')
  .description('Add a repository')
  .requiredOption('--name <name>', 'Repository name')
  .requiredOption('--path <path>', 'Repository path')
  .option('--provider <provider>', 'Provider (local, github)', 'local')
  .action(repoAddCommand);

program.command('sync').description('Sync session data from current repo').action(syncCommand);

// Agents
const agents = program.command('agents').description('List agents');
agents.action(agentsCommand);

program.command('agent:create')
  .description('Create a new agent')
  .requiredOption('--name <name>', 'Agent name')
  .requiredOption('--slug <slug>', 'Agent slug')
  .requiredOption('--model <model>', 'AI model')
  .option('--description <desc>', 'Description')
  .action(agentCreateCommand);

// Policies
program.command('policies').description('List active policies').action(policiesCommand);

// Audit & Stats
program.command('audit')
  .description('View audit log')
  .option('-a, --action <action>', 'Filter by action type')
  .option('-l, --limit <n>', 'Max results', '30')
  .action(auditCommand);

program.command('stats').description('View dashboard statistics').action(statsCommand);

// Versioning
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

// Notifications
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

// Team / Users
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

program.parse();
