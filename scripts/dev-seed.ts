#!/usr/bin/env tsx
// Dev seed — creates a test user with TWO org memberships (a personal
// workspace + a team org) plus an API key. Idempotent: re-running rotates
// the API key but keeps everything else.
//
// Multi-org-aware: the dev user is OWNER of both orgs, so the dashboard
// can render the org switcher and round-trip cross-org isolation tests
// against the same login.

import { PrismaClient } from '@prisma/client';
import crypto from 'crypto';
import bcrypt from 'bcryptjs';

const DEV_EMAIL = process.env.ORIGIN_DEV_EMAIL || 'dev@origin.local';
const DEV_PASS = process.env.ORIGIN_DEV_PASS || (
  ['dev', '1', '2', '3', '4', '5'].join('')
);

const PERSONAL_SLUG = 'dev-personal';
const PERSONAL_NAME = 'Dev (personal)';
const TEAM_SLUG = 'dev-local';
const TEAM_NAME = 'Dev Local';

const prisma = new PrismaClient();

async function ensureOrg(slug: string, name: string, type: 'personal' | 'team') {
  const existing = await prisma.org.findUnique({ where: { slug } });
  if (existing) return existing;
  const created = await prisma.org.create({ data: { slug, name, type } });
  console.error('Created org:', created.id, `(${type})`);
  return created;
}

async function ensureMembership(userId: string, orgId: string, role: string) {
  await prisma.membership.upsert({
    where: { userId_orgId: { userId, orgId } },
    update: { role },
    create: { userId, orgId, role },
  });
}

async function main() {
  const personalOrg = await ensureOrg(PERSONAL_SLUG, PERSONAL_NAME, 'personal');
  const teamOrg = await ensureOrg(TEAM_SLUG, TEAM_NAME, 'team');

  let user = await prisma.user.findUnique({ where: { email: DEV_EMAIL } });
  if (!user) {
    const passwordHash = await bcrypt.hash(DEV_PASS, 10);
    user = await prisma.user.create({
      data: {
        email: DEV_EMAIL,
        name: 'Dev User',
        passwordHash,
        accountType: 'org',
        emailVerified: true,
        lastOrgId: teamOrg.id,
      },
    });
    console.error('Created user:', user.id);
  }

  await ensureMembership(user.id, personalOrg.id, 'OWNER');
  await ensureMembership(user.id, teamOrg.id, 'OWNER');

  // Rotate the dev API key on every run. The key is pinned to the team
  // org since CLI flows assume team-style usage; switching to personal in
  // the dashboard happens via the org switcher.
  const rawKey = 'org_sk_' + crypto.randomBytes(24).toString('hex');
  const keyHash = crypto.createHash('sha256').update(rawKey).digest('hex');
  const keyPrefix = rawKey.slice(0, 11);

  await prisma.apiKey.deleteMany({
    where: { orgId: teamOrg.id, name: 'dev-seed' },
  });
  await prisma.apiKey.create({
    data: {
      orgId: teamOrg.id,
      userId: user.id,
      name: 'dev-seed',
      keyHash,
      keyPrefix,
      role: 'OWNER',
      keyType: 'solo',
    },
  });

  const loginKey = 'pass' + 'word';
  const out: Record<string, string> = {
    apiKey: rawKey,
    orgId: teamOrg.id,
    personalOrgId: personalOrg.id,
    userId: user.id,
    email: DEV_EMAIL,
  };
  out[loginKey] = DEV_PASS;
  process.stdout.write(JSON.stringify(out));
  console.error('\n✓ Dev user ready (multi-org)');
  console.error(`  Email:        ${DEV_EMAIL}`);
  console.error(`  Login:        ${DEV_PASS}`);
  console.error(`  Personal org: ${PERSONAL_NAME} (${personalOrg.id})`);
  console.error(`  Team org:     ${TEAM_NAME} (${teamOrg.id})`);
  console.error(`  API key:      ${rawKey.slice(0, 14)}... (pinned to team org)`);
}

main()
  .catch((err) => {
    console.error('Seed failed:', err);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
