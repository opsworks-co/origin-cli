import { Router, Response } from 'express';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import crypto from 'crypto';
import { prisma } from '../db.js';
import { AuthRequest, requireAuth } from '../middleware/auth.js';

const router = Router();
const JWT_SECRET = process.env.JWT_SECRET || 'origin-v2-dev-secret';

// Simple in-memory rate limiter for login
const loginAttempts = new Map<string, { count: number; resetAt: number }>();
const MAX_LOGIN_ATTEMPTS = 10;
const LOGIN_WINDOW_MS = 15 * 60 * 1000; // 15 minutes

function signToken(payload: { id: string; orgId: string; role: string }): string {
  return jwt.sign(payload, JWT_SECRET, { expiresIn: '7d' });
}

// POST /register
router.post('/register', async (req: AuthRequest, res: Response) => {
  try {
    const { email, password, name, orgName, orgSlug } = req.body;

    if (!email || !password || !name || !orgName || !orgSlug) {
      return res.status(400).json({ error: 'Missing required fields' });
    }

    // Email format validation
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      return res.status(400).json({ error: 'Invalid email format' });
    }

    // Password strength
    if (password.length < 8) {
      return res.status(400).json({ error: 'Password must be at least 8 characters' });
    }

    // Slug format validation
    if (!/^[a-z0-9-]+$/.test(orgSlug)) {
      return res.status(400).json({ error: 'Org slug must contain only lowercase letters, numbers, and hyphens' });
    }

    const existingUser = await prisma.user.findUnique({ where: { email } });
    if (existingUser) {
      return res.status(409).json({ error: 'Email already registered' });
    }

    const existingOrg = await prisma.org.findUnique({ where: { slug: orgSlug } });
    if (existingOrg) {
      return res.status(409).json({ error: 'Organization slug already taken' });
    }

    const passwordHash = await bcrypt.hash(password, 10);

    const org = await prisma.org.create({
      data: { name: orgName, slug: orgSlug },
    });

    const user = await prisma.user.create({
      data: {
        orgId: org.id,
        email,
        name,
        passwordHash,
        role: 'OWNER',
      },
    });

    const token = signToken({ id: user.id, orgId: org.id, role: user.role });

    res.status(201).json({
      token,
      user: { id: user.id, email: user.email, name: user.name, role: user.role, orgId: org.id, orgName: org.name, orgSlug: org.slug },
    });
  } catch (err) {
    console.error('Register error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// POST /login
router.post('/login', async (req: AuthRequest, res: Response) => {
  try {
    const { email, password } = req.body;

    if (!email || !password) {
      return res.status(400).json({ error: 'Missing email or password' });
    }

    // Rate limiting
    const ip = req.ip || 'unknown';
    const now = Date.now();
    const attempts = loginAttempts.get(ip);
    if (attempts) {
      if (now > attempts.resetAt) {
        loginAttempts.delete(ip);
      } else if (attempts.count >= MAX_LOGIN_ATTEMPTS) {
        return res.status(429).json({ error: 'Too many login attempts. Try again later.' });
      }
    }

    const user = await prisma.user.findUnique({
      where: { email },
      include: { org: true },
    });

    if (!user) {
      return res.status(401).json({ error: 'Invalid credentials' });
    }

    const valid = await bcrypt.compare(password, user.passwordHash);
    if (!valid) {
      // Track failed attempt
      const existing = loginAttempts.get(ip);
      if (existing) {
        existing.count++;
      } else {
        loginAttempts.set(ip, { count: 1, resetAt: now + LOGIN_WINDOW_MS });
      }
      return res.status(401).json({ error: 'Invalid credentials' });
    }

    // Clear rate limit on success
    loginAttempts.delete(ip);

    const token = signToken({ id: user.id, orgId: user.orgId, role: user.role });

    res.json({
      token,
      user: { id: user.id, email: user.email, name: user.name, role: user.role, orgId: user.orgId, orgName: user.org.name, orgSlug: user.org.slug },
    });
  } catch (err) {
    console.error('Login error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// GET /me
router.get('/me', requireAuth, async (req: AuthRequest, res: Response) => {
  try {
    const user = await prisma.user.findUnique({
      where: { id: req.user!.id },
      include: { org: true },
    });

    if (!user) {
      return res.status(404).json({ error: 'User not found' });
    }

    res.json({
      id: user.id,
      email: user.email,
      name: user.name,
      role: user.role,
      orgId: user.orgId,
      orgName: user.org.name,
      orgSlug: user.org.slug,
    });
  } catch (err) {
    console.error('Me error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// POST /api-keys — create an API key
router.post('/api-keys', requireAuth, async (req: AuthRequest, res: Response) => {
  try {
    const { name } = req.body;

    // Generate a random API key
    const rawKey = `org_${crypto.randomBytes(32).toString('hex')}`;
    const keyHash = crypto.createHash('sha256').update(rawKey).digest('hex');
    const keyPrefix = rawKey.slice(0, 12) + '...';

    const apiKey = await prisma.apiKey.create({
      data: {
        orgId: req.user!.orgId,
        name: name || 'Unnamed key',
        keyHash,
        keyPrefix,
      },
    });

    await prisma.auditLog.create({
      data: {
        orgId: req.user!.orgId,
        userId: req.user!.id,
        action: 'API_KEY_CREATED',
        resource: apiKey.id,
        metadata: JSON.stringify({ name: apiKey.name, prefix: keyPrefix }),
      },
    });

    res.status(201).json({ id: apiKey.id, key: rawKey, keyPrefix });
  } catch (err) {
    console.error('Create API key error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// GET /api-keys — list API keys
router.get('/api-keys', requireAuth, async (req: AuthRequest, res: Response) => {
  try {
    const keys = await prisma.apiKey.findMany({
      where: { orgId: req.user!.orgId },
      select: { id: true, name: true, keyPrefix: true, createdAt: true },
      orderBy: { createdAt: 'desc' },
    });
    res.json(keys);
  } catch (err) {
    console.error('List API keys error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// DELETE /api-keys/:id — revoke an API key
router.delete('/api-keys/:id', requireAuth, async (req: AuthRequest, res: Response) => {
  try {
    const id = req.params.id as string;

    const existing = await prisma.apiKey.findFirst({
      where: { id, orgId: req.user!.orgId },
    });

    if (!existing) {
      return res.status(404).json({ error: 'API key not found' });
    }

    await prisma.apiKey.delete({ where: { id } });

    await prisma.auditLog.create({
      data: {
        orgId: req.user!.orgId,
        userId: req.user!.id,
        action: 'API_KEY_REVOKED',
        resource: id,
        metadata: JSON.stringify({ name: existing.name }),
      },
    });

    res.json({ success: true });
  } catch (err) {
    console.error('Delete API key error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

export default router;
