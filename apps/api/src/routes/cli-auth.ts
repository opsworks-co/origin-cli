// ── CLI device-code login (RFC 8628 style) ─────────────────────────────
//
// `origin login` (no args) drives this flow so users don't have to copy
// API keys around manually:
//
//  1. CLI POSTs /start, gets a userCode + deviceCode + verificationUrl,
//     and prints the URL for the user to open.
//  2. User opens /cli-link?code=USER-CODE in the browser, sees who's
//     asking and which workspace they're authenticating, hits Approve.
//     Server mints an API key linked to the signed-in user and stashes
//     it on the pending request keyed by deviceCode.
//  3. CLI polls /poll with deviceCode, picks up the key when approved,
//     writes it to ~/.origin/config.json. No copy/paste.
//
// State is held in-memory because the Fly app runs on a single machine
// and the codes are short-lived (5 min). Crash = user re-runs `origin
// login`. Adding a DB-backed table would be cheap if we ever scale out
// horizontally; for now an in-process Map keeps the surface tiny.

import crypto from 'crypto';
import { Router, Request, Response } from 'express';
import { prisma } from '../db.js';
import { AuthRequest, requireAuth, resolveOrgContext } from '../middleware/auth.js';

const router = Router();

interface PendingDeviceAuth {
  deviceCode: string;
  userCode: string; // Human-friendly e.g. "WXYZ-AB12"
  status: 'pending' | 'approved' | 'denied';
  apiKey?: string;
  orgId?: string;
  orgName?: string;
  apiUrl?: string;
  keyType?: 'solo' | 'team';
  accountType?: 'developer' | 'org';
  approvedBy?: { userId: string; email: string };
  expiresAt: number; // epoch ms
}

const pending = new Map<string, PendingDeviceAuth>();
const userCodeIndex = new Map<string, string>(); // userCode → deviceCode

// Sweep expired entries every minute. Cheap, single-machine, no cron.
setInterval(() => {
  const now = Date.now();
  for (const [deviceCode, entry] of pending.entries()) {
    if (entry.expiresAt < now) {
      pending.delete(deviceCode);
      userCodeIndex.delete(entry.userCode);
    }
  }
}, 60_000).unref?.();

// Human-friendly user code: 8 chars from a base32-ish alphabet that
// avoids visually ambiguous glyphs (no 0/O, 1/I/L). Hyphenated for
// easier reading and typing if the user has to.
function generateUserCode(): string {
  const alphabet = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
  let s = '';
  const bytes = crypto.randomBytes(8);
  for (let i = 0; i < 8; i++) s += alphabet[bytes[i] % alphabet.length];
  return `${s.slice(0, 4)}-${s.slice(4)}`;
}

// ── POST /start ─────────────────────────────────────────────────────────
// CLI calls this to begin device-code flow. No auth required; user
// authenticates by opening the verification URL in their browser.
router.post('/start', async (req: Request, res: Response) => {
  const deviceCode = crypto.randomBytes(32).toString('hex');
  let userCode = generateUserCode();
  // Defensive: avoid the astronomically unlikely collision rather than
  // silently overwriting.
  while (userCodeIndex.has(userCode)) userCode = generateUserCode();

  const expiresInSec = 600; // 10 minutes — enough to read the screen, open the browser, log in
  const entry: PendingDeviceAuth = {
    deviceCode,
    userCode,
    status: 'pending',
    expiresAt: Date.now() + expiresInSec * 1000,
  };
  pending.set(deviceCode, entry);
  userCodeIndex.set(userCode, deviceCode);

  const baseUrl = process.env.BASE_URL || 'https://getorigin.io';
  res.json({
    deviceCode,
    userCode,
    verificationUrl: `${baseUrl}/cli-link?code=${encodeURIComponent(userCode)}`,
    expiresIn: expiresInSec,
    interval: 3, // CLI poll interval in seconds
  });
});

// ── GET /lookup?code=USER-CODE ─────────────────────────────────────────
// Frontend calls this from /cli-link to render the approval card. No
// auth required to look up a code (the userCode itself is the
// secret-ish handle); approval still requires a logged-in user.
router.get('/lookup', async (req: Request, res: Response) => {
  const userCode = ((req.query.code as string) || '').toUpperCase().trim();
  if (!userCode) return res.status(400).json({ error: 'Missing code' });
  const deviceCode = userCodeIndex.get(userCode);
  if (!deviceCode) return res.status(404).json({ error: 'Code not found or expired' });
  const entry = pending.get(deviceCode);
  if (!entry || entry.expiresAt < Date.now()) {
    return res.status(404).json({ error: 'Code expired' });
  }
  res.json({
    userCode: entry.userCode,
    status: entry.status,
    expiresAt: new Date(entry.expiresAt).toISOString(),
  });
});

// ── POST /approve ──────────────────────────────────────────────────────
// Frontend calls this when the user clicks "Approve" on /cli-link.
// Mints a new API key in the user's active org and stashes it on the
// pending request for the CLI to pick up via /poll.
router.post('/approve', requireAuth, resolveOrgContext, async (req: AuthRequest, res: Response) => {
  const { userCode } = req.body || {};
  if (typeof userCode !== 'string' || !userCode.trim()) {
    return res.status(400).json({ error: 'Missing userCode' });
  }
  const deviceCode = userCodeIndex.get(userCode.toUpperCase().trim());
  if (!deviceCode) return res.status(404).json({ error: 'Code not found or expired' });
  const entry = pending.get(deviceCode);
  if (!entry || entry.expiresAt < Date.now()) {
    return res.status(404).json({ error: 'Code expired — re-run `origin login`' });
  }
  if (entry.status !== 'pending') {
    return res.status(409).json({ error: `Already ${entry.status}` });
  }

  // Mint a fresh API key linked to the approving user, in their active
  // org. Same shape as /api/settings/api-keys POST so the rest of the
  // CLI plumbing (whoami, scopes, role) keeps working.
  const rawKey = 'org_sk_' + crypto.randomBytes(24).toString('hex');
  const keyHash = crypto.createHash('sha256').update(rawKey).digest('hex');
  const keyPrefix = rawKey.slice(0, 14);
  const orgId = req.activeOrgId!;
  const userId = req.user!.id;

  const [org, user] = await Promise.all([
    prisma.org.findUnique({ where: { id: orgId }, select: { name: true, type: true } }),
    prisma.user.findUnique({ where: { id: userId }, select: { email: true, accountType: true } }),
  ]);
  if (!org) return res.status(404).json({ error: 'Org not found' });

  await prisma.apiKey.create({
    data: {
      orgId,
      userId,
      name: 'CLI (device login)',
      keyHash,
      keyPrefix,
    },
  });
  await prisma.auditLog.create({
    data: {
      orgId,
      userId,
      action: 'CLI_DEVICE_LOGIN_APPROVED',
      resource: 'apiKey',
      metadata: JSON.stringify({ userCode, keyPrefix }),
    },
  }).catch(() => { /* audit best-effort */ });

  const apiUrl = process.env.BASE_URL || 'https://getorigin.io';
  entry.status = 'approved';
  entry.apiKey = rawKey;
  entry.orgId = orgId;
  entry.orgName = org.name;
  entry.apiUrl = apiUrl;
  entry.keyType = (user?.accountType === 'developer' || org.type === 'personal') ? 'solo' : 'team';
  entry.accountType = user?.accountType === 'developer' ? 'developer' : 'org';
  entry.approvedBy = { userId, email: user?.email || '' };

  res.json({ success: true });
});

// ── POST /deny ──────────────────────────────────────────────────────────
// User can reject a pending request from the browser.
router.post('/deny', requireAuth, async (req: AuthRequest, res: Response) => {
  const { userCode } = req.body || {};
  if (typeof userCode !== 'string') return res.status(400).json({ error: 'Missing userCode' });
  const deviceCode = userCodeIndex.get(userCode.toUpperCase().trim());
  if (!deviceCode) return res.status(404).json({ error: 'Code not found' });
  const entry = pending.get(deviceCode);
  if (!entry) return res.status(404).json({ error: 'Code not found' });
  entry.status = 'denied';
  res.json({ success: true });
});

// ── POST /poll ─────────────────────────────────────────────────────────
// CLI polls this with the deviceCode. We delete the entry on first
// successful read so the api key is one-shot.
router.post('/poll', async (req: Request, res: Response) => {
  const { deviceCode } = req.body || {};
  if (typeof deviceCode !== 'string' || !deviceCode) {
    return res.status(400).json({ error: 'Missing deviceCode' });
  }
  const entry = pending.get(deviceCode);
  if (!entry) return res.status(404).json({ error: 'Unknown or expired deviceCode' });
  if (entry.expiresAt < Date.now()) {
    pending.delete(deviceCode);
    userCodeIndex.delete(entry.userCode);
    return res.status(410).json({ status: 'expired' });
  }
  if (entry.status === 'pending') {
    return res.status(202).json({ status: 'pending' });
  }
  if (entry.status === 'denied') {
    pending.delete(deviceCode);
    userCodeIndex.delete(entry.userCode);
    return res.status(403).json({ status: 'denied' });
  }
  // Approved — return the key once, then drop the entry.
  const out = {
    status: 'approved',
    apiKey: entry.apiKey,
    orgId: entry.orgId,
    orgName: entry.orgName,
    apiUrl: entry.apiUrl,
    keyType: entry.keyType,
    accountType: entry.accountType,
  };
  pending.delete(deviceCode);
  userCodeIndex.delete(entry.userCode);
  res.json(out);
});

export default router;
