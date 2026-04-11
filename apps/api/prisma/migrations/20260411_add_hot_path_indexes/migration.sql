-- Add missing indexes on hot query paths.
-- SQLite: CREATE INDEX IF NOT EXISTS is cheap and online for new indexes.

-- Commit: repo timelines, sha lookups, session linking
CREATE INDEX IF NOT EXISTS "Commit_repoId_committedAt_idx" ON "Commit"("repoId", "committedAt");
CREATE INDEX IF NOT EXISTS "Commit_sha_idx" ON "Commit"("sha");
CREATE INDEX IF NOT EXISTS "Commit_sessionId_idx" ON "Commit"("sessionId");

-- CodingSession: list by user, agent, status, chaining
CREATE INDEX IF NOT EXISTS "CodingSession_userId_createdAt_idx" ON "CodingSession"("userId", "createdAt");
CREATE INDEX IF NOT EXISTS "CodingSession_agentId_idx" ON "CodingSession"("agentId");
CREATE INDEX IF NOT EXISTS "CodingSession_status_idx" ON "CodingSession"("status");
CREATE INDEX IF NOT EXISTS "CodingSession_machineId_idx" ON "CodingSession"("machineId");
CREATE INDEX IF NOT EXISTS "CodingSession_agentSessionId_idx" ON "CodingSession"("agentSessionId");
CREATE INDEX IF NOT EXISTS "CodingSession_parentSessionId_idx" ON "CodingSession"("parentSessionId");
CREATE INDEX IF NOT EXISTS "CodingSession_apiKeyId_idx" ON "CodingSession"("apiKeyId");

-- Repo: list by org (with archived filter)
CREATE INDEX IF NOT EXISTS "Repo_orgId_archived_idx" ON "Repo"("orgId", "archived");

-- AuditLog: time-ordered org feed + user history
CREATE INDEX IF NOT EXISTS "AuditLog_orgId_createdAt_idx" ON "AuditLog"("orgId", "createdAt");
CREATE INDEX IF NOT EXISTS "AuditLog_userId_idx" ON "AuditLog"("userId");

-- Notification: user inbox with unread filter
CREATE INDEX IF NOT EXISTS "Notification_userId_read_idx" ON "Notification"("userId", "read");
CREATE INDEX IF NOT EXISTS "Notification_orgId_createdAt_idx" ON "Notification"("orgId", "createdAt");

-- Webhook: lookup by repo
CREATE INDEX IF NOT EXISTS "Webhook_repoId_idx" ON "Webhook"("repoId");

-- PullRequest: repo + state filters
CREATE INDEX IF NOT EXISTS "PullRequest_repoId_state_idx" ON "PullRequest"("repoId", "state");

-- PolicyRule: join by policy/agent/repo
CREATE INDEX IF NOT EXISTS "PolicyRule_policyId_idx" ON "PolicyRule"("policyId");
CREATE INDEX IF NOT EXISTS "PolicyRule_agentId_idx" ON "PolicyRule"("agentId");
CREATE INDEX IF NOT EXISTS "PolicyRule_repoId_idx" ON "PolicyRule"("repoId");

-- ApiKey: org listing + prefix lookup
CREATE INDEX IF NOT EXISTS "ApiKey_orgId_idx" ON "ApiKey"("orgId");
CREATE INDEX IF NOT EXISTS "ApiKey_keyPrefix_idx" ON "ApiKey"("keyPrefix");
CREATE INDEX IF NOT EXISTS "ApiKey_userId_idx" ON "ApiKey"("userId");

-- SecretFinding: per-session drill-down
CREATE INDEX IF NOT EXISTS "SecretFinding_sessionId_idx" ON "SecretFinding"("sessionId");

-- User: org scoping
CREATE INDEX IF NOT EXISTS "User_orgId_idx" ON "User"("orgId");

-- Agent: org scoping
CREATE INDEX IF NOT EXISTS "Agent_orgId_idx" ON "Agent"("orgId");

-- Trail: org listing with status filter
CREATE INDEX IF NOT EXISTS "Trail_orgId_status_idx" ON "Trail"("orgId", "status");

-- Machine: org scoping
CREATE INDEX IF NOT EXISTS "Machine_orgId_idx" ON "Machine"("orgId");

-- IntegrationConfig: lookup by org+provider
CREATE INDEX IF NOT EXISTS "IntegrationConfig_orgId_provider_idx" ON "IntegrationConfig"("orgId", "provider");

-- AuthToken: lookup by user+type
CREATE INDEX IF NOT EXISTS "AuthToken_userId_type_idx" ON "AuthToken"("userId", "type");
CREATE INDEX IF NOT EXISTS "AuthToken_expiresAt_idx" ON "AuthToken"("expiresAt");

-- PromptChange: session timeline
CREATE INDEX IF NOT EXISTS "PromptChange_sessionId_idx" ON "PromptChange"("sessionId");

-- Invitation: org listing + expiry cleanup
CREATE INDEX IF NOT EXISTS "Invitation_orgId_idx" ON "Invitation"("orgId");
CREATE INDEX IF NOT EXISTS "Invitation_expiresAt_idx" ON "Invitation"("expiresAt");
