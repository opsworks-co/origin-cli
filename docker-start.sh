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

-- Dedup PromptChange: keep newest row per (sessionId, promptIndex)
DELETE FROM "PromptChange"
WHERE "id" NOT IN (
  SELECT MAX("id") FROM "PromptChange" GROUP BY "sessionId", "promptIndex"
);
SQL
fi

npx prisma db push --skip-generate --accept-data-loss

# One-time backfill: mark unreplaced session-anchor commits as placeholders
# so the listing hides them. Two patterns cover the historical bad data:
#
#   (a) Bare placeholder — message empty, no files, no fileCount, session
#       attached. The classic "session reserved a slot but never produced a
#       real commit" case (common for Cursor turns that don't commit).
#
#   (b) Duplicate placeholder — a session has TWO Commit rows, the primary
#       (CodingSession.commitId) is the session-anchor whose SHA isn't a
#       real git commit but got populated with diff data during the update
#       path, AND there's ANOTHER Commit attached to the same session via
#       the post-commit ingest with the real SHA. Hide the primary anchor
#       and keep the real one in listings.
#
# Both are idempotent — re-runs are no-ops once the flag is set.
if [ -f /data/origin.db ]; then
  sqlite3 /data/origin.db <<'SQL' || true
-- (a) bare anchors with no content. We DON'T require empty message —
-- the session update path stamps the prompt text onto the message even
-- when no real commit landed, so the only reliable signals are: zero
-- files, zero lines, has a session, AND it's the session's primary
-- commit (a regular ingested commit never matches all four).
UPDATE "Commit"
SET "isPlaceholder" = 1
WHERE ("filesChanged" IS NULL OR "filesChanged" = '[]' OR "filesChanged" = '')
  AND ("fileCount" IS NULL OR "fileCount" = 0)
  AND ("additions" IS NULL OR "additions" = 0)
  AND ("deletions" IS NULL OR "deletions" = 0)
  AND "isPlaceholder" = 0
  AND "id" IN (SELECT "commitId" FROM "CodingSession");

-- (b) primary commit on a session that ALSO has another Commit row
-- (post-commit ingest produced the real one separately). The primary
-- row was never deleted because the API's session-update delete path
-- threw or didn't fire; flag it so the listing hides it.
UPDATE "Commit"
SET "isPlaceholder" = 1
WHERE "isPlaceholder" = 0
  AND "id" IN (
    SELECT cs."commitId"
    FROM "CodingSession" cs
    JOIN "Commit" c ON c."sessionId" = cs."id"
    WHERE c."id" <> cs."commitId"
  );
SQL
fi

# Encryption backfill: idempotent, only touches rows still in plaintext.
# No-op if SESSION_ENCRYPTION_KEY is unset.
node dist/scripts/backfill-encryption.js || echo "[docker-start] backfill-encryption exited non-zero, continuing"

node dist/index.js
