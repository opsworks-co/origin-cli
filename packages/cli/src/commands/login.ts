import { createInterface } from 'readline/promises';
import { saveConfig } from '../config.js';
import chalk from 'chalk';

export async function loginCommand() {
  const rl = createInterface({ input: process.stdin, output: process.stdout });

  console.log(chalk.bold('\n🔑 Origin Login\n'));

  const apiUrl = await rl.question(chalk.gray('Origin API URL (default: https://getorigin.io): '));
  const apiKey = await rl.question(chalk.gray('API Key: '));
  rl.close();

  const url = (apiUrl.trim() || 'https://getorigin.io').replace(/\/+$/, '');
  const key = apiKey.trim();

  if (!key) {
    console.log(chalk.red('Error: API key is required'));
    process.exit(1);
  }

  // Verify connection via whoami endpoint
  console.log(chalk.gray('\nVerifying connection...'));
  try {
    const whoamiUrl = `${url}/api/mcp/whoami`;
    const res = await fetch(whoamiUrl, {
      headers: { 'X-API-Key': key },
    });

    // Check if response is HTML (wrong URL or SPA catch-all)
    const contentType = res.headers.get('content-type') || '';
    if (contentType.includes('text/html')) {
      throw new Error(`Server returned HTML instead of JSON. Check your API URL: ${url}`);
    }

    if (!res.ok) {
      const errBody = await res.json().catch(() => ({})) as any;
      if (res.status === 401) {
        throw new Error('Invalid API key. Make sure you copied the full key (shown only once at creation time). The key prefix in Settings is not the full key.');
      }
      throw new Error(errBody.error || `HTTP ${res.status}`);
    }
    const data = await res.json() as any;

    saveConfig({
      apiUrl: url.replace(/\/+$/, ''),
      apiKey: key,
      orgId: data.orgId || '',
      userId: '',
    });

    console.log(chalk.green('✓ Connected to Origin'));
    console.log(chalk.gray(`  Organization: ${data.orgName || 'Unknown'}`));
    console.log(chalk.gray(`  API Key: ${data.apiKeyName || key.slice(0, 4) + '••••••••'}`));
    console.log(chalk.gray(`  Agents: ${data.agentCount || 0} configured`));
    console.log(chalk.gray(`  Repos: ${data.repoCount || 0} registered`));
    if (data.repoScopes?.length === 0) {
      console.log(chalk.yellow('  ⚠ This API key has no repo access. Assign repos in Settings → API Keys.'));
    }
    if (data.agentScopes?.length === 0) {
      console.log(chalk.yellow('  ⚠ This API key has no agent access. Assign agents in Settings → API Keys.'));
    }
    console.log(chalk.gray(`  Config saved to ~/.origin/config.json`));
  } catch (err: any) {
    console.log(chalk.red(`✗ Failed to connect: ${err.message}`));
    process.exit(1);
  }
}
