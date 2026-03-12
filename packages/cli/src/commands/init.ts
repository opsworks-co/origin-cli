import os from 'os';
import crypto from 'crypto';
import readline from 'readline';
import chalk from 'chalk';
import { loadConfig, saveAgentConfig } from '../config.js';
import { api } from '../api.js';
import { enableCommand } from './enable.js';
import { detectTools } from '../tools-detector.js';

function prompt(question: string): Promise<string> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => rl.question(question, (answer) => { rl.close(); resolve(answer.trim()); }));
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

  // ── Agent selection ──────────────────────────────────────────────────────
  let agentSlug: string | undefined;
  try {
    const agents: any[] = await api.getMyAgents();
    if (agents.length === 1) {
      agentSlug = agents[0].slug;
      console.log(chalk.green(`\n✓ Default agent: ${agents[0].name} (${agentSlug})`));
    } else if (agents.length > 1) {
      console.log(chalk.bold('\n🤖 Select your default agent:\n'));
      agents.forEach((a, i) => {
        console.log(chalk.gray(`  ${i + 1}) ${a.name} (${a.slug}) — ${a.model}`));
      });
      const answer = await prompt(chalk.white(`\n  Enter number [1-${agents.length}]: `));
      const idx = parseInt(answer, 10) - 1;
      if (idx >= 0 && idx < agents.length) {
        agentSlug = agents[idx].slug;
        console.log(chalk.green(`  ✓ Selected: ${agents[idx].name}`));
      } else {
        console.log(chalk.yellow('  ⚠ Invalid selection — skipping agent assignment'));
      }
    }
  } catch {
    // Agent selection is optional — don't block init
  }

  saveAgentConfig({ machineId, hostname, detectedTools, orgId: config.orgId, agentSlug });
  console.log(chalk.gray('  Agent config saved to ~/.origin/agent.json'));

  // Auto-install global hooks so all repos are tracked
  console.log(chalk.bold('\n📡 Installing global hooks...\n'));
  await enableCommand({ global: true });
}
