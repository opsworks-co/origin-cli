import { prisma } from '../db.js';

export async function createPolicyVersion(policyId: string, changedBy: string | null, changeType: string) {
  // Get current policy state with rules
  const policy = await prisma.policy.findUnique({
    where: { id: policyId },
    include: { rules: { include: { agent: true } } },
  });
  if (!policy) return null;

  // Find current max version
  const latest = await prisma.policyVersion.findFirst({
    where: { policyId },
    orderBy: { version: 'desc' },
  });
  const nextVersion = (latest?.version ?? 0) + 1;

  const snapshot = JSON.stringify({
    name: policy.name,
    description: policy.description,
    type: policy.type,
    active: policy.active,
    rules: policy.rules.map(r => ({
      id: r.id,
      condition: r.condition,
      action: r.action,
      severity: r.severity,
      agentId: r.agentId,
      agentName: r.agent?.name || null,
    })),
  });

  return prisma.policyVersion.create({
    data: { policyId, version: nextVersion, snapshot, changedBy, changeType },
  });
}

export async function createAgentVersion(agentId: string, changedBy: string | null, changeType: string) {
  const agent = await prisma.agent.findUnique({ where: { id: agentId } });
  if (!agent) return null;

  const latest = await prisma.agentVersion.findFirst({
    where: { agentId },
    orderBy: { version: 'desc' },
  });
  const nextVersion = (latest?.version ?? 0) + 1;

  const snapshot = JSON.stringify({
    name: agent.name,
    slug: agent.slug,
    description: agent.description,
    model: agent.model,
    status: agent.status,
  });

  return prisma.agentVersion.create({
    data: { agentId, version: nextVersion, snapshot, changedBy, changeType },
  });
}
