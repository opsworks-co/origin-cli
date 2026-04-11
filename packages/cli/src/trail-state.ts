import crypto from 'crypto';
import fs from 'fs';
import { git, gitDetailed, gitOrNull } from './utils/exec.js';

const SAFE_ID = /^[a-zA-Z0-9_-]+$/;

// ─── Trail Model ──────────────────────────────────────────────────────────
//
// A Trail represents a unit of work (feature, bug fix, task) that may span
// multiple coding sessions. Trails are stored on the origin-sessions branch
// under trails/<trail-id>.json using the same git plumbing as session files.

export interface Trail {
  id: string;
  name: string;
  branch: string;
  repoPath: string;
  status: 'active' | 'review' | 'done' | 'paused';
  priority: 'low' | 'medium' | 'high' | 'critical';
  labels: string[];
  reviewers: string[];
  sessions: string[];      // Session IDs associated with this trail
  createdAt: string;
  updatedAt: string;
}

// ─── Constants ────────────────────────────────────────────────────────────

const BRANCH = 'origin-sessions';

// ─── Git Plumbing Helpers ─────────────────────────────────────────────────

const execOpts = (cwd: string) => ({
  cwd,
  timeoutMs: 10_000,
  maxBuffer: 5 * 1024 * 1024,
});

/**
 * Generate a short unique trail ID.
 */
export function generateTrailId(): string {
  return crypto.randomBytes(8).toString('hex');
}

/**
 * Read a trail from the origin-sessions branch.
 */
export function readTrail(repoPath: string, trailId: string): Trail | null {
  if (!SAFE_ID.test(trailId)) return null;
  try {
    const content = git(
      ['show', `refs/heads/${BRANCH}:trails/${trailId}.json`],
      execOpts(repoPath),
    ).trim();
    return JSON.parse(content);
  } catch {
    return null;
  }
}

/**
 * List all trails from the origin-sessions branch.
 */
export function listTrails(repoPath: string): Trail[] {
  const trails: Trail[] = [];
  try {
    const listing = git(
      ['ls-tree', '--name-only', `refs/heads/${BRANCH}`, 'trails/'],
      execOpts(repoPath),
    ).trim();

    if (!listing) return trails;

    const files = listing.split('\n').filter(f => f.endsWith('.json'));
    for (const file of files) {
      // Only allow trails/<id>.json with a safe id — defense against
      // weird paths that might have ended up in the tree.
      if (!/^trails\/[a-zA-Z0-9_-]+\.json$/.test(file)) continue;
      try {
        const content = git(
          ['show', `refs/heads/${BRANCH}:${file}`],
          execOpts(repoPath),
        ).trim();
        trails.push(JSON.parse(content));
      } catch { /* skip corrupt files */ }
    }
  } catch { /* branch or directory doesn't exist */ }

  return trails.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

/**
 * Write a trail to the origin-sessions branch using git plumbing.
 * Never touches the working directory or current branch.
 */
export function writeTrail(repoPath: string, trail: Trail): void {
  if (!SAFE_ID.test(trail.id)) return;
  try {
    const opts = execOpts(repoPath);
    const filePath = `trails/${trail.id}.json`;
    const content = JSON.stringify(trail, null, 2) + '\n';

    // PID-scoped temp index
    const tmpIndex = `${repoPath}/.git/origin-tmp-index-trail-${process.pid}`;
    const envWithIndex = { ...process.env, GIT_INDEX_FILE: tmpIndex };
    const indexOpts = { ...opts, env: envWithIndex };

    // Seed from existing branch tree
    const existingTree = gitOrNull(['rev-parse', `refs/heads/${BRANCH}^{tree}`], opts);
    if (existingTree && /^[a-fA-F0-9]+$/.test(existingTree)) {
      try {
        git(['read-tree', existingTree], indexOpts);
      } catch { /* best effort */ }
    }

    // Write blob (needs stdin → use gitDetailed with input)
    const blobRes = gitDetailed(['hash-object', '-w', '--stdin'], { ...opts, input: content });
    if (blobRes.status !== 0) return;
    const blobHash = blobRes.stdout.trim();
    if (!/^[a-fA-F0-9]+$/.test(blobHash)) return;

    // Add to index
    git(
      ['update-index', '--add', '--cacheinfo', `100644,${blobHash},${filePath}`],
      indexOpts,
    );

    // Write tree
    const treeHash = git(['write-tree'], indexOpts).trim();
    if (!/^[a-fA-F0-9]+$/.test(treeHash)) return;

    // Create commit
    const commitMsg = `trail ${trail.id.slice(0, 8)}: ${trail.name} [${trail.status}]`;
    const parentHash = gitOrNull(['rev-parse', `refs/heads/${BRANCH}`], opts);
    const commitArgs = ['commit-tree', treeHash];
    if (parentHash && /^[a-fA-F0-9]+$/.test(parentHash)) {
      commitArgs.push('-p', parentHash);
    }
    commitArgs.push('-m', commitMsg);
    const commitRes = gitDetailed(commitArgs, opts);
    if (commitRes.status !== 0) return;
    const commitHash = commitRes.stdout.trim();
    if (!/^[a-fA-F0-9]+$/.test(commitHash)) return;

    // Update ref
    git(['update-ref', `refs/heads/${BRANCH}`, commitHash], opts);

    // Clean up
    try {
      fs.unlinkSync(tmpIndex);
    } catch { /* ignore */ }
  } catch { /* best effort */ }
}

/**
 * Find trail associated with a branch.
 */
export function findTrailByBranch(repoPath: string, branch: string): Trail | null {
  const trails = listTrails(repoPath);
  return trails.find(t => t.branch === branch) || null;
}

/**
 * Add a session ID to a trail's sessions list.
 */
export function addSessionToTrail(repoPath: string, trailId: string, sessionId: string): void {
  const trail = readTrail(repoPath, trailId);
  if (!trail) return;
  if (trail.sessions.includes(sessionId)) return;
  trail.sessions.push(sessionId);
  trail.updatedAt = new Date().toISOString();
  writeTrail(repoPath, trail);
}
