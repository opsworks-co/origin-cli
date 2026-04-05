import { Router, Response } from 'express';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import crypto from 'crypto';
import { prisma } from '../db.js';
import { AuthRequest, requireAuth } from '../middleware/auth.js';

const router = Router();
function requireEnv(name: string): string {
  const val = process.env[name];
  if (!val) throw new Error(`FATAL: ${name} environment variable is required.`);
  return val;
}
const JWT_SECRET = requireEnv('JWT_SECRET');

// Simple in-memory rate limiter for login
const loginAttempts = new Map<string, { count: number; resetAt: number }>();
const MAX_LOGIN_ATTEMPTS = 10;
const LOGIN_WINDOW_MS = 15 * 60 * 1000; // 15 minutes

// Periodically clean up expired rate limit entries to prevent memory leak
setInterval(() => {
  const now = Date.now();
  for (const [ip, entry] of loginAttempts) {
    if (now > entry.resetAt) loginAttempts.delete(ip);
  }
}, 60_000).unref();

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
      user: { id: user.id, email: user.email, name: user.name, role: user.role, accountType: 'org', orgId: org.id, orgName: org.name, orgSlug: org.slug },
    });
  } catch (err) {
    console.error('Register error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// POST /register/developer — create a developer account (personal workspace, no org setup)
router.post('/register/developer', async (req: AuthRequest, res: Response) => {
  try {
    const { email, password, name } = req.body;

    if (!email || !password || !name) {
      return res.status(400).json({ error: 'Missing required fields' });
    }

    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      return res.status(400).json({ error: 'Invalid email format' });
    }

    if (password.length < 8) {
      return res.status(400).json({ error: 'Password must be at least 8 characters' });
    }

    const existingUser = await prisma.user.findUnique({ where: { email } });
    if (existingUser) {
      return res.status(409).json({ error: 'Email already registered' });
    }

    // Auto-generate a personal workspace
    const baseSlug = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'dev';
    let slug = `${baseSlug}-personal`;
    let attempt = 0;
    while (await prisma.org.findUnique({ where: { slug } })) {
      attempt++;
      slug = `${baseSlug}-personal-${attempt}`;
    }

    const passwordHash = await bcrypt.hash(password, 10);

    const org = await prisma.org.create({
      data: { name: `${name}'s workspace`, slug },
    });

    const user = await prisma.user.create({
      data: {
        orgId: org.id,
        email,
        name,
        passwordHash,
        role: 'OWNER',
        accountType: 'developer',
      },
    });

    // Auto-generate an API key for solo developer
    const rawKey = `org_${crypto.randomBytes(32).toString('hex')}`;
    const keyHash = crypto.createHash('sha256').update(rawKey).digest('hex');
    const keyPrefix = rawKey.slice(0, 12) + '...';

    await prisma.apiKey.create({
      data: {
        orgId: org.id,
        userId: user.id,
        name: 'Personal key',
        keyHash,
        keyPrefix,
        keyType: 'solo',
      },
    });

    const token = signToken({ id: user.id, orgId: org.id, role: user.role });

    res.status(201).json({
      token,
      user: { id: user.id, email: user.email, name: user.name, role: user.role, accountType: 'developer', orgId: org.id, orgName: org.name, orgSlug: org.slug },
      apiKey: rawKey,
    });
  } catch (err) {
    console.error('Register developer error:', err);
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
      user: { id: user.id, email: user.email, name: user.name, role: user.role, accountType: user.accountType, orgId: user.orgId, orgName: user.org.name, orgSlug: user.org.slug },
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
      accountType: user.accountType,
      avatarUrl: user.avatarUrl,
      orgId: user.orgId,
      orgName: user.org.name,
      orgSlug: user.org.slug,
    });
  } catch (err) {
    console.error('Me error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// PATCH /profile — update current user's profile (name, email, avatarUrl)
router.patch('/profile', requireAuth, async (req: AuthRequest, res: Response) => {
  try {
    const { name, email, avatarUrl } = req.body;
    const data: any = {};
    if (typeof name === 'string' && name.trim()) data.name = name.trim();
    if (typeof email === 'string' && email.trim()) {
      // Check email uniqueness
      const existing = await prisma.user.findFirst({ where: { email: email.trim(), id: { not: req.user!.id } } });
      if (existing) return res.status(409).json({ error: 'Email already in use' });
      data.email = email.trim();
    }
    if (typeof avatarUrl === 'string') data.avatarUrl = avatarUrl || null;

    if (Object.keys(data).length === 0) {
      return res.status(400).json({ error: 'No fields to update' });
    }

    const user = await prisma.user.update({
      where: { id: req.user!.id },
      data,
      include: { org: true },
    });

    res.json({
      id: user.id,
      email: user.email,
      name: user.name,
      role: user.role,
      accountType: user.accountType,
      avatarUrl: user.avatarUrl,
      orgId: user.orgId,
      orgName: user.org.name,
      orgSlug: user.org.slug,
    });
  } catch (err) {
    console.error('Profile update error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// POST /accept-invite — accept invitation and create account (public, no auth)
router.post('/accept-invite', async (req: AuthRequest, res: Response) => {
  try {
    const { token, name, email, password } = req.body;

    if (!token || !name || !email || !password) {
      return res.status(400).json({ error: 'Missing required fields: token, name, email, password' });
    }

    if (password.length < 8) {
      return res.status(400).json({ error: 'Password must be at least 8 characters' });
    }

    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      return res.status(400).json({ error: 'Invalid email format' });
    }

    // Find valid invitation
    const invitation = await prisma.invitation.findFirst({
      where: {
        token,
        usedAt: null,
        expiresAt: { gt: new Date() },
      },
      include: { org: true },
    });

    if (!invitation) {
      return res.status(404).json({ error: 'Invalid or expired invitation link' });
    }

    // If invitation has a specific email, enforce it
    if (invitation.email && invitation.email.toLowerCase() !== email.toLowerCase()) {
      return res.status(400).json({ error: 'This invitation was sent to a different email address' });
    }

    // Check if email already registered
    const existingUser = await prisma.user.findUnique({ where: { email } });

    let user;

    if (existingUser) {
      // Existing user — verify password, then move/add to invited org
      const valid = await bcrypt.compare(password, existingUser.passwordHash);
      if (!valid) {
        return res.status(401).json({ error: 'Incorrect password. Enter the password for your existing account to join.' });
      }

      // Update user to the invited org with the invited role
      user = await prisma.user.update({
        where: { id: existingUser.id },
        data: {
          orgId: invitation.orgId,
          role: invitation.role,
          name: name || existingUser.name,
        },
      });
    } else {
      // New user — create account
      const passwordHash = await bcrypt.hash(password, 10);
      user = await prisma.user.create({
        data: {
          orgId: invitation.orgId,
          email,
          name,
          passwordHash,
          role: invitation.role,
        },
      });
    }

    // Mark invitation as used
    await prisma.invitation.update({
      where: { id: invitation.id },
      data: { usedAt: new Date(), usedBy: user.id },
    });

    // Audit log
    await prisma.auditLog.create({
      data: {
        orgId: invitation.orgId,
        userId: user.id,
        action: 'INVITATION_ACCEPTED',
        resource: invitation.id,
        metadata: JSON.stringify({ email, role: invitation.role, existingUser: !!existingUser }),
      },
    });

    // When accepting an invite, user becomes an org member
    const updatedUser = await prisma.user.update({
      where: { id: user.id },
      data: { accountType: 'org' },
    });

    const jwtToken = signToken({ id: user.id, orgId: invitation.orgId, role: updatedUser.role });

    res.status(201).json({
      token: jwtToken,
      user: {
        id: user.id,
        email: user.email,
        name: user.name,
        role: updatedUser.role,
        accountType: 'org',
        orgId: invitation.orgId,
        orgName: invitation.org.name,
        orgSlug: invitation.org.slug,
      },
    });
  } catch (err) {
    console.error('Accept invite error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// GET /invite/:token — get invitation info (public, no auth)
router.get('/invite/:token', async (req: AuthRequest, res: Response) => {
  try {
    const { token } = req.params;
    const invitation = await prisma.invitation.findFirst({
      where: {
        token: token as string,
        usedAt: null,
        expiresAt: { gt: new Date() },
      },
      include: { org: { select: { name: true, slug: true } } },
    });

    if (!invitation) {
      return res.status(404).json({ error: 'Invalid or expired invitation' });
    }

    res.json({
      orgName: invitation.org.name,
      role: invitation.role,
      email: invitation.email,
    });
  } catch (err) {
    console.error('Get invite info error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// POST /api-keys — create an API key
router.post('/api-keys', requireAuth, async (req: AuthRequest, res: Response) => {
  try {
    const { name, repoIds, agentIds } = req.body;

    // Validate repoIds belong to this org
    if (repoIds && Array.isArray(repoIds) && repoIds.length > 0) {
      const validRepos = await prisma.repo.findMany({
        where: { orgId: req.user!.orgId, id: { in: repoIds } },
        select: { id: true },
      });
      if (validRepos.length !== repoIds.length) {
        return res.status(400).json({ error: 'One or more repos do not belong to your organization' });
      }
    }

    // Validate agentIds belong to this org
    if (agentIds && Array.isArray(agentIds) && agentIds.length > 0) {
      const validAgents = await prisma.agent.findMany({
        where: { orgId: req.user!.orgId, id: { in: agentIds } },
        select: { id: true },
      });
      if (validAgents.length !== agentIds.length) {
        return res.status(400).json({ error: 'One or more agents do not belong to your organization' });
      }
    }

    // Generate a random API key
    const rawKey = `org_${crypto.randomBytes(32).toString('hex')}`;
    const keyHash = crypto.createHash('sha256').update(rawKey).digest('hex');
    const keyPrefix = rawKey.slice(0, 12) + '...';

    const apiKey = await prisma.apiKey.create({
      data: {
        orgId: req.user!.orgId,
        userId: req.user!.id,
        name: name || 'Unnamed key',
        keyHash,
        keyPrefix,
        repoScopes: {
          create: (repoIds && Array.isArray(repoIds) ? repoIds : []).map((repoId: string) => ({ repoId })),
        },
        agentScopes: {
          create: (agentIds && Array.isArray(agentIds) ? agentIds : []).map((agentId: string) => ({ agentId })),
        },
      },
      include: {
        repoScopes: { include: { repo: { select: { id: true, name: true } } } },
        agentScopes: { include: { agent: { select: { id: true, name: true, slug: true } } } },
      },
    });

    await prisma.auditLog.create({
      data: {
        orgId: req.user!.orgId,
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

// GET /api-keys — list API keys
router.get('/api-keys', requireAuth, async (req: AuthRequest, res: Response) => {
  try {
    const keys = await prisma.apiKey.findMany({
      where: { orgId: req.user!.orgId },
      select: {
        id: true, name: true, keyPrefix: true, createdAt: true,
        userId: true,
        user: { select: { name: true, email: true } },
        repoScopes: { include: { repo: { select: { id: true, name: true } } } },
        agentScopes: { include: { agent: { select: { id: true, name: true, slug: true } } } },
      },
      orderBy: { createdAt: 'desc' },
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

// GET /oauth/:provider — redirect to provider's OAuth consent screen
router.get('/oauth/:provider', (req: AuthRequest, res: Response) => {
  const provider = req.params.provider as string;
  const config = OAUTH_PROVIDERS[provider];
  if (!config) return res.status(400).json({ error: 'Unknown provider' });

  const clientId = process.env[config.clientIdEnv];
  if (!clientId) return res.status(500).json({ error: `${provider} OAuth not configured` });

  const params = new URLSearchParams({
    client_id: clientId,
    redirect_uri: getOAuthRedirectUri(provider),
    scope: config.scopes,
    response_type: 'code',
    state: crypto.randomBytes(16).toString('hex'),
  });

  // Google needs access_type for refresh tokens
  if (provider === 'google') params.set('access_type', 'offline');

  res.json({ url: `${config.authorizeUrl}?${params.toString()}` });
});

// POST /oauth/:provider/callback — exchange code for token, find or create user
router.post('/oauth/:provider/callback', async (req: AuthRequest, res: Response) => {
  const provider = req.params.provider as string;
  const config = OAUTH_PROVIDERS[provider];
  if (!config) return res.status(400).json({ error: 'Unknown provider' });

  const { code, accountType: requestedAccountType } = req.body;
  if (!code) return res.status(400).json({ error: 'Authorization code required' });

  const clientId = process.env[config.clientIdEnv];
  const clientSecret = process.env[config.clientSecretEnv];
  if (!clientId || !clientSecret) return res.status(500).json({ error: `${provider} OAuth not configured` });

  try {
    // 1. Exchange code for access token
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

    // 2. Fetch user profile from provider
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
      // GitHub may not return email in profile if it's private — fetch from /user/emails
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
      // Google
      providerUserId = profile.id;
      userName = profile.name;
      email = profile.email;
      avatarUrl = profile.picture || null;
    }

    if (!email) return res.status(400).json({ error: 'Could not get email from provider' });

    // 3. Find existing user by provider ID, or by email
    let user = await prisma.user.findFirst({
      where: { provider, providerUserId },
      include: { org: true },
    });

    if (!user) {
      // Check if email already exists (link OAuth to existing account)
      user = await prisma.user.findFirst({
        where: { email },
        include: { org: true },
      });

      if (user) {
        // Link OAuth provider to existing account
        user = await prisma.user.update({
          where: { id: user.id },
          data: { provider, providerUserId, avatarUrl: user.avatarUrl || avatarUrl },
          include: { org: true },
        });
      } else {
        // Create new account (developer by default, or team if requested)
        const isTeam = requestedAccountType === 'team';
        const slug = email.split('@')[0].replace(/[^a-z0-9-]/gi, '-').toLowerCase().slice(0, 30) + '-' + crypto.randomBytes(3).toString('hex');
        const org = await prisma.org.create({
          data: { name: isTeam ? `${userName}'s org` : `${userName}'s workspace`, slug },
        });

        const passwordHash = await bcrypt.hash(crypto.randomBytes(32).toString('hex'), 10);
        user = await prisma.user.create({
          data: {
            orgId: org.id,
            email,
            name: userName,
            passwordHash,
            role: 'OWNER',
            accountType: isTeam ? 'org' : 'developer',
            provider,
            providerUserId,
            avatarUrl,
          },
          include: { org: true },
        });

        // Auto-generate API key for new OAuth user
        const rawKey = `org_${crypto.randomBytes(32).toString('hex')}`;
        const keyHash = crypto.createHash('sha256').update(rawKey).digest('hex');
        await prisma.apiKey.create({
          data: {
            orgId: org.id,
            userId: user.id,
            name: 'Default',
            keyHash,
            keyPrefix: rawKey.slice(0, 12),
            keyType: 'solo',
          },
        });
      }
    }

    const token = signToken({ id: user.id, orgId: user.orgId, role: user.role });
    res.json({
      token,
      user: {
        id: user.id,
        email: user.email,
        name: user.name,
        role: user.role,
        accountType: user.accountType,
        avatarUrl: user.avatarUrl,
        orgId: user.orgId,
        orgName: user.org.name,
        orgSlug: user.org.slug,
      },
    });
  } catch (err) {
    console.error(`OAuth ${provider} callback error:`, err);
    res.status(500).json({ error: 'OAuth authentication failed' });
  }
});

export default router;
