import { createInterface } from 'readline/promises';
import { saveConfig, saveProfile, listProfiles, loadConfig, deleteProfile } from '../config.js';
import chalk from 'chalk';

export async function loginCommand(opts: { key?: string; url?: string; profile?: string }) {
  console.log(chalk.bold('\n🔑 Origin Login\n'));

  let url: string;
  let key: string;

  if (opts.key) {
    // Non-interactive mode
    url = (opts.url || 'https://getorigin.io').replace(/\/+$/, '');
    key = opts.key.trim();
  } else {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    const apiUrl = await rl.question(chalk.gray('Origin API URL (default: https://getorigin.io): '));
    const apiKey = await rl.question(chalk.gray('API Key: '));
    rl.close();
    url = (apiUrl.trim() || 'https://getorigin.io').replace(/\/+$/, '');
    key = apiKey.trim();
  }

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

    const keyType = data.keyType || 'team';
    const accountType = data.accountType || 'org';
    const isSolo = keyType === 'solo' || accountType === 'developer';

    // Determine profile name
    const profileName = opts.profile || (isSolo ? 'dev' : 'team');

    // Save as primary config (always — this is the active account for CLI commands)
    const currentConfig = loadConfig();
    saveConfig({
      ...currentConfig,
      apiUrl: url.replace(/\/+$/, ''),
      apiKey: key,
      orgId: data.orgId || '',
      userId: '',
      keyType,
      accountType,
      orgName: data.orgName || '',
    });

    // Remove any stale profile using the same API key under a different name
    const existingProfiles = listProfiles();
    for (const p of existingProfiles) {
      if (p.apiKey === key && p.name !== profileName) {
        deleteProfile(p.name);
      }
    }

    // Also save as named profile (for multi-account hooks)
    saveProfile(profileName, {
      name: profileName,
      apiUrl: url.replace(/\/+$/, ''),
      apiKey: key,
      orgId: data.orgId || '',
      orgName: data.orgName || '',
      keyType: keyType as 'solo' | 'team',
      accountType: accountType as 'developer' | 'org',
    });

    // Single-key world (Path B). One key authenticates the user; the
    // server federates the personal view across every org they belong to
    // via /api/me/*. The old multi-account fan-out is gone — additional
    // /me/* lenses populate automatically as admins grant the user access
    // to more orgs/repos. No second login, no second key.
    if (isSolo) {
      console.log(chalk.green(`✓ Connected — Solo Developer`));
      console.log(chalk.gray(`  Workspace: ${data.orgName || 'Personal workspace'}`));
      console.log(chalk.gray(`  All repos · All agents · No restrictions`));
    } else {
      console.log(chalk.green(`✓ Connected — Team Member @ ${data.orgName || 'Unknown'}`));
      console.log(chalk.gray(`  API Key: ${data.apiKeyName || key.slice(0, 4) + '••••••••'}`));
      console.log(chalk.gray(`  Agents: ${data.agentCount || 0} configured`));
      console.log(chalk.gray(`  Repos: ${data.repoCount || 0} registered`));
      if (data.repoScopes?.length === 0) {
        console.log(chalk.yellow('  ⚠ This API key has no repo access. Ask your admin to assign repos.'));
      }
      if (data.agentScopes?.length === 0) {
        console.log(chalk.yellow('  ⚠ This API key has no agent access. Ask your admin to assign agents.'));
      }
    }
    // Tell the user about the federation behavior so they don't go hunt
    // for a "personal account" login that no longer exists.
    const allProfiles = listProfiles();
    if (allProfiles.length > 1) {
      console.log(chalk.gray(`\n  Personal dashboard at ${url}/me aggregates your activity across every org you belong to.`));
    }

    console.log(chalk.gray(`  Config saved to ~/.origin/config.json`));
  } catch (err: any) {
    console.log(chalk.red(`✗ Failed to connect: ${err.message}`));
    process.exit(1);
  }

  process.exit(0);
}
