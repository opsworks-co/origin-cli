// Spend Quality dashboard — admin-only insights endpoints.
//
// All routes share:
//   • requireAuth + resolveOrgContext + requireRole('ADMIN')
//   • A standard ?range=7d|30d|90d&from=ISO&to=ISO date filter
//   • Org-scoped queries — every WHERE includes commit.repo.orgId or userId
//   • A 500ms perf budget at 10k sessions (tested via the seed harness in
//     __tests__/insights.test.ts)
//
// Each endpoint corresponds to one section of the dashboard. Pure metric
// math lives in services/insights/metrics.ts; this file's job is to build
// the SQL/Prisma query, hand the rows to a metric function, and ship JSON.

import { Router, Response } from 'express';
import { prisma } from '../db.js';
import { AuthRequest, requireAuth, resolveOrgContext, requireRole } from '../middleware/auth.js';
import { INSIGHTS_CONFIG } from '../services/insights/insights-config.js';
import {
  computeAiAuthorship,
  computeReworkRate,
  computeCostPerMergedPr,
  flagSession,
  flagModelFit,
  bucketHeatmap,
  classifyTokenUsage,
  parseDateRange,
  type DateRange,
  type SessionForModelFit,
} from '../services/insights/metrics.js';

const router = Router();
router.use(requireAuth);
router.use(resolveOrgContext);
// Admin-only across the whole sub-router. Frontend route also gates on this
// before mounting; the API gate is the source of truth.
router.use(requireRole('ADMIN'));

// Helper: parse range or return a 400 with a user-readable error and a
// machine-readable code so the frontend can render it inline (constraint #9).
function rangeOrError(req: AuthRequest, res: Response): DateRange | null {
  try {
    return parseDateRange(req.query as { range?: unknown; from?: unknown; to?: unknown });
  } catch (err: any) {
    res.status(400).json({ error: err.message || 'Invalid range', code: 'INVALID_RANGE' });
    return null;
  }
}

// Public expose for the frontend's section legends — keeps thresholds in sync
// without bundling them twice.
router.get('/config', (_req: AuthRequest, res: Response) => {
  res.json(INSIGHTS_CONFIG);
});

// ── Section 1 — Spend Quality table ────────────────────────────────────────
//
// Per-dev row with $ spent, AI authorship %, rework rate, $/PR merged.
// Strategy:
//   1. SQL groupBy → per-user totals (cost, sessions). Cheap.
//   2. Pull bounded prompt rows for the same range; bucket by user in JS to
//      compute authorship + rework. Capped at scanCap to keep latency bounded.
//   3. Pull merged PRs in range; JS-side join via commitShas.
router.get('/spend-quality', async (req: AuthRequest, res: Response) => {
  const range = rangeOrError(req, res);
  if (!range) return;

  try {
    const orgId = req.activeOrgId!;

    // Per-user cost + session count via groupBy. SQLite handles this fine
    // up to ~10k sessions without a custom index — userId is already
    // indexed on CodingSession.
    const grouped = await prisma.codingSession.groupBy({
      by: ['userId'],
      where: {
        commit: { repo: { orgId } },
        createdAt: { gte: range.from, lte: range.to },
        userId: { not: null },
      },
      _sum: { costUsd: true },
      _count: { _all: true },
    });

    if (grouped.length === 0) {
      return res.json({ rows: [], range: { from: range.from.toISOString(), to: range.to.toISOString() } });
    }

    const userIds = grouped.map((g) => g.userId!).filter(Boolean);

    // Pull users for display names. Single round-trip.
    const users = await prisma.user.findMany({
      where: { id: { in: userIds } },
      select: { id: true, name: true, email: true },
    });
    const userMap = new Map(users.map((u) => [u.id, u]));

    // Pull bounded PromptChange rows joined to sessions in range. Capped.
    const prompts = await prisma.promptChange.findMany({
      where: {
        session: {
          commit: { repo: { orgId } },
          createdAt: { gte: range.from, lte: range.to },
          userId: { in: userIds },
        },
      },
      select: {
        sessionId: true,
        createdAt: true,
        filesChanged: true,
        linesAdded: true,
        linesRemoved: true,
        aiPercentage: true,
        session: { select: { userId: true } },
      },
      take: INSIGHTS_CONFIG.scanCap,
      orderBy: { createdAt: 'asc' },
    });

    // Bucket prompts by userId. Parse filesChanged JSON once.
    const promptsByUser = new Map<string, { authorship: { linesAdded: number; aiPercentage: number }[]; rework: { createdAt: Date; filesChanged: string[]; linesAdded: number; linesRemoved: number }[] }>();
    for (const p of prompts) {
      const uid = p.session.userId;
      if (!uid) continue;
      let bucket = promptsByUser.get(uid);
      if (!bucket) {
        bucket = { authorship: [], rework: [] };
        promptsByUser.set(uid, bucket);
      }
      let files: string[] = [];
      try {
        const parsed = JSON.parse(p.filesChanged);
        if (Array.isArray(parsed)) files = parsed.filter((x): x is string => typeof x === 'string');
      } catch { /* malformed JSON — count as no files */ }
      bucket.authorship.push({ linesAdded: p.linesAdded, aiPercentage: p.aiPercentage });
      bucket.rework.push({ createdAt: p.createdAt, filesChanged: files, linesAdded: p.linesAdded, linesRemoved: p.linesRemoved });
    }

    // Merged PRs in range. We treat *createdAt* as the bound rather than a
    // dedicated mergedAt because the existing schema doesn't always populate
    // mergedAt; the same approximation budget.ts uses for PR cost.
    const prs = await prisma.pullRequest.findMany({
      where: {
        repo: { orgId },
        state: 'merged',
        createdAt: { gte: range.from, lte: range.to },
      },
      select: { number: true, commitShas: true },
      take: 10_000,
    });
    const mergedPrs = prs.map((p) => {
      let shas: string[] = [];
      try {
        const parsed = JSON.parse(p.commitShas);
        if (Array.isArray(parsed)) shas = parsed.filter((s): s is string => typeof s === 'string');
      } catch { /* malformed — treat as empty */ }
      return { prNumber: p.number, commitShas: shas };
    });

    // Per-user session→commit lookup for $/PR. We need each session's commit
    // SHA, which lives on the Commit row. One join, narrow select.
    const sessionsWithSha = await prisma.codingSession.findMany({
      where: {
        commit: { repo: { orgId } },
        createdAt: { gte: range.from, lte: range.to },
        userId: { in: userIds },
      },
      select: { userId: true, costUsd: true, commit: { select: { sha: true } } },
      take: INSIGHTS_CONFIG.scanCap,
    });
    const sessionsForPr = sessionsWithSha
      .filter((s) => s.userId && s.commit?.sha)
      .map((s) => ({ userId: s.userId!, costUsd: s.costUsd, commitSha: s.commit!.sha }));

    const rows = grouped.map((g) => {
      const uid = g.userId!;
      const u = userMap.get(uid);
      const bucket = promptsByUser.get(uid);
      const aiAuthorship = bucket ? computeAiAuthorship(bucket.authorship) : 0;
      const reworkRate = bucket ? computeReworkRate(bucket.rework) : 0;
      const pr = computeCostPerMergedPr(uid, sessionsForPr, mergedPrs);
      return {
        userId: uid,
        name: u?.name || 'Unknown',
        email: u?.email || '',
        spendUsd: g._sum.costUsd ?? 0,
        sessionCount: g._count._all,
        aiAuthorship,
        reworkRate,
        costPerMergedPr: pr.costPerMergedPr,
        mergedPrCount: pr.mergedPrCount,
      };
    }).sort((a, b) => b.spendUsd - a.spendUsd);

    res.json({
      rows: rows.slice(0, INSIGHTS_CONFIG.maxRowsPerEndpoint),
      range: { from: range.from.toISOString(), to: range.to.toISOString() },
    });
  } catch (err) {
    console.error('insights/spend-quality error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ── Section 2 — Top expensive sessions ─────────────────────────────────────
router.get('/top-sessions', async (req: AuthRequest, res: Response) => {
  const range = rangeOrError(req, res);
  if (!range) return;

  const limitParam = Number(req.query.limit);
  const limit = Number.isFinite(limitParam) && limitParam > 0
    ? Math.min(Math.floor(limitParam), INSIGHTS_CONFIG.topSessions.max)
    : INSIGHTS_CONFIG.topSessions.default;

  try {
    const orgId = req.activeOrgId!;

    // Pull top-N most expensive sessions. To compute the dev-avg flag we
    // also need each user's average; one extra groupBy pass.
    const top = await prisma.codingSession.findMany({
      where: {
        commit: { repo: { orgId } },
        createdAt: { gte: range.from, lte: range.to },
      },
      select: {
        id: true, costUsd: true, commitId: true, branch: true,
        startedAt: true, endedAt: true, createdAt: true,
        userId: true,
        user: { select: { name: true } },
        _count: { select: { promptChanges: true } },
      },
      orderBy: { costUsd: 'desc' },
      take: limit,
    });

    if (top.length === 0) {
      return res.json({ sessions: [], range: { from: range.from.toISOString(), to: range.to.toISOString() } });
    }

    const avgs = await prisma.codingSession.groupBy({
      by: ['userId'],
      where: {
        commit: { repo: { orgId } },
        createdAt: { gte: range.from, lte: range.to },
        userId: { not: null },
      },
      _avg: { costUsd: true },
    });
    const avgByUser = new Map(avgs.map((a) => [a.userId, a._avg.costUsd ?? 0]));

    const sessions = top.map((s) => {
      const start = s.startedAt ?? s.createdAt;
      const end = s.endedAt ?? s.createdAt;
      const durationSec = Math.max(0, Math.round((end.getTime() - start.getTime()) / 1000));
      const flags = flagSession(
        { costUsd: s.costUsd, commitId: s.commitId },
        avgByUser.get(s.userId) ?? 0,
      );
      return {
        sessionId: s.id,
        userName: s.user?.name || 'Unknown',
        durationSec,
        costUsd: s.costUsd,
        promptCount: s._count.promptChanges,
        branch: s.branch,
        commitCount: s.commitId ? 1 : 0,
        flags,
        cliPath: `/sessions/${s.id}`,
      };
    });

    res.json({ sessions, range: { from: range.from.toISOString(), to: range.to.toISOString() } });
  } catch (err) {
    console.error('insights/top-sessions error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ── Section 3 — Model-fit warnings ─────────────────────────────────────────
router.get('/model-fit-warnings', async (req: AuthRequest, res: Response) => {
  const range = rangeOrError(req, res);
  if (!range) return;

  try {
    const orgId = req.activeOrgId!;

    // Only Opus/Sonnet sessions can trigger warnings — pre-filter via
    // case-insensitive contains on `model` to keep the scan bounded.
    const sessions = await prisma.codingSession.findMany({
      where: {
        commit: { repo: { orgId } },
        createdAt: { gte: range.from, lte: range.to },
        OR: [
          { model: { contains: 'opus' } },
          { model: { contains: 'sonnet' } },
        ],
      },
      select: {
        id: true, model: true, costUsd: true, commitId: true,
        user: { select: { name: true } },
        _count: { select: { promptChanges: true } },
        promptChanges: {
          select: { filesChanged: true },
          // bound at 200 — files-touched only needs the unique-set, not every prompt
          take: 200,
        },
      },
      take: INSIGHTS_CONFIG.scanCap,
    });

    const warnings = [];
    for (const s of sessions) {
      const fileSet = new Set<string>();
      for (const pc of s.promptChanges) {
        try {
          const arr = JSON.parse(pc.filesChanged);
          if (Array.isArray(arr)) for (const f of arr) if (typeof f === 'string') fileSet.add(f);
        } catch { /* skip malformed */ }
      }
      const input: SessionForModelFit = {
        sessionId: s.id,
        model: s.model,
        costUsd: s.costUsd,
        promptCount: s._count.promptChanges,
        filesTouched: fileSet.size,
        commitId: s.commitId,
      };
      const w = flagModelFit(input);
      if (w) warnings.push({ ...w, userName: s.user?.name || 'Unknown' });
      if (warnings.length >= 10) break; // top-10 cap per spec
    }

    res.json({ warnings, range: { from: range.from.toISOString(), to: range.to.toISOString() } });
  } catch (err) {
    console.error('insights/model-fit-warnings error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ── Section 4 — Time-of-spend heatmap ──────────────────────────────────────
router.get('/spend-heatmap', async (req: AuthRequest, res: Response) => {
  const range = rangeOrError(req, res);
  if (!range) return;

  try {
    const orgId = req.activeOrgId!;
    // Single SELECT — no JS-side reduction beyond the bucket aggregator.
    const sessions = await prisma.codingSession.findMany({
      where: {
        commit: { repo: { orgId } },
        createdAt: { gte: range.from, lte: range.to },
      },
      select: { createdAt: true, costUsd: true },
      take: INSIGHTS_CONFIG.scanCap,
    });
    const cells = bucketHeatmap(sessions);
    res.json({ cells, range: { from: range.from.toISOString(), to: range.to.toISOString() } });
  } catch (err) {
    console.error('insights/spend-heatmap error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ── Section 5 — Wasted prompts (DEGRADED) ──────────────────────────────────
//
// Snapshot-restore events aren't persisted in the current schema (see audit
// in CLAUDE-context). We return a structured "degraded" response so the
// frontend can render a meaningful empty state instead of "0 wasted prompts"
// (which would be a false claim).
router.get('/wasted-prompts', async (req: AuthRequest, res: Response) => {
  const range = rangeOrError(req, res);
  if (!range) return;

  res.json({
    perDev: [],
    topPrompts: [],
    degraded: true,
    degradedReason: 'Snapshot-restore events are not persisted yet. When the CLI captures restores into a queryable column, this section populates automatically.',
    range: { from: range.from.toISOString(), to: range.to.toISOString() },
  });
});

// ── Section 6 — Token-class breakdown per dev ──────────────────────────────
//
// Returns three breakdowns in a single round-trip: per-engineer (legacy
// `rows` field, kept for the Spend Quality Section 6 contract), per-agent,
// and per-model. Each breakdown re-uses classifyTokenUsage so the outlier
// flag and ratio math stay consistent across views.
router.get('/token-breakdown', async (req: AuthRequest, res: Response) => {
  const range = rangeOrError(req, res);
  if (!range) return;

  try {
    const orgId = req.activeOrgId!;
    const where = {
      commit: { repo: { orgId } },
      createdAt: { gte: range.from, lte: range.to },
    };

    // Three groupBy queries in parallel — each is a single-column aggregate
    // over the same scoped session set, so SQLite caches the index walk and
    // total time is barely above one query (verified locally on 10k rows).
    const [byUserGrouped, byAgentGrouped, byModelGrouped] = await Promise.all([
      prisma.codingSession.groupBy({
        by: ['userId'],
        where: { ...where, userId: { not: null } },
        _sum: { inputTokens: true, outputTokens: true, cacheReadTokens: true, cacheCreationTokens: true },
      }),
      prisma.codingSession.groupBy({
        by: ['agentId'],
        where: { ...where, agentId: { not: null } },
        _sum: { inputTokens: true, outputTokens: true, cacheReadTokens: true, cacheCreationTokens: true },
      }),
      prisma.codingSession.groupBy({
        by: ['model'],
        where,
        _sum: { inputTokens: true, outputTokens: true, cacheReadTokens: true, cacheCreationTokens: true },
      }),
    ]);

    // Resolve user + agent names in two batched lookups; model is its own
    // identifier so no extra fetch needed.
    const userIds = byUserGrouped.map((g) => g.userId!).filter(Boolean);
    const agentIds = byAgentGrouped.map((g) => g.agentId!).filter(Boolean);
    const [users, agents] = await Promise.all([
      userIds.length
        ? prisma.user.findMany({ where: { id: { in: userIds } }, select: { id: true, name: true } })
        : Promise.resolve([] as Array<{ id: string; name: string }>),
      agentIds.length
        ? prisma.agent.findMany({ where: { id: { in: agentIds } }, select: { id: true, name: true, slug: true } })
        : Promise.resolve([] as Array<{ id: string; name: string; slug: string }>),
    ]);
    const userMap = new Map(users.map((u) => [u.id, u]));
    const agentMap = new Map(agents.map((a) => [a.id, a]));

    const userRaw = byUserGrouped.map((g) => ({
      userId: g.userId!,
      name: userMap.get(g.userId!)?.name || 'Unknown',
      inputTokens: g._sum.inputTokens ?? 0,
      outputTokens: g._sum.outputTokens ?? 0,
      cacheReadTokens: g._sum.cacheReadTokens ?? 0,
      cacheCreationTokens: g._sum.cacheCreationTokens ?? 0,
    }));

    // Reuse classifyTokenUsage for agents/models — it's keyed on `userId` in
    // its raw input but we pass agent/model IDs as that key for code reuse.
    // The outlier-detection threshold is the org median × N, which is the
    // right shape for any per-entity rollup.
    const agentRaw = byAgentGrouped.map((g) => {
      const a = agentMap.get(g.agentId!);
      return {
        userId: g.agentId!, // re-purposed as agentId for classifier
        name: a?.name || 'Unknown',
        inputTokens: g._sum.inputTokens ?? 0,
        outputTokens: g._sum.outputTokens ?? 0,
        cacheReadTokens: g._sum.cacheReadTokens ?? 0,
        cacheCreationTokens: g._sum.cacheCreationTokens ?? 0,
      };
    });

    const modelRaw = byModelGrouped
      .filter((g) => g.model && g.model.length > 0)
      .map((g) => ({
        userId: g.model, // re-purposed as model key
        name: g.model,
        inputTokens: g._sum.inputTokens ?? 0,
        outputTokens: g._sum.outputTokens ?? 0,
        cacheReadTokens: g._sum.cacheReadTokens ?? 0,
        cacheCreationTokens: g._sum.cacheCreationTokens ?? 0,
      }));

    const byUser = classifyTokenUsage(userRaw).sort((a, b) => b.generatedTokens - a.generatedTokens);
    const byAgent = classifyTokenUsage(agentRaw).sort((a, b) => b.generatedTokens - a.generatedTokens)
      // Map the re-purposed `userId` field back to a more accurate
      // `agentId` shape on the wire so the frontend doesn't have to know
      // about the classifier's keying convention.
      .map((r) => ({ agentId: r.userId, slug: agentMap.get(r.userId)?.slug || '', ...rest(r, ['userId']) }));
    const byModel = classifyTokenUsage(modelRaw).sort((a, b) => b.generatedTokens - a.generatedTokens)
      .map((r) => ({ model: r.userId, ...rest(r, ['userId']) }));

    res.json({
      // Legacy field — unchanged shape, kept so the existing Spend Quality
      // section 6 component doesn't have to migrate.
      rows: byUser.slice(0, INSIGHTS_CONFIG.maxRowsPerEndpoint),
      byAgent: byAgent.slice(0, INSIGHTS_CONFIG.maxRowsPerEndpoint),
      byModel: byModel.slice(0, INSIGHTS_CONFIG.maxRowsPerEndpoint),
      range: { from: range.from.toISOString(), to: range.to.toISOString() },
    });
  } catch (err) {
    console.error('insights/token-breakdown error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Tiny helper to drop keys without pulling in lodash. Used to remap the
// classifier's userId-shaped output to the agent/model-keyed wire shape.
function rest<T extends object, K extends keyof T>(obj: T, keys: K[]): Omit<T, K> {
  const out = { ...obj };
  for (const k of keys) delete out[k];
  return out as Omit<T, K>;
}

export default router;
