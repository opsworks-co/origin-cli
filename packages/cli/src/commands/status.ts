import chalk from 'chalk';
import { loadConfig, loadAgentConfig } from '../config.js';
import { api } from '../api.js';

export async function statusCommand() {
  const config = loadConfig();
  const agentConfig = loadAgentConfig();

  console.log(chalk.bold('\n📊 Origin Status\n'));

  // Login status
  if (!config) {
    console.log(chalk.red('  ✗ Not logged in'));
    console.log(chalk.gray('    Run: origin login'));
    return;
  }
  console.log(chalk.green('  ✓ Logged in'));
  console.log(chalk.gray(`    API: ${config.apiUrl}`));
  console.log(chalk.gray(`    Org: ${config.orgId || 'unknown'}`));

  // Agent status
  if (!agentConfig) {
    console.log(chalk.yellow('\n  ⚠ Agent not initialized'));
    console.log(chalk.gray('    Run: origin init'));
  } else {
    console.log(chalk.green('\n  ✓ Agent initialized'));
    console.log(chalk.gray(`    Machine: ${agentConfig.hostname} (${agentConfig.machineId.slice(0, 8)}...)`));
    console.log(chalk.gray(`    Tools: ${agentConfig.detectedTools.length > 0 ? agentConfig.detectedTools.join(', ') : 'none'}`));
  }

  // Fetch policies
  try {
    const data = await api.getPolicies() as any;
    const policies = data.policies ?? data;
    const count = Array.isArray(policies) ? policies.length : 0;
    console.log(chalk.green(`\n  ✓ ${count} active ${count === 1 ? 'policy' : 'policies'}`));
  } catch (err: any) {
    console.log(chalk.yellow(`\n  ⚠ Could not fetch policies: ${err.message}`));
  }

  // MCP server check
  try {
    const res = await fetch(`${config.apiUrl}/api/mcp/policies`, {
      headers: { 'X-API-Key': config.apiKey },
    });
    if (res.ok) {
      console.log(chalk.green('  ✓ API connection healthy'));
    } else {
      console.log(chalk.red(`  ✗ API returned ${res.status}`));
    }
  } catch {
    console.log(chalk.red('  ✗ Cannot reach Origin API'));
  }

  console.log('');
}
