-- Short human-readable summary of a coding session ("Refactored auth
-- middleware"). Derived from the first prompt's first line on the API side;
-- nullable until the session list endpoint backfills it the first time the
-- session is rendered.
ALTER TABLE "CodingSession" ADD COLUMN "aiTitle" TEXT;
