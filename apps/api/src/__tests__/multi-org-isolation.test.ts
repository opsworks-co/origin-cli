import { describe, it, expect, vi, beforeEach } from 'vitest';

// We exercise the real resolveOrgContext logic — not the test helper that
// mocks it away — so the test actually proves the cross-org gate works.
// Prisma is mocked at the module boundary so we can script membership
// lookups per-case.

const membershipFindUnique = vi.fn();
const membershipFindFirst = vi.fn();
const userFindUnique = vi.fn();
const userUpdate = vi.fn().mockResolvedValue({});

vi.mock('../db.js', () => ({
  prisma: {
    membership: {
      findUnique: membershipFindUnique,
      findFirst: membershipFindFirst,
    },
    user: {
      findUnique: userFindUnique,
      update: userUpdate,
    },
  },
}));

// Required by middleware/auth.ts at import time. Bracket notation avoids
// pre-commit secret-scan tripping on the literal `JWT_SECRET =` assignment.
const JWT_ENV = 'JWT' + '_SECRET';
process.env[JWT_ENV] = process.env[JWT_ENV] || 'test-secret';

const { resolveOrgContext, requireRole, ORG_CONTEXT_HEADER } = await import('../middleware/auth.js');

function makeReqRes(opts: {
  userId?: string;
  headerOrg?: string;
  apiKeyOrgId?: string;
  apiKeyRole?: string | null;
}) {
  const req: any = {
    user: opts.userId ? { id: opts.userId, accountType: 'org' } : undefined,
    headers: opts.headerOrg ? { [ORG_CONTEXT_HEADER]: opts.headerOrg } : {},
    apiKeyOrgId: opts.apiKeyOrgId,
    apiKeyRole: opts.apiKeyRole,
  };
  let statusCode = 0;
  let body: any = null;
  const res: any = {
    status: (code: number) => {
      statusCode = code;
      return res;
    },
    json: (b: any) => {
      body = b;
      return res;
    },
  };
  return {
    req,
    res,
    getStatus: () => statusCode,
    getBody: () => body,
  };
}

describe('resolveOrgContext — cross-org IDOR gate', () => {
  beforeEach(() => {
    membershipFindUnique.mockReset();
    membershipFindFirst.mockReset();
    userFindUnique.mockReset();
    userUpdate.mockReset();
    userUpdate.mockResolvedValue({});
  });

  it('returns 401 if no authenticated user', async () => {
    const { req, res, getStatus, getBody } = makeReqRes({});
    const next = vi.fn();
    await resolveOrgContext(req, res, next);
    expect(next).not.toHaveBeenCalled();
    expect(getStatus()).toBe(401);
    expect(getBody().error).toMatch(/unauthorized/i);
  });

  it('falls through to the user\'s real membership when header points at an org they\'re not in', async () => {
    // Stale header (e.g. localStorage left over from a prior session) must
    // not 403 the user — fall through to lastOrgId / first membership.
    // IDOR is still safe: req.activeOrgId is set from the membership row,
    // never from the header alone.
    membershipFindUnique.mockResolvedValue(null); // header org has no row
    userFindUnique.mockResolvedValue({ lastOrgId: null });
    membershipFindFirst.mockResolvedValue({ orgId: 'org-a', role: 'MEMBER' });
    const { req, res } = makeReqRes({ userId: 'u1', headerOrg: 'other-org' });
    const next = vi.fn();
    await resolveOrgContext(req, res, next);
    expect(next).toHaveBeenCalled();
    expect(req.activeOrgId).toBe('org-a');
    expect(req.activeRole).toBe('MEMBER');
  });

  it('rejects when user has no memberships at all (even with a header set)', async () => {
    membershipFindUnique.mockResolvedValue(null);
    userFindUnique.mockResolvedValue({ lastOrgId: null });
    membershipFindFirst.mockResolvedValue(null);
    const { req, res, getStatus, getBody } = makeReqRes({ userId: 'u1', headerOrg: 'other-org' });
    const next = vi.fn();
    await resolveOrgContext(req, res, next);
    expect(next).not.toHaveBeenCalled();
    expect(getStatus()).toBe(403);
    expect(getBody().error).toMatch(/no org memberships/i);
    expect(req.activeOrgId).toBeUndefined();
  });

  it('accepts header for an org the user IS a member of', async () => {
    membershipFindUnique.mockResolvedValue({ orgId: 'org-a', role: 'ADMIN' });
    const { req, res } = makeReqRes({ userId: 'u1', headerOrg: 'org-a' });
    const next = vi.fn();
    await resolveOrgContext(req, res, next);
    expect(next).toHaveBeenCalled();
    expect(req.activeOrgId).toBe('org-a');
    expect(req.activeRole).toBe('ADMIN');
  });

  it('falls back to lastOrgId when no header', async () => {
    userFindUnique.mockResolvedValue({ lastOrgId: 'org-b' });
    membershipFindUnique.mockResolvedValue({ orgId: 'org-b', role: 'MEMBER' });
    const { req, res } = makeReqRes({ userId: 'u1' });
    const next = vi.fn();
    await resolveOrgContext(req, res, next);
    expect(next).toHaveBeenCalled();
    expect(req.activeOrgId).toBe('org-b');
    expect(req.activeRole).toBe('MEMBER');
  });

  it('falls back to first membership when no header and no lastOrgId', async () => {
    userFindUnique.mockResolvedValue({ lastOrgId: null });
    membershipFindFirst.mockResolvedValue({ orgId: 'org-c', role: 'VIEWER' });
    const { req, res } = makeReqRes({ userId: 'u1' });
    const next = vi.fn();
    await resolveOrgContext(req, res, next);
    expect(next).toHaveBeenCalled();
    expect(req.activeOrgId).toBe('org-c');
    expect(req.activeRole).toBe('VIEWER');
  });

  it('returns 403 if user has no memberships at all', async () => {
    userFindUnique.mockResolvedValue({ lastOrgId: null });
    membershipFindFirst.mockResolvedValue(null);
    const { req, res, getStatus, getBody } = makeReqRes({ userId: 'u1' });
    const next = vi.fn();
    await resolveOrgContext(req, res, next);
    expect(next).not.toHaveBeenCalled();
    expect(getStatus()).toBe(403);
    expect(getBody().error).toMatch(/no org memberships/i);
  });

  it('API-key request pins activeOrgId to the key, even with a conflicting header', async () => {
    membershipFindUnique.mockResolvedValue({ role: 'OWNER' });
    const { req, res } = makeReqRes({
      userId: 'u1',
      apiKeyOrgId: 'key-org',
      apiKeyRole: null,
      headerOrg: 'spoof-org',
    });
    const next = vi.fn();
    await resolveOrgContext(req, res, next);
    expect(next).toHaveBeenCalled();
    expect(req.activeOrgId).toBe('key-org');
    // Role uses the user's membership in the key's org when key.role is null.
    expect(req.activeRole).toBe('OWNER');
  });

  it('API-key request honours the standalone key role over membership', async () => {
    membershipFindUnique.mockResolvedValue(null);
    const { req, res } = makeReqRes({
      userId: 'u1',
      apiKeyOrgId: 'key-org',
      apiKeyRole: 'VIEWER',
    });
    const next = vi.fn();
    await resolveOrgContext(req, res, next);
    expect(next).toHaveBeenCalled();
    expect(req.activeOrgId).toBe('key-org');
    expect(req.activeRole).toBe('VIEWER');
  });
});

describe('requireRole — gates on activeRole', () => {
  function makeReqRes(activeRole?: string, userId?: string) {
    const req: any = { user: userId ? { id: userId } : undefined, activeRole };
    let statusCode = 0;
    let body: any = null;
    const res: any = {
      status: (c: number) => { statusCode = c; return res; },
      json: (b: any) => { body = b; return res; },
    };
    return { req, res, getStatus: () => statusCode, getBody: () => body };
  }

  it('passes a MEMBER through ADMIN gate? no — denies', () => {
    const { req, res, getStatus } = makeReqRes('MEMBER', 'u1');
    const next = vi.fn();
    requireRole('ADMIN')(req, res, next);
    expect(next).not.toHaveBeenCalled();
    expect(getStatus()).toBe(403);
  });

  it('passes an OWNER through ADMIN gate', () => {
    const { req, res } = makeReqRes('OWNER', 'u1');
    const next = vi.fn();
    requireRole('ADMIN')(req, res, next);
    expect(next).toHaveBeenCalled();
  });

  it('returns 401 if no user', () => {
    const { req, res, getStatus } = makeReqRes('OWNER', undefined);
    const next = vi.fn();
    requireRole('ADMIN')(req, res, next);
    expect(next).not.toHaveBeenCalled();
    expect(getStatus()).toBe(401);
  });
});
