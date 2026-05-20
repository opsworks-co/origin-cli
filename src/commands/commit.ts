// `origin commit <sha>` — read the Origin git note for a commit and print
// the prompt + session metadata. Works on any cloned repo that has the
// `refs/notes/origin` ref fetched; no Origin account or platform required.
//
// Usage:
//   origin commit                 # current HEAD
//   origin commit <sha>           # specific commit
//   origin commit <sha> --json    # raw note JSON
//
// First-time setup tip we print on a miss: `git fetch origin
// refs/notes/origin:refs/notes/origin` pulls notes that a teammate pushed.

import { execFileSync } from 'child_process';
import chalk from 'chalk';
import { getGitRoot } from '../session-state.js';

interface NoteOrigin {
  version?: number;
  sessionId?: string;
  model?: string;
  agent?: string;
  promptCount?: number;
  promptSummary?: string;
  fullPrompt?: string;
  previousSessionId?: string;
  filesRead?: string[];
  tokensUsed?: number;
  costUsd?: number;
  durationMs?: number;
  linesAdded?: number;
  linesRemoved?: number;
  originUrl?: string;
  timestamp?: string;
}

function readNote(repoPath: string, sha: string): string | null {
  try {
    return execFileSync('git', ['notes', '--ref=origin', 'show', sha], {
      cwd: repoPath,
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
      timeout: 5_000,
    }).trim();
  } catch {
    return null;
  }
}

function resolveSha(repoPath: string, ref: string): string | null {
  try {
    return execFileSync('git', ['rev-parse', ref], {
      cwd: repoPath,
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
      timeout: 3_000,
    }).trim();
  } catch {
    return null;
  }
}

function readCommitSubject(repoPath: string, sha: string): string {
  try {
    return execFileSync('git', ['log', '-1', '--format=%s', sha], {
      cwd: repoPath,
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
      timeout: 3_000,
    }).trim();
  } catch {
    return '';
  }
}

function fmtCost(usd?: number): string {
  if (usd == null) return '—';
  return `$${usd.toFixed(usd < 0.01 ? 4 : 2)}`;
}

function fmtTokens(n?: number): string {
  if (!n) return '—';
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(n);
}

function fmtDuration(ms?: number): string {
  if (!ms || ms <= 0) return '—';
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  return `${m}m ${s % 60}s`;
}

export async function commitCommand(
  shaArg: string | undefined,
  opts: { json?: boolean } = {},
): Promise<void> {
  const repoPath = getGitRoot(process.cwd());
  if (!repoPath) {
    console.error(chalk.red('Not a git repository (or no .git found in any parent).'));
    process.exitCode = 1;
    return;
  }

  const ref = shaArg && shaArg.trim() ? shaArg.trim() : 'HEAD';
  const sha = resolveSha(repoPath, ref);
  if (!sha) {
    console.error(chalk.red(`Could not resolve ref: ${ref}`));
    process.exitCode = 1;
    return;
  }

  const noteText = readNote(repoPath, sha);
  if (!noteText) {
    console.log(chalk.gray(`No Origin note on ${sha.slice(0, 12)}.`));
    console.log(
      chalk.dim(
        '\nIf this commit was made by a teammate, fetch their notes first:\n  ' +
        chalk.cyan('git fetch origin refs/notes/origin:refs/notes/origin'),
      ),
    );
    return;
  }

  let parsed: { origin?: NoteOrigin } | null = null;
  try { parsed = JSON.parse(noteText); } catch {
    console.error(chalk.red('Note exists but is not valid JSON.'));
    if (opts.json) process.stdout.write(noteText);
    process.exitCode = 1;
    return;
  }
  const o = parsed?.origin;
  if (!o) {
    console.error(chalk.red('Note has no `origin` payload.'));
    process.exitCode = 1;
    return;
  }

  if (opts.json) {
    process.stdout.write(JSON.stringify(parsed, null, 2) + '\n');
    return;
  }

  const subject = readCommitSubject(repoPath, sha);
  const promptText = (o.fullPrompt || o.promptSummary || '').trim();

  // Header block
  console.log();
  console.log(chalk.bold(`commit ${sha.slice(0, 12)}`) + (subject ? chalk.gray('  ' + subject) : ''));
  const headerBits: string[] = [];
  if (o.model) headerBits.push(chalk.cyan(o.model));
  if (o.agent && o.agent !== o.model) headerBits.push(chalk.gray('via ' + o.agent));
  if (o.timestamp) headerBits.push(chalk.gray(new Date(o.timestamp).toLocaleString()));
  if (headerBits.length) console.log(headerBits.join('  '));
  console.log();

  // Metrics
  const metrics = [
    `${chalk.gray('tokens:')} ${fmtTokens(o.tokensUsed)}`,
    `${chalk.gray('cost:')}   ${fmtCost(o.costUsd)}`,
    `${chalk.gray('time:')}   ${fmtDuration(o.durationMs)}`,
    `${chalk.gray('lines:')}  ${chalk.green('+' + (o.linesAdded ?? 0))} ${chalk.red('-' + (o.linesRemoved ?? 0))}`,
    `${chalk.gray('prompts:')} ${o.promptCount ?? 1}`,
  ];
  console.log(metrics.join('  '));
  console.log();

  // Prompt body
  if (promptText) {
    console.log(chalk.bold('Prompt:'));
    console.log(promptText);
    console.log();
  } else {
    console.log(chalk.gray('(no prompt content in this note)'));
    console.log();
  }

  // Footer — origin URL + session id for cross-reference
  const footer: string[] = [];
  if (o.sessionId) footer.push(chalk.gray('session ' + o.sessionId.slice(0, 8)));
  if (o.previousSessionId) footer.push(chalk.gray('prev ' + o.previousSessionId.slice(0, 8)));
  if (o.originUrl) footer.push(chalk.cyan(o.originUrl));
  if (footer.length) console.log(footer.join('  '));
}
