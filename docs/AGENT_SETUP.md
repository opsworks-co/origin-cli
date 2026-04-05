# Agent Setup Guide

Per-agent setup instructions for tracking AI coding sessions with Origin.

---

## Overview

Origin tracks sessions by installing hooks into your AI agent's configuration. The `origin enable` command auto-detects which agents are installed and configures them automatically.

```bash
origin enable          # Auto-detect and configure all found agents
origin enable --global # Install globally for all repos
```

Below are agent-specific details and any manual steps required.

---

## Claude Code

**Status:** Fully supported
**Hook type:** Session hooks (SessionStart, Stop, UserPromptSubmit, SessionEnd, PreToolUse, PostToolUse)
**Config file:** `~/.claude/settings.json`

### Setup

```bash
origin enable --agent claude-code
```

That's it. Origin writes hook entries to Claude Code's `settings.json`. Sessions are tracked automatically from the next Claude Code session.

### What's captured

- Full prompt/response transcript
- File reads and writes (PreToolUse/PostToolUse)
- Token counts (input + output) and cost
- Model name and session duration
- Commit SHAs linked to the session

### Verify

Start a Claude Code session and make a code change. Then:

```bash
origin sessions     # Should show the new session
origin status       # Should show "Active session"
```

---

## Cursor

**Status:** Fully supported
**Hook type:** Session hooks + Cursor DB integration
**Config file:** `~/.cursor/hooks.json`

### Setup

1. **Enable experimental hooks in Cursor:**
   - Open Cursor
   - Go to **Settings** (gear icon) > **Beta**
   - Enable **"Hooks"** (or "Experimental Hooks")

2. **Install Origin hooks:**

```bash
origin enable --agent cursor
```

> **Important:** Step 1 is required. Cursor's hook system is behind a feature flag. Without enabling it in Cursor's settings, Origin's hooks won't fire even though the config file is written.

### What's captured

- Prompt text submitted to the AI
- Session start/end timestamps
- Files changed during the session
- Partial token data (Cursor doesn't expose full token counts)
- Model name

### Verify

Open Cursor in a tracked repo, send a prompt, and check:

```bash
origin sessions
```

### Troubleshooting

If sessions aren't tracked after setup:
1. Confirm experimental hooks are enabled in Cursor settings
2. Check `~/.cursor/hooks.json` exists and contains Origin entries
3. Restart Cursor after enabling hooks
4. Check `~/.origin/hooks.log` for errors

---

## Codex CLI (OpenAI)

**Status:** Fully supported
**Hook type:** Session hooks (SessionStart, Stop, UserPromptSubmit)
**Config file:** `~/.codex/config.json`

### Setup

```bash
origin enable --agent codex
```

Automatic — no manual steps required.

### What's captured

- Prompts and responses
- Session timing
- Files changed
- Model name

### Verify

```bash
codex "add a hello world endpoint"
origin sessions
```

---

## Gemini CLI

**Status:** Fully supported
**Hook type:** Session hooks (SessionStart, SessionEnd, BeforeAgent, AfterAgent)
**Config file:** `~/.gemini/settings.json`

### Setup

```bash
origin enable --agent gemini
```

Automatic — no manual steps required.

### What's captured

- Full prompt/response transcript
- Token counts and cost
- Session timing and duration
- Files changed
- Model name

### Verify

```bash
gemini    # Start a Gemini CLI session
# ... make a code change
origin sessions
```

---

## Windsurf

**Status:** Coming soon
**Hook type:** Session hooks
**Config file:** `~/.windsurf/hooks.json`

### Setup

```bash
origin enable --agent windsurf
```

Hook config is written but session tracking may be limited while Windsurf's hook API is still in development.

---

## Aider

**Status:** Coming soon
**Hook type:** Config hooks (`.aider.conf.yml`)
**Config file:** `~/.aider.conf.yml`

### Setup

```bash
origin enable --agent aider
```

Aider uses a different hook mechanism (config-based notifications). Session tracking support is in progress.

---

## Global vs. per-repo hooks

### Global hooks (recommended)

```bash
origin enable --global
```

Installs hooks in your home directory (`~/`). Every repo you work in is automatically tracked. This is the recommended setup — no per-repo configuration needed.

### Per-repo hooks

```bash
cd /path/to/your/repo
origin enable
```

Installs hooks only for the current repo. You need to run this in each repo you want to track.

### Linking repos to specific agents

If you want a repo's sessions to be attributed to a specific Origin agent:

```bash
origin link my-agent-slug
```

This writes a `.origin.json` file in the repo root that maps the repo to the agent. Without this, Origin auto-detects which agent is running via process detection.

---

## Hook chaining

By default, Origin preserves any existing hooks and chains them — your existing hooks still run before Origin's. To replace existing hooks instead:

```bash
origin enable --no-chain
```

---

## Removing hooks

```bash
origin disable          # Remove from current repo
origin disable --global # Remove global hooks
```

This removes Origin's entries from all agent config files and git hooks.

---

## Verifying setup

After setup, run a quick health check:

```bash
origin doctor --verbose
```

This checks:
- Hook configs are present and valid
- API connectivity (connected mode)
- No stale sessions or orphaned state
- Hooks log is healthy

To auto-fix any issues found:

```bash
origin doctor --fix
```
