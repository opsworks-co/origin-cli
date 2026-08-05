// Machine-wide "ignore this whole repo" list (config.ignoredRepos), managed by
// `origin ignore repo`. A repo — or any path nested under an ignored entry —
// creates NO Origin session for any agent; the session lifecycle is dropped at
// session-start (see hooks.ts). This lets a headless scratch workspace (e.g. a
// Claude Desktop cowork project at ~/.openclaw/workspace, which runs the real
// `claude` CLI and so trips the global claude-code hooks) stop flooding the org,
// while genuine local repos — even ones with no git remote — keep tracking.
//
// This module is pure + side-effect-free except the thin load/save helpers, so
// the matching logic is unit-testable without touching disk.
import path from 'path';
import os from 'os';
import { loadConfig, saveConfig } from './config.js';

// macOS and Windows have case-insensitive filesystems by default, so
// `/Users/x/Repo` and `/users/x/repo` are the same directory. Linux is
// case-sensitive. Compare with a platform-appropriate key so a case-variant
// path the user typed still matches the tracked repo (and vice-versa).
const CASE_INSENSITIVE = process.platform === 'win32' || process.platform === 'darwin';

/**
 * Expand a leading `~`, resolve to an absolute path, and normalize separators.
 * Returns '' for empty input. Does NOT touch the filesystem (no realpath), so
 * it works for paths that don't exist yet and never throws.
 */
export function normalizeRepoPath(p: string | undefined | null): string {
  if (!p) return '';
  let out = String(p).trim();
  if (!out) return '';
  if (out === '~') out = os.homedir();
  else if (out === '~/' || out === '~\\') out = os.homedir();
  else if (out.startsWith('~/') || out.startsWith('~\\')) out = path.join(os.homedir(), out.slice(2));
  // path.resolve makes it absolute (against cwd if relative) and strips any
  // trailing separator except for a filesystem root.
  return path.resolve(out);
}

function compareKey(p: string): string {
  return CASE_INSENSITIVE ? p.toLowerCase() : p;
}

/**
 * If `repoPath` is exactly an ignored entry — or nested beneath one — return the
 * ORIGINAL entry string (as the user typed it, for display); otherwise null.
 * Nesting uses a separator boundary so `/a/foo` never matches an entry `/a/fo`.
 */
export function matchIgnoredRepo(repoPath: string | undefined | null, ignored: string[] | undefined | null): string | null {
  const target = normalizeRepoPath(repoPath);
  if (!target || !ignored || ignored.length === 0) return null;
  const targetKey = compareKey(target);
  for (const raw of ignored) {
    const entry = normalizeRepoPath(raw);
    if (!entry) continue;
    const entryKey = compareKey(entry);
    if (targetKey === entryKey) return raw;
    const withSep = entryKey.endsWith(path.sep) ? entryKey : entryKey + path.sep;
    if (targetKey.startsWith(withSep)) return raw;
  }
  return null;
}

/** Cheap machine-wide check used by the hooks. Reads the (cached) config. */
export function isRepoIgnored(repoPath: string | undefined | null): boolean {
  return matchIgnoredRepo(repoPath, loadConfig()?.ignoredRepos || []) !== null;
}

/**
 * Add a repo path to the machine-wide ignore list. Stores the ABSOLUTE,
 * `~`-expanded path so the entry is unambiguous regardless of the cwd it was
 * added from. Returns { added, alreadyPresent, path } — added=false when an
 * equivalent entry (or a parent that already covers it) is present.
 */
export function addIgnoredRepo(repoPath: string): { added: boolean; alreadyCovered: boolean; path: string } {
  const abs = normalizeRepoPath(repoPath);
  const config = loadConfig() || ({} as any);
  const list: string[] = Array.isArray(config.ignoredRepos) ? config.ignoredRepos : [];
  // Already ignored (exact entry or covered by an existing parent entry)?
  if (matchIgnoredRepo(abs, list)) return { added: false, alreadyCovered: true, path: abs };
  config.ignoredRepos = [...list, abs];
  saveConfig(config);
  return { added: true, alreadyCovered: false, path: abs };
}

/**
 * Remove a repo path from the ignore list. Matches an entry whose normalized
 * form equals the normalized input, so `~/x`, `~/x/`, and the absolute path all
 * remove the same entry. Returns the removed entry or null when none matched.
 */
export function removeIgnoredRepo(repoPath: string): string | null {
  const wantKey = compareKey(normalizeRepoPath(repoPath));
  const config = loadConfig();
  const list: string[] = Array.isArray(config?.ignoredRepos) ? config!.ignoredRepos! : [];
  const idx = list.findIndex((e) => compareKey(normalizeRepoPath(e)) === wantKey);
  if (idx === -1) return null;
  const [removed] = list.splice(idx, 1);
  config!.ignoredRepos = list;
  saveConfig(config!);
  return removed;
}

/** The machine-wide ignore list (as stored), or []. */
export function listIgnoredRepos(): string[] {
  const list = loadConfig()?.ignoredRepos;
  return Array.isArray(list) ? list : [];
}
