#!/bin/sh
set -e

cd /app/apps/api

# Pre-migration dedup: the Commit table gained a composite unique (repoId, sha)
# index, but existing rows may have duplicates from before webhook upsert landed.
# `prisma db push` can't apply a unique index on a table with conflicts, so we
# repoint foreign keys to the oldest surviving row and delete the dupes first.
# Idempotent — a no-op on clean DBs.
if [ -f /data/origin.db ]; then
  sqlite3 /data/origin.db <<'SQL' || true
UPDATE "CodingSession"
SET "commitId" = (
  SELECT MIN(c2."id") FROM "Commit" c2
  WHERE c2."repoId" = (SELECT c."repoId" FROM "Commit" c WHERE c."id" = "CodingSession"."commitId")
    AND c2."sha" = (SELECT c."sha" FROM "Commit" c WHERE c."id" = "CodingSession"."commitId")
)
WHERE "commitId" IS NOT NULL
  AND "commitId" NOT IN (
    SELECT MIN("id") FROM "Commit" GROUP BY "repoId", "sha"
  );

UPDATE "Commit"
SET "sessionId" = NULL
WHERE "id" NOT IN (SELECT MIN("id") FROM "Commit" GROUP BY "repoId", "sha");

DELETE FROM "Commit"
WHERE "id" NOT IN (SELECT MIN("id") FROM "Commit" GROUP BY "repoId", "sha");
SQL
fi

npx prisma migrate deploy

# Encryption backfill: idempotent, only touches rows still in plaintext.
# No-op if SESSION_ENCRYPTION_KEY is unset.
node dist/scripts/backfill-encryption.js || echo "[docker-start] backfill-encryption exited non-zero, continuing"

node dist/index.js
