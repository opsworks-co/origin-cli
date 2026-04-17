# Origin Platform

Self-hosting the connected platform.

The Origin CLI works standalone with no server. This document covers running the full platform yourself — dashboard, policy enforcement, PR compliance, team features, MCP server.

If you just want AI attribution in your terminal, you don't need any of this. Read the [main README](../README.md) and run `origin init`.

---

## What the platform adds

Beyond the standalone CLI:

- **Dashboard** — session replay, cost tracking, AI percentage per repo
- **Policy enforcement** — rules enforced inside Claude Code and Cursor via the MCP server
- **PR blocking** — GitHub status checks that block merges when AI sessions violate policies
- **Commit annotations** — `[AI 73%]` badges on GitHub PRs via the Check Runs API
- **Intent review** — approve, reject, or flag AI sessions before they ship
- **Compliance** — score, violation trends, exportable reports for SOC 2 / ISO 27001
- **Model comparison** — cost, token usage, approval rates across agents
- **Leaderboard** — rank team members by usage, lines, cost, quality score
- **Real-time secret detection** — pre-commit blocking plus admin notifications
- **Slack notifications** — alerts for violations, reviews, budget
- **GitHub App** — one-click install with bot identity on status checks
- **MCP server** — native integration with Claude Code and Cursor

---

## Prerequisites

- Node.js 22+
- `pnpm` (`npm i -g pnpm`)
- Git

---

## Run the platform locally

```bash
git clone https://github.com/dolobanko/origin
cd origin
pnpm install
cd apps/api && DATABASE_URL="file:./dev.db" npx prisma db push && cd ../..
npm run dev                 # starts API on :4002 and web on :5176
npm run cli:local           # (new terminal) seeds dev user + points CLI at localhost
```

`npm run cli:local` creates a dev org + user, prints the credentials on stderr, and writes a fresh API key to `~/.origin/config.json`. The email and password are generated inside `scripts/dev-seed.ts` — inspect that file to see (or change) them.

> ⚠️ The seed credentials are for local development only. Never use them on a reachable host. Change them in `scripts/dev-seed.ts` before any shared deployment.

---

## Install CLI and connect to your local instance

```bash
npm i -g https://getorigin.io/cli/origin-cli-latest.tgz
npm run cli:local    # from the repo root — points CLI at localhost:4002
```

Or to connect to your own hosted instance:

```bash
origin login --url https://origin.your-company.com
origin init
```

---

## MCP server setup (Claude Code)

Add to `~/.claude/settings.json`:

```json
{
  "mcpServers": {
    "origin": {
      "command": "node",
      "args": ["/path/to/origin/packages/mcp-server/dist/index.js"],
      "env": {
        "ORIGIN_API_URL": "http://localhost:4002",
        "ORIGIN_API_KEY": "your-api-key-from-settings"
      }
    }
  }
}
```

Generate the API key from the Settings page in your dashboard, or via `origin login` which writes it to `~/.origin/config.json`.

---

## Deploy to production

Origin ships with a `fly.toml` for Fly.io. Two separate apps are configured:

- **`fly.toml`** — production (`origin-platform` → getorigin.io)
- **`fly.dev.toml`** — staging (`origin-platform-dev` → origin-platform-dev.fly.dev)

```bash
npm run deploy:prod    # production
npm run deploy:dev     # staging
```

For the first deploy:

```bash
fly apps create origin-platform
fly volumes create origin_data -a origin-platform --region iad --size 1
fly secrets set -a origin-platform JWT_SECRET=$(openssl rand -hex 32)
fly deploy
```

The single-machine Fly config uses a mounted volume at `/data` for the SQLite database. For larger deployments, swap SQLite for Postgres — the schema in `apps/api/prisma/schema.prisma` works on either.

---

## Architecture

```
origin/
├── apps/
│   ├── api/          # Express + TypeScript + Prisma (SQLite) — port 4002
│   └── web/          # React + Vite + Tailwind CSS — port 5176
├── packages/
│   ├── cli/          # Origin CLI — attribution, sessions, hooks
│   └── mcp-server/   # MCP server for Claude Code and Cursor
├── scripts/
│   ├── dev-seed.ts   # Seeds dev user + API key for local dev
│   ├── cli-local.sh  # Point the CLI at localhost:4002
│   ├── cli-dev.sh    # Point the CLI at the Fly dev deployment
│   └── cli-prod.sh   # Point the CLI back at production
├── fly.toml          # Production deployment
└── fly.dev.toml      # Staging deployment
```

### Dashboard pages

Dashboard, Repositories, Live Feed, Snapshots, Insights, Integrations, API Keys, Settings.

### Ports

| Environment | API | Web |
|-------------|-----|-----|
| Local dev | `http://localhost:4002` | `http://localhost:5176` |
| Staging | `https://origin-platform-dev.fly.dev` | same |
| Production | `https://getorigin.io` | same |

---

## Running tests

```bash
cd apps/api && npx vitest run          # API tests
cd packages/cli && npx vitest run      # CLI tests (includes alias resolution)
```

---

## Tech stack

- **Backend:** Node.js 22, Express, TypeScript, Prisma, SQLite (works with Postgres)
- **Frontend:** React 19, Vite, Tailwind CSS, Recharts
- **Protocol:** MCP (Model Context Protocol) for agent integration
- **Integrations:** GitHub App, Slack Webhooks
- **Deployment:** Fly.io (Docker, single-machine with volume mount)

---

## License

Platform code: MIT (same as the CLI). Running code yourself is free. Running code on getorigin.io as a hosted service is subject to the [commercial Terms of Service](https://getorigin.io/terms). See [LICENSE](../LICENSE).
