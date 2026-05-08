# Troubleshooting

Common issues and how to fix them.

---

## Session not showing up

Your AI coding session doesn't appear in `origin sessions` or the dashboard.

### Check the hooks log

```bash
tail -100 ~/.origin/hooks.log
grep "ERROR" ~/.origin/hooks.log | tail -20
```

The hooks log records every event (session start, prompt, stop, end). Errors here usually explain what went wrong.

### Check that hooks are installed

```bash
origin status
```

If it says hooks aren't installed, run:

```bash
origin enable
```

### Check API key permissions

Your API key must have access to the repository you're working in. If the key is scoped to specific repos or agents, sessions outside that scope are silently dropped.

Go to **Settings > API Keys** in the dashboard and verify the key's scopes include the repo and agent you're using.

### Check that the agent is detected

```bash
origin status
```

Look for the "Agents detected" line. If your agent isn't listed, Origin can't track its sessions.

### Session tracked locally but not on server

If `origin sessions` shows the session locally but it's not in the dashboard:

```bash
origin whoami    # Verify you're logged in
origin status    # Check API connection health
```

If connected, the session may have failed to sync. Check the hooks log for API errors:

```bash
grep "api.*ERROR\|401\|403\|500" ~/.origin/hooks.log | tail -10
```

---

## "Invalid API key"

### Re-authenticate

```bash
origin login
```

Enter your current API URL and a valid API key from **Settings > API Keys**.

### Verify authentication

```bash
origin whoami
```

If this shows an error, your key is expired or revoked. Generate a new one from the dashboard.

### Check for environment override

If you have `ORIGIN_API_KEY` set as an environment variable, it overrides the config file:

```bash
echo $ORIGIN_API_KEY
```

Clear it or update it to the correct key.

---

## "0 machines showing"

The Machines page in the dashboard shows no registered machines.

### Register your machine

```bash
origin enable
```

This detects installed AI agents and registers the machine with your Origin org.

### Verify registration

```bash
origin whoami
```

Look for the "Machine" line. If it shows a machine ID, you're registered.

### Check that you're logged in to the right org

```bash
origin whoami
```

Verify the Org ID matches the org you're looking at in the dashboard. If you have multiple orgs, you may be logged into the wrong one.

---

## Session showing $0.00 cost

### Standalone mode

In standalone mode (no server), Origin doesn't have access to API billing data, so costs show as $0.00. This is expected.

To get cost tracking, switch to connected mode:

```bash
origin login
origin enable
```

### Connected mode — agent doesn't report cost

Some agents don't expose token counts or costs in their hook events. Origin estimates costs based on model pricing when token data is available, but if the agent doesn't report tokens, cost will be $0.00.

Claude Code and Gemini CLI report full token data. Cursor reports partial data.

---

## Hooks not firing

AI agent sessions aren't being tracked at all.

### Reinstall hooks

```bash
origin enable
```

Or for global hooks (all repos):

```bash
origin enable --global
```

### Run the diagnostic

```bash
origin doctor --verbose
```

This checks for:
- Missing or broken hook configs
- Stale session state
- Orphaned processes
- API connectivity issues
- Hook log errors

To auto-fix issues:

```bash
origin doctor --fix
```

### Check agent-specific config

Each agent stores hooks in a different config file:

| Agent | Config file to check |
|-------|---------------------|
| Claude Code | `~/.claude/settings.json` |
| Cursor | `~/.cursor/hooks.json` |
| Codex CLI | `~/.codex/config.json` |
| Gemini CLI | `~/.gemini/settings.json` |

Verify the file exists and contains Origin hook entries. If it's missing or empty, run `origin enable` again.

### Cursor-specific: experimental hooks

Cursor requires experimental hooks to be enabled in Cursor's settings. See [AGENT_SETUP.md](./AGENT_SETUP.md) for Cursor-specific setup.

---

## Session stuck in RUNNING state

### Auto-fix with doctor

```bash
origin doctor --fix
```

This ends stuck sessions (>1hr old) both locally and on the server.

### Manually end a session

```bash
origin sessions end <id>
```

### End all stale sessions

```bash
origin sessions clean       # Current repo
origin sessions clean --all # All repos
```

### Check for orphaned heartbeats

```bash
ls ~/.origin/heartbeats/
```

If there are old heartbeat files, `origin doctor --fix` will clean them up.

---

## GitHub PR check not appearing

### Verify GitHub App is connected

Go to **Settings > Integrations** in Origin. The GitHub App should show as connected with your org name.

### Verify the repo is imported

Go to **Repositories** and check that the repo is listed. If not, import it.

### Check webhooks

Origin receives `push` and `pull_request` events via webhooks. If the GitHub App is installed but checks aren't appearing:

1. Go to your GitHub org's Settings > GitHub Apps > Origin > Advanced
2. Check "Recent deliveries" for failed webhook deliveries
3. Look for 4xx or 5xx responses

### No sessions linked to the PR

If Origin posts "0 sessions detected" but you used an AI agent, the commits aren't matching to sessions. This usually means:
- The developer didn't have Origin CLI running during the session
- The commits were amended or rebased after the session (SHA mismatch)
- The API key used during the session didn't have access to the repo

---

## "Permission denied" errors in hooks

### macOS

If you see permission errors when hooks fire:

```bash
chmod +x ~/.origin/git-hooks/*
```

### Check CLI is accessible

The hook scripts call the `origin` binary. Verify it's in your PATH:

```bash
which origin
```

If it's not found, reinstall:

```bash
npm i -g https://getorigin.io/cli/origin-cli-latest.tgz
```

---

## Getting help

```bash
# Full system diagnostic
origin doctor --verbose

# Check connection and auth
origin whoami
origin status

# View recent hook activity
tail -50 ~/.origin/hooks.log

# Check for errors
grep "ERROR" ~/.origin/hooks.log | tail -20
```

If the issue persists, contact support with the output of `origin doctor --verbose` and the last 50 lines of `~/.origin/hooks.log`.
