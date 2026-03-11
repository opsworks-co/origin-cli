import chalk from 'chalk';
import { execSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import os from 'os';

// ─── Constants ─────────────────────────────────────────────────────────────

const PACKAGE_NAME = '@origin/cli';
const GITHUB_RELEASES_URL = 'https://api.github.com/repos/origin-platform/origin-cli/releases';
const REGISTRY_URL = 'https://registry.npmjs.org';

// ─── Types ─────────────────────────────────────────────────────────────────

interface NpmRegistryResponse {
  'dist-tags': Record<string, string>;
  versions: Record<string, { version: string }>;
}

// ─── Main Command ──────────────────────────────────────────────────────────

/**
 * `origin upgrade [--channel stable|beta|canary]`
 *
 * Check for and install the latest version of the Origin CLI.
 * Supports npm global install detection and channel selection.
 */
export async function upgradeCommand(opts: { channel?: string; check?: boolean }): Promise<void> {
  const channel = opts.channel || 'stable';
  const currentVersion = getCurrentVersion();

  console.log(chalk.bold('\nOrigin CLI Upgrade\n'));
  console.log(chalk.gray(`  Current version: ${currentVersion}`));
  console.log(chalk.gray(`  Channel:         ${channel}`));

  // Check npm registry for latest version
  const latestVersion = await getLatestVersion(channel);
  if (!latestVersion) {
    console.log(chalk.yellow('\n  Could not check for updates. Try again later.'));
    return;
  }

  console.log(chalk.gray(`  Latest version:  ${latestVersion}`));

  if (currentVersion === latestVersion) {
    console.log(chalk.green('\n  Already up to date!\n'));
    return;
  }

  // Check-only mode
  if (opts.check) {
    console.log(chalk.yellow(`\n  Update available: ${currentVersion} -> ${latestVersion}`));
    console.log(chalk.gray('  Run `origin upgrade` to install.\n'));
    return;
  }

  console.log(chalk.cyan(`\n  Upgrading: ${currentVersion} -> ${latestVersion}\n`));

  // Detect install method and upgrade
  const installMethod = detectInstallMethod();
  let success = false;

  switch (installMethod) {
    case 'npm-global':
      success = upgradeViaGlobalNpm(channel, latestVersion);
      break;

    case 'npm-local':
      console.log(chalk.yellow('  This appears to be a local npm install.'));
      console.log(chalk.gray('  Upgrade your project dependency:'));
      console.log(chalk.gray(`    npm install ${PACKAGE_NAME}@${getTagForChannel(channel)}`));
      return;

    case 'unknown':
    default:
      console.log(chalk.yellow('  Could not detect install method.'));
      console.log(chalk.gray('  Try manually:'));
      console.log(chalk.gray(`    npm install -g ${PACKAGE_NAME}@${getTagForChannel(channel)}`));
      return;
  }

  if (success) {
    console.log(chalk.green(`\n  Successfully upgraded to ${latestVersion}!`));

    // Show changelog
    await showChangelog(currentVersion, latestVersion);
  } else {
    console.log(chalk.red('\n  Upgrade failed. Try manually:'));
    console.log(chalk.gray(`    npm install -g ${PACKAGE_NAME}@${getTagForChannel(channel)}\n`));
    process.exit(1);
  }
}

// ─── Version Checking ──────────────────────────────────────────────────────

/**
 * Get the current installed version from package.json.
 */
function getCurrentVersion(): string {
  try {
    const pkgPath = path.join(path.dirname(new URL(import.meta.url).pathname), '..', '..', 'package.json');
    const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf-8'));
    return pkg.version || '0.0.0';
  } catch {
    return '0.0.0';
  }
}

/**
 * Get the latest version from the npm registry.
 */
async function getLatestVersion(channel: string): Promise<string | null> {
  const tag = getTagForChannel(channel);

  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 5000);

    const response = await fetch(`${REGISTRY_URL}/${PACKAGE_NAME}`, {
      signal: controller.signal,
      headers: { Accept: 'application/json' },
    });

    clearTimeout(timeoutId);

    if (!response.ok) return null;

    const data = await response.json() as NpmRegistryResponse;
    return data['dist-tags']?.[tag] || data['dist-tags']?.['latest'] || null;
  } catch {
    return null;
  }
}

// ─── Installation ──────────────────────────────────────────────────────────

/**
 * Detect how the CLI was installed.
 */
function detectInstallMethod(): 'npm-global' | 'npm-local' | 'unknown' {
  try {
    // Check if we're a global npm install
    const globalPrefix = execSync('npm prefix -g', {
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
    }).trim();

    const originBin = execSync('which origin 2>/dev/null || command -v origin', {
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
    }).trim();

    if (originBin.startsWith(globalPrefix)) {
      return 'npm-global';
    }

    // Check if it's a local node_modules install
    if (originBin.includes('node_modules')) {
      return 'npm-local';
    }

    return 'npm-global'; // Best guess
  } catch {
    return 'unknown';
  }
}

/**
 * Upgrade via npm global install.
 */
function upgradeViaGlobalNpm(channel: string, version: string): boolean {
  const tag = getTagForChannel(channel);
  const target = channel === 'stable' ? `${PACKAGE_NAME}@latest` : `${PACKAGE_NAME}@${tag}`;

  try {
    console.log(chalk.gray(`  Running: npm install -g ${target}`));
    execSync(`npm install -g ${target}`, {
      encoding: 'utf-8',
      stdio: 'inherit',
      timeout: 120_000, // 2 minute timeout
    });
    return true;
  } catch (err: any) {
    // Try with sudo on Unix if permission denied
    if (process.platform !== 'win32' && err.message?.includes('EACCES')) {
      try {
        console.log(chalk.gray('  Retrying with elevated permissions...'));
        execSync(`sudo npm install -g ${target}`, {
          encoding: 'utf-8',
          stdio: 'inherit',
          timeout: 120_000,
        });
        return true;
      } catch {
        return false;
      }
    }
    return false;
  }
}

// ─── Changelog ─────────────────────────────────────────────────────────────

/**
 * Show changelog between versions by fetching from GitHub releases.
 */
async function showChangelog(fromVersion: string, toVersion: string): Promise<void> {
  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 5000);

    const response = await fetch(`${GITHUB_RELEASES_URL}?per_page=10`, {
      signal: controller.signal,
      headers: { Accept: 'application/vnd.github.v3+json' },
    });

    clearTimeout(timeoutId);

    if (!response.ok) return;

    const releases = await response.json() as Array<{
      tag_name: string;
      name: string;
      body: string;
      published_at: string;
    }>;

    // Filter releases between our versions
    const relevant = releases.filter(r => {
      const v = r.tag_name.replace(/^v/, '');
      return v > fromVersion && v <= toVersion;
    });

    if (relevant.length === 0) return;

    console.log(chalk.bold('\n  Changelog:\n'));

    for (const release of relevant.slice(0, 5)) {
      const version = release.tag_name;
      const date = new Date(release.published_at).toLocaleDateString();
      console.log(chalk.cyan(`    ${version}`) + chalk.gray(` (${date})`));

      // Show first few lines of the body
      if (release.body) {
        const bodyLines = release.body.split('\n').filter(l => l.trim()).slice(0, 5);
        for (const line of bodyLines) {
          console.log(chalk.gray(`      ${line.trim()}`));
        }
      }
      console.log();
    }
  } catch {
    // Non-fatal — changelog is nice to have
  }
}

// ─── Helpers ───────────────────────────────────────────────────────────────

/**
 * Map channel name to npm dist-tag.
 */
function getTagForChannel(channel: string): string {
  switch (channel) {
    case 'beta': return 'beta';
    case 'canary': return 'canary';
    case 'stable':
    default: return 'latest';
  }
}
