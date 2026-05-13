<p align="center">
  <img src="https://getorigin.io/favicon.svg" width="80" alt="Origin Logo" />
</p>

<h1 align="center">Origin CLI</h1>

<p align="center">
  <strong>Git for your AI. Every agent. Every prompt. Every line. In your repo.</strong><br/>
  <em>The portable audit layer for AI-assisted code.</em>
</p>

<p align="center">
  <a href="https://github.com/opsworks-co/origin-cli/blob/main/LICENSE"><img src="https://img.shields.io/badge/license-MIT-green" alt="License"></a>
  <a href="https://getorigin.io"><img src="https://img.shields.io/badge/web-getorigin.io-6366f1" alt="Website"></a>
  <a href="https://getorigin.io/cli/version.json"><img src="https://img.shields.io/badge/dynamic/json?label=cli&query=version&url=https%3A%2F%2Fgetorigin.io%2Fcli%2Fversion.json&color=6366f1" alt="Version"></a>
</p>

---

Origin runs silently next to any AI coding agent — **Claude Code, Cursor, Codex, Gemini CLI, Aider, Windsurf, Copilot, and a dozen more** — and captures every session: prompts, files touched, tokens, cost, diffs, line-level attribution.

Everything lives in **git notes and refs**. `git clone` brings the history with the code. No server, no login, no API keys required.

## Install

```bash
npm i -g https://getorigin.io/cli/origin-cli-latest.tgz
```

## Quick start

```bash
origin enable                    # auto-detect agents, install git hooks
# …code with any AI agent — Origin tracks automatically
origin blame src/index.ts        # see which AI wrote each line
origin why src/auth.ts:42        # show the exact prompt behind a line
origin pre-review                # AI review of your diff before you open the PR
```

That's it. Nothing to configure.

---

## Why this exists

The honest dev problems Origin solves:

| Problem | What Origin gives you |
|---|---|
| **"Which agent wrote this code?"** Half your repo is now AI. `git blame` shows your name on commits an AI authored. | `origin blame <file>` — line-by-line `[AI]` / `[HU]` / `[MX]` tags, plus the model and session ID for every line. |
| **"Why does this code exist?"** Six weeks later, nobody remembers what the prompt was. | `origin why <file>:<line>` returns the exact prompt that produced that line. |
| **"Did the AI actually do what we asked?"** Diff says one thing, the prompt said another. | `origin pre-review` runs an LLM review that sees the diff *and* the prompt that produced it — flags intent drift, not just style nits. |
| **"Is this AI session actually productive?"** Tokens, cost, lines — none of these tell you whether the code stuck. | Acceptance rate: at every session-end Origin computes how many of the *previous* session's lines are still alive on HEAD. Cheap sessions can be wasteful; expensive ones can be the productive ones. |
| **"How do I work with five different AI tools?"** Each has its own logs, dashboards, and quirks. | One CLI. Detects Claude Code, Cursor, Codex, Gemini, Aider, Windsurf, Copilot, Cody, Continue, Cline, Codeium, Amp, Junie, Rovo, Droid — and writes attribution in a single format. |
| **"What if I switch tools?"** Lock-in is real. | History lives in `refs/notes/origin` inside your repo. Push, fetch, clone — it travels. Origin can vanish tomorrow and your audit trail is still there. |

---

## What you actually get

### Per-line AI attribution that survives a clone

```bash
$ origin blame src/auth.ts
  Line  Tag   Model              Content
  ───────────────────────────────────────────────────
   1    [HU]                     import express from 'express';
   2    [AI]  claude-sonnet-4    import { verify } from 'jsonwebtoken';
   3    [AI]  claude-sonnet-4
   4    [AI]  claude-sonnet-4    export function authMiddleware(req, res, next) {
   5    [AI]  claude-sonnet-4      const token = req.headers.authorization;
   6    [AI]  gpt-5-codex          if (!token) return res.status(401).json({…});
   7    [MX]  claude-sonnet-4      req.user = verify(token, process.env.JWT_SECRET);
   ───────────────────────────────────────────────────
  Summary: AI: 5 (71%)  Human: 1 (14%)  Mixed: 1 (14%)
```

JSON output (`origin blame <file> --json`) returns a per-session context map alongside the line array — each session entry includes:

- **`fullPrompt`** — the actual prompt the agent received (redacted, capped at 8 KB)
- **`previousSessionId`** — pointer to the prior session, so you can walk the chain
- **`filesRead`** — what the agent loaded into context, not just what it changed
- **`acceptanceRate`** — fraction of this session's lines still alive on HEAD (computed by the *next* session)

### Pre-PR AI code review with memory

```bash
$ origin pre-review
Reviewing 6 files (143 AI lines, 2 prior sessions) against origin/main…

## Summary
The diff adds JWT auth middleware, matching the prompt's stated intent.
Session 1's acceptance rate (87%) suggests strong continuity with prior work.

## Blockers
- src/auth.ts:14 — token decoded *before* a null check. Throws on missing
  header. Add the early return from line 6 before line 14.

## Concerns
- src/middleware.ts:32 — duplicates the validation from session abc1234
  (Apr 28). That session's lines had 23% acceptance — humans rewrote
  most of it. Worth checking why before re-introducing the same pattern.
…
```

Unlike a generic LLM diff reviewer, `origin pre-review` feeds Claude:

1. **The prompts that produced the code** (so it can check intent vs. outcome)
2. **What the agent looked at** (so it can spot missing context)
3. **How prior similar work was accepted** (so it can flag regression patterns)

Powered by your own Anthropic API key (`origin config set anthropic-api-key <key>`).

### Per-prompt rollbacks

Every prompt creates a working-tree snapshot. Get a bad result, rewind in one command:

```bash
origin snapshot                # list snapshots in current session
origin rewind --to <id>        # restore working tree to that point
```

Snapshots use git plumbing, never touch your branch, and can optionally be GPG/SSH-signed (`origin config set sign-snapshots true`).

### Cross-agent handoff

The next agent reads what the previous agent did:

```bash
origin handoff show     # last session's summary, prompts, files, open TODOs
origin memory show      # rolling 20-session history for this repo
origin todo list        # AI-extracted TODOs across sessions
```

When a new session starts, Origin auto-writes context to `CLAUDE.md` / `AGENTS.md` / `~/.cursor/rules/origin.md` / `GEMINI.md` / `.windsurfrules` so the next agent picks up where the last one stopped.

---

## What lands in your repo

Origin writes to three git refs — all pushable, all portable, none invasive.

| Ref | Holds | Lifecycle |
|---|---|---|
| `refs/notes/origin` | Per-commit: sessionId, model, agent, prompt, filesRead, tokens, cost | Written at session-end |
| `refs/notes/origin-acceptance` | Per-commit: how many AI lines survived to HEAD | Backfilled by the *next* session |
| `refs/notes/origin-memory` | Rolling index of last 20 sessions for this repo | Updated each session |
| `origin-sessions` (orphan branch) | Full transcripts, per-prompt diffs, file changes | Written via git plumbing (working tree untouched) |

Share with your team:

```bash
git push origin 'refs/notes/origin*'
git fetch origin 'refs/notes/origin*:refs/notes/origin*'
```

---

## Supported agents

| Tool | Status | How it integrates |
|---|---|---|
| Claude Code | Shipping | Native hook events |
| Cursor | Shipping | Hook events + SQLite scrape for full transcripts |
| Codex CLI | Shipping | Rollout JSONL + native hooks |
| Gemini CLI | Shipping | Chats / checkpoints + native hooks |
| Windsurf | Shipping | Workspace integration |
| Aider | Shipping | Log scraping + commit detection |
| GitHub Copilot | Shipping | `Co-Authored-By` trailer detection |
| Cody / Continue / Cline / Codeium | Shipping | Trailer-based detection |
| Amp / Junie / Rovo / Droid | Shipping | Trailer-based detection |

Detection runs on CLI availability, IDE-extension inspection, MCP config, and process detection at commit time. Tools without first-class hooks still get attributed via `Co-Authored-By:` trailers and author patterns.

---

## Common workflows

```bash
# Find which prompt introduced a bug
git bisect …                                # narrow to the commit
origin show <sha>                           # show the session behind it
origin why src/buggy.ts:42                  # see the exact prompt

# End-of-day recap
origin recap                                # today's sessions, cost, top files

# Audit a PR before merging
origin pre-review --base origin/main        # LLM review with full session context
origin intent-review                        # local-only review (no LLM call)

# Compare two sessions
origin session-compare <id1> <id2>

# Retroactively tag old commits
origin backfill --apply

# Export to your data pipeline
origin export --format agent-trace          # Agent Trace v0.1.0 standard

# Search
origin search "JWT auth"                    # full-text across prompts + transcripts
```

The CLI has 60+ commands. `origin --help` lists everything; [`DOCS.md`](./DOCS.md) has the full reference.

---

## Privacy & security

- **No telemetry by default.** Opt in with `origin config set telemetry true`.
- **Secret redaction** before writing prompts to git notes. Pattern-based + entropy-based detection for AWS keys, GitHub tokens, Stripe keys, JWTs, private-key blocks, DB connection strings, and high-entropy tokens near secret-context words. Replaced with `[REDACTED]` before anything hits disk.
- **Pre-commit secret scanning** (installed by `origin enable`) blocks commits containing secrets before they reach the repo.
- **Optional commit signing** for Origin's own commits via existing GPG/SSH config (`origin config set sign-snapshots true`).
- **Local-first.** Standalone mode (`origin enable --standalone`) keeps everything offline.
- **Reproducible builds.** Releases are signed with sigstore cosign + npm provenance.

---

## For teams

[getorigin.io](https://getorigin.io) adds the team layer on top of the CLI:

- Live sessions dashboard with full transcripts and tool-call timelines
- Per-user cost attribution, model & budget policies with hard caps
- PR compliance checks (governance gates on AI-authored PRs)
- Audit trails, compliance reports, secret/PII scanning across the org
- GitHub App, GitLab, Slack integrations

Free for solo developers. $29/user/month for teams.

```bash
origin login                # authenticate with Origin (or your self-hosted instance)
origin enable               # register the machine + install hooks
```

---

## Status

Active development. The CLI ships under a date-versioned scheme (`0.YYYYMMDD.HHMM`); the upgrader is hardened with sha256 verification and fails closed without it. Releases land via GitHub Actions with sigstore cosign signing and npm provenance attestation.

## License

MIT
