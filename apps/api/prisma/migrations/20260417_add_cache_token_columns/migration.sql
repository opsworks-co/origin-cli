-- Add per-session cache token tracking so `tokensUsed` (input + output only)
-- stops getting inflated 10x by prompt-cache replays. Both default to 0 so the
-- existing rows stay valid without a backfill.
ALTER TABLE "CodingSession" ADD COLUMN "cacheReadTokens" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "CodingSession" ADD COLUMN "cacheCreationTokens" INTEGER NOT NULL DEFAULT 0;
