import chalk from 'chalk';
import { gitDetailed } from '../utils/exec.js';
import { resolveLineAttribution, type AttributionConfidence, type LineBlameOptions } from '../attribution.js';
import { linesOf } from '../attribution-line-reanchor.js';
import { getGitRoot } from '../session-state.js';

const SAFE_RANGE = /^[a-zA-Z0-9_./~^-]+(?:\.\.[a-zA-Z0-9_./~^-]+)?$/;

// ─── Types ────────────────────────────────────────────────────────────────

interface AnnotatedDiffLine {
  type: 'header' | 'hunk' | 'addition' | 'deletion' | 'context' | 'meta';
  content: string;
  authorship?: 'ai' | 'human' | 'unknown';
  /** `line` ([AI]) or `commit` ([AI~]) on an `ai` addition only. */
  confidence?: AttributionConfidence;
  commitSha?: string;
}

// ─── Helpers ──────────────────────────────────────────────────────────────

const gitOpts = (cwd: string) => ({
  cwd,
  maxBuffer: 10 * 1024 * 1024,
});

/**
 * Which file version the new side of the diff is, and so which line view
 * proves it: a commit's blob for `A..B`, `A...B` or one shown commit, the
 * working tree for `git diff <ref>` (a ref against the files on disk).
 */
type DiffTarget = { view: 'head'; revision: string } | { view: 'worktree' };

function diffTarget(range: string, shownCommit: boolean): DiffTarget {
  if (shownCommit) return { view: 'head', revision: range };
  const sep = range.includes('...') ? '...' : range.includes('..') ? '..' : null;
  if (!sep) return { view: 'worktree' };
  const right = range.slice(range.indexOf(sep) + sep.length);
  return { view: 'head', revision: right || 'HEAD' };
}

/**
 * Parse diff output and annotate each added line with the attribution of the
 * new side (resolveLineAttribution, OR-46): `ai` with confidence `line` only on
 * a canonical claim that reaches that line, `ai` with confidence `commit` when
 * only the line's commit carries AI evidence (a commit-level record, a legacy
 * note, a trailer), `human` only under HUMAN_WHEN_NO_AI_EVIDENCE, `unknown`
 * otherwise. An added line whose text is not the text of that line in the
 * viewed side is `unknown`; deletions are `unknown`.
 */
function annotateDiffLines(
  repoPath: string,
  diffOutput: string,
  target: DiffTarget,
): AnnotatedDiffLine[] {
  const lines = diffOutput.split('\n');
  const result: AnnotatedDiffLine[] = [];

  let currentFile = '';
  let newLineNum = 0; // tracks the line number in the new (target) side

  // Batch: collect added line ranges per file, then blame once
  // First pass: parse structure to identify files + hunk ranges
  interface HunkInfo {
    file: string;
    newStart: number;
    addedLines: { diffIndex: number; newLine: number; content: string }[];
  }

  const hunks: HunkInfo[] = [];
  let currentHunk: HunkInfo | null = null;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    if (line.startsWith('diff --git')) {
      // Extract new file path: diff --git a/foo b/bar → bar
      const fileMatch = line.match(/diff --git a\/.+ b\/(.+)/);
      if (fileMatch) currentFile = fileMatch[1];
      currentHunk = null;
    } else if (line.startsWith('+++ b/')) {
      currentFile = line.slice(6);
    } else if (line.startsWith('@@')) {
      // Parse hunk header: @@ -old,count +new,count @@
      const hunkMatch = line.match(/@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
      newLineNum = hunkMatch ? parseInt(hunkMatch[1], 10) : 1;
      currentHunk = { file: currentFile, newStart: newLineNum, addedLines: [] };
      hunks.push(currentHunk);
    } else if (line.startsWith('+') && !line.startsWith('+++')) {
      if (currentHunk) {
        currentHunk.addedLines.push({ diffIndex: i, newLine: newLineNum, content: line.slice(1) });
      }
      newLineNum++;
    } else if (line.startsWith('-') && !line.startsWith('---')) {
      // Deletions don't advance new line number
    } else {
      // Context line
      newLineNum++;
    }
  }

  // One proven line view per file of the new side.
  const lineAuthorship = new Map<number, { authorship: 'ai' | 'human' | 'unknown'; confidence?: AttributionConfidence; sha?: string }>();
  const fileHunks = new Map<string, HunkInfo[]>();
  for (const h of hunks) {
    if (h.addedLines.length === 0) continue;
    if (!fileHunks.has(h.file)) fileHunks.set(h.file, []);
    fileHunks.get(h.file)!.push(h);
  }
  const viewOpts: LineBlameOptions = target.view === 'head' ? { view: 'head', revision: target.revision } : {};

  for (const [file, fHunks] of fileHunks) {
    const resolution = resolveLineAttribution(repoPath, file, viewOpts);
    const viewLines = resolution ? linesOf(resolution.text) : [];
    for (const added of fHunks.flatMap(h => h.addedLines)) {
      const attr = resolution?.lines[added.newLine - 1];
      // The proof is about the view's line; it holds for this `+` line only
      // when that line IS this text.
      if (!attr || viewLines[added.newLine - 1] !== added.content || attr.authorship === 'mixed') {
        lineAuthorship.set(added.diffIndex, { authorship: 'unknown', sha: attr?.commitSha });
      } else {
        lineAuthorship.set(added.diffIndex, {
          authorship: attr.authorship,
          ...(attr.authorship === 'ai' ? { confidence: attr.confidence } : {}),
          sha: attr.commitSha,
        });
      }
    }
  }

  // Second pass: build annotated output using per-line authorship
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    if (line.startsWith('diff --git')) {
      result.push({ type: 'header', content: line });
    } else if (line.startsWith('---') || line.startsWith('+++') || line.startsWith('index ')) {
      result.push({ type: 'meta', content: line });
    } else if (line.startsWith('@@')) {
      result.push({ type: 'hunk', content: line });
    } else if (line.startsWith('+') && !line.startsWith('+++')) {
      const info = lineAuthorship.get(i);
      result.push({
        type: 'addition',
        content: line,
        authorship: info?.authorship || 'unknown',
        ...(info?.confidence ? { confidence: info.confidence } : {}),
        commitSha: info?.sha,
      });
    } else if (line.startsWith('-') && !line.startsWith('---')) {
      // Deletions: we can't reliably blame deleted lines (they're gone),
      // so we leave them as 'unknown'
      result.push({
        type: 'deletion',
        content: line,
        authorship: 'unknown',
      });
    } else {
      result.push({ type: 'context', content: line });
    }
  }

  return result;
}

// ─── Command ──────────────────────────────────────────────────────────────

/**
 * origin diff [range] [--ai-only] [--human-only] [--json]
 *
 * Runs git diff and annotates each added line with [AI] (line proof), [AI~]
 * (commit-level evidence, no line proof), [HU] or [??] (see annotateDiffLines);
 * unknown is never counted as human. --ai-only keeps both AI tiers.
 */
export async function diffCommand(
  range?: string,
  opts?: { aiOnly?: boolean; humanOnly?: boolean; json?: boolean },
): Promise<void> {
  const cwd = process.cwd();
  const repoPath = getGitRoot(cwd);
  if (!repoPath) {
    console.error(chalk.red('Error: Not in a git repository.'));
    return;
  }

  // Default to HEAD~5..HEAD if no range given
  const diffRange = range || 'HEAD~5..HEAD';

  let shownCommit = false;

  // Get the diff
  if (!SAFE_RANGE.test(diffRange)) {
    console.error(chalk.red(`Error: Invalid diff range "${diffRange}".`));
    return;
  }
  let diffOutput: string;
  {
    const r = gitDetailed(['diff', '--no-color', '--no-ext-diff', '--src-prefix=a/', '--dst-prefix=b/', diffRange], gitOpts(repoPath));
    if (r.status === 0) {
      diffOutput = r.stdout.trim();
    } else {
      // Maybe it's a single commit ref — try showing it
      const r2 = gitDetailed(
        ['show', '--no-color', '--no-ext-diff', '--src-prefix=a/', '--dst-prefix=b/', diffRange, '--format=', '--diff-merges=first-parent'],
        gitOpts(repoPath),
      );
      if (r2.status === 0) {
        diffOutput = r2.stdout.trim();
        shownCommit = true;
      } else {
        console.error(chalk.red(`Error: Invalid diff range "${diffRange}".`));
        return;
      }
    }
  }

  if (!diffOutput) {
    console.log(chalk.gray('No differences found.'));
    return;
  }

  // Annotate added lines with the line-level proof of the new side
  const annotated = annotateDiffLines(repoPath, diffOutput, diffTarget(diffRange, shownCommit));

  // Apply filters
  let filtered = annotated;
  if (opts?.aiOnly) {
    filtered = annotated.filter(l =>
      l.type === 'header' || l.type === 'meta' || l.type === 'hunk' ||
      l.type === 'context' || l.authorship === 'ai',
    );
  } else if (opts?.humanOnly) {
    filtered = annotated.filter(l =>
      l.type === 'header' || l.type === 'meta' || l.type === 'hunk' ||
      l.type === 'context' || l.authorship === 'human',
    );
  }

  // JSON output
  if (opts?.json) {
    const jsonLines = filtered.map(l => ({
      type: l.type,
      content: l.content,
      authorship: l.authorship || null,
      confidence: l.confidence || null,
      commitSha: l.commitSha || null,
    }));
    console.log(JSON.stringify(jsonLines, null, 2));
    return;
  }

  // Pretty output with [AI] / [AI~] / [HU] / [??] tags
  let aiAdditions = 0;
  let commitLevelAdditions = 0;
  let humanAdditions = 0;
  let unknownAdditions = 0;
  let deletions = 0;

  const AI_TAG = chalk.cyan.bold('[AI]');
  const AI_COMMIT_TAG = chalk.cyan('[AI~]');
  const HU_TAG = chalk.green.bold('[HU]');
  const UNKNOWN_TAG = chalk.gray('[??]');

  for (const line of filtered) {
    switch (line.type) {
      case 'header':
        console.log(chalk.bold.white(line.content));
        break;
      case 'meta':
        console.log(chalk.gray(line.content));
        break;
      case 'hunk':
        console.log(chalk.magenta(line.content));
        break;
      case 'addition':
        if (line.authorship === 'ai' && line.confidence === 'line') {
          console.log(`${AI_TAG} ${chalk.cyan(line.content)}`);
          aiAdditions++;
        } else if (line.authorship === 'ai') {
          console.log(`${AI_COMMIT_TAG} ${chalk.cyan(line.content)}`);
          aiAdditions++;
          commitLevelAdditions++;
        } else if (line.authorship === 'human') {
          console.log(`${HU_TAG} ${chalk.green(line.content)}`);
          humanAdditions++;
        } else {
          console.log(`${UNKNOWN_TAG} ${chalk.green(line.content)}`);
          unknownAdditions++; // no proof either way: never counted as human
        }
        break;
      case 'deletion':
        // A deleted line has no line-level proof of who wrote it.
        console.log(`     ${chalk.red(line.content)}`);
        deletions++;
        break;
      case 'context':
        console.log(`     ${chalk.gray(line.content)}`);
        break;
    }
  }

  // Summary: shares of added lines; deletions are listed apart, unattributed.
  const total = aiAdditions + humanAdditions + unknownAdditions;
  const pct = (n: number) => (total > 0 ? Math.round((n / total) * 100) : 0);

  console.log('');
  console.log(chalk.bold('Attribution Summary:'));
  console.log(
    `  ${chalk.cyan(`AI: +${aiAdditions}`)} (${pct(aiAdditions)}%)` +
    chalk.gray(` [AI] line-proven: +${aiAdditions - commitLevelAdditions}, [AI~] commit-level: +${commitLevelAdditions}`) +
    `    ${chalk.green(`Human: +${humanAdditions}`)} (${pct(humanAdditions)}%)` +
    `    ${chalk.gray(`Unknown: +${unknownAdditions}`)} (${pct(unknownAdditions)}%)` +
    `    ${chalk.red(`Deleted: -${deletions}`)} (not attributed)`,
  );
  console.log('');
}
