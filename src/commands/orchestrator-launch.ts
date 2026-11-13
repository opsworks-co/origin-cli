// The runner daemon's part in the orchestrator's live mode
// (apps/api services/orchestrator/live.ts): a run the orchestrator queued for
// this machine is launched exactly as a person would launch it —
// `origin issue start <id> --agent <a> --background --force` in a checkout of
// the repo — so the worktree, the pre-start check, the time limit and the
// pull request at the end all work the same. The launch returns as soon as the
// agent is going; the server follows the run from its IssueRun.
//
// --force: the orchestrator already checked nobody is on the issue; a stale
// run record from an earlier attempt must not stop it.
// --repo-id: the run's repo. The same fullName can be a repo row in two
// workspaces, and the checkout routes to only one of them (2026-10-29: a run
// on another workspace's opsworks-co/origin found "no issue" in Origin HQ's).
import { spawn } from 'child_process';

export interface ClaimedOrchestratorRun {
  id: string;
  repoFullName: string;
  shortId: string;
  agent: string;
  /** The run's Origin repo; an older server leaves it out. */
  repoId?: string | null;
  /** A split run: split this scope into tasks instead of starting the issue (orchestrator-scope.ts). */
  scopeId?: string | null;
}

export interface LaunchResult {
  ok: boolean;
  output: string;
}

/** How long a launch (the pre-start check included) may take before it is called failed. */
export const LAUNCH_TIMEOUT_MS = 20 * 60 * 1000;
const OUTPUT_KEEP = 4000;

/** The argv that launches the run with this same CLI. */
export function launchArgv(run: ClaimedOrchestratorRun, self: [string, string]): [string, string[]] {
  // --background: returns once the split is going, like `issue start --background`.
  if (run.scopeId) return [self[0], [self[1], 'orchestrator', 'split', run.scopeId, '--background']];
  return [self[0], [self[1], 'issue', 'start', run.shortId, '--agent', run.agent, '--background', '--force', ...(run.repoId ? ['--repo-id', run.repoId] : [])]];
}

/** Runs the launch in `cwd`; resolves with whether it exited 0 and the tail of its output. */
export function launchOrchestratorRun(run: ClaimedOrchestratorRun, cwd: string, self: [string, string], env: NodeJS.ProcessEnv = process.env, timeoutMs = LAUNCH_TIMEOUT_MS): Promise<LaunchResult> {
  const [bin, args] = launchArgv(run, self);
  return new Promise((resolve) => {
    let out = '';
    const keep = (b: Buffer) => { out = (out + b.toString('utf-8')).slice(-OUTPUT_KEEP); };
    let child;
    try {
      // NO_COLOR: the output goes to the server as plain text.
      child = spawn(bin, args, { cwd, env: { ...env, NO_COLOR: '1', FORCE_COLOR: '0' }, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    } catch (err: any) {
      resolve({ ok: false, output: `could not start: ${err?.message || err}` });
      return;
    }
    const timer = setTimeout(() => { keep(Buffer.from(`\n[runner] gave up after ${Math.round(timeoutMs / 60000)} min`)); child.kill('SIGTERM'); }, timeoutMs);
    timer.unref?.();
    child.stdout?.on('data', keep);
    child.stderr?.on('data', keep);
    child.on('error', (err) => { clearTimeout(timer); resolve({ ok: false, output: `${out}\n${err.message}`.trim() }); });
    child.on('close', (code) => { clearTimeout(timer); resolve({ ok: code === 0, output: out.trim() }); });
  });
}
