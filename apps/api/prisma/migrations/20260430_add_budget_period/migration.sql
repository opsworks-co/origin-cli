-- Add `period` column to per-(agent|user|repo)-model budget tables. Existing
-- rows are evaluated monthly, which is the historical behaviour, so we
-- backfill with that default. New rows can opt into "daily" or "weekly" to
-- get tighter cadence enforcement (e.g. cap a runaway agent before it can
-- burn through a whole month's budget in one bad day).

ALTER TABLE "AgentModel" ADD COLUMN "period" TEXT NOT NULL DEFAULT 'monthly';
ALTER TABLE "UserModelLimit" ADD COLUMN "period" TEXT NOT NULL DEFAULT 'monthly';
ALTER TABLE "RepoModelLimit" ADD COLUMN "period" TEXT NOT NULL DEFAULT 'monthly';
