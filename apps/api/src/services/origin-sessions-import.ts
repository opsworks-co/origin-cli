import { prisma } from '../db.js';
import { getIntegrationConfig, parseRepoFullName } from './github-integration.js';
import { getGitLabIntegrationConfig, parseGitLabProjectPath, getValidGitLabToken } from './gitlab-integration.js';

// ── Types ──────────────────────────────────────────────────────────────────

interface SessionMetadata {
  version: 1;
  sessionId: string;
  model: string;
  startedAt: string;
  endedAt: string;
  durationMs: number;
  status: 'running' | 'ended';
  tokens: { total: number; input: number; output: number };
  cost: { usd: number };
  toolCalls: number;
  lines: { added: number; removed: number };
  filesChanged: string[];
  git: {
    branch?: string;
    headBefore: string;
    headAfter: string;
    commitShas: string[];
  };
  summary: string;
  originUrl?: string;
}

interface SessionChanges {
  version: 1;
  sessionId: string;
  changes: Array<{
    promptIndex: number;
    promptText: string;
    filesChanged: string[];
    diff: string;
  }>;
}

interface ImportResult {
  imported: number;
  skipped: number;
  total: number;
  message?: string;
  notesImported?: number;
}

// ── Provider abstraction ───────────────────────────────────────────────────
//
// Exposes just the two operations we need against the origin-sessions
// branch + git notes ref: list a tree, fetch a blob's contents, and
// fetch a single note. Implemented for GitHub and GitLab below; both
// fall back to unauthenticated public API access when no integration
// is configured (works for public repos).

interface TreeEntry {
  path: string;
  type: 'blob' | 'tree';
  sha?: string;          // GitHub uses sha; GitLab uses id
  id?: string;           // GitLab blob id
}

interface RepoApi {
  listTree(branch: string): Promise<TreeEntry[] | null>;
  fetchBlob(entry: TreeEntry): Promise<string | null>;
  fetchNote(commitSha: string): Promise<string | null>;
}

async function buildGitHubApi(repoPath: string, orgId: string): Promise<RepoApi | null> {
  const parsed = parseRepoFullName(repoPath);
  if (!parsed) return null;
  const integration = await getIntegrationConfig(orgId, 'github');
  const apiBase = integration?.apiBaseUrl || 'https://api.github.com';
  const token = integration?.token || process.env.GITHUB_TOKEN;
  const headers: Record<string, string> = {
    Accept: 'application/vnd.github.v3+json',
    'User-Agent': 'Origin-App',
  };
  if (token) headers.Authorization = `Bearer ${token}`;

  const listTree = async (branch: string): Promise<TreeEntry[] | null> => {
    try {
      const res = await fetch(
        `${apiBase}/repos/${parsed.owner}/${parsed.repo}/git/trees/${encodeURIComponent(branch)}?recursive=1`,
        { headers },
      );
      if (!res.ok) return null;
      const data = await res.json() as { tree?: any[] };
      return (data.tree || []).map((e) => ({
        path: e.path,
        type: e.type,
        sha: e.sha,
      }));
    } catch {
      return null;
    }
  };

  const fetchBlob = async (entry: TreeEntry): Promise<string | null> => {
    try {
      const sha = entry.sha;
      if (!sha) return null;
      const res = await fetch(
        `${apiBase}/repos/${parsed.owner}/${parsed.repo}/git/blobs/${sha}`,
        { headers },
      );
      if (!res.ok) return null;
      const data = await res.json() as { content?: string; encoding?: string };
      if (!data.content) return null;
      return Buffer.from(data.content, (data.encoding as BufferEncoding) || 'base64').toString('utf-8');
    } catch {
      return null;
    }
  };

  const fetchNote = async (commitSha: string): Promise<string | null> => {
    try {
      const refRes = await fetch(
        `${apiBase}/repos/${parsed.owner}/${parsed.repo}/git/refs/notes/origin`,
        { headers },
      );
      if (!refRes.ok) return null;
      const refData = await refRes.json() as { object?: { sha?: string } };
      const noteCommitSha = refData.object?.sha;
      if (!noteCommitSha) return null;

      const treeRes = await fetch(
        `${apiBase}/repos/${parsed.owner}/${parsed.repo}/git/commits/${noteCommitSha}`,
        { headers },
      );
      if (!treeRes.ok) return null;
      const commitData = await treeRes.json() as { tree?: { sha?: string } };
      const treeSha = commitData.tree?.sha;
      if (!treeSha) return null;

      // Notes can be stored as flat files (one per SHA) or fanned-out
      // (xx/yyyyyy). Walk recursively and look for entries matching the
      // commit SHA (full or fanned).
      const treeFullRes = await fetch(
        `${apiBase}/repos/${parsed.owner}/${parsed.repo}/git/trees/${treeSha}?recursive=1`,
        { headers },
      );
      if (!treeFullRes.ok) return null;
      const treeData = await treeFullRes.json() as { tree?: any[] };
      const entries = treeData.tree || [];
      const flatPath = commitSha.toLowerCase();
      const fanned = `${flatPath.slice(0, 2)}/${flatPath.slice(2)}`;
      const match = entries.find((e: any) => {
        const p = (e.path || '').toLowerCase();
        return p === flatPath || p === fanned || p.endsWith(`/${flatPath}`);
      });
      if (!match || !match.sha) return null;
      return await fetchBlob({ path: match.path, type: 'blob', sha: match.sha });
    } catch {
      return null;
    }
  };

  return { listTree, fetchBlob, fetchNote };
}

async function buildGitLabApi(repoPath: string, orgId: string): Promise<RepoApi | null> {
  const projectPath = parseGitLabProjectPath(repoPath);
  if (!projectPath) return null;
  const integration = await getGitLabIntegrationConfig(orgId);
  const apiBase = integration?.apiBaseUrl || 'https://gitlab.com/api/v4';

  let headers: Record<string, string> = {
    'User-Agent': 'Origin-App',
  };
  if (integration) {
    try {
      const tokenInfo = await getValidGitLabToken(integration as any);
      if (tokenInfo.authType === 'gitlab_oauth') {
        headers['Authorization'] = `Bearer ${tokenInfo.token}`;
      } else {
        headers['PRIVATE-TOKEN'] = tokenInfo.token;
      }
    } catch { /* fall back to unauthenticated public API */ }
  }

  const projectId = encodeURIComponent(projectPath);

  return {
    async listTree(branch: string) {
      try {
        // GitLab tree pagination — pull up to ~10k entries
        const all: TreeEntry[] = [];
        for (let page = 1; page <= 100; page++) {
          const res = await fetch(
            `${apiBase}/projects/${projectId}/repository/tree?ref=${encodeURIComponent(branch)}&recursive=true&per_page=100&page=${page}`,
            { headers },
          );
          if (!res.ok) {
            if (res.status === 404 && page === 1) return null;
            break;
          }
          const data = await res.json() as any[];
          if (!Array.isArray(data) || data.length === 0) break;
          for (const e of data) {
            all.push({
              path: e.path,
              type: e.type === 'tree' ? 'tree' : 'blob',
              id: e.id,
              sha: e.id,
            });
          }
          if (data.length < 100) break;
        }
        return all;
      } catch {
        return null;
      }
    },
    async fetchBlob(entry: TreeEntry) {
      try {
        // Use raw file endpoint — works for any blob path on the branch
        // GitLab's blob endpoint by SHA also works but path-based is simpler.
        const res = await fetch(
          `${apiBase}/projects/${projectId}/repository/files/${encodeURIComponent(entry.path)}/raw?ref=origin-sessions`,
          { headers },
        );
        if (!res.ok) return null;
        return await res.text();
      } catch {
        return null;
      }
    },
    async fetchNote(commitSha: string) {
      // GitLab does not expose refs/notes/* via its REST API the same way
      // GitHub does. We attempt to read it as a raw file from the notes
      // ref using the "files" API; if unavailable, return null and rely on
      // the origin-sessions branch as the source of truth.
      try {
        // Try fanned path on a hypothetical notes-tree branch (best-effort).
        // Real GitLab git-notes access requires a clone, which we avoid here.
        return null;
      } catch {
        return null;
      }
    },
  };
}

// ── Main entry point ───────────────────────────────────────────────────────

/**
 * Walk the `origin-sessions` branch on the repo's git host, parse each
 * `sessions/{sessionId}/{metadata,changes}.json`, and create matching
 * Commit/CodingSession/PromptChange/SessionDiff rows in this org.
 *
 * Idempotent — re-running skips sessions that already exist for this repo.
 * Works for GitHub and GitLab. For public repos, no integration token is
 * required (falls back to unauthenticated API).
 */
export async function importOriginSessionsFromGit(
  repoId: string,
  orgId: string,
): Promise<ImportResult> {
  const repo = await prisma.repo.findFirst({ where: { id: repoId, orgId } });
  if (!repo) {
    return { imported: 0, skipped: 0, total: 0, message: 'Repo not found' };
  }

  // Pick provider — explicit `provider` first, then sniff the path.
  const path = repo.path || '';
  let provider: 'github' | 'gitlab' | null = null;
  if (repo.provider === 'github') provider = 'github';
  else if (repo.provider === 'gitlab') provider = 'gitlab';
  else if (/github\.com\//.test(path)) provider = 'github';
  else if (/gitlab\.com\/|gitlab\./.test(path)) provider = 'gitlab';

  if (!provider) {
    return {
      imported: 0,
      skipped: 0,
      total: 0,
      message: 'Repo is not connected to GitHub or GitLab — cannot import session branch.',
    };
  }

  const api = provider === 'github'
    ? await buildGitHubApi(path, orgId)
    : await buildGitLabApi(path, orgId);

  if (!api) {
    return {
      imported: 0,
      skipped: 0,
      total: 0,
      message: `Could not parse repo path "${path}" for ${provider}.`,
    };
  }

  const tree = await api.listTree('origin-sessions');
  if (!tree) {
    return {
      imported: 0,
      skipped: 0,
      total: 0,
      message: 'No origin-sessions branch found on remote. Push it from the CLI first.',
    };
  }

  // Find every metadata.json under sessions/*/
  const metadataEntries = tree.filter(
    (e) => e.type === 'blob' && /^sessions\/[^/]+\/metadata\.json$/.test(e.path),
  );
  if (metadataEntries.length === 0) {
    return { imported: 0, skipped: 0, total: 0, message: 'No session files found.' };
  }

  // Pre-load existing session ids for this org so we can skip cheaply.
  const existing = await prisma.codingSession.findMany({
    where: { commit: { repo: { orgId } } },
    select: { id: true },
    take: 500_000,
    orderBy: { createdAt: 'desc' },
  });
  const existingIds = new Set(existing.map((s) => s.id));

  let imported = 0;
  let skipped = 0;
  const importedCommitShas = new Set<string>();

  for (const metaEntry of metadataEntries) {
    try {
      const metaText = await api.fetchBlob(metaEntry);
      if (!metaText) { skipped++; continue; }

      let meta: SessionMetadata;
      try {
        meta = JSON.parse(metaText);
      } catch { skipped++; continue; }

      if (!meta.sessionId) { skipped++; continue; }
      if (existingIds.has(meta.sessionId)) { skipped++; continue; }

      const dir = metaEntry.path.replace(/\/metadata\.json$/, '');
      const changesEntry = tree.find((e) => e.path === `${dir}/changes.json`);
      let changes: SessionChanges | null = null;
      if (changesEntry) {
        const changesText = await api.fetchBlob(changesEntry);
        if (changesText) {
          try { changes = JSON.parse(changesText); } catch { /* keep null */ }
        }
      }

      // Find or create the primary commit (first SHA, fallback to headAfter)
      const primarySha = meta.git?.commitShas?.[0] || meta.git?.headAfter || '';
      if (!primarySha) { skipped++; continue; }

      let commit = await prisma.commit.findFirst({
        where: { repoId, sha: primarySha },
      });
      if (!commit) {
        commit = await prisma.commit.create({
          data: {
            repoId,
            sha: primarySha,
            message: meta.summary || meta.git?.branch || 'AI session',
            author: 'ai-agent',
            aiToolDetected: meta.model || 'claude-code',
            aiDetectionMethod: 'session',
            committedAt: new Date(meta.endedAt || meta.startedAt || Date.now()),
            branch: meta.git?.branch || null,
          },
        });
      } else if (!commit.aiToolDetected) {
        await prisma.commit.update({
          where: { id: commit.id },
          data: {
            aiToolDetected: meta.model || 'claude-code',
            aiDetectionMethod: 'session',
          },
        });
      }
      importedCommitShas.add(primarySha);

      // Skip if a session already exists on this commit (race-safe)
      const sessionOnCommit = await prisma.codingSession.findUnique({
        where: { commitId: commit.id },
      });
      if (sessionOnCommit) { skipped++; continue; }

      const transcript = (changes?.changes || []).map((c) => ([
        { role: 'user' as const, content: c.promptText || '' },
        { role: 'assistant' as const, content: '' },
      ])).flat();

      const session = await prisma.codingSession.create({
        data: {
          id: meta.sessionId,
          commitId: commit.id,
          model: meta.model || 'unknown',
          prompt: changes?.changes?.[0]?.promptText || meta.summary || '',
          transcript: JSON.stringify(transcript),
          filesChanged: JSON.stringify(meta.filesChanged || []),
          tokensUsed: meta.tokens?.total || 0,
          inputTokens: meta.tokens?.input || 0,
          outputTokens: meta.tokens?.output || 0,
          toolCalls: meta.toolCalls || 0,
          durationMs: meta.durationMs || 0,
          linesAdded: meta.lines?.added || 0,
          linesRemoved: meta.lines?.removed || 0,
          costUsd: meta.cost?.usd || 0,
          status: meta.status === 'running' ? 'RUNNING' : 'COMPLETED',
          branch: meta.git?.branch || null,
          startedAt: meta.startedAt ? new Date(meta.startedAt) : null,
          endedAt: meta.endedAt ? new Date(meta.endedAt) : null,
        },
      });

      // Per-prompt records
      const promptChanges = changes?.changes || [];
      for (const c of promptChanges) {
        try {
          await prisma.promptChange.create({
            data: {
              sessionId: session.id,
              promptIndex: c.promptIndex ?? 0,
              promptText: (c.promptText || '').slice(0, 1000),
              filesChanged: JSON.stringify(c.filesChanged || []),
              diff: c.diff || '',
            },
          });
        } catch { /* unique-violation on retries — keep going */ }
      }

      // Session-level diff record (best effort)
      if (meta.git?.headBefore && meta.git?.headAfter) {
        try {
          await prisma.sessionDiff.create({
            data: {
              sessionId: session.id,
              headBefore: meta.git.headBefore,
              headAfter: meta.git.headAfter,
              commitShas: JSON.stringify(meta.git.commitShas || []),
              diff: '',
              linesAdded: meta.lines?.added || 0,
              linesRemoved: meta.lines?.removed || 0,
            },
          });
        } catch { /* already exists */ }
      }

      // Attach additional commits in the session
      for (const sha of (meta.git?.commitShas || []).slice(1)) {
        const exists = await prisma.commit.findFirst({ where: { repoId, sha } });
        if (!exists) {
          await prisma.commit.create({
            data: {
              repoId,
              sha,
              message: '',
              author: 'ai-agent',
              aiToolDetected: meta.model || 'claude-code',
              aiDetectionMethod: 'session',
              committedAt: new Date(meta.endedAt || meta.startedAt || Date.now()),
              sessionId: session.id,
              branch: meta.git?.branch || null,
            },
          });
        }
        importedCommitShas.add(sha);
      }

      existingIds.add(meta.sessionId);
      imported++;
    } catch (err) {
      console.error(`[origin-sessions-import] failed on ${metaEntry.path}:`, err);
      skipped++;
    }
  }

  // Best-effort: fetch git notes for imported commits and use them to fill
  // aiToolDetected on commits that the session import didn't touch (e.g.
  // legacy commits from before sessions were captured). GitHub only for
  // now — GitLab's REST API doesn't surface refs/notes/origin without a
  // clone.
  let notesImported = 0;
  if (provider === 'github') {
    const repoCommits = await prisma.commit.findMany({
      where: { repoId, OR: [{ aiToolDetected: null }, { aiToolDetected: '' }] },
      select: { id: true, sha: true },
      take: 500,
      orderBy: { committedAt: 'desc' },
    });
    for (const c of repoCommits) {
      try {
        const noteText = await api.fetchNote(c.sha);
        if (!noteText) continue;
        let parsed: any = null;
        try { parsed = JSON.parse(noteText); } catch { continue; }
        const o = parsed?.origin;
        if (!o) continue;
        await prisma.commit.update({
          where: { id: c.id },
          data: {
            aiToolDetected: o.model || 'claude-code',
            aiDetectionMethod: 'git-notes',
          },
        });
        notesImported++;
      } catch { /* best-effort */ }
    }
  }

  return {
    imported,
    skipped,
    total: metadataEntries.length,
    notesImported,
  };
}
