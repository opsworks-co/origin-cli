/**
 * Getting the repo's memory OFF this machine and onto the dashboard.
 *
 * Memory is a note on the root commit (`refs/notes/origin-memory`, plus the
 * continuation brief). It travels with the repo, not with the account — but a
 * PR is commits + a diff, and a `git push` of a branch does not carry a notes
 * ref. Two things have to happen for memory written here to be visible to the
 * next agent AND to the people on the Memory tab:
 *
 *   1. push the notes refs themselves (pushMemoryNotes, payload-level merge on
 *      a non-fast-forward);
 *   2. tell the server the ref moved. GitHub and GitLab deliver push webhooks
 *      for branches and tags only, never for `refs/notes/*`, so the server has
 *      no other way to learn that memory changed until the next BRANCH push —
 *      and a repo without the GitHub App installed never hears at all.
 *
 * Every writer of memory (session end, the brief refresh, pre-push,
 * `origin sync`) goes through here so the two steps cannot drift apart.
 * Best-effort throughout: nothing in here may fail a hook.
 */
import { execFileSync } from 'child_process';
import { api } from './api.js';
import { isConnectedMode } from './config.js';
import { debugLog } from './debug-log.js';
import { pushMemoryNotes, resolvePushRemote, shouldIncludePromptText } from './git-notes.js';
import { getCanonicalRepoPath } from './session-state.js';

/** Hooks run in front of the user; the server call must never be the slow part. */
export const MEMORY_REFRESH_TIMEOUT_MS = 4_000;

export interface MemoryRefreshSummary {
  sessions: number;
  commits: number;
  brief: boolean;
}

/** The remote's URL, as the server's repo resolver wants it. */
export function remoteUrlFor(repoPath: string, remote: string): string | undefined {
  try {
    const url = execFileSync('git', ['remote', 'get-url', remote], {
      windowsHide: true, cwd: repoPath, stdio: 'pipe', timeout: 5_000, encoding: 'utf-8',
    }).trim();
    return url || undefined;
  } catch {
    return undefined;
  }
}

/**
 * Ask the server to re-read this repo's memory notes off the git host.
 * Resolves to what it imported, or null when standalone, unreachable, the repo
 * is not registered, or the host has no memory notes yet.
 */
export async function notifyRepoMemoryChanged(
  repoPath: string,
  source: string,
  opts: { remote?: string; timeoutMs?: number } = {},
): Promise<MemoryRefreshSummary | null> {
  if (!isConnectedMode()) return null;
  const remote = opts.remote || resolvePushRemote(repoPath);
  const repoUrl = remote ? remoteUrlFor(repoPath, remote) : undefined;
  // The server knows the repo by its MAIN checkout path (plus the remote URL);
  // hooks run from whatever worktree the agent is in.
  const canonicalPath = getCanonicalRepoPath(repoPath);
  try {
    const res = await api.refreshRepoMemory({ repoPath: canonicalPath, repoUrl }, opts.timeoutMs ?? MEMORY_REFRESH_TIMEOUT_MS) as {
      memory?: MemoryRefreshSummary | null;
      /** Why the server could not read the notes it was just told about —
       *  a token that cannot see the repo, no host connection. Logged so
       *  hooks.log answers "the CLI pushed, why is the tab empty?". */
      error?: string | null;
    } | null;
    const memory = res?.memory ?? null;
    debugLog(source, 'server memory refresh', memory ? { ...memory } : { memory: null, error: res?.error ?? null });
    return memory;
  } catch (err: any) {
    debugLog(source, 'server memory refresh skipped', { message: err?.message });
    return null;
  }
}

export interface PublishMemoryResult {
  /** A push was attempted. False: privacy switch off, no remote, or the push failed. */
  pushed: boolean;
  /** What the server imported afterwards; null when not pushed, standalone, or unreachable. */
  memory: MemoryRefreshSummary | null;
}

/**
 * Push the memory notes, then tell the server. The privacy switch off, or no
 * remote, means nothing left the machine — so the server is not bothered either.
 */
export async function publishMemoryNotes(
  repoPath: string,
  source: string,
  opts: { timeoutMs?: number } = {},
): Promise<PublishMemoryResult> {
  if (!shouldIncludePromptText(repoPath)) return { pushed: false, memory: null };
  let remote = '';
  try {
    remote = resolvePushRemote(repoPath);
  } catch {
    remote = '';
  }
  if (!remote) return { pushed: false, memory: null };
  try {
    pushMemoryNotes(repoPath, remote);
    debugLog(source, 'pushed memory notes');
  } catch (err: any) {
    debugLog(source, 'memory notes push skipped', { message: err?.message });
    return { pushed: false, memory: null };
  }
  const memory = await notifyRepoMemoryChanged(repoPath, source, { remote, timeoutMs: opts.timeoutMs });
  return { pushed: true, memory };
}
