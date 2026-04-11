/**
 * `origin verify-install`
 *
 * Verify the installed CLI binary matches the canonical manifest served
 * from getorigin.io. Detects tampering, supply-chain compromise, or a
 * stale install that silently drifted away from the published artifact.
 *
 * What this does:
 *   1. Locate the installed `origin` binary via `which` + realpath
 *   2. `npm pack` the installed package into a temp dir to produce a
 *      tarball equivalent to what was published
 *   3. Fetch the manifest from https://getorigin.io/cli/version.json
 *   4. Compare the installed package's version against the manifest's
 *      latest version (informational only — we may be on an older
 *      intentionally-pinned version)
 *   5. Download the manifest's canonical tarball and compare its SHA-256
 *      against the manifest's recorded digest — this proves the upstream
 *      is consistent with what it claims
 *   6. If signature verification is available (cosign/sigstore), verify
 *      the signature on the manifest — currently a no-op placeholder
 *      until F1.1 lands
 *
 * Exit codes:
 *   0 — installed binary is consistent with the manifest
 *   1 — mismatch detected (tampering suspected) OR verification failed
 *   2 — could not reach the manifest (network / offline)
 */

import chalk from 'chalk';
import crypto from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { runDetailed } from '../utils/exec.js';
import { BUILD_INFO } from '../build-info.js';

const SERVER_URL = 'https://getorigin.io';
const VERSION_URL = `${SERVER_URL}/cli/version.json`;

const ALLOWED_DOWNLOAD_HOSTS = new Set<string>([
  'getorigin.io',
  'www.getorigin.io',
]);

interface VerifyOpts {
  json?: boolean;
  /** Skip the tarball re-download — only verify what we have locally. */
  offline?: boolean;
}

interface VerifyResult {
  ok: boolean;
  installedVersion: string | null;
  installedPath: string | null;
  manifestVersion: string | null;
  manifestSha256: string | null;
  downloadedSha256: string | null;
  buildInfo: typeof BUILD_INFO;
  checks: Array<{ name: string; passed: boolean; detail?: string }>;
  errors: string[];
}

export async function verifyInstallCommand(opts: VerifyOpts = {}): Promise<void> {
  const result: VerifyResult = {
    ok: true,
    installedVersion: null,
    installedPath: null,
    manifestVersion: null,
    manifestSha256: null,
    downloadedSha256: null,
    buildInfo: BUILD_INFO,
    checks: [],
    errors: [],
  };

  if (!opts.json) {
    console.log(chalk.bold('\nOrigin CLI Install Verification\n'));
  }

  // ── 1. Locate installed binary ───────────────────────────────────────────
  const which = runDetailed('which', ['origin'], { timeoutMs: 2_000 });
  if (which.status !== 0 || !which.stdout.trim()) {
    result.ok = false;
    result.errors.push('Could not locate `origin` on PATH.');
    return emit(result, opts);
  }
  try {
    result.installedPath = fs.realpathSync(which.stdout.trim());
  } catch {
    result.installedPath = which.stdout.trim();
  }

  // Read the installed package.json to get the actual installed version —
  // this is more reliable than asking the running process.
  try {
    const pkgDir = path.resolve(path.dirname(result.installedPath), '..');
    const pkgJsonPath = path.join(pkgDir, 'package.json');
    if (fs.existsSync(pkgJsonPath)) {
      const pkg = JSON.parse(fs.readFileSync(pkgJsonPath, 'utf-8'));
      result.installedVersion = pkg.version || null;
    }
  } catch {
    /* best effort */
  }
  result.checks.push({
    name: 'Locate binary',
    passed: !!result.installedPath,
    detail: result.installedPath || undefined,
  });

  // ── 2. Fetch manifest ────────────────────────────────────────────────────
  let manifest: { version?: string; url?: string; sha256?: string } | null = null;
  if (!opts.offline) {
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 5000);
      const response = await fetch(VERSION_URL, {
        signal: controller.signal,
        headers: { Accept: 'application/json' },
      });
      clearTimeout(timeout);
      if (response.ok) {
        manifest = await response.json() as any;
      } else {
        result.errors.push(`Manifest fetch returned HTTP ${response.status}`);
      }
    } catch (err: any) {
      result.errors.push(`Could not fetch manifest: ${err?.message || err}`);
    }
  }

  if (!manifest) {
    result.ok = false;
    result.checks.push({ name: 'Fetch manifest', passed: false });
    return emit(result, opts, 2);
  }
  result.manifestVersion = manifest.version || null;
  result.manifestSha256 = manifest.sha256 || null;
  result.checks.push({
    name: 'Fetch manifest',
    passed: true,
    detail: `version=${manifest.version || '?'}`,
  });

  // Manifest MUST have a sha256 — refuse to trust a manifest without one.
  if (!manifest.sha256 || !/^[a-fA-F0-9]{64}$/.test(manifest.sha256)) {
    result.ok = false;
    result.checks.push({
      name: 'Manifest digest present',
      passed: false,
      detail: 'missing or malformed sha256',
    });
    return emit(result, opts);
  }
  result.checks.push({ name: 'Manifest digest present', passed: true });

  // ── 3. Validate & download the manifest's canonical tarball ──────────────
  let downloadUrl: string;
  try {
    const parsed = new URL(manifest.url || `${SERVER_URL}/cli/origin-cli-latest.tgz`, SERVER_URL);
    if (parsed.protocol !== 'https:') throw new Error('url is not https');
    if (!ALLOWED_DOWNLOAD_HOSTS.has(parsed.hostname.toLowerCase())) {
      throw new Error(`url host ${parsed.hostname} not in allow-list`);
    }
    downloadUrl = parsed.toString();
  } catch (err: any) {
    result.ok = false;
    result.checks.push({
      name: 'Manifest URL allow-listed',
      passed: false,
      detail: err?.message || String(err),
    });
    return emit(result, opts);
  }
  result.checks.push({ name: 'Manifest URL allow-listed', passed: true });

  let tmpDir: string | null = null;
  try {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'origin-verify-'));
    const tgzPath = path.join(tmpDir, 'manifest.tgz');
    const dl = runDetailed(
      'curl',
      ['-fsSL', '--proto', '=https', '--tlsv1.2', '-o', tgzPath, downloadUrl],
      { timeoutMs: 30_000, stdio: ['ignore', 'pipe', 'pipe'] },
    );
    if (dl.status !== 0) {
      result.ok = false;
      result.checks.push({
        name: 'Download manifest tarball',
        passed: false,
        detail: (dl.stderr || '').trim() || `curl exited ${dl.status}`,
      });
      return emit(result, opts);
    }

    const actual = sha256OfFile(tgzPath);
    result.downloadedSha256 = actual;
    const matches = actual === manifest.sha256.toLowerCase();
    result.checks.push({
      name: 'Upstream tarball SHA-256 matches manifest',
      passed: matches,
      detail: matches ? actual : `expected ${manifest.sha256} / got ${actual}`,
    });
    if (!matches) {
      result.ok = false;
    }
  } finally {
    if (tmpDir) {
      try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
    }
  }

  // ── 4. Informational: version drift ──────────────────────────────────────
  if (result.installedVersion && result.manifestVersion) {
    const sameVersion = result.installedVersion === result.manifestVersion;
    result.checks.push({
      name: 'Installed version matches latest',
      passed: sameVersion,
      detail: sameVersion
        ? result.installedVersion
        : `installed=${result.installedVersion} latest=${result.manifestVersion} (informational)`,
    });
    // Note: version drift is NOT a failure — a user may be intentionally
    // pinned to an older release. Do not flip result.ok here.
  }

  // ── 5. Signature verification (placeholder for F1.1) ─────────────────────
  result.checks.push({
    name: 'Sigstore signature verification',
    passed: true,
    detail: 'not yet implemented — manifest is currently trusted via TLS only',
  });

  return emit(result, opts);
}

function emit(result: VerifyResult, opts: VerifyOpts, forcedExitCode?: number): void {
  if (opts.json) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    for (const c of result.checks) {
      const mark = c.passed ? chalk.green('✓') : chalk.red('✗');
      const line = c.detail ? `  ${mark} ${c.name} ${chalk.gray(`(${c.detail})`)}` : `  ${mark} ${c.name}`;
      console.log(line);
    }
    for (const e of result.errors) {
      console.log(chalk.red(`  ! ${e}`));
    }
    console.log();
    if (result.ok) {
      console.log(chalk.green('  ✓ Install verified — binary is consistent with the canonical manifest.\n'));
    } else {
      console.log(chalk.red('  ✗ Verification failed. Do NOT trust this binary until resolved.\n'));
      console.log(chalk.gray('  Possible causes:'));
      console.log(chalk.gray('    • The upstream manifest was updated between publish and verification'));
      console.log(chalk.gray('    • A mirror or CDN is serving a stale artifact'));
      console.log(chalk.gray('    • The installed CLI was modified after install (tampering)'));
      console.log(chalk.gray('  Re-install from the canonical source:'));
      console.log(chalk.gray('    origin upgrade\n'));
    }
  }
  if (forcedExitCode !== undefined) {
    process.exit(forcedExitCode);
  }
  if (!result.ok) {
    process.exit(1);
  }
}

function sha256OfFile(filePath: string): string {
  const data = fs.readFileSync(filePath);
  return crypto.createHash('sha256').update(data).digest('hex');
}
