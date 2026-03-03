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

const program = new Command();

program
  .name('origin')
  .description('Origin — AI Coding Agent Governance CLI')
  .version('0.1.0');

// Setup
program.command('login').description('Login to Origin').action(loginCommand);
program.command('init').description('Register this machine as an agent host').action(initCommand);
program.command('status').description('Show current status').action(statusCommand);
program.command('whoami').description('Show current user and org info').action(whoamiCommand);

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

program.parse();
