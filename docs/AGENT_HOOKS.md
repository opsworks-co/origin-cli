# Agent Hooks — Integration Contract

How Origin connects to AI coding agents. The canonical reference for anyone adding a new agent or writing a plugin that reacts to Origin events.

Every claim in this document is verifiable from code. Source citations are inline (`packages/cli/src/…`). If a feature isn't described here, it doesn't exist.

---

## 1. Overview

An **agent integration** in Origin has three moving parts:

1. **Agent-specific install path** (`packages/cli/src/commands/enable.ts`) — writes a config file the agent will read on next launch (`~/.claude/settings.json`, `~/.cursor/hooks.json`, `.aider.conf.yml`, etc.) pointing each of the agent's native lifecycle events at the Origin CLI.

2. **Shared event dispatcher** (`packages/cli/src/commands/hooks.ts:hooksCommand`) — receives hook invocations from any supported agent via `origin hooks <agent> <event>` with the agent's raw event payload on stdin, maps them onto Origin's unified lifecycle, and routes to the right handler.

3. **Session state** (`packages/cli/src/session-state.ts`) — a per-session JSON file under `.git/origin-session-<tag>.json` (or `~/.origin/sessions/...` for non-git cwds) that accumulates prompts, tool calls, file changes, and branch info across the lifecycle.

What Origin gives back to the agent:
- System-prompt injection with repo-level AI attribution context (`buildAttributionContext`) at session start
- Per-file attribution context when the agent reads/edits a file (`buildFileAttributionContext` in `handlePreToolUse`)
- Policy enforcement (FILE_RESTRICTION rules cause exit code 2 to block the tool call — `hooks.ts` ~line 3444)
- Cross-agent session memory and handoff (so the next agent — possibly a different product — picks up context without the user re-explaining)

Everything else is in-band metadata capture: prompts, diffs, token counts, cost, sub-agent tool calls, commit trailers, git notes.

---

## 2. Hook event taxonomy

Origin's **unified lifecycle** has six events. Every supported agent's native hooks are mapped onto this set. The canonical list lives in `hooks.ts:hooksCommand` (~line 4315).

| Origin event | When it fires | Handler |
|---|---|---|
| `session-start` | Agent starts a new coding session | `handleSessionStart` |
| `user-prompt-submit` | User submits a prompt to the agent | `handleUserPromptSubmit` |
| `pre-tool-use` | Agent is about to invoke a tool (Bash, Read, Edit, Task, etc.) | `handlePreToolUse` |
| `post-tool-use` | A tool invocation completed | `handlePostToolUse` |
| `stop` | Agent finished its turn (prompt → response cycle done) | `handleStop` |
| `session-end` | Agent session terminated (explicit end, tool close, or timeout) | `handleSessionEnd` |

Plus four git-level hooks fired by git itself (not by an agent):

| Hook | When | Handler | Purpose |
|---|---|---|---|
| `git-pre-commit` | Before commit staged tree is turned into a tree object | `handlePreCommit` | Secret scanner blocks commits containing API keys / tokens / etc. (42 patterns) |
| `git-prepare-commit-msg` | After git wrote `COMMIT_EDITMSG`, before the commit object is created | `handlePrepareCommitMsg` | Adds `Origin-Session:` and `Origin-Snapshot:` trailers via `git interpret-trailers`. Does not amend. |
| `git-post-commit` | After a commit object has been written | `handlePostCommit` | Writes per-commit git notes (`refs/notes/origin`) with model, session, cost, token counts. Also accumulates file/line stats into session state. |
| `git-pre-push` | Before `git push` sends refs to the remote | `handlePrePush` | Pushes the `origin-sessions` orphan branch + `refs/notes/origin` alongside the user's push. |
| `git-post-rewrite` | After `git rebase`, `git commit --amend`, or `git cherry-pick` rewrites history | history preservation | Walks old→new SHA mappings and re-attaches git notes. |

### Event payloads

Origin's handlers read fields off a JSON payload arriving on stdin. Different agents use different field names; the handlers normalize them as they read. Concrete fields used today (from `hooks.ts` reads):

```ts
// Common across all agent events
interface BaseEventPayload {
  session_id?: string;           // Agent's native session id (Claude Code: claudeSessionId)
  transcript_path?: string;      // Path to the JSONL transcript (Claude Code, Gemini)
  cwd?: string;                  // Working directory the agent reports
  workspace_roots?: string[];    // Cursor — preferred over cwd (Cursor runs hooks from ~/.cursor/)
  model?: string;                // Model identifier — only reliable on Claude Code session-start + Cursor stop
}

// session-start additions (handleSessionStart)
interface SessionStartExtras {
  // No agent-specific extras today; we compute everything from cwd + transcript_path
}

// user-prompt-submit additions (handleUserPromptSubmit)
interface PromptSubmitExtras {
  prompt?: string;               // Full user prompt text
  hook_event_name?: string;      // Claude Code passes this; used for debug only
}

// stop additions (handleStop)
interface StopExtras {
  // transcript_path is the main thing read here — we re-parse it for the full turn
}

// pre-tool-use and post-tool-use additions (handlePreToolUse / handlePostToolUse)
interface ToolEventExtras {
  tool_name?: string;            // Bash, Read, Edit, Write, Grep, Task, …
  tool_input?: Record<string, any>;  // The args the agent passed (file_path, command, etc.)
  tool_result?: unknown;         // post-tool-use only — string or JSON-ish blob
  tool_call_id?: string;         // Preferred pairing key (Claude Code)
  tool_use_id?: string;          // Same thing under a different name on some agents
}
```

> **Sub-agent caveat.** `handlePreToolUse` records every tool call as a `ToolCallRecord` (renamed from `SubagentRecord` in R2). Real Claude Code sub-agents — spawned via the `Task` tool — are one of many tool names that flow through this path. The model used by a sub-agent is **not** captured today. See `docs/notes/SUBAGENT_AUDIT.md` for full findings and follow-up proposals (R1–R6).

### Events Origin does NOT emit today

For transparency — these exist in some other tools but not here:

- No **turn-start** event. `user-prompt-submit` is the closest.
- No **streaming token** hook. Token counts come from parsing the transcript at `stop` / `session-end`.
- No **file-save** hook. File changes are captured from git `pre-/post-commit` and from tool-call diffs.
- No **pre-session-end** hook. `session-end` is the only terminal signal.

---

## 3. The CLI contract

Every hook invocation routes through:

```
origin hooks <agent-slug> <event>
```

with the agent's event payload on stdin as JSON.

**Supported `<agent-slug>` values** (exact strings from `index.ts:620-626`):

| Slug | Registered in |
|---|---|
| `claude-code` | `hooks.command('claude-code <event>')` |
| `cursor` | `hooks.command('cursor <event>')` |
| `gemini` | `hooks.command('gemini <event>')` |
| `codex` | `hooks.command('codex <event>')` |
| `windsurf` | `hooks.command('windsurf <event>')` |
| `aider` | `hooks.command('aider <event>')` |

**Supported `<event>` values:** `session-start`, `user-prompt-submit`, `stop`, `session-end`, `pre-tool-use`, `post-tool-use`. Unknown events log to stderr and return cleanly — they don't error out the host process.

**Git-level CLI invocations** use a different subcommand tree:

```
origin hooks git-pre-commit                                     # stdin: staged diff (from pre-commit hook)
origin hooks git-prepare-commit-msg <msgFile> [source] [sha]    # args: as git passes to prepare-commit-msg
origin hooks git-post-commit
origin hooks git-pre-push
origin hooks git-post-rewrite                                   # stdin: old->new SHA pairs
origin hooks git-post-checkout <prevHead> <newHead>
```

**stdin format:** JSON object. Parsed by `readStdin()` (reads entire stdin then `JSON.parse`). If stdin is empty or non-JSON, the handler receives `{}` and defaults its way through.

**Process exit:** the handler must return cleanly. Exiting with code 2 + writing to stderr is reserved for policy blocks (`handlePreToolUse` uses this to block a FILE_RESTRICTION rule violation). Any other non-zero exit is treated by the agent as a broken hook and may be silently ignored or loudly complained about, depending on the agent.

**stdout:** Origin handlers sometimes write structured JSON to stdout to communicate back to the agent:

- Claude Code: `{ "systemMessage": "..." }` for system-prompt injection
- Cursor: `{ "additional_context": "..." }`
- Others: no stdout response

Agents that don't consume stdout ignore it; Origin doesn't block on its return value.

---

## 4. The plugin interface

Third-party plugins subscribe to Origin events. The contract lives in `packages/cli/src/plugin-system.ts`.

### Registration

```bash
origin plugin install <name> "<command>" --events session-start,post-commit
origin plugin list
origin plugin remove <name>
```

`<command>` is any executable in the user's `PATH` or an absolute path. Example: `origin plugin install my-hook "node /Users/me/my-hook.js" --events "*"`.

Registry: `~/.origin/plugins.json` (mode `0o600`).

### Plugin protocol

When an event fires, Origin invokes each subscribed plugin with:

- **stdin**: JSON `PluginRequest`
- **stdout**: JSON `PluginResponse` (or non-JSON, treated as `{ status: 'ok', data: { output } }`)
- **stderr**: plugin logs — captured and surfaced in `~/.origin/debug.log` on error
- **env**: `ORIGIN_PLUGIN_EVENT`, `ORIGIN_PLUGIN_NAME` set; the user's env is copied through MINUS a curated deny-list of `SENSITIVE_ENV_VARS` (AWS / OpenAI / Anthropic / GitHub / npm / Docker creds — `plugin-system.ts:39-51`)
- **timeout**: 30 seconds per call; `SIGTERM` after timeout

```ts
interface PluginRequest {
  event: string;                  // matches Origin event taxonomy above
  data: Record<string, any>;      // event-specific payload
  timestamp: string;              // ISO-8601
}

interface PluginResponse {
  status: 'ok' | 'error' | 'skip';
  data?: Record<string, any>;
  error?: string;
}
```

### Hello-world plugin

```js
#!/usr/bin/env node
// plugin.js
let body = '';
process.stdin.on('data', (c) => body += c);
process.stdin.on('end', () => {
  const req = JSON.parse(body);
  process.stderr.write(`[hello-plugin] event=${req.event}\n`);
  process.stdout.write(JSON.stringify({ status: 'ok', data: { saw: req.event } }));
});
```

Register and subscribe to all events:

```bash
chmod +x plugin.js
origin plugin install hello "node $PWD/plugin.js" --events "*"
```

### What Origin calls plugins with

Today, plugins are invoked through `executePluginsForEvent(event, data)` in `plugin-system.ts:241`. As of this writing **no handler in `hooks.ts` actually calls `executePluginsForEvent` yet** — the plugin infrastructure is installed and registry commands work, but the event dispatch loop hasn't been wired into the event handlers. Treat the plugin surface as **alpha**: the contract above is stable, but your plugin won't be invoked until we wire the dispatch.

> **Known gap:** plugin dispatch needs to be added to each of the six agent-event handlers, guarded by `executePluginsForEvent(event, data)` after existing work is done. Tracking as follow-up. Don't ship a production plugin against this contract yet.

---

## 5. Per-agent integration matrix

Current state for each supported agent, as of the most recent commit touching `enable.ts`.

| Agent | Install location | Config file | Native events mapped | Transcript source | Known limitations |
|---|---|---|---|---|---|
| **Claude Code** | `~/.claude/settings.json` (global) or project-local override | `settings.json` — `hooks` key with event → command mappings | `SessionStart → session-start`, `UserPromptSubmit → user-prompt-submit`, `Stop → stop`, `SessionEnd → session-end`, `PreToolUse → pre-tool-use`, `PostToolUse → post-tool-use` | `transcript_path` in the stdin payload → reads the JSONL transcript directly | Sub-agent spawns (`Task` tool) look like any other tool call; model used by sub-agent not captured. |
| **Cursor** | `~/.cursor/hooks.json` | `hooks.json` | `beforeSubmitPrompt → user-prompt-submit`, `afterAgentStop → stop`, `afterSession → session-end` | Discovery: Cursor writes agent sessions to a local SQLite DB; Origin reads the most recent row near `stop` time. | No `pre-tool-use` / `post-tool-use` today — Cursor doesn't expose them via the hooks layer. Model discovery relies on the transcript row — may be `unknown` for a few seconds after a fresh session. |
| **Gemini CLI** | `~/.gemini/settings.json` | `settings.json` — hooks array | Best effort: `sessionStart → session-start`, `userPromptSubmit → user-prompt-submit`, `afterToolUse → post-tool-use` | Gemini CLI writes a session log to `~/.gemini/sessions/`. Discovered via `discoverGeminiTranscriptPath`. | No `pre-tool-use`. Token counts come from the transcript at `stop`. |
| **Codex CLI** | `~/.codex/hooks.json` | Codex config | `on-session-start → session-start`, `on-prompt → user-prompt-submit`, `on-turn-complete → stop` | Codex rollout JSONL files in `~/.codex/sessions`. Token counts parsed from rollout `usage` events. | No per-tool-use events. Model reported on session-start, reliable. |
| **Windsurf** | `~/.windsurf/hooks.json` | Windsurf config | `sessionStart`, `stop` | Agent transcript not yet publicly accessible; Origin falls back to git state diffs between prompts. | No tool-use events; no transcript-based token counts. Preview status. |
| **Aider** | `./.aider.conf.yml` in the project | YAML — `shell_cmd_pre`, `shell_cmd_post` | `shell_cmd_pre → pre-tool-use` (coarse), `shell_cmd_post → stop` | Aider's own `.aider.chat.history.md` | Aider runs all edits through its own commit path; Origin's git hooks still fire on those commits. Model detection best-effort. |

Additional process-detection-only integrations (no config install — just pgrep fallbacks used by `handlePostCommit` and backfill) exist for: `copilot`, `continue`, `amp`, `junie`, `opencode`, `rovo`, `droid`. These don't emit structured events; they let us tag an AI process as the likely author when the session file is missing.

---

## 6. Authoring a new integration

Checklist to add a new agent. Walk it top to bottom.

1. **Confirm the agent has hook surface.** It must expose callable shell commands (or a config file referencing them) for at least `session-start` and `stop`. Without `stop`, you can't capture a turn's prompts/diffs.

2. **Add the agent to the `AGENTS` registry** in `packages/cli/src/commands/enable.ts` (~line 390). Copy the shape of an existing entry: `{ name, configDir, configFile, detectDir, command, hookCommand: 'origin hooks <your-slug>', installHooks }`.

3. **Write `installYourAgentHooks(gitRoot)`** next to the other `install*Hooks` functions. Pattern:
   - Read the existing config file if present.
   - Merge in entries that invoke `origin hooks <your-slug> <event>` for each of the agent's native events you can map.
   - Write the config back atomically.
   - Guard with a marker (`# origin-<agent>` or a structured key) so re-running `origin enable` is idempotent.

4. **Register the CLI subcommand** in `packages/cli/src/index.ts`:
   ```ts
   hooks.command('<your-slug> <event>').description('Handle <Agent> hook event').action((event) => hooksCommand(event, '<your-slug>'));
   ```

5. **Map the agent's events** to Origin's taxonomy inside `hooksCommand` if the mapping isn't already 1:1. If the agent uses different event names (e.g., `beforeSubmit` vs `user-prompt-submit`), normalize in your installer's script, not in `hooksCommand`.

6. **Implement transcript discovery.** Add a helper like `discoverYourAgentTranscriptPath()` (see `discoverGeminiTranscriptPath` in `hooks.ts` for the pattern) so `handleStop` can parse the session transcript for tokens, tool calls, and prompts.

7. **Add a positive test.** In `packages/cli/src/__tests__/`, write an integration test that installs the hook into a temp repo, fires each event with a representative stdin payload, and asserts the session state file contains the expected fields. See `prepare-commit-msg.test.ts` for the shape.

8. **Update this doc's Section 5 matrix** with the new row — install location, events mapped, transcript source, limitations.

9. **Update `docs/CLI.md` "Supported Agents"** with the same info.

10. **Idempotency check.** Extend `enable-idempotency.test.ts` to include your new installer in the `HOOKS` array (for git hooks) or add a parallel per-agent suite if it mutates a config file.

---

## 7. Compatibility versioning

This doc describes the contract as of today (2026-04). Guarantees going forward:

- **Origin event names are stable.** Renaming a hook event is a breaking change. We add new events rather than renaming.
- **Payload fields may expand.** New optional fields can be added to event payloads at any time. Existing fields won't be renamed or have their semantics changed. If a field's meaning genuinely needs to change, a new field is added and the old one is marked deprecated in this doc before being removed in a subsequent major release.
- **Plugin `PluginRequest` / `PluginResponse` shape is stable.** Same rules as above.
- **CLI subcommand names are stable.** `origin hooks <agent> <event>` works forever. Same for `origin hooks git-<phase>`.
- **The `ToolCallRecord` rename (R2).** The serialized field name stays `subagents` in `.git/origin-session-*.json` for backward compat with in-flight session state files. The TypeScript type renamed from `SubagentRecord` is an internal API change.

Versioning signal: bump the first digit of the CLI version (`0.YYYYMMDD.HHMM`) if an integration contract changes in a breaking way. We haven't done this yet; any such change will ship with a migration note in the `upgrade` command's output.

---

## Known limitations at time of writing

Called out so nobody reads the above and builds on a claim that doesn't hold today.

- **Plugin dispatch is not wired.** `executePluginsForEvent` is registered but never called from `hooks.ts`. Plugins can be installed, listed, removed — they just don't fire on events yet.
- **Sub-agent identity (model, type) is not captured.** See `docs/notes/SUBAGENT_AUDIT.md`. A Task invocation that used Haiku under a parent running Opus surfaces as the parent's model everywhere (trailer, stats, blame).
- **Per-agent config installers mutate real user paths** (`~/.claude/settings.json`, etc.) and have no filesystem abstraction; they are not covered by `enable-idempotency.test.ts`. Manual QA only until a refactor lands.
- **Token counts for Windsurf and Aider** are best-effort or absent. Cost attribution for those agents is approximated; budget policies applied to them will be less accurate.
- **No streaming / token-level hook.** All cost/token data comes from post-turn transcript parsing.
- **`session_id` in the incoming payload is the agent's native ID**, not Origin's. Origin generates its own `sessionId` at `session-start` and stores both (`claudeSessionId` and `sessionId`) on the state file. API writes use Origin's `sessionId`.
