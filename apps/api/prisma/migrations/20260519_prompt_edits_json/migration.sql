-- Authoritative per-prompt edit list — JSON-encoded PromptEdit[]. Each
-- entry carries file path, old/new content, and the commit SHA (if any)
-- that landed it. When this column is populated, the blame API computes
-- per-prompt diff + attribution from it directly instead of running the
-- legacy block-matching heuristics on `diff` / `uncommittedDiff`.
-- Null for sessions captured before the new pipeline shipped — those
-- still fall back to the legacy path.
ALTER TABLE "PromptChange" ADD COLUMN "editsJson" TEXT;
