// End the Origin session of a headless run when its agent exits.
//
// `origin issue start --background` runs an agent headless in a worktree of
// its own. Its exit is the end of the session, but most agents never say so:
// Codex has no SessionEnd hook, Copilot fires sessionEnd after every turn,
// and cursor-agent's print mode is not known to fire one. Origin then waited
// for the idle sweep, about 90 minutes, before it marked the run ended.
//
// The background wrapper knows when the agent exits, so it calls
// `origin issue run-ended <record>`, which ends every session still open in
// the run's worktree through the same SessionEnd handler a hook would reach.
// The run is marked headless (ORIGIN_HEADLESS_RUN), so that handler ends the
// session instead of treating the event as a Stop. A session the agent's own
// hook already ended (Claude Code) is skipped.
import { execFileSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { HEADLESS_RUN_ENV, HEADLESS_RUN_EXITED } from './agent-env.js';

/** The Origin agent slug each `--agent` records its sessions under. */
const SESSION_AGENT: Record<string, string> = {
  claude: 'claude-code',
  codex: 'codex',
  gemini: 'gemini',
  cursor: 'cursor',
  copilot: 'copilot',
  antigravity: 'antigravity',
};

export function sessionAgentFor(agent: string): string {
  return SESSION_AGENT[agent] ?? agent;
}

export interface RunRecord {
  shortId: string;
  agent: string;
  worktree: string;
  startedAt: string;
}

export interface OpenRunSession {
  sessionId: string;
  agentSlug: string;
  /** The agent's own id for the conversation, which hooks send. */
  agentSessionId: string | null;
  transcriptPath: string | null;
}

function within(dir: string, p: unknown): boolean {
  if (typeof p !== 'string' || !p) return false;
  const rel = path.relative(dir, p);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

/**
 * Sessions still open in the run's worktree, started by this run: state files
 * in the repo's common .git (where a worktree's sessions live) and the
 * ~/.origin/sessions fallback, of the run's agent, started no earlier than a
 * minute before it.
 */
export function openRunSessions(
  run: RunRecord,
  gitDir: string | null,
  mirrorDir: string,
): OpenRunSession[] {
  const agentSlug = sessionAgentFor(run.agent);
  const since = Date.parse(run.startedAt) - 60_000;
  let worktree = run.worktree;
  try { worktree = fs.realpathSync(run.worktree); } catch { /* compare as given */ }
  const seen = new Set<string>();
  const out: OpenRunSession[] = [];
  const sources: Array<[string, RegExp]> = [
    ...(gitDir ? [[gitDir, /^origin-session.*\.json$/] as [string, RegExp]] : []),
    [mirrorDir, /\.json$/],
  ];
  for (const [dir, pattern] of sources) {
    let entries: string[] = [];
    try { entries = fs.readdirSync(dir); } catch { continue; }
    for (const entry of entries) {
      if (!pattern.test(entry)) continue;
      let s: any;
      try { s = JSON.parse(fs.readFileSync(path.join(dir, entry), 'utf-8')); } catch { continue; }
      if (!s || typeof s.sessionId !== 'string' || seen.has(s.sessionId)) continue;
      if (String(s.status || '').toUpperCase() === 'ENDED') continue;
      if ((s.agentSlug || 'claude-code') !== agentSlug) continue;
      const started = Date.parse(s.startedAt || '');
      if (!Number.isFinite(started) || started < since) continue;
      const real = (p: unknown) => { try { return typeof p === 'string' ? fs.realpathSync(p) : p; } catch { return p; } };
      if (!within(worktree, real(s.lastCwd)) && !within(worktree, real(s.repoPath))) continue;
      seen.add(s.sessionId);
      out.push({
        sessionId: s.sessionId,
        agentSlug,
        agentSessionId: (typeof s.agentSessionId === 'string' && s.agentSessionId) || (typeof s.claudeSessionId === 'string' && s.claudeSessionId) || null,
        transcriptPath: typeof s.transcriptPath === 'string' ? s.transcriptPath : null,
      });
    }
  }
  return out;
}

/** The SessionEnd payload a hook would have sent for this session. */
export function sessionEndInput(run: RunRecord, s: OpenRunSession): Record<string, unknown> {
  return {
    hook_event_name: 'SessionEnd',
    reason: HEADLESS_RUN_EXITED,
    cwd: run.worktree,
    session_id: s.agentSessionId ?? undefined,
    // Cursor names its conversation here, not in session_id.
    conversation_id: s.agentSlug === 'cursor' ? s.agentSessionId ?? undefined : undefined,
    transcript_path: s.transcriptPath ?? undefined,
  };
}

function commonGitDir(cwd: string): string | null {
  try {
    const d = execFileSync('git', ['rev-parse', '--git-common-dir'], { cwd, encoding: 'utf-8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    return path.isAbsolute(d) ? d : path.resolve(cwd, d);
  } catch { return null; }
}

/** `origin issue run-ended <record>`: called by the background wrapper after the agent exits. */
export async function runEndedAction(recordFile: string): Promise<void> {
  let run: RunRecord;
  try { run = JSON.parse(fs.readFileSync(recordFile, 'utf-8')); } catch { return; }
  if (!run?.worktree || !run.agent || !run.startedAt) return;
  const open = openRunSessions(run, commonGitDir(run.worktree), path.join(os.homedir(), '.origin', 'sessions'));
  if (open.length === 0) return;
  process.env[HEADLESS_RUN_ENV] = '1';
  const { handleSessionEnd } = await import('./commands/hooks/session-end.js');
  for (const s of open) {
    try { await handleSessionEnd(sessionEndInput(run, s), s.agentSlug); } catch { /* the idle sweep is the fallback */ }
  }
}
