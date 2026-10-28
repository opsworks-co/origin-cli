// An agent started for an issue must be a session of its own. Started from
// inside another agent's session — a terminal Claude Code opened, Terminal.app
// launched by an agent — it inherits that session's markers, and Claude Code
// then runs as its CHILD: transcript saving off, host session ids and
// messaging sockets pointing at the parent. Origin reads the transcript, so
// the run loses its tokens and turns. Strip the markers before launching.

import { execFileSync } from 'child_process';

/** Environment variables one agent session sets for the processes it starts. */
export const AGENT_SESSION_ENV = /^(ORIGIN_HEADLESS_RUN|CLAUDECODE|CLAUDE_CODE_[A-Z0-9_]*|CLAUDE_AGENT_SDK_[A-Z0-9_]*|CLAUDE_PID|CLAUDE_EFFORT|CLAUDE_PREVIEW_[A-Z0-9_]*|CODEX_THREAD_ID|CODEX_SANDBOX[A-Z0-9_]*|CODEX_MANAGED_BY_[A-Z0-9_]*)$/;

/** `env` without another agent session's markers. */
export function freshAgentEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(env)) if (!AGENT_SESSION_ENV.test(k)) out[k] = v;
  return out;
}

/**
 * Set on a headless run Origin starts (`origin issue start --background`).
 * Hooks inherit the agent's environment, so Origin's own SessionEnd hook can
 * tell this run's exit is the end of the session: Claude Code's SessionEnd
 * is otherwise only a Stop, because the desktop app also fires it on reconnect.
 */
export const HEADLESS_RUN_ENV = 'ORIGIN_HEADLESS_RUN';

/**
 * Claude Code gives SessionEnd hooks max(1.5 s, their configured timeout)
 * before it cancels them, which is less than ending a session and uploading
 * its last rows takes. The headless run waits on its hooks anyway.
 */
export const HEADLESS_SESSION_END_BUDGET_MS = 60_000;

/** The environment for a headless run: fresh, marked, with room for SessionEnd. */
export function headlessAgentEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return {
    ...freshAgentEnv(env),
    [HEADLESS_RUN_ENV]: '1',
    CLAUDE_CODE_SESSIONEND_HOOKS_TIMEOUT_MS: String(HEADLESS_SESSION_END_BUDGET_MS),
  };
}

/** The SessionEnd reason headless-run-end.ts sends: the wrapper saw the agent process exit. */
export const HEADLESS_RUN_EXITED = 'headless_run_exited';

/** Is this hook running inside a headless run Origin started? */
export function isHeadlessRun(env: NodeJS.ProcessEnv = process.env): boolean {
  return env[HEADLESS_RUN_ENV] === '1';
}

/** The command line of process `pid`, or null when it can't be read (gone, Windows). */
export function processArgs(pid: number): string | null {
  try {
    const out = execFileSync('ps', ['-o', 'args=', '-p', String(pid)], {
      encoding: 'utf-8', timeout: 2000, windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    return out || null;
  } catch {
    return null;
  }
}

/**
 * Is the Claude Code process this hook runs under a one-shot `claude -p`?
 * Its SessionEnd fires once, as it exits after its prompt — the end of the
 * session, like a headless run Origin started. The process's own command line
 * decides it: CLAUDE_PID is set fresh for every Claude process, while
 * CLAUDE_CODE_ENTRYPOINT is inherited, so a `claude -p` run from inside a
 * desktop session reads "claude-desktop". A `-p` that takes stream-json input
 * is a long-lived host process (the desktop app runs that way and restarts it
 * on reconnect), so it stays a Stop. Unreadable → not one-shot.
 */
export function isClaudeOneShotRun(
  env: NodeJS.ProcessEnv = process.env,
  readArgs: (pid: number) => string | null = processArgs,
): boolean {
  const pid = Number(env.CLAUDE_PID);
  if (!Number.isInteger(pid) || pid <= 0) return false;
  const args = readArgs(pid)?.split(/\s+/) ?? [];
  if (!args.includes('-p') && !args.includes('--print')) return false;
  const streamInput = args.includes('--input-format=stream-json')
    || args.some((a, i) => a === '--input-format' && args[i + 1] === 'stream-json');
  return !streamInput;
}

/**
 * The same, as a POSIX shell line for a launch script: unsets every inherited
 * marker. Settings a person exports in their rc files come back when the
 * login shell after it reads them.
 */
export const UNSET_AGENT_SESSION_ENV_SH =
  `for v in $(env | sed -n 's/^\\([A-Z0-9_]*\\)=.*/\\1/p' | grep -E '${AGENT_SESSION_ENV.source}'); do unset "$v"; done`;
