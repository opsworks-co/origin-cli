import { execSync } from 'child_process';
import crypto from 'crypto';
import fs from 'fs';

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
  encoding: 'utf-8' as const,
  cwd,
  stdio: ['pipe', 'pipe', 'pipe'] as ['pipe', 'pipe', 'pipe'],
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
  try {
    const content = execSync(
      `git show refs/heads/${BRANCH}:trails/${trailId}.json`,
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
    const listing = execSync(
      `git ls-tree --name-only refs/heads/${BRANCH} trails/`,
      execOpts(repoPath),
    ).trim();

    if (!listing) return trails;

    const files = listing.split('\n').filter(f => f.endsWith('.json'));
    for (const file of files) {
      try {
        const content = execSync(
          `git show refs/heads/${BRANCH}:${file}`,
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
  try {
    const opts = execOpts(repoPath);
    const filePath = `trails/${trail.id}.json`;
    const content = JSON.stringify(trail, null, 2) + '\n';

    // PID-scoped temp index
    const tmpIndex = `${repoPath}/.git/origin-tmp-index-trail-${process.pid}`;
    const envWithIndex = { ...process.env, GIT_INDEX_FILE: tmpIndex };
    const indexOpts = { ...opts, env: envWithIndex };

    // Seed from existing branch tree
    try {
      const existingTree = execSync(
        `git rev-parse refs/heads/${BRANCH}^{tree}`,
        opts,
      ).trim();
      execSync(`git read-tree ${existingTree}`, indexOpts);
    } catch {
      // Branch doesn't exist yet
    }

    // Write blob
    const blobHash = execSync(
      `git hash-object -w --stdin`,
      { ...opts, input: content },
    ).trim();

    // Add to index
    execSync(
      `git update-index --add --cacheinfo 100644,${blobHash},${filePath}`,
      indexOpts,
    );

    // Write tree
    const treeHash = execSync(`git write-tree`, indexOpts).trim();

    // Create commit
    const commitMsg = `trail ${trail.id.slice(0, 8)}: ${trail.name} [${trail.status}]`;
    let parentArg = '';
    try {
      const parentHash = execSync(
        `git rev-parse refs/heads/${BRANCH}`,
        opts,
      ).trim();
      parentArg = `-p ${parentHash}`;
    } catch { /* first commit */ }

    const commitHash = execSync(
      `git commit-tree ${treeHash} ${parentArg} -m -`,
      { ...opts, input: commitMsg },
    ).trim();

    // Update ref
    execSync(`git update-ref refs/heads/${BRANCH} ${commitHash}`, opts);

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
