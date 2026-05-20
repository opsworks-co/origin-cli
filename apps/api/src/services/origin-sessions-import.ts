import { prisma } from '../db.js';
import { getIntegrationConfig, parseRepoFullName } from './github-integration.js';
import { getGitLabIntegrationConfig, parseGitLabProjectPath, getValidGitLabToken } from './gitlab-integration.js';
import { fetchGitLabNote } from './gitlab-notes.js';

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
  virtualSessionsCreated?: number;
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
      // GitLab doesn't expose `refs/notes/*` via REST. Fall back to a
      // shallow `git fetch refs/notes/origin` into a per-project bare repo
      // on local disk, then read the note via `git notes show`. The bare
      // repo is reused across calls; concurrent requests coalesce on a
      // single fetch via an in-flight Promise map in gitlab-notes.ts.
      return fetchGitLabNote(repoPath, orgId, commitSha);
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
  // legacy commits from before sessions were captured).
  //
  // Also synthesize a virtual CodingSession from each note's prompt
  // payload so cross-org commits surface prompts in AI Blame / Ask /
  // commit-detail even when Origin wasn't recording the original session.
  // Marked with `apiKeyName = GIT_NOTE_VIRTUAL_MARKER` so analytics
  // aggregators can exclude them from spend/session counts.
  //
  // GitLab path uses gitlab-notes.ts (shallow `git fetch refs/notes/origin`
  // into a per-project bare repo) since GitLab's REST API doesn't surface
  // `refs/notes/*` directly.
  let notesImported = 0;
  let virtualSessionsCreated = 0;
  if (provider === 'github' || provider === 'gitlab') {
    const repo = await prisma.repo.findUnique({
      where: { id: repoId },
      select: { orgId: true },
    });
    if (!repo) {
      return { imported, skipped, total: metadataEntries.length, notesImported };
    }

    // Two queries — commits that need aiToolDetected, and commits that have
    // it but no linked session. Unioned so we fetch each note at most once.
    const needsDetection = await prisma.commit.findMany({
      where: { repoId, OR: [{ aiToolDetected: null }, { aiToolDetected: '' }] },
      select: { id: true, sha: true, filesChanged: true, additions: true, deletions: true, committedAt: true, session: { select: { id: true } } },
      take: 500,
      orderBy: { committedAt: 'desc' },
    });
    const needsSession = await prisma.commit.findMany({
      where: {
        repoId,
        aiToolDetected: { not: null },
        session: null,
      },
      select: { id: true, sha: true, filesChanged: true, additions: true, deletions: true, committedAt: true, session: { select: { id: true } } },
      take: 500,
      orderBy: { committedAt: 'desc' },
    });
    const byId = new Map<string, typeof needsDetection[number]>();
    for (const c of [...needsDetection, ...needsSession]) byId.set(c.id, c);

    for (const c of byId.values()) {
      try {
        const noteText = await api.fetchNote(c.sha);
        if (!noteText) continue;
        let parsed: { origin?: NoteOrigin } | null = null;
        try { parsed = JSON.parse(noteText); } catch { continue; }
        const o = parsed?.origin;
        if (!o) continue;

        const detected = await ensureAiToolDetected(c.id, o);
        if (detected) notesImported++;

        if (!c.session) {
          const created = await synthesizeSessionFromNote({
            commitId: c.id,
            commitSha: c.sha,
            commitFilesChanged: c.filesChanged,
            commitAdditions: c.additions ?? 0,
            commitDeletions: c.deletions ?? 0,
            commitTime: c.committedAt,
            orgId: repo.orgId,
            note: o,
          });
          if (created) virtualSessionsCreated++;
        }
      } catch (err) {
        console.error('[git-notes] virtual session sync failed', {
          sha: c.sha,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
  }

  return {
    imported,
    skipped,
    total: metadataEntries.length,
    notesImported,
    virtualSessionsCreated,
  };
}

// ─── Virtual session synthesis from git note ───────────────────────────────
//
// Each `refs/notes/origin` blob carries the originating prompt + session
// metadata (sessionId, model, agent, cost, tokens, …). When a commit lands
// in an org whose users weren't running Origin at the time — or whose org's
// CLI didn't push notes — the prompt content still arrives via GitHub, but
// nothing in the API turns it into a queryable session. This helper does.

const GIT_NOTE_VIRTUAL_MARKER = '__git-note__';

interface NoteOrigin {
  version?: number;
  sessionId?: string;
  model?: string;
  agent?: string;
  promptCount?: number;
  promptSummary?: string;
  fullPrompt?: string;
  previousSessionId?: string;
  filesRead?: string[];
  tokensUsed?: number;
  costUsd?: number;
  durationMs?: number;
  linesAdded?: number;
  linesRemoved?: number;
  originUrl?: string;
  timestamp?: string;
}

// Map a free-form model name onto one of the four catalog agent slugs.
// Returns null when the model doesn't clearly belong to a known agent —
// the synthesized session will then have no agentId (still useful for
// blame; just won't show up in per-agent rollups).
function inferAgentSlugFromModel(model: string | undefined): string | null {
  if (!model) return null;
  const m = model.toLowerCase();
  if (m.startsWith('gpt-') || m.startsWith('o1') || m.startsWith('o3') || m.startsWith('o4') || m === 'codex') return 'codex';
  if (m.startsWith('claude')) return 'claude-code';
  if (m.startsWith('gemini')) return 'gemini';
  return null;
}

async function ensureAiToolDetected(commitId: string, o: NoteOrigin): Promise<boolean> {
  try {
    const updated = await prisma.commit.updateMany({
      where: { id: commitId, OR: [{ aiToolDetected: null }, { aiToolDetected: '' }] },
      data: {
        aiToolDetected: o.model || 'claude-code',
        aiDetectionMethod: 'git-notes',
      },
    });
    return updated.count > 0;
  } catch {
    return false;
  }
}

async function synthesizeSessionFromNote(opts: {
  commitId: string;
  commitSha: string;
  commitFilesChanged: string;
  commitAdditions: number;
  commitDeletions: number;
  commitTime: Date;
  orgId: string;
  note: NoteOrigin;
}): Promise<boolean> {
  const { note: o } = opts;
  const promptText = (o.fullPrompt || o.promptSummary || '').trim();
  if (!promptText) return false; // nothing useful to show

  let agentId: string | null = null;
  const slug = o.agent || inferAgentSlugFromModel(o.model);
  if (slug) {
    try {
      const agent = await prisma.agent.findUnique({
        where: { orgId_slug: { orgId: opts.orgId, slug } },
        select: { id: true },
      });
      agentId = agent?.id ?? null;
    } catch { /* agent table not in scope here */ }
  }

  const noteTime = o.timestamp ? new Date(o.timestamp) : opts.commitTime;
  try {
    await prisma.$transaction(async (tx) => {
      const session = await tx.codingSession.create({
        data: {
          commitId: opts.commitId,
          agentId,
          model: o.model || 'unknown',
          prompt: promptText.slice(0, 50_000),
          transcript: '[]',
          filesChanged: opts.commitFilesChanged || '[]',
          tokensUsed: Math.max(0, Math.floor(o.tokensUsed ?? 0)),
          costUsd: Math.max(0, o.costUsd ?? 0),
          durationMs: Math.max(0, Math.floor(o.durationMs ?? 0)),
          linesAdded: o.linesAdded ?? opts.commitAdditions ?? 0,
          linesRemoved: o.linesRemoved ?? opts.commitDeletions ?? 0,
          status: 'COMPLETED',
          startedAt: noteTime,
          endedAt: noteTime,
          apiKeyName: GIT_NOTE_VIRTUAL_MARKER,
        },
      });
      await tx.promptChange.create({
        data: {
          sessionId: session.id,
          promptIndex: 0,
          promptText: promptText.slice(0, 1000),
          filesChanged: opts.commitFilesChanged || '[]',
          diff: '',
          // Pin to this commit's SHA so commit-detail's per-SHA filter
          // surfaces the prompt when the user opens that commit.
          commitSha: opts.commitSha,
        },
      });
    });
    return true;
  } catch (err) {
    // Most likely a unique-violation if a real session was created between
    // our null-check and the insert. Safe to swallow — that's the better
    // outcome anyway.
    if (err instanceof Error && /Unique constraint/i.test(err.message)) return false;
    console.error('[git-notes] synthesize session failed', {
      sha: opts.commitSha,
      error: err instanceof Error ? err.message : String(err),
    });
    return false;
  }
}

export { GIT_NOTE_VIRTUAL_MARKER };

/**
 * Live-read fallback: fetch a single commit's note from GitHub and
 * synthesise a virtual CodingSession for it. Called by commit-detail when
 * the user opens a commit whose note hasn't been imported yet (push webhook
 * may not have fired, or the org came onto a repo after the commit landed).
 *
 * Returns true when a new virtual session was created. Idempotent — if a
 * session already exists for the commit, this is a no-op. GitHub only.
 */
export async function fetchAndSynthesizeCommitNote(
  repoId: string,
  commitSha: string,
): Promise<boolean> {
  try {
    const commit = await prisma.commit.findFirst({
      where: { repoId, sha: commitSha },
      select: {
        id: true,
        sha: true,
        filesChanged: true,
        additions: true,
        deletions: true,
        committedAt: true,
        session: { select: { id: true } },
        repo: { select: { orgId: true, provider: true, path: true } },
      },
    });
    if (!commit) return false;
    if (commit.session) return false; // already have a session

    const path = commit.repo.path || '';
    const isGitHub =
      commit.repo.provider === 'github' || /github\.com\//.test(path);
    const isGitLab =
      commit.repo.provider === 'gitlab' || /gitlab\.com\/|gitlab\./.test(path);
    if (!isGitHub && !isGitLab) return false;

    const api = isGitHub
      ? await buildGitHubApi(path, commit.repo.orgId)
      : await buildGitLabApi(path, commit.repo.orgId);
    if (!api) return false;

    const noteText = await api.fetchNote(commit.sha);
    if (!noteText) return false;
    let parsed: { origin?: NoteOrigin } | null = null;
    try { parsed = JSON.parse(noteText); } catch { return false; }
    const o = parsed?.origin;
    if (!o) return false;

    await ensureAiToolDetected(commit.id, o);
    return await synthesizeSessionFromNote({
      commitId: commit.id,
      commitSha: commit.sha,
      commitFilesChanged: commit.filesChanged,
      commitAdditions: commit.additions ?? 0,
      commitDeletions: commit.deletions ?? 0,
      commitTime: commit.committedAt,
      orgId: commit.repo.orgId,
      note: o,
    });
  } catch (err) {
    console.error('[git-notes] live-read failed', {
      sha: commitSha,
      error: err instanceof Error ? err.message : String(err),
    });
    return false;
  }
}
