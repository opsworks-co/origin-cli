import { execSync } from 'child_process';

/**
 * Write Origin metadata as Git Notes on each commit SHA.
 * Uses a custom ref `refs/notes/origin` to avoid conflicts with user's own notes.
 *
 * Notes are portable — they travel with the repo when pushed:
 *   git push origin refs/notes/origin
 *
 * Read a note:
 *   git notes --ref=origin show <SHA>
 */

export interface GitNoteData {
  sessionId: string;
  model: string;
  agentSlug?: string;
  promptCount: number;
  promptSummary: string;
  tokensUsed: number;
  costUsd: number;
  durationMs: number;
  linesAdded: number;
  linesRemoved: number;
  originUrl: string;
}

export function writeGitNotes(
  repoPath: string,
  commitShas: string[],
  data: GitNoteData,
): void {
  const execOpts = {
    cwd: repoPath,
    stdio: 'pipe' as const,
    timeout: 10000,
    encoding: 'utf-8' as const,
  };

  const notePayload = JSON.stringify(
    {
      origin: {
        version: 1,
        sessionId: data.sessionId,
        model: data.model,
        agent: data.agentSlug || undefined,
        promptCount: data.promptCount,
        promptSummary:
          data.promptSummary.length > 200
            ? data.promptSummary.slice(0, 200) + '...'
            : data.promptSummary,
        tokensUsed: data.tokensUsed,
        costUsd: parseFloat(data.costUsd.toFixed(4)),
        durationMs: data.durationMs,
        linesAdded: data.linesAdded,
        linesRemoved: data.linesRemoved,
        originUrl: data.originUrl,
        timestamp: new Date().toISOString(),
      },
    },
    null,
    2,
  );

  for (const sha of commitShas) {
    try {
      // Use --ref=origin to keep notes in a separate namespace
      // Use -f to overwrite if note already exists (handles re-runs)
      execSync(
        `git notes --ref=origin add -f -m ${escapeShellArg(notePayload)} ${sha}`,
        execOpts,
      );
    } catch {
      // Never fail session-end because of a notes error
      // Notes are a nice-to-have, not critical
    }
  }
}

/**
 * Escape a string for safe use as a shell argument.
 */
function escapeShellArg(arg: string): string {
  // Wrap in single quotes and escape any single quotes within
  return "'" + arg.replace(/'/g, "'\\''") + "'";
}
