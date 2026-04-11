-- Deduplicate any existing (repoId, sha) pairs, keeping the oldest row, then
-- enforce a unique index so concurrent webhook deliveries can no longer create
-- duplicate Commit rows for the same push.
--
-- The dedup step rewrites foreign keys that pointed at losing rows so we don't
-- orphan CodingSession.commitId references.

-- 1. Repoint CodingSession.commitId at the surviving (oldest) Commit per (repoId, sha).
UPDATE "CodingSession"
SET "commitId" = (
  SELECT c_keep."id"
  FROM "Commit" c_cur
  JOIN "Commit" c_keep
    ON c_keep."repoId" = c_cur."repoId"
   AND c_keep."sha"    = c_cur."sha"
  WHERE c_cur."id" = "CodingSession"."commitId"
  ORDER BY c_keep."createdAt" ASC, c_keep."id" ASC
  LIMIT 1
)
WHERE "commitId" IN (
  SELECT c_cur."id"
  FROM "Commit" c_cur
  WHERE EXISTS (
    SELECT 1
    FROM "Commit" c_other
    WHERE c_other."repoId" = c_cur."repoId"
      AND c_other."sha"    = c_cur."sha"
      AND c_other."id"     <> c_cur."id"
  )
);

-- 2. Repoint Commit.sessionId (inverse relation) the same way, in case any
--    dup rows were used as the "current sessionCommits" target.
UPDATE "Commit"
SET "sessionId" = (
  SELECT cs."sessionId"
  FROM "Commit" cs
  WHERE cs."repoId" = "Commit"."repoId"
    AND cs."sha"    = "Commit"."sha"
    AND cs."sessionId" IS NOT NULL
  ORDER BY cs."createdAt" ASC, cs."id" ASC
  LIMIT 1
)
WHERE "sessionId" IS NULL
  AND EXISTS (
    SELECT 1 FROM "Commit" cs2
    WHERE cs2."repoId" = "Commit"."repoId"
      AND cs2."sha"    = "Commit"."sha"
      AND cs2."sessionId" IS NOT NULL
  );

-- 3. Delete the duplicate rows, keeping the oldest per (repoId, sha).
DELETE FROM "Commit"
WHERE "id" IN (
  SELECT c1."id"
  FROM "Commit" c1
  WHERE c1."id" <> (
    SELECT c2."id"
    FROM "Commit" c2
    WHERE c2."repoId" = c1."repoId"
      AND c2."sha"    = c1."sha"
    ORDER BY c2."createdAt" ASC, c2."id" ASC
    LIMIT 1
  )
);

-- 4. Enforce uniqueness going forward.
CREATE UNIQUE INDEX IF NOT EXISTS "Commit_repoId_sha_key" ON "Commit"("repoId", "sha");
