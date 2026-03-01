#!/usr/bin/env node
import { Command } from 'commander';
import { loginCommand } from './commands/login.js';
import { initCommand } from './commands/init.js';
import { statusCommand } from './commands/status.js';
import { policiesCommand } from './commands/policies.js';
import { syncCommand } from './commands/sync.js';
import { whoamiCommand } from './commands/whoami.js';

const program = new Command();

program
  .name('origin')
  .description('Origin — AI Coding Agent Governance CLI')
  .version('0.1.0');

program.command('login').description('Login to Origin').action(loginCommand);
program.command('init').description('Register this machine as an agent host').action(initCommand);
program.command('status').description('Show current status').action(statusCommand);
program.command('policies').description('List active policies').action(policiesCommand);
program.command('sync').description('Sync session data from current repo').action(syncCommand);
program.command('whoami').description('Show current user and org info').action(whoamiCommand);

program.parse();
