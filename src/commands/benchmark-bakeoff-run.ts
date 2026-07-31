// Auto-run for bake-offs: drive each agent HEADLESS in its own worktree so a
// bake-off finishes on its own instead of the human running every agent by
// hand. Each agent gets the same prompt, works autonomously in an isolated
// worktree/branch, and whatever it leaves is committed so Origin can correlate
// the arm's session by branch (see benchmark-bakeoff.ts + SPEC P3).
//
// Only agents with a real non-interactive CLI can be driven this way. The table
// below is the single source of truth; an agent whose binary isn't installed is
// skipped (never fails the whole run). Flags lean autonomous on purpose — the
// blast radius is a throwaway worktree, nothing else.

import chalk from 'chalk';
import fs from 'fs';
import path from 'path';
import { spawnSync } from 'child_process';
import { runDetailed, findExecutable } from '../utils/exec.js';
import { agentEnvWithKey, type AgentKeys } from '../agent-keys.js';

/** How to invoke one agent non-interactively with a prompt. */
export interface AgentRunner {
  /** Executable to look up on PATH. */
  bin: string;
  /** Full arg vector for a one-shot autonomous run of `prompt`. */
  buildArgs: (prompt: string) => string[];
  /** Human label if the slug isn't obvious. */
  label?: string;
  /** Env var this agent reads its API key from — set so the runner can inject a
   *  stored/local key when the interactive login isn't reachable (headless). */
  keyEnvVar?: string;
}

// Keyed by Origin agent slug. Kept deliberately small — only the agents whose
// headless mode actually edits files and exits. Add a row to support more.
export const AGENT_RUNNERS: Record<string, AgentRunner> = {
  // Claude Code print-mode runs the full agent loop (tools + edits) and exits;
  // skip-permissions so it never blocks on a prompt in a non-interactive run.
  'claude-code': {
    bin: 'claude',
    buildArgs: (p) => ['-p', p, '--dangerously-skip-permissions'],
    keyEnvVar: 'ANTHROPIC_API_KEY',
  },
  // Codex non-interactive exec: runs autonomously with workspace write access.
  codex: {
    bin: 'codex',
    buildArgs: (p) => ['exec', '--full-auto', p],
    keyEnvVar: 'OPENAI_API_KEY',
  },
  // Cursor's headless agent (best-effort — flags vary by version).
  cursor: {
    bin: 'cursor-agent',
    buildArgs: (p) => ['-p', p, '--force'],
  },
};

export interface ArmRunResult {
  agentSlug: string;
  /** 'ran' = agent executed; 'skipped' = no runner / binary missing; 'error' = non-zero exit. */
  outcome: 'ran' | 'skipped' | 'error';
  reason?: string;
  committed: boolean;
  durationMs: number;
}

/** True if the worktree has uncommitted changes. */
function isDirty(worktree: string): boolean {
  const r = runDetailed('git', ['status', '--porcelain'], { cwd: worktree, timeoutMs: 10_000 });
  return r.status === 0 && r.stdout.trim().length > 0;
}

// Origin's OWN files that end up in a bake-off worktree but are not the agent's
// work: the runner writes BAKEOFF_PROMPT.md, and Origin's session hooks inject a
// context block into these managed docs. If a commit were made of nothing but
// these, an arm that did nothing would mint a false "completed" session.
const RUNNER_PROMPT_FILE = 'BAKEOFF_PROMPT.md';
const ORIGIN_MANAGED_DOCS = ['AGENTS.md', 'CLAUDE.md'];
const ORIGIN_MANAGED_MARKER = 'Origin: Session tracking active';

/** Remove Origin's own scaffolding from a dirty worktree so it can neither form
 *  nor pollute an arm's commit: delete the runner's BAKEOFF_PROMPT.md, and
 *  restore any Origin-managed doc (AGENTS.md / CLAUDE.md) whose only change is
 *  the injected context block. A bake-off task that legitimately edits those
 *  docs is out of scope — attribution correctness wins here. */
function dropOriginScaffolding(worktree: string): void {
  try { fs.rmSync(path.join(worktree, RUNNER_PROMPT_FILE), { force: true }); } catch { /* absent */ }
  for (const doc of ORIGIN_MANAGED_DOCS) {
    const abs = path.join(worktree, doc);
    let managed = false;
    try { managed = fs.readFileSync(abs, 'utf-8').includes(ORIGIN_MANAGED_MARKER); } catch { continue; /* absent */ }
    if (!managed) continue;
    const tracked = runDetailed('git', ['ls-files', '--error-unmatch', doc], { cwd: worktree, timeoutMs: 10_000 }).status === 0;
    if (tracked) {
      // Injection MODIFIED a committed doc — restore it to HEAD.
      runDetailed('git', ['checkout', 'HEAD', '--', doc], { cwd: worktree, timeoutMs: 10_000 });
    } else {
      // Injection CREATED the doc — remove it entirely.
      try { fs.rmSync(abs, { force: true }); } catch { /* ignore */ }
    }
  }
}

/** Stage + commit the agent's real work, so the arm's branch has a commit to
 *  correlate. No-op (returns false) when the agent self-committed (clean tree)
 *  or left nothing but Origin's own scaffolding — never manufacture a commit
 *  out of the prompt file / injected context. */
function commitLeftovers(worktree: string, agentSlug: string, prompt: string): boolean {
  if (!isDirty(worktree)) return false;      // agent self-committed, or did nothing tracked
  dropOriginScaffolding(worktree);
  if (!isDirty(worktree)) return false;      // only Origin's scaffolding was dirty → no real work
  runDetailed('git', ['add', '-A'], { cwd: worktree, timeoutMs: 15_000 });
  const subject = `bake-off(${agentSlug}): ${prompt.replace(/\s+/g, ' ').slice(0, 60)}`;
  const c = runDetailed('git', ['commit', '-m', subject], { cwd: worktree, timeoutMs: 20_000 });
  return c.status === 0;
}

/** Drive one agent in its worktree. Streams the agent's own output live
 *  (stdio inherit) so the user watches it work; long timeout for a real task. */
export function runArm(
  agentSlug: string,
  worktree: string,
  prompt: string,
  opts: { timeoutMs?: number; keys?: AgentKeys } = {},
): ArmRunResult {
  const start = Date.now();
  const runner = AGENT_RUNNERS[agentSlug];
  if (!runner) {
    return { agentSlug, outcome: 'skipped', reason: 'no headless runner for this agent', committed: false, durationMs: 0 };
  }
  const bin = findExecutable(runner.bin, { cwd: worktree });
  if (!bin) {
    return { agentSlug, outcome: 'skipped', reason: `\`${runner.bin}\` not found on PATH`, committed: false, durationMs: 0 };
  }

  console.log(chalk.gray(`\n  ── ${agentSlug} working (${runner.bin}) …\n`));
  // Inject the agent's API key (stored/local) when the shell doesn't already
  // carry it — so headless auth works without the interactive Keychain login.
  const env = agentEnvWithKey(runner.keyEnvVar, opts.keys ?? {});
  const r = spawnSync(bin, runner.buildArgs(prompt), {
    cwd: worktree,
    stdio: 'inherit',
    timeout: opts.timeoutMs ?? 30 * 60 * 1000, // 30 min — a real task, not a git call
    env,
    windowsHide: true,
  });
  const durationMs = Date.now() - start;

  // Only capture work when the agent actually succeeded. On error/timeout we
  // commit NOTHING — otherwise Origin's own scaffolding (the injected
  // BAKEOFF_PROMPT.md + managed-doc context block) would be the entire commit,
  // minting a false "completed" session for an arm that produced no code.
  if (r.status !== 0) {
    const reason = r.signal ? `killed (${r.signal}${r.signal === 'SIGTERM' ? ' — timed out' : ''})` : `exit ${r.status ?? -1}`;
    return { agentSlug, outcome: 'error', reason, committed: false, durationMs };
  }
  const committed = commitLeftovers(worktree, agentSlug, prompt);
  return { agentSlug, outcome: 'ran', committed, durationMs };
}

/** Run every arm sequentially. Sequential on purpose: several autonomous agents
 *  in parallel would thrash one machine, and interleaved live output is
 *  unreadable. */
export function runBakeOffArms(
  arms: Array<{ agentSlug: string; worktree: string }>,
  prompt: string,
  opts: { timeoutMs?: number; keys?: AgentKeys } = {},
): ArmRunResult[] {
  const results: ArmRunResult[] = [];
  for (const arm of arms) {
    results.push(runArm(arm.agentSlug, arm.worktree, prompt, opts));
  }
  return results;
}
