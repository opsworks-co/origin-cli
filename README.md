# Origin v2

**AI Agent Governance Platform** — Full visibility into every AI coding session: what was prompted, what was built, and whether it followed the rules.

Origin gives CTOs and CSOs the tools to monitor, govern, and audit AI-authored code across their organization.

## Features

- **Session Replay** — Full transcript of every AI coding interaction with prompt, response, tool calls, tokens, cost
- **Repository Integration** — Connect local or GitHub repos, auto-sync commits, identify AI vs human authorship
- **Policy Enforcement** — Real-time governance rules: file restrictions, model allowlists, cost limits, review requirements
- **Agent Management** — Register and monitor AI coding agents (Claude Code, Cursor, Copilot, etc.)
- **Audit Trail** — Complete log of every action for compliance, security reviews, and SOC 2
- **Engineering Insights** — Charts for AI adoption trends, cost by model, top contributors, sessions by repo
- **CLI Tool** — Command-line interface for machine registration, repo sync, and status checks
- **MCP Server** — Model Context Protocol server for real-time policy enforcement in Claude Code and Cursor

## Architecture

```
origin-v2/
├── apps/
│   ├── api/          # Express + Prisma REST API (port 4002)
│   └── web/          # React + Vite + Tailwind dashboard (port 5176)
├── packages/
│   ├── cli/          # Origin CLI (@origin/cli)
│   └── mcp-server/   # MCP server (@origin/mcp-server)
└── pnpm-workspace.yaml
```

## Prerequisites

- **Node.js** 18 or higher
- **pnpm** 8 or higher
- **Git**

## Installation

### 1. Clone the repository

```bash
git clone https://github.com/your-org/origin-v2.git
cd origin-v2
```

### 2. Install dependencies

```bash
pnpm install
```

### 3. Set up the database

```bash
cd apps/api

# Create .env file (uses SQLite by default)
echo 'DATABASE_URL="file:./dev.db"' > .env
echo 'JWT_SECRET="your-secret-key-change-in-production"' >> .env

# Run migrations
npx prisma migrate dev --name init

# Generate Prisma client
npx prisma generate

# Seed with demo data
npx tsx prisma/seed.ts
```

### 4. Start the development servers

**Terminal 1 — API server:**
```bash
cd apps/api
npm run dev
```
The API starts on `http://localhost:4002`.

**Terminal 2 — Web dashboard:**
```bash
cd apps/web
npm run dev
```
The dashboard starts on `http://localhost:5176`.

### 5. Sign in

Open `http://localhost:5176` in your browser and sign in with the demo credentials:

| Field    | Value              |
|----------|--------------------|
| Email    | artem@origin.dev   |
| Password | password123        |

## Quick Start Guide

### Connect a Repository

1. Navigate to **Repositories** in the sidebar
2. Click **Add Repository**
3. Enter the repo name, local path (or GitHub URL), and provider
4. Click **Connect Repository**
5. Click **Sync Now** to import commits

### Review AI Sessions

1. Go to **Sessions** to see all AI coding sessions
2. Filter by model, status, or repository
3. Click a session to view the full transcript
4. Use **Approve**, **Reject**, or **Flag** to review

### Set Up Policies

1. Navigate to **Policies**
2. Click **Add Policy** and choose a type:
   - `FILE_RESTRICTION` — Block access to sensitive files
   - `REQUIRE_REVIEW` — Require human review
   - `MODEL_ALLOWLIST` — Only allow specific models
   - `COST_LIMIT` — Set cost thresholds
3. Add rules with conditions, actions, and severity levels
4. Toggle policies active to enforce via MCP

### Install the CLI

```bash
# Install globally
npm install -g @origin/cli

# Authenticate
origin login

# Register this machine
origin init

# Check status
origin status

# Sync repositories
origin sync

# View policies
origin policies
```

### Configure MCP Server

Add Origin as an MCP server in your AI coding tool:

**Claude Code** (`~/.claude/claude_desktop_config.json`):
```json
{
  "mcpServers": {
    "origin": {
      "command": "origin",
      "args": ["mcp", "serve"],
      "env": {
        "ORIGIN_API_URL": "http://localhost:4002"
      }
    }
  }
}
```

**Cursor** (`.cursor/mcp.json`):
```json
{
  "mcpServers": {
    "origin": {
      "command": "origin",
      "args": ["mcp", "serve"],
      "env": {
        "ORIGIN_API_URL": "http://localhost:4002"
      }
    }
  }
}
```

## Project Structure

### API (`apps/api`)

| Path | Description |
|------|-------------|
| `src/index.ts` | Express server entry point |
| `src/routes/auth.ts` | Authentication (login, register, me) |
| `src/routes/repos.ts` | Repository CRUD and sync |
| `src/routes/sessions.ts` | Session listing, detail, review |
| `src/routes/agents.ts` | Agent management |
| `src/routes/policies.ts` | Policy and rule management |
| `src/routes/stats.ts` | Dashboard analytics |
| `src/routes/audit.ts` | Audit log |
| `src/routes/machines.ts` | Machine registration |
| `src/routes/mcp.ts` | MCP API endpoints |
| `src/middleware/auth.ts` | JWT and API key authentication |
| `src/services/checkpoint.ts` | Git commit sync service |
| `prisma/schema.prisma` | Database schema (13 models) |
| `prisma/seed.ts` | Demo data seeder |

### Web (`apps/web`)

| Path | Description |
|------|-------------|
| `src/pages/Dashboard.tsx` | KPI cards, recent sessions, machines |
| `src/pages/Repos.tsx` | Repository list with add/sync |
| `src/pages/RepoDetail.tsx` | Commit browsing with filters |
| `src/pages/Sessions.tsx` | Session table with filters |
| `src/pages/SessionDetail.tsx` | Transcript replay, review |
| `src/pages/Agents.tsx` | Agent cards with create form |
| `src/pages/Policies.tsx` | Policy rules with toggle/create |
| `src/pages/AuditLog.tsx` | Audit trail table |
| `src/pages/Insights.tsx` | Analytics charts |
| `src/pages/Docs.tsx` | Built-in documentation |
| `src/pages/Settings.tsx` | API keys, team, agent setup |

### CLI (`packages/cli`)

| Command | Description |
|---------|-------------|
| `origin login` | Authenticate with Origin |
| `origin init` | Register machine |
| `origin status` | Connection and machine status |
| `origin policies` | List active policies |
| `origin sync` | Sync repositories |
| `origin whoami` | Current user info |

### MCP Server (`packages/mcp-server`)

| Resource/Tool | Description |
|---------------|-------------|
| `origin://policies` | Active governance policies |
| `origin://session` | Current session state |
| `check_file_access` | Check file against policies |
| `report_violation` | Report policy violation |
| `start_session` | Begin tracking a session |
| `end_session` | End and finalize a session |
| `log_tool_call` | Log tool invocation |

## API Endpoints

### Authentication
- `POST /api/auth/login` — Login (returns JWT + user)
- `POST /api/auth/register` — Create account with org
- `GET /api/auth/me` — Current user profile
- `POST /api/auth/api-keys` — Create API key
- `GET /api/auth/api-keys` — List API keys

### Repositories
- `GET /api/repos` — List repos
- `POST /api/repos` — Create repo
- `POST /api/repos/:id/sync` — Sync repo
- `GET /api/repos/:id/commits` — List commits

### Sessions
- `GET /api/sessions` — List sessions (filterable)
- `GET /api/sessions/:id` — Session detail
- `POST /api/sessions/:id/review` — Review session

### Agents
- `GET /api/agents` — List agents
- `POST /api/agents` — Create agent
- `GET /api/agents/:id` — Agent detail
- `PUT /api/agents/:id` — Update agent

### Policies
- `GET /api/policies` — List policies with rules
- `POST /api/policies` — Create policy
- `PUT /api/policies/:id` — Update policy
- `DELETE /api/policies/:id` — Delete policy
- `POST /api/policies/:id/rules` — Add rule

### Other
- `GET /api/stats` — Dashboard analytics
- `GET /api/audit` — Audit log entries
- `GET /api/machines` — Registered machines

## Database

Origin uses **SQLite** via Prisma with 13 models:

`Org` → `User` → `ApiKey`
`Org` → `Repo` → `Commit` → `CodingSession` → `SessionReview`
`Org` → `Agent` → `CodingSession`
`Org` → `Policy` → `PolicyRule`
`Org` → `Machine`
`Org` → `AuditLog`

## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `DATABASE_URL` | `file:./dev.db` | Prisma database connection |
| `JWT_SECRET` | (required) | Secret for signing JWT tokens |
| `PORT` | `4002` | API server port |

## Tech Stack

- **Backend:** Node.js, Express 5, TypeScript, Prisma, SQLite
- **Frontend:** React 18, Vite, Tailwind CSS, Recharts
- **CLI:** Commander.js, Chalk
- **MCP Server:** @modelcontextprotocol/sdk
- **Auth:** JWT (Bearer tokens), bcrypt password hashing
- **Package Manager:** pnpm workspaces

## License

Private — All rights reserved.
