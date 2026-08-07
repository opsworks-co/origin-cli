<p align="center">
  <img src="https://getorigin.io/favicon.svg" width="80" alt="Origin Logo" />
</p>

<h1 align="center">Origin CLI</h1>

<p align="center">
  <strong>Every agent. Every prompt. Every line. In your git repo.</strong><br/>
  <em>The AI coding history layer for developers and teams.</em>
</p>

<p align="center">
  <a href="https://github.com/opsworks-co/origin-cli/blob/main/LICENSE"><img src="https://img.shields.io/badge/license-MIT-green" alt="License"></a>
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
origin enable                     # auto-detect agents, install git hooks
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
origin enable           # detect agents + install hooks
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
refs/notes/origin              per-commit model / session / cost / tokens
refs/notes/origin-memory       cross-session memory (what past sessions did)
refs/notes/origin-repo-brief   repo brief (what this repo is) — opt-in
origin-sessions                transcripts, prompts, file changes
~/.origin/config.json          CLI config (machine-local)
```

No telemetry by default. Opt in with `origin config set telemetry true`.

---

## Memory that follows the repo

Agents forget everything between sessions. Origin gives them a memory that lives
in the repo — so the next agent (any agent) starts where the last one left off.
Two layers, both stored as git notes, both travelling with `git clone`:

**Session memory** — *what past sessions did.* On session end (or on every
commit — your choice), Origin writes a compact entry per session to
`refs/notes/origin-memory`: summary, files touched, open TODOs. At the next
session start it distills these into a short brief — recent changes, frequently
touched files, carried-over TODOs — and injects it into the new agent's context.
100% local, no LLM, no server.

```bash
origin context memory                      # what previous sessions did here
origin config set memoryUpdate commit      # refresh memory on every commit
                                           #   (default: session-end · also: both)
origin context clear --memory-only         # wipe it
```

**Repo brief** — *what this repo is.* Opt-in. A one-time, cached LLM summary of
the repo's purpose, architecture, entry points, and gotchas, injected at session
start so an agent is oriented before its first prompt. Generating it sends a
bounded bundle (README, manifests, file tree, recent commit subjects) to
Anthropic using your own key; the result is cached in
`refs/notes/origin-repo-brief` and only regenerated when the repo drifts.

```bash
origin context brief --enable     # turn it on for this repo
origin context brief              # show the cached brief
origin context brief --refresh    # regenerate now (uses your Anthropic key)
```

Session memory is on by default and never leaves your machine. The repo brief is
the only piece that calls an external service, and only after you enable it.

---

## Supported agents

**Full session capture (native hooks):** Claude Code · Cursor · Codex CLI · Gemini CLI · GitHub Copilot · Windsurf · Antigravity
**Commit-time detection:** Aider · Cody · Continue · Codeium · Cline · Amp · Junie · OpenCode · Rovo Dev · Droid

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
origin enable       # register the machine + install hooks
```

---

## License

MIT
