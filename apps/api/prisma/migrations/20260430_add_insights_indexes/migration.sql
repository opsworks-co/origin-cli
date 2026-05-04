-- Composite indexes for the Spend Quality dashboard's hot-path aggregations.
-- Each index targets a specific section's query pattern and is bounded to
-- columns the planner uses for range scans:
--   • CodingSession(model, createdAt) — model-fit warnings + per-model rollups
--   • CodingSession(userId, createdAt) is already present; not duplicated
--   • PromptChange(sessionId, createdAt) — rework + wasted-prompt cross-refs
-- These are all `CREATE INDEX IF NOT EXISTS` so re-running the migration on
-- an env that already had a hot-fix index applied is a no-op.

CREATE INDEX IF NOT EXISTS "CodingSession_model_createdAt_idx"
  ON "CodingSession"("model", "createdAt");

CREATE INDEX IF NOT EXISTS "PromptChange_sessionId_createdAt_idx"
  ON "PromptChange"("sessionId", "createdAt");
