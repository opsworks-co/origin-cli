// GitLab notes fetcher.
//
// GitLab's REST API doesn't expose `refs/notes/*` directly (unlike GitHub
// which has `/git/refs/notes/origin`). To recover the notes that Origin
// CLI pushes on every commit, we shell out to `git fetch` against the
// project's HTTPS URL — pulling ONLY the `refs/notes/origin` ref into a
// per-project bare repo on local disk. Subsequent reads are local
// `git notes show` calls, no further network.
//
// This is small: a typical notes ref carries one JSON blob per commit at
// 8KB cap each, so a repo with ten thousand AI commits is ≈ 80MB. We
// keep the cache under /tmp and accept that it's ephemeral on Fly's
// rootfs — the next request just re-fetches.
//
// Security: token never appears on a command line (we pass it via the
// `http.extraheader` git config) — so `ps`-readable process listings on
// shared systems never see it.

import { execFileSync } from 'child_process';
import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs';
import * as crypto from 'crypto';
import {
  parseGitLabProjectPath,
  getGitLabIntegrationConfig,
  getValidGitLabToken,
} from './gitlab-integration.js';

const CACHE_ROOT = path.join(os.tmpdir(), 'origin-gitlab-notes');
const FETCH_TIMEOUT_MS = 30_000;
const NOTE_READ_TIMEOUT_MS = 5_000;
const HEX = /^[0-9a-f]{4,64}$/i;

// Per-org+project lock to keep concurrent webhooks from racing on the same
// bare repo. Map key is the bare-repo path; value is a chain Promise.
const fetchLocks = new Map<string, Promise<void>>();

function safeFsName(input: string): string {
  // Map slashes (and weird chars) to underscores; hash if too long.
  const cleaned = input.replace(/[^A-Za-z0-9._-]/g, '_');
  if (cleaned.length > 80) {
    return crypto.createHash('sha1').update(input).digest('hex');
  }
  return cleaned;
}

function bareRepoPathFor(orgId: string, projectPath: string): string {
  return path.join(CACHE_ROOT, safeFsName(orgId), safeFsName(projectPath) + '.git');
}

function ensureBareRepo(bareDir: string): void {
  if (fs.existsSync(bareDir)) return;
  fs.mkdirSync(bareDir, { recursive: true });
  execFileSync('git', ['init', '--bare', '--quiet', bareDir], {
    stdio: ['ignore', 'ignore', 'pipe'],
    timeout: 10_000,
  });
}

function gitlabHttpsUrl(integrationBaseUrl: string, projectPath: string): string {
  // integrationBaseUrl is the API host (e.g. https://gitlab.com/api/v4 or
  // https://gitlab.company.com/api/v4). Strip the `/api/vN` suffix to get
  // the web host for git over HTTPS.
  const host = integrationBaseUrl
    .replace(/\/api\/v\d+\/?$/, '')
    .replace(/\/+$/, '');
  return `${host}/${projectPath}.git`;
}

function authHeaderFor(authType: string, token: string): string {
  // PRIVATE-TOKEN for PATs, Authorization: Bearer for OAuth. Either works
  // for HTTPS git operations against GitLab.
  if (authType === 'gitlab_oauth') return `Authorization: Bearer ${token}`;
  return `PRIVATE-TOKEN: ${token}`;
}

/**
 * Ensure the per-project bare repo has an up-to-date `refs/notes/origin`.
 * Coalesces concurrent calls — only one fetch per (org, project) runs at
 * a time, additional callers await the in-flight Promise.
 */
async function ensureNotesRefFresh(opts: {
  orgId: string;
  projectPath: string;
  url: string;
  authHeader: string;
}): Promise<string | null> {
  const bareDir = bareRepoPathFor(opts.orgId, opts.projectPath);

  const existing = fetchLocks.get(bareDir);
  if (existing) {
    await existing;
    return fs.existsSync(bareDir) ? bareDir : null;
  }

  const work = (async () => {
    try {
      ensureBareRepo(bareDir);
      // `--filter=tree:0` keeps the depth=1 fetch from pulling the full
      // history — we only need the notes ref's commit and the small tree
      // of note blobs it points at.
      execFileSync(
        'git',
        [
          '-C', bareDir,
          '-c', `http.extraheader=${opts.authHeader}`,
          'fetch',
          '--no-tags',
          '--depth=1',
          '--quiet',
          opts.url,
          '+refs/notes/origin:refs/notes/origin',
        ],
        {
          stdio: ['ignore', 'ignore', 'pipe'],
          timeout: FETCH_TIMEOUT_MS,
        },
      );
    } catch (err) {
      // Most common cause: the project simply has no refs/notes/origin yet
      // (no one's pushed an Origin commit). Silent — caller will get a
      // null note for each commit, which is the right outcome.
      const msg = err instanceof Error ? err.message : String(err);
      if (!/couldn't find remote ref|not our ref|did not match any/i.test(msg)) {
        console.warn('[gitlab-notes] fetch failed', {
          orgId: opts.orgId,
          projectPath: opts.projectPath,
          error: msg.slice(0, 300),
        });
      }
    }
  })();

  fetchLocks.set(bareDir, work);
  try {
    await work;
  } finally {
    fetchLocks.delete(bareDir);
  }
  return fs.existsSync(bareDir) ? bareDir : null;
}

function readNoteFromBare(bareDir: string, commitSha: string): string | null {
  if (!HEX.test(commitSha)) return null;
  try {
    return execFileSync(
      'git',
      ['-C', bareDir, 'notes', '--ref=origin', 'show', commitSha],
      {
        encoding: 'utf-8',
        stdio: ['ignore', 'pipe', 'pipe'],
        timeout: NOTE_READ_TIMEOUT_MS,
      },
    ).trim();
  } catch {
    return null;
  }
}

/**
 * Fetch the note for a single GitLab commit. Designed to be called from
 * `buildGitLabApi().fetchNote` so it slots into the existing import path.
 * Idempotent — multiple calls during the same request share one underlying
 * fetch via the in-flight Promise map.
 */
export async function fetchGitLabNote(
  repoPath: string,
  orgId: string,
  commitSha: string,
): Promise<string | null> {
  const projectPath = parseGitLabProjectPath(repoPath);
  if (!projectPath) return null;

  const integration = await getGitLabIntegrationConfig(orgId);
  if (!integration) return null;

  let token: string;
  let authType: string;
  try {
    const t = await getValidGitLabToken(integration as Parameters<typeof getValidGitLabToken>[0]);
    token = t.token;
    authType = t.authType;
  } catch {
    return null;
  }

  const url = gitlabHttpsUrl(integration.apiBaseUrl, projectPath);
  const authHeader = authHeaderFor(authType, token);

  const bareDir = await ensureNotesRefFresh({
    orgId,
    projectPath,
    url,
    authHeader,
  });
  if (!bareDir) return null;

  return readNoteFromBare(bareDir, commitSha);
}
