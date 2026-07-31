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

export function parentLooksDead(i: LivenessInputs): boolean {
  if (i.agentActivelyWriting) return false;
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
