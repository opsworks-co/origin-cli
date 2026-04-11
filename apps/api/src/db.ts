import { PrismaClient } from '@prisma/client';
import {
  ENCRYPTED_FIELDS,
  encryptForWrite,
  decryptForRead,
  isEncryptionEnabled,
} from './utils/field-encryption.js';

const base = new PrismaClient();

/**
 * Transparent field-level encryption for sensitive session content.
 *
 * Writes (create/update/upsert/createMany/updateMany) on models listed in
 * ENCRYPTED_FIELDS get their configured fields wrapped with AES-256-GCM.
 *
 * Reads on ANY model recursively walk the result tree and decrypt any string
 * with the `enc:v1:` envelope prefix — so deeply-included relations
 * (e.g. `commit.findMany({ include: { codingSession: { include: {...} } } })`)
 * decrypt automatically without us having to know the parent's shape.
 *
 * The encryption helpers are no-ops when SESSION_ENCRYPTION_KEY is unset, so
 * existing deployments without a key keep working unchanged.
 */
export const prisma = base.$extends({
  query: {
    $allModels: {
      async $allOperations({ model, operation, args, query }) {
        // ── Write path: encrypt before sending to the DB ───────────────
        if (model && ENCRYPTED_FIELDS[model]) {
          if (
            (operation === 'create' || operation === 'update' || operation === 'upsert') &&
            args &&
            typeof args === 'object'
          ) {
            const a: any = args;
            if (a.data) encryptForWrite(model, a.data);
            if (a.create) encryptForWrite(model, a.create);
            if (a.update) encryptForWrite(model, a.update);
          }
          if (operation === 'createMany' || operation === 'updateMany') {
            const a: any = args;
            if (Array.isArray(a?.data)) {
              for (const row of a.data) encryptForWrite(model, row);
            } else if (a?.data) {
              encryptForWrite(model, a.data);
            }
          }
        }

        const result = await query(args);

        // ── Read path: walk the entire result tree and decrypt anything
        //    with our envelope prefix, regardless of nesting depth.
        if (result) decryptForRead('', result);
        return result;
      },
    },
  },
});

if (isEncryptionEnabled()) {
  console.log('[db] field-level encryption ENABLED for session prompts/transcripts/diffs');
}
