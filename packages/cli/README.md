<p align="center">
  <img src="https://getorigin.io/favicon.svg" width="80" alt="Origin Logo" />
</p>

<h1 align="center">Origin CLI</h1>
<p align="center"><strong>Know exactly what your AI agents are writing.</strong></p>

<p align="center">
  <a href="https://github.com/dolobanko/origin-cli/blob/main/LICENSE"><img src="https://img.shields.io/badge/license-MIT-green" alt="License"></a>
  <a href="https://github.com/dolobanko/origin-cli/stargazers"><img src="https://img.shields.io/github/stars/dolobanko/origin-cli?style=social" alt="GitHub stars"></a>
  <a href="https://getorigin.io"><img src="https://img.shields.io/badge/web-getorigin.io-6366f1" alt="Website"></a>
</p>

<p align="center">
  Track every AI coding session. Line-level AI/human attribution. Full visibility into AI-authored code.<br/>
  Zero setup — no server, no login, no API keys. All data stored in git.<br/>
  <strong>50+ commands</strong> · <strong>10+ agents</strong> · <strong>MIT licensed</strong>
</p>

---

## Why Origin?

AI now writes **30–70% of the code** that ships to production. But `git blame` still
points at the human who pressed **Commit** — not the model, not the prompt, not the
session. Once a line lands in `main`, the "why" is gone forever.

Origin fixes that. It runs silently next to any AI coding agent (Claude Code, Cursor,
Codex, Gemini, Aider, Windsurf, Continue, Copilot CLI, and more), captures the full
session context — prompts, responses, tool calls, token counts, cost, duration —
and attaches it to your commits as git notes. Everything stays in **your git repo**.
No server. No login. No API keys. No data ever leaves your machine unless you
explicitly push it.

### The problems Origin solves

| Pain | What Origin gives you |
|---|---|
| 🕵️ **`git blame` is lying to you** — you see the human, not the AI that wrote the line | `origin blame` shows the exact model, agent, session, and prompt behind every single line |
| 💸 **You have no idea how much AI is costing you** | Per-session token + USD cost, broken down by model, repo, and developer |
| 🧠 **Prompts disappear the moment you close the terminal** | Every prompt is recorded and searchable — `origin why <file>:<line>` replays the exact conversation that wrote it |
| 🔁 **Context is lost every time you switch agents** | Cross-agent handoff: Claude can pick up where Cursor left off, automatically |
| 🔐 **AI agents leak secrets into commits** | Built-in secret scanner blocks commits containing AWS keys, API tokens, JWTs, DB creds, and 40+ other patterns |
| 🛰️ **Your prompts are being logged by someone else's cloud** | 100% local by default — prompts, responses, and costs live in your own git repo. No accounts, no telemetry, no server required |
| 🤷 **You don't know which model writes the best code** | `origin stats` compares approval rate, rework rate, avg cost, and avg lines across every model you use |
| 🧩 **Monorepos and multi-repo workspaces break every tool** | Auto-detects every git repo under your working dir and tracks them all in a single session |

### Why it's cool

- **Zero config.** `origin init` auto-detects whichever AI agent you use and installs
  the right hook. No YAML, no dashboards to set up, no accounts to create.
- **100% local by default.** All data lives in git notes + the `origin-sessions`
  branch. You own it. `git clone` your repo and everything comes with it.
- **It works with every agent** — Claude Code, Cursor, Codex, Gemini CLI, Aider,
  Windsurf, Continue, Copilot CLI, Roo, Cline, Kilo, and more. Same commands, same
  output, no matter what you use.
- **Fast.** Written in TypeScript, compiled to a single binary, runs in milliseconds.
  Hooks add <50ms to your commits.
- **Policy-aware.** Define rules in `.origin/policies.yml` (secret scanning, file
  allowlists, model allowlists, cost limits) and Origin enforces them at commit
  time — before bad code ever reaches `main`.
- **Free forever for solo developers.** Open source, MIT licensed. Teams get an
  optional hosted dashboard at [getorigin.io](https://getorigin.io).

---

## Install

```bash
npm i -g https://getorigin.io/cli/origin-cli-latest.tgz
```

## Quick Start

```bash
origin init                     # Auto-detects agents, installs hooks
# ... code with any AI agent — Origin tracks automatically
origin blame src/index.ts       # See who wrote each line
```

That's it. Everything stored locally in git notes and the `origin-sessions` branch.

---

## Top Commands

These are the commands you'll use every day:

```bash
origin blame <file>              # Line-by-line AI/human attribution
origin why <file>:<line>         # Which AI prompt wrote a specific line
origin diff                      # Annotated diff — see AI changes in context
origin stats                     # AI vs human breakdown for the repo
origin sessions                  # List all AI coding sessions
origin prompts <file>            # See which AI prompts touched a file
origin search "auth bug"         # Find the prompt that introduced code
origin backfill                  # Retroactively tag old commits as AI/human
```

---

## Supported Agents

| Agent | Detection | Status |
|-------|-----------|--------|
| <img src="https://cdn.simpleicons.org/anthropic/D97757" width="14"> **Claude Code** | Session hooks + process detection | ✅ Supported |
| <img src="https://cdn.simpleicons.org/cursor/00A4EF" width="14"> **Cursor** | Session hooks + Cursor DB + IDE extension | ✅ Supported |
| <img src="https://cdn.simpleicons.org/openai/412991" width="14"> **Codex CLI** | Session hooks + process detection + npx cache | ✅ Supported |
| <img src="https://cdn.simpleicons.org/google/4285F4" width="14"> **Gemini CLI** | Session hooks + process detection | ✅ Supported |
| 🌊 **Windsurf** | Session hooks + CLI detection | ✅ Supported |
| 🤖 **Aider** | Session hooks + CLI detection | 🚧 In Development |
| <img src="https://cdn.simpleicons.org/github/ffffff" width="14"> **GitHub Copilot** | IDE extension + GH CLI extension + process detection | 🚧 In Development |
| 🧠 **Cody** | IDE extension + CLI detection | 🚧 In Development |
| ▶️ **Continue** | IDE extension detection | 🚧 In Development |
| 💎 **Codeium** | IDE extension detection | 🚧 In Development |
| 🔧 **Cline** | IDE extension detection (Claude Dev) | 🚧 In Development |

**Detection methods:**
- CLI availability (`which <tool>`)
- IDE extension scanning (VS Code, VSCodium)
- Extension directory inspection
- MCP config inspection
- Process detection during commits

---

## All Commands

<details>
<summary><strong>Attribution & Analysis</strong> (9 commands)</summary>

```
origin blame <file>             Line-by-line AI/human attribution
origin diff [range]             Annotated diff with AI attribution
origin stats                    AI vs human stats (--dashboard, --global)
origin compare <a> [b]          Compare attribution between branches
origin prompts <file>           AI prompts that touched a file
origin search <query>           Full-text search across prompts (--from, --agent)
origin ask <query>              Which AI session wrote specific code
origin rework                   Detect AI code that got reworked (--days)
origin backfill                 Retroactive AI tagging (--apply, --days, --min-confidence)
```

</details>

<details>
<summary><strong>Sessions & Sharing</strong> (7 commands)</summary>

```
origin sessions                 List sessions for current repo (--all for everything)
origin sessions end <id>        End a running session
origin session <id>             View session with full transcript
origin explain [id]             Explain session with prompts and changes
origin export                   Export session data as CSV/JSON/agent-trace
origin share <id>               Copy session link to clipboard
origin share <id> --public      Create public link: getorigin.io/s/<slug>
```

</details>

<details>
<summary><strong>Reporting & Compliance</strong> (3 commands)</summary>

```
origin report                   Sprint report — cost, models, users, ROI
                                  --range 7d|14d|30d  --format md|json|csv
origin audit                    SOC 2 / ISO 27001 compliance audit trail
                                  --from <date>  --to <date>  --format md|json|csv
origin trail                    View audit trail entries
```

</details>

<details>
<summary><strong>Setup & Maintenance</strong> (13 commands)</summary>

```
origin init                     Initialize + install hooks (--no-hooks to skip)
origin login                    Authenticate with Origin server
origin whoami                   Show current user and connection info
origin enable [--global]        Install hooks + secret scanner
origin disable [--global]       Remove hooks
origin status                   Show system status
origin config <key> [value]     Get/set configuration
origin upgrade                  Upgrade CLI to latest version
origin doctor [--fix]           Diagnose and fix issues
origin verify                   Health check — agents, repo, sessions
origin clean [--force]          Remove orphaned data
origin reset                    Reset Origin data for this repo
origin hooks                    Manage git hooks
```

</details>

<details>
<summary><strong>Issue Tracker</strong> (10 commands)</summary>

```
origin issue create <title>     Create an issue (--type, --priority, --label, --dep)
origin issue list               List issues (--status, --priority, --label, --type)
origin issue show <id>          Show issue details
origin issue close <id>         Close an issue
origin issue ready              Next unblocked issue (for AI agent loops)
origin issue blocked            List blocked issues
origin issue link <id> <sess>   Link a session to an issue
origin issue dep add <id> <dep> Add a dependency
origin issue dep remove <id> <dep>  Remove a dependency
origin issue dep tree <id>      Show dependency tree
```

</details>

<details>
<summary><strong>Repos & Agents</strong> (5 commands)</summary>

```
origin repos                    List tracked repositories
origin agents                   List detected AI agents
origin link                     Link current repo to Origin server
origin sync                     Sync repos and upload session data
origin ignore                   Manage ignored files/paths
```

</details>

<details>
<summary><strong>Reviews & Policies</strong> (4 commands)</summary>

```
origin review <id>              Review a session (approve/reject/flag)
origin review-pr <url>          Review a pull request
origin intent-review            AI intent verification for sessions
origin policies                 List active governance policies
```

</details>

<details>
<summary><strong>Productivity & AI</strong> (11 commands)</summary>

```
origin handoff                  Cross-agent context handoff (show/clear)
origin memory                   Session memory across conversations (show/clear)
origin todo                     AI-extracted TODO tracker (list/done/add)
origin chat                     Chat with Origin AI about your codebase
origin resume                   Resume a previous session
origin rewind                   Rewind to a previous session state
origin snapshot                 Save a point-in-time snapshot
origin analyze                  Deep analysis of session patterns
origin recap                    End-of-day summary — sessions, cost, tokens (--days N)
origin prompt-status            Fast session check for shell prompt (<50ms)
origin shell-prompt             Shell integration script (eval "$(origin shell-prompt)")
```

</details>

<details>
<summary><strong>Server & Integration</strong> (5 commands)</summary>

```
origin web                      Open Origin dashboard in browser
origin proxy                    Local proxy for MCP integration
origin plugin                   Manage plugins
origin ci                       CI/CD integration commands
origin db                       Local database management
```

</details>

---

## Usage Examples

### Who wrote this code?

```bash
origin blame src/api.ts
```
```
  1 | Claude   | 3h ago  | import express from 'express';
  2 | Claude   | 3h ago  | import { prisma } from './db';
  3 | Human    | 2d ago  |
  4 | Gemini   | 1h ago  | export async function getUsers() {
  5 | Gemini   | 1h ago  |   const users = await prisma.user.findMany();
  6 | Cursor   | 30m ago |   return users.filter(u => u.active);

10 lines  Claude: 40%  Gemini: 30%  Cursor: 10%  Human: 20%
```

### Retroactive attribution (for repos that existed before Origin)

```bash
origin backfill                      # Dry-run — shows what it would tag
origin backfill --apply              # Actually write the tags
origin backfill --days 180           # Go back 6 months
origin backfill --min-confidence high # Only tag high-confidence matches
```

Scans `.claude/`, `.cursor/`, `.codex/` session history, commit message patterns, and code style heuristics to retroactively identify AI-generated commits.

### Find the prompt behind any code

```bash
origin search "authentication"
origin search "refactor" --agent cursor --from 2026-03-01
```

### Sprint report

```bash
origin report --range 14d --format json --output sprint.json
```

### Compliance audit

```bash
origin audit --from 2026-01-01 --to 2026-03-31 --format json
```

---

## Features

### AI Attribution Context

Origin automatically injects context into AI agent system prompts so agents know what other agents have already done.

**Repo-level** (session start):
```
Repository AI context: 90% of recent commits (27/30) are AI-generated.
  - claude-code wrote src/api.ts, src/hooks.ts on 2026-03-22
  - gemini-cli wrote src/utils.ts on 2026-03-21
```

**Per-file** (when an agent reads/edits a file):
```
File attribution for src/hooks.ts: 95% AI-generated (2258/2388 lines).
  Lines 1-28: claude-code (claude-opus-4-6)
  Lines 217-240: human (KIRAN)
```

### Secret Scanner

Pre-commit hook blocks commits containing hardcoded secrets:

```
  AWS Access Key     config.env:3   AKIA****MPLE
  GitHub Token       src/api.ts:12  ghp_****ab12
  2 secrets found. Commit blocked.
```

Detects: AWS keys, GitHub/GitLab tokens, OpenAI/Anthropic/Stripe keys, JWTs, database connection strings, private keys, and `*_TOKEN=`/`*_SECRET=`/`*_KEY=` patterns.

### Cross-Agent Context Handoff

Switch from Claude to Cursor (or any agent) without losing context. When a session ends, Origin saves what you were working on. The next session — even with a different agent — picks up where you left off.

```bash
origin handoff show              # Preview what will be passed to next agent
origin handoff clear             # Reset handoff context
```

### Session Memory

Origin remembers what happened in previous sessions. New sessions get the last 3 summaries injected, so the agent knows what was done yesterday, which files were touched, and what's still open.

```bash
origin memory show              # See accumulated session history
origin memory clear             # Reset memory for this repo
```

### AI TODO Tracker

TODOs mentioned in AI sessions are automatically extracted and tracked:

```bash
origin todo list                # Show all open TODOs across repos
origin todo done <id>           # Mark as complete
origin todo show <id>           # Show originating session context
origin todo add "fix auth flow" # Manually add a TODO
```

---

## How It Works

```
AI Agent commits code → Post-commit hook fires → Origin detects AI process
→ Writes git note (model, session, cost) → Writes session to origin-sessions branch
→ origin blame / stats / diff read notes for attribution
```

### Data Storage

| Location | Purpose |
|----------|---------|
| `refs/notes/origin` | Per-commit AI metadata (model, session, cost, tokens) |
| `refs/notes/origin-memory` | Session memory — accumulated summaries across sessions |
| `origin-sessions` branch | Session transcripts, prompts, file changes |
| `.git/origin-handoff.json` | Cross-agent handoff context (latest session) |
| `~/.origin/config.json` | CLI config |
| `~/.origin/git-hooks/` | Global hook scripts |

---

## Origin vs Alternatives

| Feature | Origin | git-ai | Entire.io |
|---------|--------|--------|-----------|
| Line-level attribution | **Yes** — per-line AI/human tags | Commit-level only | No |
| Retroactive tagging | **Yes** — `origin backfill` | No | No |
| Local-first / no server | **Yes** — git notes, zero setup | Yes | No — SaaS only |
| Multi-agent support | **5 agents** (6 more in dev) | Claude only | GitHub Copilot only |
| Session transcripts | **Full prompts + responses** | No | No |
| Per-file context injection | **Yes** — agents see authorship | No | No |
| Secret scanning | **Built-in** pre-commit hook | No | No |
| Cross-agent handoff | **Yes** — context carries over | No | No |
| Total commands | **50+** | ~5 | N/A |
| Open source | **MIT** | MIT | Closed |

---

## For Teams

**[getorigin.io](https://getorigin.io)** — centralized dashboard, policy enforcement, PR compliance. Free trial.

Connected mode adds: real-time dashboard, budget controls with ROI calculator, weekly digest emails, model/cost policies, PR blocking, compliance reports, IAM with per-user API keys, team leaderboards, Slack notifications, and GitHub App integration.

```bash
origin login    # Authenticate with your Origin instance
origin init     # Register machine + install hooks
```

---

## License

MIT
