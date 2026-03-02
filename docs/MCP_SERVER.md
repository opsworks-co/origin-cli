# MCP Server

The Origin MCP server runs inside Claude Code and Cursor. It loads your organization's policies, checks file access in real time, reports violations, and tracks sessions — all without interrupting your workflow.

---

## What It Does

1. **Loads policies** from your Origin instance when a session starts
2. **Injects rules** into the agent's context so it knows what it can and can't do
3. **Checks file access** before the agent reads or writes restricted paths
4. **Reports violations** back to Origin in real time
5. **Tracks sessions** — start, end, cost, tool calls

---

## Installation

### Prerequisites

- Origin running locally or hosted
- An API key from **Settings → API Keys → Create New**
- Node.js 18+

### Build the MCP server

```bash
cd /path/to/origin-v2/packages/mcp-server
pnpm install && pnpm build
```

### Claude Code setup

Add to `~/.claude/settings.json`:

```json
{
  "mcpServers": {
    "origin": {
      "command": "node",
      "args": ["/path/to/origin-v2/packages/mcp-server/dist/index.js"],
      "env": {
        "ORIGIN_API_URL": "http://localhost:4002",
        "ORIGIN_API_KEY": "org_sk_your_key_here"
      }
    }
  }
}
```

Restart Claude Code. You'll see "origin" in the MCP servers list.

### Cursor setup

Add to `.cursor/mcp.json` in your repo root:

```json
{
  "mcpServers": {
    "origin": {
      "command": "node",
      "args": ["/path/to/origin-v2/packages/mcp-server/dist/index.js"],
      "env": {
        "ORIGIN_API_URL": "http://localhost:4002",
        "ORIGIN_API_KEY": "org_sk_your_key_here"
      }
    }
  }
}
```

---

## MCP Resources

Resources the AI agent reads at session start:

### `origin://policies`

Returns all active policies for your org as human-readable rules:

```
ORIGIN GOVERNANCE POLICIES (read before starting work):

1. FILE_RESTRICTION: Never modify src/payments/** without explicit approval
2. REQUIRE_REVIEW: Changes to src/auth/** will be flagged for review
3. MODEL_ALLOWLIST: Only claude-code and cursor are approved
4. COST_LIMIT: Alert if session exceeds $5.00
```

### `origin://session`

Current session metadata: sessionId, machineId, user, startTime.

---

## MCP Tools

Tools the AI agent calls during a session:

### `check_file_access(filepath, action)`

Check if a file can be accessed before reading or writing.

- `filepath` — the path being accessed
- `action` — `"read"` | `"write"` | `"delete"`

Returns:
```json
{
  "allowed": true,
  "requiresReview": false,
  "policy": null
}
```

Or if blocked:
```json
{
  "allowed": false,
  "requiresReview": false,
  "policy": "Protect payments module"
}
```

### `report_violation(policyId, description, filepath)`

Called when the agent detects it's about to violate a policy.

### `start_session(prompt, model, repoPath)`

Called at session start. Returns a `sessionId` used for tracking.

### `end_session(sessionId, summary)`

Called when the session ends. Sends final stats to Origin.

### `log_tool_call(sessionId, tool, args, result)`

Optional. Logs individual tool calls for full audit trail.

---

## Getting Your API Key

1. Open Origin → **Settings**
2. Under **API Keys** → enter a name → **Create New**
3. Copy the key shown (it's only displayed once)
4. Add to your MCP server config as `ORIGIN_API_KEY`

---

## Troubleshooting

**MCP server not loading in Claude Code**
- Check `~/.claude/settings.json` syntax is valid JSON
- Verify the path to `dist/index.js` is correct and absolute
- Run `node /path/to/mcp-server/dist/index.js` manually to check for errors

**Policies not loading**
- Verify `ORIGIN_API_URL` points to your running Origin instance
- Verify `ORIGIN_API_KEY` is valid (check Settings → API Keys)
- Check Origin API is running: `curl http://localhost:4002/api/mcp/policies -H "x-api-key: YOUR_KEY"`

**Violations not showing in dashboard**
- Check the machine is registered: `origin status`
- Verify the session started correctly (check Origin → Sessions)
