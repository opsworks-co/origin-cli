import os from 'os';
import crypto from 'crypto';
import chalk from 'chalk';
import { loadConfig, loadAgentConfig, saveAgentConfig, isConnectedMode } from '../config.js';
import { api } from '../api.js';
import { enableCommand } from './enable.js';
import { detectTools } from '../tools-detector.js';

export async function initCommand(opts: { standalone?: boolean; hooks?: boolean; local?: boolean } = {}) {
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
      const status = err.status || 0;
      if (status === 401) {
        console.log(chalk.yellow('\n⚠ Could not connect to Origin — invalid or expired API key.'));
        console.log(chalk.gray('  Run `origin login` to re-authenticate.'));
      } else if (status === 403) {
        console.log(chalk.yellow('\n⚠ Could not connect to Origin — insufficient permissions.'));
        console.log(chalk.gray(`  ${err.serverMessage || err.message}`));
        console.log(chalk.gray('  Check your API key permissions in Settings → API Keys.'));
      } else {
        console.log(chalk.yellow(`\n⚠ Could not connect to Origin — ${err.message}`));
        console.log(chalk.gray('  Machine registration skipped. Sessions will still be tracked locally.'));
      }
    }
  }

  // Agent is resolved automatically at session start — no manual selection needed.
  // The session start hook matches the detected tool (claude-code, gemini, cursor)
  // to agents assigned to the API key via slug/name matching.

  saveAgentConfig({ machineId, hostname, detectedTools, orgId: config?.orgId || 'local' });
  console.log(chalk.gray('  Agent config saved to ~/.origin/agent.json'));

  // Auto-install hooks. Default = global (every repo tracked automatically
  // via git core.hooksPath). Opt-out with --no-hooks. Switch to per-repo-only
  // with --local (must be inside a git repo).
  if (opts.hooks !== false) {
    const useGlobal = !opts.local;
    if (useGlobal) {
      console.log(chalk.bold('\n📡 Installing GLOBAL git hooks\n'));
      console.log(chalk.gray('  Sets git config --global core.hooksPath → ~/.origin/git-hooks'));
      console.log(chalk.gray('  Every repo on this machine — past and future — gets tracked'));
      console.log(chalk.gray('  automatically. No per-repo `origin init` needed.'));
      console.log(chalk.gray('  Opt out with: origin init --local (per-repo only)\n'));
      await enableCommand({ global: true });
      console.log(chalk.green('\n✓ Global hooks installed — every repo is now tracked'));
    } else {
      console.log(chalk.bold('\n📡 Installing LOCAL git hooks for this repo only\n'));
      await enableCommand({ global: false });
      console.log(chalk.green('\n✓ Local hooks installed — only this repo is tracked'));
      console.log(chalk.gray('  Run `origin init` (no --local) to track ALL repos globally.'));
    }
  }

  if (!connected) {
    console.log(chalk.green('\n✓ Standalone mode ready — sessions will be tracked locally in git.'));
  }
}
