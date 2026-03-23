import chalk from 'chalk';
import { execSync } from 'child_process';
import { isAiCommit } from '../attribution.js';
import { getGitRoot } from '../session-state.js';

// ─── Types ────────────────────────────────────────────────────────────────

interface AnnotatedDiffLine {
  type: 'header' | 'hunk' | 'addition' | 'deletion' | 'context' | 'meta';
  content: string;
  authorship?: 'ai' | 'human' | 'unknown';
  commitSha?: string;
}

// ─── Helpers ──────────────────────────────────────────────────────────────

function execOpts(cwd: string) {
  return {
    encoding: 'utf-8' as const,
    cwd,
    stdio: ['pipe', 'pipe', 'pipe'] as ['pipe', 'pipe', 'pipe'],
    maxBuffer: 10 * 1024 * 1024,
  };
}

/**
 * Get commits in a range and classify each as AI or human.
 */
function getCommitAuthorship(
  repoPath: string,
  range: string,
): Map<string, 'ai' | 'human'> {
  const map = new Map<string, 'ai' | 'human'>();
  try {
    const commits = execSync(
      `git log --format=%H ${range}`,
      execOpts(repoPath),
    ).trim().split('\n').filter(Boolean);
    for (const sha of commits) {
      if (/^[a-fA-F0-9]+$/.test(sha)) {
        map.set(sha, isAiCommit(repoPath, sha) ? 'ai' : 'human');
      }
    }
  } catch { /* ignore */ }
  return map;
}

/**
 * Run git blame on specific line range of a file at a given ref.
 * Returns a map of lineNumber → commitSha.
 */
function blameLines(
  repoPath: string,
  filePath: string,
  startLine: number,
  endLine: number,
  ref: string,
): Map<number, string> {
  const result = new Map<number, string>();
  try {
    const output = execSync(
      `git blame -L ${startLine},${endLine} --porcelain ${ref} -- "${filePath}"`,
      execOpts(repoPath),
    );
    let currentSha = '';
    let currentLine = startLine;
    for (const line of output.split('\n')) {
      // Lines starting with a 40-char hex SHA are commit headers
      const match = line.match(/^([a-f0-9]{40})\s+\d+\s+(\d+)/);
      if (match) {
        currentSha = match[1];
        currentLine = parseInt(match[2], 10);
        result.set(currentLine, currentSha);
      }
    }
  } catch { /* blame can fail on new files, etc. */ }
  return result;
}

/**
 * Parse diff output and annotate each added/deleted line with per-line
 * AI/human attribution using git blame.
 */
function annotateDiffLines(
  repoPath: string,
  diffOutput: string,
  commitAuthorship: Map<string, 'ai' | 'human'>,
  targetRef: string,
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
    addedLines: { diffIndex: number; newLine: number }[];
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
        currentHunk.addedLines.push({ diffIndex: i, newLine: newLineNum });
      }
      newLineNum++;
    } else if (line.startsWith('-') && !line.startsWith('---')) {
      // Deletions don't advance new line number
    } else {
      // Context line
      newLineNum++;
    }
  }

  // Blame added lines per file (batch by file for efficiency)
  const lineAuthorship = new Map<number, { authorship: 'ai' | 'human' | 'unknown'; sha: string }>();
  const fileHunks = new Map<string, HunkInfo[]>();
  for (const h of hunks) {
    if (h.addedLines.length === 0) continue;
    if (!fileHunks.has(h.file)) fileHunks.set(h.file, []);
    fileHunks.get(h.file)!.push(h);
  }

  for (const [file, fHunks] of fileHunks) {
    // Collect all added line numbers for this file
    const allAdded = fHunks.flatMap(h => h.addedLines);
    if (allAdded.length === 0) continue;

    const minLine = Math.min(...allAdded.map(a => a.newLine));
    const maxLine = Math.max(...allAdded.map(a => a.newLine));

    // Blame the range
    const blameMap = blameLines(repoPath, file, minLine, maxLine, targetRef);

    for (const added of allAdded) {
      const sha = blameMap.get(added.newLine) || '';
      let authorship: 'ai' | 'human' | 'unknown' = 'unknown';
      if (sha) {
        // Check full SHA first, then try prefix match
        if (commitAuthorship.has(sha)) {
          authorship = commitAuthorship.get(sha)!;
        } else {
          // The blame SHA might not be in the diff range — classify it directly
          try {
            authorship = isAiCommit(repoPath, sha) ? 'ai' : 'human';
            commitAuthorship.set(sha, authorship); // cache it
          } catch { /* ignore */ }
        }
      }
      lineAuthorship.set(added.diffIndex, { authorship, sha });
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
 * Runs git diff and annotates each added line with [AI] or [HU] tags.
 * Uses git blame to determine per-line authorship.
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

  // Figure out the target ref (right side of the range) for blame
  let targetRef = 'HEAD';
  const rangeMatch = diffRange.match(/\.\.(.+)/);
  if (rangeMatch) {
    targetRef = rangeMatch[1];
  }

  // Get the diff
  let diffOutput: string;
  try {
    diffOutput = execSync(
      `git diff ${diffRange}`,
      execOpts(repoPath),
    ).trim();
  } catch {
    // Maybe it's a single commit ref — try showing it
    try {
      diffOutput = execSync(
        `git show ${diffRange} --format= --diff-merges=first-parent`,
        execOpts(repoPath),
      ).trim();
      targetRef = diffRange;
    } catch {
      console.error(chalk.red(`Error: Invalid diff range "${diffRange}".`));
      return;
    }
  }

  if (!diffOutput) {
    console.log(chalk.gray('No differences found.'));
    return;
  }

  // Classify commits in range as AI or human
  const commitAuthorship = getCommitAuthorship(repoPath, diffRange);

  // Annotate diff lines with per-line blame
  const annotated = annotateDiffLines(repoPath, diffOutput, commitAuthorship, targetRef);

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
      commitSha: l.commitSha || null,
    }));
    console.log(JSON.stringify(jsonLines, null, 2));
    return;
  }

  // Pretty output with [AI] / [HU] tags
  let aiAdditions = 0;
  let humanAdditions = 0;
  let aiDeletions = 0;
  let humanDeletions = 0;

  const AI_TAG = chalk.cyan.bold('[AI]');
  const HU_TAG = chalk.green.bold('[HU]');

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
        if (line.authorship === 'ai') {
          console.log(`${AI_TAG} ${chalk.cyan(line.content)}`);
          aiAdditions++;
        } else if (line.authorship === 'human') {
          console.log(`${HU_TAG} ${chalk.green(line.content)}`);
          humanAdditions++;
        } else {
          console.log(`     ${chalk.green(line.content)}`);
          humanAdditions++; // default unknown to human
        }
        break;
      case 'deletion':
        if (line.authorship === 'ai') {
          console.log(`${AI_TAG} ${chalk.cyan.dim(line.content)}`);
          aiDeletions++;
        } else {
          console.log(`     ${chalk.red(line.content)}`);
          humanDeletions++;
        }
        break;
      case 'context':
        console.log(`     ${chalk.gray(line.content)}`);
        break;
    }
  }

  // Summary
  const total = aiAdditions + humanAdditions;
  const aiPct = total > 0 ? Math.round((aiAdditions / total) * 100) : 0;
  const humanPct = total > 0 ? 100 - aiPct : 0;

  console.log('');
  console.log(chalk.bold('Attribution Summary:'));
  console.log(
    `  ${chalk.cyan(`AI:    +${aiAdditions} -${aiDeletions}`)}  (${aiPct}%)` +
    `    ${chalk.green(`Human: +${humanAdditions} -${humanDeletions}`)}  (${humanPct}%)`,
  );
  console.log('');
}
