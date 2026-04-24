<p align="center">
  <img src="https://getorigin.io/favicon.svg" width="80" alt="Origin Logo" />
</p>

<h1 align="center">Origin CLI</h1>

<p align="center">
  <strong>Every agent. Every prompt. Every line. In your git repo.</strong><br/>
  <em>The AI coding history layer for developers and teams.</em>
</p>

<p align="center">
  <a href="https://github.com/dolobanko/origin-cli/blob/main/LICENSE"><img src="https://img.shields.io/badge/license-MIT-green" alt="License"></a>
  <a href="https://getorigin.io"><img src="https://img.shields.io/badge/web-getorigin.io-6366f1" alt="Website"></a>
</p>

---

Origin runs silently next to any AI coding agent — Claude Code, Cursor, Codex,
Gemini CLI, Aider, Windsurf, Copilot, and more — and captures every session:
prompts, files touched, tokens, cost, diffs. All of it lives in your git repo as
notes and refs. `git clone` brings the history with the code. No server, no
login, no API keys required.

## Install

```bash
npm i -g https://getorigin.io/cli/origin-cli-latest.tgz
```

## Quick start

```bash
origin init                     # auto-detect agents, install git hooks
# ...code with any AI agent — Origin tracks automatically
origin blame src/index.ts       # see which AI wrote each line
```

That's it. Nothing to configure.

---

## The four beats

Origin maps to one idea per verb. Everything else is detail.

### 01 — Every agent.

Auto-detected. Claude Code, Cursor, Codex, Gemini CLI, Aider, Windsurf, Copilot,
Continue, Cody, Cline, Codeium, Roo, Kilo. One command picks up whichever tool
you use.

```bash
origin init           # detect agents + install hooks
origin agents         # list detected agents
origin status         # show the active session
```

### 02 — Every prompt.

Each turn is captured as a snapshot: prompt text, model, files touched, diff,
tokens, cost, duration.

```bash
origin snapshot       # list per-prompt snapshots in the current session
origin sessions       # list all sessions
origin session <id>   # replay a single session
origin rewind --to <sha>   # restore working tree to any snapshot
```

### 03 — Every line.

Line-level attribution across agents and sessions. Point at any line, get the
exact prompt that wrote it.

```bash
origin blame <file>          # per-line AI/human + model per line
origin why <file>:<line>     # the exact prompt behind one line
origin diff                  # annotated diff, AI vs human
origin search "auth bug"     # full-text search across prompts
```

### 04 — In your git repo.

Nothing leaves your machine. Sessions live in `refs/notes/origin` and the
`origin-sessions` branch. Clone the repo, clone the history.

```
refs/notes/origin          per-commit model / session / cost / tokens
origin-sessions            transcripts, prompts, file changes
~/.origin/config.json      CLI config (machine-local)
```

No telemetry by default. Opt in with `origin config set telemetry true`.

---

## Supported agents

**Shipping:** Claude Code · Cursor · Codex CLI · Gemini CLI · Windsurf
**In development:** Aider · GitHub Copilot · Cody · Continue · Codeium · Cline

Detection runs on CLI availability, IDE extension inspection, MCP config, and
process detection at commit time.

---

## More commands

The CLI has 50+ commands covering review, governance, handoff, memory, TODOs,
time travel, reports, audit, and CI integration. See [`DOCS.md`](./DOCS.md) or
run `origin --help`.

Commonly used beyond the four beats:

```bash
origin stats                 # AI vs human stats for the repo
origin handoff show          # pass context to the next agent
origin recap                 # end-of-day summary
origin backfill --apply      # retroactively tag old commits
origin policies              # list active governance policies
origin doctor                # diagnose stuck sessions
origin upgrade               # update to latest
```

---

## For teams

[getorigin.io](https://getorigin.io) adds the team layer on top of the CLI:
live dashboard, per-user cost attribution, model and budget policies, PR
compliance checks, audit trails, and GitHub App / Slack integrations. Free for
solo developers, $29/user/month for teams.

```bash
origin login      # authenticate with your Origin instance
origin init       # register the machine + install hooks
```

---

## License

MIT
