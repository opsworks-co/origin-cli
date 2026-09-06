// One place that knows what an agent's sub-agent SPAWNER is called.
//
// Sub-agent capture was gated on `tool_name === 'task'` in two separate
// places. Claude Code then renamed the spawner from `Task` to `Agent`, and the
// condition became unsatisfiable — so `subagentSpawns` was never populated
// again. Measured across 114 local sessions: ZERO spawns recorded, ever, while
// the same sessions logged 66 `TaskOutput`, 6 `TaskStop` and 1 `ListAgents`
// call. You cannot read a sub-agent's output 66 times without spawning one.
//
// Nothing failed. The feature was built, tested, shipped and documented, and
// then quietly stopped being reachable — the same shape as the write-journal
// watcher that exited instantly and the ledger that ran after its own payload
// was sent. A capability keyed to an EXTERNAL name is only ever one rename away
// from silently doing nothing.
//
// So this module holds the name in one place, accepts every spelling we know
// of, and — more importantly — provides the CONTRADICTION CHECK below, because
// the next rename cannot be predicted and no test can be written against a
// string that does not exist yet.

/**
 * Tools that SPAWN a sub-agent.
 *
 * `task` is Claude Code's historical name and is kept: an older client, a
 * replayed offline queue, and other agents' transcripts still use it. `agent`
 * is the current one.
 */
export const SUBAGENT_SPAWN_TOOLS = new Set(['task', 'agent']);

/**
 * Tools that only make sense once a sub-agent EXISTS — reading its output,
 * stopping it, listing them.
 *
 * These are the tell. They are named differently from the spawner, so a
 * spawner rename leaves them untouched, and their presence alongside zero
 * recorded spawns is a contradiction rather than a plausible session.
 */
export const SUBAGENT_COMPANION_TOOLS = new Set(['taskoutput', 'taskstop', 'listagents']);

/** Does this tool call spawn a sub-agent? Case-insensitive; never throws. */
export function isSubagentSpawnTool(toolName: string | null | undefined): boolean {
  return SUBAGENT_SPAWN_TOOLS.has(String(toolName ?? '').trim().toLowerCase());
}

/** Does this tool call operate on an ALREADY-SPAWNED sub-agent? */
export function isSubagentCompanionTool(toolName: string | null | undefined): boolean {
  return SUBAGENT_COMPANION_TOOLS.has(String(toolName ?? '').trim().toLowerCase());
}

/**
 * Has the spawner been renamed out from under us?
 *
 * A session that read, stopped or listed sub-agents but recorded NONE being
 * spawned is describing something that cannot have happened. The likeliest
 * cause by far is that the spawn tool is now called something this build does
 * not recognise — which is exactly how this went unnoticed for weeks.
 *
 * Deliberately one-directional. Companions WITHOUT spawns is a contradiction;
 * spawns without companions is ordinary (a sub-agent whose result the parent
 * never polled). Only the first is reported.
 *
 * Returns the unrecognised tool names seen in the same session, so the warning
 * can name a candidate instead of just saying something is wrong. A caller
 * that has no tool-name list still gets the boolean via an empty array.
 */
export function detectRenamedSpawner(
  toolNames: readonly string[],
  spawnCount: number,
): { broken: boolean; companionsSeen: string[]; candidates: string[] } {
  const seen = (toolNames || []).map((n) => String(n ?? '').trim().toLowerCase()).filter(Boolean);
  const companionsSeen = [...new Set(seen.filter((n) => isSubagentCompanionTool(n)))];
  if (spawnCount > 0 || companionsSeen.length === 0) {
    return { broken: false, companionsSeen, candidates: [] };
  }
  // Anything unrecognised is a candidate for the new spawner name. Ordinary
  // tools (bash, edit, read) are excluded by the known-tool list rather than
  // by guessing at what a spawner might be called — the next name is exactly
  // the thing we cannot predict.
  const ordinary = new Set([
    'bash', 'read', 'edit', 'write', 'glob', 'grep', 'ls', 'multiedit',
    'notebookedit', 'webfetch', 'websearch', 'todowrite', 'skill', 'monitor',
    'toolsearch', 'sendmessage', 'artifact', 'askuserquestion',
  ]);
  const candidates = [...new Set(
    seen.filter((n) => !ordinary.has(n)
      && !isSubagentCompanionTool(n)
      && !isSubagentSpawnTool(n)
      && !n.startsWith('mcp__')),
  )];
  return { broken: true, companionsSeen, candidates };
}
