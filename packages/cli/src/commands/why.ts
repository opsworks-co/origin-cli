import chalk from 'chalk';
import path from 'path';
import { getGitRoot } from '../session-state.js';
import { getLineBlame, LineAttribution } from '../attribution.js';
import { isConnectedMode } from '../config.js';
import { git, runDetailed } from '../utils/exec.js';

const HEX = /^[a-fA-F0-9]{4,64}$/;

function formatDuration(ms: number): string {
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${s % 60}s`;
  const h = Math.floor(m / 60);
  return `${h}h ${m % 60}m`;
}

// ─── origin why <file>:<line> ────────────────────────────────────────────
// Tells you WHY a specific line exists — which AI session and prompt wrote it.

function parseFileAndLine(input: string): { file: string; line?: number } {
  // Support: file.ts:42, file.ts 42, file.ts
  const colonMatch = input.match(/^(.+):(\d+)$/);
  if (colonMatch) return { file: colonMatch[1], line: parseInt(colonMatch[2], 10) };
  return { file: input };
}

function readOriginNote(repoPath: string, sha: string): any | null {
  if (!HEX.test(sha)) return null;
  const r = runDetailed('git', ['notes', '--ref=origin', 'show', sha], { cwd: repoPath });
  if (r.status !== 0) return null;
  try {
    const parsed = JSON.parse(r.stdout.trim());
    return parsed.origin || parsed;
  } catch {
    return null;
  }
}

function getCommitForLine(repoPath: string, filePath: string, lineNum: number): string | null {
  if (!Number.isInteger(lineNum) || lineNum < 1) return null;
  try {
    const output = git(
      ['blame', '-L', `${lineNum},${lineNum}`, '--porcelain', '--', filePath],
      { cwd: repoPath }
    ).trim();
    const match = output.match(/^([0-9a-f]{40})/);
    return match ? match[1] : null;
  } catch {
    return null;
  }
}

function getCommitInfo(repoPath: string, sha: string): { date: string; author: string; message: string } | null {
  if (!HEX.test(sha)) return null;
  try {
    const info = git(
      ['log', '-1', '--format=%aI|%an|%s', sha],
      { cwd: repoPath }
    ).trim();
    const [date, author, ...msgParts] = info.split('|');
    return { date, author, message: msgParts.join('|') };
  } catch {
    return null;
  }
}

async function showLineWhy(repoPath: string, filePath: string, lineNum: number): Promise<void> {
  const relPath = path.relative(repoPath, path.resolve(process.cwd(), filePath));

  // Get file content for display
  const fullPath = path.resolve(repoPath, relPath);
  let lineContent = '';
  try {
    const { readFileSync } = await import('fs');
    const lines = readFileSync(fullPath, 'utf-8').split('\n');
    lineContent = lines[lineNum - 1] || '';
  } catch { /* ignore */ }

  console.log(chalk.bold(`\n  Line ${lineNum} in ${relPath}`));
  if (lineContent) {
    console.log(chalk.gray(`  ${lineContent.trimStart()}`));
  }
  console.log('');

  // Step 1: git blame to find commit SHA
  const commitSha = getCommitForLine(repoPath, relPath, lineNum);
  if (!commitSha || commitSha.startsWith('0000000')) {
    console.log(chalk.yellow('  Uncommitted change — not yet attributed.\n'));
    return;
  }

  // Step 2: get commit info
  const commitInfo = getCommitInfo(repoPath, commitSha);
  const dateStr = commitInfo?.date
    ? new Date(commitInfo.date).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })
    : '—';

  // Step 3: check git notes for Origin session
  const note = readOriginNote(repoPath, commitSha);

  if (!note?.sessionId) {
    // Human-written or Origin wasn't tracking
    console.log(chalk.white(`  Written by ${chalk.cyan(commitInfo?.author || 'unknown')} · ${dateStr}`));
    console.log(chalk.gray(`  Commit: ${commitSha.slice(0, 8)} — ${commitInfo?.message || ''}`));
    console.log(chalk.gray('\n  No Origin session found for this commit.'));
    console.log(chalk.gray('  This line was committed without an active Origin session.\n'));
    return;
  }

  // AI-written line with session
  const agent = note.agent || note.model || 'AI';
  const sessionId = note.sessionId;

  console.log(chalk.white(`  Written by ${chalk.cyan(agent)} · ${dateStr} · Session ${chalk.cyan(sessionId.slice(0, 8))}`));

  // Step 4: try to find which prompt in the session wrote this line
  // First try platform API
  if (isConnectedMode()) {
    try {
      const { api } = await import('../api.js');
      const session = await api.getSession(sessionId) as any;

      if (session?.promptChanges?.length) {
        // Find which prompt's diff contains this line
        const matchingPrompt = findPromptForLine(session.promptChanges, relPath, lineNum, lineContent);

        if (matchingPrompt) {
          console.log(chalk.green(`  Prompt: "${matchingPrompt.promptText}"`));
          if (matchingPrompt.filesChanged?.length) {
            console.log(chalk.gray(`  Files: ${matchingPrompt.filesChanged.join(', ')}`));
          }
        } else {
          // Show the session's prompt if only one
          if (session.promptChanges.length === 1) {
            console.log(chalk.green(`  Prompt: "${session.promptChanges[0].promptText}"`));
          } else {
            console.log(chalk.gray(`  Session had ${session.promptChanges.length} prompts (couldn't determine which wrote this line)`));
          }
        }

        // Session summary
        const turns = session.promptChanges.length;
        const cost = session.costUsd ? `$${session.costUsd.toFixed(2)}` : '$0.00';
        const filesCount = (() => {
          try { return JSON.parse(session.filesChanged || '[]').length; } catch { return 0; }
        })();
        const duration = session.durationMs ? formatDuration(session.durationMs) : '—';

        console.log(chalk.gray(`\n  Session: ${turns} turn${turns === 1 ? '' : 's'} · ${cost} · ${filesCount} files · ${duration}`));
      } else if (session?.prompt) {
        console.log(chalk.green(`  Prompt: "${session.prompt}"`));
      }

      console.log(chalk.gray(`  Run ${chalk.cyan(`origin explain ${sessionId.slice(0, 8)}`)} for full details\n`));
      return;
    } catch {
      // Fall through to local-only display
    }
  }

  // Local-only: show what we know from git notes
  if (note.promptSummary) {
    console.log(chalk.green(`  Prompt: "${note.promptSummary}"`));
  }
  const cost = note.costUsd ? `$${note.costUsd.toFixed(2)}` : '';
  const tokens = note.tokensUsed ? `${(note.tokensUsed / 1000).toFixed(1)}k tokens` : '';
  const meta = [cost, tokens, note.promptCount ? `${note.promptCount} turns` : ''].filter(Boolean).join(' · ');
  if (meta) console.log(chalk.gray(`  ${meta}`));

  console.log(chalk.gray(`  Commit: ${commitSha.slice(0, 8)} — ${commitInfo?.message || ''}`));
  console.log(chalk.gray(`  Run ${chalk.cyan(`origin explain ${sessionId.slice(0, 8)}`)} for full details\n`));
}

function findPromptForLine(
  promptChanges: any[],
  filePath: string,
  lineNum: number,
  lineContent: string,
): any | null {
  // Walk prompts in reverse (later prompts override earlier ones)
  for (let i = promptChanges.length - 1; i >= 0; i--) {
    const pc = promptChanges[i];
    const files: string[] = Array.isArray(pc.filesChanged) ? pc.filesChanged : [];

    // Check if this prompt touched the file
    const touchesFile = files.some((f: string) => {
      const nf = f.replace(/^\//, '');
      const nt = filePath.replace(/^\//, '');
      return nf === nt || nf.endsWith(nt) || nt.endsWith(nf);
    });

    if (!touchesFile) continue;

    // If we have a diff, check if it includes the line
    if (pc.diff) {
      // Look for the line content in added lines of the diff
      const trimmedContent = lineContent.trim();
      if (trimmedContent && pc.diff.includes(trimmedContent)) {
        return pc;
      }

      // Check line number in diff hunk headers
      const hunkRegex = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/gm;
      let match;
      while ((match = hunkRegex.exec(pc.diff)) !== null) {
        const start = parseInt(match[1], 10);
        const count = match[2] ? parseInt(match[2], 10) : 1;
        if (lineNum >= start && lineNum < start + count) {
          return pc;
        }
      }
    }

    // If no diff but file matches, this is our best guess
    if (touchesFile) return pc;
  }
  return null;
}

async function showFileWhy(repoPath: string, filePath: string): Promise<void> {
  const relPath = path.relative(repoPath, path.resolve(process.cwd(), filePath));

  // Get line-level attribution
  const lines = getLineBlame(repoPath, relPath);
  if (lines.length === 0) {
    console.log(chalk.yellow(`\n  No attribution data for ${relPath}\n`));
    return;
  }

  const total = lines.length;
  const aiLines = lines.filter(l => l.authorship === 'ai').length;
  const humanLines = lines.filter(l => l.authorship === 'human').length;
  const aiPct = Math.round((aiLines / total) * 100);
  const humanPct = Math.round((humanLines / total) * 100);

  console.log(chalk.bold(`\n  ${relPath}`));
  console.log(chalk.gray(`  ${total} lines — `) +
    chalk.green(`${aiPct}% AI (${aiLines})`) +
    chalk.gray(' · ') +
    chalk.white(`${humanPct}% human (${humanLines})`));
  console.log('');

  // Group by session/agent
  const sessionMap = new Map<string, { model: string; lines: number; sessionId: string }>();
  let humanCount = 0;
  for (const line of lines) {
    if (line.authorship === 'human') {
      humanCount++;
      continue;
    }
    const key = line.sessionId || 'unknown';
    const existing = sessionMap.get(key);
    if (existing) {
      existing.lines++;
    } else {
      sessionMap.set(key, { model: line.model || line.tool || 'AI', lines: 1, sessionId: key });
    }
  }

  // Sort by line count
  const agents = [...sessionMap.values()].sort((a, b) => b.lines - a.lines);

  for (const a of agents.slice(0, 5)) {
    const pct = Math.round((a.lines / total) * 100);
    console.log(
      chalk.cyan(`  ${a.model.padEnd(20)}`) +
      chalk.green(`${String(a.lines).padStart(4)} lines  ${String(pct).padStart(3)}%`) +
      chalk.gray(`  session ${a.sessionId.slice(0, 8)}`)
    );
  }
  if (humanCount > 0) {
    const pct = Math.round((humanCount / total) * 100);
    console.log(
      chalk.white(`  ${'Human'.padEnd(20)}${String(humanCount).padStart(4)} lines  ${String(pct).padStart(3)}%`)
    );
  }

  console.log(chalk.gray(`\n  Tip: ${chalk.cyan(`origin why ${relPath}:42`)} to see which prompt wrote a specific line\n`));
}

export async function whyCommand(input: string) {
  const { file, line } = parseFileAndLine(input);

  const repoPath = getGitRoot(process.cwd());
  if (!repoPath) {
    console.log(chalk.red('Not inside a git repository.'));
    process.exit(1);
  }

  if (line) {
    await showLineWhy(repoPath, file, line);
  } else {
    await showFileWhy(repoPath, file);
  }
}
