import chalk from 'chalk';
import { getGitRoot } from '../session-state.js';
import { searchPrompts, getPromptsBySession } from '../local-db.js';
import { isConnectedMode } from '../config.js';
import path from 'path';
import { git, runDetailed } from '../utils/exec.js';

const HEX = /^[a-fA-F0-9]{4,64}$/;

interface CommitPromptInfo {
  sha: string;
  date: string;
  message: string;
  sessionId: string;
  model: string;
  prompts: string[];
  diff?: string;
}

function readNoteForSha(sha: string, cwd: string): { sessionId?: string; model?: string } | null {
  if (!HEX.test(sha)) return null;
  const r = runDetailed('git', ['notes', '--ref=origin', 'show', sha], { cwd });
  if (r.status !== 0) return null;
  try {
    const parsed = JSON.parse(r.stdout.trim());
    const data = parsed.origin || parsed;
    return { sessionId: data.sessionId, model: data.model };
  } catch {
    return null;
  }
}

function getCommitDiff(sha: string, cwd: string, filePath?: string): string {
  if (!HEX.test(sha)) return '';
  const fileArgs = filePath ? ['--', filePath] : [];
  const opts = { cwd, maxBuffer: 1024 * 1024 };
  const r = runDetailed('git', ['diff', `${sha}~1..${sha}`, '--stat', '--patch', ...fileArgs], opts);
  if (r.status === 0) return r.stdout.trim();
  // Might be the initial commit
  const r2 = runDetailed('git', ['diff', '--root', sha, '--stat', '--patch', ...fileArgs], opts);
  if (r2.status === 0) return r2.stdout.trim();
  return '';
}

function getPromptsForSession(sessionId: string, cwd: string): string[] {
  // Try local DB first
  const dbPrompts = getPromptsBySession(sessionId);
  if (dbPrompts.length > 0) {
    return dbPrompts.map((p) => p.promptText);
  }

  // Try origin-sessions branch
  if (!/^[a-zA-Z0-9_.-]+$/.test(sessionId)) return [];
  const r = runDetailed('git', ['show', `origin-sessions:sessions/${sessionId}/prompts.md`], { cwd });
  if (r.status !== 0) return [];
  try {
    const raw = r.stdout.trim();
    // Parse prompts from markdown — each prompt starts with ## Prompt
    const prompts: string[] = [];
    const sections = raw.split(/^## Prompt \d+/m).slice(1);
    for (const section of sections) {
      const text = section.replace(/^\s*\n/, '').replace(/\n### (Response|Metadata)[\s\S]*$/, '').trim();
      if (text) prompts.push(text);
    }
    return prompts;
  } catch {
    return [];
  }
}

export async function promptsCommand(filePath: string, opts: { expand?: boolean; limit?: string }) {
  // If the argument looks like a session ID (hex, 8+ chars, no path separators),
  // show prompts for that session from the platform API
  const isSessionId = /^[a-f0-9]{8,}$/i.test(filePath) && !filePath.includes('/') && !filePath.includes('.');
  if (isSessionId) {
    return showSessionPrompts(filePath);
  }

  const cwd = process.cwd();
  const repoRoot = getGitRoot(cwd);
  if (!repoRoot) {
    console.log(chalk.red('Not inside a git repository. Run from a repo, or pass a session ID to view prompts.'));
    process.exit(1);
  }

  const limit = parseInt(opts.limit || '10', 10);
  const showDiff = !!opts.expand;

  // Resolve file path relative to repo root
  const absPath = path.resolve(cwd, filePath);
  const relPath = path.relative(repoRoot, absPath);

  // Get all commits that touched this file
  let commits: { sha: string; date: string; message: string }[];
  try {
    const r = runDetailed(
      'git',
      ['log', '--follow', '--format=%H|%aI|%s', '-n', String(limit * 2), '--', relPath],
      { cwd: repoRoot }
    );
    const log = r.status === 0 ? r.stdout.trim() : '';
    if (!log) {
      console.log(chalk.yellow(`\n  No commits found for ${relPath}\n`));
      return;
    }
    commits = log.split('\n').filter(Boolean).map((line) => {
      const [sha, date, ...msgParts] = line.split('|');
      return { sha, date, message: msgParts.join('|') };
    });
  } catch {
    console.log(chalk.red(`  Could not read git log for ${relPath}`));
    return;
  }

  // Filter to AI commits (those with origin notes)
  const aiCommits: CommitPromptInfo[] = [];
  for (const commit of commits) {
    const note = readNoteForSha(commit.sha, repoRoot);
    if (note?.sessionId) {
      const prompts = getPromptsForSession(note.sessionId, repoRoot);
      const entry: CommitPromptInfo = {
        ...commit,
        sessionId: note.sessionId,
        model: note.model || 'unknown',
        prompts,
      };
      if (showDiff) {
        entry.diff = getCommitDiff(commit.sha, repoRoot, relPath);
      }
      aiCommits.push(entry);
      if (aiCommits.length >= limit) break;
    }
  }

  if (aiCommits.length === 0) {
    console.log(chalk.yellow(`\n  No AI prompts found for ${chalk.white(relPath)}`));
    console.log(chalk.gray('  This file may have been written entirely by humans,'));
    console.log(chalk.gray('  or sessions haven\'t been tracked yet.\n'));
    return;
  }

  console.log(chalk.bold(`\n  ${relPath}`) + chalk.gray(` — ${aiCommits.length} AI session${aiCommits.length > 1 ? 's' : ''} touched this file\n`));

  for (const commit of aiCommits) {
    const date = new Date(commit.date);
    const dateStr = date.toLocaleString('en-US', {
      month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false,
    });

    // Header line
    console.log(
      chalk.gray(`  ${dateStr}  `) +
      chalk.cyan(commit.model.padEnd(22)) +
      chalk.gray(`(${commit.sha.slice(0, 8)})`)
    );

    // Prompts
    if (commit.prompts.length > 0) {
      for (const prompt of commit.prompts) {
        const truncated = prompt.length > 120 ? prompt.slice(0, 117) + '...' : prompt;
        console.log(chalk.white(`  > "${truncated}"`));
      }
    } else {
      console.log(chalk.gray(`  > (prompts not captured for this session)`));
    }

    // Commit message
    console.log(chalk.gray(`    ${commit.message}`));

    // Diff (if --expand)
    if (showDiff && commit.diff) {
      console.log(chalk.gray('    ─────────────────────────────────────'));
      const lines = commit.diff.split('\n');
      for (const line of lines) {
        if (line.startsWith('+') && !line.startsWith('+++')) {
          console.log(chalk.green(`    ${line}`));
        } else if (line.startsWith('-') && !line.startsWith('---')) {
          console.log(chalk.red(`    ${line}`));
        } else if (line.startsWith('@@')) {
          console.log(chalk.cyan(`    ${line}`));
        } else {
          console.log(chalk.gray(`    ${line}`));
        }
      }
      console.log(chalk.gray('    ─────────────────────────────────────'));
    }

    console.log(''); // spacing between entries
  }

  console.log(chalk.gray(`  Tip: Use ${chalk.cyan('--expand')} to see the actual code changes per prompt`));
  console.log(chalk.gray(`       Use ${chalk.cyan('origin session <id>')} to see the full transcript\n`));
}

/**
 * Show prompts for a session by ID — fetches from platform API.
 * Works from any directory (no git repo required).
 */
async function showSessionPrompts(sessionId: string): Promise<void> {
  if (!isConnectedMode()) {
    console.log(chalk.red('Not connected to Origin. Run `origin login` first, or use a file path instead.'));
    process.exit(1);
  }

  const { api } = await import('../api.js');

  try {
    const session = await api.getSession(sessionId) as any;
    if (!session) {
      console.log(chalk.red(`Session ${sessionId} not found.`));
      process.exit(1);
    }

    const model = session.model || session.agentName || 'unknown';
    const status = (session.status || 'ENDED').toUpperCase();
    const startedAt = session.startedAt || session.createdAt;
    const dateStr = startedAt
      ? new Date(startedAt).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false })
      : '—';

    console.log(chalk.bold(`\n  Session ${chalk.cyan(sessionId.slice(0, 8))}`) +
      chalk.gray(` — ${model} — ${status} — ${dateStr}\n`));

    const prompts = session.promptChanges || [];
    if (prompts.length === 0) {
      // Fall back to session.prompt field
      if (session.prompt) {
        console.log(chalk.white(`  1. "${session.prompt}"`));
        console.log(chalk.gray(`     (no per-prompt breakdown available)\n`));
      } else {
        console.log(chalk.yellow('  No prompts captured for this session.'));
        console.log(chalk.gray('  Prompts are recorded when the session ends.\n'));
      }
      return;
    }

    for (const pc of prompts) {
      const idx = (pc.promptIndex ?? 0) + 1;
      const text = pc.promptText || '(empty)';
      const files = Array.isArray(pc.filesChanged) ? pc.filesChanged : [];

      console.log(chalk.white(`  ${idx}. "${text}"`));
      if (files.length > 0) {
        console.log(chalk.gray(`     Files: ${files.join(', ')}`));
      }
      console.log('');
    }

    console.log(chalk.gray(`  ${prompts.length} prompt${prompts.length === 1 ? '' : 's'} total`));
    console.log(chalk.gray(`  View full session: ${chalk.cyan(`origin explain ${sessionId.slice(0, 8)}`)}\n`));
  } catch (err: any) {
    console.log(chalk.red(`Failed to fetch session: ${err.message || 'unknown error'}`));
    process.exit(1);
  }
}
