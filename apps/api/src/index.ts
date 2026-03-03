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

// Serve React app in production
const webDist = path.join(__dirname, '../../web/dist');
app.use(express.static(webDist));
app.get('*', (req, res) => {
  if (!req.path.startsWith('/api')) {
    res.sendFile(path.join(webDist, 'index.html'));
  }
});

const PORT = process.env.PORT || 4002;
app.listen(PORT, () => {
  console.log(`Origin v2 running on http://localhost:${PORT}`);
});
