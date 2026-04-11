import chalk from 'chalk';
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { runDetailed } from '../utils/exec.js';
import { BUILD_INFO } from '../build-info.js';

// ─── Constants ─────────────────────────────────────────────────────────────

/**
 * Hardcoded canonical upgrade origin. Pinned in source so a compromised
 * tarball cannot redirect future upgrades to an attacker-controlled host.
 * Update intentionally and review the diff carefully.
 */
const SERVER_URL = 'https://getorigin.io';
const VERSION_URL = `${SERVER_URL}/cli/version.json`;
const TARBALL_URL = `${SERVER_URL}/cli/origin-cli-latest.tgz`;

/**
 * Allow-list of hosts the upgrader will download from. Manifests served
 * from `getorigin.io` may point at the same host or our CDN, but we never
 * follow a manifest URL pointing at an arbitrary third party.
 */
const ALLOWED_DOWNLOAD_HOSTS = new Set<string>([
  'getorigin.io',
  'www.getorigin.io',
]);

// ─── Backup / Rollback ─────────────────────────────────────────────────────

/**
 * Location where we stash the previous tarball before each upgrade. If an
 * upgrade breaks the CLI, `origin upgrade --rollback` re-installs this.
 *
 * Kept under ~/.origin so it's per-user and survives across shells, but not
 * under npm's global prefix (which might be wiped by the next install).
 */
const BACKUP_DIR = path.join(os.homedir(), '.origin', 'backups');
const BACKUP_META_FILE = path.join(BACKUP_DIR, 'previous.json');

interface BackupMeta {
  version: string;
  tarballPath: string;
  sha256: string;
  savedAt: string;
}

function readBackupMeta(): BackupMeta | null {
  try {
    const raw = fs.readFileSync(BACKUP_META_FILE, 'utf-8');
    const meta = JSON.parse(raw) as BackupMeta;
    if (!meta.version || !meta.tarballPath || !meta.sha256) return null;
    if (!fs.existsSync(meta.tarballPath)) return null;
    return meta;
  } catch {
    return null;
  }
}

function writeBackupMeta(meta: BackupMeta): void {
  fs.mkdirSync(BACKUP_DIR, { recursive: true });
  fs.writeFileSync(BACKUP_META_FILE, JSON.stringify(meta, null, 2) + '\n');
}

/**
 * Pack the currently-installed CLI into BACKUP_DIR so we can roll back to
 * it. Returns the backup tarball path or null on failure. Failures here are
 * logged but never abort the upgrade — a failed backup is still better than
 * refusing to upgrade entirely.
 */
function backupCurrentInstall(currentVersion: string): BackupMeta | null {
  try {
    // Find the installed origin binary's package dir.
    const which = runDetailed('which', ['origin'], { timeoutMs: 2_000 });
    if (which.status !== 0) return null;
    const originPath = which.stdout.trim();
    if (!originPath) return null;
    const realPath = fs.realpathSync(originPath);
    const pkgDir = path.resolve(path.dirname(realPath), '..');
    if (!fs.existsSync(path.join(pkgDir, 'package.json'))) return null;

    fs.mkdirSync(BACKUP_DIR, { recursive: true });
    // `npm pack` produces a tarball in cwd. Run it in BACKUP_DIR so the
    // output lands where we want it.
    const packed = runDetailed('npm', ['pack', pkgDir], {
      cwd: BACKUP_DIR,
      timeoutMs: 30_000,
    });
    if (packed.status !== 0) return null;
    const tarName = packed.stdout.trim().split('\n').pop() || '';
    if (!tarName) return null;
    const tarballPath = path.join(BACKUP_DIR, tarName);
    if (!fs.existsSync(tarballPath)) return null;

    const meta: BackupMeta = {
      version: currentVersion,
      tarballPath,
      sha256: sha256OfFile(tarballPath),
      savedAt: new Date().toISOString(),
    };
    writeBackupMeta(meta);
    return meta;
  } catch {
    return null;
  }
}

// ─── Main Command ──────────────────────────────────────────────────────────

interface UpgradeOpts {
  check?: boolean;
  dryRun?: boolean;
  rollback?: boolean;
}

/**
 * `origin upgrade [--check] [--dry-run]`
 *
 * Check for and install the latest version of the Origin CLI.
 * Downloads directly from the Origin platform server, verifies the
 * SHA-256 of the tarball against the manifest, and installs via
 * `npm install -g` (no `sudo`).
 */
export async function upgradeCommand(opts: UpgradeOpts): Promise<void> {
  // Rollback short-circuits the whole update-check flow — no network at all.
  if (opts.rollback) {
    return rollbackCommand();
  }

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
  if (latest.sha256) {
    console.log(chalk.gray(`  SHA-256:         ${latest.sha256}`));
  } else {
    console.log(chalk.yellow(`  SHA-256:         (manifest does not include a digest — refusing to install)`));
  }

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

  // Dry-run mode: print what would happen, don't touch anything
  if (opts.dryRun) {
    console.log(chalk.cyan(`\n  [dry-run] Would upgrade ${currentVersion} → ${latest.version}`));
    console.log(chalk.gray(`  [dry-run] Would download: ${latest.url}`));
    console.log(chalk.gray(`  [dry-run] Would verify SHA-256 against: ${latest.sha256 || '(none)'}`));
    console.log(chalk.gray(`  [dry-run] Would install via: npm install -g <tarball>\n`));
    return;
  }

  // Refuse to install without a digest. Older manifests didn't include one;
  // we'd rather fail closed than silently install an unverified tarball.
  if (!latest.sha256) {
    console.log(chalk.red('\n  Refusing to install: manifest is missing sha256 digest.'));
    console.log(chalk.gray(`  Install manually after verifying the tarball:`));
    console.log(chalk.gray(`    npm i -g ${TARBALL_URL}\n`));
    process.exit(1);
  }

  // Refuse to upgrade if we'd need root. The user can re-run under a Node
  // version manager (nvm/asdf/volta) or fix the prefix; we will NOT shell
  // out to sudo on their behalf — that's a privilege escalation.
  const prefixWritable = isNpmGlobalPrefixWritable();
  if (prefixWritable === false) {
    console.log(chalk.red('\n  Refusing to install: npm global prefix is not writable by the current user.'));
    console.log(chalk.gray(`  Origin will not invoke sudo automatically. Fix one of these and re-run:`));
    console.log(chalk.gray(`    • Use a Node version manager (nvm, volta, asdf) so global installs land in your home dir`));
    console.log(chalk.gray(`    • Run npm config set prefix ~/.npm-global and add it to PATH`));
    console.log(chalk.gray(`    • Install manually: sudo npm i -g ${TARBALL_URL}\n`));
    process.exit(1);
  }

  console.log(chalk.cyan(`\n  Upgrading: ${currentVersion} → ${latest.version}\n`));

  // Pack the currently-installed CLI so we have something to roll back to
  // if this upgrade breaks things. Non-fatal if it fails.
  const backup = backupCurrentInstall(currentVersion);
  if (backup) {
    console.log(chalk.gray(`  Backed up current version to ${backup.tarballPath}`));
  } else {
    console.log(chalk.yellow(`  (could not back up current install — rollback will be unavailable)`));
  }

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
  // Prefer BUILD_INFO (written at build time by scripts/write-build-info.cjs).
  // Previously this walked up from dist/ to read package.json via a relative
  // import.meta.url path — that breaks under npm's global bin shim (the CLI
  // resolves from a symlinked .bin/origin, so `..` doesn't land where we
  // expected) and under Bun/Deno-style loaders that don't expose a real
  // filesystem URL. BUILD_INFO is baked into the JS bundle, so it works
  // identically regardless of how the binary is installed.
  const baked: string = BUILD_INFO.version;
  if (baked && baked !== '0.0.0-dev') {
    return baked;
  }
  // Dev-mode fallback: walk up from the compiled file to find package.json.
  try {
    const pkgPath = path.join(path.dirname(new URL(import.meta.url).pathname), '..', '..', 'package.json');
    const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf-8'));
    return pkg.version || '0.0.0';
  } catch {
    return BUILD_INFO.version || '0.0.0';
  }
}

/**
 * Check what version the `origin` binary on PATH actually reports.
 * This catches cases where npm install -g succeeded but installed to a
 * different prefix than where `origin` resolves from.
 */
function getInstalledVersion(): string | null {
  try {
    // `which` is invoked with no shell, args are literal strings.
    const r = runDetailed('which', ['origin'], { timeoutMs: 2000 });
    if (r.status !== 0) return null;
    const originPath = r.stdout.trim();
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

interface VersionManifest {
  version: string;
  url: string;
  sha256?: string;
}

async function getLatestVersion(): Promise<VersionManifest | null> {
  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 5000);

    const response = await fetch(VERSION_URL, {
      signal: controller.signal,
      headers: { Accept: 'application/json' },
    });

    clearTimeout(timeoutId);

    if (!response.ok) return null;

    const data = await response.json() as { version?: string; url?: string; sha256?: string };
    if (!data.version) return null;

    // Validate version string — only allow semver-ish characters.
    if (!/^[a-zA-Z0-9._+-]+$/.test(data.version)) return null;

    // Resolve and validate the download URL. We accept either a relative
    // path served from getorigin.io or an absolute URL whose host is on
    // our allow-list. Anything else is rejected.
    let downloadUrl = data.url || TARBALL_URL;
    try {
      const parsed = new URL(downloadUrl, SERVER_URL);
      if (parsed.protocol !== 'https:') return null;
      if (!ALLOWED_DOWNLOAD_HOSTS.has(parsed.hostname.toLowerCase())) return null;
      downloadUrl = parsed.toString();
    } catch {
      return null;
    }

    // Validate sha256 if present — must be 64 hex chars.
    let sha256: string | undefined;
    if (data.sha256) {
      if (!/^[a-fA-F0-9]{64}$/.test(data.sha256)) return null;
      sha256 = data.sha256.toLowerCase();
    }

    return { version: data.version, url: downloadUrl, sha256 };
  } catch {
    return null;
  }
}

// ─── Installation ──────────────────────────────────────────────────────────

/**
 * Download tarball, verify its SHA-256, and install via `npm install -g`.
 * Never invokes sudo. Never falls back to escalation. Returns true on
 * success, false otherwise — caller logs the failure.
 */
function downloadAndInstall(url: string, expectedSha256: string): boolean {
  let tmpDir: string | null = null;
  try {
    // Re-validate the URL one more time before we touch the network.
    const parsed = new URL(url);
    if (parsed.protocol !== 'https:') return false;
    if (!ALLOWED_DOWNLOAD_HOSTS.has(parsed.hostname.toLowerCase())) return false;

    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'origin-cli-'));
    const tgzPath = path.join(tmpDir, 'origin-cli-latest.tgz');

    console.log(chalk.gray('  Downloading...'));
    // curl args are passed as an array — no shell, no interpolation.
    // -f: fail on HTTP error; -sS: silent but show errors; -L: follow redirects.
    const dl = runDetailed(
      'curl',
      ['-fsSL', '--proto', '=https', '--tlsv1.2', '-o', tgzPath, url],
      { timeoutMs: 30_000, stdio: ['ignore', 'pipe', 'pipe'] },
    );
    if (dl.status !== 0) {
      console.log(chalk.red(`  Download failed: ${(dl.stderr || '').trim() || `curl exited ${dl.status}`}`));
      return false;
    }

    // Verify SHA-256 of the downloaded tarball before doing anything with it.
    console.log(chalk.gray('  Verifying SHA-256...'));
    const actualSha = sha256OfFile(tgzPath);
    if (actualSha !== expectedSha256) {
      console.log(chalk.red(`  SHA-256 mismatch:`));
      console.log(chalk.red(`    expected ${expectedSha256}`));
      console.log(chalk.red(`    got      ${actualSha}`));
      console.log(chalk.red('  Refusing to install — aborting.'));
      return false;
    }
    console.log(chalk.green('  ✓ SHA-256 verified'));

    console.log(chalk.gray('  Installing...'));
    // Pass the local tgz path as a positional arg. No shell, no expansion.
    // We deliberately do NOT fall back to sudo on EACCES — privilege
    // escalation in an auto-updater is a supply-chain disaster waiting to
    // happen. The caller already pre-flighted prefix writability.
    const inst = runDetailed('npm', ['install', '-g', tgzPath], {
      timeoutMs: 120_000,
      stdio: 'inherit',
    });
    if (inst.status !== 0) {
      console.log(chalk.red(`  npm install exited ${inst.status}`));
      return false;
    }

    return true;
  } catch (err: any) {
    console.log(chalk.red(`  Upgrade error: ${err?.message || err}`));
    return false;
  } finally {
    if (tmpDir) {
      try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
    }
  }
}

/**
 * Compute SHA-256 of a file synchronously. Used for tarball verification.
 */
function sha256OfFile(filePath: string): string {
  const data = fs.readFileSync(filePath);
  return crypto.createHash('sha256').update(data).digest('hex');
}

/**
 * Best-effort check whether the npm global prefix is writable by the
 * current user. Returns:
 *   - true:  prefix exists and we can write to it
 *   - false: prefix exists and we cannot write
 *   - null:  unknown (npm not found, prefix missing, etc.) — caller should
 *            proceed cautiously
 */
function isNpmGlobalPrefixWritable(): boolean | null {
  try {
    const r = runDetailed('npm', ['prefix', '-g'], { timeoutMs: 5_000 });
    if (r.status !== 0) return null;
    const prefix = r.stdout.trim();
    if (!prefix) return null;
    try {
      fs.accessSync(prefix, fs.constants.W_OK);
      return true;
    } catch {
      return false;
    }
  } catch {
    return null;
  }
}

// ─── Rollback ──────────────────────────────────────────────────────────────

/**
 * `origin upgrade --rollback`
 *
 * Re-install the previous version from the backup tarball stashed at the
 * start of the last successful upgrade. Verifies the backup's SHA-256
 * against the recorded value before touching npm — if the backup was
 * tampered with on disk we refuse to install it.
 */
function rollbackCommand(): void {
  console.log(chalk.bold('\nOrigin CLI Rollback\n'));

  const meta = readBackupMeta();
  if (!meta) {
    console.log(chalk.yellow('  No backup available to roll back to.'));
    console.log(chalk.gray('  A backup is created automatically each time you run `origin upgrade`.'));
    console.log(chalk.gray('  If this is your first upgrade, there is nothing to roll back.\n'));
    process.exit(1);
  }

  const currentVersion = getCurrentVersion();
  console.log(chalk.gray(`  Current version:  ${currentVersion}`));
  console.log(chalk.gray(`  Previous version: ${meta.version}`));
  console.log(chalk.gray(`  Backup saved at:  ${meta.savedAt}`));
  console.log(chalk.gray(`  Backup path:      ${meta.tarballPath}`));

  if (currentVersion === meta.version) {
    console.log(chalk.green(`\n  ✓ Already on ${meta.version} — nothing to roll back.\n`));
    return;
  }

  // Verify the backup hasn't been tampered with on disk. If the sha doesn't
  // match what we recorded, something modified it — refuse to install.
  console.log(chalk.gray('  Verifying backup SHA-256...'));
  const actual = sha256OfFile(meta.tarballPath);
  if (actual !== meta.sha256) {
    console.log(chalk.red(`\n  Backup SHA-256 mismatch — refusing to install.`));
    console.log(chalk.red(`    expected ${meta.sha256}`));
    console.log(chalk.red(`    got      ${actual}`));
    console.log(chalk.gray(`\n  The backup file may have been modified. Re-install manually:`));
    console.log(chalk.gray(`    npm i -g @origin/cli@${meta.version}\n`));
    process.exit(1);
  }
  console.log(chalk.green('  ✓ SHA-256 verified'));

  // Pre-flight prefix writability — same rule as upgrade.
  const prefixWritable = isNpmGlobalPrefixWritable();
  if (prefixWritable === false) {
    console.log(chalk.red('\n  Refusing to install: npm global prefix is not writable.'));
    console.log(chalk.gray(`  Install manually: npm i -g ${meta.tarballPath}\n`));
    process.exit(1);
  }

  console.log(chalk.cyan(`\n  Rolling back: ${currentVersion} → ${meta.version}\n`));
  const inst = runDetailed('npm', ['install', '-g', meta.tarballPath], {
    timeoutMs: 120_000,
    stdio: 'inherit',
  });
  if (inst.status !== 0) {
    console.log(chalk.red(`\n  npm install exited ${inst.status}`));
    console.log(chalk.gray(`  Try manually: npm i -g ${meta.tarballPath}\n`));
    process.exit(1);
  }

  const newVersion = getInstalledVersion();
  if (newVersion === meta.version) {
    console.log(chalk.green(`\n  ✓ Rolled back to ${newVersion}\n`));
  } else {
    console.log(chalk.yellow(`\n  ⚠ npm install succeeded but the active origin binary was not updated.`));
    console.log(chalk.gray(`    Try: npm i -g ${meta.tarballPath}\n`));
  }
}
