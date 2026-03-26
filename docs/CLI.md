# CLI Reference

Complete reference for the `origin` CLI — every command, every flag, every option.

---

## Installation

```bash
npm i -g https://getorigin.io/cli/origin-cli-latest.tgz
```

---

## Modes

Origin operates in two modes:

| Mode | Description |
|------|-------------|
| **Standalone** | No server, no login. All data stored locally in git notes and the `origin-sessions` branch. Zero setup. |
| **Connected** | Linked to [getorigin.io](https://getorigin.io) for centralized dashboard, policy enforcement, team analytics, and PR compliance. |

Standalone is the default. Run `origin login` to switch to connected mode.

---

## Supported Agents

| Agent | Slug | Hook Type |
|-------|------|-----------|
| Claude Code | `claude-code` | Session hooks (SessionStart, Stop, UserPromptSubmit, SessionEnd, PreToolUse, PostToolUse) |
| Cursor | `cursor` | Session hooks + Cursor DB |
| Gemini CLI | `gemini` | Session hooks |
| Codex CLI | `codex` | Session hooks |
| Windsurf | `windsurf` | Session hooks |
| Aider | `aider` | Config hooks (.aider.conf.yml) |

---

## Setup Commands

### `origin login`

Authenticate with the Origin platform (connected mode).

```bash
origin login
```

Prompts for:
- **Origin API URL** (default: `https://getorigin.io`)
- **API Key** from Settings > API Keys

Saves credentials to `~/.origin/config.json`.

---

### `origin init`

Initialize Origin on this machine. Auto-detects installed AI tools, registers the machine, and installs global hooks.

```bash
origin init
origin init --standalone
```

| Flag | Description |
|------|-------------|
| `--standalone` | Force standalone mode (skip API, even when logged in) |

What it does:
1. Detects installed AI coding tools
2. Registers the machine with your org (connected mode)
3. Saves agent config to `~/.origin/agent.json`
4. Installs global hooks via `origin enable --global`

---

### `origin enable`

Install Origin hooks for session tracking. Writes hook config into each agent's settings file.

```bash
origin enable                          # Auto-detect agents in current repo
origin enable --global                 # Install globally (~/) for all repos
origin enable --agent cursor           # Only install for Cursor
origin enable --link my-agent          # Also link repo to an agent slug
origin enable --no-chain               # Replace existing hooks instead of chaining
```

| Flag | Description |
|------|-------------|
| `-a, --agent <agent>` | Agent to enable: `claude-code`, `cursor`, `gemini`, `windsurf`, `codex`, `aider`. Auto-detects if omitted. |
| `-g, --global` | Install hooks globally (`~/`) so all repos are tracked |
| `-l, --link <slug>` | Link this repo to an Origin agent by slug (writes `.origin.json`) |
| `--no-chain` | Replace existing hooks instead of chaining |

Hook files written:
- Claude Code: `.claude/settings.json`
- Cursor: `.cursor/hooks.json`
- Gemini CLI: `.gemini/settings.json`
- Codex CLI: `.codex/hooks.json`
- Windsurf: `.windsurf/hooks.json`
- Aider: `.aider.conf.yml`

Also installs git hooks (pre-commit for secret scanning, post-commit for attribution, pre-push for session sync).

---

### `origin disable`

Remove Origin hooks from all agent configs.

```bash
origin disable                         # Current repo only
origin disable --global                # Remove global hooks from ~/
```

| Flag | Description |
|------|-------------|
| `-g, --global` | Remove global hooks from `~/` |

---

### `origin link [slug]`

Link this repo to a specific Origin agent. Two modes:

- **Auto-detect (default):** Origin detects which agent is running via process detection. No config needed.
- **Manual link:** `origin link <agent-slug>` writes the mapping to `.origin.json` in the repo root.

When linked, the CLI sends `agentSlug` to the API on session start and receives that agent's system prompt and policies.

```bash
origin link claude-code                # Link this repo to "claude-code" agent
origin link --list                     # Show current link
origin link --unlink                   # Remove link
```

| Flag | Description |
|------|-------------|
| `--list` | Show current agent link for this repo |
| `--unlink` | Remove agent mapping (deletes from `.origin.json`) |

---

### `origin status`

Show current status: active session, branch, repo info, connection state.

```bash
origin status
```

---

### `origin whoami`

Show current user, org, and machine info.

```bash
origin whoami
```

---

### `origin upgrade`

Upgrade Origin CLI to the latest version from `getorigin.io`.

```bash
origin upgrade                         # Download and install latest
origin upgrade --check                 # Only check, don't install
```

| Flag | Description |
|------|-------------|
| `--check` | Only check for updates, do not install |

---

## Attribution & Blame

### `origin blame <file>`

Show AI vs human attribution per line, like `git blame` but for AI.

```bash
origin blame src/index.ts
origin blame src/api.ts --line 10-20
origin blame src/api.ts --json
```

| Flag | Description |
|------|-------------|
| `-l, --line <range>` | Show specific line range (e.g., `10-20`) |
| `--json` | Output as JSON |

Example output:
```
  1 | Claude   | 3h ago  | import express from 'express';
  2 | Human    | 2d ago  |
  3 | Gemini   | 1h ago  | export async function getUsers() {

10 lines  Claude: 40%  Gemini: 30%  Human: 30%
```

---

### `origin diff [range]`

Show diff with AI/human attribution annotations.

```bash
origin diff                            # Unstaged changes
origin diff HEAD~5..HEAD               # Specific range
origin diff --ai-only                  # Only AI-authored changes
origin diff --human-only               # Only human-authored changes
origin diff --json
```

| Flag | Description |
|------|-------------|
| `--ai-only` | Only show AI-authored changes |
| `--human-only` | Only show human-authored changes |
| `--json` | Output as JSON |

---

### `origin stats`

View attribution statistics for the current repo.

```bash
origin stats                           # Local git attribution (default)
origin stats --dashboard               # API dashboard stats
origin stats --dashboard --global      # Org-wide dashboard stats
origin stats --range HEAD~100..HEAD    # Custom commit range
```

| Flag | Description |
|------|-------------|
| `--local` | Compute stats from local git data (default when in a repo) |
| `--dashboard` | Show org-wide dashboard stats from Origin API |
| `-g, --global` | Show stats across all repos (default: current repo only) |
| `-r, --range <range>` | Commit range (e.g., `HEAD~50..HEAD`) |

---

### `origin compare <arg1> [arg2]`

Compare AI attribution between two branches or commit ranges.

```bash
origin compare main feature-branch
origin compare HEAD~50..HEAD~25 HEAD~25..HEAD
origin compare main --json
```

| Flag | Description |
|------|-------------|
| `--json` | Output as JSON |

Displays side-by-side comparison: AI commits %, AI lines %, models used, cost.

---

### `origin prompts <file>`

Show AI prompts that led to changes in a file. Like `git log` but for AI prompts.

```bash
origin prompts src/api.ts
origin prompts src/api.ts --expand     # Include code diffs
origin prompts src/api.ts --limit 5
```

| Flag | Description |
|------|-------------|
| `-e, --expand` | Show the actual code diff for each prompt |
| `--limit <n>` | Max entries to show (default: `10`) |

---

### `origin rework`

Detect AI-generated code that was reverted or heavily modified by humans (rework hotspots).

```bash
origin rework                          # Last 7 days
origin rework --days 30 --limit 10
```

| Flag | Description |
|------|-------------|
| `-d, --days <n>` | Number of days to look back (default: `7`) |
| `-l, --limit <n>` | Max results to show (default: `20`) |

---

### `origin backfill`

Retroactively tag old commits with AI attribution by scanning agent history (`.claude/`, `.cursor/`, `.codex/`), commit message patterns, and code style heuristics.

```bash
origin backfill                        # Dry-run (default)
origin backfill --apply                # Actually write git notes
origin backfill --days 180             # Go back 6 months
origin backfill --min-confidence high  # Only high-confidence matches
```

| Flag | Description |
|------|-------------|
| `-d, --days <n>` | How far back to scan (default: `90`) |
| `--dry-run` | Show results without tagging (default behavior) |
| `--apply` | Actually write git notes |
| `--min-confidence <level>` | Minimum confidence: `high`, `medium`, `low` (default: `medium`) |

---

### `origin verify`

Health check showing agent config, repo config, mode, active sessions, and attribution summary.

```bash
origin verify
origin verify --json
```

| Flag | Description |
|------|-------------|
| `--json` | Output as JSON |

---

## Session Management

### `origin sessions`

List coding sessions. Scoped to the current repo by default.

```bash
origin sessions
origin sessions --all                  # All repos
origin sessions --status unreviewed
origin sessions --model claude-sonnet-4-20250514 --limit 10
```

| Flag | Description |
|------|-------------|
| `-s, --status <status>` | Filter: `unreviewed`, `approved`, `rejected`, `flagged` |
| `-m, --model <model>` | Filter by AI model |
| `-l, --limit <n>` | Max results (default: `20`) |
| `-a, --all` | Show sessions from all repos |

---

### `origin session <id>`

View full details of a specific session.

```bash
origin session abc123
```

---

### `origin sessions end <sessionId>`

End a running session. Supports short IDs (first 8 chars).

```bash
origin sessions end abc12345
```

---

### `origin explain [sessionId]`

Explain a coding session: prompts, files, cost, review status, prompt-to-change mapping.

```bash
origin explain                         # Active session
origin explain abc123
origin explain --commit a1b2c3d        # Look up by commit SHA
origin explain abc123 --short          # Skip prompt-change mapping
origin explain abc123 --summarize      # AI-powered summary
origin explain abc123 --json
```

| Flag | Description |
|------|-------------|
| `-c, --commit <sha>` | Look up session by commit SHA (via git notes) |
| `-s, --short` | Short output (skip prompt-change mapping) |
| `--summarize` | Generate AI-powered summary (intent, outcome, learnings, friction) |
| `--json` | Output as JSON |

---

### `origin ask <query>`

Ask about AI-generated code. Find the session and prompts behind any file or change.

```bash
origin ask "who wrote the auth middleware"
origin ask "what changed yesterday" --file src/api.ts
origin ask "why was this function added" --line 42 --file src/utils.ts
```

| Flag | Description |
|------|-------------|
| `-f, --file <path>` | Ask about a specific file |
| `-l, --line <n>` | Focus on a specific line number |
| `-s, --session <id>` | Search within a specific session |
| `--limit <n>` | Max results (default: `5`) |

---

### `origin chat`

Interactive AI assistant for your repo's AI context. Ask natural language questions about who wrote what, costs, sessions, and more. Requires `ANTHROPIC_API_KEY` env var.

```bash
origin chat                            # Interactive mode
origin chat -q "how much did AI cost this week"
```

| Flag | Description |
|------|-------------|
| `-q, --question <text>` | Ask a single question (non-interactive) |

---

### `origin resume [branch]`

Resume an AI session from a previous branch. Outputs markdown context for piping to agents.

```bash
origin resume
origin resume feature/auth
origin resume --launch                 # Auto-launch AI agent with context
origin resume --json
```

| Flag | Description |
|------|-------------|
| `--launch` | Auto-launch the AI agent with context |
| `--json` | Output context as JSON |

---

### `origin rewind`

Rewind to a previous AI checkpoint (time travel through session commits).

```bash
origin rewind --list                   # List checkpoints
origin rewind --to a1b2c3d            # Rewind to specific commit
origin rewind --interactive            # Interactive checkpoint browser
```

| Flag | Description |
|------|-------------|
| `-i, --interactive` | Interactive checkpoint browser |
| `-t, --to <sha>` | Rewind to specific commit SHA |
| `--list` | List checkpoints without rewinding |

---

### `origin review <sessionId>`

Review a coding session: approve, reject, or flag.

```bash
origin review abc123 --approve
origin review abc123 --reject --note "Uses deprecated API"
origin review abc123 --flag --note "Needs security review"
```

| Flag | Description |
|------|-------------|
| `--approve` | Approve the session |
| `--reject` | Reject the session |
| `--flag` | Flag the session for review |
| `-n, --note <note>` | Review note |

---

### `origin review-pr <url>`

Analyze AI sessions behind a GitHub pull request. Requires connected mode.

```bash
origin review-pr https://github.com/org/repo/pull/123
```

---

### `origin intent-review [branch]`

Intent-based review: shows WHY code was written (prompts, reasoning, risk) not just WHAT changed.

```bash
origin intent-review
origin intent-review feature/auth
origin intent-review --format json --output review.json
```

| Flag | Description |
|------|-------------|
| `-f, --format <format>` | Output format: `json`, `md` (default: terminal) |
| `-o, --output <file>` | Write output to file |

---

### `origin share <sessionId>`

Create a shareable prompt bundle from a session.

```bash
origin share abc123                    # Copy markdown bundle to clipboard
origin share abc123 --public           # Create public link (getorigin.io/s/<slug>)
origin share abc123 --prompt 2         # Share specific prompt only
origin share abc123 --output session.md
```

| Flag | Description |
|------|-------------|
| `-p, --prompt <index>` | Share a specific prompt by index |
| `-o, --output <path>` | Write to file instead of clipboard |
| `--public` | Create a public share URL (requires platform connection) |

---

## Snapshots

Mid-session shadow snapshots (no commits required). Captures working tree state without affecting git index.

### `origin snapshot`

Save a snapshot of the current working tree state.

```bash
origin snapshot
```

### `origin snapshot list`

List all snapshots for the current session.

```bash
origin snapshot list
```

### `origin snapshot restore <id>`

Restore working tree to a previously saved snapshot. Automatically saves current state before restoring.

```bash
origin snapshot restore lxyz123
```

### `origin snapshot clean`

Remove all shadow snapshot branches.

```bash
origin snapshot clean
```

---

## Search & Analysis

### `origin search <query>`

Full-text search across all AI prompt history.

```bash
origin search "authentication"
origin search "database migration" --from 7d --agent claude
origin search "refactor" --model claude-sonnet-4-20250514 --limit 5
```

| Flag | Description |
|------|-------------|
| `-l, --limit <n>` | Max results (default: `20`) |
| `--from <date>` | Filter by date (e.g., `7d`, `2w`, `1m`, or `2025-01-01`) |
| `--agent <name>` | Filter by agent: `claude`, `cursor`, `gemini`, `codex`, `windsurf`, `aider` |
| `-m, --model <model>` | Filter by model |
| `-r, --repo <path>` | Filter by repo path |

---

### `origin analyze`

Analyze AI prompting patterns and metrics: prompt lengths, model breakdown, common patterns, time distribution.

```bash
origin analyze
origin analyze --days 60 --model claude-sonnet-4-20250514
origin analyze --export analysis.json --json
```

| Flag | Description |
|------|-------------|
| `-d, --days <n>` | Number of days to analyze (default: `30`) |
| `-m, --model <model>` | Filter by model |
| `-e, --export <path>` | Export results to file |
| `--json` | Output as JSON |

---

## Reporting & Compliance

### `origin report`

Generate a markdown sprint report summarizing AI activity: cost breakdown, agent usage, daily activity.

```bash
origin report                          # Last 7 days, markdown
origin report --range 14d --output sprint.md
origin report --range 30d --format json
```

| Flag | Description |
|------|-------------|
| `-r, --range <range>` | Date range: `7d`, `14d`, or `30d` (default: `7d`) |
| `-o, --output <file>` | Write report to file instead of stdout |
| `-f, --format <format>` | Output format: `md`, `json`, or `csv` (default: `md`) |

---

### `origin audit`

Generate a compliance audit trail for SOC 2, ISO 27001, and GDPR reporting.

```bash
origin audit
origin audit --from 2026-01-01 --to 2026-03-31 --format csv --output q1.csv
origin audit --author "Jane" --agent claude
```

| Flag | Description |
|------|-------------|
| `--from <date>` | Start date, YYYY-MM-DD (default: 30 days ago) |
| `--to <date>` | End date, YYYY-MM-DD (default: today) |
| `--author <name>` | Filter by author name |
| `--agent <name>` | Filter by agent name |
| `-f, --format <format>` | Output format: `md`, `json`, `csv` (default: `md`) |
| `-o, --output <file>` | Write to file instead of stdout |

---

### `origin export`

Export session data as CSV, JSON, or Agent Trace v0.1.0.

```bash
origin export                          # JSON to stdout
origin export --format csv --output sessions.csv
origin export --format agent-trace --session abc123
origin export --model claude-sonnet-4-20250514 --limit 50
```

| Flag | Description |
|------|-------------|
| `-f, --format <format>` | Output format: `json`, `csv`, `agent-trace` (default: `json`) |
| `-o, --output <file>` | Write to file instead of stdout |
| `-l, --limit <n>` | Limit number of sessions |
| `-m, --model <name>` | Filter by model |
| `-s, --session <id>` | Export only a specific session (agent-trace format) |

---

## Trail System

Branch-centric work tracking. Associate branches with metadata, labels, reviewers, and priority.

### `origin trail`

Show current trail for this branch.

```bash
origin trail
```

### `origin trail list`

List all trails.

```bash
origin trail list
origin trail list --status active
```

| Flag | Description |
|------|-------------|
| `-s, --status <status>` | Filter by status: `active`, `review`, `done`, `paused` |

### `origin trail create <name>`

Create a trail for the current branch.

```bash
origin trail create "implement auth"
origin trail create "fix login bug" --priority high --label security --label urgent
```

| Flag | Description |
|------|-------------|
| `-p, --priority <priority>` | Priority: `low`, `medium`, `high`, `critical` (default: `medium`) |
| `-l, --label <labels...>` | Labels to add |

### `origin trail update`

Update the current trail.

```bash
origin trail update --status review
origin trail update --priority critical --title "New title"
```

| Flag | Description |
|------|-------------|
| `-s, --status <status>` | New status: `active`, `review`, `done`, `paused` |
| `-p, --priority <priority>` | New priority |
| `-t, --title <title>` | New title |

### `origin trail assign <user>`

Assign a reviewer to the current trail.

```bash
origin trail assign jane
```

### `origin trail label <labels...>`

Add labels to the current trail.

```bash
origin trail label security backend
```

---

## Configuration

### `origin config get <key>`

Get a config value.

```bash
origin config get commitLinking
origin config get push-strategy        # Kebab-case aliases work
```

### `origin config set <key> <value>`

Set a config value.

```bash
origin config set commitLinking always
origin config set pushStrategy auto
origin config set secretRedaction true
origin config set checkpointRepo git@github.com:org/sessions.git
```

### `origin config list`

List all config values with types and descriptions.

```bash
origin config list
```

#### Configuration Keys

| Key | Type | Values | Description |
|-----|------|--------|-------------|
| `apiUrl` | string | | Origin API URL |
| `apiKey` | string | | API key (use `origin login` instead) |
| `orgId` | string | | Organization ID |
| `userId` | string | | User ID |
| `machineId` | string | | Machine identifier |
| `commitLinking` | enum | `always`, `prompt`, `never` | When to add Origin-Session trailers to commits |
| `pushStrategy` | enum | `auto`, `prompt`, `false` | When to push origin-sessions branch |
| `telemetry` | boolean | `true`, `false` | Enable anonymous telemetry (opt-in) |
| `autoUpdate` | boolean | `true`, `false` | Check for CLI updates on startup |
| `secretRedaction` | boolean | `true`, `false` | Redact secrets before sending to API |
| `hookChaining` | boolean | `true`, `false` | Chain existing hooks when installing Origin hooks |
| `checkpointRepo` | string | | External git remote URL for session data |
| `mode` | enum | `auto`, `standalone` | Force standalone mode — skip all API calls, everything local |

Kebab-case aliases are accepted (e.g., `commit-linking` for `commitLinking`).

**Entering standalone mode:**

```bash
origin init --standalone                   # At setup time
origin config set mode standalone          # Switch anytime (skip all API calls, everything local)
```

Config file location: `~/.origin/config.json`

---

## Database Management

### `origin db import`

Import prompts from the `origin-sessions` branch or agent-trace files into the local SQLite database.

```bash
origin db import                       # Import from origin-sessions branch
origin db import --format agent-trace --file trace.json
```

| Flag | Description |
|------|-------------|
| `-f, --format <format>` | Import format: `origin-sessions` (default) or `agent-trace` |
| `--file <path>` | Input file (for agent-trace format; otherwise reads from git) |

### `origin db stats`

Show local database statistics.

```bash
origin db stats
```

---

## CI/CD Integration

### `origin ci check`

Report AI attribution stats for CI output. Walks recent commits and reports AI vs human attribution.

```bash
origin ci check
origin ci check --range HEAD~20..HEAD
```

| Flag | Description |
|------|-------------|
| `-r, --range <range>` | Commit range to check |

### `origin ci squash-merge <baseBranch>`

Preserve attribution through squash merge. Collects attribution from all commits being squashed and writes a combined note to the merge commit.

```bash
origin ci squash-merge main
```

### `origin ci generate-workflow`

Generate a GitHub Actions workflow YAML snippet for integrating Origin attribution checks into CI.

```bash
origin ci generate-workflow
```

Output: save as `.github/workflows/origin-attribution.yml`. Requires `ORIGIN_API_KEY` secret.

---

## Ignore Patterns

Manage file ignore patterns for Origin tracking. Ignored files are excluded from attribution analysis.

### `origin ignore`

List all ignore patterns (built-in defaults, gitattributes, and custom).

```bash
origin ignore
```

### `origin ignore add <pattern>`

Add an ignore pattern to `.origin.json`.

```bash
origin ignore add "*.generated.ts"
origin ignore add "vendor/**"
```

### `origin ignore remove <pattern>`

Remove a custom ignore pattern.

```bash
origin ignore remove "*.generated.ts"
```

### `origin ignore test <filepath>`

Test if a file would be ignored.

```bash
origin ignore test src/generated/types.ts
```

---

## Plugin System

External agent plugin management. Plugins receive session events via JSON stdin/stdout protocol.

### `origin plugin list`

List installed plugins.

```bash
origin plugin list
```

### `origin plugin install <name> <command>`

Install an external agent plugin.

```bash
origin plugin install my-logger "/usr/local/bin/my-logger"
```

Plugin protocol:
- **Input:** `{ "event": "...", "data": {...}, "timestamp": "..." }`
- **Output:** `{ "status": "ok"|"error"|"skip", "data": {...} }`

### `origin plugin remove <name>`

Remove an installed plugin.

```bash
origin plugin remove my-logger
```

---

## Git Proxy

Transparent git proxy for preserving attribution through rebases, amends, and cherry-picks.

### `origin proxy install`

Install git proxy wrapper. Creates `~/.origin/bin/git` that intercepts git commands.

```bash
origin proxy install
```

Kill switch: `touch ~/.origin/proxy-disabled`

### `origin proxy uninstall`

Remove the git proxy wrapper.

```bash
origin proxy uninstall
```

### `origin proxy status`

Show proxy installation status.

```bash
origin proxy status
```

---

## Maintenance Commands

### `origin doctor`

Scan for and fix stuck/orphaned sessions.

```bash
origin doctor                          # Scan only
origin doctor --fix                    # Auto-fix issues found
origin doctor --verbose                # Detailed diagnostics
```

| Flag | Description |
|------|-------------|
| `-f, --fix` | Auto-fix issues found |
| `-v, --verbose` | Show detailed diagnostic info |

Checks:
1. Stale session state in `.git/origin-session.json` (>24h old)
2. Orphaned session files
3. Hook installation health

---

### `origin reset`

Clear local session state for the current repo. Does NOT delete the `origin-sessions` branch, git notes, or remote data.

```bash
origin reset
origin reset --force                   # Force clear even if session looks active
```

| Flag | Description |
|------|-------------|
| `-f, --force` | Force clear even if session looks active |

---

### `origin clean`

Remove orphaned branches, stale sessions, temp files. Preview mode by default.

```bash
origin clean                           # Dry-run (default)
origin clean --force                   # Actually delete
origin clean --dry-run                 # Explicit dry-run
```

| Flag | Description |
|------|-------------|
| `--dry-run` | Show what would be cleaned without deleting |
| `-f, --force` | Skip confirmation and actually delete |

---

### `origin web`

Launch a local web dashboard for AI attribution, sessions, and prompts.

```bash
origin web                             # Default port 3141
origin web --port 8080
```

| Flag | Description |
|------|-------------|
| `-p, --port <n>` | Port number (default: `3141`) |

---

## Repository & Agent Management (Connected Mode)

### `origin repos`

List all connected repositories.

```bash
origin repos
```

### `origin repo:add`

Add a repository.

```bash
origin repo:add --name my-app --path /Users/me/projects/my-app
origin repo:add --name api --path /srv/api --provider github
```

| Flag | Description |
|------|-------------|
| `--name <name>` | Repository name (required) |
| `--path <path>` | Repository path (required) |
| `--provider <provider>` | Provider: `local` or `github` (default: `local`) |

### `origin sync`

Sync session data from the current repo to the Origin platform.

```bash
origin sync
```

### `origin agents`

List all registered AI coding agents.

```bash
origin agents
```

### `origin agent:create`

Register a new agent.

```bash
origin agent:create --name "Claude Coder" --slug claude-coder --model claude-sonnet-4-20250514
```

| Flag | Description |
|------|-------------|
| `--name <name>` | Agent name (required) |
| `--slug <slug>` | URL-safe slug (required) |
| `--model <model>` | AI model identifier (required) |
| `--description <desc>` | Optional description |

### `origin policies`

List all active governance policies.

```bash
origin policies
```

### `origin policy:versions <id>`

View version history for a specific policy.

```bash
origin policy:versions abc123
```

### `origin agent:versions <id>`

View version history for a specific agent.

```bash
origin agent:versions abc123
```

---

## Team & Notifications (Connected Mode)

### `origin team`

List team members with activity stats.

```bash
origin team
```

### `origin user <id>`

View a specific user's profile and recent activity.

```bash
origin user abc123
```

### `origin notifications`

View notifications.

```bash
origin notifications
origin notifications --unread
origin notifications --limit 50
```

| Flag | Description |
|------|-------------|
| `--unread` | Show only unread notifications |
| `-l, --limit <n>` | Max results (default: `20`) |

---

## Internal Hook Handlers

These are called automatically by agent hooks. Not intended for direct use.

```
origin hooks claude-code <event>       # Handle Claude Code hook event
origin hooks cursor <event>            # Handle Cursor hook event
origin hooks gemini <event>            # Handle Gemini CLI hook event
origin hooks codex <event>             # Handle Codex CLI hook event
origin hooks windsurf <event>          # Handle Windsurf hook event
origin hooks aider <event>             # Handle Aider hook event
origin hooks git-pre-commit            # Secret scanning
origin hooks git-post-commit           # Attribution tagging
origin hooks git-pre-push              # Session sync
origin hooks git-post-rewrite          # Preserve attribution through rebase/amend
origin hooks git-post-checkout         # Track branch switches
```

---

## How Attribution Works

### Git Notes

Every AI-authored commit gets a git note at `refs/notes/origin` containing:

```json
{
  "origin": {
    "sessionId": "abc123",
    "model": "claude-sonnet-4-20250514",
    "agent": "claude-code",
    "cost": 0.12,
    "tokens": 15000,
    "linesAdded": 42,
    "linesRemoved": 8
  }
}
```

### Commit Trailers

When `commitLinking` is set to `always`, Origin appends a trailer to commit messages:

```
Origin-Session: abc123
```

### Session Data

Full session transcripts (prompts, file changes, metadata) are stored on the `origin-sessions` orphan branch:

```
origin-sessions/
  sessions/
    <sessionId>/
      metadata.json       # Session metadata
      prompts.md          # Full prompt transcript
```

### AI Attribution Context (System Prompt Injection)

Origin injects context into AI agent system prompts so agents know what other agents have already done.

**Repo-level** (at session start):
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

The pre-commit hook blocks commits containing hardcoded secrets:

```
  AWS Access Key     config.env:3   AKIA****MPLE
  GitHub Token       src/api.ts:12  ghp_****ab12
  2 secrets found. Commit blocked.
```

Detects: AWS keys, GitHub/GitLab tokens, OpenAI/Anthropic/Stripe keys, JWTs, database connection strings, private keys, and `*_TOKEN=`/`*_SECRET=`/`*_KEY=` patterns.

---

## Data Storage

| Location | Purpose |
|----------|---------|
| `refs/notes/origin` | Per-commit AI metadata (model, session, cost, tokens) |
| `origin-sessions` branch | Session transcripts, prompts, file changes |
| `~/.origin/config.json` | CLI config (API URL, key, org) |
| `~/.origin/agent.json` | Agent config (machine ID, detected tools) |
| `~/.origin/git-hooks/` | Global hook scripts |
| `~/.origin/plugins.json` | Installed plugins |
| `~/.origin/db/` | Local SQLite prompt database |
| `.origin.json` | Per-repo config (agent link, ignore patterns) |

---

## Quick Reference

| Command | Description |
|---------|-------------|
| `origin login` | Authenticate with Origin |
| `origin init` | Initialize + install hooks |
| `origin enable` | Install hooks (--global, --agent) |
| `origin disable` | Remove hooks (--global) |
| `origin link [slug]` | Link repo to agent |
| `origin status` | Show system status |
| `origin whoami` | Show user/org info |
| `origin blame <file>` | Line-level AI/human attribution |
| `origin diff [range]` | Annotated diff with attribution |
| `origin stats` | AI vs human statistics |
| `origin compare <a> [b]` | Compare attribution between branches |
| `origin prompts <file>` | AI prompts that touched a file |
| `origin rework` | Detect reworked AI code |
| `origin backfill` | Retroactive AI tagging |
| `origin verify` | Health check |
| `origin sessions` | List sessions (--all, --status, --model) |
| `origin session <id>` | View session detail |
| `origin sessions end <id>` | End a running session |
| `origin explain [id]` | Explain a session |
| `origin ask <query>` | Ask about AI-authored code |
| `origin chat` | Interactive AI assistant |
| `origin resume [branch]` | Resume session from branch |
| `origin rewind` | Time travel to checkpoint |
| `origin review <id>` | Approve/reject/flag session |
| `origin review-pr <url>` | Analyze AI sessions in a PR |
| `origin intent-review` | Intent-based review |
| `origin share <id>` | Share a session |
| `origin snapshot` | Save working tree snapshot |
| `origin snapshot list` | List snapshots |
| `origin snapshot restore <id>` | Restore a snapshot |
| `origin snapshot clean` | Remove all snapshots |
| `origin search <query>` | Full-text search across prompts |
| `origin analyze` | Analyze prompting patterns |
| `origin report` | Sprint report |
| `origin audit` | Compliance audit trail |
| `origin export` | Export sessions (JSON/CSV/agent-trace) |
| `origin trail` | Branch work tracking |
| `origin config get/set/list` | Manage configuration |
| `origin db import` | Import prompts into local DB |
| `origin db stats` | Local database statistics |
| `origin ci check` | CI attribution report |
| `origin ci squash-merge <base>` | Preserve attribution in squash |
| `origin ci generate-workflow` | GitHub Actions YAML |
| `origin ignore` | Manage ignore patterns |
| `origin plugin list/install/remove` | Plugin management |
| `origin proxy install/uninstall/status` | Git proxy management |
| `origin doctor` | Diagnose and fix issues |
| `origin reset` | Clear local session state |
| `origin clean` | Remove orphaned data |
| `origin web` | Local web dashboard |
| `origin upgrade` | Upgrade CLI |
| `origin repos` | List repositories |
| `origin repo:add` | Add a repository |
| `origin sync` | Sync session data |
| `origin agents` | List agents |
| `origin agent:create` | Create an agent |
| `origin policies` | List policies |
| `origin policy:versions <id>` | Policy version history |
| `origin agent:versions <id>` | Agent version history |
| `origin team` | List team members |
| `origin user <id>` | View user detail |
| `origin notifications` | View notifications |
