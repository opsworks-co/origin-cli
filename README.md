# Origin

**Know exactly what your AI agents are writing.**

Origin is an AI code attribution and governance platform for engineering teams using AI coding agents — Claude Code, Cursor, Gemini CLI, Aider, Copilot. It tracks every AI coding session, provides line-level AI/human attribution, and gives CTOs and engineering leads full visibility into AI-authored code.

Works in two modes:
- **Standalone** — zero setup, no server needed. All data stored locally in git.
- **Connected** — full platform with dashboard, policy enforcement, and team features.

---

## Why Origin

When AI agents write your code:
- Who reviews the intent, not just the diff?
- What percentage of your codebase is AI-written?
- Which AI model wrote which line of code?
- What's your audit trail when something breaks in production?

Git blame shows you *who committed*. Origin shows you *what AI wrote it, why, and how*.

---

## Features

### Standalone (no server required)
- **AI Blame** — `origin blame <file>` shows `[AI]`/`[HU]` tag per line with model name
- **AI Diff** — `origin diff` annotates diffs with AI/human attribution per line
- **Stats** — `origin stats` shows AI vs human commit/line breakdown with tool and model charts
- **Ask the Author** — `origin ask "query" --file src/auth.ts` finds which AI session and prompt generated specific code
- **Prompt History** — `origin prompts <file>` shows every AI prompt that touched a file, with diffs (`--expand`)
- **AI Chat** — `origin chat` interactive assistant to ask questions about your AI-authored code in natural language
- **Session Tracking** — full transcript of every AI session stored in git (`origin-sessions` branch)
- **Session Resume** — `origin resume` rebuilds context from previous sessions for handoff between agents
- **Search** — `origin search <query>` searches all AI prompt history locally
- **Prompt Analytics** — `origin analyze` detects prompting patterns and metrics
- **Trail System** — branch-centric work tracking linking sessions to features
- **Attribution Preservation** — AI tags survive `git rebase`, `git commit --amend`, `git cherry-pick`, and stash operations
- **Auto-Detection** — 13 agents: Claude Code, Gemini CLI, Cursor, Codex, Aider, Windsurf, Copilot, Continue, Amp, Junie, OpenCode, Rovo, Droid
- **Git Notes** — per-commit AI metadata stored in `refs/notes/origin`

### Connected (with Origin server)
- **Session Replay** — full transcript of every AI coding session in the dashboard
- **Policy Enforcement** — rules enforced inside Claude Code and Cursor via MCP server
- **PR Blocking** — GitHub status checks that block merges when AI sessions violate policies
- **Intent Review** — approve, reject, or flag AI sessions before they ship
- **Compliance Dashboard** — compliance score, policy violation trends, exportable reports
- **Model Comparison** — cost, token usage, and approval rates across AI models
- **Leaderboard** — rank team members by AI usage, lines written, cost, quality score
- **Slack Notifications** — real-time alerts for violations, reviews, and budget
- **GitHub App** — one-click install with bot identity on status checks
- **MCP Server** — native integration with Claude Code and Cursor

---

## Quick Start (Standalone)

### 1. Install the CLI

```bash
npm i -g https://origin-platform.fly.dev/cli/origin-cli-latest.tgz
```

### 2. Enable tracking

```bash
origin enable --global    # Install global hooks for all repos
```

### 3. Code with any AI agent

Use Claude Code, Gemini CLI, Cursor, or any supported agent — Origin tracks automatically.

### 4. See what AI wrote

```bash
origin blame src/index.ts    # Line-level AI/human attribution
origin stats                 # AI vs human breakdown
origin diff                  # Annotated diff with attribution
origin sessions              # List all AI sessions
origin session <id>          # Full session transcript with prompts
origin prompts src/index.ts  # AI prompts that touched this file
origin chat                  # Ask questions about your AI code in natural language
```

> **That's it.** No server, no login, no API keys. Everything is stored locally in git notes and the `origin-sessions` branch.

### 5. Enable AI Chat (optional)

To use `origin chat` — the interactive AI assistant that answers questions about your AI-authored code:

```bash
export ANTHROPIC_API_KEY=sk-ant-...    # Add to ~/.zshrc or ~/.bashrc
origin chat
```

```
  you > who wrote the auth module?
  Claude 3.5 Sonnet wrote src/auth.ts across 3 sessions...

  you > how much have I spent on AI this month?
  $4.32 across 23 sessions. Claude: $3.18 (74%), Gemini: $1.14 (26%)
```

---

## Quick Start (Connected Platform)

### 1. Clone and run

```bash
git clone https://github.com/dolobanko/origin-v2
cd origin-v2
pnpm install
cd apps/api && npx prisma db push && npx tsx prisma/seed.ts && cd ../..
bash dev.sh
```

Open **http://localhost:5176** — Demo login: `artem@origin.dev` / `password123`

### 2. Install CLI and connect

```bash
npm i -g https://origin-platform.fly.dev/cli/origin-cli-latest.tgz
origin login       # authenticate with your Origin instance
origin init        # register machine, auto-detect AI tools, install global hooks
```

### 3. Add MCP server to Claude Code

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

---

## Architecture

```
origin-v2/
├── apps/
│   ├── api/          # Express + TypeScript + Prisma (SQLite)
│   └── web/          # React + Vite + Tailwind CSS (dark theme)
└── packages/
    ├── cli/          # Origin CLI — attribution, sessions, hooks
    └── mcp-server/   # MCP server for Claude Code and Cursor
```

**Dashboard Pages:** Dashboard, Repositories, Agents, Sessions, PR Checks, Leaderboard, Trails, Prompts, Compliance, Models, Policies, Settings

**Ports:**
- API: `http://localhost:4002`
- Web: `http://localhost:5176`
- Production: `https://origin-platform.fly.dev`

---

## CLI Commands

```
Setup:
  origin enable [--global]        Install hooks (standalone or connected)
  origin disable [--global]       Remove hooks
  origin login                    Authenticate with Origin server (connected mode)
  origin init                     Register machine + detect AI tools
  origin status                   Show system status

Attribution:
  origin blame <file>             AI/human attribution per line ([AI]/[HU] tags)
  origin diff [range]             Annotated diff with AI/human attribution
  origin stats                    AI vs human commit/line breakdown with charts
  origin search <query>           Search AI prompt history
  origin ask <query>              Query which AI session wrote specific code
  origin prompts <file>           Show AI prompts that touched a file (--expand for diffs)
  origin chat                     Interactive AI assistant — ask questions in natural language
  origin analyze                  Prompt pattern analytics

Sessions:
  origin sessions                 List sessions (--status, --model, --limit)
  origin session <id>             View session detail with full transcript
  origin resume [branch]          Resume session context for AI handoff
  origin explain [id]             Explain session with prompts and changes
  origin share <id>               Create shareable session bundle

Time Travel:
  origin rewind                   Rewind to previous AI checkpoint
  origin trail                    Branch-centric work tracking

Maintenance:
  origin doctor [--fix]           Diagnose and fix issues
  origin clean [--force]          Remove orphaned data
  origin upgrade                  Upgrade CLI to latest version
```

---

## How It Works

### Attribution Pipeline

```
AI Agent commits code
        ↓
Global post-commit hook fires
        ↓
Origin detects AI process (pgrep) or active session
        ↓
Writes git note to refs/notes/origin with model, session, cost
        ↓
Writes session data to origin-sessions branch
        ↓
origin blame / stats / diff read notes for attribution
```

### Supported Agents

| Agent | Detection | Hook System | Status |
|-------|-----------|-------------|--------|
| Claude Code | Session hooks + process detection | Claude Code hooks API | Stable |
| Gemini CLI | Process detection (`pgrep`) | Global post-commit hook | Stable |
| Cursor | Session hooks | Cursor hooks API | Stable |
| Codex CLI | Session hooks + process detection | Codex hooks API | Stable |
| Aider | Process detection | Global post-commit hook | Stable |
| Windsurf | Session hooks + process detection | Windsurf hooks API | Preview |
| GitHub Copilot | Process detection | Global post-commit hook | Preview |
| Continue | Process detection | Global post-commit hook | Preview |
| Amp | Process detection | Global post-commit hook | Preview |
| Junie | Process detection | Global post-commit hook | Preview |
| OpenCode | Process detection | Global post-commit hook | Preview |
| Rovo Dev | Process detection | Global post-commit hook | Preview |
| Droid | Process detection | Global post-commit hook | Preview |

### Data Storage

| Location | Purpose |
|----------|---------|
| `refs/notes/origin` | Per-commit AI metadata (model, session, cost, tokens) |
| `origin-sessions` branch | Session transcripts, prompts, file changes |
| `~/.origin/config.json` | CLI config (API URL, keys, feature flags) |
| `~/.origin/git-hooks/` | Global hook scripts |
| `~/.origin/hooks.log` | Debug log for hook invocations |

---

## Running Tests

```bash
cd apps/api && npx vitest run
```

---

## Tech Stack

- **Backend:** Node.js, Express, TypeScript, Prisma, SQLite
- **Frontend:** React, Vite, Tailwind CSS, Recharts
- **Protocol:** MCP (Model Context Protocol)
- **Integrations:** GitHub App, Slack Webhooks
- **Deployment:** Fly.io (Docker, single-machine with volume mount)

---

## License

MIT
