import 'dotenv/config';
import express from 'express';
import cors from 'cors';
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

const PORT = process.env.PORT || 4002;
app.listen(PORT, () => {
  console.log(`Origin v2 API running on http://localhost:${PORT}`);
});
