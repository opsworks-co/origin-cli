import { prisma } from '../db.js';
import { AGENT_CATALOG, type CatalogEntry } from '../data/agent-catalog.js';

// Idempotent catalog seeder. Every org should own one Agent row per
// AGENT_CATALOG entry. New rows start with isEnabled=false; existing rows
// (e.g. a user-created Agent that already used `claude-code` as its slug)
// get marked as catalog (isCustom=false) and have name/description/default
// model nudged toward the catalog values *only if those fields are empty*
// — we don't clobber an admin's custom branding mid-flight.
//
// Safe to call repeatedly. Runs on:
//   1. Server startup (backfillCatalogForAllOrgs) — covers existing orgs
//      across deploys and after schema bumps.
//   2. Every prisma.org.create site (seedCatalogForOrg, in-tx) — new orgs
//      get the catalog before the user sees the Agents page.

type Tx = Parameters<Parameters<typeof prisma.$transaction>[0]>[0];
type PrismaLike = typeof prisma | Tx;

async function upsertCatalogRow(client: PrismaLike, orgId: string, entry: CatalogEntry) {
  const existing = await client.agent.findFirst({
    where: { orgId, slug: entry.slug },
    select: {
      id: true,
      name: true,
      description: true,
      model: true,
      isCustom: true,
    },
  });

  if (!existing) {
    await client.agent.create({
      data: {
        orgId,
        slug: entry.slug,
        name: entry.name,
        description: entry.description,
        model: entry.defaultModel,
        isEnabled: false,
        isCustom: false,
      },
    });
    return 'created';
  }

  // Re-classify: this row IS a catalog slug, so isCustom must be false.
  // Backfill empty display fields with catalog defaults; never overwrite
  // values the admin has already chosen.
  const patch: Record<string, unknown> = {};
  if (existing.isCustom) patch.isCustom = false;
  if (!existing.name || existing.name === entry.slug) patch.name = entry.name;
  if (!existing.description) patch.description = entry.description;
  if (!existing.model) patch.model = entry.defaultModel;

  if (Object.keys(patch).length > 0) {
    await client.agent.update({ where: { id: existing.id }, data: patch });
    return 'updated';
  }
  return 'noop';
}

export async function seedCatalogForOrg(orgId: string, client: PrismaLike = prisma): Promise<void> {
  for (const entry of AGENT_CATALOG) {
    await upsertCatalogRow(client, orgId, entry);
  }
}

/**
 * Walk every org and ensure the catalog rows exist. Logs a summary so the
 * boot log makes it obvious whether the schema migration backfilled
 * correctly.
 */
export async function backfillCatalogForAllOrgs(): Promise<void> {
  const orgs = await prisma.org.findMany({ select: { id: true }, take: 10_000 });
  let created = 0;
  let updated = 0;
  for (const org of orgs) {
    for (const entry of AGENT_CATALOG) {
      const result = await upsertCatalogRow(prisma, org.id, entry);
      if (result === 'created') created++;
      else if (result === 'updated') updated++;
    }
  }
  if (created || updated) {
    console.log(`[seed-catalog] orgs=${orgs.length} created=${created} updated=${updated}`);
  }
}
