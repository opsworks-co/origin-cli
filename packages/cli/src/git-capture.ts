import { execSync } from 'child_process';
import { shouldIgnoreFile } from './ignore-patterns.js';

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
  diff: string;             // Combined committed + uncommitted (capped at MAX_DIFF_SIZE)
  committedDiff: string;    // Committed changes only (sha..sha)
  uncommittedDiff: string;  // Uncommitted changes only (staged + unstaged + untracked)
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
export function captureGitState(repoPath: string, headBefore: string | null, opts?: { committedOnly?: boolean }): GitCaptureResult {
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
      const filesChanged = filesRaw ? filesRaw.split('\n').filter(Boolean).filter(f => !shouldIgnoreFile(f)) : [];
      commitDetails.push({ sha, message, author, filesChanged });
    } catch {
      // If we can't get details for a commit, include it with minimal info
      commitDetails.push({ sha, message: '', author: '', filesChanged: [] });
    }
  }

  // 4. Build diffs: committedDiff (sha..sha), uncommittedDiff (working tree),
  //    diff (combined for backwards compat)
  let committedDiff = '';
  let uncommittedDiff = '';
  let diffTruncated = false;

  try {
    // Committed changes since session start
    if (safeBefore !== headAfter) {
      committedDiff = execSync(`git diff ${safeBefore}..${headAfter}`, execOpts).trim();
    }

    // Capture uncommitted changes (staged + unstaged + untracked)
    if (!opts?.committedOnly) {
      uncommittedDiff = execSync('git diff HEAD', execOpts).trim();
      // Also capture new untracked files as diff
      try {
        const untracked = execSync(
          'git ls-files --others --exclude-standard',
          execOpts,
        ).trim();
        if (untracked) {
          for (const file of untracked.split('\n').filter(Boolean)) {
            try {
              execSync(`git diff --no-index /dev/null "${file}"`, execOpts);
            } catch (e: any) {
              // git diff --no-index exits 1 on diff, stdout still has the diff
              const out = (e.stdout || '').toString().trim();
              if (out) {
                uncommittedDiff = uncommittedDiff ? uncommittedDiff + '\n' + out : out;
              }
            }
          }
        }
      } catch {
        // ls-files failed — skip untracked
      }
    }

    // Enforce size limits
    if (committedDiff.length > MAX_DIFF_SIZE) {
      committedDiff = committedDiff.slice(0, MAX_DIFF_SIZE);
      diffTruncated = true;
    }
    if (uncommittedDiff.length > MAX_DIFF_SIZE) {
      uncommittedDiff = uncommittedDiff.slice(0, MAX_DIFF_SIZE);
      diffTruncated = true;
    }
  } catch {
    // git diff can fail on shallow clones, detached HEAD issues, etc.
  }

  // Combined diff for backwards compat
  let diff = committedDiff;
  if (uncommittedDiff) {
    diff = diff ? diff + '\n' + uncommittedDiff : uncommittedDiff;
  }

  // Count lines added/removed
  let linesAdded = 0;
  let linesRemoved = 0;
  for (const d of [committedDiff, uncommittedDiff]) {
    if (d) {
      for (const line of d.split('\n')) {
        if (line.startsWith('+') && !line.startsWith('+++')) linesAdded++;
        if (line.startsWith('-') && !line.startsWith('---')) linesRemoved++;
      }
    }
  }

  return {
    headBefore: safeBefore,
    headAfter,
    commitShas,
    commitDetails,
    diff,
    committedDiff,
    uncommittedDiff,
    diffTruncated,
    linesAdded,
    linesRemoved,
  };
}

/**
 * Get list of files with uncommitted changes (staged + unstaged).
 * Used to snapshot the dirty working tree before a prompt starts.
 */
export function getDirtyFiles(repoPath: string): string[] {
  try {
    const execOpts = { cwd: repoPath, encoding: 'utf-8' as const, stdio: ['pipe', 'pipe', 'pipe'] as ['pipe', 'pipe', 'pipe'], timeout: 5000 };
    // Tracked files with changes (staged + unstaged)
    const tracked = execSync('git diff --name-only HEAD', execOpts).trim();
    // Untracked files
    const untracked = execSync('git ls-files --others --exclude-standard', execOpts).trim();
    const files = [
      ...(tracked ? tracked.split('\n').filter(Boolean) : []),
      ...(untracked ? untracked.split('\n').filter(Boolean) : []),
    ];
    return files;
  } catch {
    return [];
  }
}

// ─── Helpers ───────────────────────────────────────────────────────────────

function emptyResult(headBefore: string): GitCaptureResult {
  return {
    headBefore,
    headAfter: headBefore,
    commitShas: [],
    commitDetails: [],
    diff: '',
    committedDiff: '',
    uncommittedDiff: '',
    diffTruncated: false,
    linesAdded: 0,
    linesRemoved: 0,
  };
}
