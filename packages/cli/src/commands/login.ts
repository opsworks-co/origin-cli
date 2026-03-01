import { createInterface } from 'readline/promises';
import { saveConfig } from '../config.js';
import chalk from 'chalk';

export async function loginCommand() {
  const rl = createInterface({ input: process.stdin, output: process.stdout });

  console.log(chalk.bold('\n🔑 Origin Login\n'));

  const apiUrl = await rl.question(chalk.gray('Origin API URL (default: http://localhost:4002): '));
  const apiKey = await rl.question(chalk.gray('API Key: '));
  rl.close();

  const url = apiUrl.trim() || 'http://localhost:4002';
  const key = apiKey.trim();

  if (!key) {
    console.log(chalk.red('Error: API key is required'));
    process.exit(1);
  }

  // Verify connection
  console.log(chalk.gray('\nVerifying connection...'));
  try {
    const res = await fetch(`${url}/api/mcp/policies`, {
      headers: { 'X-API-Key': key },
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json() as any;

    saveConfig({
      apiUrl: url,
      apiKey: key,
      orgId: data.orgId || '',
      userId: '',
    });

    console.log(chalk.green('✓ Connected to Origin'));
    console.log(chalk.gray(`  Organization: ${data.orgName || 'Connected'}`));
    console.log(chalk.gray(`  Config saved to ~/.origin/config.json`));
  } catch (err: any) {
    console.log(chalk.red(`✗ Failed to connect: ${err.message}`));
    process.exit(1);
  }
}
