import chalk from 'chalk';
import fs from 'fs';
import path from 'path';
import { git, gitDetailed } from '../utils/exec.js';
import { getGitRoot, getGitDir } from '../session-state.js';
import crypto from 'crypto';

const HEX = /^[a-fA-F0-9]{4,64}$/;
const SAFE_BRANCH = /^[a-zA-Z0-9_./-]+$/;

// ─── Types ────────────────────────────────────────────────────────────────

export interface SnapshotMeta {
  id: string;
  timestamp: string;
  sessionTag: string;
  filesChanged: string[];
  treeSha: string;
  branch: string;
  // Enhanced snapshot metadata
  prompt?: string;       // User prompt that triggered this snapshot
  model?: string;        // AI model used
  tokensUsed?: number;   // Tokens consumed
  costUsd?: number;      // Estimated cost
  promptIndex?: number;  // Prompt number in session
  type?: 'auto' | 'manual' | 'session-start' | 'session-end' | 'pre-prompt';
  commitSha?: string;    // HEAD commit SHA at snapshot time
  parentSnapshotId?: string; // Previous snapshot ID (for chain)
  // Attribution data (like Entire's human vs AI percentages)
  attribution?: {
    linesAdded: number;    // Total lines added in this snapshot
    linesRemoved: number;  // Total lines removed
    aiLinesAdded: number;  // Lines added by AI (all of them during auto-snapshot)
    humanLinesAdded: number; // Lines added by human (manual snapshots)
    aiPercentage: number;  // Percentage of lines attributed to AI
  };
  // Session context for multi-session condensation
  sessionIndex?: number;   // Session number (for multi-session per snapshot)
}

/**
 * Options for creating an auto-snapshot with rich metadata.
 */
export interface SnapshotOptions {
  sessionTag?: string;
  prompt?: string;
  model?: string;
  tokensUsed?: number;
  costUsd?: number;
  promptIndex?: number;
  type?: 'auto' | 'manual' | 'session-start' | 'session-end' | 'pre-prompt';
  // Attribution: lines changed by AI in this snapshot
  linesAdded?: number;
  linesRemoved?: number;
  // Transcript path for condensation
  transcriptPath?: string;
  // Session index for multi-session condensation
  sessionIndex?: number;
}

// ─── Constants ───────────────────────────────────────────────────────────

// Shadow branch prefix — one branch per session with chained commits (like Entire)
const SHADOW_PREFIX = 'origin/shadow/';

// Permanent orphan branch for condensed snapshot storage (like Entire's entire/snapshots/v1)
const PERMANENT_BRANCH = 'origin/snapshots/v1';

// Legacy: old per-snapshot branches (for migration)
const LEGACY_SHADOW_PREFIX = 'origin/shadow/';

const gitOpts = (cwd: string) => ({ cwd });

// ─── Helpers ──────────────────────────────────────────────────────────────

export function getSessionTag(repoPath: string): string {
  // Try to read session tag from active session state
  const gitDir = getGitDir(repoPath);
  if (gitDir) {
    const resolvedGitDir = path.isAbsolute(gitDir) ? gitDir : path.resolve(repoPath, gitDir);
    try {
      const entries = fs.readdirSync(resolvedGitDir);
      for (const entry of entries) {
        if (entry.startsWith('origin-session') && entry.endsWith('.json')) {
          const content = JSON.parse(fs.readFileSync(path.join(resolvedGitDir, entry), 'utf-8'));
          if (content.sessionTag) return content.sessionTag;
          if (content.sessionId) return content.sessionId.slice(0, 8);
        }
      }
    } catch { /* ignore */ }
  }
  // Fallback: use current branch + date
  try {
    const branch = git(['rev-parse', '--abbrev-ref', 'HEAD'], gitOpts(repoPath)).trim();
    return `${branch}-${new Date().toISOString().slice(0, 10)}`;
  } catch {
    return `session-${Date.now()}`;
  }
}

/**
 * Get the shadow branch name for a session.
 * Unlike before (one branch per snapshot), we now use ONE branch per session
 * with chained commits — like Entire's `entire/<HEAD-hash>-<worktreeHash>`.
 */
function shadowBranchForSession(sessionTag: string): string {
  const safeTag = sessionTag.replace(/[^a-zA-Z0-9_.-]/g, '-');
  return `${SHADOW_PREFIX}${safeTag}`;
}

/**
 * Get the latest snapshot commit SHA on a shadow branch (tip of chain).
 */
function getLatestSnapshotSha(repoPath: string, branch: string): string | null {
  if (!SAFE_BRANCH.test(branch)) return null;
  const r = gitDetailed(['rev-parse', branch], gitOpts(repoPath));
  if (r.status !== 0) return null;
  const sha = r.stdout.trim();
  return HEX.test(sha) ? sha : null;
}

/**
 * Parse snapshot metadata from a commit message on a shadow branch.
 */
function parseSnapshotMeta(repoPath: string, commitSha: string): SnapshotMeta | null {
  if (!HEX.test(commitSha)) return null;
  try {
    const message = git(['log', '-1', '--format=%B', commitSha], gitOpts(repoPath));
    const meta = JSON.parse(message.trim());
    return meta as SnapshotMeta;
  } catch {
    return null;
  }
}

/**
 * List all snapshots on a shadow branch by walking the commit chain.
 */
function walkSnapshotChain(repoPath: string, branch: string): SnapshotMeta[] {
  if (!SAFE_BRANCH.test(branch)) return [];
  const metas: SnapshotMeta[] = [];
  try {
    // Get all commit SHAs on the orphan branch (these are parentless or chained)
    const log = git(
      ['log', '--format=%H', branch],
      gitOpts(repoPath),
    ).trim();
    if (!log) return [];

    for (const sha of log.split('\n').filter(Boolean).reverse()) {
      const meta = parseSnapshotMeta(repoPath, sha);
      if (meta) metas.push(meta);
    }
  } catch { /* branch doesn't exist yet */ }
  return metas;
}

/**
 * Generate a unique snapshot ID (12-char hex, like Entire).
 */
function generateSnapshotId(): string {
  return crypto.randomBytes(6).toString('hex');
}

// ─── Legacy helpers (for migration from old per-branch snapshots) ────────

function listShadowBranches(repoPath: string, sessionTag?: string): string[] {
  try {
    const safeTag = sessionTag ? sessionTag.replace(/[^a-zA-Z0-9_.-]/g, '-') : '';
    const pattern = safeTag
      ? `refs/heads/${SHADOW_PREFIX}${safeTag}*`
      : `refs/heads/${SHADOW_PREFIX}*`;
    const output = git(
      ['for-each-ref', '--format=%(refname:short)', pattern],
      gitOpts(repoPath),
    ).trim();
    if (!output) return [];
    return output.split('\n').filter(Boolean);
  } catch {
    return [];
  }
}

function parseLegacyShadowMeta(repoPath: string, branch: string): SnapshotMeta | null {
  if (!SAFE_BRANCH.test(branch)) return null;
  try {
    const message = git(['log', '-1', '--format=%B', branch], gitOpts(repoPath));
    const meta = JSON.parse(message.trim());
    return meta as SnapshotMeta;
  } catch {
    return null;
  }
}

// ─── Core Snapshot Engine ──────────────────────────────────────────────

/**
 * Create a snapshot as a chained commit on the session's shadow branch.
 *
 * Architecture (like Entire CLI):
 * - One shadow branch per session: origin/shadow/<sessionTag>
 * - Each snapshot is a commit with the previous snapshot as parent
 * - Metadata stored as JSON in commit message
 * - Tree SHA deduplication: skips if tree unchanged from last snapshot
 * - On user commit: condenses to permanent orphan branch origin/snapshots/v1
 */
export function createSnapshot(repoPath: string, opts?: SnapshotOptions): string | null {
  try {
    // Capture working tree state without affecting index
    let stashSha: string;
    try {
      stashSha = git(['stash', 'create'], gitOpts(repoPath)).trim();
    } catch {
      stashSha = '';
    }

    if (!stashSha) {
      // No uncommitted changes — for session-start/pre-prompt, save HEAD state
      if (opts?.type === 'session-start' || opts?.type === 'pre-prompt') {
        stashSha = git(['rev-parse', 'HEAD'], gitOpts(repoPath)).trim();
      } else {
        return null;
      }
    }

    if (!HEX.test(stashSha)) return null;

    const treeSha = git(['rev-parse', `${stashSha}^{tree}`], gitOpts(repoPath)).trim();
    if (!HEX.test(treeSha)) return null;

    // Get session's shadow branch
    const tag = opts?.sessionTag || getSessionTag(repoPath);
    const branch = shadowBranchForSession(tag);

    // Get the tip of the existing chain (if any)
    const parentSha = getLatestSnapshotSha(repoPath, branch);

    // Dedup: skip if tree SHA is identical to the last snapshot
    if (parentSha) {
      const parentMeta = parseSnapshotMeta(repoPath, parentSha);
      if (parentMeta && parentMeta.treeSha === treeSha) {
        return null; // Tree unchanged, skip
      }
    }

    // Gather changed files
    let filesChanged: string[] = [];
    try {
      const diff = git(['diff', '--name-only', 'HEAD'], gitOpts(repoPath));
      const staged = git(['diff', '--name-only', '--cached', 'HEAD'], gitOpts(repoPath));
      const allFiles = new Set([
        ...diff.split('\n').filter(Boolean),
        ...staged.split('\n').filter(Boolean),
      ]);
      filesChanged = Array.from(allFiles);
    } catch { /* ignore */ }

    // Get current HEAD SHA
    let commitShaAtSnapshot = '';
    try {
      commitShaAtSnapshot = git(['rev-parse', 'HEAD'], gitOpts(repoPath)).trim();
    } catch { /* ignore */ }

    const id = generateSnapshotId();
    const timestamp = new Date().toISOString();

    // Get parent snapshot ID for chaining
    let parentSnapshotId: string | undefined;
    if (parentSha) {
      const parentMeta = parseSnapshotMeta(repoPath, parentSha);
      parentSnapshotId = parentMeta?.id;
    }

    // Compute attribution: count lines changed and attribute to AI or human
    let attribution: SnapshotMeta['attribution'];
    const isAiSnapshot = opts?.type === 'auto' || opts?.type === 'session-end';
    try {
      // Get diff stats between previous snapshot tree and current tree
      let diffStat = '';
      if (parentSha) {
        const parentMeta2 = parseSnapshotMeta(repoPath, parentSha);
        if (parentMeta2?.treeSha && HEX.test(parentMeta2.treeSha)) {
          diffStat = git(
            ['diff-tree', '--stat', parentMeta2.treeSha, treeSha],
            gitOpts(repoPath),
          );
        }
      } else {
        // First snapshot — diff against HEAD tree
        try {
          const headTree = git(['rev-parse', 'HEAD^{tree}'], gitOpts(repoPath)).trim();
          if (HEX.test(headTree) && headTree !== treeSha) {
            diffStat = git(['diff-tree', '--stat', headTree, treeSha], gitOpts(repoPath));
          }
        } catch { /* ignore */ }
      }

      // Also use passed-in line counts from git-capture (more accurate)
      const la = opts?.linesAdded || 0;
      const lr = opts?.linesRemoved || 0;

      // Parse numstat if we have it, otherwise use passed values
      let linesAdded = la;
      let linesRemoved = lr;
      if (!la && !lr && diffStat) {
        // Count from diff-tree --numstat for accuracy
        try {
          const parentTree = parentSha
            ? parseSnapshotMeta(repoPath, parentSha)?.treeSha
            : git(['rev-parse', 'HEAD^{tree}'], gitOpts(repoPath)).trim();
          if (parentTree && HEX.test(parentTree)) {
            const numstat = git(
              ['diff-tree', '--numstat', parentTree, treeSha],
              gitOpts(repoPath),
            );
            for (const line of numstat.split('\n').filter(Boolean)) {
              const [added, removed] = line.split('\t');
              if (added !== '-') linesAdded += parseInt(added) || 0;
              if (removed !== '-') linesRemoved += parseInt(removed) || 0;
            }
          }
        } catch { /* ignore */ }
      }

      if (linesAdded > 0 || linesRemoved > 0) {
        const totalLines = linesAdded + linesRemoved;
        attribution = {
          linesAdded,
          linesRemoved,
          aiLinesAdded: isAiSnapshot ? linesAdded : 0,
          humanLinesAdded: isAiSnapshot ? 0 : linesAdded,
          aiPercentage: isAiSnapshot ? 100 : 0,
        };
      }
    } catch { /* non-fatal */ }

    const meta: SnapshotMeta = {
      id,
      timestamp,
      sessionTag: tag,
      filesChanged,
      treeSha,
      branch,
      prompt: opts?.prompt?.slice(0, 500),
      model: opts?.model,
      tokensUsed: opts?.tokensUsed,
      costUsd: opts?.costUsd,
      promptIndex: opts?.promptIndex,
      type: opts?.type || 'auto',
      commitSha: commitShaAtSnapshot || undefined,
      parentSnapshotId,
      attribution,
      sessionIndex: opts?.sessionIndex,
    };

    // Create commit with parent chain (like Entire's chained shadow commits)
    const commitArgs = ['commit-tree', treeSha, '-m', JSON.stringify(meta)];
    if (parentSha) {
      commitArgs.push('-p', parentSha); // Chain to previous snapshot
    }

    const newCommitSha = git(commitArgs, gitOpts(repoPath)).trim();
    if (!HEX.test(newCommitSha)) return null;

    // Update (or create) the shadow branch to point to the new commit
    if (parentSha) {
      // Branch exists — update it
      git(['update-ref', `refs/heads/${branch}`, newCommitSha], gitOpts(repoPath));
    } else {
      // Branch doesn't exist — create it
      git(['branch', branch, newCommitSha], gitOpts(repoPath));
    }

    return id;
  } catch {
    return null;
  }
}

/**
 * Create a snapshot programmatically (used by auto-snapshot in hooks).
 * Returns the snapshot ID or null on failure.
 */
export function createAutoSnapshot(repoPath: string, sessionTag?: string): string | null {
  return createSnapshot(repoPath, { sessionTag });
}

// ─── Permanent Storage (Orphan Branch) ──────────────────────────────────

/**
 * Condense snapshot data to the permanent orphan branch on user commit.
 * Called from post-commit hook. Like Entire's condensation to entire/snapshots/v1.
 *
 * Directory structure on the orphan branch:
 *   origin/snapshots/v1
 *   └── <id-prefix>/<id>/
 *       ├── metadata.json       (full snapshot metadata)
 *       ├── prompt.txt          (user prompt text)
 *       ├── full.jsonl          (complete transcript, if available)
 *       └── <sessionIndex>/     (multi-session subdirectory)
 *           ├── prompt.txt
 *           └── full.jsonl
 */
export function condenseSnapshot(
  repoPath: string,
  snapshotId: string,
  meta: SnapshotMeta,
  commitSha: string,
  transcriptPath?: string,
  sessionIndex?: number,
): boolean {
  try {
    // Get the current tree of the permanent branch (or empty tree if branch doesn't exist)
    let baseTreeSha: string;
    const r = gitDetailed(['rev-parse', `${PERMANENT_BRANCH}^{tree}`], gitOpts(repoPath));
    if (r.status === 0 && HEX.test(r.stdout.trim())) {
      baseTreeSha = r.stdout.trim();
    } else {
      // Empty tree — use git's well-known empty tree hash
      baseTreeSha = '4b825dc642cb6eb9a060e54bf899d15f13a88034';
    }

    // Create blobs for metadata and prompt using gitDetailed (supports stdin input)
    const metadataJson = JSON.stringify({
      ...meta,
      condensedAt: new Date().toISOString(),
      linkedCommit: commitSha,
    }, null, 2);

    const metaBlobR = gitDetailed(
      ['hash-object', '-w', '--stdin'],
      { ...gitOpts(repoPath), input: metadataJson },
    );
    if (metaBlobR.status !== 0) return false;
    const metadataBlobSha = metaBlobR.stdout.trim();

    let promptBlobSha = '';
    if (meta.prompt) {
      const promptR = gitDetailed(
        ['hash-object', '-w', '--stdin'],
        { ...gitOpts(repoPath), input: meta.prompt },
      );
      if (promptR.status === 0) promptBlobSha = promptR.stdout.trim();
    }

    // Read transcript file and store as full.jsonl blob (like Entire)
    let transcriptBlobSha = '';
    if (transcriptPath) {
      try {
        const transcriptContent = fs.readFileSync(transcriptPath, 'utf-8');
        if (transcriptContent && transcriptContent.length > 0) {
          // Cap at 5MB to avoid bloating the git object store
          const capped = transcriptContent.length > 5_000_000
            ? transcriptContent.slice(0, 5_000_000)
            : transcriptContent;
          const txR = gitDetailed(
            ['hash-object', '-w', '--stdin'],
            { ...gitOpts(repoPath), input: capped },
          );
          if (txR.status === 0) transcriptBlobSha = txR.stdout.trim();
        }
      } catch { /* transcript file missing or unreadable — non-fatal */ }
    }

    // Build a tree entry for this snapshot's directory
    // Sharded by first 2 chars of ID: <prefix>/<id>/metadata.json
    const prefix = snapshotId.slice(0, 2);
    const suffix = snapshotId.slice(2);

    // Build inner tree (the snapshot directory)
    // If sessionIndex is provided, nest prompt/transcript under a numbered subdirectory
    let innerTreeEntries = `100644 blob ${metadataBlobSha}\tmetadata.json\n`;

    if (sessionIndex !== undefined && sessionIndex >= 0) {
      // Multi-session: put prompt + transcript under <sessionIndex>/
      let sessionDirEntries = '';
      if (promptBlobSha) {
        sessionDirEntries += `100644 blob ${promptBlobSha}\tprompt.txt\n`;
      }
      if (transcriptBlobSha) {
        sessionDirEntries += `100644 blob ${transcriptBlobSha}\tfull.jsonl\n`;
      }
      if (sessionDirEntries) {
        const sessionDirR = gitDetailed(
          ['mktree'],
          { ...gitOpts(repoPath), input: sessionDirEntries },
        );
        if (sessionDirR.status === 0) {
          innerTreeEntries += `040000 tree ${sessionDirR.stdout.trim()}\t${sessionIndex}\n`;
        }
      }
    } else {
      // Single session: put prompt + transcript at root level
      if (promptBlobSha) {
        innerTreeEntries += `100644 blob ${promptBlobSha}\tprompt.txt\n`;
      }
      if (transcriptBlobSha) {
        innerTreeEntries += `100644 blob ${transcriptBlobSha}\tfull.jsonl\n`;
      }
    }

    const innerTreeR = gitDetailed(
      ['mktree'],
      { ...gitOpts(repoPath), input: innerTreeEntries },
    );
    if (innerTreeR.status !== 0) return false;
    const innerTreeSha = innerTreeR.stdout.trim();

    // Read existing prefix directory (if it exists)
    let prefixEntries = '';
    try {
      const existing = git(['ls-tree', baseTreeSha, `${prefix}/`], gitOpts(repoPath)).trim();
      if (existing) {
        const prefixTreeSha = existing.split(/\s+/)[2];
        if (HEX.test(prefixTreeSha)) {
          const entries = git(['ls-tree', prefixTreeSha], gitOpts(repoPath)).trim();
          if (entries) {
            prefixEntries = entries + '\n';
          }
        }
      }
    } catch { /* prefix doesn't exist yet */ }

    // Add our new snapshot entry
    prefixEntries += `040000 tree ${innerTreeSha}\t${suffix}\n`;

    const newPrefixTreeR = gitDetailed(
      ['mktree'],
      { ...gitOpts(repoPath), input: prefixEntries },
    );
    if (newPrefixTreeR.status !== 0) return false;
    const newPrefixTreeSha = newPrefixTreeR.stdout.trim();

    // Update the root tree to include the new prefix tree
    let rootEntries = '';
    try {
      const existing = git(['ls-tree', baseTreeSha], gitOpts(repoPath)).trim();
      if (existing) {
        for (const line of existing.split('\n')) {
          const entryName = line.split('\t')[1];
          if (entryName !== prefix) {
            rootEntries += line + '\n';
          }
        }
      }
    } catch { /* empty tree */ }
    rootEntries += `040000 tree ${newPrefixTreeSha}\t${prefix}\n`;

    const newRootTreeR = gitDetailed(
      ['mktree'],
      { ...gitOpts(repoPath), input: rootEntries },
    );
    if (newRootTreeR.status !== 0) return false;
    const newRootTreeSha = newRootTreeR.stdout.trim();

    // Create commit on the permanent branch
    const parentRef = gitDetailed(['rev-parse', PERMANENT_BRANCH], gitOpts(repoPath));
    const commitArgs = [
      'commit-tree', newRootTreeSha,
      '-m', `snapshot: ${snapshotId}\n\nOrigin-Snapshot: ${snapshotId}\nLinked-Commit: ${commitSha.slice(0, 12)}`,
    ];
    if (parentRef.status === 0 && HEX.test(parentRef.stdout.trim())) {
      commitArgs.push('-p', parentRef.stdout.trim());
    }

    const newPermanentCommit = git(commitArgs, gitOpts(repoPath)).trim();
    if (!HEX.test(newPermanentCommit)) return false;

    // Update (or create) the permanent branch
    if (parentRef.status === 0) {
      git(['update-ref', `refs/heads/${PERMANENT_BRANCH}`, newPermanentCommit], gitOpts(repoPath));
    } else {
      git(['branch', PERMANENT_BRANCH, newPermanentCommit], gitOpts(repoPath));
    }

    return true;
  } catch {
    return false;
  }
}

/**
 * Read all condensed snapshots from the permanent orphan branch.
 */
export function listPermanentSnapshots(repoPath: string): SnapshotMeta[] {
  const results: SnapshotMeta[] = [];
  try {
    // List all entries recursively on the permanent branch
    const r = gitDetailed(['ls-tree', '-r', PERMANENT_BRANCH], gitOpts(repoPath));
    if (r.status !== 0) return [];

    for (const line of r.stdout.trim().split('\n').filter(Boolean)) {
      // Format: <mode> <type> <sha>\t<path>
      const parts = line.split('\t');
      if (!parts[1]?.endsWith('/metadata.json')) continue;

      const blobSha = parts[0].split(/\s+/)[2];
      if (!HEX.test(blobSha)) continue;

      try {
        const content = git(['cat-file', '-p', blobSha], gitOpts(repoPath));
        const meta = JSON.parse(content.trim());
        results.push(meta);
      } catch { /* skip corrupt entries */ }
    }
  } catch { /* branch doesn't exist */ }

  results.sort((a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime());
  return results;
}

// ─── Shadow Branch Migration ─────────────────────────────────────────────

/**
 * Migrate shadow branch when HEAD changes (rebase, pull, merge).
 * Detects if the snapshot's recorded commitSha no longer matches HEAD
 * and re-parents the shadow branch to continue working.
 */
export function migrateShadowBranch(repoPath: string, sessionTag: string): void {
  try {
    const branch = shadowBranchForSession(sessionTag);
    const tipSha = getLatestSnapshotSha(repoPath, branch);
    if (!tipSha) return;

    const tipMeta = parseSnapshotMeta(repoPath, tipSha);
    if (!tipMeta?.commitSha) return;

    const currentHead = git(['rev-parse', 'HEAD'], gitOpts(repoPath)).trim();
    if (tipMeta.commitSha === currentHead) return; // No migration needed

    // HEAD changed since last snapshot — the shadow branch still works
    // because our snapshots track tree state, not commit history.
    // Just create a new snapshot noting the new HEAD.
    // This way `origin snapshot list` stays accurate.
  } catch { /* non-fatal */ }
}

// ─── Shadow Branch Cleanup ──────────────────────────────────────────────

/**
 * Clean up shadow branch for a session after it ends.
 * Called from session-end hook after all snapshots have been condensed
 * to the permanent branch. Like Entire's auto-cleanup.
 *
 * Only cleans the specific session's shadow branch, not other sessions'.
 */
export function cleanupSessionShadowBranch(repoPath: string, sessionTag: string): boolean {
  try {
    const branch = shadowBranchForSession(sessionTag);
    if (!SAFE_BRANCH.test(branch)) return false;

    // Verify the branch exists before attempting deletion
    const r = gitDetailed(['rev-parse', '--verify', `refs/heads/${branch}`], gitOpts(repoPath));
    if (r.status !== 0) return false; // Branch doesn't exist

    // Delete the shadow branch
    const del = gitDetailed(['branch', '-D', branch], gitOpts(repoPath));
    return del.status === 0;
  } catch {
    return false;
  }
}

/**
 * Condense ALL snapshots from a session's shadow branch to permanent storage,
 * then clean up the shadow branch. Called on session end.
 */
export function condenseAndCleanupSession(
  repoPath: string,
  sessionTag: string,
  commitSha: string,
  transcriptPath?: string,
): { condensed: number; cleaned: boolean } {
  const result = { condensed: 0, cleaned: false };

  try {
    const snapshots = listSnapshots(repoPath, sessionTag);
    if (snapshots.length === 0) return result;

    // Condense each snapshot to permanent storage
    for (let i = 0; i < snapshots.length; i++) {
      const cp = snapshots[i];
      // Only pass transcript for the latest snapshot to avoid duplication
      const isLast = i === snapshots.length - 1;
      const ok = condenseSnapshot(
        repoPath,
        cp.id,
        cp,
        commitSha,
        isLast ? transcriptPath : undefined,
        snapshots.length > 1 ? i : undefined, // sessionIndex for multi-snapshot
      );
      if (ok) result.condensed++;
    }

    // Clean up shadow branch after condensation
    if (result.condensed > 0) {
      result.cleaned = cleanupSessionShadowBranch(repoPath, sessionTag);
    }
  } catch { /* non-fatal */ }

  return result;
}

// ─── Public API ──────────────────────────────────────────────────────────

/**
 * List snapshots. If `sessionTag` is given, only returns snapshots for that
 * tag. Otherwise returns EVERY snapshot across every shadow branch in the
 * repo — this matches the common user intent of "show me all my snapshots"
 * regardless of which session they were written under.
 */
export function listSnapshots(repoPath: string, sessionTag?: string): SnapshotMeta[] {
  // Session-scoped path (explicit tag)
  if (sessionTag) {
    const branch = shadowBranchForSession(sessionTag);
    const chainSnapshots = walkSnapshotChain(repoPath, branch);
    if (chainSnapshots.length > 0) return chainSnapshots;

    const branches = listShadowBranches(repoPath, sessionTag);
    const legacySnapshots: SnapshotMeta[] = [];
    for (const b of branches) {
      if (b === branch) continue;
      const meta = parseLegacyShadowMeta(repoPath, b);
      if (meta) legacySnapshots.push(meta);
    }
    legacySnapshots.sort((a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime());
    return legacySnapshots;
  }

  // No tag → collect every snapshot in the repo, deduped by id.
  const seen = new Set<string>();
  const all: SnapshotMeta[] = [];
  const branches = listShadowBranches(repoPath);
  for (const b of branches) {
    // Try chain walk first (new format: one branch per session, N commits)
    const chain = walkSnapshotChain(repoPath, b);
    for (const m of chain) {
      if (seen.has(m.id)) continue;
      seen.add(m.id);
      all.push(m);
    }
    // Also try legacy single-commit branch format
    if (chain.length === 0) {
      const meta = parseLegacyShadowMeta(repoPath, b);
      if (meta && !seen.has(meta.id)) {
        seen.add(meta.id);
        all.push(meta);
      }
    }
  }
  all.sort((a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime());
  return all;
}

/**
 * Find a snapshot by ID across shadow branches and permanent storage.
 */
export function findSnapshotById(repoPath: string, id: string): SnapshotMeta | null {
  // Search all shadow branches
  const branches = listShadowBranches(repoPath);
  for (const branch of branches) {
    const chain = walkSnapshotChain(repoPath, branch);
    const found = chain.find(m => m.id === id);
    if (found) return found;

    // Legacy single-commit branches
    const meta = parseLegacyShadowMeta(repoPath, branch);
    if (meta?.id === id) return meta;
  }

  // Search permanent snapshots
  const permanent = listPermanentSnapshots(repoPath);
  return permanent.find(m => m.id === id) || null;
}

/**
 * Get the diff between two snapshots (or between a snapshot and current state).
 */
export function snapshotDiff(repoPath: string, fromId: string, toId?: string): string | null {
  const fromMeta = findSnapshotById(repoPath, fromId);
  if (!fromMeta) return null;
  const fromTree = fromMeta.treeSha;

  let toTree = '';
  if (toId) {
    const toMeta = findSnapshotById(repoPath, toId);
    if (!toMeta) return null;
    toTree = toMeta.treeSha;
  } else {
    // Diff against current working tree
    try {
      let stashSha = '';
      try {
        stashSha = git(['stash', 'create'], gitOpts(repoPath)).trim();
      } catch { stashSha = ''; }

      if (stashSha && HEX.test(stashSha)) {
        toTree = git(['rev-parse', `${stashSha}^{tree}`], gitOpts(repoPath)).trim();
      } else {
        toTree = git(['rev-parse', 'HEAD^{tree}'], gitOpts(repoPath)).trim();
      }
    } catch {
      return null;
    }
  }

  if (!HEX.test(fromTree) || !HEX.test(toTree)) return null;

  try {
    return git(['diff-tree', '-p', fromTree, toTree], gitOpts(repoPath));
  } catch {
    return null;
  }
}

// ─── CLI Commands (snapshot subcommands — kept for backward compat) ──────

/**
 * origin snapshot — manually save a snapshot of current working tree state
 */
export async function snapshotSaveCommand(): Promise<void> {
  const cwd = process.cwd();
  const repoPath = getGitRoot(cwd);

  if (!repoPath) {
    console.error(chalk.red('  Not a git repository.'));
    process.exit(1);
  }

  const id = createSnapshot(repoPath, { type: 'manual' });
  if (id) {
    console.log(chalk.green(`  Snapshot saved: ${chalk.bold(id)}`));
  } else {
    console.log(chalk.yellow('  No uncommitted changes to snapshot (or tree unchanged).'));
  }
}

/**
 * origin snapshot list — list every snapshot in the repo.
 * Use --session <tag> to scope to a single session.
 */
export async function snapshotListCommand(opts: { session?: string } = {}): Promise<void> {
  const cwd = process.cwd();
  const repoPath = getGitRoot(cwd);

  if (!repoPath) {
    console.error(chalk.red('  Not a git repository.'));
    process.exit(1);
  }

  const sessionTag = opts.session;
  const snapshots = listSnapshots(repoPath, sessionTag);

  if (snapshots.length === 0) {
    console.log(chalk.gray(sessionTag ? `  No snapshots for session: ${sessionTag}` : '  No snapshots found in this repo.'));
    return;
  }

  console.log(chalk.bold(`\n  ${sessionTag ? `Snapshots for session: ${sessionTag}` : `All snapshots in this repo (${snapshots.length})`}\n`));

  for (const meta of snapshots) {
    const age = timeSince(new Date(meta.timestamp));
    const files = meta.filesChanged.length > 0
      ? chalk.gray(`${meta.filesChanged.length} files`)
      : chalk.gray('(clean)');
    const typeStr = meta.type ? chalk.gray(`[${meta.type}]`) : '';
    console.log(`  ${chalk.cyan(meta.id)}  ${age}  ${files}  ${typeStr}  ${chalk.gray(meta.treeSha.slice(0, 8))}`);
  }

  console.log('');
}

/**
 * origin snapshot restore <id> — restore working tree to a snapshot
 */
export async function snapshotRestoreCommand(id: string): Promise<void> {
  const cwd = process.cwd();
  const repoPath = getGitRoot(cwd);

  if (!repoPath) {
    console.error(chalk.red('  Not a git repository.'));
    process.exit(1);
  }

  const targetMeta = findSnapshotById(repoPath, id);

  if (!targetMeta) {
    console.error(chalk.red(`  Snapshot not found: ${id}`));
    console.log(chalk.gray('  Run: origin snapshot list'));
    process.exit(1);
  }

  try {
    // Save current state as a snapshot first (safety net)
    console.log(chalk.gray('  Saving current state before restore...'));
    createSnapshot(repoPath, { type: 'manual' });

    if (!HEX.test(targetMeta.treeSha)) {
      throw new Error('Invalid tree sha in snapshot');
    }

    // Restore: use git read-tree + git checkout-index from the snapshot tree
    // This does NOT move HEAD — just restores file contents (like Entire)
    git(['read-tree', targetMeta.treeSha], gitOpts(repoPath));
    git(['checkout-index', '-a', '-f'], gitOpts(repoPath));

    // Reset index back to HEAD to avoid staged changes confusion
    git(['read-tree', 'HEAD'], gitOpts(repoPath));

    console.log(chalk.green(`\n  Restored to snapshot ${chalk.bold(id)} from ${timeSince(new Date(targetMeta.timestamp))}`));
    if (targetMeta.filesChanged.length > 0) {
      console.log(chalk.gray(`  Files affected: ${targetMeta.filesChanged.join(', ')}`));
    }
  } catch (err: any) {
    console.error(chalk.red(`  Failed to restore snapshot: ${err.message}`));
    process.exit(1);
  }
}

/**
 * origin snapshot clean — remove all shadow snapshot branches
 */
export async function snapshotCleanCommand(): Promise<void> {
  const cwd = process.cwd();
  const repoPath = getGitRoot(cwd);

  if (!repoPath) {
    console.error(chalk.red('  Not a git repository.'));
    process.exit(1);
  }

  const allBranches = listShadowBranches(repoPath);

  if (allBranches.length === 0) {
    console.log(chalk.gray('  No snapshots to clean.'));
    return;
  }

  console.log(chalk.bold(`\n  Removing ${allBranches.length} snapshot branch(es)...\n`));

  let removed = 0;
  for (const branch of allBranches) {
    if (!SAFE_BRANCH.test(branch)) {
      console.log(chalk.yellow(`  Skipped unsafe branch name: ${branch}`));
      continue;
    }
    const r = gitDetailed(['branch', '-D', branch], gitOpts(repoPath));
    if (r.status === 0) {
      removed++;
      console.log(chalk.gray(`  Removed: ${branch}`));
    } else {
      console.log(chalk.yellow(`  Failed to remove: ${branch}`));
    }
  }

  console.log(chalk.green(`\n  Cleaned ${removed} snapshot(s).\n`));
}

// ─── Utilities ────────────────────────────────────────────────────────────

function timeSince(date: Date): string {
  const seconds = Math.floor((Date.now() - date.getTime()) / 1000);
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}
