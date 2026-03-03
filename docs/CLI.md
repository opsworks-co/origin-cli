# CLI Reference

The `origin` CLI gives you full command-line access to the Origin platform — manage sessions, agents, repos, policies, and more.

---

## Installation

```bash
# From the repo:
cd /path/to/origin-v2/packages/cli
pnpm install && pnpm build

# Run:
node dist/index.js <command>

# Or alias it:
alias origin="node /path/to/origin-v2/packages/cli/dist/index.js"
```

---

## Setup Commands

### `origin login`

Authenticate with your Origin instance.

```bash
origin login
```

Prompts for:
- **Origin API URL** — e.g. `http://localhost:4002`
- **API Key** — from Settings > API Keys

Saves credentials to `~/.origin/config.json`.

---

### `origin init`

Register this machine as an agent host in Origin.

```bash
origin init
```

- Detects installed AI coding tools (claude, cursor, aider, gemini)
- Registers the machine with your org
- Prints step-by-step MCP server setup instructions for each detected tool

Run this once on every machine where engineers use AI coding agents.

---

### `origin status`

Show connection and registration status.

```bash
origin status
```

---

### `origin whoami`

Show current user and machine info.

```bash
origin whoami
```

---

## Session Commands

### `origin sessions`

List AI coding sessions with optional filters.

```bash
origin sessions
origin sessions --status unreviewed
origin sessions --model claude-sonnet-4-20250514 --limit 10
```

Options:
- `-s, --status <status>` — Filter: `unreviewed`, `approved`, `rejected`, `flagged`
- `-m, --model <model>` — Filter by AI model
- `-l, --limit <n>` — Max results (default: 20)

---

### `origin session <id>`

View full details of a specific session.

```bash
origin session abc123
```

Shows: model, repo, commit, agent, tokens, cost, duration, tool calls, lines changed, files changed, and review status.

---

### `origin review <sessionId>`

Approve, reject, or flag a coding session.

```bash
origin review abc123 --approve
origin review abc123 --reject --note "Uses deprecated API"
origin review abc123 --flag --note "Needs security review"
```

Options:
- `--approve` — Mark session as approved
- `--reject` — Mark session as rejected
- `--flag` — Flag for further review
- `-n, --note <note>` — Optional review note

---

## Repository Commands

### `origin repos`

List all connected repositories.

```bash
origin repos
```

Shows: name, provider, commit count, sync status, path.

---

### `origin repo:add`

Add a new repository.

```bash
origin repo:add --name my-app --path /Users/me/projects/my-app
origin repo:add --name api --path /srv/api --provider github
```

Options:
- `--name <name>` — Repository name (required)
- `--path <path>` — Repository path (required)
- `--provider <provider>` — Provider: `local` or `github` (default: local)

---

### `origin sync`

Sync AI session data from the current git repo to Origin.

```bash
cd /path/to/your/repo
origin sync
```

Reads `.entire/` checkpoint files and uploads them to Origin.

---

## Agent Commands

### `origin agents`

List all registered AI coding agents.

```bash
origin agents
```

Shows: name, model, status (ACTIVE/INACTIVE), session count.

---

### `origin agent:create`

Register a new agent.

```bash
origin agent:create --name "Claude Coder" --slug claude-coder --model claude-sonnet-4-20250514
origin agent:create --name "GPT Worker" --slug gpt-worker --model gpt-4o --description "Frontend tasks"
```

Options:
- `--name <name>` — Agent name (required)
- `--slug <slug>` — URL-safe slug (required)
- `--model <model>` — AI model identifier (required)
- `--description <desc>` — Optional description

---

## Policy Commands

### `origin policies`

List all active governance policies.

```bash
origin policies
```

Shows: policy name, type, description, rules, enforcement status.

---

### `origin policy:versions <id>`

View version history for a specific policy.

```bash
origin policy:versions abc123
```

Shows: version number, change type (CREATED, UPDATED, RULE_ADDED, etc.), and timestamp.

---

### `origin agent:versions <id>`

View version history for a specific agent.

```bash
origin agent:versions abc123
```

Shows: version number, change type, and timestamp.

---

## Notification Commands

### `origin notifications`

View your notifications.

```bash
origin notifications
origin notifications --unread
origin notifications -l 50
```

Options:
- `--unread` — Show only unread notifications
- `-l, --limit <n>` — Max results (default: 20)

Shows: unread indicator (●), title, message, and timestamp.

---

## Monitoring Commands

### `origin stats`

View dashboard statistics.

```bash
origin stats
```

Shows:
- Sessions this week
- Active agents
- AI authorship percentage
- Total tokens used
- Estimated cost this month
- Lines written
- Unreviewed sessions count
- Policy violations
- Cost breakdown by model
- Top agents

---

### `origin audit`

View the audit log.

```bash
origin audit
origin audit --action AGENT_CREATED --limit 50
```

Options:
- `-a, --action <action>` — Filter by action type (e.g. `AGENT_CREATED`, `POLICY_UPDATED`, `SESSION_REVIEWED`)
- `-l, --limit <n>` — Max entries (default: 30)

---

## Config File

Stored at `~/.origin/config.json`:

```json
{
  "apiUrl": "http://localhost:4002",
  "apiKey": "org_sk_...",
  "orgId": "uuid",
  "userId": "uuid",
  "machineId": "uuid"
}
```

Delete this file to log out.

---

## All Commands

| Command | Description |
|---------|-------------|
| `origin login` | Authenticate with Origin |
| `origin init` | Register machine as agent host |
| `origin status` | Show connection status |
| `origin whoami` | Show user and org info |
| `origin sessions` | List coding sessions |
| `origin session <id>` | View session detail |
| `origin review <id>` | Approve/reject/flag session |
| `origin repos` | List repositories |
| `origin repo:add` | Add a repository |
| `origin sync` | Sync session data from repo |
| `origin agents` | List agents |
| `origin agent:create` | Create a new agent |
| `origin policies` | List active policies |
| `origin policy:versions <id>` | View policy version history |
| `origin agent:versions <id>` | View agent version history |
| `origin notifications` | View notifications |
| `origin stats` | View dashboard statistics |
| `origin audit` | View audit log |
