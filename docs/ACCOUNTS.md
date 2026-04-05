# Account Types & Multi-Account Setup

Origin supports two account types: **Solo Developer** and **Team**. You can connect to both simultaneously.

---

## Account Types

### Solo Developer

For individual developers who want to track their own AI coding sessions.

- **Auto-creates repos** on first session (no pre-registration needed)
- **Auto-creates agents** when a new tool is detected
- **No scope restrictions** — all repos, all agents, no policies enforced
- **Full dashboard access** — see all your sessions, prompts, costs, file changes

Sign up at [getorigin.io/register](https://getorigin.io/register) as a Developer account. You'll get an API key immediately after registration.

```bash
origin login
# paste your dev API key
```

### Team

For organizations that need visibility and governance over AI coding across a team.

- **Repos must be registered** in the dashboard before sessions are accepted
- **Agents must be configured** with explicit API key permissions
- **Policies enforced** — model allowlists, cost limits, file restrictions, review requirements
- **API keys are scoped** — each key has access to specific repos and agents
- **Sessions rejected (403)** if the API key doesn't have permission for the repo or agent

Team accounts are created by an admin at [getorigin.io/register](https://getorigin.io/register) as an Organization account. API keys are created in **Settings > API Keys** with specific repo and agent scopes.

```bash
origin login --profile team
# paste your team API key
```

---

## Multi-Account Setup

Developers can connect to **both** a personal dev account and a team account simultaneously. Sessions are automatically routed:

- **Dev account** = always receives every session (your personal dashboard)
- **Team account** = receives a copy when the repo/agent is in the team's scope

This means:
- You always see all your sessions in your dev dashboard
- Your team admin also sees sessions on team repos in the team dashboard
- Personal repos only appear in your dev dashboard (team rejects them silently)

### Setup

```bash
# Step 1: Login with your dev account (becomes primary)
origin login
# paste your dev API key

# Step 2: Add team account as secondary
origin login --profile team
# paste your team API key
```

### Verify

```bash
origin status
```

You should see both accounts:

```
Accounts
  ● dev (solo) → Your Name's workspace
  ○ team (team) → Acme Corp
  Sessions sent to all accounts simultaneously
```

The `●` is your primary (dev), `○` is secondary (team).

### How Routing Works

On every session start:

1. CLI creates a session on your **dev account** (always succeeds for solo)
2. CLI tries to create a duplicate on the **team account**
   - If team accepts (repo is registered, agent is permitted) → session appears in both dashboards
   - If team rejects (403) → session only appears in dev dashboard
3. All subsequent updates (prompts, tokens, cost, file changes) go to both sessions

```
┌──────────────┐     ┌──────────────┐
│  Claude Code  │────▶│  Dev Account  │  ← always
│  (your repo)  │     │  (solo)       │
│               │────▶│  Team Account │  ← only if repo is in team scope
└──────────────┘     └──────────────┘
```

### Profiles

Profiles are stored in `~/.origin/profiles/`:

```
~/.origin/
  config.json          # primary account (used for CLI commands)
  profiles/
    dev.json           # dev profile
    team.json          # team profile
```

The primary config (`config.json`) is always your dev account. The CLI automatically creates profile files when you log in.

---

## For Team Admins

### Setting Up a Team Account

1. Register at [getorigin.io/register](https://getorigin.io/register) as an Organization
2. Go to **Settings > API Keys** and create a key for each developer
3. For each key, assign:
   - **Repos** — which repositories the key can create sessions for
   - **Agents** — which AI tools the key can use (Claude Code, Gemini, Codex, etc.)
4. Share the API key with the developer

### Agent Configuration

Agents must be created in the dashboard before team API keys can use them:

1. Go to **Agents > Add Agent**
2. Set the **slug** to match the tool name: `claude-code`, `gemini`, `codex`, `cursor`
3. Assign the agent to the relevant API keys

If a developer's session uses an agent not permitted by their API key, the session is rejected with:
```
403: Agent not permitted — This API key does not have access to agent "gemini"
```

### Repo Registration

Repos must be registered before team sessions are accepted:

1. Go to **Repos > Add Repo**
2. Enter the repo path or connect via GitHub
3. Assign the repo to the relevant API keys

Solo dev accounts skip this — repos are auto-registered on first session.

---

## Key Differences

| Feature | Solo Developer | Team |
|---------|---------------|------|
| Repo registration | Automatic | Manual (admin) |
| Agent creation | Automatic | Manual (admin) |
| API key scopes | No restrictions | Repo + Agent scopes |
| Policy enforcement | Skipped | Enforced |
| Session rejection | Never (always accepted) | 403 if out of scope |
| Dashboard access | Full (own sessions) | Scoped by role |
| Cost | Free | Free (self-hosted) |

---

## Troubleshooting

### Sessions appear in dev but not team

The team API key likely doesn't have permission for the repo or agent. Check:

```bash
origin status
```

Look at the Accounts section. If team shows `○`, it's connected but secondary. Check server logs or ask your team admin to verify:
- The repo is registered in the team dashboard
- The agent slug matches (e.g., `claude-code`, not `claude`)
- The API key has the repo and agent assigned

### "Agent not permitted" error

The team API key doesn't have access to the agent being used. The admin needs to:
1. Create the agent in **Agents** with the correct slug
2. Assign it to the API key in **Settings > API Keys**

### Sessions empty (no prompts/cost)

The API key may be invalid. Check:

```bash
origin status
```

If you see `API returned 401`, your key is dead. Re-login:

```bash
origin login          # dev key
origin login --profile team  # team key
```

### Both accounts showing same data

This is expected for team repos — both dev and team dashboards show the same session data. Personal repos only appear in dev.
