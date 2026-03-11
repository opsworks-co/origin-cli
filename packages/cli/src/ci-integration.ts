import { execSync } from 'child_process';
import fs from 'fs';
import path from 'path';

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

export interface SquashMergeResult {
  success: boolean;
  message: string;
  combinedNote?: string;
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
  const execOpts = {
    cwd: repoPath,
    encoding: 'utf-8' as const,
    stdio: ['pipe', 'pipe', 'pipe'] as ['pipe', 'pipe', 'pipe'],
  };

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

  // Get commit list
  const range = commitRange || 'HEAD~10..HEAD';
  let commits: string[];
  try {
    commits = execSync(
      `git rev-list ${range} 2>/dev/null || git rev-list --max-count=10 HEAD`,
      execOpts,
    ).trim().split('\n').filter(Boolean);
  } catch {
    return report;
  }

  report.totalCommits = commits.length;
  const sessionsSet = new Set<string>();
  const modelsSet = new Set<string>();

  for (const sha of commits) {
    // Check for Origin note
    try {
      const note = execSync(
        `git notes --ref=origin show ${sha} 2>/dev/null`,
        execOpts,
      ).trim();

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

/**
 * Collect attribution from all commits being squashed and write a combined
 * note to the new squash-merge commit.
 *
 * @param repoPath - Git repository root path
 * @param baseBranch - The base branch being merged into (e.g., "main")
 */
export function collectSquashMergeAttribution(
  repoPath: string,
  baseBranch: string,
): SquashMergeResult {
  const execOpts = {
    cwd: repoPath,
    encoding: 'utf-8' as const,
    stdio: ['pipe', 'pipe', 'pipe'] as ['pipe', 'pipe', 'pipe'],
  };

  try {
    // Get commits between base branch and HEAD
    const commits = execSync(
      `git rev-list ${baseBranch}..HEAD`,
      execOpts,
    ).trim().split('\n').filter(Boolean);

    if (commits.length === 0) {
      return { success: false, message: `No commits found between ${baseBranch} and HEAD.` };
    }

    // Collect all Origin notes from these commits
    const allSessions = new Set<string>();
    const allModels = new Set<string>();
    let totalLinesAdded = 0;
    let totalLinesRemoved = 0;
    let totalTokensUsed = 0;
    let totalCostUsd = 0;
    let totalDurationMs = 0;
    let noteCount = 0;

    for (const sha of commits) {
      try {
        const note = execSync(
          `git notes --ref=origin show ${sha} 2>/dev/null`,
          execOpts,
        ).trim();

        if (!note) continue;

        const parsed = JSON.parse(note);
        const origin = parsed.origin;
        if (!origin) continue;

        noteCount++;
        if (origin.sessionId) allSessions.add(origin.sessionId);
        if (origin.model) allModels.add(origin.model);
        totalLinesAdded += origin.linesAdded || 0;
        totalLinesRemoved += origin.linesRemoved || 0;
        totalTokensUsed += origin.tokensUsed || 0;
        totalCostUsd += origin.costUsd || 0;
        totalDurationMs += origin.durationMs || 0;
      } catch {
        // Skip commits without notes
      }
    }

    if (noteCount === 0) {
      return { success: true, message: 'No Origin attribution found in commits being squashed.' };
    }

    // Build combined note
    const combinedNote = JSON.stringify({
      origin: {
        version: 1,
        squashMerge: true,
        commitsSquashed: commits.length,
        sessionIds: Array.from(allSessions),
        models: Array.from(allModels),
        totalLinesAdded,
        totalLinesRemoved,
        totalTokensUsed,
        totalCostUsd: parseFloat(totalCostUsd.toFixed(4)),
        totalDurationMs,
        timestamp: new Date().toISOString(),
      },
    }, null, 2);

    return {
      success: true,
      message: `Collected attribution from ${noteCount} of ${commits.length} commits ` +
        `(${allSessions.size} sessions, ${allModels.size} models).`,
      combinedNote,
    };
  } catch (err: any) {
    return { success: false, message: `Failed to collect attribution: ${err.message}` };
  }
}

/**
 * Write a combined attribution note to a specific commit SHA.
 */
export function writeCombinedNote(repoPath: string, commitSha: string, noteContent: string): boolean {
  try {
    execSync(
      `git notes --ref=origin add -f -m ${escapeShellArg(noteContent)} ${commitSha}`,
      {
        cwd: repoPath,
        encoding: 'utf-8',
        stdio: ['pipe', 'pipe', 'pipe'],
        timeout: 10000,
      },
    );
    return true;
  } catch {
    return false;
  }
}

// ─── GitHub Actions Workflow ───────────────────────────────────────────────

/**
 * Generate a GitHub Actions YAML snippet for Origin CI integration.
 */
export function generateGitHubActionsWorkflow(): string {
  return `# Origin CI Attribution Check
# Add this to your .github/workflows/ directory
name: Origin Attribution

on:
  pull_request:
    types: [opened, synchronize]

jobs:
  attribution:
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

      - name: Preserve Attribution on Squash Merge
        if: github.event.action == 'closed' && github.event.pull_request.merged
        run: origin ci squash-merge \${{ github.event.pull_request.base.ref }}
`;
}

// ─── Utilities ─────────────────────────────────────────────────────────────

function escapeShellArg(arg: string): string {
  return "'" + arg.replace(/'/g, "'\\''") + "'";
}
