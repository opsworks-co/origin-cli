# API Reference

Base URL: `http://localhost:4002/api`

All endpoints except auth require a `Authorization: Bearer TOKEN` header.
MCP endpoints use `x-api-key: YOUR_API_KEY` header instead.

---

## Auth

### POST `/auth/register`
Register a new org and user.

```json
{
  "orgName": "Acme Corp",
  "orgSlug": "acme",
  "name": "Artem Dolobanko",
  "email": "artem@acme.com",
  "password": "password123"
}
```

Returns: `{ token, user }`

---

### POST `/auth/login`
```json
{ "email": "artem@acme.com", "password": "password123" }
```
Returns: `{ token, user }`

---

### GET `/auth/me`
Returns current user and org info.

---

## Sessions

### GET `/sessions`
List all AI coding sessions for the org.

Query params:
- `model` — filter by model (claude-code, cursor, etc.)
- `status` — filter by review status (pending, approved, rejected, flagged)
- `repoId` — filter by repo
- `limit` — page size (default 20)
- `offset` — pagination offset

Returns: `{ sessions: [...], total, limit, offset }`

---

### GET `/sessions/:id`
Get a single session with full transcript.

Returns session with:
- Commit info (sha, message, author, repo)
- Agent info
- Full transcript array
- Files changed array
- Stats (tokens, cost, duration, tool calls)
- Review (if reviewed)

---

### POST `/sessions/:id/review`
Review a session.

```json
{
  "status": "APPROVED",
  "note": "Looks good, clean implementation"
}
```

Status options: `APPROVED` | `REJECTED` | `FLAGGED`

---

### GET `/sessions/:id/blame?file=<filepath>`
Line-level AI attribution for a file in a session.

Query params:
- `file` (required) — file path to get blame for

Returns: `{ file, totalAttributedLines, lines: [{ lineNumber, content, attribution }], prompts }`

---

### POST `/sessions/:id/ask`
Ask questions about a coding session. Requires `ANTHROPIC_API_KEY`.

```json
{
  "question": "Why was this approach chosen?",
  "context": { "file": "src/auth.ts", "promptIndex": 0 },
  "messages": []
}
```

Returns: `{ "answer": "..." }`

---

## Repos

### GET `/repos`
List connected repos.

### POST `/repos`
Connect a repo.

```json
{
  "name": "my-app",
  "path": "/Users/me/projects/my-app",
  "provider": "local"
}
```

Provider options: `local` | `github` | `gitlab`

For GitHub: `"path": "owner/repo"`

### POST `/repos/:id/sync`
Sync commits and sessions from the repo.

---

## Agents

### GET `/agents`
List registered AI agents.

### POST `/agents`
Register an agent.

```json
{
  "name": "Claude Code",
  "model": "claude-code",
  "description": "Primary coding agent"
}
```

### GET `/agents/:id`
Get agent details with session history.

### PUT `/agents/:id`
Update agent.

---

## Policies

### GET `/policies`
List all policies.

### POST `/policies`
Create a policy.

```json
{
  "name": "Protect payments",
  "description": "Block AI from touching payment code",
  "type": "FILE_RESTRICTION",
  "active": true
}
```

Types: `FILE_RESTRICTION` | `REQUIRE_REVIEW` | `MODEL_ALLOWLIST` | `COST_LIMIT`

### PUT `/policies/:id`
Update a policy.

### DELETE `/policies/:id`
Delete a policy.

---

## Settings (API Keys)

### GET `/settings/api-keys`
List API keys for the org (prefix only, never full key).

### POST `/settings/api-keys`
Create a new API key.

```json
{ "name": "MCP Server" }
```

Returns: `{ id, name, keyPrefix, key, createdAt }`
⚠️ The full `key` is only returned once. Save it immediately.

### DELETE `/settings/api-keys/:id`
Delete an API key.

---

## Machines

### GET `/machines`
List registered machines.

### POST `/machines`
Register a machine (called by CLI `origin init`).

```json
{
  "hostname": "artems-mac",
  "machineId": "machine-001",
  "detectedTools": ["claude-code", "cursor"]
}
```

---

## MCP Endpoints

These use `x-api-key` header authentication (not Bearer token).

### GET `/mcp/policies`
Returns active policies for the org. Called by MCP server on session start.

### POST `/mcp/session/start`
```json
{
  "machineId": "machine-001",
  "prompt": "Add rate limiting to the API",
  "model": "claude-code",
  "repoPath": "/workspace/my-app"
}
```
Returns: `{ sessionId }`

### POST `/mcp/session/end`
```json
{
  "sessionId": "uuid",
  "summary": "Added Redis-based rate limiting",
  "tokensUsed": 45000,
  "toolCalls": 28
}
```

### POST `/mcp/violations`
```json
{
  "machineId": "machine-001",
  "policyId": "uuid",
  "description": "Attempted to modify src/payments/stripe.ts",
  "filepath": "src/payments/stripe.ts"
}
```

---

## Stats

### GET `/stats`
Org-wide stats.

Returns:
```json
{
  "totalSessions": 26,
  "activeAgents": 2,
  "sessionsThisWeek": 11,
  "aiPercentage": 100,
  "tokensUsed": 728220,
  "costUsd": 18.84,
  "unreviewed": 16,
  "linesWritten": 3689,
  "estimatedHoursSaved": 74,
  "modelBreakdown": {
    "claude-code": 8,
    "cursor": 6,
    "aider": 5,
    "gemini-cli": 4,
    "copilot": 3
  }
}
```

---

## Audit Log

### GET `/audit`
Returns audit log entries for the org, ordered by most recent.

Query params:
- `limit` — default 50
- `action` — filter by action type
