<p align="center">
  <h1 align="center">Origin CLI</h1>
  <p align="center"><strong>Know exactly what your AI agents are writing.</strong></p>
</p>

<p align="center">
  <a href="https://github.com/dolobanko/origin-cli/blob/main/LICENSE"><img src="https://img.shields.io/badge/license-MIT-green" alt="License"></a>
  <a href="https://github.com/dolobanko/origin-cli/stargazers"><img src="https://img.shields.io/github/stars/dolobanko/origin-cli?style=social" alt="GitHub stars"></a>
</p>

<p align="center">
  Track every AI coding session. Line-level AI/human attribution. Full visibility into AI-authored code.<br/>
  Zero setup — no server, no login, no API keys. All data stored in git.<br/>
  Supports Cursor Agent Trace v0.1.0 standard.
</p>

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
origin diff                      # Annotated diff — see AI changes in context
origin stats                     # AI vs human breakdown for the repo
origin sessions                  # List all AI coding sessions
origin prompts <file>            # See which AI prompts touched a file
origin search "auth bug"         # Find the prompt that introduced code
origin backfill                  # Retroactively tag old commits as AI/human
```

---

## Supported Agents

| Agent | Hook Type | Status |
|-------|-----------|--------|
| <img src="https://cdn.simpleicons.org/anthropic/D97757" width="14"> **Claude Code** | Session hooks + process detection | **Supported** |
| <img src="https://cdn.simpleicons.org/cursor/00A4EF" width="14"> **Cursor** | Session hooks + Cursor DB | **Supported** |
| <img src="https://cdn.simpleicons.org/openai/412991" width="14"> **Codex CLI** | Session hooks + process detection | **Supported** |
| <img src="https://cdn.simpleicons.org/google/4285F4" width="14"> **Gemini CLI** | Session hooks + process detection | **Supported** |
| Windsurf | Session hooks | Coming soon |
| Aider | Config hooks | Coming soon |
| GitHub Copilot | Process detection | Coming soon |

---

## All Commands

<details>
<summary><strong>Attribution & Analysis</strong></summary>

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
<summary><strong>Sessions & Sharing</strong></summary>

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
<summary><strong>Reporting & Compliance</strong></summary>

```
origin report                   Sprint report — cost, models, users, ROI
                                  --range 7d|14d|30d  --format md|json|csv
origin audit                    SOC 2 / ISO 27001 compliance audit trail
                                  --from <date>  --to <date>  --format md|json|csv
```

</details>

<details>
<summary><strong>Setup & Maintenance</strong></summary>

```
origin init                     Initialize + install hooks
origin enable [--global]        Install hooks + secret scanner
origin disable [--global]       Remove hooks
origin status                   Show system status
origin upgrade                  Upgrade CLI to latest version
origin doctor [--fix]           Diagnose and fix issues
origin verify                   Health check — agents, repo, sessions
origin clean [--force]          Remove orphaned data
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
| `origin-sessions` branch | Session transcripts, prompts, file changes |
| `~/.origin/config.json` | CLI config |
| `~/.origin/git-hooks/` | Global hook scripts |

---

## Origin vs Alternatives

| Feature | Origin | git-ai | Entire.io |
|---------|--------|--------|-----------|
| Line-level attribution | **Yes** — per-line AI/human tags | Commit-level only | No |
| Retroactive tagging | **Yes** — `origin backfill` | No | No |
| Local-first / no server | **Yes** — git notes, zero setup | Yes | No — SaaS only |
| Multi-agent support | **4 agents**, more coming | Claude only | GitHub Copilot only |
| Session transcripts | **Full prompts + responses** | No | No |
| Per-file context injection | **Yes** — agents see authorship | No | No |
| Secret scanning | **Built-in** pre-commit hook | No | No |
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
