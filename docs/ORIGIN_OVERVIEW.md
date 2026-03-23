# Origin Platform Overview

> **Know exactly what your AI agents are writing.**

Origin is a governance and compliance platform for AI coding agents. It gives engineering teams full visibility into AI-generated code, enforces organizational policies in real-time, and provides audit trails for compliance.

**Supported AI tools:** Claude Code, Cursor, GitHub Copilot, Gemini CLI, Aider, Windsurf, Cody

---

## Table of Contents

### Part 1: Business Perspective
- [1.1 Problem & Solution](#11-problem--solution)
- [1.2 Core Concepts](#12-core-concepts)
- [1.3 Policy System](#13-policy-system)
- [1.4 User Roles & Permissions](#14-user-roles--permissions)
- [1.5 Session Lifecycle](#15-session-lifecycle)
- [1.6 Integrations](#16-integrations)
- [1.7 Security Features](#17-security-features)
- [1.8 Compliance & Reporting](#18-compliance--reporting)

### Part 2: Technical Perspective
- [2.1 Monorepo Structure](#21-monorepo-structure)
- [2.2 Tech Stack](#22-tech-stack)
- [2.3 Database Schema](#23-database-schema)
- [2.4 API Architecture](#24-api-architecture)
- [2.5 Policy Engine](#25-policy-engine)
- [2.6 MCP Server](#26-mcp-server)
- [2.7 CLI Architecture](#27-cli-architecture)
- [2.8 Session Lifecycle (Technical)](#28-session-lifecycle-technical)
- [2.9 GitHub Integration](#29-github-integration)
- [2.10 Deployment](#210-deployment)
- [2.11 Testing](#211-testing)

---

# Part 1: Business Perspective

## 1.1 Problem & Solution

### The Problem

Engineering teams increasingly rely on AI agents to write code, but have no visibility into:
- **What** the AI is writing and why (no audit trail)
- **Whether** it follows company policies (sensitive files, auth patterns, payment code)
- **How much** it costs (no budget controls or cost attribution)
- **Who** is responsible (no per-developer tracking)
- **Whether** it introduced secrets or vulnerabilities

### The Solution

Origin captures every AI coding session with full transcripts, enforces organizational policies before code ships, and provides compliance dashboards for auditors. It integrates directly into the developer workflow via CLI hooks and the Model Context Protocol (MCP).

```
┌─────────────────────────────────────────────────────┐
│                    Origin Platform                   │
│                                                      │
│  ┌──────────┐  ┌──────────┐  ┌───────────────────┐  │
│  │  Policy   │  │ Session  │  │   Compliance &    │  │
│  │ Enforce-  │  │ Tracking │  │   Audit Trail     │  │
│  │  ment     │  │ & Replay │  │                   │  │
│  └──────────┘  └──────────┘  └───────────────────┘  │
│                                                      │
│  ┌──────────┐  ┌──────────┐  ┌───────────────────┐  │
│  │  GitHub   │  │  Cost &  │  │  Secret / PII     │  │
│  │    PR     │  │  Budget  │  │   Scanning        │  │
│  │ Blocking  │  │ Controls │  │                   │  │
│  └──────────┘  └──────────┘  └───────────────────┘  │
└─────────────────────────────────────────────────────┘
         │              │              │
    Claude Code      Cursor      Gemini CLI  ...
```

---

## 1.2 Core Concepts

### Entity Relationship

```
Organization (Org)
├── Users (with roles: OWNER, ADMIN, MEMBER, VIEWER)
├── Agents (AI tool configurations)
│   └── Agent Versions (change history)
├── Policies (governance rules)
│   ├── Policy Rules (scoped conditions)
│   └── Policy Assignments (agent-specific bindings)
├── Repositories (connected Git repos)
│   ├── Commits (with AI detection)
│   ├── Webhooks (GitHub event listeners)
│   └── Pull Requests (with status checks)
├── Coding Sessions (recorded AI interactions)
│   ├── Session Diff (code changes)
│   ├── Prompt Changes (per-prompt breakdown)
│   ├── Session Review (human or AI review)
│   └── Secret Findings (detected credentials/PII)
├── Machines (developer workstations)
├── Trails (investigation threads grouping sessions)
├── API Keys (scoped authentication tokens)
├── Audit Logs (action history)
└── Notifications (alerts)
```

### Key Entities

| Entity | Description |
|--------|-------------|
| **Organization** | Top-level tenant. Contains all users, agents, repos, policies, and sessions. Isolated from other orgs. |
| **User** | A team member with a role (OWNER, ADMIN, MEMBER, VIEWER). Each user can have individual API keys for session attribution. |
| **Agent** | A configured AI coding tool (e.g., "Claude Code Production"). Includes model, system prompt, allowed tools, cost/token limits, and file permissions. |
| **Session** | A recorded AI coding interaction. Captures the full transcript, files changed, tokens used, cost, duration, and review status. |
| **Policy** | A governance rule that restricts, flags, or blocks AI behavior. Scoped to the org, specific agents, machines, or repos. |
| **Repository** | A connected Git repository (local or GitHub). Tracks commits, PRs, and AI authorship detection. |
| **Machine** | A developer workstation identified by hostname and machine ID. Auto-detects installed AI tools. |
| **Trail** | An investigation thread that groups related sessions by feature, bug, or initiative. Tracks status (active/review/done/paused) and priority. |

---

## 1.3 Policy System

Origin enforces six types of policies. Policies can be org-wide or assigned to specific agents.

### Policy Types

| Type | Purpose | Example Condition | Actions | Enforcement |
|------|---------|-------------------|---------|-------------|
| **FILE_RESTRICTION** | Block or flag access to sensitive file paths | `**/.env`, `src/payments/**` | BLOCK, REQUIRE_REVIEW, WARN | Server-side + pre-commit hook |
| **MODEL_ALLOWLIST** | Restrict which AI models can be used | `["claude-sonnet-4", "gpt-4o"]` | BLOCK | Server-side (session start) |
| **REQUIRE_REVIEW** | Auto-flag sessions that exceed thresholds | `cost_above: 5.0`, `tokens_above: 100000` | FLAG, REQUIRE_REVIEW | Server-side (session end) |
| **COST_LIMIT** | Per-session cost or token ceilings | `max_cost: 10.0`, `max_tokens: 200000` | BLOCK, FLAG | Server-side (session end) |
| **CONTENT_FILTER** | Block commits containing specific patterns | `"baran"`, `"TODO HACK"` | BLOCK, WARN | Pre-commit hook (git level) |
| **COMMIT_MESSAGE** | Validate commit message format | `"^(feat\|fix\|chore):"` | BLOCK, WARN | Pre-commit hook (git level) |

### Policy Scoping

Each policy rule can be scoped to:
- **Agent** — applies only when a specific agent is used
- **Machine** — applies only on a specific developer machine
- **Repository** — applies only in a specific repo

If a policy has no assignments, it applies org-wide.

### PR Blocking

When a session violates a policy, Origin posts a failing `origin/ai-governance` status check on the associated GitHub PR. With branch protection enabled, the PR cannot merge until an admin reviews and approves the session.

For detailed policy configuration, see [POLICIES.md](POLICIES.md).

---

## 1.4 User Roles & Permissions

| Role | Level | Capabilities |
|------|-------|-------------|
| **VIEWER** | 0 | Read-only access to dashboards, sessions, and reports |
| **MEMBER** | 1 | Create and manage policies, agents, sessions. Conduct reviews |
| **ADMIN** | 2 | Manage users, delete policies, restore agent versions, configure integrations |
| **OWNER** | 3 | Full org access including billing, budget controls, and team management |

Roles are hierarchical — a higher role inherits all lower-role permissions.

**API Keys** can be:
- Linked to a user (inherits that user's role)
- Standalone with an explicit role (VIEWER, MEMBER, ADMIN)
- Scoped to specific repositories or agents

---

## 1.5 Session Lifecycle

```
Developer Prompt
       │
       ▼
  AI Agent starts coding
       │
       ▼
  ┌─ SESSION START ─────────────────────────┐
  │  • Budget check                         │
  │  • Model allowlist check                │
  │  • System prompt + policies injected    │
  └─────────────────────────────────────────┘
       │
       ▼
  ┌─ DURING SESSION ────────────────────────┐
  │  • Real-time file access checks (MCP)   │
  │  • Token/cost accumulation              │
  │  • Transcript recorded                  │
  └─────────────────────────────────────────┘
       │
       ▼
  ┌─ SESSION END ───────────────────────────┐
  │  • Metrics recorded (tokens, cost,      │
  │    files, lines, duration)              │
  │  • Policy engine evaluates all rules    │
  │  • AI auto-review (quality score 0-100) │
  │  • Secret/PII scanning                  │
  │  • GitHub status check updated          │
  │  • Slack notification (if violations)   │
  └─────────────────────────────────────────┘
       │
       ▼
  ┌─ POST-SESSION ──────────────────────────┐
  │  • Human review (approve/reject/flag)   │
  │  • PR merge gated on review status      │
  │  • Audit log entry created              │
  └─────────────────────────────────────────┘
```

### Session Review

Sessions can be reviewed by humans or automatically by AI:
- **AI Auto-Review**: Claude analyzes the transcript and diff, producing a quality score (0-100), risk level (low/medium/high/critical), concerns, suggestions, and category scores (security, scope, quality, cost)
- **Human Review**: Team members can approve, reject, or flag sessions with notes

---

## 1.6 Integrations

### GitHub

Two integration modes:
- **GitHub App** (recommended): One-click install, automatic webhook setup, token auto-refresh
- **Personal Access Token (PAT)**: Manual setup, requires webhook configuration

Features:
- **Status Checks**: `origin/ai-governance` check on commits/PRs (pass/fail based on policy engine)
- **PR Comments**: AI Governance Report posted on PRs with session summary, cost, and review status
- **AI Commit Detection**: Identifies AI-authored commits via co-author trailers, author patterns, and commit message signatures

### Slack

Incoming webhook integration for real-time notifications:
- Policy violations
- Sessions flagged for review
- Budget threshold alerts

### Budget Management

- Monthly spending limits (per org)
- Alert thresholds (e.g., 50%, 80%, 90%, 100% of budget)
- Optional session blocking when budget exceeded
- Per-model cost tracking (input/output token pricing)

---

## 1.7 Security Features

### Secret & PII Scanning

Every session is scanned at completion for:

| Finding Type | Examples |
|-------------|----------|
| API_KEY | Generic API keys in code |
| AWS_SECRET | AWS access key IDs and secret keys |
| PRIVATE_KEY | RSA/SSH private keys |
| PASSWORD | Hardcoded passwords |
| PII_EMAIL | Email addresses in code |
| CONNECTION_STRING | Database connection strings |
| JWT_TOKEN | JSON Web Tokens |
| GENERIC_SECRET | Other credential patterns |

Findings are stored with severity level, file path, line number, and redacted match. Org admins are notified of critical findings.

### Security Rules Toggle

Each agent has a **Security Rules** toggle in its configuration (default: OFF). When enabled, Origin automatically injects a `<security-rules>` block into the agent's system prompt at session start. This adds 8 default rules covering:

1. Never log, print, or commit secrets, API keys, or credentials
2. Protect `.env` files, `.git` folder, and system configurations
3. Never hardcode credentials — use environment variables
4. Always use environment variables for sensitive data
5. Never expose sensitive info in logs or error messages
6. Redact sensitive data before displaying
7. Never store passwords in plain text
8. Report security concerns immediately

**How it works:**
- Toggle ON → `<security-rules>` block appended to system prompt on new sessions
- Toggle OFF → no security rules injected (default)
- Custom rules can override the defaults via the Security Rules textarea
- Changes only apply to **new sessions** — running sessions keep their original prompt
- Agent version snapshots include the security rules state

**Important:** This is a best-effort AI instruction, not a hard enforcement. The AI agent *should* follow these rules, but model-level compliance varies. For hard enforcement of secret blocking, use a CONTENT_FILTER policy (enforced at the git pre-commit hook level).

---

## 1.8 Compliance & Reporting

### Audit Trail

Every significant action is logged:
- Agent created/updated/deleted/restored
- Policy created/updated/activated/deactivated
- Session started/ended/reviewed
- User invited/role changed

Each log entry includes: action, resource ID, metadata (JSON), user ID, and timestamp.

### Version History

Both agents and policies maintain full version history:
- **Agent Versions**: Track system prompt changes, model changes, permission updates, status changes
- **Policy Versions**: Track rule additions/removals, activation/deactivation, condition changes

Admins can restore agents to any previous version.

### Dashboard Features

- **Compliance Score**: Overall org compliance gauge with trend charts
- **Leaderboard**: Team rankings by sessions, lines written, cost, quality score
- **Model Comparison**: Per-model analytics (cost, tokens, approval rates)
- **Prompt Analytics**: Searchable prompt log with keyword pattern detection
- **Activity Heatmaps**: Team activity patterns by day/time

---

# Part 2: Technical Perspective

## 2.1 Monorepo Structure

```
origin-v2/
├── apps/
│   ├── api/                 # Express.js REST API
│   │   ├── prisma/          # Schema + migrations + seed
│   │   └── src/
│   │       ├── routes/      # 25 route files
│   │       ├── services/    # 16 service modules
│   │       ├── middleware/   # Auth, CORS
│   │       └── __tests__/   # API tests
│   └── web/                 # React SPA
│       └── src/
│           ├── pages/       # 20+ page components
│           ├── components/  # Reusable UI components
│           ├── context/     # Auth context
│           └── utils/       # API client, helpers
├── packages/
│   ├── cli/                 # CLI tool (34 commands)
│   │   └── src/
│   │       └── commands/    # Command implementations
│   └── mcp-server/          # MCP protocol server
│       └── src/
│           └── index.ts     # Tools + Resources
├── docs/                    # Documentation
├── Dockerfile               # Multi-stage Docker build
├── fly.toml                 # Fly.io deployment config
├── pnpm-workspace.yaml      # Monorepo workspace config
└── vitest.workspace.ts      # Test configuration
```

**Package manager**: pnpm with workspaces

---

## 2.2 Tech Stack

| Component | Technology |
|-----------|-----------|
| **API Server** | Express.js 5, TypeScript 5.8 |
| **ORM** | Prisma 6.8 |
| **Database** | SQLite (file-based) |
| **Auth** | JWT (jsonwebtoken) + bcryptjs |
| **Frontend** | React 18, Vite 6.3, Tailwind CSS 3.4 |
| **Routing** | React Router 7.6 |
| **Charts** | Recharts 2.15 |
| **CLI** | Commander.js 12, Chalk 5 |
| **MCP** | @modelcontextprotocol/sdk 1.12 |
| **AI Integration** | @anthropic-ai/sdk 0.78 (for auto-review + chat) |
| **Git** | simple-git 3.27 |
| **Testing** | Vitest 4.0, Supertest 7.2 |
| **Runtime** | Node.js 22 (ES modules) |
| **Deployment** | Docker (multi-stage), Fly.io |

---

## 2.3 Database Schema

22 Prisma models organized into logical groups:

**Core & Auth**
- `Org` — multi-tenant organization container
- `User` — team members with roles and password hashes
- `Invitation` — email-based team invitations with expiry tokens
- `ApiKey` — SHA256-hashed API keys with prefix for identification
- `ApiKeyRepoScope` / `ApiKeyAgentScope` — key access restrictions

**Repositories & Code**
- `Repo` — Git repositories (local or GitHub, with provider and sync status)
- `Commit` — Git commits with AI tool detection fields (`aiToolDetected`, `aiDetectionMethod`)
- `Webhook` — GitHub webhook configs (secret, events, GitHub webhook ID)
- `PullRequest` — PR tracking with check status and comment ID

**Sessions**
- `CodingSession` — Core entity. Full session data: transcript (JSON), metrics (tokens, cost, lines, duration), status (RUNNING/COMPLETED), agent snapshot
- `SessionDiff` — Unified diff with before/after HEAD SHAs
- `PromptChange` — Per-prompt breakdown (index, text, files changed, diff)
- `SessionReview` — Review with score (0-100), risk level, concerns, suggestions, categories (JSON)
- `SecretFinding` — Detected secrets/PII with type, severity, file path, line number

**Agents**
- `Agent` — AI agent configuration: model, system prompt, allowed tools, cost/token limits, file permissions (JSON)
- `AgentVersion` — Versioned snapshots with change type tracking

**Policies**
- `Policy` — Named governance rule with type and active flag
- `PolicyRule` — Scoped condition + action (can target specific agent, machine, or repo)
- `PolicyAssignment` — Many-to-many policy-to-agent binding
- `PolicyVersion` — Versioned policy snapshots

**Infrastructure**
- `Machine` — Developer workstations (hostname, machine ID, detected AI tools as JSON)
- `IntegrationConfig` — GitHub PAT or App tokens with settings

**Observability**
- `AuditLog` — Action log (action, resource, metadata JSON, user, timestamp)
- `Notification` — User notifications (type, title, message, read status, email sent flag)

**Feature Tracking**
- `Trail` — Investigation threads (name, status, priority, labels)
- `TrailSession` — Many-to-many trail-to-session grouping

**Key schema file**: `apps/api/prisma/schema.prisma`

---

## 2.4 API Architecture

### Route Files (25)

```
/api/auth          — login, register, token refresh
/api/sessions      — list, detail, review, metrics update
/api/mcp           — session/start, session/end, policies (MCP-specific)
/api/agents        — CRUD, versions, restore
/api/policies      — CRUD, rules, assignments, versions
/api/repos         — list, detail, sync, import, archive
/api/webhooks      — GitHub webhook receiver (HMAC verification)
/api/integrations  — GitHub App install, PAT config
/api/github-app    — OAuth callback
/api/users         — user management, invitations
/api/machines      — register, list
/api/audit         — audit log queries
/api/stats         — dashboard KPIs
/api/settings      — org settings, API keys
/api/notifications — list, mark read
/api/chat          — Claude-powered session Q&A
/api/scanning      — secret/PII findings
/api/pull-requests — PR status tracking
/api/trails        — investigation trails
/api/leaderboard   — team rankings
/api/prompts       — prompt log + pattern detection
/api/models        — model pricing + comparison stats
/api/pricing       — cost calculations
/api/reports       — compliance reports
/api/public-policies — public policy view
```

### Authentication

Dual-mode authentication via middleware (`apps/api/src/middleware/auth.ts`):

1. **JWT Bearer** (web UI): `Authorization: Bearer <token>` — resolves user ID, org ID, role
2. **API Key** (CLI/MCP): `X-API-Key: org_sk_...` — hashes key with SHA256, looks up in DB, resolves org ID + optional user ID + scopes

### Service Modules (16)

| Service | Responsibility |
|---------|---------------|
| `policy-engine` | Load and evaluate policies against session context |
| `ai-review` | Claude-powered automatic session scoring |
| `ai-commit-detector` | Detect AI authorship from git metadata |
| `secret-scanner` | Regex-based secret/PII detection |
| `github-integration` | Status checks, PR comments, webhook handling |
| `github-app` | GitHub App OAuth flow and token management |
| `budget` | Monthly spend tracking and limit enforcement |
| `notifications` | In-app and Slack notification delivery |
| `session-events` | Real-time session event broadcasting (SSE) |
| `versioning` | Agent and policy version snapshot creation |
| `webhook` | GitHub webhook processing (push, pull_request events) |
| `slack` | Slack webhook message formatting and delivery |
| `checkpoint` | Session diff capture (before/after HEAD, unified diff) |
| `chat-context` | Context preparation for Claude Q&A about sessions |
| `auto-sync` | Periodic repo sync and commit detection |

For the full API reference, see [API.md](API.md).

---

## 2.5 Policy Engine

**File**: `apps/api/src/services/policy-engine.ts`

### Evaluation Flow

```
loadOrgPolicies(orgId)
       │
       ▼
  For each active policy:
       │
       ├─ shouldSkipPolicy() — check agent assignments
       │
       ├─ For each rule:
       │   ├─ shouldSkipRule() — check agent/machine/repo scope
       │   ├─ parseCondition() — JSON parse condition
       │   └─ matchCondition() — evaluate against session context
       │
       └─ Accumulate violations
       │
       ▼
  Return EnforcementResult:
  { allowed, violations[], requiresReview, reviewReason }
```

### Condition Formats

```json
// FILE_RESTRICTION
{ "path": "**/.env" }
{ "path": "src/payments/**" }

// MODEL_ALLOWLIST
{ "models": ["claude-sonnet-4", "gpt-4o"] }

// REQUIRE_REVIEW
{ "cost_above": 5.0 }
{ "tokens_above": 100000 }
{ "files_above": 20 }
{ "max_lines": 500 }
{ "max_duration_minutes": 60 }

// COST_LIMIT
{ "max_cost": 10.0 }
{ "max_tokens": 200000 }

// CONTENT_FILTER
{ "pattern": "baran" }
{ "pattern": "TODO HACK|FIXME" }

// COMMIT_MESSAGE
{ "pattern": "^(feat|fix|chore|docs|refactor|test):" }
```

### Enforcement Points

| When | What | How |
|------|------|-----|
| Session start | MODEL_ALLOWLIST | `enforceSessionStart()` blocks if model not allowed |
| During session | FILE_RESTRICTION | MCP `check_file_access` tool validates file paths |
| Session end | COST_LIMIT, REQUIRE_REVIEW, FILE_RESTRICTION | `enforceSessionEnd()` evaluates full session context |
| Pre-commit hook | CONTENT_FILTER | `origin hooks git-pre-commit` scans `git diff --cached` |
| Pre-commit hook | COMMIT_MESSAGE | `origin hooks git-pre-commit` validates commit message |
| Pre-commit hook | FILE_RESTRICTION | `origin hooks git-pre-commit` checks staged file paths |
| PR merge | All violations | GitHub status check blocks merge if violations exist |

### Natural Language Policy Creation

Policies can be created from natural language descriptions via `POST /api/policies/from-natural-language`. The AI parses descriptions like "block commits containing the word baran" into structured policy objects with the correct type, conditions, and actions. Available in the UI via the "Create from Natural Language" button on the Policies page.

---

## 2.6 MCP Server

**File**: `packages/mcp-server/src/index.ts`

The MCP (Model Context Protocol) server runs as a stdio-based process inside Claude Code or Cursor. It provides real-time governance capabilities to the AI agent.

### Resources (read-only context)

| URI | Description |
|-----|-------------|
| `origin://policies` | Active governance policies formatted as text (injected into agent context) |
| `origin://session` | Current session metadata (session ID, machine ID, start time) |

### Tools (callable by AI agent)

| Tool | Description |
|------|-------------|
| `start_session` | Begin tracking a new coding session |
| `end_session` | Complete session with metrics (tokens, cost, files, duration) |
| `check_file_access` | Validate file path against FILE_RESTRICTION policies |
| `report_violation` | Log a policy violation |
| `list_sessions` | Query org sessions |
| `get_session` | Get session details + transcript |
| `review_session` | Submit manual review (approve/reject/flag) |
| `list_agents` | List available agents |
| `list_repos` | List repositories |
| `get_stats` | Dashboard KPIs |
| `get_audit_log` | Query audit trail |
| `get_policy_versions` | Policy change history |
| `get_agent_versions` | Agent change history |
| `list_notifications` | Org notifications |
| `list_users` | Team members |

### Configuration

```json
{
  "mcpServers": {
    "origin": {
      "command": "node",
      "args": ["<path>/packages/mcp-server/dist/index.js"],
      "env": {
        "ORIGIN_API_URL": "https://getorigin.io",
        "ORIGIN_API_KEY": "org_sk_..."
      }
    }
  }
}
```

For detailed MCP setup, see [MCP_SERVER.md](MCP_SERVER.md).

---

## 2.7 CLI Architecture

**Entry point**: `packages/cli/src/index.ts` (Commander.js)

### Commands (34)

| Category | Commands |
|----------|---------|
| **Setup** | `login`, `init`, `whoami`, `status`, `doctor`, `reset`, `clean` |
| **Sessions** | `sessions`, `session <id>`, `review <id>`, `explain`, `diff`, `blame` |
| **Repos** | `repos`, `repo:add`, `sync` |
| **Agents** | `agents`, `agent:create`, `agent:versions <id>` |
| **Governance** | `policies`, `policy:versions <id>`, `audit` |
| **Analytics** | `stats`, `team`, `user <id>`, `notifications` |
| **Hooks** | `enable`, `disable`, `link` |
| **Advanced** | `search`, `trail`, `ci`, `plugin`, `proxy`, `analyze`, `db`, `share`, `resume`, `rewind`, `upgrade` |

### Hooks System

The hooks system (`packages/cli/src/commands/hooks.ts`) is the core data-capture mechanism:

1. **`origin enable --global`** installs git post-commit hooks in `~/.git-templates/hooks/`
2. On every git commit, the hook:
   - Detects if an AI tool authored the commit
   - Parses the session transcript
   - Computes cost from token counts
   - Captures the git diff
   - Sends session data to the Origin API
3. **`origin link <agent-slug>`** writes `.origin.json` to the repo, linking it to a specific agent

### Config Files

| File | Purpose |
|------|---------|
| `~/.origin/config.json` | API URL, API key, org ID (set by `login`) |
| `~/.origin/agent.json` | Machine ID, hostname, detected tools, agent slug |
| `~/.origin/hooks/` | Global pre-commit/post-commit hook scripts |
| `.origin.json` (per-repo) | Agent mapping, policies to enforce |

### AI Tool Detection

The CLI auto-detects installed AI tools by checking:
- CLI presence (e.g., `claude` binary for Claude Code)
- IDE extension directories (e.g., `.cursor/` for Cursor)
- MCP configuration files
- Detected tools: Claude Code, Cursor, Copilot, Gemini CLI, Aider, Windsurf, Cody

For CLI command reference, see [CLI.md](CLI.md).

---

## 2.8 Session Lifecycle (Technical)

```
┌─────────────────────────────────────────────────────────────┐
│  DEVELOPER                                                   │
│  ┌──────────┐                                               │
│  │  Prompt   │                                               │
│  └────┬─────┘                                               │
│       │                                                      │
│       ▼                                                      │
│  ┌──────────────┐    MCP: start_session     ┌────────────┐  │
│  │  AI Agent     │ ────────────────────────▶ │  Origin    │  │
│  │  (Claude,     │                           │  API       │  │
│  │   Cursor,     │    Response:              │            │  │
│  │   Gemini)     │ ◀──────────────────────── │  Creates:  │  │
│  │               │    sessionId,             │  - Session │  │
│  │               │    activePolicies,        │  - Commit  │  │
│  │               │    agentSystemPrompt      │  - Audit   │  │
│  │               │                           │    Log     │  │
│  │  ┌─────────┐ │    MCP: check_file_access │            │  │
│  │  │ Coding  │ │ ────────────────────────▶ │  Policy    │  │
│  │  │ (per    │ │ ◀ { allowed: true/false } │  Engine    │  │
│  │  │  file)  │ │                           │            │  │
│  │  └─────────┘ │                           │            │  │
│  │               │    MCP: end_session       │            │  │
│  │               │ ────────────────────────▶ │  Runs:     │  │
│  └──────────────┘    (metrics payload)       │  1. Diff   │  │
│                                              │  2. Scan   │  │
│                                              │  3. Policy │  │
│                                              │  4. Review │  │
│                                              │  5. GitHub │  │
│                                              │  6. Slack  │  │
│                                              └────────────┘  │
└─────────────────────────────────────────────────────────────┘
```

### Session Start (`POST /api/mcp/session/start`)

**Input**: machineId, prompt, model, repoPath, agentSlug, branch

**Processing**:
1. Validate API key and resolve org/user
2. Check budget limits (`checkBudget()`)
3. Enforce MODEL_ALLOWLIST (`enforceSessionStart()`)
4. Create placeholder commit record
5. Create CodingSession (status: RUNNING)
6. Snapshot agent system prompt and version number
7. Log SESSION_STARTED audit event

**Response**: sessionId, activePolicies (formatted rule summaries), agentSystemPrompt

### Session End (`POST /api/mcp/session/end`)

**Input**: sessionId, summary, tokensUsed, inputTokens, outputTokens, toolCalls, linesAdded, linesRemoved, costUsd, filesChanged (JSON), durationMs

**Processing**:
1. Update session with metrics
2. Capture session diff (before/after HEAD, unified diff)
3. Create PromptChange records
4. Run secret scanner (regex patterns for credentials/PII)
5. Evaluate all policies (`enforceSessionEnd()`)
6. Run AI auto-review (Claude scores session 0-100)
7. Record spend for budget tracking
8. Update GitHub PR status check (if applicable)
9. Send Slack notifications (if violations)
10. Create audit log entry

### System Prompt Injection

When a session starts, Origin builds a `fullSystemPrompt` from multiple sources:
- **`agent.systemPrompt`**: The agent's custom system prompt (configured in the dashboard)
- **`<security-rules>`**: Auto-injected security rules block (if Security Rules toggle is ON)
- **`activePolicies`**: Human-readable policy summaries formatted as text

The CLI or MCP server injects these into the AI agent's context so it's aware of governance rules.

**Important**: System prompt changes only apply to new sessions. Running sessions keep the original prompt. Resumed sessions fetch the latest prompt. The session dedup logic (reusing active sessions) uses the stored prompt — it does NOT re-evaluate the security rules toggle.

---

## 2.9 GitHub Integration

**File**: `apps/api/src/services/github-integration.ts`

### Two Auth Modes

| Mode | Setup | Token Management |
|------|-------|-----------------|
| **GitHub App** | One-click install via OAuth redirect | Auto-refresh installation tokens |
| **PAT** | Manual token entry in Settings | User-managed |

### Webhook Processing

GitHub sends webhooks for `push` and `pull_request` events:

- **Push**: Creates Commit records, runs AI commit detection (checks co-author trailers, author patterns, commit messages)
- **Pull Request**: Creates/updates PullRequest records, links sessions by branch/SHA, posts AI Governance Report as PR comment

### Status Checks

Origin posts `origin/ai-governance` commit status:
- **success**: No policy violations found
- **failure**: Policy violations detected (blocks merge with branch protection)
- **pending**: Session still running or under review

### PR Comments

Formatted AI Governance Report includes:
- Session summary table (model, cost, tokens, files changed)
- Review status (approved/rejected/flagged)
- Policy violation details (if any)
- Link to full session detail in Origin dashboard

---

## 2.10 Deployment

### Docker (Multi-Stage Build)

```dockerfile
# Stage 1: API Builder
# - Compiles TypeScript API
# - Generates Prisma client
# - Packs CLI tarball

# Stage 2: Web Builder
# - Builds React app with Vite
# - Outputs to /apps/web/dist

# Stage 3: Runtime (Node 22 Alpine)
# - Copies compiled API + web assets + CLI tarball
# - Runs migrations on startup
# - Serves both API and SPA on port 8080
```

### Fly.io Configuration

```
App:            origin-platform
Region:         iad (US East)
Machine:        shared-cpu-1x, 512MB RAM
Volume:         origin_data mounted at /data (SQLite DB)
Auto-stop:      enabled (scales to zero when idle)
HTTPS:          forced
```

### Environment Variables

| Variable | Purpose |
|----------|---------|
| `DATABASE_URL` | `file:/data/origin.db` (SQLite on persistent volume) |
| `JWT_SECRET` | Secret for JWT token signing (set via `fly secrets`) |
| `PORT` | `8080` |
| `ORIGIN_WEB_URL` | `https://getorigin.io` |
| `CORS_ORIGIN` | Allowed CORS domains |

### Local Development

```bash
# Start API (port 4002) + Web (port 5176)
bash dev.sh

# Or manually:
cd apps/api && npx prisma db push && npx tsx prisma/seed.ts
cd apps/api && npx tsx src/index.ts    # API
cd apps/web && npx vite                # Web
```

**Production URL**: https://getorigin.io

---

## 2.11 Testing

**Framework**: Vitest + Supertest

**Test location**: `apps/api/src/__tests__/`

**Test categories**:
- Route tests: agents, audit, integrations, policies, repos, sessions, stats, users, webhooks
- Service tests: ai-commit-detector, github-integration

**Run tests**:
```bash
pnpm test                        # All workspace tests
cd apps/api && npx vitest run    # API tests only
```

---

## Key File Reference

| Area | File Path |
|------|-----------|
| Database Schema | `apps/api/prisma/schema.prisma` |
| Policy Engine | `apps/api/src/services/policy-engine.ts` |
| MCP Routes | `apps/api/src/routes/mcp.ts` |
| Session Routes | `apps/api/src/routes/sessions.ts` |
| Auth Middleware | `apps/api/src/middleware/auth.ts` |
| AI Auto-Review | `apps/api/src/services/ai-review.ts` |
| Secret Scanner | `apps/api/src/services/secret-scanner.ts` |
| GitHub Integration | `apps/api/src/services/github-integration.ts` |
| MCP Server | `packages/mcp-server/src/index.ts` |
| CLI Entry | `packages/cli/src/index.ts` |
| CLI Hooks | `packages/cli/src/commands/hooks.ts` |
| Frontend API Client | `apps/web/src/api.ts` |
| Docker Build | `Dockerfile` |
| Fly.io Config | `fly.toml` |

---

## Related Documentation

- [API.md](API.md) — Full API endpoint reference
- [CLI.md](CLI.md) — CLI command documentation
- [MCP_SERVER.md](MCP_SERVER.md) — MCP server setup and configuration
- [POLICIES.md](POLICIES.md) — Policy configuration guide
- [INTEGRATIONS.md](INTEGRATIONS.md) — Integration setup (GitHub, Slack, etc.)
- [AI_FEATURES.md](AI_FEATURES.md) — AI-powered capabilities
