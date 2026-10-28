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
// This runs from the heartbeat's end, where the transcript is complete — and
// again from post-commit when the person commits the session's work by hand
// after it ended (rememberCommitAfterEnd).
import { buildMemoryEntry } from './commands/hooks/session-end.js';
import { shouldIncludePromptText } from './prompt-privacy.js';
import { commitDecisionsFor, commitEvidence, committedSessionMarkers, currentTurnStart, withTurnDiffs } from './committed-markers.js';
import {
  enrichDecisionsForSession, memoryUpdateTrigger, readSessionMemoryEntry, sessionCommitSubjects, shouldWriteMemoryOnSessionEnd,
  summarizeFromCommitSubjects, writeSessionMemory,
} from './memory.js';
import { parseMarkersFromTranscriptPath, readMarkerTurns, type CommitEvidence } from './origin-markers.js';
import { parseTranscript } from './transcript.js';
import { gitOrNull } from './utils/exec.js';

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
  completedPromptMappings?: Array<{
    promptIndex: number; diff?: string | null; uncommittedDiff?: string | null;
    filesChanged?: string[]; discardedFiles?: string[];
  }>;
}

/**
 * The files the session's turns changed, as Stop recorded them, less the ones
 * a turn wrote and put back. Pure — exported for testing.
 */
export function turnFilesChanged(state: Pick<EndingSessionState, 'completedPromptMappings'>): string[] {
  const out = new Set<string>();
  for (const m of state.completedPromptMappings || []) {
    const discarded = new Set(m.discardedFiles || []);
    for (const f of m.filesChanged || []) if (f && !discarded.has(f)) out.add(f);
  }
  return [...out];
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
  const afterEnd = commitsAfterEnd(repoPath, state);
  // A commit of its work after it ended is the session committing, which
  // `memoryUpdate: commit` asks to remember too.
  if (!existing && afterEnd.length === 0 && !shouldWriteMemoryOnSessionEnd(memoryUpdateTrigger())) return false;

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
      commits: afterEnd,
    });
    const closes = parseMarkersFromTranscriptPath(state.transcriptPath || undefined)?.closes;
    markers = committed || closes ? { ...(committed || {}), ...(closes ? { closes } : {}) } : undefined;
  } catch { /* best-effort */ }

  const prompts = (state.prompts && state.prompts.length > 0) ? state.prompts : undefined;
  const summary = summarizeFromCommitSubjects(sessionCommitSubjects(repoPath, state.sessionId))
    || lastMessage.trim()
    || undefined;
  // Files: the ones each turn recorded, plus any the entry already carries.
  // With the default `memoryUpdate: session-end` no commit wrote an entry
  // first, so the entry's own list was empty and every Claude Code session
  // was remembered with line counts but no files. Line counts are the
  // larger of the two — writeSessionMemory keeps the larger count anyway.
  writeSessionMemory(repoPath, buildMemoryEntry(
    { ...state, prompts: state.prompts || [], branch: state.branch ?? existing?.branch ?? null },
    {
      agentSlug: state.agentSlug || existing?.agentSlug,
      model: state.model && state.model !== 'unknown' ? state.model : (existing?.model || 'unknown'),
      branch: state.branch ?? existing?.branch ?? null,
      filesChanged: [...new Set([...(existing?.filesChanged || []), ...turnFilesChanged(state)])],
      linesAdded: Math.max(state.linesAdded || 0, existing?.linesAdded || 0),
      linesRemoved: Math.max(state.linesRemoved || 0, existing?.linesRemoved || 0),
      summary,
      prompts,
      includePromptText: shouldIncludePromptText(repoPath),
      fileNotes: existing?.fileNotes,
      decisions: [...(markers?.decision || []), ...(existing?.decisions || [])],
      markers,
    },
  ));
  return true;
}

const MAX_COMMITS_AFTER_END = 50;

/**
 * The commits made by hand after the session ended that carry its trailer —
 * prepare-commit-msg stamps one when the staged lines are the ones the session
 * recorded (ended-session-commit-owner.ts). No turn made them, so each brings
 * back only the turns whose work is in it.
 *
 * Read from git rather than kept on the state, so every rewrite of the entry
 * sees all of them: the heartbeat's at the end, then one per such commit.
 */
export function commitsAfterEnd(repoPath: string, state: Pick<EndingSessionState, 'sessionId' | 'startedAt' | 'sessionCommitShas'>): CommitEvidence[] {
  const id = (state.sessionId || '').slice(0, 12).toLowerCase();
  if (!/^[0-9a-f-]{8,12}$/.test(id) || !state.startedAt) return [];
  const log = gitOrNull(
    ['log', `--since=${state.startedAt}`, '-n', String(MAX_COMMITS_AFTER_END), '-i', '-E', `--grep=^Origin-Session: *${id}`, '--format=%H', 'HEAD'],
    { cwd: repoPath, timeoutMs: 10_000 },
  );
  if (!log) return [];
  const own = new Set((state.sessionCommitShas || []).map((s) => s.toLowerCase()));
  const shas = log.split('\n').map((l) => l.trim()).filter((sha) => sha && !own.has(sha.toLowerCase()));
  if (shas.length === 0) return [];
  const evidence = commitEvidence(repoPath, shas);
  return shas.map((sha) => evidence.get(sha)).filter((ev): ev is CommitEvidence => !!ev).map((ev) => ({ ...ev, afterEnd: true }));
}
