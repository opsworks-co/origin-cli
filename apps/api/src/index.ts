import 'dotenv/config';

// --- Production security checks ---
if (process.env.NODE_ENV === 'production') {
  const jwtSecret = process.env.JWT_SECRET || '';
  if (!jwtSecret || jwtSecret === 'CHANGE_ME_TO_A_RANDOM_SECRET' || jwtSecret.length < 32) {
    console.error('FATAL: JWT_SECRET must be set to a random string of 32+ characters in production');
    process.exit(1);
  }

  if (!process.env.SESSION_ENCRYPTION_KEY || process.env.SESSION_ENCRYPTION_KEY.length < 32) {
    console.warn('WARNING: SESSION_ENCRYPTION_KEY not set — session prompts/transcripts will be stored in plaintext. Set a 32-byte hex key for encryption at rest.');
  }
}

import express from 'express';
import cookieParser from 'cookie-parser';
import cors from 'cors';
import path from 'path';
import fsSync from 'fs';
import { fileURLToPath } from 'url';
import { execSync } from 'child_process';
import { prisma } from './db.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Run DB schema sync on startup (dev only — production uses prisma migrate deploy in docker-start.sh)
if (process.env.NODE_ENV !== 'production') {
  try {
    execSync('npx prisma db push --skip-generate', {
      cwd: path.join(__dirname, '../'),
      stdio: 'pipe',
      env: { ...process.env }
    });
    console.log('✅ Database ready');
  } catch (e) {
    console.log('⚠️  DB push skipped:', (e as Error).message?.slice(0, 100));
  }
}

import { authMiddleware } from './middleware/auth.js';
import { authLimiter, sessionLimiter, mcpLimiter, webhookLimiter, apiLimiter, publicScanLimiter } from './middleware/rate-limit.js';
import { startAutoSync } from './services/auto-sync.js';
import { startScheduler } from './services/scheduler.js';
import { startWebhookQueue } from './services/webhook-queue.js';
import authRoutes from './routes/auth.js';
import repoRoutes from './routes/repos.js';
import sessionRoutes from './routes/sessions.js';
import agentRoutes from './routes/agents.js';
import policyRoutes from './routes/policies.js';
import publicPolicyRoutes from './routes/public-policies.js';
import publicScanRoutes from './routes/public-scan.js';
import auditRoutes from './routes/audit.js';
import statsRoutes from './routes/stats.js';
import machineRoutes from './routes/machines.js';
import mcpRoutes from './routes/mcp.js';
import settingsRoutes from './routes/settings.js';
import notificationRoutes from './routes/notifications.js';
import webhookRoutes from './routes/webhooks.js';
import integrationRoutes from './routes/integrations.js';
import userRoutes from './routes/users.js';
import chatRoutes from './routes/chat.js';
import scanningRoutes from './routes/scanning.js';
import reportRoutes from './routes/reports.js';
import pullRequestRoutes from './routes/pull-requests.js';
import githubAppRoutes from './routes/github-app.js';
import gitlabOAuthRoutes from './routes/gitlab-oauth.js';
import trailRoutes from './routes/trails.js';
import leaderboardRoutes from './routes/leaderboard.js';
import promptRoutes from './routes/prompts.js';
import meRoutes from './routes/me.js';
import modelRoutes from './routes/models.js';
import pricingRoutes, { seedDefaultPricing } from './routes/pricing.js';
import { backfillAgentModels } from './services/agent-models.js';
import { backfillCatalogForAllOrgs } from './services/seed-catalog.js';
import forecastRoutes from './routes/forecast.js';
import shareRoutes from './routes/share.js';
import budgetRoutes from './routes/budget.js';
import insightsRoutes from './routes/insights.js';
import adminRoutes from './routes/admin.js';
import orgsRoutes from './routes/orgs.js';
import annotationRoutes from './routes/annotations.js';
import issueRoutes from './routes/issues.js';
import feedRoutes from './routes/feed.js';
import todayBriefRoutes from './routes/today-brief.js';

const app = express();

app.set('trust proxy', 1);

// Don't leak Express version in X-Powered-By — fingerprinting aid for
// attackers, provides zero value to legitimate clients.
app.disable('x-powered-by');

// Security headers
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('X-XSS-Protection', '1; mode=block');
  res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  // Baseline CSP. 'unsafe-inline' is required for the Vite-bundled app's
  // style tags; script-src stays 'self' so injected scripts can't execute.
  // connect-src allows the API itself plus https for outbound SSE/fetch.
  res.setHeader(
    'Content-Security-Policy',
    "default-src 'self'; " +
      "script-src 'self' https://www.googletagmanager.com https://www.google-analytics.com; " +
      "style-src 'self' 'unsafe-inline'; " +
      "img-src 'self' data: https:; " +
      "font-src 'self' data:; " +
      "connect-src 'self' https:; " +
      // Whitelist the embedded demo video host. Without this, the CSP falls
      // back to default-src 'self' and blocks the Loom iframe on the landing
      // page — the symptom is a broken-file icon where the video should be.
      "frame-src 'self' https://www.loom.com https://loom.com; " +
      "frame-ancestors 'none'; " +
      "base-uri 'self'; " +
      "form-action 'self'",
  );
  next();
});

app.use(cors({
  // Trim whitespace so CORS_ORIGIN="a, b, c" doesn't silently admit
  // " b" but reject "b" because the list is space-prefixed.
  origin: process.env.CORS_ORIGIN
    ? process.env.CORS_ORIGIN.split(',').map((s) => s.trim()).filter(Boolean)
    : ['http://localhost:5176', 'http://localhost:4002'],
  credentials: true,
}));

// Webhook routes need the raw body for HMAC signature verification.
// Mount them BEFORE the JSON body parser so we can capture raw bytes.
app.use('/api/webhooks', webhookLimiter, express.raw({ type: '*/*', limit: '10mb' }), (req, _res, next) => {
  // Store raw buffer for HMAC, then parse as JSON for route handlers
  (req as any).rawBody = req.body;
  if (Buffer.isBuffer(req.body)) {
    try {
      req.body = JSON.parse(req.body.toString('utf8'));
    } catch {
      // If not JSON (e.g. form-encoded with payload field), try to extract
      const str = req.body.toString('utf8');
      if (str.startsWith('payload=')) {
        try {
          req.body = JSON.parse(decodeURIComponent(str.slice(8)));
        } catch { /* leave as-is */ }
      }
    }
  }
  next();
}, webhookRoutes);

app.use(express.json({ limit: '2mb' }));
app.use(cookieParser());

// Per-route override for endpoints that receive large payloads (transcripts, diffs)
const largeBodyParser = express.json({ limit: '50mb' });

// Public routes (no auth required) — mount BEFORE authMiddleware
app.use(feedRoutes); // /rss.xml and /feed.xml — no /api/ prefix
app.use('/api/share', shareRoutes);
app.use('/api/v1/share', shareRoutes);

// Auth endpoints get strict per-IP brute-force protection BEFORE auth middleware
app.use('/api/auth', authLimiter);
app.use('/api/v1/auth', authLimiter);

app.use(authMiddleware);

// ── CSRF origin-check for cookie-authenticated mutations ────���───────────
// SameSite=Strict on the auth cookie already blocks most CSRF, but older
// browsers and certain redirect flows may not enforce it. This adds a
// defense-in-depth layer: for state-changing methods authenticated via
// cookie, verify the Origin/Referer header matches an allowed origin.
// API-key and Bearer-token auth are exempt (not cookie-based).
app.use((req, res, next) => {
  if (['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method)) {
    // Skip CSRF for auth routes (login creates sessions, not protects them)
    // and for OAuth callback routes
    const path = req.path;
    if (path.startsWith('/api/auth') || path.startsWith('/api/v1/auth') ||
        path.startsWith('/api/github-app') || path.startsWith('/api/gitlab-oauth')) {
      return next();
    }
    const hasCookie = req.headers.cookie?.includes('origin_auth=');
    if (hasCookie) {
      const origin = req.headers.origin || req.headers.referer;
      const allowed = process.env.CORS_ORIGIN
        ? process.env.CORS_ORIGIN.split(',').map(s => s.trim()).filter(Boolean)
        : ['http://localhost:5176', 'http://localhost:4002'];
      if (origin && !allowed.some(a => origin.startsWith(a))) {
        return res.status(403).json({ error: 'CSRF check failed' });
      }
    }
  }
  next();
});

// General per-user rate limit on all authenticated API traffic
app.use('/api', apiLimiter);

// ── Route mounting ───────────────────────────────────────────────────────
// Each route group is mounted under /api/* (current) and /api/v1/* (versioned).
// Once a CLI version starts using /v1, breaking changes can ship under /v2
// without disrupting older clients. The unversioned /api/* path stays as the
// implicit "v1" for now.
function mountRoute(path: string, router: any, extraMiddleware: any[] = []) {
  app.use(`/api${path}`, ...extraMiddleware, router);
  app.use(`/api/v1${path}`, ...extraMiddleware, router);
}

mountRoute('/auth', authRoutes);
mountRoute('/repos', repoRoutes);
mountRoute('/sessions', sessionRoutes, [largeBodyParser, sessionLimiter]);
mountRoute('/agents', agentRoutes);
mountRoute('/policies/public', publicPolicyRoutes);
mountRoute('/public-scan', publicScanRoutes, [publicScanLimiter]);
mountRoute('/policies', policyRoutes);
mountRoute('/audit', auditRoutes);
mountRoute('/stats', statsRoutes);
mountRoute('/machines', machineRoutes);
mountRoute('/mcp', mcpRoutes, [largeBodyParser, mcpLimiter]);
mountRoute('/settings', settingsRoutes);
mountRoute('/notifications', notificationRoutes);
// webhookRoutes already mounted above (before JSON parser, for raw body HMAC)
mountRoute('/integrations', integrationRoutes);
mountRoute('/users', userRoutes);
mountRoute('/chat', chatRoutes);
mountRoute('/scanning', scanningRoutes);
mountRoute('/reports', reportRoutes);
mountRoute('/pull-requests', pullRequestRoutes);
mountRoute('/github-app', githubAppRoutes);
mountRoute('/gitlab-oauth', gitlabOAuthRoutes);
mountRoute('/trails', trailRoutes);
mountRoute('/leaderboard', leaderboardRoutes);
mountRoute('/prompts', promptRoutes);
mountRoute('/me', meRoutes);
mountRoute('/models', modelRoutes);
mountRoute('/pricing', pricingRoutes);
mountRoute('/forecast', forecastRoutes);
mountRoute('/budget', budgetRoutes);
mountRoute('/insights', insightsRoutes);
mountRoute('/today-brief', todayBriefRoutes);
mountRoute('/admin', adminRoutes);
// Mount the multi-org user-self endpoints (/me/memberships, /me/active-org,
// /orgs, /orgs/:id/leave) at the root /api so the router's per-route
// paths resolve directly. They're not org-scoped — each route validates
// membership of the affected org on its own.
mountRoute('', orgsRoutes);
mountRoute('/sessions/:sessionId/annotations', annotationRoutes);
mountRoute('/repos/:repoId/issues', issueRoutes);

// Serve CLI install script
app.get('/install.sh', (_req, res) => {
  res.setHeader('Content-Type', 'text/plain');
  res.send(`#!/bin/sh
set -e

echo ""
echo "  Origin CLI Installer"
echo "  ===================="
echo ""

# Check for Node.js
if ! command -v node >/dev/null 2>&1; then
  echo "Error: Node.js is required. Install it from https://nodejs.org"
  exit 1
fi

NODE_VERSION=$(node -v | sed 's/v//' | cut -d. -f1)
if [ "$NODE_VERSION" -lt 18 ]; then
  echo "Error: Node.js 18+ required (found $(node -v))"
  exit 1
fi

if ! command -v npm >/dev/null 2>&1; then
  echo "Error: npm is required."
  exit 1
fi

TMPDIR=$(mktemp -d)
trap 'rm -rf "$TMPDIR"' EXIT

echo "  Downloading Origin CLI..."
curl -fsSL "https://getorigin.io/cli/origin-cli-latest.tgz" -o "$TMPDIR/origin-cli.tgz"

echo "  Installing..."
npm install -g "$TMPDIR/origin-cli.tgz" --silent 2>/dev/null

VERSION=$(origin --version 2>/dev/null || echo "unknown")
echo ""
echo "  Origin CLI installed successfully! (v$VERSION)"
echo ""
echo "  Get started:"
echo ""
echo "    origin login          # authenticate with your org"
echo "    origin init           # register machine, detect tools, install hooks"
echo ""
echo "  That's it — 2 commands. AI tools are auto-detected"
echo "  (Claude Code, Cursor, Copilot, Gemini, Aider, Windsurf, etc.)"
echo "  and re-scanned on every session start."
echo ""
`);
});

// Serve CLI tarballs from /cli/
const publicDir = path.join(__dirname, '../public');
app.use('/cli', express.static(path.join(publicDir, 'cli')));

// CLI version endpoint — read by `origin` CLI to detect updates.
// Reads the version.json written by the Dockerfile's CLI build step.
const cliVersionHandler = (_req: express.Request, res: express.Response) => {
  try {
    // Try the canonical Dockerfile location first: web/dist/cli/version.json
    const candidates = [
      path.join(__dirname, '../../web/dist/cli/version.json'),
      path.join(publicDir, 'cli', 'version.json'),
    ];
    for (const candidate of candidates) {
      if (fsSync.existsSync(candidate)) {
        const data = JSON.parse(fsSync.readFileSync(candidate, 'utf-8'));
        // Return both `downloadUrl` (legacy field name) and `url` + `sha256`
        // so the hardened upgrader in packages/cli/src/commands/upgrade.ts
        // can verify the tarball digest. Missing sha256 triggers fail-closed
        // behavior in the client — see F1.4 in the CLI.
        return res.json({
          version: data.version,
          url: data.url || 'https://getorigin.io/cli/origin-cli-latest.tgz',
          downloadUrl: data.url || 'https://getorigin.io/cli/origin-cli-latest.tgz',
          sha256: data.sha256 || null,
        });
      }
    }
    res.status(404).json({ error: 'cli version metadata not found' });
  } catch (err) {
    console.error('[cli-version] failed to resolve CLI version:', err);
    res.status(500).json({ error: 'unable to resolve cli version' });
  }
};
app.get('/api/cli/version', cliVersionHandler);
app.get('/api/v1/cli/version', cliVersionHandler);

// Serve React app in production
const webDist = path.join(__dirname, '../../web/dist');
app.use(express.static(webDist));
app.get('{*path}', (req, res) => {
  // NOTE: trailing slash matters — `/api-keys` is a SPA route, not an API call,
  // so we must only bail out for paths under `/api/`, not anything starting
  // with the literal string `/api`.
  if (!req.path.startsWith('/api/') && req.path !== '/api') {
    res.sendFile(path.join(webDist, 'index.html'));
  }
});

const PORT = process.env.PORT || 4002;
const HOST = process.env.HOST || '0.0.0.0';
app.listen(Number(PORT), HOST, () => {
  console.log(`Origin v2 running on http://${HOST}:${PORT}`);
  startAutoSync();
  seedDefaultPricing();
  backfillAgentModels();
  // Ensure every existing org has the four catalog Agent rows. Idempotent
  // — re-running on every boot only writes when something is missing.
  backfillCatalogForAllOrgs().catch((err) => {
    console.error('[seed-catalog] backfill failed:', err);
  });
  startScheduler();
  startWebhookQueue();

  // Auto-complete stale RUNNING sessions periodically.
  // CLI sends heartbeat pings every 30s, but the daemon can die when the
  // machine sleeps. Use a generous threshold — developers take long breaks,
  // read docs, etc. The session-end hook handles normal completion; this
  // only catches truly orphaned sessions.
  const STALE_SESSION_CHECK_MS = 5 * 60 * 1000;    // check every 5 min
  const STALE_THRESHOLD_MS = 15 * 60 * 1000;       // 15 min without heartbeat ping
  setInterval(async () => {
    try {
      const cutoff = new Date(Date.now() - STALE_THRESHOLD_MS);
      const stale = await prisma.codingSession.updateMany({
        where: {
          status: 'RUNNING',
          updatedAt: { lt: cutoff },
        },
        data: {
          status: 'COMPLETED',
          endedAt: new Date(),
        },
      });
      if (stale.count > 0) {
        console.log(`🧹 Auto-completed ${stale.count} stale session(s)`);
      }
    } catch (err) {
      console.error('Stale session cleanup error:', err);
    }
  }, STALE_SESSION_CHECK_MS).unref();
});

// Graceful shutdown — allow in-flight HTTP requests to finish before
// Fly sends SIGKILL. The listen() callback keeps the server ref; the
// .unref()'d intervals above don't need explicit teardown because they
// already let the loop exit once HTTP is closed.
function gracefulShutdown(signal: string) {
  console.log(`[shutdown] received ${signal}, draining connections...`);
  // Give Fly's proxy time to stop sending new requests, then exit.
  setTimeout(() => {
    console.log('[shutdown] exiting');
    process.exit(0);
  }, 5000).unref();
}
process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));
