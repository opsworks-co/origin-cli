import fs from 'fs';
import path from 'path';
import { gitOrNull, runDetailed } from './utils/exec.js';
import { rewriteAttributionForTarget, type RewriteTargetOutcome } from './history-preservation.js';
import type { RewriteWarning } from './history-rewrite.js';

// ─── Types ─────────────────────────────────────────────────────────────────

export interface CIAttributionReport {
  totalCommits: number;
  aiCommits: number;
  humanCommits: number;
  aiPercentage: number;
  totalLinesAdded: number;
  totalLinesRemoved: number;
  sessions: string[];
  models: string[];
}

// ─── CI Check ──────────────────────────────────────────────────────────────

/**
 * Generate an attribution report for CI output.
 * Walks recent commits and checks for Origin git notes.
 *
 * @param repoPath - Git repository root path
 * @param commitRange - Optional range (e.g., "main..HEAD", or last N commits)
 */
export function generateCIReport(repoPath: string, commitRange?: string): CIAttributionReport {
  const gitOpts = { cwd: repoPath, timeoutMs: 10_000 };

  const report: CIAttributionReport = {
    totalCommits: 0,
    aiCommits: 0,
    humanCommits: 0,
    aiPercentage: 0,
    totalLinesAdded: 0,
    totalLinesRemoved: 0,
    sessions: [],
    models: [],
  };

  // Get commit list. Validate range to prevent command injection — only
  // accept ranges made of hex SHAs, branch-safe chars, and `..`/`...`.
  const range = commitRange || 'HEAD~10..HEAD';
  if (!/^[a-zA-Z0-9_./~^-]+(?:\.{2,3}[a-zA-Z0-9_./~^-]+)?$/.test(range)) {
    return report;
  }
  let commits: string[];
  try {
    const raw = gitOrNull(['rev-list', range], gitOpts)
      ?? gitOrNull(['rev-list', '--max-count=10', 'HEAD'], gitOpts);
    commits = (raw || '').split('\n').filter(Boolean);
  } catch {
    return report;
  }

  report.totalCommits = commits.length;
  const sessionsSet = new Set<string>();
  const modelsSet = new Set<string>();

  for (const sha of commits) {
    if (!/^[a-fA-F0-9]+$/.test(sha)) continue;
    // Check for Origin note
    try {
      const r = runDetailed('git', ['notes', '--ref=origin', 'show', sha], gitOpts);
      const note = r.status === 0 ? r.stdout.trim() : '';

      if (note) {
        const parsed = JSON.parse(note);
        const origin = parsed.origin;
        if (origin) {
          report.aiCommits++;
          if (origin.sessionId) sessionsSet.add(origin.sessionId);
          if (origin.model) modelsSet.add(origin.model);
          report.totalLinesAdded += origin.linesAdded || 0;
          report.totalLinesRemoved += origin.linesRemoved || 0;
        }
      }
    } catch {
      // No note or parse error — count as human commit
    }
  }

  report.humanCommits = report.totalCommits - report.aiCommits;
  report.aiPercentage = report.totalCommits > 0
    ? Math.round((report.aiCommits / report.totalCommits) * 100)
    : 0;
  report.sessions = Array.from(sessionsSet);
  report.models = Array.from(modelsSet);

  return report;
}

/**
 * Format a CI report as a text table for CI output.
 */
export function formatCIReport(report: CIAttributionReport): string {
  const lines: string[] = [
    '=== Origin Attribution Report ===',
    '',
    `Total Commits:    ${report.totalCommits}`,
    `AI-Assisted:      ${report.aiCommits} (${report.aiPercentage}%)`,
    `Human-Only:       ${report.humanCommits}`,
    `Lines Added:      +${report.totalLinesAdded}`,
    `Lines Removed:    -${report.totalLinesRemoved}`,
  ];

  if (report.sessions.length > 0) {
    lines.push(`Sessions:         ${report.sessions.length}`);
  }
  if (report.models.length > 0) {
    lines.push(`Models:           ${report.models.join(', ')}`);
  }

  lines.push('');
  lines.push('================================');

  return lines.join('\n');
}

// ─── Squash Merge ──────────────────────────────────────────────────────────
//
// A squash merge — `git merge --squash` + commit, or a forge's "Squash and
// merge" — runs no post-rewrite hook and states no old→new pairs, and on a
// hosted forge it happens where no Origin hook runs at all. The only honest
// mapping is an explicit one: the range of the original commits and the squash
// commit they became. Nothing is inferred from HEAD: after the merge HEAD IS
// the squash commit, and `<base>..HEAD` no longer holds the original commits.
// The note is rebuilt exactly as for a rebase squash (history-rewrite.ts): one
// commit-level v1 record with every proven contribution, and a legacy aggregate
// that sums nothing.

export interface SquashMergeOptions {
  /** `<base-before-merge>..<source-tip>`: the original commits. */
  range: string;
  /** The squash commit. */
  target: string;
  /**
   * For automation that cannot tell a squash from another merge method: a
   * target that is provably not a squash commit is skipped (success, nothing
   * written) instead of being an error.
   */
  skipUnlessSquash?: boolean;
}

export interface SquashMergeResult {
  success: boolean;
  message: string;
  /**
   * Why it failed. `usage`: the command was called wrong — never masked.
   * `operational`: this repository cannot carry the attribution right now (a
   * source not fetched, an unresolvable or empty range, a target that is not a
   * squash, a held note lock, git failing) — `--warn-only` reports it and exits 0.
   */
  failure?: 'usage' | 'operational';
  outcome?: RewriteTargetOutcome | 'not-squash';
  /** Full sha of the squash commit. */
  target?: string;
  /** Full shas of the source commits in the range. */
  sources?: string[];
  warnings?: RewriteWarning[];
}

const SQUASH_REV = /^[A-Za-z0-9_][A-Za-z0-9_./~^@{}-]*$/;

function resolveRev(repoPath: string, rev: string): string | null {
  if (!SQUASH_REV.test(rev)) return null;
  const r = runDetailed('git', ['rev-parse', '--verify', '--quiet', `${rev}^{commit}`], { cwd: repoPath, timeoutMs: 10_000 });
  const full = r.status === 0 ? r.stdout.trim().toLowerCase() : '';
  return /^([0-9a-f]{40}|[0-9a-f]{64})$/.test(full) ? full : null;
}

/**
 * The commit of `range` that `target` is a rebased copy of, if any. A rebase
 * (a forge's "Rebase and merge" included) keeps each commit's author, author
 * date and message; a squash commit of several commits is a new commit with
 * its own. Used only to REFUSE a write, never to map attribution.
 */
function rebasedCopyOf(repoPath: string, target: string, range: string): string | null {
  const fmt = '--format=%H%x00%an%x00%ae%x00%at%x00%B%x1e';
  const own = runDetailed('git', ['log', '-1', fmt, target], { cwd: repoPath, timeoutMs: 10_000 });
  const all = runDetailed('git', ['log', fmt, range], { cwd: repoPath, timeoutMs: 30_000 });
  if (own.status !== 0 || all.status !== 0) return null;
  const identity = (rec: string) => rec.slice(rec.indexOf('\0') + 1).trim();
  const mine = identity(own.stdout.split('\x1e')[0]);
  for (const rec of all.stdout.split('\x1e')) {
    const r = rec.replace(/^\s+/, '');
    if (r && identity(r) === mine) return r.slice(0, r.indexOf('\0'));
  }
  return null;
}

/**
 * Carry the attribution of the commits in `range` to the squash commit
 * `target`. Writes at most one note, on `target`; never touches the sources'
 * notes; a second run with the same inputs changes nothing.
 */
export function squashMergeAttribution(repoPath: string, opts: SquashMergeOptions): SquashMergeResult {
  const parts = (opts.range || '').split('..');
  if (parts.length !== 2 || !parts[0] || !parts[1] || parts[1].startsWith('.')) {
    return { success: false, failure: 'usage', message: `--range must be <base-before-merge>..<source-tip>, got "${opts.range || ''}".` };
  }
  const base = resolveRev(repoPath, parts[0]);
  const tip = resolveRev(repoPath, parts[1]);
  if (!base || !tip) {
    return {
      success: false,
      failure: 'operational',
      message: `Cannot resolve ${!base ? parts[0] : parts[1]} to a commit here. Fetch the original commits `
        + '(for a pull request: its head ref) before carrying their attribution; nothing was written.',
    };
  }
  const target = resolveRev(repoPath, opts.target || '');
  if (!target) return { success: false, failure: 'operational', message: `Cannot resolve --target ${opts.target || '(empty)'} to a commit; nothing was written.` };

  const parents = runDetailed('git', ['rev-list', '--parents', '-n', '1', target], { cwd: repoPath, timeoutMs: 10_000 });
  const parentCount = parents.status === 0 ? parents.stdout.trim().split(/\s+/).length - 1 : -1;
  if (parentCount !== 1) {
    if (opts.skipUnlessSquash && parentCount > 1) {
      return { success: true, outcome: 'not-squash', target, message: `${target.slice(0, 12)} is a merge commit, not a squash; its original commits keep their own notes. Nothing was written.` };
    }
    return {
      success: false,
      failure: 'operational',
      message: `--target ${target.slice(0, 12)} has ${parentCount < 0 ? 'unknown' : parentCount} parents; a squash commit has one. `
        + 'A merge commit keeps the original commits as ancestors, and their own notes already apply.',
    };
  }

  const list = runDetailed('git', ['rev-list', `${base}..${tip}`], { cwd: repoPath, timeoutMs: 30_000 });
  if (list.status !== 0) return { success: false, failure: 'operational', message: 'Could not list the source commits; nothing was written.' };
  const sources = list.stdout.split('\n').map((l) => l.trim().toLowerCase()).filter(Boolean);
  if (sources.length === 0) {
    return { success: false, failure: 'operational', message: `The range ${parts[0]}..${parts[1]} holds no commits; nothing was written.` };
  }
  if (sources.includes(target)) {
    return { success: false, failure: 'operational', message: `--target ${target.slice(0, 12)} is inside the source range; it must be the squash commit.` };
  }
  if (opts.skipUnlessSquash && sources.length > 1) {
    const copied = rebasedCopyOf(repoPath, target, `${base}..${tip}`);
    if (copied) {
      return {
        success: true, outcome: 'not-squash', target, sources,
        message: `${target.slice(0, 12)} is a rebased copy of ${copied.slice(0, 12)} (same author, author date and message), not a squash of ${sources.length} commits. Nothing was written.`,
      };
    }
  }

  const { outcome, warnings } = rewriteAttributionForTarget(repoPath, target, sources);
  const where = `${target.slice(0, 12)} from ${sources.length} source commit${sources.length === 1 ? '' : 's'}`;
  switch (outcome) {
    case 'written':
      return { success: true, outcome, target, sources, warnings, message: `Attribution note written to ${where}.` };
    case 'unchanged':
      return { success: true, outcome, target, sources, warnings, message: `The note on ${target.slice(0, 12)} already carries this attribution; nothing changed.` };
    case 'skipped':
      return { success: true, outcome, target, sources, warnings, message: `No Origin attribution on the ${sources.length} source commits; nothing was written.` };
    default:
      return { success: false, failure: 'operational', outcome, target, sources, warnings, message: `Could not read or write the notes for ${where}.` };
  }
}

// ─── GitHub Actions Workflow ───────────────────────────────────────────────

/**
 * Generate a GitHub Actions YAML snippet for Origin CI integration.
 *
 * The squash job runs on `closed` (the trigger lists it) for a merged pull
 * request, only where the repository opted in (ORIGIN_SQUASH_MERGE_ONLY: the
 * event does not state the merge method), and hands `origin ci squash-merge`
 * the SHAs the event states: the squash commit (`merge_commit_sha`), the base
 * before the merge (its first parent) and the PR head. The head is fetched by
 * its pull ref, which outlives a deleted branch.
 */
export function generateGitHubActionsWorkflow(): string {
  return `# Origin CI Attribution
# Add this to your .github/workflows/ directory
name: Origin Attribution

on:
  pull_request:
    types: [opened, synchronize, closed]

jobs:
  attribution:
    if: github.event.action != 'closed'
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
        with:
          fetch-depth: 0  # Full history for attribution analysis

      - name: Setup Node.js
        uses: actions/setup-node@v4
        with:
          node-version: '20'

      - name: Install Origin CLI
        run: npm install -g @origin/cli

      - name: Login to Origin
        run: origin login --token \${{ secrets.ORIGIN_API_KEY }}

      - name: Attribution Check
        run: |
          echo "## Attribution Report" >> \$GITHUB_STEP_SUMMARY
          origin ci check --range "\${{ github.event.pull_request.base.sha }}..\${{ github.sha }}" >> \$GITHUB_STEP_SUMMARY

  # OPT-IN. The pull_request event does not say HOW a pull request was
  # merged, so this job runs only in a repository whose settings allow
  # "Squash and merge" and nothing else, and says so by setting the repository
  # variable ORIGIN_SQUASH_MERGE_ONLY to "true". --skip-unless-squash still
  # exits 0 and writes nothing for a merge commit or a rebased copy.
  # --warn-only: the pull request is already merged, so a run that cannot carry
  # the attribution (originals not fetchable, a held note lock) warns and
  # writes nothing instead of failing the merged pull request.
  squash-attribution:
    if: github.event.action == 'closed' && github.event.pull_request.merged == true && vars.ORIGIN_SQUASH_MERGE_ONLY == 'true'
    runs-on: ubuntu-latest
    permissions:
      contents: write  # pushes refs/notes/origin
    steps:
      - uses: actions/checkout@v4
        with:
          ref: \${{ github.event.pull_request.base.ref }}
          fetch-depth: 0

      - name: Setup Node.js
        uses: actions/setup-node@v4
        with:
          node-version: '20'

      - name: Install Origin CLI
        run: npm install -g @origin/cli

      - name: Fetch the pull request's original commits and the attribution notes
        run: |
          git fetch --no-tags origin "+refs/pull/\${{ github.event.pull_request.number }}/head:refs/origin-ci/pr-head"
          git fetch --no-tags origin "+refs/notes/origin:refs/notes/origin" || echo "no attribution notes on the remote yet"

      - name: Carry attribution to the squash commit
        run: |
          origin ci squash-merge \\
            --range "\${{ github.event.pull_request.merge_commit_sha }}^..\${{ github.event.pull_request.head.sha }}" \\
            --target "\${{ github.event.pull_request.merge_commit_sha }}" \\
            --skip-unless-squash \\
            --warn-only

      - name: Publish the notes
        run: origin push-metadata
`;
}
