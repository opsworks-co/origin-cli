/**
 * The list of repos `origin enable` has installed repo-local hooks into.
 *
 * `origin upgrade` needs it. A hook-schema fix (see hook-config-health.ts) can
 * only reach an existing install by rewriting the config file, and for a
 * repo-local install nothing else on the machine knows where those files are:
 * ~/.origin holds sessions, heartbeats and sync markers, all keyed by hashes,
 * none of which is a list of enabled repos. So `enable` records one here.
 *
 * Deliberately NOT authoritative — a repo enabled by an older CLI won't be in
 * it until the next `origin enable`. It's a best-effort index that makes
 * `upgrade` reach more installs; `origin status` / `origin doctor` still check
 * whatever repo the user is standing in, which covers the rest.
 */
import fs from 'fs';
import os from 'os';
import path from 'path';

interface EnabledRepoEntry {
  path: string;
  enabledAt: string;
}

function registryPath(): string {
  return path.join(os.homedir(), '.origin', 'enabled-repos.json');
}

function readEntries(): EnabledRepoEntry[] {
  try {
    const raw = JSON.parse(fs.readFileSync(registryPath(), 'utf-8'));
    const repos = Array.isArray(raw?.repos) ? raw.repos : [];
    return repos.filter((e: any) => e && typeof e.path === 'string');
  } catch {
    return [];
  }
}

function writeEntries(entries: EnabledRepoEntry[]): void {
  try {
    const file = registryPath();
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify({ repos: entries }, null, 2) + '\n');
  } catch {
    // Best effort — never let bookkeeping fail an enable/disable.
  }
}

/** Remember that this repo has repo-local Origin hooks. Idempotent. */
export function recordEnabledRepo(repoPath: string): void {
  if (!repoPath || repoPath === os.homedir()) return;
  const entries = readEntries().filter((e) => e.path !== repoPath);
  entries.push({ path: repoPath, enabledAt: new Date().toISOString() });
  writeEntries(entries);
}

/** Drop a repo from the registry — `origin disable` just removed its hooks. */
export function forgetEnabledRepo(repoPath: string): void {
  const entries = readEntries();
  const next = entries.filter((e) => e.path !== repoPath);
  if (next.length !== entries.length) writeEntries(next);
}

/**
 * Registered repos that still exist on disk. Prunes the ones that don't, so a
 * deleted checkout stops being retried on every upgrade.
 */
export function listEnabledRepos(): string[] {
  const entries = readEntries();
  const alive = entries.filter((e) => {
    try { return fs.statSync(e.path).isDirectory(); } catch { return false; }
  });
  if (alive.length !== entries.length) writeEntries(alive);
  return alive.map((e) => e.path);
}
