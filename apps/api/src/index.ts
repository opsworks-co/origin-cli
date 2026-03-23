import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import path from 'path';
import { fileURLToPath } from 'url';
import { execSync } from 'child_process';
import { prisma } from './db.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Run DB migrations on startup
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

import { authMiddleware } from './middleware/auth.js';
import { startAutoSync } from './services/auto-sync.js';
import { startScheduler } from './services/scheduler.js';
import authRoutes from './routes/auth.js';
import repoRoutes from './routes/repos.js';
import sessionRoutes from './routes/sessions.js';
import agentRoutes from './routes/agents.js';
import policyRoutes from './routes/policies.js';
import publicPolicyRoutes from './routes/public-policies.js';
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
import modelRoutes from './routes/models.js';
import pricingRoutes, { seedDefaultPricing } from './routes/pricing.js';
import forecastRoutes from './routes/forecast.js';
import shareRoutes from './routes/share.js';
import budgetRoutes from './routes/budget.js';

const app = express();

app.set('trust proxy', 1);

// Security headers
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('X-XSS-Protection', '1; mode=block');
  res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  next();
});

app.use(cors({
  origin: process.env.CORS_ORIGIN
    ? process.env.CORS_ORIGIN.split(',')
    : ['http://localhost:5176', 'http://localhost:4002'],
  credentials: true,
}));

// Webhook routes need the raw body for HMAC signature verification.
// Mount them BEFORE the JSON body parser so we can capture raw bytes.
app.use('/api/webhooks', express.raw({ type: '*/*', limit: '10mb' }), (req, _res, next) => {
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

app.use(express.json({ limit: '10mb' }));

// Public routes (no auth required) — mount BEFORE authMiddleware
app.use('/api/share', shareRoutes);

app.use(authMiddleware);

app.use('/api/auth', authRoutes);
app.use('/api/repos', repoRoutes);
app.use('/api/sessions', sessionRoutes);
app.use('/api/agents', agentRoutes);
app.use('/api/policies/public', publicPolicyRoutes);
app.use('/api/policies', policyRoutes);
app.use('/api/audit', auditRoutes);
app.use('/api/stats', statsRoutes);
app.use('/api/machines', machineRoutes);
app.use('/api/mcp', mcpRoutes);
app.use('/api/settings', settingsRoutes);
app.use('/api/notifications', notificationRoutes);
// webhookRoutes already mounted above (before JSON parser, for raw body HMAC)
app.use('/api/integrations', integrationRoutes);
app.use('/api/users', userRoutes);
app.use('/api/chat', chatRoutes);
app.use('/api/scanning', scanningRoutes);
app.use('/api/reports', reportRoutes);
app.use('/api/pull-requests', pullRequestRoutes);
app.use('/api/github-app', githubAppRoutes);
app.use('/api/gitlab-oauth', gitlabOAuthRoutes);
app.use('/api/trails', trailRoutes);
app.use('/api/leaderboard', leaderboardRoutes);
app.use('/api/prompts', promptRoutes);
app.use('/api/models', modelRoutes);
app.use('/api/pricing', pricingRoutes);
app.use('/api/forecast', forecastRoutes);
app.use('/api/budget', budgetRoutes);

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

// Serve React app in production
const webDist = path.join(__dirname, '../../web/dist');
app.use(express.static(webDist));
app.get('{*path}', (req, res) => {
  if (!req.path.startsWith('/api')) {
    res.sendFile(path.join(webDist, 'index.html'));
  }
});

const PORT = process.env.PORT || 4002;
const HOST = process.env.HOST || '0.0.0.0';
app.listen(Number(PORT), HOST, () => {
  console.log(`Origin v2 running on http://${HOST}:${PORT}`);
  startAutoSync();
  seedDefaultPricing();
  startScheduler();

  // Auto-complete stale RUNNING sessions periodically.
  // CLI sends heartbeat pings every 30s, but the daemon can die when the
  // machine sleeps. Use a generous threshold — developers take long breaks,
  // read docs, etc. The session-end hook handles normal completion; this
  // only catches truly orphaned sessions.
  const STALE_SESSION_CHECK_MS = 1 * 60 * 1000;    // check every 1 min
  const STALE_THRESHOLD_MS = 2 * 60 * 1000;        // 2 min without heartbeat ping
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
  }, STALE_SESSION_CHECK_MS);
});
