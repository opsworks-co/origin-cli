import chalk from 'chalk';
import fs from 'fs';
import path from 'path';
import { getLineBlame, getSessionContextForCommit, type SessionContext } from '../attribution.js';
import { getGitRoot } from '../session-state.js';

// ─── Types ────────────────────────────────────────────────────────────────

interface BlameOutputLine {
  lineNumber: number;
  authorship: 'ai' | 'human' | 'mixed';
  sessionId?: string;
  model?: string;
  agent?: string;
  author?: string;
  content: string;
}

// Friendly short label for the Agent column. Mirrors the dashboard's
// displayAgentName so "claude-code" → "claude", "gemini-cli" → "gemini".
function shortAgent(agent: string | undefined): string {
  if (!agent) return '';
  const a = agent.toLowerCase();
  if (a.startsWith('claude')) return 'claude';
  if (a.startsWith('codex')) return 'codex';
  if (a.startsWith('gemini')) return 'gemini';
  if (a.startsWith('cursor')) return 'cursor';
  if (a.startsWith('windsurf')) return 'windsurf';
  return agent;
}

// Trim a git author down to the part before any email/`<`.
function shortAuthor(author: string | undefined): string {
  if (!author) return '';
  const m = author.match(/^([^<]+?)\s*(?:<.*)?$/);
  return (m ? m[1] : author).trim();
}

// ─── Helpers ──────────────────────────────────────────────────────────────

function authorshipTag(authorship: 'ai' | 'human' | 'mixed'): string {
  switch (authorship) {
    case 'ai': return '[AI]';
    case 'human': return '[HU]';
    case 'mixed': return '[MX]';
  }
}

function colorTag(authorship: 'ai' | 'human' | 'mixed', text: string): string {
  switch (authorship) {
    case 'ai': return chalk.green(text);
    case 'human': return chalk.white(text);
    case 'mixed': return chalk.yellow(text);
  }
}

function parseLineRange(rangeStr: string): { start: number; end: number } | null {
  const match = rangeStr.match(/^(\d+)(?:-(\d+))?$/);
  if (!match) return null;
  const start = parseInt(match[1], 10);
  const end = match[2] ? parseInt(match[2], 10) : start;
  return { start, end };
}

// ─── Command ──────────────────────────────────────────────────────────────

/**
 * origin blame <file> [--line <start>-<end>] [--json]
 *
 * Git blame style output with AI/Human/Mixed attribution column.
 * Cross-references git blame with Origin notes to determine authorship.
 */
export async function blameCommand(
  file: string,
  opts?: { line?: string; json?: boolean },
): Promise<void> {
  const cwd = process.cwd();
  const repoPath = getGitRoot(cwd);
  if (!repoPath) {
    console.error(chalk.red('Error: Not in a git repository.'));
    return;
  }

  // Get line-level attribution
  const attributions = getLineBlame(repoPath, file);
  if (attributions.length === 0) {
    console.error(chalk.red(`Error: Could not get blame for ${file}. File may not exist or have no commits.`));
    return;
  }

  // Read file content for display
  const fullPath = path.isAbsolute(file) ? file : path.join(repoPath, file);
  let fileLines: string[] = [];
  try {
    fileLines = fs.readFileSync(fullPath, 'utf-8').split('\n');
  } catch {
    console.error(chalk.red(`Error: Could not read file ${file}.`));
    return;
  }

  // Parse line range filter
  let lineRange: { start: number; end: number } | null = null;
  if (opts?.line) {
    lineRange = parseLineRange(opts.line);
    if (!lineRange) {
      console.error(chalk.red(`Error: Invalid line range "${opts.line}". Use format: <start>-<end> (e.g., 10-20)`));
      return;
    }
  }

  // Build output lines
  const outputLines: BlameOutputLine[] = attributions.map((attr) => {
    const content = fileLines[attr.lineNumber - 1] ?? '';
    return {
      lineNumber: attr.lineNumber,
      authorship: attr.authorship,
      sessionId: attr.sessionId,
      model: attr.model,
      agent: attr.agent,
      author: attr.author,
      content,
    };
  });

  // Apply line range filter
  const filtered = lineRange
    ? outputLines.filter(l => l.lineNumber >= lineRange!.start && l.lineNumber <= lineRange!.end)
    : outputLines;

  if (filtered.length === 0) {
    console.log(chalk.gray('No lines to display.'));
    return;
  }

  // JSON output — emit a sessions map keyed by sessionId so callers can look
  // up the rich context (full prompt, previousSessionId, filesRead, acceptance)
  // once per session instead of per line.
  if (opts?.json) {
    const sessions: Record<string, SessionContext> = {};
    const seenCommits = new Set<string>();
    for (const attr of attributions) {
      if (!attr.commitSha || !attr.sessionId || seenCommits.has(attr.commitSha)) continue;
      seenCommits.add(attr.commitSha);
      const ctx = getSessionContextForCommit(repoPath, attr.commitSha);
      if (ctx && !sessions[ctx.sessionId]) {
        sessions[ctx.sessionId] = ctx;
      }
    }
    console.log(JSON.stringify({ file, lines: filtered, sessions }, null, 2));
    return;
  }

  // Pretty output
  const maxLineNum = Math.max(...filtered.map(l => l.lineNumber));
  const lineNumWidth = String(maxLineNum).length;

  // Column widths sized to the actual data so the table stays compact
  // even when this file has no agent/author info recorded.
  const AGENT_W = 8;
  const MODEL_W = 14;
  // Author width adapts to the longest name in the slice (capped at 22)
  // so a short common author (e.g. "Artem") doesn't burn 22 chars.
  const AUTHOR_W = Math.min(
    22,
    Math.max(8, ...filtered.map(l => shortAuthor(l.author).length)),
  );

  // Header
  console.log(chalk.bold(`\n  ${file}\n`));
  const header = opts?.line
    ? `  ${'Line'.padStart(lineNumWidth)}  Tag   Content`
    : `  ${'Line'.padStart(lineNumWidth)}  Tag   ${'Agent'.padEnd(AGENT_W)}  ${'Model'.padEnd(MODEL_W)}  ${'Author'.padEnd(AUTHOR_W)}  Content`;
  console.log(chalk.gray(header));
  console.log(chalk.gray('  ' + '─'.repeat(lineNumWidth + 60)));

  // Summary counters
  let aiCount = 0;
  let humanCount = 0;
  let mixedCount = 0;

  for (const line of filtered) {
    const lineNum = String(line.lineNumber).padStart(lineNumWidth);
    const tag = authorshipTag(line.authorship);
    const coloredTag = colorTag(line.authorship, tag);
    // For human-authored lines the agent/model columns stay blank — only
    // the Author chip is meaningful. AI lines show all three.
    const agentLabel = line.authorship === 'ai' ? shortAgent(line.agent).slice(0, AGENT_W) : '';
    const modelLabel = line.authorship === 'ai' && line.model ? line.model.slice(0, MODEL_W) : '';
    const authorLabel = shortAuthor(line.author).slice(0, AUTHOR_W);
    const content = line.content.slice(0, 120);

    // Count authorship
    if (line.authorship === 'ai') aiCount++;
    else if (line.authorship === 'human') humanCount++;
    else mixedCount++;

    if (opts?.line) {
      console.log(`  ${chalk.gray(lineNum)}  ${coloredTag}  ${colorTag(line.authorship, content)}`);
    } else {
      console.log(
        `  ${chalk.gray(lineNum)}  ${coloredTag}  ` +
        `${chalk.cyan(agentLabel.padEnd(AGENT_W))}  ` +
        `${chalk.gray(modelLabel.padEnd(MODEL_W))}  ` +
        `${chalk.magenta(authorLabel.padEnd(AUTHOR_W))}  ` +
        `${colorTag(line.authorship, content)}`,
      );
    }
  }

  // Summary
  const total = filtered.length;
  console.log(chalk.gray('\n  ' + '─'.repeat(lineNumWidth + 60)));
  console.log(
    `  ${chalk.bold('Summary:')} ` +
    `${chalk.green(`AI: ${aiCount} (${total > 0 ? Math.round((aiCount / total) * 100) : 0}%)`)}  ` +
    `${chalk.white(`Human: ${humanCount} (${total > 0 ? Math.round((humanCount / total) * 100) : 0}%)`)}  ` +
    `${chalk.yellow(`Mixed: ${mixedCount} (${total > 0 ? Math.round((mixedCount / total) * 100) : 0}%)`)}`,
  );
  console.log('');
}
