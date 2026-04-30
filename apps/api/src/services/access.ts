import { prisma } from '../db.js';

// Resource access resolver. Computes the *effective* access level a user
// has on a repo or agent in a given org. Org OWNER and ADMIN roles get
// implicit "admin" on every resource, regardless of explicit grants. Org
// MEMBER and VIEWER need an explicit RepoMember/AgentMember row.

export type RepoLevel = 'read' | 'write' | 'admin';
export type AgentLevel = 'use' | 'admin';

const REPO_RANK: Record<RepoLevel, number> = { read: 1, write: 2, admin: 3 };
const AGENT_RANK: Record<AgentLevel, number> = { use: 1, admin: 2 };

export function repoLevelMeets(have: RepoLevel | null, need: RepoLevel): boolean {
  if (!have) return false;
  return REPO_RANK[have] >= REPO_RANK[need];
}

export function agentLevelMeets(have: AgentLevel | null, need: AgentLevel): boolean {
  if (!have) return false;
  return AGENT_RANK[have] >= AGENT_RANK[need];
}

/**
 * Org roles that bypass per-resource grants. OWNER and ADMIN always have
 * Admin on every repo + agent in the org; this matches GitHub's behaviour
 * where org owners can't be locked out of a repo.
 */
function isOrgPrivileged(role: string | undefined): boolean {
  if (!role) return false;
  const r = role.toUpperCase();
  return r === 'OWNER' || r === 'ADMIN';
}

/**
 * Compute the user's effective level on a repo. Returns null if the user
 * has no access (not a member of the org, or org-member with no grant).
 *
 * Order of checks:
 *  1. The repo must exist and belong to `orgId`. We trust the caller to
 *     have validated org membership separately (resolveOrgContext does
 *     this on every request); here we only care about access scoping
 *     inside that org.
 *  2. If the caller is org OWNER/ADMIN — return 'admin'.
 *  3. Otherwise look up RepoMember; row's level wins.
 */
export async function resolveRepoAccess(
  userId: string,
  orgId: string,
  repoId: string,
  callerOrgRole: string | undefined,
): Promise<RepoLevel | null> {
  // Cheap path: privileged org role short-circuits the DB lookup, but we
  // still verify the repo belongs to the active org so privileged users
  // can't cross-org by passing a foreign repoId.
  const repo = await prisma.repo.findFirst({
    where: { id: repoId, orgId },
    select: { id: true },
  });
  if (!repo) return null;
  if (isOrgPrivileged(callerOrgRole)) return 'admin';

  const member = await prisma.repoMember.findUnique({
    where: { userId_repoId: { userId, repoId } },
    select: { level: true },
  });
  return (member?.level as RepoLevel | undefined) || null;
}

export async function resolveAgentAccess(
  userId: string,
  orgId: string,
  agentId: string,
  callerOrgRole: string | undefined,
): Promise<AgentLevel | null> {
  const agent = await prisma.agent.findFirst({
    where: { id: agentId, orgId },
    select: { id: true },
  });
  if (!agent) return null;
  if (isOrgPrivileged(callerOrgRole)) return 'admin';

  const member = await prisma.agentMember.findUnique({
    where: { userId_agentId: { userId, agentId } },
    select: { level: true },
  });
  return (member?.level as AgentLevel | undefined) || null;
}

/**
 * Return the set of repo IDs the user can *read* in this org. Used to
 * scope list endpoints (e.g. GET /repos) for non-privileged users so they
 * only see repos they've been granted access to.
 *
 * Privileged users (OWNER/ADMIN) get null — meaning "no filter, return
 * everything in the org" — which the caller maps to a query without an
 * `id IN (...)` clause.
 */
export async function readableRepoIds(
  userId: string,
  orgId: string,
  callerOrgRole: string | undefined,
): Promise<string[] | null> {
  if (isOrgPrivileged(callerOrgRole)) return null;
  const rows = await prisma.repoMember.findMany({
    where: { userId, repo: { orgId } },
    select: { repoId: true },
  });
  return rows.map((r) => r.repoId);
}

export async function readableAgentIds(
  userId: string,
  orgId: string,
  callerOrgRole: string | undefined,
): Promise<string[] | null> {
  if (isOrgPrivileged(callerOrgRole)) return null;
  const rows = await prisma.agentMember.findMany({
    where: { userId, agent: { orgId } },
    select: { agentId: true },
  });
  return rows.map((r) => r.agentId);
}
