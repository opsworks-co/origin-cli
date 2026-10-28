import chalk from 'chalk';
import {
  resolveLineAttribution,
  getSessionContextForCommit,
  isLineProvenAttribution,
  type AttributionConfidence,
  type LineAuthorship,
  type LineUnknownReason,
  type SessionContext,
} from '../attribution.js';
import { linesOf } from '../attribution-line-reanchor.js';
import { getGitRoot, getWorkingGitRoot } from '../session-state.js';
import { provenanceRoots, resolveQueryTarget } from '../session-worktree.js';
import { syncNotesFromRemote } from '../git-notes.js';

// ─── Types ────────────────────────────────────────────────────────────────

interface BlameOutputLine {
  lineNumber: number;
  authorship: LineAuthorship;
  /** `line` ([AI]) or `commit` ([AI~]) on an `ai` line; absent on every other line. */
  confidence?: AttributionConfidence;
  /** Why an `unknown` line has no attribution. Absent on every other line. */
  unknownReason?: LineUnknownReason;
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
  if (a.startsWith('devin') || a.startsWith('windsurf')) return 'devin';
  return agent;
}

// Trim a git author down to the part before any email/`<`.
function shortAuthor(author: string | undefined): string {
  if (!author) return '';
  const m = author.match(/^([^<]+?)\s*(?:<.*)?$/);
  return (m ? m[1] : author).trim();
}

// ─── Helpers ──────────────────────────────────────────────────────────────

const TAG_W = 5;

function authorshipTag(authorship: LineAuthorship, confidence?: AttributionConfidence): string {
  switch (authorship) {
    // [AI] is line proof only; [AI~] is commit-level evidence (OR-46 CR1).
    case 'ai': return confidence === 'line' ? '[AI]' : '[AI~]';
    case 'human': return '[HU]';
    case 'mixed': return '[MX]';
    case 'unknown': return '[??]';
  }
}

function colorTag(authorship: LineAuthorship, text: string, confidence?: AttributionConfidence): string {
  switch (authorship) {
    case 'ai': return confidence === 'line' ? chalk.green(text) : chalk.greenBright(text);
    case 'human': return chalk.white(text);
    case 'mixed': return chalk.yellow(text);
    case 'unknown': return chalk.gray(text);
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
 * Git blame style output with an AI/Human/Unknown attribution column.
 * `[AI]` is a canonical line claim re-anchored onto the line (OR-46); `[AI~]`
 * is AI evidence on the line's commit with no line-level proof (OR-46 CR1);
 * a line without evidence either way is Unknown, never Human. Lines are
 * numbered as the file is on disk; proof comes from HEAD (see
 * resolveLineAttribution).
 */
export async function blameCommand(
  file: string,
  opts?: { line?: string; json?: boolean },
): Promise<void> {
  const cwd = process.cwd();
  // Blame the tree the user is standing in. `getGitRoot` collapses a linked
  // worktree onto its main checkout, so blaming there answered for the MAIN
  // branch's copy of the file — a wrong answer, not an empty one, which is
  // worse than what `why`/`prompts` did with the same root.
  const roots = provenanceRoots(cwd, { gitRoot: getGitRoot, workingGitRoot: getWorkingGitRoot });
  if (!roots) {
    console.error(chalk.red('Error: Not in a git repository.'));
    return;
  }
  const { relPath, root: repoPath } = resolveQueryTarget(file, roots, cwd);

  // Pull attribution notes down from the remote before reading them, and
  // install the fetch refspec so future ordinary `git pull`s keep them
  // current. This is what makes blame work out-of-the-box on a fresh
  // clone — `git clone` does not fetch refs/notes/* by itself. Notes and the
  // refspec live in the common dir every worktree shares, so this is a
  // repo-level resource: the canonical root's job.
  syncNotesFromRemote(roots.canonicalRoot);

  // Line-level attribution, and the very text its line numbers refer to: the
  // content shown below is never read separately from the attribution.
  const resolution = resolveLineAttribution(repoPath, relPath);
  if (!resolution || resolution.lines.length === 0) {
    console.error(chalk.red(`Error: Could not get blame for ${file}. File may not exist or be empty.`));
    return;
  }
  const attributions = resolution.lines;
  const fileLines = linesOf(resolution.text);

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
      ...(attr.confidence ? { confidence: attr.confidence } : {}),
      ...(attr.unknownReason ? { unknownReason: attr.unknownReason } : {}),
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
    // Context only for sessions a proven line names, and only when the
    // commit's note describes that same session. A commit-confidence line's
    // session is evidence about its commit, not a line session: it stays on
    // the line, tagged `confidence: "commit"`, and opens no context here.
    const sessions: Record<string, SessionContext> = {};
    const seenCommits = new Set<string>();
    for (const attr of attributions) {
      if (!isLineProvenAttribution(attr) || !attr.commitSha || !attr.sessionId || seenCommits.has(attr.commitSha)) continue;
      seenCommits.add(attr.commitSha);
      const ctx = getSessionContextForCommit(repoPath, attr.commitSha);
      if (ctx && ctx.sessionId === attr.sessionId && !sessions[ctx.sessionId]) {
        sessions[ctx.sessionId] = ctx;
      }
    }
    console.log(JSON.stringify({ file, view: resolution.view, revision: resolution.revision, lines: filtered, sessions }, null, 2));
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
    ? `  ${'Line'.padStart(lineNumWidth)}  ${'Tag'.padEnd(TAG_W)}  Content`
    : `  ${'Line'.padStart(lineNumWidth)}  ${'Tag'.padEnd(TAG_W)}  ${'Agent'.padEnd(AGENT_W)}  ${'Model'.padEnd(MODEL_W)}  ${'Author'.padEnd(AUTHOR_W)}  Content`;
  console.log(chalk.gray(header));
  console.log(chalk.gray('  ' + '─'.repeat(lineNumWidth + 60)));

  // Summary counters
  let aiCount = 0;
  let lineProvenCount = 0;
  let commitLevelCount = 0;
  let humanCount = 0;
  let mixedCount = 0;
  let unknownCount = 0;

  for (const line of filtered) {
    const lineNum = String(line.lineNumber).padStart(lineNumWidth);
    const tag = authorshipTag(line.authorship, line.confidence).padEnd(TAG_W);
    const coloredTag = colorTag(line.authorship, tag, line.confidence);
    // For human-authored lines the agent/model columns stay blank — only
    // the Author chip is meaningful. AI lines show all three.
    const agentLabel = line.authorship === 'ai' ? shortAgent(line.agent).slice(0, AGENT_W) : '';
    const modelLabel = line.authorship === 'ai' && line.model ? line.model.slice(0, MODEL_W) : '';
    const authorLabel = shortAuthor(line.author).slice(0, AUTHOR_W);
    const content = line.content.slice(0, 120);

    // Count authorship
    if (line.authorship === 'ai') {
      aiCount++;
      if (line.confidence === 'line') lineProvenCount++;
      else commitLevelCount++;
    } else if (line.authorship === 'human') humanCount++;
    else if (line.authorship === 'mixed') mixedCount++;
    else unknownCount++;

    if (opts?.line) {
      console.log(`  ${chalk.gray(lineNum)}  ${coloredTag}  ${colorTag(line.authorship, content, line.confidence)}`);
    } else {
      console.log(
        `  ${chalk.gray(lineNum)}  ${coloredTag}  ` +
        `${chalk.cyan(agentLabel.padEnd(AGENT_W))}  ` +
        `${chalk.gray(modelLabel.padEnd(MODEL_W))}  ` +
        `${chalk.magenta(authorLabel.padEnd(AUTHOR_W))}  ` +
        `${colorTag(line.authorship, content, line.confidence)}`,
      );
    }
  }

  // Summary
  const total = filtered.length;
  const pct = (n: number) => (total > 0 ? Math.round((n / total) * 100) : 0);
  console.log(chalk.gray('\n  ' + '─'.repeat(lineNumWidth + 60)));
  console.log(
    `  ${chalk.bold('Summary:')} ` +
    `${chalk.green(`AI: ${aiCount} (${pct(aiCount)}%)`)} ` +
    chalk.gray(`[AI] line-proven: ${lineProvenCount}, [AI~] commit-level: ${commitLevelCount}`) + '  ' +
    `${chalk.white(`Human: ${humanCount} (${pct(humanCount)}%)`)}  ` +
    `${chalk.yellow(`Mixed: ${mixedCount} (${pct(mixedCount)}%)`)}  ` +
    `${chalk.gray(`Unknown: ${unknownCount} (${pct(unknownCount)}%)`)}`,
  );
  console.log('');
}
