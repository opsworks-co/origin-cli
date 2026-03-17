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
origin enable --agent windsurf
origin enable --agent aider

# Install globally (all repos tracked automatically)
origin enable --global

# Install and link to a specific Origin agent
origin enable --link my-agent-slug

# Replace existing hooks instead of chaining
origin enable --no-chain
```

**What gets installed:**

| Agent | Config File | Events |
|-------|-------------|--------|
| Claude Code | `~/.claude/settings.json` | SessionStart, Stop, UserPromptSubmit, SessionEnd, PreToolUse, PostToolUse |
| Cursor | `~/.cursor/hooks.json` | sessionStart, stop, beforeSubmitPrompt, sessionEnd |
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

The `--summarize` flag generates a structured AI summary with: intent, outcome, learnings, friction points, and open items.

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
```

Searches the local prompt database. Run `origin db import` first to populate from the `origin-sessions` branch.

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
- Stuck sessions (>1hr old)
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
            .git/origin-session.json (local state)
                    ↓
            origin-sessions branch (git plumbing)
                    ↓
            refs/notes/origin (git notes per commit)
```

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
| `.git/origin-session.json` | Active session state |
| `.git/origin-session-<tag>.json` | Concurrent session state |
| `.origin.json` | Per-repo config (agent slug, ignore patterns) |

### Git Refs

| Ref | Purpose |
|-----|---------|
| `origin-sessions` | Orphan branch storing session data (metadata.json, prompts.md, changes.json per session) |
| `refs/notes/origin` | Git notes with AI attribution metadata per commit |
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

---

## Troubleshooting

### Hooks not firing

```bash
origin doctor --verbose    # Check for issues
origin enable              # Reinstall hooks
```

### Stale sessions

```bash
origin clean --force       # Remove stale data
origin reset --force       # Clear current session
```

### View hook logs

```bash
tail -100 ~/.origin/hooks.log
```

### Check connection

```bash
origin whoami              # Verify auth
origin status              # Check API health
```
