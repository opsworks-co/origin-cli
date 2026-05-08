import { execFileSync } from 'child_process';
import { redactSecrets } from './redaction.js';

function redact(text: string): string {
  return redactSecrets(text || '').redacted;
}

const TRUNCATED_MARKER = '…[truncated]';

function redactAndCap(text: string, maxBytes: number): string {
  const out = redact(text);
  const buf = Buffer.from(out, 'utf-8');
  if (buf.length <= maxBytes) return out;
  // Slice on byte boundaries, then re-decode. `Buffer.toString('utf-8')`
  // replaces partial multi-byte sequences with U+FFFD, so we don't emit
  // invalid UTF-8 even when the cap lands mid-codepoint.
  const markerBytes = Buffer.byteLength(TRUNCATED_MARKER, 'utf-8');
  const head = buf.subarray(0, Math.max(0, maxBytes - markerBytes)).toString('utf-8');
  return head + TRUNCATED_MARKER;
}

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

// Caps keep the per-commit note small enough to push without bloating the repo.
// fullPrompt is the largest contributor; 8KB after redaction is a reasonable
// budget for next-agent context (≈1500 tokens of preceding intent).
const FULL_PROMPT_MAX_BYTES = 8 * 1024;
const FILES_READ_MAX = 100;

export interface GitNoteData {
  sessionId: string;
  model: string;
  agentSlug?: string;
  promptCount: number;
  promptSummary: string;
  // Untruncated last prompt (post-redaction, capped at ~8KB). Lets the next
  // agent reading blame see the actual intent behind a commit, not a 200-char
  // teaser. Stored separately from promptSummary so older readers keep working.
  fullPrompt?: string;
  // Pointer to the previous Origin session in this repo, captured at
  // session-start from refs/notes/origin-memory. Lets readers walk a chain of
  // sessions to reconstruct evolution of a feature across commits.
  previousSessionId?: string;
  // Files the agent loaded into context during this session (unique paths,
  // capped). Helps the next agent understand what the prior agent saw —
  // not just what it changed.
  filesRead?: string[];
  tokensUsed: number;
  costUsd: number;
  durationMs: number;
  linesAdded: number;
  linesRemoved: number;
  originUrl: string;
  aiPercentage?: number;
  humanPercentage?: number;
  mixedPercentage?: number;
  snapshot?: boolean;
  snapshotAt?: string;
  filesChanged?: string[];
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

  const summarySource = redact(data.promptSummary || '');
  const promptSummary =
    summarySource.length > 200 ? summarySource.slice(0, 200) + '...' : summarySource;
  const fullPrompt = data.fullPrompt
    ? redactAndCap(data.fullPrompt, FULL_PROMPT_MAX_BYTES)
    : undefined;
  const filesRead = data.filesRead && data.filesRead.length > 0
    ? Array.from(new Set(data.filesRead)).slice(0, FILES_READ_MAX)
    : undefined;

  const notePayload = JSON.stringify(
    {
      origin: {
        // Stays at 1 — the new fields (fullPrompt, previousSessionId,
        // filesRead) are purely additive. Existing readers look up keys
        // by name and ignore unknowns, so no version bump is needed.
        version: 1,
        sessionId: data.sessionId,
        model: data.model,
        agent: data.agentSlug || undefined,
        promptCount: data.promptCount,
        promptSummary,
        fullPrompt,
        previousSessionId: data.previousSessionId || undefined,
        filesRead,
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
    try {
      // Use --ref=origin to keep notes in a separate namespace
      // Use -f to overwrite if note already exists (handles re-runs)
      execFileSync('git', ['notes', '--ref=origin', 'add', '-f', '-m', notePayload, sha], execOpts);
    } catch {
      // Never fail session-end because of a notes error
      // Notes are a nice-to-have, not critical
    }
  }
}

