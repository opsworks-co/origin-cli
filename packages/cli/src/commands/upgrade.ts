import chalk from 'chalk';
import crypto from 'crypto';
import { execSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import os from 'os';

// ─── Constants ─────────────────────────────────────────────────────────────

const SERVER_URL = 'https://getorigin.io';
const VERSION_URL = `${SERVER_URL}/cli/version.json`;
const TARBALL_URL = `${SERVER_URL}/cli/origin-cli-latest.tgz`;

// ─── Main Command ──────────────────────────────────────────────────────────

/**
 * `origin upgrade [--check]`
 *
 * Check for and install the latest version of the Origin CLI.
 * Downloads directly from the Origin platform server.
 */
export async function upgradeCommand(opts: { check?: boolean }): Promise<void> {
  const currentVersion = getCurrentVersion();

  console.log(chalk.bold('\nOrigin CLI Upgrade\n'));
  console.log(chalk.gray(`  Current version: ${currentVersion}`));

  // Check server for latest version
  const latest = await getLatestVersion();
  if (!latest) {
    console.log(chalk.yellow('\n  Could not check for updates. Try again later.'));
    return;
  }

  console.log(chalk.gray(`  Latest version:  ${latest.version}`));

  if (currentVersion === latest.version) {
    console.log(chalk.green('\n  ✓ Already up to date!\n'));
    return;
  }

  // Check-only mode
  if (opts.check) {
    console.log(chalk.yellow(`\n  Update available: ${currentVersion} → ${latest.version}`));
    console.log(chalk.gray('  Run `origin upgrade` to install.\n'));
    return;
  }

  console.log(chalk.cyan(`\n  Upgrading: ${currentVersion} → ${latest.version}\n`));

  const success = downloadAndInstall(latest.url, latest.sha256);

  if (success) {
    // Verify the upgrade actually took effect
    const newVersion = getInstalledVersion();
    if (newVersion && newVersion !== currentVersion) {
      console.log(chalk.green(`\n  ✓ Successfully upgraded to ${newVersion}!\n`));
    } else {
      console.log(chalk.yellow(`\n  ⚠ npm install succeeded but the active origin binary was not updated.`));
      console.log(chalk.yellow(`    This usually means origin was installed with a different Node/npm.`));
      console.log(chalk.gray(`\n  Try one of these:`));
      console.log(chalk.gray(`    npm i -g ${TARBALL_URL}`));
      console.log(chalk.gray(`    # Or if using nvm, make sure you're on the right Node version first\n`));
    }

    // Clear update check cache so banner disappears
    try {
      const cachePath = path.join(os.homedir(), '.origin', 'last-update-check.json');
      fs.unlinkSync(cachePath);
    } catch { /* ignore */ }
  } else {
    console.log(chalk.red('\n  Upgrade failed. Try manually:'));
    console.log(chalk.gray(`    npm i -g ${TARBALL_URL}\n`));
    process.exit(1);
  }
}

// ─── Version Checking ──────────────────────────────────────────────────────

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
 * Check what version the `origin` binary on PATH actually reports.
 * This catches cases where npm install -g succeeded but installed to a
 * different prefix than where `origin` resolves from.
 */
function getInstalledVersion(): string | null {
  try {
    // Use `which origin` to find the actual binary, then read its package.json
    const originPath = execSync('which origin', { encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] }).trim();
    if (!originPath) return null;
    // Follow symlinks to find the real location
    const realPath = fs.realpathSync(originPath);
    const pkgDir = path.resolve(path.dirname(realPath), '..');
    const pkgJson = path.join(pkgDir, 'package.json');
    if (fs.existsSync(pkgJson)) {
      const pkg = JSON.parse(fs.readFileSync(pkgJson, 'utf-8'));
      return pkg.version || null;
    }
  } catch { /* ignore */ }
  return null;
}

async function getLatestVersion(): Promise<{ version: string; url: string; sha256: string } | null> {
  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 5000);

    const response = await fetch(VERSION_URL, {
      signal: controller.signal,
      headers: { Accept: 'application/json' },
    });

    clearTimeout(timeoutId);

    if (!response.ok) return null;

    const data = await response.json() as { version?: string; url?: string; sha256?: string | null };
    if (!data.version) return null;

    // Fail-closed: sha256 must be present and non-empty
    if (!data.sha256) {
      console.log(chalk.red('\n  Server response missing SHA-256 checksum. Aborting upgrade for safety.'));
      return null;
    }

    const url = data.url || TARBALL_URL;

    // URL pinning: only allow downloads from getorigin.io
    if (!url.startsWith('https://getorigin.io/')) {
      console.log(chalk.red(`\n  Untrusted download URL rejected: ${url}`));
      return null;
    }

    return { version: data.version, url, sha256: data.sha256 };
  } catch {
    return null;
  }
}

// ─── Installation ──────────────────────────────────────────────────────────

function downloadAndInstall(url: string, expectedSha256: string): boolean {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'origin-cli-'));
  const tgzPath = path.join(tmpDir, 'origin-cli-latest.tgz');

  try {
    console.log(chalk.gray('  Downloading...'));
    execSync(`curl -fsSL "${url}" -o "${tgzPath}"`, {
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
      timeout: 30_000,
    });

    // Verify SHA-256 integrity
    console.log(chalk.gray('  Verifying integrity...'));
    const fileBuffer = fs.readFileSync(tgzPath);
    const actualSha256 = crypto.createHash('sha256').update(fileBuffer).digest('hex');

    if (actualSha256 !== expectedSha256) {
      console.log(chalk.red(`\n  Integrity check failed!`));
      console.log(chalk.red(`    Expected: ${expectedSha256}`));
      console.log(chalk.red(`    Got:      ${actualSha256}`));
      console.log(chalk.red(`  Aborting upgrade — the downloaded file may have been tampered with.\n`));
      try { fs.rmSync(tmpDir, { recursive: true }); } catch { /* ignore */ }
      return false;
    }

    console.log(chalk.gray('  Installing...'));
    execSync(`npm install -g "${tgzPath}"`, {
      encoding: 'utf-8',
      stdio: 'inherit',
      timeout: 60_000,
    });

    // Cleanup
    try { fs.rmSync(tmpDir, { recursive: true }); } catch { /* ignore */ }

    return true;
  } catch (err: any) {
    // Cleanup on failure
    try { fs.rmSync(tmpDir, { recursive: true }); } catch { /* ignore */ }

    if (process.platform !== 'win32' && err.message?.includes('EACCES')) {
      console.log(chalk.yellow('\n  Permission denied. Please run manually with elevated permissions:'));
      console.log(chalk.gray(`    sudo npm install -g ${TARBALL_URL}\n`));
    }

    return false;
  }
}
