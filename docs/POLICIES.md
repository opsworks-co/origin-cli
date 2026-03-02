# Policies

Policies are the rules that govern how AI coding agents operate in your organization. Origin enforces them in real time via the MCP server — before code is written, not after.

---

## Policy Types

### FILE_RESTRICTION
Block or warn when an AI agent tries to modify specific files or directories.

**Use when:** You have sensitive code that should never be touched by AI without explicit human involvement.

**Example:** Block all AI changes to `src/payments/**`

### REQUIRE_REVIEW
Flag sessions that touch certain code paths for mandatory human review before merge.

**Use when:** You want AI agents to work freely but ensure a human reviews anything security-critical.

**Example:** Any changes to `src/auth/**` require senior engineer sign-off.

### MODEL_ALLOWLIST
Restrict which AI models are allowed to write code in your repos.

**Use when:** You have approved specific models for compliance reasons and need to block unapproved ones.

**Example:** Only `claude-code` and `cursor` are allowed. Block `aider` and `copilot`.

### COST_LIMIT
Alert or block when a single AI session exceeds a cost threshold.

**Use when:** You want to prevent runaway AI usage that burns through your API budget.

**Example:** Warn when a session exceeds $5. Block when it exceeds $20.

---

## Creating Policies

### Via the UI

1. Go to **Policies** in the sidebar
2. Click **Add Policy**
3. Fill in:
   - **Name** — descriptive, e.g. "No AI changes to payments"
   - **Description** — what this policy does and why
   - **Type** — select from the four types above
   - **Active** — toggle on to enforce immediately
4. Save

### Via the API

```bash
curl -X POST http://localhost:4002/api/policies \
  -H "Authorization: Bearer YOUR_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "name": "No payments changes",
    "description": "Block AI from touching payment processing code",
    "type": "FILE_RESTRICTION",
    "active": true
  }'
```

---

## How Enforcement Works

When an engineer starts a Claude Code or Cursor session with the Origin MCP server loaded:

1. MCP server fetches your org's active policies from Origin
2. Policies are injected into the agent's context as rules it must follow
3. Before touching a file, the agent calls `check_file_access` — MCP server checks against policies
4. If restricted: returns `{ allowed: false }` — agent stops and reports to Origin
5. Violation is logged in Origin's audit trail and surfaces on the dashboard

---

## Common Policy Examples

### "No AI changes to payments code"
```json
{
  "name": "Protect payments module",
  "type": "FILE_RESTRICTION",
  "rules": [{ "path": "src/payments/**", "action": "BLOCK" }]
}
```

### "Infrastructure changes require review"
```json
{
  "name": "Review all infra changes",
  "type": "REQUIRE_REVIEW",
  "rules": [{ "path": "infra/**", "action": "FLAG" }]
}
```

### "Only approved models in production repos"
```json
{
  "name": "Approved models only",
  "type": "MODEL_ALLOWLIST",
  "rules": [{ "allowed": ["claude-code", "cursor"] }]
}
```

### "Alert on expensive sessions"
```json
{
  "name": "Session cost limit",
  "type": "COST_LIMIT",
  "rules": [{ "threshold": 5.00, "action": "WARN" }]
}
```
