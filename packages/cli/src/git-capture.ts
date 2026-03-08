import { execSync } from 'child_process';

// ─── Types ─────────────────────────────────────────────────────────────────

export interface CommitInfo {
  sha: string;
  message: string;
  author: string;
  filesChanged: string[];
}

export interface GitCaptureResult {
  headBefore: string;
  headAfter: string;
  commitShas: string[];     // Real commit SHAs created during session
  commitDetails: CommitInfo[]; // Per-commit metadata
  diff: string;             // Unified diff (capped at MAX_DIFF_SIZE)
  diffTruncated: boolean;
  linesAdded: number;
  linesRemoved: number;
}

// ─── Constants ─────────────────────────────────────────────────────────────

const MAX_DIFF_SIZE = 500_000; // 500KB max diff size

// ─── Main Function ─────────────────────────────────────────────────────────

/**
 * Capture real git state at session end:
 * - Current HEAD SHA
 * - New commits created since headBefore
 * - Full unified diff (committed + uncommitted changes)
 */
export function captureGitState(repoPath: string, headBefore: string | null): GitCaptureResult {
  const execOpts = {
    encoding: 'utf-8' as const,
    cwd: repoPath,
    stdio: ['pipe', 'pipe', 'pipe'] as ['pipe', 'pipe', 'pipe'],
    maxBuffer: 10 * 1024 * 1024, // 10MB buffer for large diffs
  };

  // 1. Get current HEAD
  let headAfter: string;
  try {
    headAfter = execSync('git rev-parse HEAD', execOpts).trim();
  } catch {
    return emptyResult(headBefore || '');
  }

  const safeBefore = headBefore || headAfter;

  // 2. Find commits created during session (between headBefore and headAfter)
  let commitShas: string[] = [];
  if (safeBefore !== headAfter) {
    try {
      const log = execSync(
        `git log --format=%H ${safeBefore}..${headAfter}`,
        execOpts,
      ).trim();
      commitShas = log ? log.split('\n').filter(Boolean) : [];
    } catch {
      // If headBefore is no longer reachable (e.g. rebase), just record headAfter
      commitShas = [headAfter];
    }
  }

  // 3. Capture per-commit metadata (message, author, files changed)
  const commitDetails: CommitInfo[] = [];
  for (const sha of commitShas) {
    try {
      const message = execSync(`git log -1 --format=%s ${sha}`, execOpts).trim();
      const author = execSync(`git log -1 --format=%an ${sha}`, execOpts).trim();
      const filesRaw = execSync(
        `git diff-tree --no-commit-id --name-only -r ${sha}`,
        execOpts,
      ).trim();
      const filesChanged = filesRaw ? filesRaw.split('\n').filter(Boolean) : [];
      commitDetails.push({ sha, message, author, filesChanged });
    } catch {
      // If we can't get details for a commit, include it with minimal info
      commitDetails.push({ sha, message: '', author: '', filesChanged: [] });
    }
  }

  // 4. Build unified diff
  let diff = '';
  let diffTruncated = false;

  try {
    // Committed changes since session start
    if (safeBefore !== headAfter) {
      diff = execSync(`git diff ${safeBefore}..${headAfter}`, execOpts).trim();
    }

    // Also include uncommitted changes (staged + unstaged)
    const uncommitted = execSync('git diff HEAD', execOpts).trim();
    const staged = execSync('git diff --cached', execOpts).trim();

    // Merge: committed changes + unstaged + staged (avoid duplicates from staged)
    if (uncommitted) {
      diff = diff ? diff + '\n' + uncommitted : uncommitted;
    } else if (staged) {
      diff = diff ? diff + '\n' + staged : staged;
    }

    // Enforce size limit
    if (diff.length > MAX_DIFF_SIZE) {
      diff = diff.slice(0, MAX_DIFF_SIZE);
      diffTruncated = true;
    }
  } catch {
    // git diff can fail on shallow clones, detached HEAD issues, etc.
  }

  // 4. Count lines added/removed from diff
  let linesAdded = 0;
  let linesRemoved = 0;

  if (diff) {
    for (const line of diff.split('\n')) {
      if (line.startsWith('+') && !line.startsWith('+++')) linesAdded++;
      if (line.startsWith('-') && !line.startsWith('---')) linesRemoved++;
    }
  }

  return {
    headBefore: safeBefore,
    headAfter,
    commitShas,
    commitDetails,
    diff,
    diffTruncated,
    linesAdded,
    linesRemoved,
  };
}

// ─── Helpers ───────────────────────────────────────────────────────────────

function emptyResult(headBefore: string): GitCaptureResult {
  return {
    headBefore,
    headAfter: headBefore,
    commitShas: [],
    commitDetails: [],
    diff: '',
    diffTruncated: false,
    linesAdded: 0,
    linesRemoved: 0,
  };
}
