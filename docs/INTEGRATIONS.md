# Integrations

## Entire.io

[Entire.io](https://entire.io) captures AI agent sessions per git commit, storing them in `.entire/` inside your repo. Origin reads these checkpoints and surfaces them in the dashboard.

### How it works

1. Developer installs Entire: `curl -fsSL https://entire.io/install.sh | bash`
2. Initialize in repo: `entire init`
3. Developer works with Claude Code or Cursor — Entire captures the session automatically on commit
4. Run `origin sync` in the repo — Origin reads `.entire/` and imports the sessions
5. Sessions appear in Origin dashboard linked to commits

### Supported tools

Entire captures sessions from:
- Claude Code
- Cursor
- Gemini CLI
- Aider
- OpenCode

---

## GitHub

Connect a GitHub repo to Origin to automatically sync commits and sessions.

### Setup

1. Go to **Repositories** in Origin
2. Click **Add Repository**
3. Select **GitHub** as provider
4. Enter `owner/repo` format (e.g. `dolobanko/my-app`)
5. Click **Sync**

Origin uses the GitHub API to fetch commits. For private repos, add a GitHub token to your environment:

```bash
GITHUB_TOKEN=ghp_your_token bash dev.sh
```

### What gets synced

- Commit history (SHA, message, author, timestamp)
- Sessions from `.entire/` checkpoints in the repo
- Links commits to sessions for session replay

---

## GitLab

Same as GitHub, select **GitLab** as provider and enter your repo path.

For private repos, set `GITLAB_TOKEN` in your environment.

---

## Agent Trace

Origin supports the [Agent Trace spec](https://agent-trace.dev) — an open standard (backed by Cursor, Vercel, Google, Cloudflare) for tracking AI code attribution per commit.

### Ingest an Agent Trace record

```bash
curl -X POST http://localhost:4002/api/agent-traces \
  -H "Authorization: Bearer YOUR_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "version": "0.1.0",
    "id": "550e8400-e29b-41d4-a716-446655440001",
    "timestamp": "2026-03-01T10:00:00Z",
    "vcs": {
      "type": "git",
      "revision": "a1b2c3d4e5f6"
    },
    "tool": {
      "name": "claude-code",
      "version": "2.1.62"
    },
    "files": [
      {
        "path": "src/api/routes.ts",
        "conversations": [{
          "contributor": {
            "type": "ai",
            "model_id": "anthropic/claude-sonnet-4-6"
          },
          "ranges": [{ "start_line": 1, "end_line": 120 }]
        }]
      }
    ]
  }'
```

### What Origin does with it

- Links the trace to the matching commit
- Shows AI authorship per file in the session detail view
- Includes AI attribution data in the Insights page
- Available for compliance export

---

## MCP Protocol

Origin implements the [Model Context Protocol](https://modelcontextprotocol.io) for native integration with Claude Code and Cursor.

See [MCP Server docs](MCP_SERVER.md) for full setup instructions.
