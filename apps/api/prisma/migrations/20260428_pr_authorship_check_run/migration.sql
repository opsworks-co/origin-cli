-- Persist the GitHub Check Run ID for the per-PR AI-authorship check so
-- subsequent webhook deliveries (synchronize, reopen) PATCH the existing
-- check rather than create a duplicate. NULL = check has never been
-- posted for this PR yet (or the GitHub App lacked checks:write).
ALTER TABLE "PullRequest" ADD COLUMN "authorshipCheckRunId" INTEGER;
