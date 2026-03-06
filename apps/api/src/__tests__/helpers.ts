import { vi } from 'vitest';

// ─── Mock Prisma Client ──────────────────────────────────────────────────
// Creates a deeply mocked Prisma client. Each model has standard CRUD methods.

function createModelMock() {
  return {
    findMany: vi.fn().mockResolvedValue([]),
    findFirst: vi.fn().mockResolvedValue(null),
    findUnique: vi.fn().mockResolvedValue(null),
    create: vi.fn().mockResolvedValue({}),
    update: vi.fn().mockResolvedValue({}),
    updateMany: vi.fn().mockResolvedValue({ count: 0 }),
    upsert: vi.fn().mockResolvedValue({}),
    delete: vi.fn().mockResolvedValue({}),
    deleteMany: vi.fn().mockResolvedValue({ count: 0 }),
    count: vi.fn().mockResolvedValue(0),
    aggregate: vi.fn().mockResolvedValue({ _sum: {}, _count: 0, _avg: {}, _min: {}, _max: {} }),
    groupBy: vi.fn().mockResolvedValue([]),
  };
}

export const mockPrisma = {
  org: createModelMock(),
  user: createModelMock(),
  apiKey: createModelMock(),
  repo: createModelMock(),
  commit: createModelMock(),
  codingSession: createModelMock(),
  sessionReview: createModelMock(),
  agent: createModelMock(),
  policy: createModelMock(),
  policyRule: createModelMock(),
  policyVersion: createModelMock(),
  agentVersion: createModelMock(),
  machine: createModelMock(),
  auditLog: createModelMock(),
  webhook: createModelMock(),
  pullRequest: createModelMock(),
  integrationConfig: createModelMock(),
  notification: createModelMock(),
  sessionDiff: createModelMock(),
  promptChange: createModelMock(),
  secretFinding: createModelMock(),
};

// Mock the db module (path relative to this file: src/__tests__/helpers.ts -> src/db.js)
vi.mock('../db.js', () => ({
  prisma: mockPrisma,
}));

// Mock the versioning service (so route tests don't depend on it)
vi.mock('../services/versioning.js', () => ({
  createPolicyVersion: vi.fn().mockResolvedValue({}),
  createAgentVersion: vi.fn().mockResolvedValue({}),
}));

// Mock the notifications service
vi.mock('../services/notifications.js', () => ({
  notifyOrgAdmins: vi.fn().mockResolvedValue(undefined),
  notifyOrgMembers: vi.fn().mockResolvedValue(undefined),
}));

// ─── Mock Auth Middleware ─────────────────────────────────────────────────

export const TEST_USER = {
  id: 'user-1',
  orgId: 'org-1',
  role: 'OWNER',
};

export const TEST_MEMBER = {
  id: 'user-2',
  orgId: 'org-1',
  role: 'MEMBER',
};

export const TEST_VIEWER = {
  id: 'user-3',
  orgId: 'org-1',
  role: 'VIEWER',
};

// Mock auth middleware to inject test user
vi.mock('../middleware/auth.js', () => {
  let currentUser = { id: 'user-1', orgId: 'org-1', role: 'OWNER' };

  return {
    AuthRequest: {},
    authMiddleware: (req: any, _res: any, next: any) => {
      req.user = currentUser;
      next();
    },
    requireAuth: (req: any, res: any, next: any) => {
      if (!req.user) return res.status(401).json({ error: 'Unauthorized' });
      next();
    },
    requireRole: (...roles: string[]) => {
      const ROLE_LEVELS: Record<string, number> = { VIEWER: 0, MEMBER: 1, ADMIN: 2, OWNER: 3 };
      return (req: any, res: any, next: any) => {
        if (!req.user) return res.status(401).json({ error: 'Unauthorized' });
        const maxRequired = Math.max(...roles.map(r => ROLE_LEVELS[r.toUpperCase()] ?? 0));
        const userLevel = ROLE_LEVELS[req.user.role.toUpperCase()] ?? 0;
        if (userLevel >= maxRequired) return next();
        res.status(403).json({ error: 'Forbidden: insufficient permissions' });
      };
    },
    _setTestUser: (user: any) => { currentUser = user; },
  };
});

// ─── App Factory ──────────────────────────────────────────────────────────

import express from 'express';

let _currentTestUser: any = { id: 'user-1', orgId: 'org-1', role: 'OWNER' };

export function setTestUser(user: any) {
  _currentTestUser = user;
}

export function createTestApp(router: any, path = '/api/test') {
  const app = express();
  app.use(express.json());

  // Inject user directly (mirrors what the mocked authMiddleware does)
  app.use((req: any, _res: any, next: any) => {
    req.user = _currentTestUser;
    next();
  });

  app.use(path, router);
  return app;
}

// ─── Reset Helpers ────────────────────────────────────────────────────────

export function resetAllMocks() {
  Object.values(mockPrisma).forEach(model => {
    Object.values(model).forEach(fn => {
      if (typeof fn === 'function' && 'mockReset' in fn) {
        (fn as any).mockReset();
      }
    });
  });
}
