import { Request, Response, NextFunction } from 'express';
import crypto from 'crypto';
import jwt from 'jsonwebtoken';
import { prisma } from '../db.js';

const JWT_SECRET = process.env.JWT_SECRET || 'origin-v2-dev-secret';

export interface AuthRequest extends Request {
  user?: { id: string; orgId: string; role: string };
}

export function authMiddleware(req: AuthRequest, _res: Response, next: NextFunction) {
  // Support Bearer token in Authorization header
  const header = req.headers.authorization;
  if (header?.startsWith('Bearer ')) {
    try {
      const payload = jwt.verify(header.slice(7), JWT_SECRET) as { id: string; orgId: string; role: string };
      req.user = payload;
    } catch { /* ignore invalid tokens */ }
  }
  // Also support token in query param (for SSE EventSource which can't set headers)
  if (!req.user && req.query.token) {
    try {
      const payload = jwt.verify(req.query.token as string, JWT_SECRET) as { id: string; orgId: string; role: string };
      req.user = payload;
    } catch { /* ignore invalid tokens */ }
  }
  // Support X-API-Key header (used by CLI)
  if (!req.user) {
    const apiKey = req.headers['x-api-key'] as string | undefined;
    if (apiKey) {
      const keyHash = crypto.createHash('sha256').update(apiKey).digest('hex');
      prisma.apiKey.findFirst({
        where: { keyHash },
        include: {
          user: true,
          org: { include: { users: { where: { role: 'OWNER' }, take: 1 } } },
        },
      })
        .then((found) => {
          if (found) {
            // Standalone key (no userId): use key's own id + role
            // Linked key (has userId): use the linked user's identity + role
            const resolvedUser = found.user ?? found.org.users[0];
            req.user = {
              id: found.user?.id ?? found.id,
              orgId: found.orgId,
              role: found.role ?? resolvedUser?.role ?? 'MEMBER',
            };
          }
          next();
        })
        .catch(() => next());
      return; // async — don't call next() synchronously
    }
  }
  next();
}

export function requireAuth(req: AuthRequest, res: Response, next: NextFunction) {
  if (!req.user) return res.status(401).json({ error: 'Unauthorized' });
  next();
}

/**
 * RBAC middleware — restricts route to specific roles.
 * Roles hierarchy: OWNER > ADMIN > MEMBER > VIEWER
 * Usage: router.post('/', requireAuth, requireRole('ADMIN'), handler)
 */
const ROLE_LEVELS: Record<string, number> = {
  VIEWER: 0,
  MEMBER: 1,
  ADMIN: 2,
  OWNER: 3,
};

export function requireRole(...roles: string[]) {
  return (req: AuthRequest, res: Response, next: NextFunction) => {
    if (!req.user) return res.status(401).json({ error: 'Unauthorized' });
    const userRole = req.user.role.toUpperCase();
    // Allow if user's role is in the list, or if user's level >= highest required level
    const maxRequired = Math.max(...roles.map((r) => ROLE_LEVELS[r.toUpperCase()] ?? 0));
    const userLevel = ROLE_LEVELS[userRole] ?? 0;
    if (userLevel >= maxRequired) return next();
    res.status(403).json({ error: 'Forbidden: insufficient permissions' });
  };
}
