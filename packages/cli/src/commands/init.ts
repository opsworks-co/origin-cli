import os from 'os';
import crypto from 'crypto';
import readline from 'readline';
import chalk from 'chalk';
import { loadConfig, loadAgentConfig, saveAgentConfig, isConnectedMode } from '../config.js';
import { api } from '../api.js';
import { enableCommand } from './enable.js';
import { detectTools } from '../tools-detector.js';

function prompt(question: string): Promise<string> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => rl.question(question, (answer) => { rl.close(); resolve(answer.trim()); }));
}

export async function initCommand(opts: { standalone?: boolean } = {}) {
  const config = loadConfig();
  let connected = isConnectedMode();

  // --standalone flag forces standalone mode even when logged in
  if (opts.standalone && connected) {
    const { saveConfig } = await import('../config.js');
    if (config) {
      config.mode = 'standalone';
      saveConfig(config);
    }
    connected = false;
    console.log(chalk.green('\n✓ Switched to standalone mode'));
    console.log(chalk.gray('  API credentials kept — run `origin config set mode auto` to reconnect.\n'));
  }

  console.log(chalk.bold('\n🔧 Initializing Origin Agent\n'));

  if (!connected) {
    console.log(chalk.gray('  Mode: standalone (no Origin platform)'));
    console.log(chalk.gray('  Run `origin login` to connect to the Origin platform.\n'));
  }

  const hostname = os.hostname();
  const existingAgent = loadAgentConfig();
  const machineId = existingAgent?.machineId ?? crypto.randomUUID();
  const detectedTools = detectTools();

  console.log(chalk.gray(`  Hostname: ${hostname}`));
  console.log(chalk.gray(`  Machine ID: ${machineId}`));
  console.log(chalk.gray(`  Detected tools: ${detectedTools.length > 0 ? detectedTools.join(', ') : 'none'}`));

  // Register machine with Origin platform (connected mode only)
  if (connected) {
    try {
      await api.registerMachine({ hostname, machineId, detectedTools });
      console.log(chalk.green('\n✓ Machine registered with Origin'));
    } catch (err: any) {
      // Non-fatal — init continues in standalone-like mode
      console.log(chalk.gray(`\n  Machine registration skipped (${err.message})`));
      console.log(chalk.gray('  Sessions will still be tracked locally.'));
    }
  }

  // ── Agent selection (connected mode only) ──────────────────────────────
  let agentSlug: string | undefined;
  if (connected) {
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
  }

  saveAgentConfig({ machineId, hostname, detectedTools, orgId: config?.orgId || 'local', agentSlug });
  console.log(chalk.gray('  Agent config saved to ~/.origin/agent.json'));

  // Auto-install global hooks so all repos are tracked
  console.log(chalk.bold('\n📡 Installing global hooks...\n'));
  await enableCommand({ global: true });

  if (!connected) {
    console.log(chalk.green('\n✓ Standalone mode ready — sessions will be tracked locally in git.'));
  }
}
