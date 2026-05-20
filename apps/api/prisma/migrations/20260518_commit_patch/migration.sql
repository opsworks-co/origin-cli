-- Per-commit unified diff so the commit-detail page can show what THIS
-- commit changed instead of falling back to the session-level aggregate
-- (which made every commit in a session render the same diff). Populated
-- by the CLI's post-commit hook via the ingestCommits endpoint.
ALTER TABLE "Commit" ADD COLUMN "patch" TEXT;
