import os from 'os';
import crypto from 'crypto';
import { execSync } from 'child_process';
import chalk from 'chalk';
import { loadConfig, saveAgentConfig } from '../config.js';
import { api } from '../api.js';
import { enableCommand } from './enable.js';

function detectTools(): string[] {
  const tools: string[] = [];
  const checks = [
    { name: 'claude', cmd: 'which claude' },
    { name: 'cursor', cmd: 'which cursor' },
    { name: 'aider', cmd: 'which aider' },
    { name: 'gemini', cmd: 'which gemini' },
    { name: 'windsurf', cmd: 'which windsurf' },
  ];
  for (const { name, cmd } of checks) {
    try { execSync(cmd, { stdio: 'ignore' }); tools.push(name); } catch {}
  }
  return tools;
}

export async function initCommand() {
  const config = loadConfig();
  if (!config) {
    console.log(chalk.red('Not logged in. Run: origin login'));
    process.exit(1);
  }

  console.log(chalk.bold('\n🔧 Initializing Origin Agent\n'));

  const hostname = os.hostname();
  const machineId = crypto.randomUUID();
  const detectedTools = detectTools();

  console.log(chalk.gray(`  Hostname: ${hostname}`));
  console.log(chalk.gray(`  Machine ID: ${machineId}`));
  console.log(chalk.gray(`  Detected tools: ${detectedTools.length > 0 ? detectedTools.join(', ') : 'none'}`));

  try {
    await api.registerMachine({ hostname, machineId, detectedTools });
    console.log(chalk.green('\n✓ Machine registered with Origin'));
  } catch (err: any) {
    console.log(chalk.yellow(`\n⚠ Could not register machine: ${err.message}`));
  }

  saveAgentConfig({ machineId, hostname, detectedTools, orgId: config.orgId });
  console.log(chalk.gray('  Agent config saved to ~/.origin/agent.json'));

  // Auto-install global hooks so all repos are tracked
  console.log(chalk.bold('\n📡 Installing global hooks...\n'));
  await enableCommand({ global: true });
}
