# Sub-agent tracking audit

**Status:** Findings only. No code changes in this note. Follow-ups listed at the bottom — waiting on approval before any implementation.

**Source of truth** for everything here:
- `packages/cli/src/session-state.ts` — `SubagentRecord` interface, `SessionState.subagents`
- `packages/cli/src/commands/hooks.ts` lines 3353–3544 — `handlePreToolUse` / `handlePostToolUse`
- `packages/cli/src/attribution.ts` — full file, no sub-agent references

---

## Headline finding

The thing we call a "sub-agent" in the code is actually **every tool call**, not a sub-agent in any meaningful sense. Claude Code's `Task` tool (which genuinely spawns a child agent that can use a different model) is one of many tools — `Bash`, `Read`, `Edit`, `Grep`, etc. all also get recorded as a `SubagentRecord`. The file header comment `F7: Subagent Tracking` and the variable name `state.subagents` are misleading.

Worse: even for real `Task` invocations, we capture no identity, model, or output attribution. A Task spawned with Opus looks identical in our records to one spawned with Haiku.

---

## Q1 — Does each sub-agent get its own `sessionId`?

**No.** Every tool call is stored as a child record on `SessionState.subagents[]`. There is no concept of a "child session" with its own `sessionId`, `parentSessionId`, or API linkage. The `SessionState` interface has a `parentSessionId` field (`session-state.ts:57` equivalent area) but it's used for cross-agent handoff and session chaining, not sub-agent spawning.

Concrete shape (from `session-state.ts:10–17`):

```ts
export interface SubagentRecord {
  toolCallId: string;
  toolName: string;
  startedAt: string;
  endedAt?: string;
  prompt?: string;   // JSON.stringify(tool_input).slice(0, 500)
  result?: string;   // tool_result truncated to 500 chars
}
```

Fields conspicuously absent: `model`, `agent` / `agent_type`, `sessionId`, `parentSessionId`, `filesChanged`, `linesAdded`, `linesRemoved`.

Every `Bash`, `Read`, `Edit`, `Grep`, `Write`, `Task`, etc. tool call produces one of these. On a typical session that's dozens to hundreds of records per session, most of which are not sub-agents in any meaningful sense.

---

## Q2 — Does attribution tag lines written by sub-agents with the sub-agent's identity?

**No.** `attribution.ts` contains zero references to `subagent`, `Subagent`, `parentSession`, or anything related. Every attribution path — `computeFileAttribution`, `getLineBlame`, `computeAttributionStats`, `computeAcceptanceMetrics` — reads model and authorship from the **commit-level git note** written by `handlePostCommit`. That note uses the *parent session's* `state.model`. Whatever sub-agent actually wrote a line is invisible.

If a Claude Code parent session spawns a Task sub-agent that uses Haiku, and that sub-agent writes `src/auth.ts`, `origin blame src/auth.ts` reports the parent's model (likely Sonnet/Opus) for every line.

---

## Q3 — Is a different sub-agent model captured in the trailer? In stats? In `origin blame`?

**No, no, and no.** In that order:

- **Trailer**: `buildOriginTrailers` (hooks.ts:~4076) takes `state.sessionId`, `state.model`, `state.prompts?.length`. No sub-agent data is consulted. The trailer says "Claude Code" even when a Task actually ran Haiku.

- **Stats**: `origin stats` aggregates by `byModel` / `byTool`, which again comes from the commit-level git note's `model` field — single value per commit, always the parent's.

- **Blame**: same code path as stats (reads `refs/notes/origin`). Per-line attribution is based on which git commit introduced a line, and each commit has exactly one `model` in its note. No subagent-level granularity exists anywhere in the blame output.

There is also no way to derive the sub-agent's model from what we currently capture. `SubagentRecord.prompt` contains a JSON-stringified `tool_input`, truncated to 500 chars. For Task tool calls, Claude Code puts `{ "description": "...", "prompt": "...", "subagent_type": "..." }` in `tool_input` — `subagent_type` tells us which configured sub-agent was invoked, but **not** which model that sub-agent runs on (that's determined by the sub-agent's own config file in `.claude/agents/<type>.md`).

---

## Q4 — What happens when sub-agents run in parallel?

**Two bugs, one severity each.**

**Bug 4a — Race condition matching pre/post tool use records.**
`handlePostToolUse` at hooks.ts:3530 matches a post-use to its pre-use via:
```ts
const record = [...state.subagents].reverse().find(
  r => r.toolName === toolName && !r.endedAt
);
```
If Claude Code fires two parallel `Task` tool calls, both hit `handlePreToolUse` in sequence (both push a record with `toolName === 'Task'`, no `endedAt`). When the first `Task` finishes, `handlePostToolUse` reverse-iterates and matches the **second** (most-recently-pushed) record. The two records swap their `endedAt` timestamps and `result` fields.

The fix is simple: match by `toolCallId`, not `toolName`. The ID is already captured at pre-use time (`input.tool_call_id || synthesized`), but at post-use time we ignore `input.tool_call_id` / `input.tool_use_id` and do a name-based lookup instead.

**Bug 4b — Auto-generated IDs collide across parallel calls.**
When `input.tool_call_id` is missing (it is for some agents — Gemini, Aider), `handlePreToolUse` falls back to `${Date.now()}-${crypto.randomBytes(4).toString('hex')}`. Two parallel tool calls arriving in the same millisecond will have different random suffixes, so IDs don't collide. This is fine — flagged only for completeness.

---

## Other findings (observed while reading the code)

- **`SubagentRecord.prompt` has no sanitization or secret scanning.** It's the full `tool_input` stringified and truncated. For a `Bash` tool with a shell command containing `ANTHROPIC_API_KEY=...` in the command string, that API key ends up in session state on disk (`.git/origin-session-<tag>.json`). The session-state file is mode `0o600`, but still worth flagging.
- **No cleanup on session end.** Sub-agent records accumulate in `SessionState.subagents` for the full session lifetime. A long-running session with thousands of tool calls will have a growing JSON array. Not a bug, but memory for a long idle claude session can balloon.
- **`pre-tool-use` handler fires a `saveSessionState` per tool call.** Hundreds of tool calls in a session = hundreds of JSON file writes. Mild performance cost, not incorrect.
- **The post-tool-use handler checks `state.subagents && state.subagents.length > 0`** but pre-tool-use always pushes, so the length is always > 0 after the first pre-use. The guard is redundant. Not a bug.

---

## Recommended follow-up changes (not done in this stage — awaiting approval)

Ranked by value / cost.

### R1. Fix the parallel matching bug. *(cheap, real bug.)*
Swap the name-based lookup in `handlePostToolUse` for ID-based:
```ts
const toolCallId = input.tool_call_id || input.tool_use_id;
if (toolCallId) {
  const record = state.subagents.find(r => r.toolCallId === toolCallId);
  ...
}
```
Fall back to the reverse-find-by-name for agents that don't send IDs. ~15 lines changed.

### R2. Rename `SubagentRecord` → `ToolCallRecord`. *(cheap, clarifies.)*
What we track is tool calls, not sub-agents. The misnomer has led us to misleading marketing ("sub-agent tracking") and will keep confusing future contributors. Non-functional rename touches ~10 files. Flag for a cleanup PR.

### R3. Detect real sub-agents as a separate record type. *(medium, enables marketing.)*
Add `SubagentSpawn` that's only recorded when `toolName === 'Task'`. Fields:
```ts
interface SubagentSpawn {
  toolCallId: string;
  subagentType: string | null;  // from tool_input.subagent_type
  description: string | null;   // from tool_input.description
  prompt: string | null;
  startedAt: string;
  endedAt?: string;
  filesChanged?: string[];  // best-effort, see R4
  linesAdded?: number;
  linesRemoved?: number;
  result?: string;
}
```
Stored on `SessionState.subagentSpawns[]`. Now "this session used 3 sub-agents" is a real, correct statement.

### R4. Attribute files changed inside a sub-agent to that sub-agent.
This is the big one. Currently impossible because the commit-level git note records one `model`. To fix:

- During `handleStop` transcript parsing, we already compute per-prompt file mappings (`promptMappings`). Extend this to also detect Task-spawned tool calls by transcript cross-reference — the transcript records which parent turn each tool call belongs to, and Task-spawned `Write`/`Edit` calls appear as nested tool calls under the Task.
- When writing git notes, include a `subagents` array in the JSON payload: each entry = `{ subagentType, model, filesChanged, linesAdded }`.
- `origin blame` / `origin stats` would need per-sub-agent rollup. The `byModel` map in `computeAttributionStats` already carries per-model counts; extend to also carry per-subagent-type counts.

This is ~4 hours of careful work and requires confirming Claude Code's transcript format actually nests Task sub-calls. If it doesn't, we can't do this reliably and R4 should be dropped.

### R5. Redact secrets from `SubagentRecord.prompt` and `result`.
Run the same secret redactor used in other places through the truncation. ~5 lines.

### R6. Extend the trailer to mention sub-agents.
After R3 lands: `Origin-Session: abc123 | Claude Code | 3 prompts | 2 subagents`. Trivial. Needs a flag so we only count real Task spawns, not the 400 Bash calls.

---

## What I would NOT do

- **Don't retroactively invent per-sub-agent blame.** Without transcript-level evidence of which sub-agent wrote which line, any attribution would be a lie.
- **Don't split sub-agents into separate Origin API sessions.** That would fragment the billing/session-replay model for no real gain. Sub-agents are a detail of how a parent session did its work.
- **Don't mark R2 as urgent.** The `SubagentRecord` name is misleading but nothing is functionally broken by the name alone.

---

## Impact on Stages 3 and 4 of the current task

- **Stage 3 (idempotency tests for `origin enable`)**: unaffected.
- **Stage 4 (`AGENT_HOOKS.md` plugin spec)**: I should document `SubagentRecord` as "tool-call record" (its real shape) and explicitly note that sub-agent identity is not captured. Don't want the spec claiming a feature we don't have.

## Decision needed

1. Approve R1 (parallel matching bug fix)? It's a real bug, cheap to fix.
2. Approve or defer R3 (proper sub-agent spawn tracking)? Blocks any honest "sub-agent support" marketing.
3. Approve or defer R4 (per-sub-agent file attribution)? Needed for `origin blame` to tell the truth about mixed-model sessions.
4. Approve R2 (rename `SubagentRecord`)? Codebase hygiene.

Waiting on your call before any code lands.
