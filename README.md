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

## The problem

AI agents write more and more of your code, but git only records who *committed*.
Six months from now, `git blame` will point at a teammate — not at the agent, not
at the prompt that produced the change, not at what it cost or what else changed
in that session. The prompt — the actual source of the code — dies with the
terminal window.

Origin fixes that. It runs silently beside your AI coding agent and records every
session — prompts, per-prompt diffs, files touched, tokens, cost — into your git
repo as notes and refs. `git clone` brings the AI history along with the code.

**Supported agents:** Claude Code · Cursor · Codex · Gemini CLI (auto-detected).
Antigravity, Windsurf and Aider support is experimental.

## Install

```bash
npm i -g https://getorigin.io/cli/origin-cli-latest.tgz
origin enable        # auto-detects your agents, installs hooks
```

The CLI runs standalone by default: no account, no server — everything stays in
your repo and on your machine. (Connecting it to the [team platform](#for-teams)
is where logins and API keys come in.)

## Quick start

There is no step 2 — after `origin enable`, just code with your agent like you
always do. Origin captures each session automatically. When your first AI session
has run:

```bash
$ origin sessions

  Sessions (1 total)

  8f41ac02  claude-fable-5   ENDED   4 files  $0.87  12m ago
```

Every session is broken into per-prompt snapshots — what you asked, what the
agent changed, what it cost:

```bash
origin session 8f41ac02     # replay the session, prompt by prompt
origin snapshot             # per-prompt snapshots of the current session
```

And once AI-written code is in your repo, attribution is line-level:

```bash
$ origin blame src/auth.ts

  Line  Tag   Agent    Model            Author  Content
  ─────────────────────────────────────────────────────────────
  41    [AI]  claude   claude-fable-5   dev     const token = rotate(session)
  42    [AI]  claude   claude-fable-5   dev     await store.save(token)
  43    [HU]                            dev     // TODO: audit log

  Summary: AI: 2 (67%)  Human: 1 (33%)

$ origin why src/auth.ts:41    # the exact prompt behind that line
```

## What that gives you day to day

**"Which AI wrote this line, and why?"** — When something breaks, don't stop at
who committed. `origin blame` separates AI from human lines per agent and model;
`origin why file:line` pulls up the exact prompt that produced the line;
`origin search "refresh token"` full-text-searches every prompt ever run against
the repo.

**"What did the agent actually do?"** — Agents touch more than you asked for.
`origin session <id>` replays a session turn by turn: prompt, diff, files,
tokens, cost. `origin recap` gives you the end-of-day summary; `origin stats`
the AI-vs-human ratio for the whole repo.

**"The agent made a mess — get me back."** — Every prompt is a snapshot.
`origin rewind --to <snapshot>` restores the working tree to the moment before
things went sideways — finer-grained than your last commit.

**"The history must travel with the code."** — Everything lives in git, not in a
vendor database:

```
refs/notes/origin          per-commit agent / model / session / cost
origin-sessions branch     transcripts, prompts, per-prompt file changes
~/.origin/config.json      CLI config (machine-local)
```

Clone the repo, get the history. Works offline. No telemetry by default.

**"Old repo, no history?"** — `origin backfill --apply` retroactively tags past
commits by detecting the agents that authored them.

## For teams

The CLI answers "what happened in my repo." [getorigin.io](https://getorigin.io)
answers "what is AI doing across my team": a live dashboard of every session,
per-user and per-agent cost, budgets that actually block overspend, model and
content policies enforced at commit time, PR compliance checks, and audit
trails.

This is the part that needs an account: `origin login` authenticates the CLI and
issues the API key that links your sessions to your org. Free for solo
developers, $29/user/month for teams.

## More

The CLI has 50+ commands — review, governance, handoff between agents, session
memory, TODO tracking, reports, CI integration. See [`DOCS.md`](./DOCS.md) or run
`origin --help`.

## License

MIT
