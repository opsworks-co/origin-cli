# Getting Started with Origin

Get from zero to your first tracked AI coding session in under 5 minutes.

---

## Prerequisites

- **Node.js 18+** installed
- An AI coding agent installed (Claude Code, Cursor, Codex CLI, or Gemini CLI)
- A GitHub account (for PR checks — optional for local-only use)

---

## Step 1: Install the CLI

```bash
npm i -g https://getorigin.io/cli/origin-cli-latest.tgz
```

Verify:

```bash
origin --version
```

---

## Step 2: Log in to Origin

```bash
origin login
```

You'll be prompted for:
- **Origin API URL** — press Enter to accept the default (`https://getorigin.io`)
- **API Key** — get this from your Origin dashboard: **Settings > API Keys > Create Key**

> **Don't have an account yet?** Sign up free at [getorigin.io/register](https://getorigin.io/register). No credit card required.

Origin has two account types:
- **Solo Developer** — for personal use. No restrictions, auto-creates repos and agents.
- **Team** — for organizations. Repos and agents must be pre-configured by an admin.

If you belong to a team AND have a personal account, you can connect both:

```bash
origin login                    # your dev account
origin login --profile team     # your team account
```

Sessions on team repos appear in both dashboards. Personal repos only appear in your dev dashboard. See [ACCOUNTS.md](./ACCOUNTS.md) for full details.

---

## Step 3: Initialize your machine

```bash
origin init
```

This does three things:
1. Detects which AI coding agents are installed on your machine (Claude Code, Cursor, Gemini, Codex, etc.)
2. Registers your machine with your Origin org
3. Installs global hooks so all repos are tracked automatically

---

## Step 4: Enable hooks

```bash
origin enable
```

This installs session-tracking hooks into your AI agents' config files. Origin now captures every AI coding session automatically — prompts, file changes, token usage, and costs.

What gets configured:

| Agent | Config File |
|-------|-------------|
| Claude Code | `~/.claude/settings.json` |
| Cursor | `~/.cursor/hooks.json` |
| Codex CLI | `~/.codex/config.json` |
| Gemini CLI | `~/.gemini/settings.json` |

> **Tip:** Use `origin enable --global` to install hooks globally so every repo on your machine is tracked without per-repo setup.

---

## Step 5: Code with your AI agent

Open any project and start a coding session with your AI agent as you normally would. Origin runs silently in the background.

For example, open Claude Code and ask it to make a change:

```
> Add input validation to the user registration endpoint
```

Origin automatically:
- Detects the session starting
- Captures each prompt and response
- Tracks which files were changed and by which prompt
- Records token usage and cost
- Writes attribution metadata to git notes

---

## Step 6: View your session

### From the CLI

```bash
# List recent sessions
origin sessions

# View a specific session with full details
origin session <id>

# See line-by-line AI/human attribution
origin blame src/index.ts

# View AI vs human stats for the repo
origin stats
```

### From the dashboard

Open [getorigin.io/dashboard](https://getorigin.io/dashboard) to see:
- All coding sessions across your team
- Per-session cost, token count, files changed
- Review and approve sessions
- AI blame view with line-level attribution

---

## What's next?

Now that sessions are being tracked, here's how to get more value from Origin:

### Connect GitHub for PR checks
Go to **Settings > Integrations** and install the Origin GitHub App. Origin will post governance status checks on every PR, showing which commits were AI-authored and whether they comply with your policies. See [GITHUB_CHECKS.md](./GITHUB_CHECKS.md) for details.

### Create your first policy
Go to **Policies > Add Policy** to set up governance rules:
- **REQUIRE_REVIEW** — Block PRs until a human approves the AI session
- **COST_LIMIT** — Block PRs if a session cost exceeds a threshold
- **FILE_RESTRICTION** — Block AI from modifying sensitive files
- **MODEL_ALLOWLIST** — Only allow approved AI models

See [POLICIES.md](./POLICIES.md) for the full policy reference.

### Set up per-agent tracking
Register your AI agents in **Agents > Add Agent** to track usage per agent and apply agent-specific policies. See [AGENT_SETUP.md](./AGENT_SETUP.md) for per-agent instructions.

### Invite your team
Go to **Settings > Team** to invite other developers. Each person installs the CLI on their machine and runs `origin login` + `origin init`.

---

## Quick reference

| Task | Command |
|------|---------|
| Install CLI | `npm i -g https://getorigin.io/cli/origin-cli-latest.tgz` |
| Log in | `origin login` |
| Initialize machine | `origin init` |
| Enable hooks | `origin enable` |
| Check status | `origin status` |
| List sessions | `origin sessions` |
| View session detail | `origin session <id>` |
| Line-level blame | `origin blame <file>` |
| AI vs human stats | `origin stats` |
| Diagnose issues | `origin doctor` |
| Upgrade CLI | `origin upgrade` |

---

## Standalone mode (no server)

Don't want to use the Origin platform? The CLI works fully offline:

```bash
origin enable --global    # Enable hooks (no login needed)
# ... code with AI agents
origin blame src/file.ts  # Line-level attribution
origin stats              # AI vs human breakdown
origin sessions           # List all sessions
```

All data is stored locally in git notes and the `origin-sessions` branch. No account, no API keys, no server.

---

## Troubleshooting

See [TROUBLESHOOTING.md](./TROUBLESHOOTING.md) for common issues and fixes.
