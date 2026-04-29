-- Reverse 20260428_org_llm_key. The org's LLM credentials live in the
-- existing IntegrationConfig (provider='llm') row that already backs the
-- in-app Chat feature — no need for a duplicate spot. SQLite supports
-- DROP COLUMN since 3.35.
ALTER TABLE "Org" DROP COLUMN "llmProvider";
ALTER TABLE "Org" DROP COLUMN "llmApiKey";
