// Public lead-magnet route: takes a GitHub repo URL + email, runs a heuristic
// AI-attribution scan, persists the result so the link is shareable.
// No auth. Rate limited by IP (handled at the mount point).
import { Router, Request, Response } from 'express';
import crypto from 'crypto';
import { prisma } from '../db.js';
import { parseGitHubUrl, scanRepository } from '../services/public-scan.js';

const router = Router();

// Simple email validator. We're not trying to bounce-check here, just keep
// obvious garbage out of the leads list.
function looksLikeEmail(s: string): boolean {
  if (!s || s.length > 254) return false;
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s);
}

// Short, URL-safe token. Not a secret — it's the shareable link id.
function makeToken(): string {
  return crypto.randomBytes(9).toString('base64url');
}

// POST / — start a scan. Returns { token } so the client can poll + share.
// Body: { repoUrl, email }
router.post('/', async (req: Request, res: Response) => {
  try {
    const repoUrl = typeof req.body?.repoUrl === 'string' ? req.body.repoUrl : '';
    const email = typeof req.body?.email === 'string' ? req.body.email.trim().toLowerCase() : '';

    if (!looksLikeEmail(email)) {
      return res.status(400).json({ error: 'Valid email required' });
    }
    const parsed = parseGitHubUrl(repoUrl);
    if (!parsed) {
      return res.status(400).json({ error: 'Not a valid GitHub URL. Try: github.com/owner/repo' });
    }

    // Idempotency: if this email already scanned this repo in the last hour,
    // return the existing scan instead of burning GitHub quota.
    const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000);
    const existing = await prisma.auditLead.findFirst({
      where: {
        email,
        repoUrl: `https://github.com/${parsed.owner}/${parsed.repo}`,
        createdAt: { gte: oneHourAgo },
      },
      orderBy: { createdAt: 'desc' },
    });
    if (existing) {
      return res.json({ token: existing.token, status: existing.status });
    }

    const token = makeToken();
    const requestIp = (req.headers['x-forwarded-for'] as string)?.split(',')[0]?.trim() ||
      req.socket?.remoteAddress ||
      null;

    // Create the row up front so the client can poll.
    const lead = await prisma.auditLead.create({
      data: {
        email,
        repoUrl: `https://github.com/${parsed.owner}/${parsed.repo}`,
        token,
        status: 'running',
        requestIp,
      },
    });

    // Fire the scan asynchronously. The client polls GET /:token.
    (async () => {
      try {
        const result = await scanRepository(parsed.owner, parsed.repo, 100);
        await prisma.auditLead.update({
          where: { id: lead.id },
          data: {
            status: 'complete',
            commitCount: result.commitCount,
            aiCommitCount: result.aiCommitCount,
            aiPercentage: result.aiPercentage,
            topModel: result.topModel,
            estimatedCost: result.estimatedCost,
            totalLines: result.totalLines,
            topAuthors: JSON.stringify(result.topAuthors),
            modelBreakdown: JSON.stringify(result.modelBreakdown),
            signalsFound: JSON.stringify(result.signalsFound),
            completedAt: new Date(),
          },
        });
      } catch (err: any) {
        await prisma.auditLead.update({
          where: { id: lead.id },
          data: {
            status: 'failed',
            errorMessage: (err?.message || 'Scan failed').slice(0, 500),
            completedAt: new Date(),
          },
        }).catch(() => { /* swallow secondary errors */ });
      }
    })();

    return res.json({ token, status: 'running' });
  } catch (err: any) {
    console.error('public-scan POST error:', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

// GET /:token — fetch scan result. Polled by the client while running.
router.get('/:token', async (req: Request, res: Response) => {
  try {
    const token = req.params.token as string;
    const lead = await prisma.auditLead.findUnique({ where: { token } });
    if (!lead) return res.status(404).json({ error: 'Scan not found' });

    const topAuthors = (() => { try { return JSON.parse(lead.topAuthors); } catch { return []; } })();
    const modelBreakdown = (() => { try { return JSON.parse(lead.modelBreakdown); } catch { return {}; } })();
    const signalsFound = (() => { try { return JSON.parse(lead.signalsFound); } catch { return []; } })();

    return res.json({
      token: lead.token,
      repoUrl: lead.repoUrl,
      status: lead.status,
      commitCount: lead.commitCount,
      aiCommitCount: lead.aiCommitCount,
      aiPercentage: lead.aiPercentage,
      topModel: lead.topModel,
      estimatedCost: lead.estimatedCost,
      totalLines: lead.totalLines,
      topAuthors,
      modelBreakdown,
      signalsFound,
      errorMessage: lead.errorMessage,
      createdAt: lead.createdAt,
      completedAt: lead.completedAt,
    });
  } catch (err: any) {
    console.error('public-scan GET error:', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

export default router;
