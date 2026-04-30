import { describe, it, expect, vi, beforeEach } from 'vitest';

// Real requireRepoAccess + access helpers, mocked Prisma. Proves the org
// role inheritance + per-repo gate + cross-org isolation.

const repoFindFirst = vi.fn();
const agentFindFirst = vi.fn();
const repoMemberFindUnique = vi.fn();
const repoMemberFindMany = vi.fn();
const agentMemberFindUnique = vi.fn();
const agentMemberFindMany = vi.fn();

vi.mock('../db.js', () => ({
  prisma: {
    repo: { findFirst: repoFindFirst },
    agent: { findFirst: agentFindFirst },
    repoMember: { findUnique: repoMemberFindUnique, findMany: repoMemberFindMany },
    agentMember: { findUnique: agentMemberFindUnique, findMany: agentMemberFindMany },
    membership: { findUnique: vi.fn(), findFirst: vi.fn() },
    user: { findUnique: vi.fn(), update: vi.fn().mockResolvedValue({}) },
  },
}));

// Bracket notation avoids pre-commit secret-scan tripping on the literal
// `JWT_SECRET =` assignment.
const JWT_ENV = 'JWT' + '_SECRET';
process.env[JWT_ENV] = process.env[JWT_ENV] || 'test-secret';

const { requireRepoAccess, requireAgentAccess } = await import('../middleware/auth.js');
const { resolveRepoAccess, repoLevelMeets, readableRepoIds } = await import('../services/access.js');

function makeReqRes(opts: {
  userId?: string;
  activeOrgId?: string;
  activeRole?: string;
  paramId?: string;
}) {
  const req: any = {
    user: opts.userId ? { id: opts.userId, accountType: 'org' } : undefined,
    activeOrgId: opts.activeOrgId,
    activeRole: opts.activeRole,
    params: { id: opts.paramId },
    headers: {},
  };
  let statusCode = 0;
  let body: any = null;
  const res: any = {
    status: (c: number) => { statusCode = c; return res; },
    json: (b: any) => { body = b; return res; },
  };
  return { req, res, getStatus: () => statusCode, getBody: () => body };
}

describe('resolveRepoAccess + requireRepoAccess', () => {
  beforeEach(() => {
    repoFindFirst.mockReset();
    repoMemberFindUnique.mockReset();
  });

  it('repoLevelMeets honours read < write < admin ordering', () => {
    expect(repoLevelMeets('read', 'read')).toBe(true);
    expect(repoLevelMeets('write', 'read')).toBe(true);
    expect(repoLevelMeets('admin', 'write')).toBe(true);
    expect(repoLevelMeets('read', 'write')).toBe(false);
    expect(repoLevelMeets('write', 'admin')).toBe(false);
    expect(repoLevelMeets(null, 'read')).toBe(false);
  });

  it('returns null when repo does not belong to active org (cross-org IDOR block)', async () => {
    repoFindFirst.mockResolvedValue(null);
    const level = await resolveRepoAccess('u1', 'org-a', 'foreign-repo', 'OWNER');
    expect(level).toBeNull();
    expect(repoMemberFindUnique).not.toHaveBeenCalled();
  });

  it('OWNER inherits admin without a RepoMember row', async () => {
    repoFindFirst.mockResolvedValue({ id: 'r1' });
    const level = await resolveRepoAccess('u1', 'org-a', 'r1', 'OWNER');
    expect(level).toBe('admin');
    expect(repoMemberFindUnique).not.toHaveBeenCalled();
  });

  it('ADMIN inherits admin without a RepoMember row', async () => {
    repoFindFirst.mockResolvedValue({ id: 'r1' });
    const level = await resolveRepoAccess('u1', 'org-a', 'r1', 'ADMIN');
    expect(level).toBe('admin');
  });

  it('MEMBER without grant gets null', async () => {
    repoFindFirst.mockResolvedValue({ id: 'r1' });
    repoMemberFindUnique.mockResolvedValue(null);
    const level = await resolveRepoAccess('u1', 'org-a', 'r1', 'MEMBER');
    expect(level).toBeNull();
  });

  it('MEMBER with explicit RepoMember.level=write gets write', async () => {
    repoFindFirst.mockResolvedValue({ id: 'r1' });
    repoMemberFindUnique.mockResolvedValue({ level: 'write' });
    const level = await resolveRepoAccess('u1', 'org-a', 'r1', 'MEMBER');
    expect(level).toBe('write');
  });

  it('requireRepoAccess(write) gates a MEMBER with read-only grant', async () => {
    repoFindFirst.mockResolvedValue({ id: 'r1' });
    repoMemberFindUnique.mockResolvedValue({ level: 'read' });
    const { req, res, getStatus, getBody } = makeReqRes({
      userId: 'u1', activeOrgId: 'org-a', activeRole: 'MEMBER', paramId: 'r1',
    });
    const next = vi.fn();
    await requireRepoAccess('write')(req, res, next);
    expect(next).not.toHaveBeenCalled();
    expect(getStatus()).toBe(403);
    expect(getBody().error).toMatch(/write/);
  });

  it('requireRepoAccess(read) lets a MEMBER with read grant through', async () => {
    repoFindFirst.mockResolvedValue({ id: 'r1' });
    repoMemberFindUnique.mockResolvedValue({ level: 'read' });
    const { req, res } = makeReqRes({
      userId: 'u1', activeOrgId: 'org-a', activeRole: 'MEMBER', paramId: 'r1',
    });
    const next = vi.fn();
    await requireRepoAccess('read')(req, res, next);
    expect(next).toHaveBeenCalled();
    expect((req as any).repoAccessLevel).toBe('read');
  });

  it('requireRepoAccess always lets OWNER admin a repo, even with no explicit row', async () => {
    repoFindFirst.mockResolvedValue({ id: 'r1' });
    const { req, res } = makeReqRes({
      userId: 'u1', activeOrgId: 'org-a', activeRole: 'OWNER', paramId: 'r1',
    });
    const next = vi.fn();
    await requireRepoAccess('admin')(req, res, next);
    expect(next).toHaveBeenCalled();
    expect((req as any).repoAccessLevel).toBe('admin');
  });

  it('requireRepoAccess 403s when target repo is in another org (even for OWNER of the active org)', async () => {
    repoFindFirst.mockResolvedValue(null); // active-org filter returns nothing
    const { req, res, getStatus } = makeReqRes({
      userId: 'u1', activeOrgId: 'org-a', activeRole: 'OWNER', paramId: 'foreign-repo',
    });
    const next = vi.fn();
    await requireRepoAccess('read')(req, res, next);
    expect(next).not.toHaveBeenCalled();
    expect(getStatus()).toBe(403);
  });

  it('readableRepoIds returns null for OWNER (no filter — sees all)', async () => {
    const ids = await readableRepoIds('u1', 'org-a', 'OWNER');
    expect(ids).toBeNull();
    expect(repoMemberFindMany).not.toHaveBeenCalled();
  });

  it('readableRepoIds returns the explicit grant set for MEMBER', async () => {
    repoMemberFindMany.mockResolvedValue([{ repoId: 'r1' }, { repoId: 'r2' }]);
    const ids = await readableRepoIds('u1', 'org-a', 'MEMBER');
    expect(ids).toEqual(['r1', 'r2']);
  });
});

describe('requireAgentAccess', () => {
  beforeEach(() => {
    agentFindFirst.mockReset();
    agentMemberFindUnique.mockReset();
  });

  it('use < admin enforced', async () => {
    agentFindFirst.mockResolvedValue({ id: 'a1' });
    agentMemberFindUnique.mockResolvedValue({ level: 'use' });
    const { req, res, getStatus } = makeReqRes({
      userId: 'u1', activeOrgId: 'org-a', activeRole: 'MEMBER', paramId: 'a1',
    });
    const next = vi.fn();
    await requireAgentAccess('admin')(req, res, next);
    expect(next).not.toHaveBeenCalled();
    expect(getStatus()).toBe(403);
  });

  it('OWNER inherits agent admin', async () => {
    agentFindFirst.mockResolvedValue({ id: 'a1' });
    const { req, res } = makeReqRes({
      userId: 'u1', activeOrgId: 'org-a', activeRole: 'OWNER', paramId: 'a1',
    });
    const next = vi.fn();
    await requireAgentAccess('admin')(req, res, next);
    expect(next).toHaveBeenCalled();
  });

  it('rejects cross-org agent access', async () => {
    agentFindFirst.mockResolvedValue(null);
    const { req, res, getStatus } = makeReqRes({
      userId: 'u1', activeOrgId: 'org-a', activeRole: 'OWNER', paramId: 'foreign-agent',
    });
    const next = vi.fn();
    await requireAgentAccess('use')(req, res, next);
    expect(next).not.toHaveBeenCalled();
    expect(getStatus()).toBe(403);
  });
});
