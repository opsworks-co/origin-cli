-- Backfill: delete git-notes metadata commits that leaked in via webhook pushes
-- of refs/notes/origin. These rows are Origin's own bookkeeping, not user work,
-- and the read+write filters in commit-filter.ts hide them going forward — but
-- existing rows from past deliveries still bloat pagination counts and the
-- Commits UI until cleaned up here.
--
-- Safety:
--   1. We only match commits whose message starts with "Notes added by 'git notes"
--      (same regex as isGitNotesMetadataCommit, just SQL-flavored).
--   2. We exclude any commit that is the *primary* commit of a CodingSession
--      — those are user-uploaded sessions from the CLI and should never match
--      this pattern, but the WHERE NOT EXISTS guard keeps us safe if they do.
--   3. We null out sessionId (the "sessionCommits" back-ref) before delete so
--      the FK on CodingSession.commits doesn't block us.

UPDATE "Commit"
SET "sessionId" = NULL
WHERE "message" LIKE 'Notes added by %git notes%'
  AND "sessionId" IS NOT NULL;

DELETE FROM "Commit"
WHERE "message" LIKE 'Notes added by %git notes%'
  AND NOT EXISTS (
    SELECT 1 FROM "CodingSession" cs WHERE cs."commitId" = "Commit"."id"
  );
