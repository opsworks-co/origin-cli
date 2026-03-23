import chalk from 'chalk';
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

  const success = downloadAndInstall(latest.url);

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

async function getLatestVersion(): Promise<{ version: string; url: string } | null> {
  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 5000);

    const response = await fetch(VERSION_URL, {
      signal: controller.signal,
      headers: { Accept: 'application/json' },
    });

    clearTimeout(timeoutId);

    if (!response.ok) return null;

    const data = await response.json() as { version?: string; url?: string };
    if (!data.version) return null;

    return { version: data.version, url: data.url || TARBALL_URL };
  } catch {
    return null;
  }
}

// ─── Installation ──────────────────────────────────────────────────────────

function downloadAndInstall(url: string): boolean {
  try {
    // Download to temp dir, then npm install -g
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'origin-cli-'));
    const tgzPath = path.join(tmpDir, 'origin-cli-latest.tgz');

    console.log(chalk.gray('  Downloading...'));
    execSync(`curl -fsSL "${url}" -o "${tgzPath}"`, {
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
      timeout: 30_000,
    });

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
    // Try with sudo on Unix if permission denied
    if (process.platform !== 'win32' && err.message?.includes('EACCES')) {
      try {
        console.log(chalk.gray('  Retrying with elevated permissions...'));
        const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'origin-cli-'));
        const tgzPath = path.join(tmpDir, 'origin-cli-latest.tgz');

        execSync(`curl -fsSL "${url}" -o "${tgzPath}"`, {
          encoding: 'utf-8',
          stdio: ['pipe', 'pipe', 'pipe'],
          timeout: 30_000,
        });

        execSync(`sudo npm install -g "${tgzPath}"`, {
          encoding: 'utf-8',
          stdio: 'inherit',
          timeout: 60_000,
        });

        try { fs.rmSync(tmpDir, { recursive: true }); } catch { /* ignore */ }
        return true;
      } catch {
        return false;
      }
    }
    return false;
  }
}
