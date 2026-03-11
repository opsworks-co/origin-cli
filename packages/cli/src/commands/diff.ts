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
      map.set(sha, isAiCommit(repoPath, sha) ? 'ai' : 'human');
    }
  } catch { /* ignore */ }
  return map;
}

/**
 * For a given diff range, figure out which commit each added line belongs to
 * by running git log on the range and cross-referencing with blame.
 */
function annotateDiffLines(
  repoPath: string,
  diffOutput: string,
  commitAuthorship: Map<string, 'ai' | 'human'>,
): AnnotatedDiffLine[] {
  const lines = diffOutput.split('\n');
  const result: AnnotatedDiffLine[] = [];

  // Determine default authorship from the most recent commit in the range
  let defaultAuthorship: 'ai' | 'human' | 'unknown' = 'unknown';
  for (const [, auth] of commitAuthorship) {
    defaultAuthorship = auth;
    break; // use first (most recent) commit
  }

  for (const line of lines) {
    if (line.startsWith('diff --git')) {
      result.push({ type: 'header', content: line });
    } else if (line.startsWith('---') || line.startsWith('+++') || line.startsWith('index ')) {
      result.push({ type: 'meta', content: line });
    } else if (line.startsWith('@@')) {
      result.push({ type: 'hunk', content: line });
    } else if (line.startsWith('+')) {
      result.push({
        type: 'addition',
        content: line,
        authorship: defaultAuthorship,
      });
    } else if (line.startsWith('-')) {
      result.push({
        type: 'deletion',
        content: line,
        authorship: defaultAuthorship,
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
 * Runs git diff and annotates each line with AI/human attribution.
 * AI additions shown in cyan, human additions in green.
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

  // Annotate diff lines
  const annotated = annotateDiffLines(repoPath, diffOutput, commitAuthorship);

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
    }));
    console.log(JSON.stringify(jsonLines, null, 2));
    return;
  }

  // Pretty output
  let aiAdditions = 0;
  let humanAdditions = 0;
  let aiDeletions = 0;
  let humanDeletions = 0;

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
          console.log(chalk.cyan(line.content));
          aiAdditions++;
        } else {
          console.log(chalk.green(line.content));
          humanAdditions++;
        }
        break;
      case 'deletion':
        if (line.authorship === 'ai') {
          console.log(chalk.cyan.dim(line.content));
          aiDeletions++;
        } else {
          console.log(chalk.red(line.content));
          humanDeletions++;
        }
        break;
      case 'context':
        console.log(chalk.gray(line.content));
        break;
    }
  }

  // Summary
  console.log('');
  console.log(chalk.bold('Attribution Summary:'));
  console.log(
    `  ${chalk.cyan('AI:')}    +${aiAdditions} -${aiDeletions}` +
    `    ${chalk.green('Human:')} +${humanAdditions} -${humanDeletions}`,
  );
  console.log('');
}
