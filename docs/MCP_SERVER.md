# MCP Server

The Origin MCP server runs inside Claude Code and Cursor. It gives AI agents full access to governance policies, session tracking, and platform data — all without leaving the coding environment.

---

## What It Does

1. **Loads policies** from your Origin instance when a session starts
2. **Injects rules** into the agent's context so it knows what it can and can't do
3. **Checks file access** before the agent reads or writes restricted paths
4. **Reports violations** back to Origin in real time
5. **Tracks sessions** — start, end, cost, tool calls
6. **Queries platform data** — sessions, agents, repos, stats, audit logs
7. **Reviews sessions** — approve, reject, or flag directly from the agent

---

## Installation

### Prerequisites

- Origin running locally or hosted
- An API key from **Settings > API Keys > Create New**
- Node.js 18+

### Build the MCP server

```bash
cd /path/to/origin/packages/mcp-server
pnpm install && pnpm build
```

### Claude Code setup

Add to `~/.claude/settings.json`:

```json
{
  "mcpServers": {
    "origin": {
      "command": "node",
      "args": ["/path/to/origin/packages/mcp-server/dist/index.js"],
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
      "args": ["/path/to/origin/packages/mcp-server/dist/index.js"],
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

The MCP server exposes 16 tools across two categories:

### Governance Tools (5)

#### `check_file_access(filepath, action)`

Check if a file can be accessed before reading or writing.

- `filepath` — the path being accessed
- `action` — `"read"` | `"write"` | `"delete"`

Returns:
```json
{ "allowed": true, "requiresReview": false, "policy": null }
```

Or if blocked:
```json
{ "allowed": false, "requiresReview": false, "policy": "Protect payments module" }
```

#### `report_violation(policy_id, description, filepath)`

Report a policy violation to Origin.

#### `start_session(prompt, model, repoPath)`

Start a new coding session. Returns a `sessionId` for tracking.

#### `end_session(sessionId, summary)`

End the current session. Sends final stats to Origin.

#### `log_tool_call(sessionId, tool, args, result)`

Log individual tool calls for the audit trail.

---

### Platform Tools (11)

#### `list_sessions(status?, model?, limit?)`

List recent AI coding sessions with optional filters.

- `status` — `"unreviewed"` | `"reviewed"` | `"approved"` | `"rejected"` | `"flagged"`
- `model` — Filter by AI model name
- `limit` — Max results (default: 20)

Returns session list with commit info, review status, cost, and tokens.

#### `get_session(session_id)`

Get full details of a specific session including transcript, files changed, commit info, agent info, and review status.

#### `review_session(session_id, status, note?)`

Approve, reject, or flag a coding session.

- `status` — `"APPROVED"` | `"REJECTED"` | `"FLAGGED"`
- `note` — Optional review note

#### `list_agents()`

List all registered AI coding agents with their model, status, and session count.

#### `list_repos()`

List all connected code repositories with commit counts and sync status.

#### `get_stats()`

Get dashboard statistics including:
- Sessions this week, active agents
- AI authorship percentage
- Token usage and costs
- Unreviewed sessions count
- Policy violations
- Cost breakdown by model
- Top agents and engineers

#### `get_audit_log(action?, limit?)`

View recent audit log entries.

- `action` — Filter by type (e.g. `"AGENT_CREATED"`, `"POLICY_UPDATED"`)
- `limit` — Max entries (default: 30)

#### `get_policy_versions(policy_id)`

View version history for a specific policy. Returns all versions with change type, snapshot, and timestamp.

- `policy_id` — Policy ID (required)

#### `get_agent_versions(agent_id)`

View version history for a specific agent. Returns all versions with change type, snapshot, and timestamp.

- `agent_id` — Agent ID (required)

#### `list_notifications(unread?, limit?)`

View notifications for the current user.

- `unread` — Only show unread notifications (boolean)
- `limit` — Max results (default: 20)

Returns notification list with type, title, message, read status, and timestamp.

#### `list_users()`

List all team members in the organization with activity stats including session count, review count, total cost, and last active date.

---

## All Tools Reference

| Tool | Category | Description |
|------|----------|-------------|
| `check_file_access` | Governance | Check file path against policies |
| `report_violation` | Governance | Report a policy violation |
| `start_session` | Governance | Start session tracking |
| `end_session` | Governance | End session tracking |
| `log_tool_call` | Governance | Log tool call for audit |
| `list_sessions` | Platform | List coding sessions |
| `get_session` | Platform | Get session details |
| `review_session` | Platform | Approve/reject/flag session |
| `list_agents` | Platform | List registered agents |
| `list_repos` | Platform | List repositories |
| `get_stats` | Platform | Dashboard statistics |
| `get_audit_log` | Platform | View audit log |
| `get_policy_versions` | Platform | View policy version history |
| `get_agent_versions` | Platform | View agent version history |
| `list_notifications` | Platform | View user notifications |
| `list_users` | Platform | List team members with stats |

---

## Getting Your API Key

1. Open Origin > **Settings**
2. Under **API Keys** > enter a name > **Create New**
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
- Verify `ORIGIN_API_KEY` is valid (check Settings > API Keys)
- Check Origin API is running: `curl http://localhost:4002/api/mcp/policies -H "x-api-key: YOUR_KEY"`

**Violations not showing in dashboard**
- Check the machine is registered: `origin status`
- Verify the session started correctly (check Origin > Sessions)
