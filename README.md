# Origin

**Know exactly what your AI agents are writing.**

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

Git blame tells you which human committed code. Origin tells you which AI wrote it, what they were asked to do, and what it cost. It runs silently next to Claude Code, Cursor, Gemini CLI, Codex, Aider, and 8 more agents, captures every session — prompts, responses, tokens, duration, cost — and attaches it to your commits as git notes. Your data stays in your repo.

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

## What you can do

- `origin blame <file>` — line-level AI/human attribution with the model that wrote each line
- `origin diff` — annotated diff showing which lines are AI vs human
- `origin stats` — AI percentage, cost, token usage, per-agent breakdown
- `origin sessions` — every AI coding session stored in git
- `origin snapshot` — auto-saved working-tree snapshot after every AI prompt; `origin snapshot restore <id>` time-travels back non-destructively, `origin rewind` opens an interactive browser
- `origin prompts <file>` — every prompt that touched a file, with diffs
- `origin chat` — natural-language Q&A over your AI-authored code
- `origin web` — local browser dashboard, no server needed
- Built-in secret scanner blocks commits containing API keys and tokens

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

## For teams

[getorigin.io](https://getorigin.io) is the hosted platform built on the same CLI. It adds:

- **Session replay** — every prompt and diff of every session, in the browser
- **Policy enforcement** — block AI from touching payment logic, enforce model allowlists, require human review
- **PR compliance** — GitHub status checks that verify AI attribution before merge
- **Cost visibility** — who's spending what, on which model, in which repo
- **Audit reports** — one-click SOC 2 and ISO 27001 evidence

<!-- TODO: real dashboard screenshot / GIF showing a Session Detail page with prompts + diffs -->

Self-host setup and the full platform architecture live in [`docs/PLATFORM.md`](docs/PLATFORM.md). Hosted is free for solo developers.

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
