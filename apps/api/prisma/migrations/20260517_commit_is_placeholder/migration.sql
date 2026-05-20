-- Track session-anchor "placeholder" commits separately from real ones.
-- The session-start API creates a Commit row with a random 40-char hex SHA
-- so CodingSession can link to a commit immediately. When the agent ships
-- its actual git SHA, the placeholder is replaced (see apps/api/src/routes/
-- mcp.ts session update path). Sessions that never produce a real commit
-- (e.g. Cursor turns that edit files without committing, or sessions that
-- get reset) leave the placeholder stuck in the dashboard as a phantom
-- "0 files" commit. This column flips false on replacement and lets the
-- commit listing hide unreplaced placeholders.
ALTER TABLE "Commit" ADD COLUMN "isPlaceholder" BOOLEAN NOT NULL DEFAULT false;

CREATE INDEX "Commit_isPlaceholder_idx" ON "Commit"("isPlaceholder");
