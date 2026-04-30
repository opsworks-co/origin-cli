import { Router, Request, Response } from 'express';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import crypto from 'crypto';
import { prisma } from '../db.js';
import {
  AuthRequest,
  requireAuth,
  setAuthCookie,
  clearAuthCookie,
  generateSseToken,
  resolveOrgContext,
  ORG_CONTEXT_HEADER,
} from '../middleware/auth.js';
import { passwordResetLimiter } from '../middleware/rate-limit.js';
import { sendEmail } from '../services/email.js';
import { seedCatalogForOrg } from '../services/seed-catalog.js';

const router = Router();
function requireEnv(name: string): string {
  const val = process.env[name];
  if (!val) throw new Error(`FATAL: ${name} environment variable is required.`);
  return val;
}
const JWT_SECRET = requireEnv('JWT_SECRET');

const loginAttempts = new Map<string, { count: number; resetAt: number }>();
const MAX_LOGIN_ATTEMPTS = 10;
const LOGIN_WINDOW_MS = 15 * 60 * 1000;

setInterval(() => {
  const now = Date.now();
  for (const [ip, entry] of loginAttempts) {
    if (now > entry.resetAt) loginAttempts.delete(ip);
  }
}, 60_000).unref();

function validatePasswordLen(pw: unknown): string | null {
  if (typeof pw !== 'string') return 'Password is required';
  if (pw.length < 8) return 'Password must be at least 8 characters';
  if (Buffer.byteLength(pw, 'utf8') > 72) return 'Password must be 72 bytes or fewer';
  return null;
}

const BCRYPT_COST = 12;

// JWT payload now carries only the user id. Active org is resolved per
// request from the X-Origin-Org header → User.lastOrgId → first membership.
function signToken(userId: string): string {
  prisma.user.update({ where: { id: userId }, data: { lastLoginAt: new Date() } }).catch(() => {});
  return jwt.sign({ id: userId }, JWT_SECRET, { expiresIn: '7d' });
}

// Build the membership list + chosen active org for the response shape used
// by /me, /login, /register and /accept-invite. Caller can pass an explicit
// `preferredOrgId` (e.g. the one the user just joined) to override the
// header / lastOrgId fallback.
async function buildAuthPayload(
  userId: string,
  preferredOrgId?: string,
): Promise<{
  user: {
    id: string;
    email: string;
    name: string;
    accountType: string;
    avatarUrl: string | null;
    emailVerified: boolean;
  };
  memberships: Array<{
    orgId: string;
    name: string;
    slug: string;
    type: string;
    role: string;
  }>;
  activeOrgId: string | null;
  activeRole: string | null;
}> {
  const [user, memberships] = await Promise.all([
    prisma.user.findUnique({
      where: { id: userId },
      select: {
        id: true, email: true, name: true, accountType: true,
        avatarUrl: true, emailVerified: true, lastOrgId: true,
      },
    }),
    prisma.membership.findMany({
      where: { userId },
      select: {
        role: true,
        org: { select: { id: true, name: true, slug: true, type: true } },
      },
      orderBy: { joinedAt: 'asc' },
    }),
  ]);
  if (!user) throw new Error('User not found');

  const memberList = memberships.map((m) => ({
    orgId: m.org.id,
    name: m.org.name,
    slug: m.org.slug,
    type: m.org.type,
    role: m.role,
  }));

  let activeOrgId: string | null = null;
  let activeRole: string | null = null;
  if (preferredOrgId) {
    const m = memberList.find((x) => x.orgId === preferredOrgId);
    if (m) { activeOrgId = m.orgId; activeRole = m.role; }
  }
  if (!activeOrgId && user.lastOrgId) {
    const m = memberList.find((x) => x.orgId === user.lastOrgId);
    if (m) { activeOrgId = m.orgId; activeRole = m.role; }
  }
  if (!activeOrgId && memberList.length > 0) {
    activeOrgId = memberList[0].orgId;
    activeRole = memberList[0].role;
  }

  return {
    user: {
      id: user.id,
      email: user.email,
      name: user.name,
      accountType: user.accountType,
      avatarUrl: user.avatarUrl,
      emailVerified: user.emailVerified,
    },
    memberships: memberList,
    activeOrgId,
    activeRole,
  };
}

// POST /register — create a team org + owner + membership.
router.post('/register', async (req: AuthRequest, res: Response) => {
  try {
    const { email, password, name, orgName, orgSlug } = req.body;
    if (!email || !password || !name || !orgName || !orgSlug) {
      return res.status(400).json({ error: 'Missing required fields' });
    }
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      return res.status(400).json({ error: 'Invalid email format' });
    }
    {
      const pwErr = validatePasswordLen(password);
      if (pwErr) return res.status(400).json({ error: pwErr });
    }
    if (!/^[a-z0-9-]+$/.test(orgSlug)) {
      return res.status(400).json({ error: 'Org slug must contain only lowercase letters, numbers, and hyphens' });
    }

    const existingUser = await prisma.user.findUnique({ where: { email } });
    if (existingUser) return res.status(409).json({ error: 'Email already registered' });
    const existingOrg = await prisma.org.findUnique({ where: { slug: orgSlug } });
    if (existingOrg) return res.status(409).json({ error: 'Organization slug already taken' });

    const passwordHash = await bcrypt.hash(password, BCRYPT_COST);

    const result = await prisma.$transaction(async (tx) => {
      const org = await tx.org.create({
        data: { name: orgName, slug: orgSlug, type: 'team' },
      });
      const user = await tx.user.create({
        data: { email, name, passwordHash, accountType: 'org', lastOrgId: org.id },
      });
      await tx.membership.create({
        data: { userId: user.id, orgId: org.id, role: 'OWNER' },
      });
      // Pre-seed the agent catalog (Claude Code / Cursor / Gemini /
      // Codex) so the new admin lands on a populated Agents page.
      await seedCatalogForOrg(org.id, tx);
      return { user, org };
    });

    const token = signToken(result.user.id);
    setAuthCookie(res, token);
    const payload = await buildAuthPayload(result.user.id, result.org.id);

    res.status(201).json({ token, ...payload });
  } catch (err) {
    console.error('Register error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// POST /register/developer — create a personal org + owner + membership.
router.post('/register/developer', async (req: AuthRequest, res: Response) => {
  try {
    const { email, password, name } = req.body;
    if (!email || !password || !name) return res.status(400).json({ error: 'Missing required fields' });
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return res.status(400).json({ error: 'Invalid email format' });
    {
      const pwErr = validatePasswordLen(password);
      if (pwErr) return res.status(400).json({ error: pwErr });
    }

    const existingUser = await prisma.user.findUnique({ where: { email } });
    if (existingUser) return res.status(409).json({ error: 'Email already registered' });

    const baseSlug = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'dev';
    let slug = `${baseSlug}-personal`;
    let attempt = 0;
    while (await prisma.org.findUnique({ where: { slug } })) {
      attempt++;
      slug = `${baseSlug}-personal-${attempt}`;
    }

    const passwordHash = await bcrypt.hash(password, BCRYPT_COST);

    const result = await prisma.$transaction(async (tx) => {
      const org = await tx.org.create({
        data: { name: `${name}'s workspace`, slug, type: 'personal' },
      });
      const user = await tx.user.create({
        data: { email, name, passwordHash, accountType: 'developer', lastOrgId: org.id },
      });
      await tx.membership.create({
        data: { userId: user.id, orgId: org.id, role: 'OWNER' },
      });
      await seedCatalogForOrg(org.id, tx);
      return { user, org };
    });

    const rawApiKey = 'org_sk_' + crypto.randomBytes(24).toString('hex');
    const keyHash = crypto.createHash('sha256').update(rawApiKey).digest('hex');
    const keyPrefix = rawApiKey.slice(0, 14);
    await prisma.apiKey.create({
      data: { orgId: result.org.id, userId: result.user.id, name: 'Default', keyHash, keyPrefix },
    });

    const token = signToken(result.user.id);
    setAuthCookie(res, token);
    const payload = await buildAuthPayload(result.user.id, result.org.id);

    res.status(201).json({ token, apiKey: rawApiKey, ...payload });
  } catch (err) {
    console.error('Register developer error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// POST /login — verifies password, returns membership list + chosen active org.
router.post('/login', async (req: AuthRequest, res: Response) => {
  try {
    const { email, password } = req.body;
    if (!email || !password) return res.status(400).json({ error: 'Missing email or password' });
    if (typeof email !== 'string' || email.length > 320) return res.status(400).json({ error: 'Invalid credentials' });
    if (typeof password !== 'string' || password.length > 1024) return res.status(400).json({ error: 'Invalid credentials' });

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

    const user = await prisma.user.findUnique({ where: { email } });
    if (!user) return res.status(401).json({ error: 'Invalid credentials' });

    const valid = await bcrypt.compare(password, user.passwordHash);
    if (!valid) {
      const existing = loginAttempts.get(ip);
      if (existing) existing.count++;
      else loginAttempts.set(ip, { count: 1, resetAt: now + LOGIN_WINDOW_MS });
      return res.status(401).json({ error: 'Invalid credentials' });
    }

    loginAttempts.delete(ip);

    const token = signToken(user.id);
    setAuthCookie(res, token);
    const payload = await buildAuthPayload(user.id);

    res.json({ token, ...payload });
  } catch (err) {
    console.error('Login error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// GET /me — full session payload (user, memberships, activeOrgId).
router.get('/me', requireAuth, async (req: AuthRequest, res: Response) => {
  try {
    const headerOrg = (req.headers[ORG_CONTEXT_HEADER] as string | undefined)?.trim() || undefined;
    const payload = await buildAuthPayload(req.user!.id, headerOrg);
    res.json(payload);
  } catch (err) {
    console.error('Me error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

router.post('/logout', async (_req: AuthRequest, res: Response) => {
  clearAuthCookie(res);
  res.json({ success: true });
});

router.patch('/profile', requireAuth, async (req: AuthRequest, res: Response) => {
  try {
    const { name, email, avatarUrl } = req.body;
    const data: any = {};
    if (typeof name === 'string' && name.trim()) data.name = name.trim();
    if (typeof email === 'string' && email.trim()) {
      const existing = await prisma.user.findFirst({ where: { email: email.trim(), id: { not: req.user!.id } } });
      if (existing) return res.status(409).json({ error: 'Email already in use' });
      data.email = email.trim();
    }
    if (typeof avatarUrl === 'string') data.avatarUrl = avatarUrl || null;

    if (Object.keys(data).length === 0) return res.status(400).json({ error: 'No fields to update' });

    await prisma.user.update({ where: { id: req.user!.id }, data });
    const payload = await buildAuthPayload(req.user!.id);
    res.json(payload);
  } catch (err) {
    console.error('Profile update error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

router.post('/change-password', requireAuth, async (req: AuthRequest, res: Response) => {
  try {
    const { currentPassword, newPassword } = req.body;
    if (!currentPassword || !newPassword) return res.status(400).json({ error: 'Current and new password are required' });
    {
      const pwErr = validatePasswordLen(newPassword);
      if (pwErr) return res.status(400).json({ error: `New password invalid: ${pwErr}` });
    }
    if (typeof currentPassword !== 'string' || currentPassword.length > 1024) return res.status(400).json({ error: 'Current password invalid' });

    const user = await prisma.user.findUnique({ where: { id: req.user!.id } });
    if (!user) return res.status(404).json({ error: 'User not found' });
    if (user.provider) return res.status(400).json({ error: 'Cannot change password for OAuth accounts' });

    const valid = await bcrypt.compare(currentPassword, user.passwordHash);
    if (!valid) return res.status(401).json({ error: 'Current password is incorrect' });

    const passwordHash = await bcrypt.hash(newPassword, BCRYPT_COST);
    await prisma.user.update({ where: { id: user.id }, data: { passwordHash } });

    res.json({ success: true });
  } catch (err) {
    console.error('Change password error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// POST /accept-invite — public; creates a Membership in the invited org.
// Pre-existing accounts can join additional orgs without losing their
// existing memberships.
router.post('/accept-invite', async (req: AuthRequest, res: Response) => {
  try {
    const { token, name, email, password } = req.body;
    if (!token || !name || !email || !password) {
      return res.status(400).json({ error: 'Missing required fields: token, name, email, password' });
    }
    {
      const pwErr = validatePasswordLen(password);
      if (pwErr) return res.status(400).json({ error: pwErr });
    }
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return res.status(400).json({ error: 'Invalid email format' });

    const invitation = await prisma.invitation.findFirst({
      where: { token, usedAt: null, expiresAt: { gt: new Date() } },
      include: { org: true },
    });
    if (!invitation) return res.status(404).json({ error: 'Invalid or expired invitation link' });
    if (invitation.email && invitation.email.toLowerCase() !== email.toLowerCase()) {
      return res.status(400).json({ error: 'This invitation was sent to a different email address' });
    }

    const existingUser = await prisma.user.findUnique({ where: { email } });
    let userId: string;

    if (existingUser) {
      const valid = await bcrypt.compare(password, existingUser.passwordHash);
      if (!valid) {
        return res.status(401).json({ error: 'Incorrect password. Enter the password for your existing account to join.' });
      }
      userId = existingUser.id;
      // Upsert membership — re-accepting the same invite is a no-op rather
      // than an error, but role on the invitation wins (admin can use a
      // re-invite to upgrade an existing member's role).
      await prisma.membership.upsert({
        where: { userId_orgId: { userId, orgId: invitation.orgId } },
        update: { role: invitation.role },
        create: { userId, orgId: invitation.orgId, role: invitation.role },
      });
      // Once a user has joined any team, accountType becomes 'org' so the
      // dashboard treats them as a multi-tenant user (picker, etc.).
      await prisma.user.update({
        where: { id: userId },
        data: { accountType: 'org', lastOrgId: invitation.orgId },
      });
    } else {
      const passwordHash = await bcrypt.hash(password, BCRYPT_COST);
      const created = await prisma.user.create({
        data: { email, name, passwordHash, accountType: 'org', lastOrgId: invitation.orgId },
      });
      await prisma.membership.create({
        data: { userId: created.id, orgId: invitation.orgId, role: invitation.role },
      });
      userId = created.id;
    }

    await prisma.invitation.update({
      where: { id: invitation.id },
      data: { usedAt: new Date(), usedBy: userId },
    });
    await prisma.auditLog.create({
      data: {
        orgId: invitation.orgId,
        userId,
        action: 'INVITATION_ACCEPTED',
        resource: invitation.id,
        metadata: JSON.stringify({ email, role: invitation.role, existingUser: !!existingUser }),
      },
    });

    const jwtToken = signToken(userId);
    setAuthCookie(res, jwtToken);
    const payload = await buildAuthPayload(userId, invitation.orgId);

    res.status(201).json({ token: jwtToken, ...payload });
  } catch (err) {
    console.error('Accept invite error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// GET /invite/:token — public invitation lookup.
router.get('/invite/:token', async (req: AuthRequest, res: Response) => {
  try {
    const { token } = req.params;
    if (typeof token !== 'string' || token.length < 8 || token.length > 128) {
      return res.status(400).json({ error: 'Invalid invitation token' });
    }
    const invitation = await prisma.invitation.findFirst({
      where: { token, usedAt: null, expiresAt: { gt: new Date() } },
      include: { org: { select: { name: true, slug: true } } },
    });
    if (!invitation) return res.status(404).json({ error: 'Invalid or expired invitation' });
    res.json({ orgName: invitation.org.name, role: invitation.role, email: invitation.email });
  } catch (err) {
    console.error('Get invite info error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ── API Keys (org-scoped) ───────────────────────────────────────────────────

router.post('/api-keys', requireAuth, resolveOrgContext, async (req: AuthRequest, res: Response) => {
  try {
    const { name, repoIds, agentIds } = req.body;
    const MAX_SCOPE = 200;
    if (repoIds !== undefined && !Array.isArray(repoIds)) return res.status(400).json({ error: 'repoIds must be an array' });
    if (agentIds !== undefined && !Array.isArray(agentIds)) return res.status(400).json({ error: 'agentIds must be an array' });
    if (Array.isArray(repoIds) && repoIds.length > MAX_SCOPE) return res.status(400).json({ error: `repoIds exceeds max of ${MAX_SCOPE}` });
    if (Array.isArray(agentIds) && agentIds.length > MAX_SCOPE) return res.status(400).json({ error: `agentIds exceeds max of ${MAX_SCOPE}` });
    if (typeof name === 'string' && name.length > 256) return res.status(400).json({ error: 'name exceeds max length' });

    if (repoIds && Array.isArray(repoIds) && repoIds.length > 0) {
      const validRepos = await prisma.repo.findMany({
        where: { orgId: req.activeOrgId!, id: { in: repoIds } },
        select: { id: true },
      });
      if (validRepos.length !== repoIds.length) {
        return res.status(400).json({ error: 'One or more repos do not belong to your organization' });
      }
    }
    if (agentIds && Array.isArray(agentIds) && agentIds.length > 0) {
      const validAgents = await prisma.agent.findMany({
        where: { orgId: req.activeOrgId!, id: { in: agentIds } },
        select: { id: true },
      });
      if (validAgents.length !== agentIds.length) {
        return res.status(400).json({ error: 'One or more agents do not belong to your organization' });
      }
    }

    const rawKey = `org_${crypto.randomBytes(32).toString('hex')}`;
    const keyHash = crypto.createHash('sha256').update(rawKey).digest('hex');
    const keyPrefix = rawKey.slice(0, 12) + '...';

    const apiKey = await prisma.apiKey.create({
      data: {
        orgId: req.activeOrgId!,
        userId: req.user!.id,
        name: name || 'Unnamed key',
        keyHash,
        keyPrefix,
        repoScopes: { create: (repoIds && Array.isArray(repoIds) ? repoIds : []).map((repoId: string) => ({ repoId })) },
        agentScopes: { create: (agentIds && Array.isArray(agentIds) ? agentIds : []).map((agentId: string) => ({ agentId })) },
      },
      include: {
        repoScopes: { include: { repo: { select: { id: true, name: true } } } },
        agentScopes: { include: { agent: { select: { id: true, name: true, slug: true } } } },
      },
    });

    await prisma.auditLog.create({
      data: {
        orgId: req.activeOrgId!,
        userId: req.user!.id,
        action: 'API_KEY_CREATED',
        resource: apiKey.id,
        metadata: JSON.stringify({
          name: apiKey.name,
          prefix: keyPrefix,
          repoScopes: apiKey.repoScopes.map((s) => s.repo.name),
          agentScopes: apiKey.agentScopes.map((s) => s.agent.name),
        }),
      },
    });

    res.status(201).json({
      id: apiKey.id,
      key: rawKey,
      keyPrefix,
      repoScopes: apiKey.repoScopes.map((s) => ({ repoId: s.repo.id, repoName: s.repo.name })),
      agentScopes: apiKey.agentScopes.map((s) => ({ agentId: s.agent.id, agentName: s.agent.name, agentSlug: s.agent.slug })),
    });
  } catch (err) {
    console.error('Create API key error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

router.get('/api-keys', requireAuth, resolveOrgContext, async (req: AuthRequest, res: Response) => {
  try {
    const keys = await prisma.apiKey.findMany({
      where: { orgId: req.activeOrgId! },
      select: {
        id: true, name: true, keyPrefix: true, createdAt: true,
        userId: true,
        user: { select: { name: true, email: true } },
        repoScopes: { include: { repo: { select: { id: true, name: true } } } },
        agentScopes: { include: { agent: { select: { id: true, name: true, slug: true } } } },
      },
      orderBy: { createdAt: 'desc' },
      take: 2000,
    });
    res.json(keys.map((k) => ({
      ...k,
      repoScopes: k.repoScopes.map((s) => ({ repoId: s.repo.id, repoName: s.repo.name })),
      agentScopes: k.agentScopes.map((s) => ({ agentId: s.agent.id, agentName: s.agent.name, agentSlug: s.agent.slug })),
    })));
  } catch (err) {
    console.error('List API keys error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

router.delete('/api-keys/:id', requireAuth, resolveOrgContext, async (req: AuthRequest, res: Response) => {
  try {
    const id = req.params.id as string;
    const existing = await prisma.apiKey.findFirst({ where: { id, orgId: req.activeOrgId! } });
    if (!existing) return res.status(404).json({ error: 'API key not found' });

    const deleted = await prisma.apiKey.deleteMany({ where: { id, orgId: req.activeOrgId! } });
    if (deleted.count === 0) return res.status(404).json({ error: 'API key not found' });

    await prisma.auditLog.create({
      data: {
        orgId: req.activeOrgId!,
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

// ── Password Reset ──────────────────────────────────────────────────────────

const WEB_URL = process.env.ORIGIN_WEB_URL || 'https://getorigin.io';

router.post('/forgot-password', passwordResetLimiter, async (req: AuthRequest, res: Response) => {
  try {
    const { email } = req.body;
    if (!email) return res.status(400).json({ error: 'Email is required' });
    const user = await prisma.user.findUnique({ where: { email } });
    if (!user) return res.json({ message: 'If that email exists, a reset link has been sent.' });

    await prisma.authToken.updateMany({
      where: { userId: user.id, type: 'password_reset', usedAt: null },
      data: { usedAt: new Date() },
    });

    const token = crypto.randomBytes(32).toString('hex');
    const tokenHash = crypto.createHash('sha256').update(token).digest('hex');
    await prisma.authToken.create({
      data: {
        userId: user.id,
        token: tokenHash,
        type: 'password_reset',
        expiresAt: new Date(Date.now() + 60 * 60 * 1000),
      },
    });

    const resetUrl = `${WEB_URL}/reset-password?token=${token}`;
    await sendEmail(email, 'Reset your Origin password', `
      <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; max-width: 480px; margin: 0 auto; padding: 40px 20px;">
        <div style="text-align: center; margin-bottom: 32px;">
          <h1 style="color: #f3f4f6; font-size: 24px; margin: 0;">Origin</h1>
        </div>
        <div style="background: #111827; border: 1px solid #1f2937; border-radius: 12px; padding: 32px;">
          <h2 style="color: #f3f4f6; font-size: 18px; margin: 0 0 12px;">Reset your password</h2>
          <p style="color: #9ca3af; font-size: 14px; line-height: 1.6; margin: 0 0 24px;">
            Click the button below to set a new password. This link expires in 1 hour.
          </p>
          <a href="${resetUrl}" style="display: inline-block; background: #6366f1; color: white; text-decoration: none; padding: 12px 24px; border-radius: 8px; font-size: 14px; font-weight: 500;">
            Reset Password
          </a>
          <p style="color: #6b7280; font-size: 12px; margin: 24px 0 0;">
            If you didn't request this, you can safely ignore this email.
          </p>
        </div>
      </div>
    `);

    res.json({ message: 'If that email exists, a reset link has been sent.' });
  } catch (err) {
    console.error('Forgot password error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

router.post('/reset-password', async (req: AuthRequest, res: Response) => {
  try {
    const { token, password } = req.body;
    if (!token || !password) return res.status(400).json({ error: 'Token and password are required' });
    {
      const pwErr = validatePasswordLen(password);
      if (pwErr) return res.status(400).json({ error: pwErr });
    }
    const tokenHash = crypto.createHash('sha256').update(token).digest('hex');
    const authToken = await prisma.authToken.findFirst({
      where: { token: tokenHash, type: 'password_reset', usedAt: null, expiresAt: { gt: new Date() } },
    });
    if (!authToken) return res.status(400).json({ error: 'Invalid or expired reset link' });

    const passwordHash = await bcrypt.hash(password, BCRYPT_COST);
    await prisma.user.update({ where: { id: authToken.userId }, data: { passwordHash } });
    await prisma.authToken.update({ where: { id: authToken.id }, data: { usedAt: new Date() } });

    res.json({ message: 'Password has been reset successfully' });
  } catch (err) {
    console.error('Reset password error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

router.get('/verify-token/:token', async (req: AuthRequest, res: Response) => {
  try {
    const { token } = req.params;
    const tokenHash = crypto.createHash('sha256').update(token as string).digest('hex');
    const authToken = await prisma.authToken.findFirst({
      where: { token: tokenHash, usedAt: null, expiresAt: { gt: new Date() } },
    });
    res.json({ valid: !!authToken, type: authToken?.type || null });
  } catch (err) {
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ── Email Verification ──────────────────────────────────────────────────────

router.post('/send-verification', requireAuth, async (req: AuthRequest, res: Response) => {
  try {
    const user = await prisma.user.findUnique({ where: { id: req.user!.id } });
    if (!user) return res.status(404).json({ error: 'User not found' });
    if (user.emailVerified) return res.json({ message: 'Email already verified' });

    await prisma.authToken.updateMany({
      where: { userId: user.id, type: 'email_verification', usedAt: null },
      data: { usedAt: new Date() },
    });

    const token = crypto.randomBytes(32).toString('hex');
    const tokenHash = crypto.createHash('sha256').update(token).digest('hex');
    await prisma.authToken.create({
      data: {
        userId: user.id,
        token: tokenHash,
        type: 'email_verification',
        expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
      },
    });

    const verifyUrl = `${WEB_URL}/verify-email?token=${token}`;
    const emailResult = await sendEmail(user.email, 'Verify your Origin email', `
      <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; max-width: 480px; margin: 0 auto; padding: 40px 20px;">
        <div style="text-align: center; margin-bottom: 32px;">
          <h1 style="color: #f3f4f6; font-size: 24px; margin: 0;">Origin</h1>
        </div>
        <div style="background: #111827; border: 1px solid #1f2937; border-radius: 12px; padding: 32px;">
          <h2 style="color: #f3f4f6; font-size: 18px; margin: 0 0 12px;">Verify your email</h2>
          <p style="color: #9ca3af; font-size: 14px; line-height: 1.6; margin: 0 0 24px;">
            Welcome to Origin! Click the button below to verify your email address.
          </p>
          <a href="${verifyUrl}" style="display: inline-block; background: #10b981; color: white; text-decoration: none; padding: 12px 24px; border-radius: 8px; font-size: 14px; font-weight: 500;">
            Verify Email
          </a>
          <p style="color: #6b7280; font-size: 12px; margin: 24px 0 0;">
            This link expires in 24 hours.
          </p>
        </div>
      </div>
    `);
    if (!emailResult.success) {
      console.error('Email send failed:', emailResult.error);
      return res.status(503).json({ error: emailResult.error || 'Email service not configured. Set RESEND_API_KEY.' });
    }
    res.json({ message: 'Verification email sent' });
  } catch (err) {
    console.error('Send verification error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

router.post('/verify-email', async (req: AuthRequest, res: Response) => {
  try {
    const { token } = req.body;
    if (!token) return res.status(400).json({ error: 'Token is required' });
    const tokenHash = crypto.createHash('sha256').update(token).digest('hex');
    const authToken = await prisma.authToken.findFirst({
      where: { token: tokenHash, type: 'email_verification', usedAt: null, expiresAt: { gt: new Date() } },
    });
    if (!authToken) return res.status(400).json({ error: 'Invalid or expired verification link' });
    await prisma.user.update({ where: { id: authToken.userId }, data: { emailVerified: true } });
    await prisma.authToken.update({ where: { id: authToken.id }, data: { usedAt: new Date() } });
    res.json({ message: 'Email verified successfully' });
  } catch (err) {
    console.error('Verify email error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ── OAuth ────────────────────────────────────────────────────────────────────

const OAUTH_PROVIDERS: Record<string, {
  authorizeUrl: string;
  tokenUrl: string;
  userUrl: string;
  scopes: string;
  clientIdEnv: string;
  clientSecretEnv: string;
}> = {
  github: {
    authorizeUrl: 'https://github.com/login/oauth/authorize',
    tokenUrl: 'https://github.com/login/oauth/access_token',
    userUrl: 'https://api.github.com/user',
    scopes: 'read:user user:email',
    clientIdEnv: 'GITHUB_CLIENT_ID',
    clientSecretEnv: 'GITHUB_CLIENT_SECRET',
  },
  gitlab: {
    authorizeUrl: 'https://gitlab.com/oauth/authorize',
    tokenUrl: 'https://gitlab.com/oauth/token',
    userUrl: 'https://gitlab.com/api/v4/user',
    scopes: 'read_user',
    clientIdEnv: 'GITLAB_CLIENT_ID',
    clientSecretEnv: 'GITLAB_CLIENT_SECRET',
  },
  google: {
    authorizeUrl: 'https://accounts.google.com/o/oauth2/v2/auth',
    tokenUrl: 'https://oauth2.googleapis.com/token',
    userUrl: 'https://www.googleapis.com/oauth2/v2/userinfo',
    scopes: 'openid email profile',
    clientIdEnv: 'GOOGLE_CLIENT_ID',
    clientSecretEnv: 'GOOGLE_CLIENT_SECRET',
  },
};

function getOAuthRedirectUri(provider: string) {
  const base = process.env.ORIGIN_WEB_URL || 'https://getorigin.io';
  return `${base}/auth/${provider}/callback`;
}

router.get('/oauth/:provider', (req: Request, res: Response) => {
  const provider = req.params.provider as string;
  const config = OAUTH_PROVIDERS[provider];
  if (!config) return res.status(400).json({ error: 'Unknown provider' });
  const clientId = process.env[config.clientIdEnv];
  if (!clientId) return res.status(500).json({ error: `${provider} OAuth not configured` });

  const state = crypto.randomUUID();
  res.cookie('oauth_state', state, {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    maxAge: 10 * 60 * 1000,
    path: '/',
  });

  const params = new URLSearchParams({
    client_id: clientId,
    redirect_uri: getOAuthRedirectUri(provider),
    scope: config.scopes,
    response_type: 'code',
    state,
  });
  if (provider === 'google') params.set('access_type', 'offline');
  res.json({ url: `${config.authorizeUrl}?${params.toString()}` });
});

router.post('/oauth/:provider/callback', async (req: Request, res: Response) => {
  const provider = req.params.provider as string;
  const config = OAUTH_PROVIDERS[provider];
  if (!config) return res.status(400).json({ error: 'Unknown provider' });

  const cookieState = req.cookies?.oauth_state;
  const { code, state: queryState, accountType: requestedAccountType } = req.body;
  if (!cookieState || !queryState || cookieState !== queryState) {
    return res.status(403).json({ error: 'OAuth state mismatch — possible CSRF' });
  }
  res.clearCookie('oauth_state', { path: '/' });
  if (!code) return res.status(400).json({ error: 'Authorization code required' });

  const clientId = process.env[config.clientIdEnv];
  const clientSecret = process.env[config.clientSecretEnv];
  if (!clientId || !clientSecret) return res.status(500).json({ error: `${provider} OAuth not configured` });

  try {
    const tokenBody: Record<string, string> = {
      client_id: clientId,
      client_secret: clientSecret,
      code,
      redirect_uri: getOAuthRedirectUri(provider),
    };
    if (provider === 'gitlab' || provider === 'google') tokenBody.grant_type = 'authorization_code';

    const tokenRes = await fetch(config.tokenUrl, {
      method: 'POST',
      headers: {
        'Content-Type': provider === 'github' ? 'application/json' : 'application/x-www-form-urlencoded',
        Accept: 'application/json',
      },
      body: provider === 'github' ? JSON.stringify(tokenBody) : new URLSearchParams(tokenBody).toString(),
    });
    const tokenData = await tokenRes.json() as any;
    const accessToken = tokenData.access_token;
    if (!accessToken) {
      console.error('OAuth token exchange failed:', tokenData);
      return res.status(400).json({ error: 'Failed to get access token from provider' });
    }

    const userRes = await fetch(config.userUrl, {
      headers: { Authorization: `Bearer ${accessToken}`, Accept: 'application/json' },
    });
    const profile = await userRes.json() as any;

    let email: string;
    let userName: string;
    let providerUserId: string;
    let avatarUrl: string | null = null;

    if (provider === 'github') {
      providerUserId = String(profile.id);
      userName = profile.name || profile.login;
      avatarUrl = profile.avatar_url || null;
      email = profile.email;
      if (!email) {
        const emailsRes = await fetch('https://api.github.com/user/emails', {
          headers: { Authorization: `Bearer ${accessToken}`, Accept: 'application/json' },
        });
        const emails = await emailsRes.json() as any[];
        const primary = emails.find((e: any) => e.primary && e.verified) || emails.find((e: any) => e.verified);
        email = primary?.email;
      }
    } else if (provider === 'gitlab') {
      providerUserId = String(profile.id);
      userName = profile.name || profile.username;
      email = profile.email;
      avatarUrl = profile.avatar_url || null;
    } else {
      providerUserId = profile.id;
      userName = profile.name;
      email = profile.email;
      avatarUrl = profile.picture || null;
    }
    if (!email) return res.status(400).json({ error: 'Could not get email from provider' });

    let user = await prisma.user.findFirst({ where: { provider, providerUserId } });
    let isNewAccount = false;
    let newApiKey = '';
    let activeOrgId: string | null = null;

    if (!user) {
      user = await prisma.user.findFirst({ where: { email } });
      if (user) {
        // Existing email account — link OAuth.
        user = await prisma.user.update({
          where: { id: user.id },
          data: { provider, providerUserId, avatarUrl: user.avatarUrl || avatarUrl },
        });
        const firstMembership = await prisma.membership.findFirst({
          where: { userId: user.id },
          orderBy: { joinedAt: 'asc' },
          select: { orgId: true },
        });
        activeOrgId = firstMembership?.orgId || null;
      } else {
        // Brand new user — create org + user + membership atomically.
        const isTeam = requestedAccountType === 'team';
        const slug = email.split('@')[0].replace(/[^a-z0-9-]/gi, '-').toLowerCase().slice(0, 30) + '-' + crypto.randomBytes(3).toString('hex');
        const passwordHash = await bcrypt.hash(crypto.randomBytes(32).toString('hex'), BCRYPT_COST);

        const created = await prisma.$transaction(async (tx) => {
          const org = await tx.org.create({
            data: {
              name: isTeam ? `${userName}'s org` : `${userName}'s workspace`,
              slug,
              type: isTeam ? 'team' : 'personal',
            },
          });
          const u = await tx.user.create({
            data: {
              email,
              name: userName,
              passwordHash,
              accountType: isTeam ? 'org' : 'developer',
              provider,
              providerUserId,
              avatarUrl,
              lastOrgId: org.id,
            },
          });
          await tx.membership.create({
            data: { userId: u.id, orgId: org.id, role: 'OWNER' },
          });
          await seedCatalogForOrg(org.id, tx);
          return { user: u, org };
        });
        user = created.user;
        activeOrgId = created.org.id;

        const rawKey = 'org_sk_' + crypto.randomBytes(24).toString('hex');
        const keyHash = crypto.createHash('sha256').update(rawKey).digest('hex');
        await prisma.apiKey.create({
          data: {
            orgId: created.org.id,
            userId: user.id,
            name: 'Default',
            keyHash,
            keyPrefix: rawKey.slice(0, 14),
          },
        });

        isNewAccount = true;
        newApiKey = rawKey;
      }
    } else {
      const firstMembership = await prisma.membership.findFirst({
        where: { userId: user.id },
        orderBy: { joinedAt: 'asc' },
        select: { orgId: true },
      });
      activeOrgId = firstMembership?.orgId || null;
    }

    const token = signToken(user.id);
    setAuthCookie(res, token);
    const payload = await buildAuthPayload(user.id, activeOrgId || undefined);

    res.json({
      token,
      ...(isNewAccount && newApiKey ? { apiKey: newApiKey, isNewAccount: true } : {}),
      ...payload,
    });
  } catch (err) {
    console.error(`OAuth ${provider} callback error:`, err);
    res.status(500).json({ error: 'OAuth authentication failed' });
  }
});

// ── SSE Token ──────────────────────────────────────────────────────────────

router.post('/sse-token', requireAuth, (req: AuthRequest, res: Response) => {
  const sseToken = generateSseToken({ id: req.user!.id });
  res.json({ token: sseToken });
});

export default router;
