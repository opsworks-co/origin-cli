// Pure reap-decision logic for the heartbeat, extracted so it can be unit-
// tested without importing heartbeat.ts (which starts the ping daemon at module
// load). heartbeat.ts feeds this the live signals each tick.

export interface LivenessInputs {
  // The pid captured at session-start (the process that fired the hook). >0 for
  // terminal/CLI agents; ≤0 for hookless-IDE agents (e.g. Cursor) we can't tie
  // to a pid.
  recordedParentPid: number;
  // isProcessAlive(recordedParentPid) — whether that exact pid is still running.
  recordedParentAlive: boolean;
  // isTranscriptStale() — transcript mtime older than the idle window (false
  // when there's no transcript path: inconclusive, not proof of death).
  transcriptStale: boolean;
  // isStateFileStale() — Origin's own self-bumped state file went stale (only a
  // meaningful death signal for hookless agents with no pid).
  stateFileStale: boolean;
  // isAgentActivelyWriting() — the agent's transcript/rollout was touched within
  // the idle window: positive proof it's alive right now.
  agentActivelyWriting: boolean;
  // turnInProgress() — a prompt was submitted and no Stop has closed it yet.
  // The agent is working on that prompt whether or not anything on disk
  // moves, so it is proof of life in its own right. See turnInProgress.
  turnInProgress?: boolean;
}

// A hook-driven turn that has been OPENED (user-prompt-submit) and not yet
// CLOSED (Stop) is an agent at work, and that is true even when nothing on
// disk moves for the whole turn.
//
// Cursor flushes its agent transcript at the END of a generation. A long
// generation therefore looks, from the outside, exactly like a closed window:
// no transcript write, no pid to watch, only Origin's own state file moving.
// The 20-minute hookless-IDE window then reaped a live turn. Prod session
// c1e361a4: the prompt landed 23:14:55, the agent read and thought until
// 23:44 and edited seven files, Stop came at 23:45:30 — and the heartbeat
// ended the session at 23:36:37, in the middle of it. The edits at 23:44
// found no session to land on, and the next prompt minted a twin.
//
// The two timestamps are written by the hooks alone — the heartbeat never
// touches them — so unlike the state file's mtime they cannot be kept warm by
// Origin itself. Capped: a turn that dies without a Stop (API error, an
// interrupt, the app quit mid-generation) stays "open" forever, so past
// OPEN_TURN_MAX_MS the veto lapses and the ordinary signals decide.
export const OPEN_TURN_MAX_MS = 90 * 60 * 1000;

export function turnInProgress(
  state: { currentTurnStartedAt?: number | null; lastTurnClosedAt?: number | null } | null | undefined,
  nowMs: number = Date.now(),
): boolean {
  const opened = state?.currentTurnStartedAt;
  if (typeof opened !== 'number' || !Number.isFinite(opened) || opened <= 0) return false;
  const closed = state?.lastTurnClosedAt;
  if (typeof closed === 'number' && Number.isFinite(closed) && closed >= opened) return false;
  const age = nowMs - opened;
  return age >= 0 && age <= OPEN_TURN_MAX_MS;
}

// True when the agent behind this session looks gone (the heartbeat then reaps
// it after PARENT_DEAD_TICKS_BEFORE_END consecutive true results).
//
// Fresh transcript/rollout activity is positive proof of life and VETOES every
// death signal — including a dead recorded parent pid. That veto is the fix for
// the split-session bug: across a machine sleep or an app restart the recorded
// pid dies while the SAME chat continues under a new pid, so reaping on the dead
// pid alone tore an actively-resumed Codex Desktop session in two (the
// continuation auto-created a fresh duplicate session). See
// isAgentActivelyWriting in heartbeat.ts.
export interface HeartbeatOwnershipInputs {
  // Whether the pid file for this session still exists at all.
  pidFileExists: boolean;
  // The pid recorded INSIDE that file, or null when it's missing/unparseable.
  pidFileOwner: number | null;
  // This daemon's own process id.
  myPid: number;
}

// True when this heartbeat process no longer owns its session's pid file and
// must exit.
//
// startHeartbeat() calls stopHeartbeat() before spawning, but two hooks firing
// concurrently race: both spawn, and the second overwrites the pid file with
// its own pid. The loser kept running forever, because the only ownership
// check was `fs.existsSync(pidFile)` — and the file DOES still exist, it just
// names the other process. Those losers accumulate as orphaned daemons that
// ping (and keep bumping session state) long after the agent is gone, holding
// sessions RUNNING indefinitely. Observed live: session 9e2ef3aa with pid file
// 9218 while daemon 8107 was still pinging.
//
// Deliberately conservative — an unreadable/garbage pid file is NOT treated as
// proof of supersession, because falsely tearing down the live daemon is worse
// than one lingering tick.
export function heartbeatSuperseded(i: HeartbeatOwnershipInputs): boolean {
  if (!i.pidFileExists) return true;
  if (i.pidFileOwner === null || !Number.isFinite(i.pidFileOwner) || i.pidFileOwner <= 0) return false;
  return i.pidFileOwner !== i.myPid;
}

// True when the state file this daemon was started on now belongs to ANOTHER
// registered session, so nothing will ever write to ours again.
//
// The daemon is spawned with a session id and a state-file path, and every
// tick it reads the file and pushes its contents under that id. The file is
// keyed by conversation tag, not by session id — so when a second
// registration lands on the same tag, the file's `sessionId` changes and the
// daemon keeps going, feeding the other session's prompts and diffs to a row
// that has no owner. Prod 2026-09-09: the daemon for 5431ff0f read a file that
// had become e24477e2's, and the dashboard showed both rows live for eleven
// minutes with the same turn on each.
//
// A provisional id in the file is not a takeover: a hook holding a stale
// reservation can briefly write `local-…` back, and between two placeholders
// the incumbent wins (preferRegisteredSessionId). Only a DIFFERENT registered
// id means the row moved.
export function stateFileTakenOver(i: { ownSessionId: string; fileSessionId: string | null | undefined }): boolean {
  if (!i.fileSessionId || i.fileSessionId === i.ownSessionId) return false;
  return !i.fileSessionId.startsWith('local-');
}

// The server's ping response can report a session in a state that is
// DEFINITIVELY terminal for THIS machine — the user or an admin archived it, or
// it no longer exists in the org (deleted → status 'NOT_FOUND'). These differ
// from a plain COMPLETED/ENDED/ABANDONED, which the server sometimes stamps
// while the agent is still alive (a collapsed sibling conversation, a premature
// auto-end); those keep the "parent still alive → keep pinging" grace so a live
// agent's next prompt isn't orphaned.
//
// Archived / deleted carry no such ambiguity: the session is intentionally
// hidden from Origin, so the heartbeat must stop and drop local state
// immediately, REGARDLESS of whether the agent parent is still alive. Otherwise
// a still-open IDE window keeps a heartbeat pinging an archived session forever
// and `origin status` lists a session the web dashboard no longer shows — the
// exact CLI/web drift users report.
export function isServerTerminalDefinitive(
  resp: { status?: string; archived?: boolean } | null | undefined,
): boolean {
  if (!resp) return false;
  if (resp.archived === true) return true;
  return resp.status === 'NOT_FOUND' || resp.status === 'DELETED';
}

export function parentLooksDead(i: LivenessInputs): boolean {
  if (i.agentActivelyWriting) return false;
  // An open turn is the agent working right now — see turnInProgress.
  if (i.turnInProgress) return false;
  const processConfirmedAlive = i.recordedParentPid > 0 && i.recordedParentAlive;
  return (
    // A recorded pid we can prove is dead.
    (i.recordedParentPid > 0 && !i.recordedParentAlive) ||
    // No live-process signal AND the agent stopped writing its transcript —
    // catches the hookless-IDE zombie (parentPid=0, pings forever after close).
    (!processConfirmedAlive && i.transcriptStale) ||
    // Hookless agent with no pid: fall back to our own state-file staleness.
    (i.recordedParentPid <= 0 && i.stateFileStale)
  );
}

// ─── Transcript-idle policy ───────────────────────────────────────────────
//
// How long the agent's transcript must sit untouched before it counts as
// evidence the agent is gone — and it depends on what else we can see.
//
// A HOOKLESS IDE agent (Cursor, Antigravity) gives us one signal and one only:
// no pid to watch, and a state file something other than its lifecycle keeps
// warm. The short window is the only thing that catches its zombie heartbeat
// pinging on after the window closed.
//
// Every other agent fires lifecycle hooks, each bumping the state file through
// saveSessionState, and signals a real close through SessionEnd. For those the
// transcript is a BACKSTOP, not the primary signal — and at a flat 20 minutes
// it ended live conversations the moment the user stepped away. Claude Code
// sits here: LONG_RUNNING_AGENTS is ['devin'] alone, so its recorded pid is 0
// and parentLooksDead reaped it on the transcript clause by itself (prod
// 0a8e2164 went quiet 16:35 -> 18:48 and was ended, taking its prompt history
// with it).
//
// The backstop matches the window the state-file signal already applies to the
// same pid-less agents, so the two now agree instead of the shorter one
// quietly winning.
export const HOOKLESS_IDE_IDLE_MS = 20 * 60 * 1000;
export const HOOK_DRIVEN_IDLE_MS = 90 * 60 * 1000;

const HOOKLESS_IDE_AGENTS = new Set(['cursor', 'antigravity']);

// An unknown agent gets the LONGER window deliberately. Reaping a live session
// corrupts the record — numbering restarts against a server that kept the
// conversation — while a zombie lingering an extra hour costs a stale row the
// server's own no-ping sweep clears.
export function transcriptIdleWindowMs(slug: string): number {
  return HOOKLESS_IDE_AGENTS.has((slug || '').toLowerCase())
    ? HOOKLESS_IDE_IDLE_MS
    : HOOK_DRIVEN_IDLE_MS;
}
