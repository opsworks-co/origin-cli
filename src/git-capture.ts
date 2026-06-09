import { git, gitDetailed, gitOrNull } from './utils/exec.js';
import { stripIgnoredSectionsFromDiff } from './ignore-patterns.js';
import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';

const HEX = /^[a-fA-F0-9]+$/;

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
  /**
   * Single unified diff of `working tree vs headBefore's tree`. When
   * headBefore is a "shadow commit" (created by createShadowCommit and
   * NOT an ancestor of HEAD), the legacy `committedDiff + uncommittedDiff`
   * pair produces self-canceling text. Use `workingTreeDiff` instead in
   * that case — it's always the clean "what changed between baseline
   * tree and current working tree" view.
   */
  workingTreeDiff: string;
  /**
   * True when headBefore is not an ancestor of HEAD — i.e. headBefore is
   * a shadow commit, so callers should prefer `workingTreeDiff` over the
   * `committedDiff + uncommittedDiff` pair.
   */
  baselineIsShadow: boolean;
}

// ─── Constants ─────────────────────────────────────────────────────────────

const MAX_DIFF_SIZE = 500_000; // 500KB max diff size

/**
 * Maximum byte length for a single per-prompt diff in payloads sent to the
 * API (PATCH /api/mcp/session/:id `promptChanges[].diff` /
 * `.uncommittedDiff`, plus the equivalent endpoints under /session/end and
 * /commits/ingest's per-prompt blocks).
 *
 * MUST match the API's per-prompt cap in apps/api/src/routes/mcp.ts:~1540
 * (`.slice(0, 200_000)` on each incoming `pc.diff` / `pc.uncommittedDiff`).
 * If the CLI sends a SMALLER slice than the API would store we silently
 * drop bytes the API would have happily accepted — a hard-to-spot
 * truncation that was capping every per-prompt diff at 100KB across nine
 * call sites before this constant existed.
 *
 * Bumping requires a coordinated update on the API side first; bumping
 * down here is safe (API just stores less).
 */
export const MAX_PROMPT_DIFF_LEN = 200_000;

// ─── Main Function ─────────────────────────────────────────────────────────

/**
 * Capture real git state at session end:
 * - Current HEAD SHA
 * - New commits created since headBefore
 * - Full unified diff (committed + uncommitted changes)
 */
export function captureGitState(
  repoPath: string,
  headBefore: string | null,
  opts?: {
    committedOnly?: boolean;
    // When true, run git diff with `--unified=99999` so the produced diff
    // contains the entire file as context — gives AI Blame the full file
    // to render with line-level attribution instead of "N lines hidden"
    // gaps between hunks. Bigger payload (capped by MAX_DIFF_SIZE), so
    // callers should only opt in for session-level snapshots, not the
    // per-prompt deltas that fire on every heartbeat.
    fullContext?: boolean;
  },
): GitCaptureResult {
  const gitOpts = {
    cwd: repoPath,
    timeoutMs: 15_000,
    maxBuffer: 10 * 1024 * 1024, // 10MB buffer for large diffs
  };
  // Bounded "large context" instead of unlimited. 2000 lines covers a
  // typical full source file but caps the worst case so a giant generated
  // file (lock file, fixture, build artifact) doesn't blow up
  // MAX_DIFF_SIZE and truncate mid-hunk into a malformed diff that the
  // UI parser then chokes on. AI Blame still gets full-file rendering
  // for all reasonable source files.
  const unifiedFlag = opts?.fullContext ? ['--unified=2000'] : [];

  // 1. Get current HEAD
  const headAfter = gitOrNull(['rev-parse', 'HEAD'], gitOpts);
  if (!headAfter || !HEX.test(headAfter)) {
    return emptyResult(headBefore || '');
  }

  const safeBefore = headBefore && HEX.test(headBefore) ? headBefore : headAfter;

  // 2. Find commits created during session (between headBefore and headAfter)
  let commitShas: string[] = [];
  if (safeBefore !== headAfter) {
    try {
      const log = git(
        ['log', '--format=%H', `${safeBefore}..${headAfter}`],
        gitOpts,
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
    if (!HEX.test(sha)) continue;
    try {
      const message = git(['log', '-1', '--format=%s', sha], gitOpts).trim();
      const author = git(['log', '-1', '--format=%an', sha], gitOpts).trim();
      const filesRaw = git(
        ['diff-tree', '--no-commit-id', '--name-only', '-r', sha],
        gitOpts,
      ).trim();
      // Don't filter filesChanged through shouldIgnoreFile — this list is the
      // commit's metadata answer to "which files did this commit touch" and
      // drives Commit.fileCount on the dashboard. Hiding lock files / dist /
      // generated entries here makes the UI report fewer files than git
      // actually shows. Diff-content filtering still happens at the patch
      // layer (stripIgnoredSectionsFromDiff), which is the right place to
      // hide bookkeeping changes without lying about file counts.
      const filesChanged = filesRaw ? filesRaw.split('\n').filter(Boolean) : [];
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
      committedDiff = git(['diff', ...unifiedFlag, `${safeBefore}..${headAfter}`], gitOpts).trim();
    }

    // Capture uncommitted changes (staged + unstaged + untracked)
    if (!opts?.committedOnly) {
      uncommittedDiff = git(['diff', ...unifiedFlag, 'HEAD'], gitOpts).trim();
      // Also capture new untracked files as diff
      try {
        const untracked = git(
          ['ls-files', '--others', '--exclude-standard'],
          gitOpts,
        ).trim();
        if (untracked) {
          for (const file of untracked.split('\n').filter(Boolean)) {
            // git diff --no-index exits 1 on diff; use gitDetailed to capture
            // stdout regardless of status. Pass the file path as a positional
            // arg — no shell, no quoting required.
            const r = gitDetailed(['diff', '--no-index', '/dev/null', file], gitOpts);
            const out = (r.stdout || '').trim();
            if (out) {
              uncommittedDiff = uncommittedDiff ? uncommittedDiff + '\n' + out : out;
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

  // Single "working tree vs baseline" diff — clean even when baseline is
  // a shadow commit not in HEAD's ancestry. Use this in callers that
  // store the diff per-prompt for AI blame.
  let workingTreeDiff = '';
  let baselineIsShadow = false;
  if (safeBefore && safeBefore !== headAfter) {
    try {
      // Is baseline an ancestor of HEAD? If not, it's a shadow commit.
      const ancestorRes = gitDetailed(['merge-base', '--is-ancestor', safeBefore, headAfter], gitOpts);
      baselineIsShadow = ancestorRes.status !== 0;
    } catch {
      baselineIsShadow = false;
    }
  }
  try {
    if (safeBefore) {
      // `git diff <commit>` compares working tree to commit's tree.
      // Includes staged + unstaged. Untracked still needs special handling.
      workingTreeDiff = git(['diff', ...unifiedFlag, safeBefore], gitOpts).trim();
      // Append untracked file diffs
      if (!opts?.committedOnly) {
        try {
          const untracked = git(['ls-files', '--others', '--exclude-standard'], gitOpts).trim();
          if (untracked) {
            for (const file of untracked.split('\n').filter(Boolean)) {
              const r = gitDetailed(['diff', '--no-index', '/dev/null', file], gitOpts);
              const out = (r.stdout || '').trim();
              if (out) workingTreeDiff = workingTreeDiff ? workingTreeDiff + '\n' + out : out;
            }
          }
        } catch { /* skip */ }
      }
      if (workingTreeDiff.length > MAX_DIFF_SIZE) {
        workingTreeDiff = workingTreeDiff.slice(0, MAX_DIFF_SIZE);
        diffTruncated = true;
      }
    }
  } catch {
    workingTreeDiff = '';
  }

  // Strip diff sections targeting ignored files (lock files, generated
  // dirs, Origin's own AGENTS.md / GEMINI.md / .windsurfrules). These
  // contribute noise to the per-prompt blame view — AGENTS.md alone shows
  // up as 13+ "AI-attributed" lines on every Codex turn because Origin
  // rewrites it as bookkeeping, not agent output.
  diff = stripIgnoredSectionsFromDiff(diff);
  committedDiff = stripIgnoredSectionsFromDiff(committedDiff);
  uncommittedDiff = stripIgnoredSectionsFromDiff(uncommittedDiff);
  workingTreeDiff = stripIgnoredSectionsFromDiff(workingTreeDiff);

  // Count lines added/removed
  let linesAdded = 0;
  let linesRemoved = 0;
  // For shadow baseline, use workingTreeDiff (committedDiff would be reverse).
  const countSrc = baselineIsShadow && workingTreeDiff
    ? [workingTreeDiff]
    : [committedDiff, uncommittedDiff];
  for (const d of countSrc) {
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
    workingTreeDiff,
    baselineIsShadow,
  };
}

/**
 * Get list of files with uncommitted changes (staged + unstaged).
 * Used to snapshot the dirty working tree before a prompt starts.
 */
export function getDirtyFiles(repoPath: string): string[] {
  try {
    const gitOpts = { cwd: repoPath, timeoutMs: 5_000 };
    // Tracked files with changes (staged + unstaged)
    const tracked = git(['diff', '--name-only', 'HEAD'], gitOpts).trim();
    // Untracked files
    const untracked = git(['ls-files', '--others', '--exclude-standard'], gitOpts).trim();
    const files = [
      ...(tracked ? tracked.split('\n').filter(Boolean) : []),
      ...(untracked ? untracked.split('\n').filter(Boolean) : []),
    ];
    return files;
  } catch {
    return [];
  }
}

/**
 * Create a "shadow commit" that captures the current working-tree state
 * (HEAD + staged + unstaged + untracked) as a real commit object.
 *
 * Returns the SHA of the new commit, or null on failure.
 *
 * This is used to anchor `prePromptSha` at a per-prompt baseline so that
 * the diff for the NEXT prompt is computed against "the state at end of
 * the previous prompt" — not against the last real HEAD, which would
 * incorrectly include any uncommitted-then-later-committed work from the
 * previous prompt.
 *
 * The shadow commit is kept alive via `refs/origin/shadow/<tag>` so git
 * GC can't prune it before the next STOP.
 *
 * NOTE: This does NOT modify the user's working tree, branch, or index.
 * It writes to a private temp index file, never to .git/index.
 */
export function createShadowCommit(repoPath: string, tag: string): string | null {
  try {
    const gitOpts = { cwd: repoPath, timeoutMs: 10_000, maxBuffer: 10 * 1024 * 1024 };

    const headSha = gitOrNull(['rev-parse', 'HEAD'], gitOpts);
    if (!headSha || !HEX.test(headSha)) return null;

    // Use a private index file so we don't touch .git/index.
    // The temp index starts as a copy of HEAD's tree.
    const tmpIndex = path.join(os.tmpdir(), `origin-shadow-${process.pid}-${Date.now()}.idx`);
    const indexOpts = { ...gitOpts, env: { ...process.env, GIT_INDEX_FILE: tmpIndex } };

    try {
      // 1. Seed the temp index with HEAD's tree
      git(['read-tree', 'HEAD'], indexOpts);

      // 2. Stage all changes from the working tree (tracked changes +
      //    deletions) into the temp index.
      try {
        git(['add', '-A', '--', '.'], indexOpts);
      } catch {
        // best-effort: continue even if some paths fail
      }

      // 3. write-tree against the temp index
      const treeSha = git(['write-tree'], indexOpts).trim();
      if (!HEX.test(treeSha)) return null;

      // 4. Skip if the tree is identical to HEAD's (nothing dirty —
      //    caller should normally avoid calling us in that case, but
      //    we double-check so we never create no-op shadow commits)
      const headTree = gitOrNull(['rev-parse', `${headSha}^{tree}`], gitOpts);
      if (headTree === treeSha) return null;

      // 5. commit-tree with HEAD as parent
      const commitRes = gitDetailed(
        ['commit-tree', treeSha, '-p', headSha, '-m', `origin shadow ${tag} ${new Date().toISOString()}`],
        gitOpts,
      );
      if (commitRes.status !== 0) return null;
      const shadowSha = (commitRes.stdout || '').trim();
      if (!HEX.test(shadowSha)) return null;

      // 6. Keep it reachable so git GC doesn't prune it before next STOP
      try {
        git(['update-ref', `refs/origin/shadow/${tag}`, shadowSha], gitOpts);
      } catch { /* non-fatal — commit object still exists in objects/, GC won't run immediately */ }

      return shadowSha;
    } finally {
      try { fs.unlinkSync(tmpIndex); } catch { /* ignore */ }
    }
  } catch {
    return null;
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
    workingTreeDiff: '',
    baselineIsShadow: false,
  };
}
