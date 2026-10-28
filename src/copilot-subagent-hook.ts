// ── Copilot sub-agent hooks are not the user's session ──────────────────────
// Copilot CLI ≥1.0.81 re-emits a sub-agent's hook events through the parent's
// hooks. A `task` sub-agent (foreground or background) fires its own
// userPromptSubmitted — `sessionId` is the sub-agent's id, `prompt` is the
// dispatch text the parent wrote — and its own agentStop, whose
// `transcriptPath` is the PARENT's events.jsonl. Origin took the first for a
// new session and auto-created one for the dispatch text (Copilot 1.0.96,
// 2026-10-15: session be13e47a beside the real a26689f2), and ran a full Stop
// pass for the second in the middle of the parent's turn.
//
// The sub-agent's own events (user.message, assistant.message, usage) are
// written into the parent's events.jsonl stamped with a top-level `agentId`,
// and the transcript converter handles them there. The hooks carry nothing new.
import fs from 'fs';
import os from 'os';
import path from 'path';

function defaultStateDir(): string {
  return path.join(os.homedir(), '.copilot', 'session-state');
}

/** Recent events.jsonl files to look through for a sub-agent's start. */
const MAX_FILES = 8;
const RECENT_MS = 60 * 60 * 1000;
const MAX_BYTES = 64 * 1024 * 1024;

function startedAsSubagent(sessionId: string, stateDir: string): boolean {
  let dirs: string[];
  try { dirs = fs.readdirSync(stateDir); } catch { return false; }
  const cutoff = Date.now() - RECENT_MS;
  const files: Array<{ file: string; mtime: number; size: number }> = [];
  for (const d of dirs) {
    const file = path.join(stateDir, d, 'events.jsonl');
    try {
      const st = fs.statSync(file);
      if (st.mtimeMs >= cutoff) files.push({ file, mtime: st.mtimeMs, size: st.size });
    } catch { /* not a session dir */ }
  }
  files.sort((a, b) => b.mtime - a.mtime);
  // `"agentId":"<id>"` is how Copilot stamps every event the sub-agent writes
  // into its parent's log, starting with `subagent.started` — which lands
  // before the sub-agent's first hook fires.
  const needle = `"agentId":"${sessionId}"`;
  for (const { file, size } of files.slice(0, MAX_FILES)) {
    if (size > MAX_BYTES) continue;
    try {
      if (fs.readFileSync(file, 'utf-8').includes(needle)) return true;
    } catch { /* raced with a rotation */ }
  }
  return false;
}

/**
 * True when this Copilot hook was fired for a sub-agent rather than for the
 * user's session. agentStop says so directly (its transcript belongs to
 * another session id). userPromptSubmitted carries only the sub-agent's id:
 * a real session has its own `session-state/<id>/` directory by the time its
 * first hook runs, a sub-agent never does, and it appears as `agentId` in its
 * parent's events.jsonl. When neither signal is readable, the hook is kept.
 */
export function isCopilotSubagentHook(
  input: Record<string, unknown>,
  stateDir: string = defaultStateDir(),
): boolean {
  const sessionId = [input.session_id, input.sessionId]
    .find((id): id is string => typeof id === 'string' && id.length > 0);
  if (!sessionId) return false;
  const transcript = [input.transcript_path, input.transcriptPath]
    .find((p): p is string => typeof p === 'string' && p.length > 0);
  if (transcript) {
    if (path.basename(transcript) !== 'events.jsonl') return false;
    const owner = path.basename(path.dirname(transcript));
    return owner.length > 0 && owner !== sessionId;
  }
  if (fs.existsSync(path.join(stateDir, sessionId))) return false;
  return startedAsSubagent(sessionId, stateDir);
}
