// A scoped permission set for an Antigravity background run.
//
// Headless `agy -p` cannot ask for permission, so anything not granted is
// refused and the run stops. Its `--mode accept-edits` grants file edits and
// no shell at all (the first `git status` ended the run), which pushed
// background runs onto `--dangerously-skip-permissions --sandbox`.
//
// Antigravity keeps permission grants per PROJECT
// (`~/.gemini/config/projects/<id>.json`, `permissionGrants.allow`), and a
// run picks its project with `--project <id>`. So each background run gets a
// project of its own, granted exactly:
//   - reading and writing files inside its worktree;
//   - `git`, which it needs to inspect and commit its work;
//   - a few read-only commands (ls, cat, grep, …);
// with internet access denied, and the project file removed when the run
// ends. Verified against agy 2026-10-13: git status, a new file and a commit
// work; `curl` is refused; so are `git status && touch /tmp/x` and
// `cat a > /tmp/x` — grants are checked per command, not by prefix of the line.
import crypto from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';

/** Commands an Antigravity background run may execute: git, and read-only inspection. */
export const ANTIGRAVITY_BACKGROUND_COMMANDS = ['git', 'ls', 'cat', 'head', 'tail', 'grep', 'rg', 'wc', 'pwd', 'diff'] as const;

/**
 * Origin MCP tools a background run may call (server `origin`, mcp/install.ts):
 * reading repo memory, which Origin's startup check tells it to do first, and
 * recording TODOs, decisions and task claims. Ungranted, the first
 * `get_repo_memory` call was refused and ended the run (2c762dea, 2026-10-16).
 * Session control and admin tools are left out. Grants are per tool: agy
 * takes `mcp(<server>/<tool>)` and rejects `mcp(*)`.
 */
export const ANTIGRAVITY_BACKGROUND_MCP_TOOLS = [
  'get_repo_memory', 'get_file_context', 'search_history', 'get_session', 'list_sessions',
  'list_tasks', 'take_task', 'release_task', 'finish_task',
  'add_todo', 'close_todo', 'record_decision', 'check_file_access', 'log_tool_call',
] as const;

export function antigravityProjectsDir(home: string = os.homedir()): string {
  return path.join(home, '.gemini', 'config', 'projects');
}

/** The project a background run in `worktree` uses: its grants and settings. */
export function backgroundProject(id: string, worktree: string, label: string): Record<string, unknown> {
  return {
    id,
    name: `origin background ${label}`.slice(0, 80),
    projectResources: { resources: [{ gitFolder: { folderUri: `file://${worktree}` } }] },
    permissionGrants: {
      permissionGrants: {
        allow: [
          ...ANTIGRAVITY_BACKGROUND_COMMANDS.map((c) => `command(${c})`),
          ...ANTIGRAVITY_BACKGROUND_MCP_TOOLS.map((t) => `mcp(origin/${t})`),
          `read_file(${worktree})`,
          `write_file(${worktree})`,
        ],
      },
    },
    settings: {
      // Anything not granted above is asked about — and headless, refused.
      fileAccessPolicy: 'AGENT_SETTING_POLICY_ASK',
      internetPolicy: 'AGENT_SETTING_POLICY_DENY',
      autoExecutionPolicy: 'CASCADE_COMMANDS_AUTO_EXECUTION_OFF',
      artifactReviewMode: 'ARTIFACT_REVIEW_MODE_ALWAYS',
    },
    updatedAt: new Date().toISOString(),
  };
}

/** Write a run's project; returns its id and file (removed by the supervisor at the end). */
export function createBackgroundProject(worktree: string, label: string, home?: string): { id: string; file: string } {
  const id = crypto.randomUUID();
  const dir = antigravityProjectsDir(home);
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${id}.json`);
  fs.writeFileSync(file, JSON.stringify(backgroundProject(id, worktree, label), null, 2) + '\n');
  return { id, file };
}

/** Remove a run's project — only a file this module wrote, inside the projects dir. */
export function removeBackgroundProject(file: string | null | undefined, home?: string): void {
  if (!file) return;
  const dir = antigravityProjectsDir(home);
  if (path.dirname(path.resolve(file)) !== path.resolve(dir)) return;
  try {
    const p = JSON.parse(fs.readFileSync(file, 'utf-8'));
    if (!String(p?.name || '').startsWith('origin background ')) return;
  } catch { return; }
  try { fs.unlinkSync(file); } catch { /* already gone */ }
}

/** Told to the agent up front, so it does not end its own run on a refused command. */
export function antigravityBackgroundNote(): string {
  return `This run is unattended. Shell commands allowed: ${ANTIGRAVITY_BACKGROUND_COMMANDS.join(', ')}. `
    + 'Any other command, or a command chained with && ; | or a redirect, is refused and ends the run. '
    + `Origin MCP tools allowed: ${ANTIGRAVITY_BACKGROUND_MCP_TOOLS.join(', ')}; any other MCP tool is refused and ends the run. `
    + 'Edit files with your file tools, inside this repository only. There is no network access.';
}

/** Headless agy's own words when it refused something: it then exits 0 having done nothing. */
export const ANTIGRAVITY_REFUSAL = /headless mode cannot prompt for, so it was auto-denied/;
