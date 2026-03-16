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
 * For a given diff, annotate each added/deleted line with AI or human authorship.
 * Uses git blame on the current file to determine which commit each line belongs to.
 */
function annotateDiffLines(
  repoPath: string,
  diffOutput: string,
  commitAuthorship: Map<string, 'ai' | 'human'>,
): AnnotatedDiffLine[] {
  const lines = diffOutput.split('\n');
  const result: AnnotatedDiffLine[] = [];

  // Build a blame cache per file: lineNumber -> commitSha
  const blameCache = new Map<string, Map<number, string>>();

  function getBlameForFile(filePath: string): Map<number, string> {
    if (blameCache.has(filePath)) return blameCache.get(filePath)!;
    const lineMap = new Map<number, string>();
    try {
      const blame = execSync(
        `git blame --porcelain -- "${filePath}"`,
        execOpts(repoPath),
      );
      let currentSha = '';
      for (const bl of blame.split('\n')) {
        const headerMatch = bl.match(/^([0-9a-f]{40})\s+\d+\s+(\d+)/);
        if (headerMatch) {
          currentSha = headerMatch[1];
          lineMap.set(parseInt(headerMatch[2], 10), currentSha);
        }
      }
    } catch { /* file might not exist yet */ }
    blameCache.set(filePath, lineMap);
    return lineMap;
  }

  // Fallback: if all commits have same authorship, use that
  let uniformAuthorship: 'ai' | 'human' | 'mixed' = 'mixed';
  const authorships = new Set(commitAuthorship.values());
  if (authorships.size === 1) {
    uniformAuthorship = [...authorships][0];
  }

  let currentFile = '';
  let currentLineNum = 0;

  for (const line of lines) {
    if (line.startsWith('diff --git')) {
      result.push({ type: 'header', content: line });
      // Extract file path: diff --git a/path b/path
      const match = line.match(/diff --git a\/.+ b\/(.+)/);
      if (match) currentFile = match[1];
    } else if (line.startsWith('---') || line.startsWith('+++') || line.startsWith('index ')) {
      result.push({ type: 'meta', content: line });
    } else if (line.startsWith('@@')) {
      result.push({ type: 'hunk', content: line });
      // Parse new file line number: @@ -a,b +c,d @@
      const hunkMatch = line.match(/\+(\d+)/);
      if (hunkMatch) currentLineNum = parseInt(hunkMatch[1], 10);
    } else if (line.startsWith('+')) {
      let authorship: 'ai' | 'human' | 'unknown' = 'unknown';
      if (uniformAuthorship !== 'mixed') {
        authorship = uniformAuthorship;
      } else if (currentFile) {
        const blameMap = getBlameForFile(currentFile);
        const blameSha = blameMap.get(currentLineNum);
        if (blameSha && commitAuthorship.has(blameSha)) {
          authorship = commitAuthorship.get(blameSha)!;
        } else if (blameSha) {
          // Commit not in range but exists — check it directly
          authorship = isAiCommit(repoPath, blameSha) ? 'ai' : 'human';
        }
      }
      result.push({ type: 'addition', content: line, authorship });
      currentLineNum++;
    } else if (line.startsWith('-')) {
      // Deletions: attribute to the range's authorship (we can't blame deleted lines)
      let authorship: 'ai' | 'human' | 'unknown' = uniformAuthorship !== 'mixed' ? uniformAuthorship : 'unknown';
      result.push({ type: 'deletion', content: line, authorship });
    } else {
      result.push({ type: 'context', content: line });
      currentLineNum++;
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
