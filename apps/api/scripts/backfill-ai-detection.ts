#!/usr/bin/env npx tsx
// ── Backfill AI Detection ────────────────────────────────────────────────────
// One-time script to classify existing commits using the AI detection heuristics.
// Run: npx tsx apps/api/scripts/backfill-ai-detection.ts

import { PrismaClient } from '@prisma/client';
import { detectAITool } from '../src/services/ai-commit-detector.js';

const prisma = new PrismaClient();

async function main() {
  console.log('Starting AI detection backfill...');

  // 1. Session-linked commits — mark with session method
  const sessionCommits = await prisma.commit.findMany({
    where: {
      aiToolDetected: null,
      session: { isNot: null },
    },
    include: { session: { select: { model: true } } },
  });

  let sessionUpdated = 0;
  for (const commit of sessionCommits) {
    if (commit.session) {
      await prisma.commit.update({
        where: { id: commit.id },
        data: {
          aiToolDetected: commit.session.model,
          aiDetectionMethod: 'session',
        },
      });
      sessionUpdated++;
    }
  }
  console.log(`  Session-linked: ${sessionUpdated} commits updated`);

  // 2. Non-session commits — run heuristic detection
  const otherCommits = await prisma.commit.findMany({
    where: {
      aiToolDetected: null,
      session: null,
    },
  });

  let heuristicUpdated = 0;
  for (const commit of otherCommits) {
    const result = detectAITool(commit.message, commit.author);
    if (result.aiToolDetected) {
      await prisma.commit.update({
        where: { id: commit.id },
        data: {
          aiToolDetected: result.aiToolDetected,
          aiDetectionMethod: result.aiDetectionMethod,
        },
      });
      heuristicUpdated++;
    }
  }
  console.log(`  Heuristic: ${heuristicUpdated} / ${otherCommits.length} commits detected as AI`);

  // Summary
  const totalAI = await prisma.commit.count({ where: { aiToolDetected: { not: null } } });
  const totalAll = await prisma.commit.count();
  console.log(`\nDone. ${totalAI} / ${totalAll} total commits classified as AI.`);
}

main()
  .catch(console.error)
  .finally(() => prisma.$disconnect());
