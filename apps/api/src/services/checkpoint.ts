import fs from 'fs';
import path from 'path';
import { prisma } from '../db.js';
import { simpleGit } from 'simple-git';
import {
  parseGitHubUrl,
  fetchGitHubCommits,
  fetchEntireCheckpoints,
  fetchFileContent,
} from './github.js';
import { getIntegrationConfig } from './github-integration.js';
import {
  getGitLabIntegrationConfig,
  getValidGitLabToken,
  parseGitLabProjectPath,
} from './gitlab-integration.js';
import { detectAITool } from './ai-commit-detector.js';

// Cap transcript size at ingest. Checkpoints come from the CLI (or a
// mirrored checkpoint file on disk), which is trusted in principle but
// must not let a single runaway session write a 500MB row. The cap is
// applied both to JSON byte length and to entry count: a huge array of
// tiny messages is just as expensive as one giant message.
const MAX_TRANSCRIPT_JSON_BYTES = 2 * 1024 * 1024; // 2MB
const MAX_TRANSCRIPT_ENTRIES = 5000;
function safeTranscriptJson(t: unknown): string {
  const arr = Array.isArray(t) ? t.slice(0, MAX_TRANSCRIPT_ENTRIES) : [];
  const s = JSON.stringify(arr);
  if (s.length <= MAX_TRANSCRIPT_JSON_BYTES) return s;
  // Fall back to a truncated tail — the most recent messages are the
  // most useful when debugging why a session ended.
  const half = Math.floor(arr.length / 2);
  return JSON.stringify(arr.slice(-half));
}

interface Checkpoint {
  commitSha: string;
  message: string;
  author: string;
  committedAt: string;
  model: string;
  prompt: string;
  transcript: Array<{ role: string; content: string }>;
  filesChanged: string[];
  tokensUsed: number;
  toolCalls: number;
  durationMs: number;
  linesAdded?: number;
  linesRemoved?: number;
  costUsd?: number;
}

// ─── Main entry point ──────────────────────────────────────────────────────

export async function syncCheckpoints(repo: { id: string; path: string; provider: string; orgId: string }) {
  let result: { synced: number; total: number; statsEnriched?: number };
  // Resolve the effective provider for sync. If the repo was imported as
  // github/gitlab but the org never connected (or later disconnected) the
  // matching integration, we can't call the provider API — fall through to
  // the local path so the sync still runs backlink + stats enrichment on
  // whatever is already in the DB (commits pushed up by the CLI, etc).
  let effective: 'github' | 'gitlab' | 'local' = 'local';
  if (repo.provider === 'github') {
    const integ = await getIntegrationConfig(repo.orgId).catch(() => null);
    if (integ) effective = 'github';
  } else if (repo.provider === 'gitlab') {
    const integ = await getGitLabIntegrationConfig(repo.orgId).catch(() => null);
    if (integ) effective = 'gitlab';
  }

  if (effective === 'github') {
    result = await syncGitHubRepo(repo);
  } else if (effective === 'gitlab') {
    result = await syncGitLabRepo(repo);
  } else {
    result = await syncLocalRepo(repo);
  }
  // Backlink commits to existing Origin sessions via SessionDiff.commitShas
  try {
    const linked = await backlinkCommitsToSessions(repo.id, repo.orgId);
    return { ...result, sessionsLinked: linked };
  } catch (e) {
    console.error('backlinkCommitsToSessions failed:', e);
    return result;
  }
}

/**
 * For commits in this repo that don't yet have a session FK, search the org's
 * SessionDiff records for any that contain this commit's SHA in their
 * commitShas JSON array. When a match is found, set commit.sessionId and
 * populate aiToolDetected from the session's agent/model.
 *
 * This handles the case where a dev uses Origin locally (which writes
 * SessionDiff.commitShas), then pushes to GitHub/GitLab — the sync grabs the
 * commits from the provider API, and this pass stitches them back together.
 */
async function backlinkCommitsToSessions(repoId: string, orgId: string): Promise<number> {
  // Cap per-sync at 50k commits to stitch; reruns pick up the tail.
  const unlinked = await prisma.commit.findMany({
    where: { repoId, sessionId: null },
    take: 50_000,
    orderBy: { committedAt: 'desc' },
    select: {
      id: true,
      sha: true,
      author: true,
      committedAt: true,
      aiToolDetected: true,
    },
  });
  if (unlinked.length === 0) return 0;

  let linked = 0;

  // Tier 1 — SHA match via SessionDiff.commitShas (most precise).
  // Cap sessionDiffs we scan to avoid OOM on huge histories; reruns pick up the tail.
  const diffs = await prisma.sessionDiff.findMany({
    where: {
      session: { commit: { repo: { orgId } } },
    },
    take: 50_000,
    orderBy: { id: 'desc' },
    select: {
      sessionId: true,
      commitShas: true,
      session: {
        select: {
          id: true,
          model: true,
          agent: { select: { name: true } },
        },
      },
    },
  });

  // Build a SHA → session Map for O(1) lookup (previously O(n·m)).
  const shaToSession = new Map<string, typeof diffs[number]['session']>();
  for (const d of diffs) {
    if (!d.commitShas || !d.session) continue;
    let shas: string[] = [];
    try { shas = JSON.parse(d.commitShas); } catch { continue; }
    if (!Array.isArray(shas)) continue;
    for (const sha of shas) {
      if (typeof sha === 'string' && !shaToSession.has(sha)) {
        shaToSession.set(sha, d.session);
      }
    }
  }

  const stillUnlinked: typeof unlinked = [];
  for (const c of unlinked) {
    const match = shaToSession.get(c.sha);
    if (!match) {
      stillUnlinked.push(c);
      continue;
    }
    const tool = match.agent?.name?.toLowerCase() || match.model || 'ai';
    await prisma.commit.update({
      where: { id: c.id },
      data: {
        sessionId: match.id,
        aiToolDetected: tool,
        aiDetectionMethod: 'session-diff-link',
      },
    });
    linked++;
  }

  // Tier 2 — Author email + time window fuzzy match.
  // If the commit author matches an Origin user in the org and a CodingSession
  // by that user overlaps the commit time (±6h), consider it a candidate.
  // This catches cases where Origin ran locally but didn't capture the final
  // SHA (e.g. amend/rebase) or the commitShas array wasn't populated.
  if (stillUnlinked.length > 0) {
    const users = await prisma.user.findMany({
      where: { orgId },
      select: { id: true, email: true, name: true },
    });
    const userByKey = new Map<string, { id: string; email: string; name: string | null }>();
    for (const u of users) {
      if (u.email) userByKey.set(u.email.toLowerCase(), u);
      if (u.name) userByKey.set(u.name.toLowerCase(), u);
    }

    for (const c of stillUnlinked) {
      const authorKey = (c.author || '').toLowerCase();
      const user = userByKey.get(authorKey);
      if (!user) continue;

      const windowMs = 6 * 60 * 60 * 1000;
      const commitTime = c.committedAt.getTime();
      const from = new Date(commitTime - windowMs);
      const to = new Date(commitTime + windowMs);

      const sessions = await prisma.codingSession.findMany({
        where: {
          userId: user.id,
          OR: [
            { startedAt: { gte: from, lte: to } },
            { endedAt: { gte: from, lte: to } },
            { AND: [{ startedAt: { lte: from } }, { endedAt: { gte: to } }] },
          ],
        },
        select: {
          id: true,
          model: true,
          startedAt: true,
          endedAt: true,
          agent: { select: { name: true } },
        },
        orderBy: { startedAt: 'desc' },
        take: 5,
      });

      if (sessions.length === 0) continue;
      // Pick the session closest to commit time
      const best = sessions.reduce((prev, s) => {
        const sTime = (s.endedAt || s.startedAt || new Date()).getTime();
        const prevTime = (prev.endedAt || prev.startedAt || new Date()).getTime();
        return Math.abs(sTime - commitTime) < Math.abs(prevTime - commitTime) ? s : prev;
      });

      const tool = best.agent?.name?.toLowerCase() || best.model || 'ai';
      await prisma.commit.update({
        where: { id: c.id },
        data: {
          sessionId: best.id,
          aiToolDetected: tool,
          aiDetectionMethod: 'author-time-window',
        },
      });
      linked++;
    }
  }

  return linked;
}

// ─── GitLab sync ───────────────────────────────────────────────────────────

async function syncGitLabRepo(repo: { id: string; path: string; orgId: string }) {
  const projectPath = parseGitLabProjectPath(repo.path);
  if (!projectPath) {
    console.error(`Invalid GitLab URL: ${repo.path}`);
    return { synced: 0, total: 0 };
  }

  const integration = await getGitLabIntegrationConfig(repo.orgId);
  if (!integration) {
    console.error('No GitLab integration configured for this org');
    return { synced: 0, total: 0 };
  }

  let token: string | null = null;
  try {
    const result = await getValidGitLabToken(integration as any);
    token = result?.token || null;
  } catch (err) {
    console.error('Failed to resolve GitLab token:', err);
  }
  if (!token) {
    console.error('GitLab sync: no valid token available');
    return { synced: 0, total: 0 };
  }

  const apiBase = (integration as any).apiBaseUrl || 'https://gitlab.com/api/v4';
  const encodedPath = encodeURIComponent(projectPath);
  const headers: Record<string, string> = {
    'PRIVATE-TOKEN': token, // works for PAT
    Authorization: `Bearer ${token}`, // works for OAuth
    'User-Agent': 'Origin-App',
  };

  // Paginate through commits using GitLab's Link header pagination
  const MAX_PAGES = 20; // up to 2000 commits per sync
  const collected: Array<{ sha: string; message: string; author: string; date: string }> = [];
  try {
    for (let page = 1; page <= MAX_PAGES; page++) {
      const url = `${apiBase}/projects/${encodedPath}/repository/commits?per_page=100&page=${page}&all=true`;
      const res = await fetch(url, { headers });
      if (!res.ok) {
        if (res.status === 404) break;
        const body = await res.text().catch(() => '');
        console.error(`GitLab API error ${res.status}: ${body.slice(0, 300)}`);
        break;
      }
      const data = await res.json() as any[];
      if (!Array.isArray(data) || data.length === 0) break;
      for (const c of data) {
        collected.push({
          sha: c.id,
          message: c.message || c.title || '',
          author: c.author_name || 'unknown',
          date: c.committed_date || c.created_at || new Date().toISOString(),
        });
      }
      if (data.length < 100) break;
    }
  } catch (err) {
    console.error('Failed to fetch commits from GitLab:', err);
  }

  if (collected.length === 0) return { synced: 0, total: 0 };

  // Bulk-check existing SHAs — pull message too so we know which need repair
  const existingRows = await prisma.commit.findMany({
    where: { repoId: repo.id, sha: { in: collected.map((c) => c.sha) } },
    select: { sha: true, additions: true, message: true, aiToolDetected: true },
  });
  const existing = new Map(existingRows.map((r) => [r.sha, r]));

  // Helper: a message is "poor" if empty, whitespace, or a single-char placeholder
  const isPoorMessage = (m: string | null | undefined) => {
    if (!m) return true;
    const t = m.trim();
    return t.length < 3;
  };

  // Enrich new commits (and ones missing stats) with per-commit stats
  const STAT_CAP = 200;
  const STAT_CONCURRENCY = 5;
  let statsEnriched = 0;

  async function enrichCommit(sha: string): Promise<{ additions: number; deletions: number; fileCount: number } | null> {
    try {
      // Single call returns stats + diff file count via ?stats=true (GitLab default)
      const res = await fetch(
        `${apiBase}/projects/${encodedPath}/repository/commits/${sha}?stats=true`,
        { headers },
      );
      if (!res.ok) return null;
      const data = await res.json() as any;
      const stats = data.stats || {};

      // Optional: fetch diff for file count (separate endpoint in GitLab)
      let fileCount = 0;
      try {
        const diffRes = await fetch(
          `${apiBase}/projects/${encodedPath}/repository/commits/${sha}/diff?per_page=100`,
          { headers },
        );
        if (diffRes.ok) {
          const diffs = await diffRes.json() as any[];
          if (Array.isArray(diffs)) fileCount = diffs.length;
        }
      } catch {/* ignore */}

      return {
        additions: stats.additions ?? 0,
        deletions: stats.deletions ?? 0,
        fileCount,
      };
    } catch {
      return null;
    }
  }

  // Process commits that are new OR need message/stats repair
  const toProcess = collected.filter((c) => {
    const ex = existing.get(c.sha);
    if (!ex) return true;
    if (ex.additions == null) return true;
    if (isPoorMessage(ex.message) && !isPoorMessage(c.message)) return true;
    return false;
  });

  let synced = 0;
  let messagesRepaired = 0;
  for (let i = 0; i < toProcess.length; i += STAT_CONCURRENCY) {
    const batch = toProcess.slice(i, i + STAT_CONCURRENCY);
    const stats = await Promise.all(
      batch.map((c) => {
        const ex = existing.get(c.sha);
        const needsStats = !ex || ex.additions == null;
        return needsStats && statsEnriched < STAT_CAP ? enrichCommit(c.sha) : Promise.resolve(null);
      })
    );

    for (let j = 0; j < batch.length; j++) {
      const entry = batch[j];
      const stat = stats[j];
      if (stat) statsEnriched++;

      const detection = detectAITool(entry.message, entry.author);
      const baseData = {
        message: entry.message,
        author: entry.author,
        aiToolDetected: detection.aiToolDetected,
        aiDetectionMethod: detection.aiDetectionMethod,
        committedAt: new Date(entry.date),
        ...(stat ? { additions: stat.additions, deletions: stat.deletions, fileCount: stat.fileCount } : {}),
      };

      const ex = existing.get(entry.sha);
      if (!ex) {
        await prisma.commit.create({
          data: { repoId: repo.id, sha: entry.sha, ...baseData },
        });
        synced++;
      } else {
        const updateData: any = {};
        if (stat) {
          updateData.additions = stat.additions;
          updateData.deletions = stat.deletions;
          updateData.fileCount = stat.fileCount;
        }
        // Heal poor messages from the API response
        if (isPoorMessage(ex.message) && !isPoorMessage(entry.message)) {
          updateData.message = entry.message;
          updateData.author = entry.author;
          messagesRepaired++;
          // Re-run AI detection now that we have a real message
          if (!ex.aiToolDetected && detection.aiToolDetected) {
            updateData.aiToolDetected = detection.aiToolDetected;
            updateData.aiDetectionMethod = detection.aiDetectionMethod;
          }
        }
        if (Object.keys(updateData).length > 0) {
          await prisma.commit.updateMany({
            where: { repoId: repo.id, sha: entry.sha },
            data: updateData,
          });
        }
      }
    }
  }

  return { synced, total: collected.length, statsEnriched, messagesRepaired };
}

// ─── GitHub sync ───────────────────────────────────────────────────────────

async function syncGitHubRepo(repo: { id: string; path: string; orgId: string }) {
  const parsed = parseGitHubUrl(repo.path);
  if (!parsed) {
    console.error(`Invalid GitHub URL: ${repo.path}`);
    return { synced: 0, total: 0 };
  }

  const { owner, repo: repoName } = parsed;
  console.log(`Syncing GitHub repo: ${owner}/${repoName}`);

  // 1. Check for .entire/ checkpoints (real session data from Entire CLI)
  const entireFiles = await fetchEntireCheckpoints(owner, repoName);
  if (entireFiles.length > 0) {
    return syncGitHubEntireDir(repo, entireFiles);
  }

  // 2. Fetch real commit history (no fake sessions)
  return syncGitHubCommits(repo, owner, repoName);
}

async function syncGitHubEntireDir(
  repo: { id: string },
  files: Array<{ name: string; download_url: string | null }>
) {
  let synced = 0;
  for (const file of files) {
    if (!file.download_url) continue;
    try {
      const raw = await fetchFileContent(file.download_url);
      const checkpoint: Checkpoint = JSON.parse(raw);

      const existing = await prisma.commit.findFirst({
        where: { repoId: repo.id, sha: checkpoint.commitSha },
      });
      if (existing) continue;

      await prisma.commit.create({
        data: {
          repoId: repo.id,
          sha: checkpoint.commitSha,
          message: checkpoint.message,
          author: checkpoint.author,
          aiToolDetected: checkpoint.model,
          aiDetectionMethod: 'session',
          committedAt: new Date(checkpoint.committedAt),
          session: {
            create: {
              model: checkpoint.model,
              prompt: checkpoint.prompt,
              transcript: safeTranscriptJson(checkpoint.transcript),
              filesChanged: JSON.stringify(checkpoint.filesChanged),
              tokensUsed: checkpoint.tokensUsed,
              toolCalls: checkpoint.toolCalls,
              durationMs: checkpoint.durationMs,
              linesAdded: checkpoint.linesAdded ?? 0,
              linesRemoved: checkpoint.linesRemoved ?? 0,
              costUsd: checkpoint.costUsd ?? 0,
            },
          },
        },
      });
      synced++;
    } catch (err) {
      console.error(`Failed to process checkpoint ${file.name}:`, err);
    }
  }
  return { synced, total: files.length };
}

async function syncGitHubCommits(
  repo: { id: string; orgId: string },
  owner: string,
  repoName: string,
  opts: { deep?: boolean; maxPages?: number; enrichStats?: boolean } = {}
) {
  const deep = opts.deep ?? true;
  const maxPages = opts.maxPages ?? 20;          // 20 pages * 100 = up to 2000 commits per sync
  const enrichStats = opts.enrichStats ?? true;

  const integration = await getIntegrationConfig(repo.orgId, 'github');
  const apiBase = integration?.apiBaseUrl || 'https://api.github.com';
  const headers: Record<string, string> = {
    Accept: 'application/vnd.github.v3+json',
    'User-Agent': 'Origin-App',
  };
  if (integration?.token) {
    headers.Authorization = `Bearer ${integration.token}`;
  } else if (process.env.GITHUB_TOKEN) {
    headers.Authorization = `Bearer ${process.env.GITHUB_TOKEN}`;
  }

  // Paginate through all commits
  const collected: Array<{ sha: string; message: string; author: string; date: string }> = [];
  try {
    const pageCount = deep ? maxPages : 1;
    for (let page = 1; page <= pageCount; page++) {
      const res = await fetch(
        `${apiBase}/repos/${owner}/${repoName}/commits?per_page=100&page=${page}`,
        { headers }
      );
      if (!res.ok) {
        if (res.status === 404 || res.status === 409) break; // empty repo / no more
        throw new Error(`GitHub API error: ${res.status}`);
      }
      const data = await res.json() as any[];
      if (!Array.isArray(data) || data.length === 0) break;
      for (const c of data) {
        collected.push({
          sha: c.sha,
          message: c.commit?.message || '',
          author: c.commit?.author?.name || 'unknown',
          date: c.commit?.author?.date || new Date().toISOString(),
        });
      }
      if (data.length < 100) break; // last page
    }
  } catch (err) {
    console.error(`Failed to fetch commits from GitHub:`, err);
    if (collected.length === 0) return { synced: 0, total: 0 };
  }

  let synced = 0;
  // Fetch existing SHAs in one query for efficiency
  const existingRows = await prisma.commit.findMany({
    where: { repoId: repo.id, sha: { in: collected.map((c) => c.sha) } },
    select: { sha: true, additions: true },
  });
  const existing = new Map(existingRows.map((r) => [r.sha, r]));

  // Concurrency-limited stat enrichment (avoid GitHub rate limits)
  const STAT_CONCURRENCY = 5;
  const STAT_CAP = 200; // cap per-sync enrichment to avoid exhausting rate limits
  let statsEnriched = 0;

  async function enrichCommit(sha: string): Promise<{ additions: number; deletions: number; fileCount: number } | null> {
    try {
      const res = await fetch(`${apiBase}/repos/${owner}/${repoName}/commits/${sha}`, { headers });
      if (!res.ok) return null;
      const data = await res.json() as any;
      return {
        additions: data.stats?.additions ?? 0,
        deletions: data.stats?.deletions ?? 0,
        fileCount: Array.isArray(data.files) ? data.files.length : 0,
      };
    } catch {
      return null;
    }
  }

  // Only process commits that are new OR missing stats
  const toProcess = collected.filter((c) => {
    const ex = existing.get(c.sha);
    return !ex || ex.additions == null;
  });

  // Chunk for limited parallelism on stat fetches
  for (let i = 0; i < toProcess.length; i += STAT_CONCURRENCY) {
    const batch = toProcess.slice(i, i + STAT_CONCURRENCY);

    const stats = await Promise.all(
      batch.map((c) =>
        enrichStats && statsEnriched < STAT_CAP ? enrichCommit(c.sha) : Promise.resolve(null)
      )
    );

    for (let j = 0; j < batch.length; j++) {
      const entry = batch[j];
      const stat = stats[j];
      if (stat) statsEnriched++;

      const detection = detectAITool(entry.message, entry.author);
      const baseData = {
        message: entry.message,
        author: entry.author,
        aiToolDetected: detection.aiToolDetected,
        aiDetectionMethod: detection.aiDetectionMethod,
        committedAt: new Date(entry.date),
        ...(stat ? { additions: stat.additions, deletions: stat.deletions, fileCount: stat.fileCount } : {}),
      };

      if (!existing.has(entry.sha)) {
        await prisma.commit.create({
          data: {
            repoId: repo.id,
            sha: entry.sha,
            ...baseData,
          },
        });
        synced++;
      } else if (stat) {
        // Backfill stats on existing row
        await prisma.commit.updateMany({
          where: { repoId: repo.id, sha: entry.sha },
          data: { additions: stat.additions, deletions: stat.deletions, fileCount: stat.fileCount },
        });
      }
    }
  }

  return { synced, total: collected.length, statsEnriched };
}

// ─── Local sync ────────────────────────────────────────────────────────────

async function syncLocalRepo(repo: { id: string; path: string }) {
  // On the cloud deployment the server has no access to the user's
  // working tree, so filesystem paths never resolve — any commit/session
  // data for "local" repos has already been pushed up via the CLI's
  // checkpoint ingest or the webhook flow. In that environment, "sync"
  // means: recount what's in the DB and let the outer syncCheckpoints
  // wrapper run backlinkCommitsToSessions + stats enrichment. Returning
  // { synced: 0, total: <current> } gives the UI a truthful "Up to date"
  // message instead of the misleading "No commits" it used to show.
  //
  // When Origin is self-hosted with a real checkout on disk we still
  // want the old behavior: read .entire/ or git log and import new
  // checkpoints. So we only short-circuit when the path doesn't exist.
  if (!fs.existsSync(repo.path)) {
    const total = await prisma.commit.count({ where: { repoId: repo.id } });
    return { synced: 0, total };
  }

  const entireDir = path.join(repo.path, '.entire');
  const hasEntire = fs.existsSync(entireDir);

  if (hasEntire) {
    return syncFromEntireDir(repo, entireDir);
  }
  return syncFromGitLog(repo);
}

async function syncFromEntireDir(repo: { id: string; path: string }, entireDir: string) {
  let synced = 0;
  const files = fs.readdirSync(entireDir).filter((f) => f.endsWith('.json'));

  for (const file of files) {
    try {
      const raw = fs.readFileSync(path.join(entireDir, file), 'utf-8');
      const checkpoint: Checkpoint = JSON.parse(raw);

      const existing = await prisma.commit.findFirst({
        where: { repoId: repo.id, sha: checkpoint.commitSha },
      });
      if (existing) continue;

      await prisma.commit.create({
        data: {
          repoId: repo.id,
          sha: checkpoint.commitSha,
          message: checkpoint.message,
          author: checkpoint.author,
          aiToolDetected: checkpoint.model,
          aiDetectionMethod: 'session',
          committedAt: new Date(checkpoint.committedAt),
          session: {
            create: {
              model: checkpoint.model,
              prompt: checkpoint.prompt,
              transcript: safeTranscriptJson(checkpoint.transcript),
              filesChanged: JSON.stringify(checkpoint.filesChanged),
              tokensUsed: checkpoint.tokensUsed,
              toolCalls: checkpoint.toolCalls,
              durationMs: checkpoint.durationMs,
              linesAdded: checkpoint.linesAdded ?? 0,
              linesRemoved: checkpoint.linesRemoved ?? 0,
              costUsd: checkpoint.costUsd ?? 0,
            },
          },
        },
      });
      synced++;
    } catch (err) {
      // Skip malformed checkpoints, but surface *why* — the old silent
      // catch hid JSON schema drift, disk corruption, and partial writes
      // from the ingest path. The file name is enough to let an operator
      // reproduce locally without leaking payload content to logs.
      console.error('[checkpoint] failed to import file', {
        repoId: repo.id,
        file,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
  return { synced, total: files.length };
}

async function syncFromGitLog(repo: { id: string; path: string }) {
  const git = simpleGit(repo.path);
  let log;
  try {
    log = await git.log({ maxCount: 1000 });
  } catch {
    return { synced: 0, total: 0 };
  }

  // Parse per-commit stats from `git log --numstat` in a single call.
  const statsBySha = new Map<string, { additions: number; deletions: number; fileCount: number }>();
  try {
    const raw = await git.raw([
      'log',
      '--max-count=1000',
      '--numstat',
      '--pretty=format:__COMMIT__%H',
    ]);
    let currentSha = '';
    let cur = { additions: 0, deletions: 0, fileCount: 0 };
    for (const line of raw.split('\n')) {
      if (line.startsWith('__COMMIT__')) {
        if (currentSha) statsBySha.set(currentSha, cur);
        currentSha = line.slice('__COMMIT__'.length).trim();
        cur = { additions: 0, deletions: 0, fileCount: 0 };
      } else if (line.trim()) {
        const parts = line.split('\t');
        if (parts.length >= 3) {
          const add = parseInt(parts[0], 10);
          const del = parseInt(parts[1], 10);
          if (!isNaN(add)) cur.additions += add;
          if (!isNaN(del)) cur.deletions += del;
          cur.fileCount += 1;
        }
      }
    }
    if (currentSha) statsBySha.set(currentSha, cur);
  } catch {
    // numstat failed — fall back to no stats
  }

  let synced = 0;
  for (const entry of log.all) {
    const existing = await prisma.commit.findFirst({
      where: { repoId: repo.id, sha: entry.hash },
    });
    const stats = statsBySha.get(entry.hash);

    // Concatenate first line + body for full message (simple-git splits them)
    const fullMessage = (entry as any).body
      ? `${entry.message}\n\n${(entry as any).body}`
      : entry.message;

    if (existing) {
      // Backfill stats if missing
      if (stats && (existing as any).additions == null) {
        await prisma.commit.update({
          where: { id: existing.id },
          data: {
            additions: stats.additions,
            deletions: stats.deletions,
            fileCount: stats.fileCount,
          },
        });
      }
      continue;
    }

    // Create commit record with AI detection
    const detection = detectAITool(fullMessage, entry.author_name);
    await prisma.commit.create({
      data: {
        repoId: repo.id,
        sha: entry.hash,
        message: fullMessage,
        author: entry.author_name,
        aiToolDetected: detection.aiToolDetected,
        aiDetectionMethod: detection.aiDetectionMethod,
        committedAt: new Date(entry.date),
        ...(stats ? { additions: stats.additions, deletions: stats.deletions, fileCount: stats.fileCount } : {}),
      },
    });
    synced++;
  }

  return { synced, total: log.all.length };
}
