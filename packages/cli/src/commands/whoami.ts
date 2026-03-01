import chalk from 'chalk';
import { loadConfig, loadAgentConfig } from '../config.js';
import { api } from '../api.js';

export async function whoamiCommand() {
  const config = loadConfig();
  if (!config) {
    console.log(chalk.red('Not logged in. Run: origin login'));
    process.exit(1);
  }

  console.log(chalk.bold('\n👤 Origin Identity\n'));

  // Show local config
  console.log(chalk.gray(`  API: ${config.apiUrl}`));
  console.log(chalk.gray(`  Org ID: ${config.orgId || 'unknown'}`));

  // Fetch user info from API
  try {
    const me = await api.getMe() as any;
    if (me.email) console.log(chalk.white(`  Email: ${me.email}`));
    if (me.name) console.log(chalk.white(`  Name: ${me.name}`));
    if (me.role) console.log(chalk.gray(`  Role: ${me.role}`));
    if (me.orgName) console.log(chalk.gray(`  Organization: ${me.orgName}`));
  } catch (err: any) {
    console.log(chalk.yellow(`  ⚠ Could not fetch user info: ${err.message}`));
  }

  // Show agent/machine info
  const agentConfig = loadAgentConfig();
  if (agentConfig) {
    console.log(chalk.gray(`\n  Machine: ${agentConfig.hostname}`));
    console.log(chalk.gray(`  Machine ID: ${agentConfig.machineId}`));
    console.log(chalk.gray(`  Tools: ${agentConfig.detectedTools.length > 0 ? agentConfig.detectedTools.join(', ') : 'none'}`));
  } else {
    console.log(chalk.gray('\n  Machine: not initialized (run: origin init)'));
  }

  console.log('');
}
