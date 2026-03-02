# CLI Reference

The `origin` CLI registers your machine with Origin and gives you command-line access to your org's policies and sessions.

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

## Commands

### `origin login`

Authenticate with your Origin instance.

```bash
origin login
```

Prompts for:
- **Origin API URL** — e.g. `http://localhost:4002`
- **API Key** — from Settings → API Keys

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

Output:
```
✅ Connected to http://localhost:4002
✅ Logged in as artem@origin.dev (Acme Corp)
✅ Machine registered: artems-mac
   Tools detected: claude-code, cursor
   Active policies: 5
   MCP server: configured
```

---

### `origin policies`

List all active policies for your org.

```bash
origin policies
```

Output:
```
Active policies (5):

  1. Protect payments module [FILE_RESTRICTION]
     Block AI from modifying src/payments/**
     Enforced via MCP ●

  2. Review infrastructure changes [REQUIRE_REVIEW]
     Flag any changes to infra/** for human review
     Enforced via MCP ●

  3. Approved models only [MODEL_ALLOWLIST]
     Only claude-code and cursor are approved
     Enforced via MCP ●
```

---

### `origin sync`

Sync AI session data from the current git repo to Origin.

```bash
cd /path/to/your/repo
origin sync
```

Reads `.entire/` checkpoint files from the repo and uploads them to Origin. Use this if you're using Entire.io to capture sessions and want to see them in the Origin dashboard.

---

### `origin whoami`

Show current user and machine info.

```bash
origin whoami
```

Output:
```
User:    Artem Dolobanko (artem@origin.dev)
Org:     Acme Corp
Role:    OWNER
Machine: artems-mac (machine-001)
Tools:   claude-code, cursor
```

---

## Config file

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
