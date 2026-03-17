import chalk from 'chalk';
import { execSync } from 'child_process';
import { getGitRoot } from '../session-state.js';
import { searchPrompts, getPromptsBySession } from '../local-db.js';
import path from 'path';

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
  try {
    const raw = execSync(`git notes --ref=origin show ${sha} 2>/dev/null`, {
      encoding: 'utf-8', cwd, stdio: ['pipe', 'pipe', 'pipe'],
    }).trim();
    const parsed = JSON.parse(raw);
    const data = parsed.origin || parsed;
    return { sessionId: data.sessionId, model: data.model };
  } catch {
    return null;
  }
}

function getCommitDiff(sha: string, cwd: string, filePath?: string): string {
  try {
    const fileArg = filePath ? `-- "${filePath}"` : '';
    return execSync(`git diff ${sha}~1..${sha} --stat --patch ${fileArg} 2>/dev/null`, {
      encoding: 'utf-8', cwd, stdio: ['pipe', 'pipe', 'pipe'],
      maxBuffer: 1024 * 1024,
    }).trim();
  } catch {
    // Might be the initial commit
    try {
      const fileArg = filePath ? `-- "${filePath}"` : '';
      return execSync(`git diff --root ${sha} --stat --patch ${fileArg} 2>/dev/null`, {
        encoding: 'utf-8', cwd, stdio: ['pipe', 'pipe', 'pipe'],
        maxBuffer: 1024 * 1024,
      }).trim();
    } catch {
      return '';
    }
  }
}

function getPromptsForSession(sessionId: string, cwd: string): string[] {
  // Try local DB first
  const dbPrompts = getPromptsBySession(sessionId);
  if (dbPrompts.length > 0) {
    return dbPrompts.map((p) => p.promptText);
  }

  // Try origin-sessions branch
  try {
    const raw = execSync(
      `git show origin-sessions:sessions/${sessionId}/prompts.md 2>/dev/null`,
      { encoding: 'utf-8', cwd, stdio: ['pipe', 'pipe', 'pipe'] }
    ).trim();
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
  const cwd = process.cwd();
  const repoRoot = getGitRoot(cwd);
  if (!repoRoot) {
    console.log(chalk.red('Not inside a git repository.'));
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
    const log = execSync(
      `git log --follow --format="%H|%aI|%s" -n ${limit * 2} -- "${relPath}" 2>/dev/null`,
      { encoding: 'utf-8', cwd: repoRoot, stdio: ['pipe', 'pipe', 'pipe'] }
    ).trim();
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
