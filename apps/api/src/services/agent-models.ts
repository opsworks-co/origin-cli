import { prisma } from '../db.js';

// One-shot backfill: ensure every Agent has at least one AgentModel row using
// the agent's current `model` value, copying any per-session caps already on
// Agent. Idempotent — only inserts where no matching (agentId, model) row
// exists yet, so it's safe to run on every startup.
export async function backfillAgentModels(): Promise<void> {
  try {
    const agents = await prisma.agent.findMany({
      select: {
        id: true,
        model: true,
        maxCostPerSession: true,
        maxTokensPerSession: true,
      },
      take: 5_000,
    });

    if (agents.length === 0) return;

    const existing = await prisma.agentModel.findMany({
      where: { agentId: { in: agents.map((a) => a.id) } },
      select: { agentId: true, model: true },
    });
    const existingKeys = new Set(existing.map((e) => `${e.agentId}::${e.model}`));

    const toCreate = agents.filter(
      (a) => a.model && !existingKeys.has(`${a.id}::${a.model}`),
    );
    if (toCreate.length === 0) return;

    await prisma.agentModel.createMany({
      data: toCreate.map((a) => ({
        agentId: a.id,
        model: a.model,
        maxCostPerSession: a.maxCostPerSession ?? null,
        maxTokensPerSession: a.maxTokensPerSession ?? null,
      })),
    });

    console.log(`[agent-models] Backfilled ${toCreate.length} default rows`);
  } catch (err) {
    // Non-fatal — feature degrades to single-model behaviour
    console.error('[agent-models] Backfill failed:', err);
  }
}

// Auto-detection: ensure an AgentModel row exists for (agentId, model). If
// the row is created here, mark `autoDetected: true` so the UI can surface
// "new models seen" to admins. Existing rows are left untouched (so admins
// who have already configured limits don't get the flag flipped on them).
//
// Called from session-start and session PATCH whenever a new model surfaces.
// Idempotent and cheap — single upsert.
export async function ensureAgentModel(agentId: string, model: string): Promise<void> {
  if (!agentId || !model) return;
  try {
    await prisma.agentModel.upsert({
      where: { agentId_model: { agentId, model } },
      update: {},
      create: { agentId, model, autoDetected: true },
    });
  } catch (err) {
    // Non-fatal — auto-detection is a nicety, not a correctness requirement.
    console.error('[agent-models] ensureAgentModel failed:', err);
  }
}

// Resolve the effective per-session caps for a session of (agentId, model).
// Returns the most-specific non-null value at each field; null means "no
// limit".
export async function resolvePerSessionCaps(
  agentId: string,
  model: string,
): Promise<{ maxCostPerSession: number | null; maxTokensPerSession: number | null; level: 'model' | 'agent' | 'none' }> {
  const agent = await prisma.agent.findUnique({
    where: { id: agentId },
    select: {
      maxCostPerSession: true,
      maxTokensPerSession: true,
      models: {
        where: { model },
        select: { maxCostPerSession: true, maxTokensPerSession: true },
        take: 1,
      },
    },
  });
  if (!agent) return { maxCostPerSession: null, maxTokensPerSession: null, level: 'none' };

  const am = agent.models[0];
  const cost = am?.maxCostPerSession ?? agent.maxCostPerSession ?? null;
  const tok = am?.maxTokensPerSession ?? agent.maxTokensPerSession ?? null;
  const level: 'model' | 'agent' | 'none' =
    am && (am.maxCostPerSession != null || am.maxTokensPerSession != null)
      ? 'model'
      : agent.maxCostPerSession != null || agent.maxTokensPerSession != null
        ? 'agent'
        : 'none';

  return { maxCostPerSession: cost, maxTokensPerSession: tok, level };
}
