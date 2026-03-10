import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import path from 'path';
import { fileURLToPath } from 'url';
import { execSync } from 'child_process';

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
import authRoutes from './routes/auth.js';
import repoRoutes from './routes/repos.js';
import sessionRoutes from './routes/sessions.js';
import agentRoutes from './routes/agents.js';
import policyRoutes from './routes/policies.js';
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

const app = express();

app.use(cors({ origin: true }));
app.use(express.json({ limit: '10mb' }));
app.use(authMiddleware);

app.use('/api/auth', authRoutes);
app.use('/api/repos', repoRoutes);
app.use('/api/sessions', sessionRoutes);
app.use('/api/agents', agentRoutes);
app.use('/api/policies', policyRoutes);
app.use('/api/audit', auditRoutes);
app.use('/api/stats', statsRoutes);
app.use('/api/machines', machineRoutes);
app.use('/api/mcp', mcpRoutes);
app.use('/api/settings', settingsRoutes);
app.use('/api/notifications', notificationRoutes);
app.use('/api/webhooks', webhookRoutes);
app.use('/api/integrations', integrationRoutes);
app.use('/api/users', userRoutes);
app.use('/api/chat', chatRoutes);
app.use('/api/scanning', scanningRoutes);
app.use('/api/reports', reportRoutes);
app.use('/api/pull-requests', pullRequestRoutes);
app.use('/api/github-app', githubAppRoutes);

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
curl -fsSL "https://origin-platform.fly.dev/cli/origin-cli-latest.tgz" -o "$TMPDIR/origin-cli.tgz"

echo "  Installing..."
npm install -g "$TMPDIR/origin-cli.tgz" --silent 2>/dev/null

echo ""
echo "  Origin CLI installed successfully!"
echo ""
echo "  Get started:"
echo ""
echo "    origin login          # authenticate with your org"
echo "    origin init           # register this machine"
echo "    origin enable         # install hooks in your repo"
echo ""
echo "  Then just code with Claude Code, Cursor, or Gemini."
echo "  Sessions are captured automatically."
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
app.listen(PORT, () => {
  console.log(`Origin v2 running on http://localhost:${PORT}`);
  startAutoSync();
});
