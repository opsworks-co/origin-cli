import chalk from 'chalk';
import crypto from 'crypto';
import { execSync } from 'child_process';
import { findExecutable } from '../utils/exec.js';
import { compareVersions } from '../version-check.js';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { fileURLToPath } from 'url';

// ─── Constants ─────────────────────────────────────────────────────────────

const SERVER_URL = 'https://getorigin.io';
const VERSION_URL = `${SERVER_URL}/cli/version.json`;
const TARBALL_URL = `${SERVER_URL}/cli/origin-cli-latest.tgz`;

// ─── Main Command ──────────────────────────────────────────────────────────

/**
 * `origin upgrade [--check] [--force]`
 *
 * Check for and install the latest version of the Origin CLI.
 * Downloads directly from the Origin platform server.
 */
export async function upgradeCommand(opts: { check?: boolean; force?: boolean }): Promise<void> {
  const currentVersion = getCurrentVersion();

  console.log(chalk.bold('\nOrigin CLI Upgrade\n'));
  console.log(chalk.gray(`  Current version: ${currentVersion}`));

  // Check server for latest version
  const latest = await getLatestVersion();
  if (!latest) {
    console.log(chalk.yellow('\n  Could not check for updates. Try again later.'));
    // Cycle the daemons anyway. Restarting them is a purely LOCAL operation —
    // it compares the running daemon's build to the installed one and respawns
    // — so tying it to a network round-trip meant a transient fetch failure
    // left both watchers capturing on stale code with no way to fix it short of
    // calling the restart helpers by hand. Observed twice in a row on a working
    // machine; an offline machine could never cycle its own daemons at all.
    if (!opts.check) { await syncWatchersToInstalledCode(); await healHookConfigs(); }
    return;
  }

  console.log(chalk.gray(`  Latest version:  ${latest.version}`));

  // ORDER the versions, don't just test equality. The old `current === latest`
  // check treated "different" as "newer" and would install an OLDER build over
  // a newer one while printing "Upgrading: 2043 → 2042". Two everyday ways to
  // land there: a locally-built CLI (`npm install -g .` from the repo), and the
  // window between pushing a release tag and its deploy finishing — the
  // workflow regenerates /cli/version.json only in its last job, so the server
  // advertises the PREVIOUS version for several minutes after the tag exists.
  const cmp = compareVersions(currentVersion, latest.version);

  if (cmp === 0) {
    console.log(chalk.green('\n  ✓ Already up to date!\n'));
    // The BINARY being current doesn't mean the background daemons are: they
    // keep running whatever code they loaded at spawn. A daemon left behind by
    // an `npm install -g` (which never runs this command) or by an upgrade that
    // happened while it was already up would otherwise keep capturing with old
    // code until a reboot or its 24h lifetime cap.
    await syncWatchersToInstalledCode();
    await healHookConfigs();
    return;
  }

  if (cmp > 0 && (!opts.force || opts.check)) {
    console.log(chalk.green(`\n  ✓ Your install is NEWER than the server's (${currentVersion} > ${latest.version}).`));
    console.log(chalk.gray('    Nothing to do — installing would be a downgrade.'));
    console.log(chalk.gray('    To roll back to the server version on purpose:'));
    console.log(chalk.gray('      origin upgrade --force\n'));
    // Same reasoning as the up-to-date path: the binary here is the newest
    // thing on the box, so any daemon not matching it is stale.
    if (!opts.check) { await syncWatchersToInstalledCode(); await healHookConfigs(); }
    return;
  }

  // Check-only mode
  if (opts.check) {
    console.log(chalk.yellow(`\n  Update available: ${currentVersion} → ${latest.version}`));
    console.log(chalk.gray('  Run `origin upgrade` to install.\n'));
    return;
  }

  const downgrading = cmp > 0;
  console.log(chalk[downgrading ? 'yellow' : 'cyan'](
    `\n  ${downgrading ? 'Downgrading (--force)' : 'Upgrading'}: ${currentVersion} → ${latest.version}\n`,
  ));

  const success = downloadAndInstall(latest.url, latest.sha256);

  if (success) {
    // Verify the upgrade actually took effect. Compare against the target
    // version we just installed (definitive) rather than "different from the
    // current version" — the latter false-warns whenever the current-version
    // read itself fell back (e.g. the old Windows 0.0.0 bug).
    const newVersion = getInstalledVersion();
    if (newVersion && newVersion === latest.version) {
      console.log(chalk.green(`\n  ✓ Now running ${newVersion}!\n`));
      // Restart the Codex rollout watcher so it runs the JUST-INSTALLED code.
      // Without this the old daemon keeps executing its stale in-memory version
      // (upgrade only swaps dist/ on disk), silently mis-capturing sessions
      // until a reboot or its 24h lifetime. No-op where it isn't auto-started.
      try {
        const { restartCodexWatch } = await import('../codex-watch.js');
        if (restartCodexWatch().restarted) {
          console.log(chalk.gray('  ✓ Restarted the Codex watcher on the new version\n'));
        }
      } catch { /* non-fatal: the watcher self-restarts at next logon / 24h */ }
      // Same for the multi-agent transcript watcher — cycle it onto the fresh
      // code so it doesn't keep capturing with the stale in-memory version.
      try {
        const { restartTranscriptWatch } = await import('../transcript-watch.js');
        if (restartTranscriptWatch().restarted) {
          console.log(chalk.gray('  ✓ Restarted the transcript watcher on the new version\n'));
        }
      } catch { /* non-fatal: the watcher self-restarts at next logon / 24h */ }
      // And rewrite any hook config the new code would write differently —
      // the whole point of shipping a schema fix.
      healHookConfigsWithInstalledCode();
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

/**
 * Cycle any watcher daemon that is running code older (or just different) than
 * the CLI on disk. No-op when a daemon already matches, so repeated
 * `origin upgrade` runs don't churn a healthy watcher, and no-op when one isn't
 * running at all — starting watchers is `origin enable`'s job.
 *
 * Used on the "already up to date" path. The post-install path below restarts
 * unconditionally instead: it just replaced dist/, so every daemon is stale by
 * definition and the sidecar hasn't been rewritten yet.
 */
async function syncWatchersToInstalledCode(): Promise<void> {
  try {
    const { restartCodexWatchIfStale } = await import('../codex-watch.js');
    reportWatcherAction('Codex', restartCodexWatchIfStale());
  } catch { /* non-fatal: the watcher self-restarts at next logon / 24h */ }
  try {
    const { restartTranscriptWatchIfStale } = await import('../transcript-watch.js');
    reportWatcherAction('transcript', restartTranscriptWatchIfStale());
  } catch { /* non-fatal */ }
}

/**
 * Absolute path to the JS entry point of the globally installed CLI, so we can
 * run the version npm JUST put on disk rather than the one in this process.
 */
function installedCliEntry(): string | null {
  try {
    const root = execSync('npm root -g', {
      windowsHide: true,
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
      timeout: 15_000,
    }).trim();
    if (root) {
      const entry = path.join(root, '@origin', 'cli', 'dist', 'index.js');
      if (fs.existsSync(entry)) return entry;
    }
  } catch { /* fall through to the PATH walk */ }
  try {
    const originPath = findExecutable('origin');
    if (!originPath) return null;
    // The npm bin is a symlink straight to the package's dist/index.js.
    const real = fs.realpathSync(originPath);
    return real.toLowerCase().endsWith('.js') && fs.existsSync(real) ? real : null;
  } catch { /* ignore */ }
  return null;
}

/**
 * Repair hook configs USING THE BINARY WE JUST INSTALLED.
 *
 * This process is still running the pre-upgrade code, and its idea of the
 * correct hook schema is precisely the one the upgrade replaced — healing
 * in-process would write the old schema straight back and report success. So
 * shell out to the new entry point. If it can't be resolved, fall back to the
 * in-process pass: for every drift class except "the schema itself changed in
 * this release", the old code still writes the right thing.
 */
function healHookConfigsWithInstalledCode(): void {
  const entry = installedCliEntry();
  if (!entry) {
    void healHookConfigs();
    return;
  }
  try {
    const out = execSync(`"${process.execPath}" "${entry}" hooks repair`, {
      windowsHide: true,
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
      timeout: 30_000,
    });
    // `hooks repair` already prints one line per config it touched; only echo
    // it when it actually did something, so a clean upgrade stays quiet.
    if (/✓|⚠|✗/.test(out) && !/All \d+ hook config/.test(out)) {
      process.stdout.write(out);
    }
  } catch {
    void healHookConfigs();
  }
}

/**
 * Rewrite any agent hook config that no longer matches what this CLI writes.
 *
 * This is the path that makes a hook-schema fix REACH people. `enable` is the
 * only thing that has ever written these files, and nothing re-runs it, so
 * #1143's Antigravity fix would have sat in the installer while every machine
 * that already ran `enable` kept the file agy silently rejects — uncaptured,
 * with no error on either side and no way to self-heal (the hook that could
 * repair the file is the hook the broken file stops from running).
 *
 * Scoped to installs that already exist: agents never enabled at a given base
 * are left alone, so upgrading can't switch on capture the user didn't ask for.
 */
async function healHookConfigs(): Promise<void> {
  try {
    const { hookConfigBases, checkHookConfigs, repairHookConfig, isRepairable } =
      await import('../hook-config-health.js');

    for (const base of hookConfigBases()) {
      const drifted = checkHookConfigs(base).filter((r) => isRepairable(r.state));
      if (drifted.length === 0) continue;

      const where = base === os.homedir() ? 'globally' : base.replace(os.homedir(), '~');
      for (const report of drifted) {
        try {
          repairHookConfig(report);
          // 'relocated' is routine (a Node/nvm move); the rest means the agent
          // may have been rejecting the file, so say so plainly.
          const why = report.state === 'relocated'
            ? 'launcher path had moved'
            : report.state === 'unreadable'
              ? 'the file was corrupt'
              : `stale schema${report.detail ? ` (${report.detail})` : ''}`;
          console.log(chalk.green(`  ✓ Refreshed ${report.agentName} hooks in ${report.label} ${chalk.gray(`(${where}) — ${why}`)}`));
        } catch (err: any) {
          console.log(chalk.yellow(`  ⚠ Could not refresh ${report.agentName} hooks in ${report.label}: ${err?.message || err}`));
        }
      }
    }
  } catch { /* non-fatal: `origin doctor --fix` covers the same ground */ }
}

/**
 * Say what actually happened to a watcher. "Restarted — it was running an older
 * build" was printed for BOTH cases, so a daemon that had crashed and stopped
 * capturing entirely was reported in the same words as a routine version cycle.
 * That is the reassuring-but-false line that let a dead watcher go unnoticed for
 * hours; a revival is worth calling out, not smoothing over.
 */
function reportWatcherAction(label: string, res: { restarted: boolean; reason: string }): void {
  if (!res.restarted) return;
  if (res.reason === 'revived-dead-watcher') {
    console.log(chalk.yellow(`  ✓ Revived the ${label} watcher — it had DIED and was capturing nothing\n`));
    return;
  }
  console.log(chalk.gray(`  ✓ Restarted the ${label} watcher — it was running an older build\n`));
}

// ─── Version Checking ──────────────────────────────────────────────────────

export function getCurrentVersion(): string {
  try {
    // Use fileURLToPath — NOT `new URL(import.meta.url).pathname`. On Windows
    // the latter yields "/C:/…/package.json" (a spurious leading slash before
    // the drive letter), which readFileSync can't open, so every upgrade
    // reported "Current version: 0.0.0". fileURLToPath decodes the file URL
    // to a real OS path on all platforms (same approach as index.ts).
    // upgrade.js lives at dist/commands/ → two levels up is the package root.
    const pkgPath = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'package.json');
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
  // Primary: read the version npm just installed globally. `npm root -g`
  // returns the global node_modules dir on every platform, so
  // <root>/@origin/cli/package.json is the authoritative post-install version.
  // This is the reliable path on Windows, where the earlier bin-shim walk
  // failed: `npm i -g` writes origin.cmd into %AppData%\npm\ but the package
  // into %AppData%\npm\node_modules\@origin\cli\ — so resolving "../package.json"
  // from the shim landed on %AppData%\npm (no package.json) and every upgrade
  // falsely warned "the active origin binary was not updated."
  try {
    const root = execSync('npm root -g', { windowsHide: true,
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
      timeout: 15_000,
    }).trim();
    if (root) {
      const pkgJson = path.join(root, '@origin', 'cli', 'package.json');
      if (fs.existsSync(pkgJson)) {
        const pkg = JSON.parse(fs.readFileSync(pkgJson, 'utf-8'));
        if (pkg.version) return pkg.version;
      }
    }
  } catch { /* fall through to the bin-shim walk */ }

  // Fallback: locate the binary on PATH and walk to its package.json. Works on
  // the Unix global layout (bin symlinked into the package's dist).
  try {
    const originPath = findExecutable('origin');
    if (!originPath) return null;
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
    // 5s was too tight on slow / corporate networks — bump to 15s. The
    // previous behaviour swallowed AbortError and surfaced as the generic
    // "Could not check for updates. Try again later." message, which gave
    // the user no actionable signal.
    const timeoutId = setTimeout(() => controller.abort(), 15_000);

    const response = await fetch(VERSION_URL, {
      signal: controller.signal,
      headers: { Accept: 'application/json' },
    });

    clearTimeout(timeoutId);

    if (!response.ok) {
      console.log(chalk.gray(`  (server returned HTTP ${response.status} from ${VERSION_URL})`));
      return null;
    }

    const data = await response.json() as { version?: string; url?: string; sha256?: string | null };
    if (!data.version) {
      console.log(chalk.gray(`  (server response missing "version" field)`));
      return null;
    }

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
  } catch (err: any) {
    // Surface the underlying cause so users can diagnose network issues
    // instead of guessing. AbortError → timeout, ENOTFOUND → DNS, ECONNREFUSED
    // → host down, anything else prints the raw message.
    const msg = err?.name === 'AbortError'
      ? `timed out after 15s`
      : err?.code
        ? `${err.code}${err.message ? ' (' + err.message + ')' : ''}`
        : err?.message || String(err);
    console.log(chalk.gray(`  (fetch error: ${msg})`));
    return null;
  }
}

// ─── Installation ──────────────────────────────────────────────────────────

function downloadAndInstall(url: string, expectedSha256: string): boolean {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'origin-cli-'));
  const tgzPath = path.join(tmpDir, 'origin-cli-latest.tgz');

  try {
    console.log(chalk.gray('  Downloading...'));
    execSync(`curl -fsSL "${url}" -o "${tgzPath}"`, { windowsHide: true,
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
    execSync(`npm install -g "${tgzPath}"`, { windowsHide: true,
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
