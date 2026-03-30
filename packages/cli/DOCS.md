# Origin CLI Documentation

Origin is an AI coding governance platform that tracks, attributes, and governs AI-assisted code across your team. The CLI hooks into AI coding agents (Claude Code, Cursor, Gemini, Windsurf, Aider) to capture session data, enforce policies, and provide attribution analytics.

## Table of Contents

- [Installation](#installation)
- [Quick Start](#quick-start)
- [Authentication & Setup](#authentication--setup)
- [Hook Management](#hook-management)
- [Session Tracking](#session-tracking)
- [Attribution & Blame](#attribution--blame)
- [Search & Analysis](#search--analysis)
- [Time Travel & Resume](#time-travel--resume)
- [Trail System](#trail-system)
- [Cross-Agent Handoff](#cross-agent-handoff)
- [Session Memory](#session-memory)
- [AI TODO Tracker](#ai-todo-tracker)
- [Configuration](#configuration)
- [Local Database](#local-database)
- [CI/CD Integration](#cicd-integration)
- [Plugin System](#plugin-system)
- [Git Proxy](#git-proxy)
- [Maintenance](#maintenance)
- [Upgrade](#upgrade)
- [Hook Architecture](#hook-architecture)
- [Data Storage](#data-storage)
- [Supported Agents](#supported-agents)

---

## Installation

```bash
# Install from Origin platform
npm i -g https://getorigin.io/cli/origin-cli-latest.tgz
```

Verify:

```bash
origin --version
```

## Quick Start (Standalone — no server required)

```bash
# 1. Enable global hooks (tracks all repos automatically)
origin enable --global

# 2. Code with any AI agent (Claude Code, Gemini CLI, Cursor, etc.)

# 3. View attribution
origin blame src/index.ts    # Line-level AI/human tags
origin stats                 # AI vs human breakdown
origin diff                  # Annotated diff
origin sessions              # List all AI sessions
origin session <id>          # Full session transcript
```

No login, no API keys. All data stored locally in git notes and `origin-sessions` branch.

## Quick Start (Connected — with Origin server)

```bash
# 1. Login to your Origin instance
origin login

# 2. Register this machine
origin init

# 3. Enable hooks (auto-detects installed agents)
origin enable

# 4. Start coding with your AI agent — Origin tracks everything automatically

# 5. View your session
origin sessions
```

---

## Authentication & Setup

### `origin login`

Authenticate with your Origin server.

```bash
origin login
# Prompts for:
#   API URL (default: https://getorigin.io)
#   API Key (from your Origin dashboard)
```

Config saved to `~/.origin/config.json`.

### `origin init`

Register this machine as an agent host. Auto-detects installed AI tools.

```bash
origin init
# Detects: claude, cursor, aider, gemini, windsurf
# Registers machine with Origin API
# Saves to ~/.origin/agent.json
```

### `origin whoami`

Show current authentication status.

```bash
origin whoami
# Output: API URL, Org ID, user email/name/role, machine info
```

---

## Hook Management

### `origin enable`

Install Origin hooks for session tracking. Hooks capture AI prompts, file changes, token usage, and costs.

```bash
# Auto-detect and install for all found agents
origin enable

# Install for a specific agent
origin enable --agent claude-code
origin enable --agent cursor
origin enable --agent gemini
origin enable --agent codex
origin enable --agent windsurf
origin enable --agent aider

# Install globally (all repos tracked automatically)
origin enable --global

# Install and link to a specific Origin agent
origin enable --link my-agent-slug

# Override the agent slug used for session attribution
origin enable --agent-slug my-custom-slug

# Replace existing hooks instead of chaining
origin enable --no-chain
```

**What gets installed:**

| Agent | Config File | Events |
|-------|-------------|--------|
| Claude Code | `~/.claude/settings.json` | SessionStart, Stop, UserPromptSubmit, SessionEnd, PreToolUse, PostToolUse |
| Cursor | `~/.cursor/hooks.json` | sessionStart, stop, beforeSubmitPrompt, sessionEnd |
| Codex CLI | `~/.codex/config.json` | SessionStart, Stop, UserPromptSubmit |
| Gemini | `~/.gemini/settings.json` | SessionStart, SessionEnd, BeforeAgent, AfterAgent |
| Windsurf | `~/.windsurf/hooks.json` | sessionStart, stop, beforeSubmitPrompt, sessionEnd |
| Aider | `~/.aider.conf.yml` | git-commit-verify, notifications-command |
| Git | `.git/hooks/post-commit` | post-commit (for commit attribution) |
| Git | `.git/hooks/pre-push` | pre-push (auto-push session data) |

**Hook chaining:** By default, Origin preserves existing hooks and chains them. Use `--no-chain` to replace instead.

**Permission deny rules:** Origin installs deny rules so AI agents can't read their own session metadata (`.git/origin-session*.json`, `.origin.json`).

### `origin disable`

Remove all Origin hooks.

```bash
origin disable           # Remove from current repo
origin disable --global  # Remove global hooks
```

### `origin link`

Link a repo to a specific Origin agent for session attribution.

```bash
origin link my-agent     # Link to agent "my-agent" (writes .origin.json)
origin link              # Show current mapping
origin link --clear      # Remove mapping
```

---

## Session Tracking

### `origin status`

Show current session status, repo info, and connection health.

```bash
origin status
# Shows:
#   Login status
#   Active session (ID, model, duration, branch, HEAD)
#   Repository info
#   Policy count
#   API health
```

### `origin sessions`

List coding sessions with filters.

```bash
origin sessions                          # List recent sessions
origin sessions --status unreviewed      # Only unreviewed
origin sessions --model claude-sonnet-4  # Filter by model
origin sessions --limit 50              # Show more results
```

### `origin session <id>`

View full details of a session.

```bash
origin session abc123
# Shows: model, repo, commits, author, tokens, cost, duration,
#        files changed, review status
```

### `origin sessions end <id>`

End a running session. Kills the heartbeat process, ends the session on the platform, cleans local state files, and updates the `origin-sessions` git branch.

```bash
origin sessions end abc123      # End by session ID
origin sessions end abc1        # Partial ID match works
```

### `origin sessions clean`

End all stale RUNNING sessions in bulk.

```bash
origin sessions clean           # Clean sessions for current repo
origin sessions clean --all     # Clean all repos
```

### `origin explain [sessionId]`

Explain a coding session with prompts, file changes, cost, and review status.

```bash
# Explain active session
origin explain

# Explain by session ID
origin explain abc123

# Look up by commit SHA
origin explain --commit a1b2c3d

# Short output (skip prompt mappings)
origin explain --short

# AI-powered summary
origin explain --summarize

# JSON output
origin explain --json
```

The `--summarize` flag generates:
1. A structured metrics summary (scope, efficiency, velocity)
2. An AI-powered analysis (requires `ANTHROPIC_API_KEY` or `origin config set anthropicApiKey <key>`) with:
   - **Intent** — what the developer was trying to accomplish
   - **Outcome** — what was actually achieved
   - **Learnings** — patterns and techniques used
   - **Friction** — signs of struggle or inefficiency
   - **Time saved** — estimate vs writing manually

### `origin session-compare <id1> <id2>`

Compare two sessions side by side.

```bash
origin session-compare abc123 def456
# Shows:
#   Session    abc123       def456
#   Model      claude-4     gpt-4o
#   Duration   5m 30s       12m 15s
#   Tokens     15,234       42,891
#   Cost       $0.0456      $0.1234
#   Lines +    89           45
#   Lines -    12           30
#
#   Efficiency
#   Tokens/line  151        574
#   Lines/min    18         6
#
#   AI Comparison
#   Session 1 was 3.8x more token-efficient...
```

If an Anthropic API key is available, includes an AI-powered comparison analysis.

### `origin review <sessionId>`

Review and approve/reject/flag a session.

```bash
origin review abc123 --approve
origin review abc123 --reject --note "Introduces security vulnerability"
origin review abc123 --flag --note "Needs team review"
```

---

## Attribution & Blame

### `origin blame <file>`

Show AI vs human attribution per line, like `git blame` but for AI authorship.

```bash
origin blame src/index.ts
# Output:
#   Line  Tag   Author/Model              Content
#   ─────────────────────────────────────────────────
#     1  [AI]  gemini-3-flash-preview     hello world
#     2  [AI]  claude-sonnet-4            import express from 'express';
#     3  [HU]  Artem Dolobanko            const port = 8080;
#
# Summary: AI: 2 (67%)  Human: 1 (33%)  Mixed: 0 (0%)

# Show specific line range
origin blame src/index.ts --line 10-20

# JSON output (for IDE integration)
origin blame src/index.ts --json
```

Tags:
- `[AI]` (green) — Line written by AI agent (shows model name)
- `[HU]` (white) — Line written by human (shows git author)
- `[MX]` (yellow) — AI wrote initial version, human modified

### `origin diff [range]`

Show diff with AI/human attribution annotations.

```bash
origin diff                    # Diff of current changes
origin diff HEAD~5..HEAD       # Diff over last 5 commits
origin diff --ai-only          # Only AI-authored changes
origin diff --human-only       # Only human-authored changes
origin diff --json             # JSON output
```

### `origin stats`

View dashboard statistics with attribution breakdown.

```bash
# API stats (sessions, costs, agents)
origin stats

# Local git-based stats with attribution
origin stats --local
# Shows:
#   Total commits (AI vs human)
#   Lines added by AI vs human
#   Per-tool breakdown with bar graph:
#     claude-code  ████████████████████░░░░  82%  (340 lines)
#     cursor       ██████░░░░░░░░░░░░░░░░░░  25%  (45 lines)
#   Acceptance rate (AI lines humans kept vs edited)

# Custom commit range
origin stats --local --range HEAD~100..HEAD
```

---

## Search & Analysis

### `origin search <query>`

Search across all AI prompt history.

```bash
origin search "authentication"              # Search all prompts
origin search "refactor" --model claude     # Filter by model
origin search "database" --limit 50         # More results
origin search "API" --repo /path/to/repo    # Filter by repo
origin search "auth" --from 7d             # Only last 7 days
origin search "fix" --from 2w              # Last 2 weeks
origin search "deploy" --agent claude      # Filter by agent
origin search "bug" --from 1m --agent cursor # Combined filters
```

Searches across multiple data sources:
1. **Connected mode** — Origin API sessions
2. **Local state files** — `~/.origin/sessions/*.json`
3. **Git notes** — `refs/notes/origin` commit metadata
4. **Local DB** — `~/.origin/db/` prompt database (run `origin db import` to populate)

### `origin ask <query>`

Query the context behind AI-generated code. Find which session and prompts generated a specific file or line.

```bash
# Ask about a specific file
origin ask "auth" --file src/auth.ts
# Shows: sessions that modified this file, matching prompts

# Ask about a specific line
origin ask "why" --file src/index.ts --line 42

# Search within a specific session
origin ask "refactor" --session local-f7a2b3

# Global prompt search
origin ask "authentication"
```

How it works:
1. If `--file` is given, looks up sessions via git notes on commits touching that file
2. If `--session` is given, searches that session's prompts
3. Otherwise, searches all prompts matching the query
4. Falls back to searching the `origin-sessions` branch directly

### `origin prompts <file>`

Show all AI prompts that led to changes in a specific file — like `git log` but for AI prompts. Shows which prompts, models, and sessions touched each file.

```bash
# See which AI prompts touched a file
origin prompts src/auth.ts

# See prompts + the actual code diff per prompt
origin prompts src/auth.ts --expand

# Limit results
origin prompts src/auth.ts --limit 5
```

Output:

```
  src/auth.ts — 3 AI sessions touched this file

  Mar 16, 19:42  Claude 3.5 Sonnet      (a1b2c3d4)
  > "add JWT validation middleware"
    feat: add JWT auth middleware

  Mar 16, 18:15  Gemini 2.5 Pro         (d4e5f6a7)
  > "refactor auth to use async/await"
    refactor: async auth handlers

  Mar 15, 14:30  Claude 3.5 Sonnet      (g7h8i9j0)
  > "implement login endpoint"
    feat: login endpoint
```

With `--expand`, each entry includes the full colored diff showing exactly what lines that prompt added/removed in the file.

### `origin chat`

Interactive AI assistant for your repo's AI context. Ask natural language questions about your AI-authored code, sessions, costs, and attribution.

Requires `ANTHROPIC_API_KEY` environment variable.

```bash
# Interactive mode — ongoing conversation
origin chat

# Single question mode
origin chat -q "how much AI code is in this repo?"
origin chat -q "which model wrote the auth module?"
origin chat -q "what did AI touch last week?"
origin chat -q "show me the most expensive sessions"
```

Interactive session example:

```
  Origin Chat — ask anything about your AI-authored code

  you > who wrote src/auth.ts?
  3 AI sessions touched src/auth.ts. Claude 3.5 Sonnet wrote the initial
  login endpoint (session local-g7h8i9, Mar 15), then Gemini 2.5 Pro
  refactored it to async/await (session local-d4e5f6, Mar 16).

  you > how much have I spent on AI this month?
  Based on tracked sessions: $4.32 across 23 sessions.
  Claude 3.5 Sonnet: $3.18 (74%), Gemini 2.5 Pro: $1.14 (26%).

  you > exit
```

The assistant automatically gathers context from:
- Git notes (AI commit metadata)
- Session history (origin-sessions branch)
- Local prompt database
- Commit log and authors

### `origin web`

Launch a local web dashboard in your browser. Shows AI attribution stats, commit history, sessions, and prompts — no server or login required.

```bash
origin web              # Opens http://localhost:3141
origin web --port 8080  # Custom port
```

The dashboard includes:
- **Overview** — stats cards (total commits, AI ratio, lines added), bar charts by tool and model
- **Commits** — full commit list with [AI]/[HU] badges, model names, line counts
- **Sessions** — all tracked AI sessions with model, tokens, cost
- **Prompts** — prompt database browser with file change tracking

Data is gathered from git notes, the `origin-sessions` branch, and the local prompt database. The browser opens automatically.

### `origin analyze`

Analyze AI prompting patterns and metrics.

```bash
origin analyze                    # Analyze last 30 days
origin analyze --days 90          # Custom date range
origin analyze --model claude     # Filter by model
origin analyze --export report.md # Export to file
origin analyze --json             # JSON output
```

Shows:
- Total prompts, average/median length
- Prompt-to-file-change ratio
- Model breakdown (which AI models used most)
- Common patterns (questions, commands, fixes, refactors)
- Time distribution (when you prompt most)
- Top changed files

### `origin report`

Generate a sprint or time-range report with cost, model, user, and ROI metrics.

```bash
origin report                         # Default 7-day report
origin report --range 14d             # 14-day report
origin report --range 30d             # Monthly report
origin report --format json           # JSON output
origin report --format csv            # CSV output
origin report --output sprint.md      # Write to file
```

### `origin audit`

Generate a compliance audit trail (SOC 2, ISO 27001).

```bash
origin audit                                    # Audit last 30 days
origin audit --from 2026-01-01 --to 2026-03-31  # Custom date range
origin audit --format json                      # JSON output
origin audit --format csv                       # CSV output
origin audit --output audit.md                  # Write to file
```

### `origin backfill`

Retroactively tag old commits as AI or human-authored.

```bash
origin backfill                       # Dry-run — show what would be tagged
origin backfill --apply               # Actually write the tags
origin backfill --days 180            # Go back 6 months
origin backfill --min-confidence high # Only tag high-confidence matches
```

Scans `.claude/`, `.cursor/`, `.codex/` session history, commit message patterns, and code style heuristics to identify AI-generated commits.

### `origin verify`

Health check for agents, repo connection, and sessions.

```bash
origin verify           # Run all checks
origin verify --json    # JSON output
```

### `origin review-pr`

Review a pull request with AI governance analysis.

```bash
origin review-pr 123              # Review PR #123
origin review-pr <pr-url>         # Review by URL
```

---

## Reporting & Compliance

### `origin agents`

List and manage registered AI agents (connected mode).

```bash
origin agents                     # List all agents
origin agents create --name "My Agent" --slug my-agent --model claude-opus-4-6
```

### `origin policies`

View active governance policies for the organization.

```bash
origin policies
```

Policies are configured in the Origin dashboard and enforce rules like session review requirements, cost limits, model restrictions, and file access controls.

### `origin repos`

List and manage repositories tracked by Origin.

```bash
origin repos                      # List all repos
origin repos add --name my-repo --path /path/to/repo
```

---

## Time Travel & Resume

### `origin rewind`

Rewind to a previous AI checkpoint (time travel). Restore your code to any previous AI session state.

```bash
# Interactive checkpoint browser
origin rewind --interactive
# Shows:
#   Checkpoints for session abc12345:
#     1. [14:30] feat: add auth middleware      +45 -3  (claude-sonnet-4)
#     2. [14:25] fix: route handler types       +12 -8  (claude-sonnet-4)
#     3. [14:20] refactor: extract validators   +89 -34 (claude-sonnet-4)
#   Select checkpoint (1-3):

# Rewind to specific commit
origin rewind --to a1b2c3d

# List checkpoints without rewinding
origin rewind --list
```

**Safety:** Always stashes current changes before rewinding. Requires confirmation.

### `origin resume [branch]`

Resume an AI session from a previous branch. Builds context from the `origin-sessions` branch data.

```bash
# Resume from current branch
origin resume

# Resume from specific branch
origin resume feature/auth

# Auto-launch the AI agent with context
origin resume --launch

# Get context as JSON (for piping)
origin resume --json
```

With `--launch`, Origin detects the installed agent and launches it with the session context:
- Claude Code: pipes context to `claude --resume`
- Cursor: writes context to `.cursor/context.md`
- Gemini: writes context to `.gemini/context.md`

### `origin share <sessionId>`

Create a shareable prompt bundle from a session.

```bash
# Share entire session (copies to clipboard)
origin share abc123

# Share specific prompt
origin share abc123 --prompt 3

# Write to file
origin share abc123 --output session-bundle.md
```

Generates a self-contained markdown bundle with context, prompts, files changed, and diffs.

---

## Trail System

Branch-centric work tracking. Trails describe the "why" and "what" of work while sessions capture the "how" and "when."

### `origin trail`

Show the trail for the current branch.

```bash
origin trail
# Shows: Trail ID, name, branch, status, priority, labels,
#        reviewers, associated sessions
```

### `origin trail list`

List all trails.

```bash
origin trail list                    # All trails
origin trail list --status active    # Filter by status
```

Statuses: `active`, `review`, `done`, `paused`

### `origin trail create <name>`

Create a trail for the current branch.

```bash
origin trail create "Add user authentication"
origin trail create "Bug fix: login loop" --priority high
origin trail create "Refactor API" --priority critical --label backend --label api
```

### `origin trail update`

Update the current trail.

```bash
origin trail update --status review
origin trail update --priority high
origin trail update --title "Updated: Add OAuth2 authentication"
```

### `origin trail assign <user>`

Assign a reviewer.

```bash
origin trail assign john@example.com
```

### `origin trail label <labels...>`

Add labels.

```bash
origin trail label frontend security
```

Trails are stored on the `origin-sessions` branch under `trails/` and synced with remote.

---

## Cross-Agent Handoff

Automatically pass context between different AI agents. When you finish a session in Claude Code and start one in Cursor (or any other agent), Origin carries over what you were working on.

### How It Works

1. **On session-end/stop:** Origin writes `.git/origin-handoff.json` with the session's prompts, files changed, summary, and extracted TODOs
2. **On next session-start (any agent):** Origin reads the handoff and injects context into the new agent's system prompt

The new agent automatically knows:
- What was done in the previous session
- Which files are in progress
- The last prompt and its context
- Open TODOs from the previous session

### `origin handoff show`

Preview the handoff context that will be passed to the next agent.

```bash
origin handoff show
# Output:
#   Cross-Agent Handoff Context
#
#   Agent:    claude-code
#   Model:    claude-sonnet-4
#   Session:  5c6c03a2
#   Ended:    15m ago
#   Branch:   feature/auth
#
#   Summary: Added JWT authentication middleware...
#
#   Last prompt: "add validation for expired tokens"
#
#   Files in progress (3):
#     src/auth/middleware.ts
#     src/auth/jwt.ts
#     tests/auth.test.ts
#
#   Open TODOs:
#     - add refresh token support
#     - handle edge case for expired tokens
```

### `origin handoff clear`

Clear handoff data for the current repo.

```bash
origin handoff clear
```

**Note:** Handoff data expires after 24 hours automatically.

---

## Session Memory

Accumulated context across sessions. Origin remembers what happened in previous sessions and injects summaries into new ones.

### How It Works

1. **On session-end:** Origin writes a memory entry to git notes (`refs/notes/origin-memory`)
2. **On next session-start:** Origin reads the last 3 session summaries and injects them into the system prompt

The new agent gets context like:
```
Session history for this repo:
- [15m ago] claude-code/claude-sonnet-4: Added JWT auth middleware
  Files: src/auth/middleware.ts, src/auth/jwt.ts
- [2h ago] cursor/gpt-4o: Refactored database queries
  Files: src/db/queries.ts, src/db/pool.ts
- [1d ago] claude-code/claude-sonnet-4: Set up project structure
  Files: package.json, tsconfig.json, src/index.ts
```

### `origin memory show`

Display accumulated session memory for the current repo.

```bash
origin memory show              # Show last 10 sessions
origin memory show --limit 20   # Show more
```

### `origin memory clear`

Clear all session memory for the current repo.

```bash
origin memory clear
```

Memory is stored in git notes and travels with the repo when pushed (`git push origin refs/notes/origin-memory`).

---

## AI TODO Tracker

Origin automatically extracts TODOs mentioned in AI session prompts and tracks them across repos.

### How It Works

On session-end, Origin scans all prompts for patterns like:
- `TODO: ...`, `FIXME: ...`, `NOTE: ...`
- "need to fix X", "we should add Y", "handle Z later"
- "still need to implement X"

Extracted TODOs are stored in `~/.origin/origin-todos.json` across all repos.

### `origin todo`

List open TODOs (alias for `origin todo list`).

```bash
origin todo
# Output:
#   Open TODOs (3)
#
#   ○ a1b2c3d4  add refresh token support
#     session:5c6c03a2  my-app  15m ago
#     branch: feature/auth
#
#   ○ e5f6g7h8  handle edge case for expired tokens
#     session:5c6c03a2  my-app  15m ago
#
#   ○ i9j0k1l2  add rate limiting to API endpoints
#     session:d4e5f6a7  api-server  2h ago
```

### `origin todo list`

```bash
origin todo list                # Open TODOs for current repo
origin todo list --all          # Open TODOs from all repos
origin todo list --done         # Show completed TODOs
```

### `origin todo done <id>`

Mark a TODO as complete.

```bash
origin todo done a1b2            # Partial ID match works
# ✓ Marked as done: add refresh token support
```

### `origin todo show <id>`

Show full details of a TODO including the originating session.

```bash
origin todo show a1b2
# Output:
#   TODO a1b2c3d4
#   Text:      add refresh token support
#   Status:    open
#   Session:   5c6c03a2
#   Repo:      /Users/you/my-app
#   Branch:    feature/auth
#   Created:   2026-03-30T10:15:00Z (2h ago)
#   Source:    prompt
```

### `origin todo add <text>`

Manually add a TODO.

```bash
origin todo add "migrate database to PostgreSQL"
```

### `origin todo remove <id>`

Remove a TODO permanently.

```bash
origin todo remove a1b2
```

---

## Configuration

### `origin config`

Manage Origin configuration.

```bash
# List all config values with descriptions
origin config list

# Get a specific value
origin config get pushStrategy

# Set a value
origin config set commitLinking always
origin config set pushStrategy auto
origin config set secretRedaction true
origin config set telemetry true
```

### Available Config Keys

| Key | Values | Default | Description |
|-----|--------|---------|-------------|
| `apiUrl` | URL | `https://getorigin.io` | Origin API URL |
| `apiKey` | string | — | API key (use `origin login`) |
| `commitLinking` | `always` \| `prompt` \| `never` | `always` | Add Origin-Session trailers to commits |
| `pushStrategy` | `auto` \| `prompt` \| `false` | `auto` | When to push origin-sessions branch |
| `telemetry` | `true` \| `false` | `false` | Enable anonymous telemetry (opt-in) |
| `autoUpdate` | `true` \| `false` | `true` | Check for CLI updates |
| `secretRedaction` | `true` \| `false` | `true` | Redact secrets before sending to API |
| `hookChaining` | `true` \| `false` | `true` | Chain existing hooks when installing |
| `anthropicApiKey` | string | — | Anthropic API key for AI features (`explain --summarize`, `chat`, `session-compare`) |
| `agentSlugs` | object | `{}` | Per-tool agent slug overrides (e.g., `{"claude-code": "claude-front"}`) |

### Agent Slug Overrides

Override which Origin agent a tool's sessions are attributed to:

```bash
# Map Claude Code sessions to a custom agent slug
origin config set agentSlugs.claude-code claude-frontend

# Map Cursor sessions to a different agent
origin config set agentSlugs.cursor cursor-backend

# View current overrides
origin config get agentSlugs
```

This is useful when you have multiple Origin agents (e.g., `claude-frontend`, `claude-backend`) and want different repos or tools to report to different agents.

### Per-Repo Config (`.origin.json`)

```json
{
  "agent": "my-agent-slug",
  "ignorePatterns": ["*.generated.ts", "dist/**"],
  "trackTabCompletions": true
}
```

---

## Local Database

### `origin db import`

Import prompts from the `origin-sessions` branch into the local prompt database for search and analysis.

```bash
origin db import
# Walks origin-sessions branch, extracts prompts, stores in ~/.origin/db/
```

### `origin db stats`

Show local database statistics.

```bash
origin db stats
# Shows: Total prompts, stored blobs, blob storage size
```

---

## CI/CD Integration

### `origin ci check`

Report AI attribution stats in CI. Designed to run in GitHub Actions or similar CI systems.

```bash
origin ci check
origin ci check --range origin/main..HEAD
```

Output includes: total commits, AI vs human split, AI percentage, top AI models used.

### `origin ci squash-merge <baseBranch>`

Preserve AI attribution data through squash merges. Collects attribution from all commits being squashed and writes a combined note to the new squash commit.

```bash
origin ci squash-merge main
```

### `origin ci generate-workflow`

Generate a GitHub Actions workflow file for automated attribution checking.

```bash
origin ci generate-workflow
# Outputs a complete .github/workflows/origin-attribution.yml
```

### Example GitHub Actions Workflow

```yaml
name: Origin Attribution
on:
  pull_request:
    types: [opened, synchronize]

jobs:
  attribution:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
        with:
          fetch-depth: 0

      - name: Install Origin CLI
        run: npm install -g @origin/cli

      - name: Attribution Check
        run: |
          echo "## Attribution Report" >> $GITHUB_STEP_SUMMARY
          origin ci check --range "${{ github.event.pull_request.base.sha }}..${{ github.sha }}" >> $GITHUB_STEP_SUMMARY
```

**Required secrets:** `ORIGIN_API_KEY`

---

## GitHub Commit Annotations (Connected Mode)

When using Origin with the GitHub App integration, PRs automatically get:

- **Status Checks** — `origin/ai-governance` check that blocks or allows merges based on session review status
- **PR Comments** — detailed AI governance report table with sessions, costs, tokens, and policy violations
- **Commit Annotations** — `[AI 73%]` badge via GitHub Check Runs API showing per-commit AI attribution breakdown

The Check Run appears as "Origin AI Attribution" on the PR Checks tab and includes:
- Overall AI percentage across all PR commits
- Number of AI sessions and total AI lines added
- Models and agents used
- Per-commit table showing which commits are `[AI]` vs `[Human]`

This is automatic when the GitHub App is installed and `postChecks` is enabled in integration settings.

---

## Plugin System

Extend Origin with external agent plugins.

### `origin plugin list`

List installed plugins.

```bash
origin plugin list
```

### `origin plugin install <name> <command>`

Register an external agent plugin.

```bash
origin plugin install my-agent /usr/local/bin/my-agent-hook
```

Plugins communicate via JSON-over-stdio:
- Origin writes `{ "event": "session-start", "data": {...} }` to plugin stdin
- Plugin responds `{ "status": "ok", "data": {...} }` on stdout

### `origin plugin remove <name>`

Remove a plugin.

```bash
origin plugin remove my-agent
```

Plugin registry stored at `~/.origin/plugins.json`.

---

## Git Proxy

Transparent git proxy that intercepts git commands for automatic attribution tracking.

### `origin proxy install`

Install the git proxy wrapper. Creates `~/.origin/bin/git` that wraps the real git binary.

```bash
origin proxy install
# Adds ~/.origin/bin to PATH (add to shell profile)
```

**What it intercepts:** `git commit`, `git push`, `git rebase`, `git cherry-pick`, `git stash`

For each intercepted command, the proxy fires pre/post hooks for attribution preservation.

### `origin proxy uninstall`

Remove the git proxy.

```bash
origin proxy uninstall
```

### `origin proxy status`

Check proxy installation status.

```bash
origin proxy status
```

**Warning:** The git proxy modifies your PATH. It's opt-in only with a kill switch (`origin proxy uninstall`). If anything goes wrong, remove `~/.origin/bin` from your PATH.

---

## Maintenance

### `origin doctor`

Scan for and fix stuck or orphaned sessions.

```bash
origin doctor            # Scan only
origin doctor --fix      # Auto-fix issues found
origin doctor --verbose  # Detailed output
```

Checks for:
- Stuck sessions (>1hr old, auto-ends with `--fix` — ends on platform API + local git branch)
- Stale "running" sessions on `origin-sessions` branch (>1hr, marks as ended with `--fix`)
- Orphaned entries referencing non-existent commits
- Stale session state files (>24h/48h)
- Orphaned session files in `~/.origin/sessions/`
- Errors in hooks log
- Oversized hooks log (>10MB)
- API connection health

### `origin clean`

Remove orphaned data and temp files.

```bash
origin clean             # Preview what would be cleaned
origin clean --dry-run   # Same as above
origin clean --force     # Clean without confirmation
```

Removes:
- Orphaned `origin-sessions` branch entries
- Stale `.git/origin-session*.json` files
- Temp index files (`.git/origin-tmp-index*`)
- Old hooks log entries (>7 days)

### `origin reset`

Clear local session state for the current repo.

```bash
origin reset             # Warns if session <1h old
origin reset --force     # Force clear
```

---

## Upgrade

### `origin upgrade`

Upgrade Origin CLI to the latest version.

```bash
origin upgrade                    # Upgrade to latest stable
origin upgrade --channel beta     # Upgrade to beta channel
origin upgrade --channel canary   # Upgrade to canary channel
origin upgrade --check            # Only check, don't install
```

Origin also checks for updates automatically after commands run (configurable via `origin config set autoUpdate false`).

---

## Hook Architecture

Origin uses a multi-layer hook system:

### Agent Hooks (7 events)

| Event | Trigger | Data Captured |
|-------|---------|---------------|
| `session-start` | AI agent process begins | Session ID, model, branch, HEAD |
| `user-prompt-submit` | User sends prompt | Prompt text |
| `stop` | AI finishes a turn | Tokens, files changed, cost |
| `session-end` | AI process terminates | Full transcript, git state, final metrics |
| `pre-tool-use` | AI about to use a tool | Tool name, input |
| `post-tool-use` | AI finished using a tool | Tool result, subagent tracking |
| `git-post-commit` | After every git commit | Commit SHA, message, files, diff |
| `git-pre-push` | Before git push | Pushes origin-sessions branch alongside |
| `git-post-rewrite` | After rebase/amend | Copies attribution notes to new SHAs |
| `git-post-checkout` | After branch checkout/stash | Preserves attribution through stash ops |

### Data Flow

```
AI Agent → Agent Hook → Origin CLI → Origin API
                    ↓
            .git/origin-session-<tag>.json (local state)
                    ↓
            origin-sessions branch (git plumbing)
                    ↓
            refs/notes/origin (git notes per commit)
                    ↓
            .git/origin-handoff.json (cross-agent context)
                    ↓
            refs/notes/origin-memory (session memory)
                    ↓
            ~/.origin/origin-todos.json (extracted TODOs)
```

### Session Lifecycle

Each agent handles session start/end differently:

| Agent | Session Start | Session End | Fallback |
|-------|--------------|-------------|----------|
| Claude Code | `SessionStart` hook | `SessionEnd` hook | Heartbeat stale check (15 min) |
| Cursor | `sessionStart` hook | No explicit end | Heartbeat stale check (15 min) |
| Codex CLI | `user-prompt-submit` hook | No explicit end | Heartbeat stale check (15 min) |
| Gemini CLI | `SessionStart` hook | `SessionEnd` hook | Heartbeat stale check (15 min) |

**Heartbeat:** A background process (`~/.origin/heartbeats/<id>.pid`) pings the Origin API every 30 seconds. If the state file hasn't been updated in 15 minutes (agent closed/crashed), the heartbeat auto-ends the session.

**Server-side cleanup:** The Origin platform also checks every 5 minutes and auto-completes any RUNNING sessions with no heartbeat ping in 15 minutes.

### Per-Prompt Diff Tracking

Origin tracks file changes per prompt, not just per session:

- `headShaAtLastStop` — HEAD SHA after each prompt's stop, used as baseline for the next prompt's diff
- `completedPromptMappings` — accumulated per-prompt file change data across stops
- On each Stop event, the current prompt's changes are merged with previously saved mappings
- The API receives all prompt mappings and stores them as `PromptChange` records
- The AI Blame view on the dashboard uses these to show which prompt wrote which lines

### Concurrent Sessions

Claude Code supports multiple concurrent sessions on the same repo. Each session gets a unique tag derived from the Claude session ID, stored as `.git/origin-session-<tag>.json`.

### Secret Redaction

When `secretRedaction` is enabled (default: true), Origin automatically redacts:
- AWS keys (AKIA...)
- GitHub tokens (ghp_, gho_, ghu_, ghs_, github_pat_)
- OpenAI keys (sk-...)
- Anthropic keys (sk-ant-...)
- Stripe keys (sk_live_, sk_test_)
- Slack tokens (xoxb-, xoxp-)
- Private keys (-----BEGIN ... PRIVATE KEY-----)
- JWTs (eyJ...)
- Database connection strings (postgres://, mysql://, mongodb://)
- High-entropy secrets (Shannon entropy > 4.5)

---

## Data Storage

### Local Files

| Path | Purpose |
|------|---------|
| `~/.origin/config.json` | API URL, key, org/user IDs, feature flags |
| `~/.origin/agent.json` | Machine registration (hostname, detected tools) |
| `~/.origin/hooks.log` | Debug log for all hook invocations |
| `~/.origin/db/prompts.json` | Local prompt database |
| `~/.origin/blobs/<hash>` | Content-addressable blob storage |
| `~/.origin/plugins.json` | Plugin registry |
| `~/.origin/last-update-check.json` | Update check cache (24h TTL) |
| `~/.origin/sessions/<id>.json` | Global session archive (backup state) |
| `~/.origin/heartbeats/<id>.pid` | Active heartbeat PID files |
| `~/.origin/origin-todos.json` | AI-extracted TODO tracker (cross-repo) |
| `.git/origin-session-<tag>.json` | Active session state (tagged per concurrent session) |
| `.git/origin-handoff.json` | Cross-agent handoff context (last session summary for next agent) |
| `.origin.json` | Per-repo config (agent slug, ignore patterns) |

### Git Refs

| Ref | Purpose |
|-----|---------|
| `origin-sessions` | Orphan branch storing session data (metadata.json, prompts.md, changes.json per session) |
| `refs/notes/origin` | Git notes with AI attribution metadata per commit |
| `refs/notes/origin-memory` | Session memory — accumulated session summaries for context injection |
| `trails/` | Trail metadata (on origin-sessions branch) |

### Origin-Sessions Branch Structure

```
sessions/
  <sessionId>/
    metadata.json    # Session metrics, tokens, cost, git state
    prompts.md       # Human-readable markdown with all prompts
    changes.json     # Prompt-to-file mappings with diffs
trails/
  <trailId>.json     # Trail metadata
```

### Git Notes Format

Each AI-assisted commit gets a note under `refs/notes/origin`:

```json
{
  "origin": {
    "sessionId": "local-f7a2b3",
    "model": "gemini-3-flash-preview",
    "promptCount": 5,
    "promptSummary": "Add authentication middleware...",
    "tokensUsed": 15000,
    "costUsd": 0.45,
    "durationMs": 120000,
    "linesAdded": 89,
    "linesRemoved": 12
  }
}
```

View notes: `git notes --ref=origin show <commit-sha>`
Push notes: `git push origin refs/notes/origin`

---

## Supported Agents

| Agent | Detection | Hook System | Session Reuse | Status |
|-------|-----------|-------------|---------------|--------|
| Claude Code | Session hooks + process detection | Claude Code hooks API | No (new session per conversation) | Stable |
| Cursor | Session hooks + Cursor DB | Cursor hooks API | Yes (reuses across prompts) | Stable |
| Codex CLI | Session hooks + SQLite state | Codex hooks API | No (new session per conversation) | Stable |
| Gemini CLI | Session hooks + process detection | Gemini settings hooks | No | Stable |
| Aider | Process detection | Config hooks | No | Stable |
| Windsurf | Session hooks + process detection | Windsurf hooks API | No | Preview |
| GitHub Copilot | Process detection | Global post-commit hook | N/A | Preview |
| Continue | Process detection | Global post-commit hook | N/A | Preview |
| Amp | Process detection | Global post-commit hook | N/A | Preview |
| Junie | Process detection | Global post-commit hook | N/A | Preview |
| OpenCode | Process detection | Global post-commit hook | N/A | Preview |
| Rovo Dev | Process detection | Global post-commit hook | N/A | Preview |
| Droid | Process detection | Global post-commit hook | N/A | Preview |

### Cost Estimation

Origin estimates costs for:
- Claude Sonnet 4 / Opus 4 / Haiku
- Gemini Pro / Ultra
- GPT-4 / GPT-4o / o1 / o3
- Custom models (configurable)

---

## File Ignore Patterns

Origin automatically ignores these files in attribution tracking:

**Lock files:** `package-lock.json`, `yarn.lock`, `pnpm-lock.yaml`, `Cargo.lock`, `go.sum`, etc.
**Generated:** `*.generated.*`, `*.min.js`, `*.min.css`, `*.map`
**Directories:** `node_modules/`, `vendor/`, `dist/`, `.next/`, `build/`, `__snapshots__/`

Override in `.origin.json`:

```json
{
  "ignorePatterns": ["custom-generated/**", "*.auto.ts"]
}
```

---

## Environment Variables

| Variable | Purpose |
|----------|---------|
| `ORIGIN_API_URL` | Override API URL |
| `ORIGIN_API_KEY` | Override API key |
| `ORIGIN_DEBUG` | Enable debug logging |
| `ANTHROPIC_API_KEY` | Anthropic API key for AI features (`explain --summarize`, `chat`, `session-compare`) |

---

## Troubleshooting

### Hooks not firing

```bash
origin doctor --verbose    # Check for issues
origin enable              # Reinstall hooks
```

### Stale/stuck sessions

```bash
origin doctor --fix        # Auto-fix stuck sessions (local + origin-sessions branch)
origin sessions end <id>   # End a specific session
origin sessions clean      # End all stale sessions for current repo
origin sessions clean --all # End all stale sessions globally
origin clean --force       # Remove orphaned data
origin reset --force       # Clear current session state
```

### Session still shows RUNNING after closing agent

The heartbeat process auto-ends sessions after 15 minutes of inactivity. If it persists:

```bash
# Check for orphaned heartbeats
ls ~/.origin/heartbeats/

# Force end
origin sessions end <id>

# Fix stuck git branch entries
origin doctor --fix
```

### AI Blame shows 0 prompts

Check the hooks log for errors during the Stop event:

```bash
grep "stop.*ERROR" ~/.origin/hooks.log
```

Common causes: API payload too large (fixed in v0.20260330+), transcript path not found, or session state missing.

### View hook logs

```bash
tail -100 ~/.origin/hooks.log

# Filter for specific events
grep "stop" ~/.origin/hooks.log | tail -20
grep "ERROR" ~/.origin/hooks.log | tail -20
```

### Check connection

```bash
origin whoami              # Verify auth
origin status              # Check API health
origin verify              # Full health check
```
