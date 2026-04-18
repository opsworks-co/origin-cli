# Origin

**The AI-aware layer on top of git.**

Four things no other tool gives you together:

1. **Snapshots** — every AI prompt auto-saves a working-tree snapshot. Undo a bad turn, branch off a good one, time-travel inside a session. Zero commits polluted, stored on orphan branches.
2. **Blame** — line-level attribution showing which AI wrote which line, with the prompt that produced it and the model that ran it. `git blame` tells you who committed; Origin tells you who *authored*.
3. **Multi-agent** — one CLI tracks Claude Code, Cursor, Gemini, Codex, Aider, Windsurf, Copilot, Continue, Amp, Junie, OpenCode, Rovo Dev, Droid. Switch agents, track all of them.
4. **Web platform** — [getorigin.io](https://getorigin.io) for individuals (free) and teams (paid): session replay, live feed, policy enforcement, PR compliance, cost dashboards, SOC 2 audit trails.


```
$ origin blame src/auth.ts

  src/auth.ts

  Line  Tag   Model             Content
  ────────────────────────────────────────────────────────────────
     1  [AI]  claude-sonnet-4   import express from 'express';
     2  [AI]  claude-sonnet-4   import { prisma } from './db';
     3  [HU]                    
     4  [AI]  gemini-2.0-pro    export async function getUsers() {
     5  [MX]  claude-sonnet-4     const users = await prisma.user.findMany();
     6  [AI]  claude-sonnet-4     return users.filter(u => u.active);
     7  [HU]                    }
  ────────────────────────────────────────────────────────────────
  Summary: AI: 5 (71%)  Human: 2 (29%)  Mixed: 0 (0%)
```

Origin runs silently alongside any AI coding agent, captures every session (prompts, responses, tokens, cost, diff), stores it in your own repo as git notes and shadow branches, and gives you snapshots, blame, and a web dashboard on top. Your data stays where your code is.

---

## Quick Start

```bash
npm i -g https://getorigin.io/cli/origin-cli-latest.tgz
origin init
origin blame src/auth.ts
```

That's it. No server, no login, no API keys. Session metadata lives in `refs/notes/origin` and the `origin-sessions` branch — both travel with `git clone`.

<sub>Origin isn't on npm's public registry because it's distributed with the platform. `npm i -g <url>` installs the same tarball we use internally. Inspect it first: `curl -sL https://getorigin.io/cli/origin-cli-latest.tgz | tar -tz | head`.</sub>

---

## The four pillars

### 1. Snapshots — undo any AI turn

Every AI prompt auto-saves a snapshot of your working tree. If the last turn broke something, restore it. If it was good, branch off and keep exploring.

```bash
origin snapshot list              # every snapshot in the current session
origin snapshot restore <id>      # time-travel back (non-destructive)
origin snapshot diff a1b2 c3d4    # see what changed between two turns
origin rewind                     # interactive browser
```

Stored on orphan git branches — no commits polluted, no disk overhead on clone.

### 2. Blame — which AI wrote which line

```bash
origin blame src/auth.ts          # line-by-line AI/human + model
origin why src/auth.ts:42         # the exact prompt that produced line 42
origin diff                       # annotated diff: [AI] vs [HU]
```

Attribution survives `rebase`, `amend`, `cherry-pick`, and `stash`.

### 3. Multi-agent — one CLI, every agent

Claude Code, Cursor, Gemini CLI, Codex, Aider, Windsurf, GitHub Copilot, Continue, Amp, Junie, OpenCode, Rovo Dev, Droid. Auto-detected by `origin init`. Switch between them — your history doesn't fragment.

### 4. Web platform — solo (free) or team

[getorigin.io](https://getorigin.io) reads the same data the CLI writes:

- **Session replay** — every prompt, diff, tool call, token count
- **Live feed** — watch active sessions, kill runaway agents
- **AI blame view** — dashboard version of `origin blame`
- **Policy enforcement** — block AI from paths, enforce model allowlists, require human review
- **PR compliance** — GitHub status checks on AI-authored PRs
- **Cost dashboards** — spend per agent / model / repo / developer
- **SOC 2 / ISO 27001 audit** — one-click evidence export

Free for solo. Paid for teams.

Full command reference: [`docs/CLI.md`](docs/CLI.md).

---

## Supported AI agents

| Agent | Detection | Status |
|-------|-----------|--------|
| Claude Code | Session hooks + process detection | Stable |
| Cursor | Session hooks + IDE extension | Stable |
| Gemini CLI | Process detection | Stable |
| Codex CLI | Session hooks + process detection | Stable |
| Aider | Process detection | Stable |
| Windsurf | Session hooks + process detection | Preview |
| GitHub Copilot | Process detection | Preview |
| Continue | Process detection | Preview |
| Amp | Process detection | Preview |
| Junie | Process detection | Preview |
| OpenCode | Process detection | Preview |
| Rovo Dev | Process detection | Preview |
| Droid | Process detection | Preview |

Auto-detected by `origin init`. One CLI tracks them all.

---

## Self-hosting the platform

Setup and architecture live in [`docs/PLATFORM.md`](docs/PLATFORM.md). The CLI works standalone without the platform — the web dashboard is optional.

---

## How it works

```
You code with any AI agent
        ↓
Pre-commit hook scans for secrets (blocks if found)
        ↓
Post-commit hook fires automatically
        ↓
Origin detects the agent + reads session transcript
        ↓
Metadata written to refs/notes/origin
Session saved to origin-sessions branch
        ↓
origin blame / diff / stats read it back
```

Hooks add <50ms to commits. Zero config. Works offline.

### Where data lives

| Location | What's there |
|----------|-------------|
| `refs/notes/origin` | Per-commit AI metadata (model, session, cost, tokens) |
| `origin-sessions` branch | Full session transcripts and prompts |
| `.git/origin-handoff.json` | Cross-agent handoff context |
| `~/.origin/config.json` | CLI config |

Everything travels with `git clone`. No external database.

### Supported git operations

AI attribution survives `git rebase`, `git commit --amend`, `git cherry-pick`, and stash operations. See [`docs/CLI.md`](docs/CLI.md#attribution-preservation).

---

## License & distribution

- **Code in this repository: MIT.** Use it, self-host it, fork it.
- **The hosted service at [getorigin.io](https://getorigin.io) is commercial.** Self-hosting the code doesn't require a license; using the hosted product is subject to its Terms of Service.

See [LICENSE](LICENSE).
