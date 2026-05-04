-- Add a JSON-string column to Invitation so admins can pre-stage repo
-- and agent grants at invite-creation time. Applied to the new user as
-- RepoMember / AgentMember rows in the accept-invite handler.
-- Shape: { repos: [{ id, level }], agents: [{ id, level }] }

ALTER TABLE "Invitation" ADD COLUMN "pendingGrants" TEXT;
