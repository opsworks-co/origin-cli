-- Optional org-level LLM credentials used for higher-quality session
-- summaries (AI-generated session titles) and future LLM-backed features.
-- NULL provider/key => fall back to deterministic heuristic.
ALTER TABLE "Org" ADD COLUMN "llmProvider" TEXT;
ALTER TABLE "Org" ADD COLUMN "llmApiKey" TEXT;
