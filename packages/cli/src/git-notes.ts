import { git } from './utils/exec.js';

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
  aiPercentage?: number;
  humanPercentage?: number;
  mixedPercentage?: number;
  checkpoint?: boolean;
  checkpointAt?: string;
  filesChanged?: string[];
}

export function writeGitNotes(
  repoPath: string,
  commitShas: string[],
  data: GitNoteData,
): void {
  const opts = { cwd: repoPath, timeoutMs: 10_000 };

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
        aiPercentage: data.aiPercentage ?? undefined,
        humanPercentage: data.humanPercentage ?? undefined,
        mixedPercentage: data.mixedPercentage ?? undefined,
        timestamp: new Date().toISOString(),
      },
    },
    null,
    2,
  );

  for (const sha of commitShas) {
    // Defense in depth: only operate on hex SHAs
    if (!/^[a-fA-F0-9]+$/.test(sha)) continue;
    try {
      // Use --ref=origin to keep notes in a separate namespace
      // Use -f to overwrite if note already exists (handles re-runs).
      // notePayload and sha are passed as positional args — no shell, no escaping.
      git(['notes', '--ref=origin', 'add', '-f', '-m', notePayload, sha], opts);
    } catch {
      // Never fail session-end because of a notes error
      // Notes are a nice-to-have, not critical
    }
  }
}
