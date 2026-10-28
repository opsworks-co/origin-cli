// A scoped permission set for a Cursor background run.
//
// Headless `cursor-agent -p` runs only the shell commands the user's
// ~/.cursor/cli-config.json allows; anything else is refused. A typical config
// allows almost nothing (2026-10-13: `Shell(ls)` only), so a background run
// could read and grep but never `git status` or commit. The alternative —
// `--force` — runs everything, which is the blanket bypass background runs
// don't get (see antigravity-scope.ts).
//
// Cursor also reads permissions from the project it runs in,
// `<project>/.cursor/cli.json`. So each background run's worktree gets one,
// allowing exactly git and a few read-only commands, and denying the network
// tools; it is removed when the run ends, and git is told to ignore it so the
// agent can't commit it. A worktree whose repo already has its own
// .cursor/cli.json is left alone — that repo decides.
import fs from 'fs';
import path from 'path';
import { spawnSync } from 'child_process';

/** Commands a Cursor background run may execute: git, and read-only inspection. */
export const CURSOR_BACKGROUND_COMMANDS = ['git', 'ls', 'cat', 'head', 'tail', 'grep', 'rg', 'wc', 'pwd', 'diff'] as const;
const CURSOR_DENIED_COMMANDS = ['curl', 'wget', 'ssh', 'scp', 'nc', 'sudo'] as const;

export function cursorScopeFile(worktree: string): string {
  return path.join(worktree, '.cursor', 'cli.json');
}

/** The permissions a run's worktree gets. Pure. */
export function cursorScope(): { permissions: { allow: string[]; deny: string[] } } {
  return {
    permissions: {
      allow: [...CURSOR_BACKGROUND_COMMANDS.map((c) => `Shell(${c})`), 'Read(**)', 'Write(**)'],
      deny: CURSOR_DENIED_COMMANDS.map((c) => `Shell(${c})`),
    },
  };
}

const EXCLUDE_LINE = '/.cursor/cli.json';

/** Keep the scope file out of the agent's commits: the repo's info/exclude. Best effort. */
function excludeFromGit(worktree: string): void {
  try {
    const r = spawnSync('git', ['rev-parse', '--git-path', 'info/exclude'], { cwd: worktree, encoding: 'utf-8' });
    const rel = (r.stdout || '').trim();
    if (r.status !== 0 || !rel) return;
    const file = path.isAbsolute(rel) ? rel : path.resolve(worktree, rel);
    const current = fs.existsSync(file) ? fs.readFileSync(file, 'utf-8') : '';
    if (current.split('\n').some((l) => l.trim() === EXCLUDE_LINE)) return;
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.appendFileSync(file, `${current && !current.endsWith('\n') ? '\n' : ''}# origin: Cursor background-run permissions\n${EXCLUDE_LINE}\n`);
  } catch { /* the agent is also told not to commit it */ }
}

/**
 * Write a run's scope into its worktree. Returns the file (removed by the
 * supervisor at the end), or null when the repo already has its own.
 */
export function writeCursorScope(worktree: string): string | null {
  const file = cursorScopeFile(worktree);
  if (fs.existsSync(file)) return null;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(cursorScope(), null, 2) + '\n');
  excludeFromGit(worktree);
  return file;
}

/** Remove a run's scope — only the exact file this module wrote. */
export function removeCursorScope(file: string | null | undefined): void {
  if (!file || path.basename(file) !== 'cli.json' || path.basename(path.dirname(file)) !== '.cursor') return;
  try {
    const content = JSON.parse(fs.readFileSync(file, 'utf-8'));
    if (JSON.stringify(content) !== JSON.stringify(cursorScope())) return; // changed since: not ours to delete
    fs.unlinkSync(file);
    const dir = path.dirname(file);
    if (fs.readdirSync(dir).length === 0) fs.rmdirSync(dir);
  } catch { /* already gone */ }
}

/** Told to the agent up front, so it doesn't spend the run retrying refused commands. */
export function cursorBackgroundNote(): string {
  return `This run is unattended. Shell commands allowed: ${CURSOR_BACKGROUND_COMMANDS.join(', ')}. `
    + 'Any other command is refused. Edit files with your file tools, inside this repository only. '
    + 'Do not commit .cursor/cli.json.';
}
