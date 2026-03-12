# Origin

**Know exactly what your AI agents are writing.**

Origin is a governance platform for engineering teams using AI coding agents — Claude Code, Cursor, Gemini CLI, Aider, Copilot. It captures every AI coding session, enforces your organization's policies, and gives CTOs and CSOs full visibility into AI-authored code.

---

## Why Origin

When AI agents write your code:
- Who reviews the intent, not just the diff?
- How do you enforce "never touch payments without human approval"?
- What's your audit trail when something breaks in production?
- How do you prove to your board that AI code is under control?

Git blame shows you *who*. Origin shows you *why* and *how*.

---

## Features

- **Session Replay** — full transcript of every AI coding session, linked to every commit
- **Policy Enforcement** — rules enforced inside Claude Code and Cursor via MCP server
- **PR Blocking** — GitHub status checks that block merges when AI sessions violate policies
- **Intent Review** — approve, reject, or flag AI sessions before they ship
- **Audit Trail** — complete log of every AI decision in your codebase
- **Compliance Dashboard** — compliance score, policy violation trends, and exportable reports
- **Model Comparison** — cost, token usage, and approval rates across AI models over time
- **Leaderboard** — rank team members by AI usage, lines written, cost, and quality score
- **Prompt Analytics** — searchable log of every prompt with pattern detection
- **Investigation Trails** — group related sessions into audit investigation threads
- **AI Blame** — line-level attribution showing which AI prompt produced each line of code
- **Ask the Author** — ask natural-language questions about any AI coding session
- **Insights** — AI authorship %, cost by model, ROI tracking
- **Machine Registration** — know which engineers are using which AI tools
- **MCP Server** — native integration with Claude Code and Cursor
- **CLI** — `origin init` registers your machine in 30 seconds
- **Slack Notifications** — real-time alerts for violations, reviews, and budget
- **GitHub App** — one-click install with bot identity on status checks

---

## Quick Start

### 1. Clone and run

```bash
git clone https://github.com/dolobanko/origin-v2
cd origin-v2
pnpm install
cd apps/api && npx prisma db push && npx tsx prisma/seed.ts && cd ../..
bash dev.sh
```

Open **http://localhost:5176**

Demo login: `artem@origin.dev` / `password123`

### 2. Install the CLI

```bash
# From the repo:
cd packages/cli && pnpm build
node dist/index.js login
```

### 3. Register your machine

```bash
origin login       # authenticate with your Origin instance
origin init        # register machine, auto-detect AI tools, install global hooks
origin policies    # view your org's active policies (optional)
```

> **That's it — 2 commands.** `origin init` auto-detects installed AI tools (Claude Code, Cursor, Copilot, Gemini, Aider, Windsurf, Cody, etc.) via CLI checks, IDE extension scanning, and MCP config inspection. Global hooks are installed so all repos are tracked automatically. Tools are re-scanned on every session start.

### 4. Add the MCP server to Claude Code

Add to `~/.claude/settings.json`:

```json
{
  "mcpServers": {
    "origin": {
      "command": "node",
      "args": ["/path/to/origin-v2/packages/mcp-server/dist/index.js"],
      "env": {
        "ORIGIN_API_URL": "http://localhost:4002",
        "ORIGIN_API_KEY": "your-api-key-from-settings"
      }
    }
  }
}
```

### 5. Add the MCP server to Cursor

Add to `.cursor/mcp.json` in your repo:

```json
{
  "mcpServers": {
    "origin": {
      "command": "node",
      "args": ["/path/to/origin-v2/packages/mcp-server/dist/index.js"]
    }
  }
}
```

Get your API key from **Settings → API Keys → Create New**.

---

## Architecture

```
origin-v2/
├── apps/
│   ├── api/          # Express + TypeScript + Prisma (SQLite)
│   └── web/          # React + Vite + Tailwind CSS (dark theme)
└── packages/
    ├── cli/          # origin CLI — login, init, sync, policies
    └── mcp-server/   # MCP server for Claude Code and Cursor
```

**Dashboard Pages:** Dashboard, Repositories, Agents, Sessions, PR Checks, Leaderboard, Trails, Prompts, Compliance, Models, Policies, Settings

**Ports:**
- API: `http://localhost:4002`
- Web: `http://localhost:5176`
- Production: `https://origin-platform.fly.dev`

---

## Testing Data Ingestion

### Option A: Test with curl

```bash
# 1. Get your API key from Settings → API Keys → Create New
API_KEY="org_sk_..."

# 2. Start a session
curl -X POST http://localhost:4002/api/mcp/session/start \
  -H "X-API-Key: $API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "machineId": "my-laptop",
    "prompt": "Add user authentication to the app",
    "model": "claude-code",
    "repoPath": "origin"
  }'
# → Returns { "sessionId": "abc123..." }

# 3. End the session with metrics
curl -X POST http://localhost:4002/api/mcp/session/end \
  -H "X-API-Key: $API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "sessionId": "SESSION_ID_FROM_ABOVE",
    "summary": "Added JWT auth with login/register endpoints",
    "tokensUsed": 45000,
    "toolCalls": 23,
    "linesAdded": 340,
    "linesRemoved": 12,
    "costUsd": 0.85,
    "filesChanged": "[\"src/auth.ts\", \"src/middleware.ts\"]",
    "durationMs": 180000
  }'

# 4. Check it appeared in the dashboard
open http://localhost:5176/sessions
```

### Option B: Test with the CLI

```bash
# Build CLI
cd packages/cli && npx tsc

# Login (API key from Settings page)
node dist/index.js login

# Register machine
node dist/index.js init

# View data
node dist/index.js sessions
node dist/index.js stats
node dist/index.js team

# Review a session
node dist/index.js review SESSION_ID --approve --note "Looks good"
```

### Option C: Connect an AI agent via MCP

```bash
# Build MCP server
cd packages/mcp-server && npx tsc
```

Add to Claude Code (`~/.claude/settings.json`):
```json
{
  "mcpServers": {
    "origin": {
      "command": "node",
      "args": ["/path/to/origin-v2/packages/mcp-server/dist/index.js"]
    }
  }
}
```

Add to Cursor (`.cursor/mcp.json`):
```json
{
  "mcpServers": {
    "origin": {
      "command": "node",
      "args": ["/path/to/origin-v2/packages/mcp-server/dist/index.js"]
    }
  }
}
```

Then when the AI agent codes, it will automatically call `start_session` and `end_session`, and sessions appear in Origin in real time.

### CLI Commands Reference

```
Setup:
  origin login                    Authenticate (saves to ~/.origin/config.json)
  origin init                     Register this machine + detect AI tools
  origin whoami                   Show current user/org
  origin status                   Show system status

Sessions:
  origin sessions                 List sessions (--status, --model, --limit)
  origin session <id>             View session detail with transcript
  origin review <id> --approve    Review (--approve/--reject/--flag, --note)

Repos:
  origin repos                    List repositories
  origin repo:add                 Add repo (--name, --path, --provider)
  origin sync                     Sync session data from current repo

Agents:
  origin agents                   List agents
  origin agent:create             Create agent (--name, --slug, --model)
  origin agent:versions <id>      Version history

Governance:
  origin policies                 List active policies
  origin policy:versions <id>     Policy version history
  origin audit                    View audit log (--action, --limit)

Analytics:
  origin stats                    Dashboard statistics
  origin team                     List team members
  origin user <id>                User detail + recent sessions
  origin notifications            View notifications (--unread)
```

---

## Running Tests

```bash
cd apps/api && npx vitest run    # 150 tests, 11 files
```

---

## Tech Stack

- **Backend:** Node.js, Express, TypeScript, Prisma, SQLite
- **Frontend:** React, Vite, Tailwind CSS, Recharts
- **Protocol:** MCP (Model Context Protocol)
- **Integrations:** GitHub App, Slack Webhooks, Entire.io, Agent Trace spec
- **Deployment:** Fly.io (Docker, single-machine with volume mount)

---

## License

MIT
