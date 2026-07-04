import { spawn } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { createInterface } from 'readline/promises';
import { saveConfig, saveProfile, listProfiles, loadConfig, deleteProfile, type OriginConfig } from '../config.js';
import { clearReloginLock } from '../api.js';
import { ownerFromConfig, stampUnstampedQueuedSessions, listForeignQueuedSessions, currentOwner } from '../session-owner.js';
import { processPendingForeignAction } from './sessions.js';
import chalk from 'chalk';

// Clear ephemeral heartbeat files. These are transient, account-agnostic
// liveness records — stale ones from a previous account are useless and
// harmless to drop. (Sessions, by contrast, we KEEP — see below.)
function clearHeartbeats(): number {
  const dir = path.join(os.homedir(), '.origin', 'heartbeats');
  let cleared = 0;
  try {
    for (const entry of fs.readdirSync(dir)) {
      try { fs.unlinkSync(path.join(dir, entry)); cleared++; } catch { /* skip */ }
    }
  } catch { /* missing dir */ }
  return cleared;
}

// Handle an account switch at login. We used to DELETE all queued local
// sessions here, which threw away the user's previous-account work. Instead
// we now PRESERVE them: backfill an ownership stamp (the outgoing account) on
// any unstamped queued session so the sync path treats them as foreign and
// won't pull them into the new account. The user is then told they can run
// `origin sessions import` to bring them in, or `origin sessions forget` to
// discard — see status.ts and sessions.ts. New sessions are already stamped at
// capture time (saveSessionState → ensureOwnerStamp); this backfill only
// matters for legacy sessions captured before stamping existed.
function handleWorkspaceSwitch(previousConfig: OriginConfig | null, newOrgId: string, newApiKey: string): void {
  const switching = !!previousConfig?.orgId
    && (previousConfig.orgId !== newOrgId || previousConfig.apiKey !== newApiKey);
  if (!switching) return;
  const previousOwner = ownerFromConfig(previousConfig);
  stampUnstampedQueuedSessions(previousOwner);
  clearHeartbeats();
}

// After login, if queued sessions from a previous account are sitting locally,
// tell the user how to decide what happens to them. Call AFTER the new config
// is saved so `currentOwner()` reflects the account they just logged into.
function printForeignSessionHint(): void {
  const foreign = listForeignQueuedSessions(currentOwner());
  if (foreign.length === 0) return;
  const n = foreign.length;
  console.log(chalk.yellow(`\n  ⚠ ${n} session${n === 1 ? '' : 's'} from a previous Origin account ${n === 1 ? 'is' : 'are'} kept locally.`));
  console.log(chalk.gray('    Run `origin sessions import` to bring them into this account,'));
  console.log(chalk.gray('    or `origin sessions forget` to discard them.'));
}

// Best-effort: open a URL in the user's default browser. Falls back to
// printing the URL if the platform-specific opener isn't available.
function openInBrowser(url: string) {
  try {
    const cmd = process.platform === 'darwin'
      ? 'open'
      : process.platform === 'win32'
        ? 'cmd'
        : 'xdg-open';
    const args = process.platform === 'win32' ? ['/c', 'start', '""', url] : [url];
    spawn(cmd, args, { stdio: 'ignore', detached: true }).unref();
  } catch { /* user can copy the URL manually */ }
}

// Drive the device-code flow on the server. Returns the minted key +
// resolved metadata, or throws if the request expires / is denied.
async function deviceCodeLogin(apiUrl: string): Promise<{
  apiKey: string;
  orgId: string;
  orgName: string;
  keyType: 'solo' | 'team';
  accountType: 'developer' | 'org';
}> {
  const startRes = await fetch(`${apiUrl}/api/cli-auth/start`, { method: 'POST' });
  if (!startRes.ok) {
    throw new Error(`Couldn't start device login (HTTP ${startRes.status}). Falling back: rerun with --key.`);
  }
  const start = (await startRes.json()) as {
    deviceCode: string;
    userCode: string;
    verificationUrl: string;
    expiresIn: number;
    interval: number;
  };

  console.log(chalk.gray('  Open this URL in your browser to approve the login:'));
  console.log('    ' + chalk.cyan(start.verificationUrl));
  console.log(chalk.gray(`  Code: ${chalk.white(start.userCode)}`));
  console.log(chalk.gray(`  (waiting up to ${Math.round(start.expiresIn / 60)} min for approval…)\n`));
  openInBrowser(start.verificationUrl);

  const deadline = Date.now() + start.expiresIn * 1000;
  const intervalMs = Math.max(1, start.interval) * 1000;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, intervalMs));
    const pollRes = await fetch(`${apiUrl}/api/cli-auth/poll`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ deviceCode: start.deviceCode }),
    });
    if (pollRes.status === 202) continue; // still pending
    if (pollRes.status === 410) throw new Error('Login request expired. Rerun `origin login`.');
    if (pollRes.status === 403) throw new Error('Login denied in browser.');
    if (pollRes.ok) {
      const body = (await pollRes.json()) as {
        status: string;
        apiKey: string;
        orgId: string;
        orgName: string;
        keyType?: 'solo' | 'team';
        accountType?: 'developer' | 'org';
      };
      if (body.status === 'approved' && body.apiKey) {
        return {
          apiKey: body.apiKey,
          orgId: body.orgId,
          orgName: body.orgName,
          keyType: body.keyType || 'team',
          accountType: body.accountType || 'org',
        };
      }
    }
    // Other statuses fall through and retry until deadline.
  }
  throw new Error('Login request timed out. Rerun `origin login`.');
}

export async function loginCommand(opts: { key?: string; url?: string; profile?: string; browser?: boolean }) {
  console.log(chalk.bold('\n🔑 Origin Login\n'));

  let url: string;
  let key: string;

  // Force device-code flow when:
  //   - --browser flag is passed (explicit), OR
  //   - ORIGIN_FORCE_DEVICE_CODE=1 env var is set (used by the
  //     api.ts auto-relogin spawn, where the child has stdio:
  //     'ignore' so process.stdin.isTTY is false and we'd
  //     otherwise drop into the manual-prompt branch and die on
  //     EOF from the closed stdin).
  const forceDeviceCode = !!opts.browser || process.env.ORIGIN_FORCE_DEVICE_CODE === '1';

  if (opts.key) {
    // Non-interactive mode — explicit key supplied.
    url = (opts.url || 'https://getorigin.io').replace(/\/+$/, '');
    key = opts.key.trim();
  } else if (process.stdin.isTTY || forceDeviceCode) {
    // Default path: browser-based device-code flow so users don't
    // have to dig an API key out of Settings and paste it. This is
    // the common path for re-login after the previous account was
    // deleted/rotated. Falls back to manual prompts if the server's
    // /cli-auth endpoints don't respond (older self-hosted versions).
    url = (opts.url || 'https://getorigin.io').replace(/\/+$/, '');
    try {
      const result = await deviceCodeLogin(url);
      key = result.apiKey;
      const currentConfig = loadConfig();
      // Account switch: tag the previous account's queued sessions as foreign
      // (instead of deleting them) so they don't leak into the new account.
      handleWorkspaceSwitch(currentConfig, result.orgId, key);
      saveConfig({
        ...currentConfig,
        apiUrl: url,
        apiKey: key,
        orgId: result.orgId,
        userId: '',
        keyType: result.keyType,
        accountType: result.accountType,
        orgName: result.orgName,
      });
      // Clear the auto-relogin lock so a future drift can re-spawn
      // this flow. (api.ts also clears it on the next successful
      // request — this is the belt-and-braces path for cases where
      // login finishes before another hook fires.)
      clearReloginLock();
      const isSolo = result.keyType === 'solo' || result.accountType === 'developer';
      const profileName = opts.profile || (isSolo ? 'dev' : 'team');
      const existingProfiles = listProfiles();
      for (const p of existingProfiles) {
        if (p.apiKey === key && p.name !== profileName) {
          deleteProfile(p.name);
        }
      }
      saveProfile(profileName, {
        name: profileName,
        apiUrl: url,
        apiKey: key,
        orgId: result.orgId,
        orgName: result.orgName,
        keyType: result.keyType,
        accountType: result.accountType,
      });
      console.log(chalk.green(`\n✓ Connected — ${isSolo ? 'Solo Developer' : `Team Member @ ${result.orgName}`}`));
      console.log(chalk.gray(`  Workspace: ${result.orgName}`));
      console.log(chalk.gray(`  Config saved to ~/.origin/config.json`));
      await processPendingForeignAction();
      printForeignSessionHint();
      process.exit(0);
    } catch (err: any) {
      console.log(chalk.yellow(`\n⚠ Browser login didn't complete: ${err.message}`));
      // When this is the auto-relogin spawn (no TTY, forceDeviceCode
      // env), don't fall through to manual stdin prompts — there's
      // no user typing into us. Exit cleanly so the lock file
      // expires and a future hook can re-spawn.
      if (forceDeviceCode && !process.stdin.isTTY) {
        process.exit(1);
      }
      console.log(chalk.gray('  Falling back to manual API key entry.\n'));
      const rl = createInterface({ input: process.stdin, output: process.stdout });
      const apiUrl = await rl.question(chalk.gray('Origin API URL (default: https://getorigin.io): '));
      const apiKey = await rl.question(chalk.gray('API Key: '));
      rl.close();
      url = (apiUrl.trim() || 'https://getorigin.io').replace(/\/+$/, '');
      key = apiKey.trim();
    }
  } else {
    // No TTY (CI / piped input) — keep the interactive prompts. They
    // fail noisily in CI rather than hanging on the device-code wait.
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
    // Account switch: tag the previous account's queued sessions as foreign
    // (instead of deleting them) so they don't leak into the new account.
    handleWorkspaceSwitch(currentConfig, data.orgId || '', key);
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
    await processPendingForeignAction();
    printForeignSessionHint();
  } catch (err: any) {
    console.log(chalk.red(`✗ Failed to connect: ${err.message}`));
    process.exit(1);
  }

  process.exit(0);
}
