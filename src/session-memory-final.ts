// The memory entry a session leaves when it really ends.
//
// A session's entry in the repo memory note was written by the SessionEnd
// handler and, with `memoryUpdate: commit`, at each commit. For Claude Code the
// first never runs: its desktop app fires SessionEnd on reconnect as well as on
// exit, so the hook is handled as a Stop (session-end.ts), and the real end is
// the heartbeat noticing the transcript has gone idle. So every Claude Code
// entry was whatever the LAST COMMIT left — on this repo each one's `endedAt`
// sat a minute or two after its final commit, and a session whose last commit
// was a merge was remembered by the agent's narration of that moment.
//
// This runs from the heartbeat's end, where the transcript is complete.
import { buildMemoryEntry } from './commands/hooks/session-end.js';
import { commitDecisionsFor, committedSessionMarkers, currentTurnStart, withTurnDiffs } from './committed-markers.js';
import {
  enrichDecisionsForSession, memoryUpdateTrigger, readSessionMemoryEntry, sessionCommitSubjects, shouldWriteMemoryOnSessionEnd,
  summarizeFromCommitSubjects, writeSessionMemory,
} from './memory.js';
import { parseMarkersFromTranscriptPath, readMarkerTurns } from './origin-markers.js';
import { parseTranscript } from './transcript.js';

export interface EndingSessionState {
  sessionId: string;
  repoPath?: string;
  startedAt: string;
  agentSlug?: string;
  model?: string;
  branch?: string | null;
  prompts?: string[];
  transcriptPath?: string | null;
  linesAdded?: number;
  linesRemoved?: number;
  sessionCommitShas?: string[];
  currentTurnStartedAt?: number;
  promptSubmittedAt?: string[];
  promptIndexBase?: number;
  completedPromptMappings?: Array<{ promptIndex: number; diff?: string | null; uncommittedDiff?: string | null }>;
}

/**
 * Write the session's final memory entry. Returns true when one was written.
 *
 * Writes when the config asks for session-end memory, or when the session
 * already has an entry — `memoryUpdate: commit` means "remember sessions that
 * commit", and finishing the entry of one that did is still that; starting one
 * for a session that never committed would not be.
 *
 * The summary is the session's commit subjects (all of them, not the last),
 * then the agent's last message, then the opening prompt — the same order the
 * SessionEnd handler uses when it has no LLM summary.
 */
export function writeFinalSessionMemory(state: EndingSessionState): boolean {
  const repoPath = state.repoPath;
  if (!repoPath || !state.sessionId || !state.startedAt) return false;
  const existing = readSessionMemoryEntry(repoPath, state.sessionId);
  if (!existing && !shouldWriteMemoryOnSessionEnd(memoryUpdateTrigger())) return false;

  let lastMessage = '';
  if (state.transcriptPath) {
    try {
      lastMessage = parseTranscript(state.transcriptPath, { since: state.startedAt }).summary || '';
    } catch { /* best-effort */ }
  }
  // The agent writes its markers in the reply AFTER a commit, so the commit
  // records were frozen without them: fill each from the turn that made it,
  // then remember only what the committing turns wrote. Closes stay whole —
  // they are checked against what landed (todo-sweep.ts).
  let markers: ReturnType<typeof parseMarkersFromTranscriptPath> | undefined;
  try {
    const turns = withTurnDiffs(readMarkerTurns(state.transcriptPath), state);
    const turnStart = currentTurnStart(state);
    enrichDecisionsForSession(repoPath, state.sessionId,
      commitDecisionsFor(repoPath, state.sessionId, turns, { currentTurnStartedAt: turnStart }));
    const committed = committedSessionMarkers({
      repoPath, sessionId: state.sessionId, turns,
      commitShas: state.sessionCommitShas, currentTurnStartedAt: turnStart,
    });
    const closes = parseMarkersFromTranscriptPath(state.transcriptPath || undefined)?.closes;
    markers = committed || closes ? { ...(committed || {}), ...(closes ? { closes } : {}) } : undefined;
  } catch { /* best-effort */ }

  const prompts = (state.prompts && state.prompts.length > 0) ? state.prompts : undefined;
  const summary = summarizeFromCommitSubjects(sessionCommitSubjects(repoPath, state.sessionId))
    || lastMessage.trim()
    || undefined;
  // Files and line counts are the ones the entry already carries:
  // writeSessionMemory unions files and keeps the larger count, so passing
  // what is there only ever keeps it.
  writeSessionMemory(repoPath, buildMemoryEntry(
    { ...state, prompts: state.prompts || [], branch: state.branch ?? existing?.branch ?? null },
    {
      agentSlug: state.agentSlug || existing?.agentSlug,
      model: state.model && state.model !== 'unknown' ? state.model : (existing?.model || 'unknown'),
      branch: state.branch ?? existing?.branch ?? null,
      filesChanged: existing?.filesChanged || [],
      linesAdded: Math.max(state.linesAdded || 0, existing?.linesAdded || 0),
      linesRemoved: Math.max(state.linesRemoved || 0, existing?.linesRemoved || 0),
      summary,
      prompts,
      fileNotes: existing?.fileNotes,
      decisions: [...(markers?.decision || []), ...(existing?.decisions || [])],
      markers,
    },
  ));
  return true;
}
