/**
 * One-shot encryption backfill.
 *
 * Walks every model in ENCRYPTED_FIELDS and re-writes any row whose target
 * columns are still plaintext (i.e. missing the `enc:v1:` envelope prefix).
 *
 * Safe to run repeatedly — `encryptField()` is a no-op on already-encrypted
 * values, and the query middleware in db.ts will wrap the update below, so
 * the final `update()` call transparently produces the envelope for us.
 *
 * Invoked once at startup from docker-start.sh. If SESSION_ENCRYPTION_KEY is
 * not set, the script exits immediately — nothing to encrypt.
 */

import { prisma } from '../db.js';
import { isEncryptionEnabled, isEncrypted, ENCRYPTED_FIELDS } from '../utils/field-encryption.js';

// Use the RAW prisma client, not the $extends wrapper, because we need to
// read the plaintext values as-written and write them back through the
// middleware exactly once. Importing the unwrapped client avoids double-
// encryption bugs.
import { PrismaClient } from '@prisma/client';

const BATCH_SIZE = 200;

async function backfillModel(
  raw: PrismaClient,
  model: string,
  fields: string[],
): Promise<{ scanned: number; rewritten: number }> {
  // @ts-expect-error — dynamic model access.
  const delegate = raw[model[0].toLowerCase() + model.slice(1)];
  if (!delegate?.findMany) return { scanned: 0, rewritten: 0 };

  let scanned = 0;
  let rewritten = 0;
  let cursor: string | undefined;

  for (;;) {
    const rows: Array<Record<string, unknown>> = await delegate.findMany({
      take: BATCH_SIZE,
      ...(cursor ? { skip: 1, cursor: { id: cursor } } : {}),
      orderBy: { id: 'asc' },
      select: {
        id: true,
        ...Object.fromEntries(fields.map((f) => [f, true])),
      },
    });
    if (rows.length === 0) break;
    cursor = rows[rows.length - 1].id as string;
    scanned += rows.length;

    for (const row of rows) {
      const needsUpdate: Record<string, string> = {};
      for (const field of fields) {
        const v = row[field];
        if (typeof v === 'string' && v.length > 0 && !isEncrypted(v)) {
          needsUpdate[field] = v;
        }
      }
      if (Object.keys(needsUpdate).length === 0) continue;
      // Route the write through the `prisma` (extended) client so the
      // encryption middleware runs — do NOT use `raw` here.
      // @ts-expect-error — dynamic model access on extended client.
      await prisma[model[0].toLowerCase() + model.slice(1)].update({
        where: { id: row.id },
        data: needsUpdate,
      });
      rewritten++;
    }
  }

  return { scanned, rewritten };
}

async function main() {
  if (!isEncryptionEnabled()) {
    console.log('[backfill-encryption] SESSION_ENCRYPTION_KEY not set — nothing to backfill');
    return;
  }

  const raw = new PrismaClient();
  try {
    for (const [model, fields] of Object.entries(ENCRYPTED_FIELDS)) {
      try {
        const { scanned, rewritten } = await backfillModel(raw, model, fields);
        console.log(
          `[backfill-encryption] ${model}: scanned ${scanned}, rewritten ${rewritten} (${fields.join(', ')})`,
        );
      } catch (err) {
        console.warn(`[backfill-encryption] ${model} skipped: ${(err as Error).message}`);
      }
    }
  } finally {
    await raw.$disconnect();
  }
}

main().catch((err) => {
  console.error('[backfill-encryption] fatal:', err);
  // Don't fail the container on backfill errors — the main process should
  // still boot. Rows that fail to encrypt stay plaintext and can be picked
  // up on the next run.
  process.exit(0);
});
