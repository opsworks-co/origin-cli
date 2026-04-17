# Origin Solo

Origin Solo is the free, unrestricted version of Origin for individual developers. Track every AI coding session, see exactly what your AI agents wrote, and get full visibility into cost and token usage — for free, forever.

---

## What You Get

- **Unlimited repos** — every repo you work in is auto-registered on first session
- **Unlimited sessions** — no caps, no throttling
- **All AI agents** — Claude Code, Cursor, Gemini CLI, Codex, Windsurf, Aider, and 7 more. Auto-detected.
- **Full session replay** — every prompt, every response, every file change
- **Per-prompt diffs** — see exactly which prompt caused which code changes
- **Snapshots** — per-prompt checkpoints you can restore or branch from with one click
- **Token & cost tracking** — know how much each session costs across models
- **CLI attribution tools** — `origin blame`, `origin diff`, `origin stats`, `origin log`, `origin show <sha>`
- **Cross-agent handoff** — `origin context` passes state between Claude, Cursor, and any other agent
- **Web dashboard** — visual session browser at [getorigin.io](https://getorigin.io)
- **Multi-account** — connect to a team account too, if you belong to one

---

## Quick Start

### 1. Register

Go to [getorigin.io/register](https://getorigin.io/register) and sign up as a **Developer** account. You'll see your API key immediately after registration — copy it.

### 2. Install & Login

```bash
npm i -g https://getorigin.io/cli/origin-cli-latest.tgz
origin login
# paste your API key
```

### 3. Initialize

```bash
origin init
```

This detects your AI tools, registers your machine, and installs hooks.

### 4. Code

Open any AI coding agent and start working. Origin tracks everything automatically in the background. No per-repo setup needed.

### 5. See Your Data

**CLI:**
```bash
origin sessions              # list recent sessions
origin session <id>          # full session with prompts and diffs
origin log                   # git log with AI session info inline
origin show <sha>            # full session behind any commit
origin blame src/index.ts    # line-level AI/human attribution
origin stats                 # AI vs human breakdown
origin diff                  # annotated diff
origin context               # cross-agent handoff + memory
```

**Dashboard:**
Open [getorigin.io](https://getorigin.io) to browse sessions visually. Key pages:

- **Dashboard** — cost, sessions, AI % this week vs last
- **Snapshots** — every AI prompt as a checkpoint, with restore + branch + compare
- **Live Feed** — real-time view of active AI sessions
- **Repositories** — per-repo AI attribution and commit history
- **Insights** — deep analytics on models, peak hours, rework hotspots

---

## How It Works

When you code with an AI agent, Origin's hooks fire automatically:

1. **Session start** — registers the session with your dashboard
2. **Each prompt** — captures the prompt text, tracks token usage, records cost
3. **Each tool use** — records file reads, writes, and shell commands
4. **Session end** — captures the final diff, total cost, and transcript

All data flows to your personal dashboard. Nothing is shared with anyone unless you also connect to a team account.

### What Gets Tracked

| Data | Example |
|------|---------|
| Prompts | "Add input validation to the signup form" |
| Model | claude-opus-4-6, gemini-2.5-pro, gpt-4.1 |
| Tokens | Input: 1,200 / Output: 3,400 / Cache: 12,000 |
| Cost | $0.42 |
| Files changed | src/auth.ts, src/validators.ts |
| Per-prompt diffs | Which prompt changed which files |
| Duration | 4m 32s |
| Agent | claude-code, gemini, codex |
| Repo & branch | origin-v2 @ feature/auth |

### What Doesn't Get Tracked

- Your code is never uploaded to Origin servers
- File contents are not stored — only file names and diffs
- Prompts can be redacted with `secretRedaction: true` in config

---

## Solo vs Team

| | Solo | Team |
|---|---|---|
| Price | Free forever | $29/user/month |
| Repos | Auto-created | Must be registered |
| Agents | Auto-created | Must be configured |
| API key scopes | None (unrestricted) | Per-repo, per-agent |
| Policies | None | Enforced |
| PR checks | None | GitHub/GitLab |
| Dashboard | Your sessions only | Team-wide view |
| Users | 1 | Up to 25 |

**You don't need Team to get value from Origin.** Solo gives you complete session tracking. Team adds governance — use it when your org needs visibility and control over AI coding across the team.

---

## Multi-Account (Solo + Team)

If you belong to a team, you can connect to both your Solo account and the team account:

```bash
origin login                    # your solo account (primary)
origin login --profile team     # team account (secondary)
```

How it works:
- **Every session** goes to your Solo dashboard (you always see your data)
- **Team repo sessions** also go to the team dashboard (if the team accepts them)
- **Personal repo sessions** only go to Solo (team silently rejects them)

Check your setup:
```bash
origin status
```

```
Accounts
  ● dev (solo) → Your workspace
  ○ team (team) → Acme Corp
  Sessions sent to all accounts simultaneously
```

---

## Configuration

Config is stored in `~/.origin/config.json`:

```json
{
  "apiUrl": "https://getorigin.io",
  "apiKey": "org_sk_...",
  "keyType": "solo",
  "accountType": "developer"
}
```

### Optional Settings

| Setting | Default | Description |
|---------|---------|-------------|
| `secretRedaction` | `true` | Redact secrets (API keys, tokens) from prompts before sending |
| `secretScan` | `true` | Pre-commit hook blocks commits containing hardcoded secrets |
| `commitLinking` | `always` | Link git commits to sessions automatically |
| `mode` | `auto` | Set to `standalone` to force local-only mode even when logged in |

---

## Standalone Mode (No Server)

Don't want to use the Origin platform at all? The CLI works fully offline:

```bash
origin enable --global    # install hooks (no login needed)
# ... code with AI agents
origin blame src/file.ts  # line-level attribution
origin stats              # AI vs human breakdown
origin sessions           # list all sessions (stored locally)
origin web                # local dashboard in the browser
```

All data is stored in git notes (`refs/notes/origin`) and the `origin-sessions` branch. No account, no API keys, no server.

---

## CLI Commands Reference

| Command | Description |
|---------|-------------|
| `origin sessions` | List recent AI coding sessions |
| `origin session <id>` | Full session detail with prompts, cost, files |
| `origin blame <file>` | Line-level AI/human attribution |
| `origin stats` | AI vs human commit/line breakdown |
| `origin diff` | Annotated diff with AI/human tags |
| `origin prompts <file>` | AI prompts that touched a file |
| `origin search <query>` | Search all AI prompt history |
| `origin chat` | Interactive AI assistant for code questions |
| `origin web` | Local browser dashboard |
| `origin status` | Connection status, accounts, active session |
| `origin doctor` | Diagnose issues |
| `origin upgrade` | Update CLI to latest version |

---

## Troubleshooting

### Sessions not appearing in dashboard

1. Check connection: `origin status` — should show "Connected - Solo Developer"
2. Check hooks: `origin doctor` — should show all hooks installed
3. Check logs: `tail -20 ~/.origin/hooks.log` — look for errors

### "Invalid API key"

Your key expired or was regenerated. Re-login:
```bash
origin login
```

### Hooks not firing

Make sure hooks are enabled:
```bash
origin enable --global
```

For Claude Code, verify in `~/.claude/settings.json` that hooks are configured.

### Cost showing $0

Token usage is estimated from the transcript. If the session has no transcript (e.g., very short session), cost may show as zero.

---

## FAQ

**Is Solo really free?**
Yes. No limits, no trial period, no credit card. Free forever.

**What data do you store?**
Prompts, token counts, cost, file names changed, diffs, and session metadata. We do not store your source code.

**Can I export my data?**
All session data is also stored locally in git (`origin-sessions` branch). You always have a local copy.

**Do I need to set up each repo?**
No. Solo auto-registers repos on first session. Just code — Origin handles the rest.

**What if I want to add my team later?**
Sign up for a Team account and add it as a secondary profile. Your Solo account keeps working alongside it.
