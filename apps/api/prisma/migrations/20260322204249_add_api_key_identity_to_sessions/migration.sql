-- CreateTable
CREATE TABLE "Invitation" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "orgId" TEXT NOT NULL,
    "email" TEXT,
    "role" TEXT NOT NULL DEFAULT 'MEMBER',
    "token" TEXT NOT NULL,
    "createdBy" TEXT NOT NULL,
    "expiresAt" DATETIME NOT NULL,
    "usedAt" DATETIME,
    "usedBy" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "Invitation_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "Org" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "ApiKeyRepoScope" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "apiKeyId" TEXT NOT NULL,
    "repoId" TEXT NOT NULL,
    CONSTRAINT "ApiKeyRepoScope_apiKeyId_fkey" FOREIGN KEY ("apiKeyId") REFERENCES "ApiKey" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "ApiKeyRepoScope_repoId_fkey" FOREIGN KEY ("repoId") REFERENCES "Repo" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "ApiKeyAgentScope" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "apiKeyId" TEXT NOT NULL,
    "agentId" TEXT NOT NULL,
    CONSTRAINT "ApiKeyAgentScope_apiKeyId_fkey" FOREIGN KEY ("apiKeyId") REFERENCES "ApiKey" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "ApiKeyAgentScope_agentId_fkey" FOREIGN KEY ("agentId") REFERENCES "Agent" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "SessionDiff" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "sessionId" TEXT NOT NULL,
    "headBefore" TEXT NOT NULL,
    "headAfter" TEXT NOT NULL,
    "commitShas" TEXT NOT NULL DEFAULT '[]',
    "diff" TEXT NOT NULL,
    "diffTruncated" BOOLEAN NOT NULL DEFAULT false,
    "linesAdded" INTEGER NOT NULL DEFAULT 0,
    "linesRemoved" INTEGER NOT NULL DEFAULT 0,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "SessionDiff_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES "CodingSession" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "PromptChange" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "sessionId" TEXT NOT NULL,
    "promptIndex" INTEGER NOT NULL,
    "promptText" TEXT NOT NULL,
    "filesChanged" TEXT NOT NULL,
    "diff" TEXT NOT NULL DEFAULT '',
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "PromptChange_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES "CodingSession" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "PolicyAssignment" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "policyId" TEXT NOT NULL,
    "agentId" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "PolicyAssignment_policyId_fkey" FOREIGN KEY ("policyId") REFERENCES "Policy" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "PolicyAssignment_agentId_fkey" FOREIGN KEY ("agentId") REFERENCES "Agent" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "PolicyVersion" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "policyId" TEXT NOT NULL,
    "version" INTEGER NOT NULL,
    "snapshot" TEXT NOT NULL,
    "changedBy" TEXT,
    "changeType" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "PolicyVersion_policyId_fkey" FOREIGN KEY ("policyId") REFERENCES "Policy" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "AgentVersion" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "agentId" TEXT NOT NULL,
    "version" INTEGER NOT NULL,
    "snapshot" TEXT NOT NULL,
    "changedBy" TEXT,
    "changeType" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "AgentVersion_agentId_fkey" FOREIGN KEY ("agentId") REFERENCES "Agent" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "Webhook" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "repoId" TEXT NOT NULL,
    "secret" TEXT NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "events" TEXT NOT NULL DEFAULT '["push","pull_request"]',
    "githubWebhookId" INTEGER,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "Webhook_repoId_fkey" FOREIGN KEY ("repoId") REFERENCES "Repo" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "PullRequest" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "repoId" TEXT NOT NULL,
    "number" INTEGER NOT NULL,
    "title" TEXT NOT NULL,
    "url" TEXT NOT NULL,
    "state" TEXT NOT NULL DEFAULT 'open',
    "author" TEXT NOT NULL,
    "baseBranch" TEXT NOT NULL,
    "headBranch" TEXT NOT NULL,
    "commitShas" TEXT NOT NULL DEFAULT '[]',
    "checkStatus" TEXT,
    "commentId" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "PullRequest_repoId_fkey" FOREIGN KEY ("repoId") REFERENCES "Repo" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "IntegrationConfig" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "orgId" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "token" TEXT NOT NULL,
    "baseUrl" TEXT NOT NULL DEFAULT '',
    "settings" TEXT NOT NULL DEFAULT '{}',
    "authType" TEXT NOT NULL DEFAULT 'pat',
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "IntegrationConfig_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "Org" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "Notification" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "orgId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "message" TEXT NOT NULL,
    "link" TEXT,
    "read" BOOLEAN NOT NULL DEFAULT false,
    "readAt" DATETIME,
    "metadata" TEXT NOT NULL DEFAULT '{}',
    "emailSent" BOOLEAN NOT NULL DEFAULT false,
    "emailSentAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "Notification_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "Org" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "Notification_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "SecretFinding" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "sessionId" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "severity" TEXT NOT NULL,
    "filePath" TEXT NOT NULL,
    "lineNumber" INTEGER NOT NULL DEFAULT 0,
    "match" TEXT NOT NULL,
    "ruleName" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "SecretFinding_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES "CodingSession" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "Trail" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "orgId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "branch" TEXT,
    "status" TEXT NOT NULL DEFAULT 'active',
    "priority" TEXT NOT NULL DEFAULT 'medium',
    "labels" TEXT NOT NULL DEFAULT '[]',
    "createdBy" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "Trail_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "Org" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "TrailSession" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "trailId" TEXT NOT NULL,
    "sessionId" TEXT NOT NULL,
    "addedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "TrailSession_trailId_fkey" FOREIGN KEY ("trailId") REFERENCES "Trail" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "TrailSession_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES "CodingSession" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "SharedSession" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "sessionId" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "expiresAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdById" TEXT,
    CONSTRAINT "SharedSession_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES "CodingSession" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_Agent" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "orgId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "description" TEXT,
    "model" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'ACTIVE',
    "systemPrompt" TEXT,
    "securityRulesEnabled" BOOLEAN NOT NULL DEFAULT false,
    "securityRules" TEXT,
    "allowedTools" TEXT NOT NULL DEFAULT '[]',
    "maxCostPerSession" REAL,
    "maxTokensPerSession" INTEGER,
    "permissions" TEXT NOT NULL DEFAULT '{}',
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "Agent_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "Org" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);
INSERT INTO "new_Agent" ("createdAt", "description", "id", "model", "name", "orgId", "slug", "status") SELECT "createdAt", "description", "id", "model", "name", "orgId", "slug", "status" FROM "Agent";
DROP TABLE "Agent";
ALTER TABLE "new_Agent" RENAME TO "Agent";
CREATE TABLE "new_ApiKey" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "orgId" TEXT NOT NULL,
    "userId" TEXT,
    "name" TEXT NOT NULL,
    "keyHash" TEXT NOT NULL,
    "keyPrefix" TEXT NOT NULL,
    "role" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "ApiKey_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "Org" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "ApiKey_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);
INSERT INTO "new_ApiKey" ("createdAt", "id", "keyHash", "keyPrefix", "name", "orgId") SELECT "createdAt", "id", "keyHash", "keyPrefix", "name", "orgId" FROM "ApiKey";
DROP TABLE "ApiKey";
ALTER TABLE "new_ApiKey" RENAME TO "ApiKey";
CREATE TABLE "new_CodingSession" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "commitId" TEXT NOT NULL,
    "agentId" TEXT,
    "userId" TEXT,
    "model" TEXT NOT NULL,
    "prompt" TEXT NOT NULL,
    "transcript" TEXT NOT NULL,
    "filesChanged" TEXT NOT NULL,
    "tokensUsed" INTEGER NOT NULL DEFAULT 0,
    "inputTokens" INTEGER NOT NULL DEFAULT 0,
    "outputTokens" INTEGER NOT NULL DEFAULT 0,
    "toolCalls" INTEGER NOT NULL DEFAULT 0,
    "durationMs" INTEGER NOT NULL DEFAULT 0,
    "linesAdded" INTEGER NOT NULL DEFAULT 0,
    "linesRemoved" INTEGER NOT NULL DEFAULT 0,
    "costUsd" REAL NOT NULL DEFAULT 0,
    "branch" TEXT,
    "status" TEXT NOT NULL DEFAULT 'COMPLETED',
    "archived" BOOLEAN NOT NULL DEFAULT false,
    "apiKeyId" TEXT,
    "apiKeyName" TEXT,
    "agentSystemPrompt" TEXT,
    "agentVersion" INTEGER,
    "startedAt" DATETIME,
    "endedAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "CodingSession_commitId_fkey" FOREIGN KEY ("commitId") REFERENCES "Commit" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "CodingSession_agentId_fkey" FOREIGN KEY ("agentId") REFERENCES "Agent" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "CodingSession_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);
INSERT INTO "new_CodingSession" ("agentId", "commitId", "costUsd", "createdAt", "durationMs", "filesChanged", "id", "linesAdded", "linesRemoved", "model", "prompt", "tokensUsed", "toolCalls", "transcript") SELECT "agentId", "commitId", "costUsd", "createdAt", "durationMs", "filesChanged", "id", "linesAdded", "linesRemoved", "model", "prompt", "tokensUsed", "toolCalls", "transcript" FROM "CodingSession";
DROP TABLE "CodingSession";
ALTER TABLE "new_CodingSession" RENAME TO "CodingSession";
CREATE UNIQUE INDEX "CodingSession_commitId_key" ON "CodingSession"("commitId");
CREATE TABLE "new_Commit" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "repoId" TEXT NOT NULL,
    "sha" TEXT NOT NULL,
    "message" TEXT NOT NULL,
    "author" TEXT NOT NULL,
    "aiToolDetected" TEXT,
    "aiDetectionMethod" TEXT,
    "branch" TEXT,
    "filesChanged" TEXT NOT NULL DEFAULT '[]',
    "committedAt" DATETIME NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "sessionId" TEXT,
    CONSTRAINT "Commit_repoId_fkey" FOREIGN KEY ("repoId") REFERENCES "Repo" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "Commit_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES "CodingSession" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);
INSERT INTO "new_Commit" ("author", "committedAt", "createdAt", "id", "message", "repoId", "sha") SELECT "author", "committedAt", "createdAt", "id", "message", "repoId", "sha" FROM "Commit";
DROP TABLE "Commit";
ALTER TABLE "new_Commit" RENAME TO "Commit";
CREATE TABLE "new_PolicyRule" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "policyId" TEXT NOT NULL,
    "agentId" TEXT,
    "machineId" TEXT,
    "repoId" TEXT,
    "condition" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "severity" TEXT NOT NULL DEFAULT 'MEDIUM',
    CONSTRAINT "PolicyRule_policyId_fkey" FOREIGN KEY ("policyId") REFERENCES "Policy" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "PolicyRule_agentId_fkey" FOREIGN KEY ("agentId") REFERENCES "Agent" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "PolicyRule_machineId_fkey" FOREIGN KEY ("machineId") REFERENCES "Machine" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "PolicyRule_repoId_fkey" FOREIGN KEY ("repoId") REFERENCES "Repo" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);
INSERT INTO "new_PolicyRule" ("action", "agentId", "condition", "id", "policyId", "severity") SELECT "action", "agentId", "condition", "id", "policyId", "severity" FROM "PolicyRule";
DROP TABLE "PolicyRule";
ALTER TABLE "new_PolicyRule" RENAME TO "PolicyRule";
CREATE TABLE "new_Repo" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "orgId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "path" TEXT NOT NULL,
    "provider" TEXT NOT NULL DEFAULT 'local',
    "archived" BOOLEAN NOT NULL DEFAULT false,
    "syncedAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "Repo_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "Org" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);
INSERT INTO "new_Repo" ("createdAt", "id", "name", "orgId", "path", "provider", "syncedAt") SELECT "createdAt", "id", "name", "orgId", "path", "provider", "syncedAt" FROM "Repo";
DROP TABLE "Repo";
ALTER TABLE "new_Repo" RENAME TO "Repo";
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;

-- CreateIndex
CREATE UNIQUE INDEX "Invitation_token_key" ON "Invitation"("token");

-- CreateIndex
CREATE UNIQUE INDEX "ApiKeyRepoScope_apiKeyId_repoId_key" ON "ApiKeyRepoScope"("apiKeyId", "repoId");

-- CreateIndex
CREATE UNIQUE INDEX "ApiKeyAgentScope_apiKeyId_agentId_key" ON "ApiKeyAgentScope"("apiKeyId", "agentId");

-- CreateIndex
CREATE UNIQUE INDEX "SessionDiff_sessionId_key" ON "SessionDiff"("sessionId");

-- CreateIndex
CREATE UNIQUE INDEX "PolicyAssignment_policyId_agentId_key" ON "PolicyAssignment"("policyId", "agentId");

-- CreateIndex
CREATE UNIQUE INDEX "TrailSession_trailId_sessionId_key" ON "TrailSession"("trailId", "sessionId");

-- CreateIndex
CREATE UNIQUE INDEX "SharedSession_slug_key" ON "SharedSession"("slug");
