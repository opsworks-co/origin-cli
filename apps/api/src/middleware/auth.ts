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
