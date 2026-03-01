import { Request, Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';

const JWT_SECRET = process.env.JWT_SECRET || 'origin-v2-dev-secret';

export interface AuthRequest extends Request {
  user?: { id: string; orgId: string; role: string };
}

export function authMiddleware(req: AuthRequest, _res: Response, next: NextFunction) {
  const header = req.headers.authorization;
  if (!header?.startsWith('Bearer ')) return next();
  try {
    const payload = jwt.verify(header.slice(7), JWT_SECRET) as { id: string; orgId: string; role: string };
    req.user = payload;
  } catch { /* ignore invalid tokens */ }
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
