import os from 'os';
import crypto from 'crypto';
import { execSync } from 'child_process';
import chalk from 'chalk';
import { loadConfig, saveAgentConfig } from '../config.js';
import { api } from '../api.js';

function detectTools(): string[] {
  const tools: string[] = [];
  const checks = [
    { name: 'claude', cmd: 'which claude' },
    { name: 'cursor', cmd: 'which cursor' },
    { name: 'aider', cmd: 'which aider' },
    { name: 'gemini', cmd: 'which gemini' },
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

  // Print MCP setup instructions
  console.log(chalk.bold('\n📋 Next steps — Add the Origin MCP server:\n'));

  console.log(chalk.cyan('For Claude Code') + chalk.gray(' — add to ~/.claude/settings.json:'));
  console.log(chalk.white(JSON.stringify({
    mcpServers: {
      origin: {
        command: 'npx',
        args: ['@origin/mcp-server'],
        env: {},
      }
    }
  }, null, 2)));

  console.log(chalk.cyan('\nFor Cursor') + chalk.gray(' — add to .cursor/mcp.json in your repo:'));
  console.log(chalk.white(JSON.stringify({
    mcpServers: {
      origin: {
        command: 'npx',
        args: ['@origin/mcp-server'],
      }
    }
  }, null, 2)));

  console.log(chalk.green('\n✓ Setup complete. Start coding — Origin is watching.\n'));
}
