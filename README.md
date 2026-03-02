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
- **Intent Review** — approve, reject, or flag AI sessions before they ship
- **Audit Trail** — complete log of every AI decision in your codebase
- **Insights** — AI authorship %, cost by model, ROI tracking
- **Machine Registration** — know which engineers are using which AI tools
- **MCP Server** — native integration with Claude Code and Cursor
- **CLI** — `origin init` registers your machine in 30 seconds

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
origin init        # register this machine, detect AI tools
origin policies    # view your org's active policies
```

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

**Ports:**
- API: `http://localhost:4002`
- Web: `http://localhost:5176`

---

## Docs

- [Policies Guide](docs/POLICIES.md)
- [MCP Server Setup](docs/MCP_SERVER.md)
- [CLI Reference](docs/CLI.md)
- [API Reference](docs/API.md)
- [Integrations](docs/INTEGRATIONS.md)

---

## Tech Stack

- **Backend:** Node.js, Express, TypeScript, Prisma, SQLite
- **Frontend:** React, Vite, Tailwind CSS
- **Protocol:** MCP (Model Context Protocol)
- **Integrations:** Entire.io, GitHub API, Agent Trace spec

---

## License

MIT
