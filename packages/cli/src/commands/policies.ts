import chalk from 'chalk';
import { loadConfig } from '../config.js';
import { api } from '../api.js';

export async function policiesCommand() {
  const config = loadConfig();
  if (!config) {
    console.log(chalk.red('Not logged in. Run: origin login'));
    process.exit(1);
  }

  console.log(chalk.bold('\n📜 Active Policies\n'));

  try {
    const data = await api.getPolicies() as any;
    const policies = data.policies ?? data;

    if (!Array.isArray(policies) || policies.length === 0) {
      console.log(chalk.gray('  No active policies found.'));
      console.log(chalk.gray('  Create policies at your Origin dashboard.\n'));
      return;
    }

    for (const policy of policies) {
      const status = policy.enabled !== false ? chalk.green('●') : chalk.red('○');
      console.log(`  ${status} ${chalk.white(policy.name || policy.id)}`);
      if (policy.description) {
        console.log(chalk.gray(`    ${policy.description}`));
      }
      if (policy.type) {
        console.log(chalk.gray(`    Type: ${policy.type}`));
      }
      if (policy.scope) {
        console.log(chalk.gray(`    Scope: ${policy.scope}`));
      }
      console.log('');
    }

    console.log(chalk.gray(`  Total: ${policies.length} ${policies.length === 1 ? 'policy' : 'policies'}\n`));
  } catch (err: any) {
    console.log(chalk.red(`  ✗ Failed to fetch policies: ${err.message}\n`));
    process.exit(1);
  }
}
