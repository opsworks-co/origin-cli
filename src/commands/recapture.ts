// `origin recapture` — re-send a session's per-turn capture from its
// transcript, to heal turns whose stored numbers include work that never
// happened.
//
// The bug it repairs (fixed in capture on 2026-08-26, #1249): a REJECTED edit
// tool call — "String to replace not found", a denied permission — was recorded
// as if it had been applied. The agent then retries the same edit successfully,
// so the turn stores the same block twice: session cb853c02 turn 2 read +240
// for a file git says gained +124.
//
// The fixed extractor drops those, but only for captures made from now on. The
// phantom is already in the stored editsJson of every turn captured before the
// fix, and no read-side rule can spot it — two hunks writing the same block is
// indistinguishable from a genuine repeated edit unless you can see the
// `is_error` on the tool result, which only the transcript has.
//
// THE SAFETY RULE, and why this command is not "re-send everything":
// a transcript sees tool calls, and nothing else. Work an agent did through
// the shell (`python - <<'EOF'`, `sed -i`, `cat >`) leaves no tool call, so a
// re-capture of such a turn is SMALLER than the truth git recorded. In session
// cb853c02, turn 1's stored +444/-81 matches git exactly while its transcript
// capture yields only +204 — re-sending that would destroy a correct row.
//
// So a turn is only ever proposed when its capture reports
// `droppedFailedEdits > 0`: the transcript proves this turn issued an edit that
// was rejected, which is exactly the case the stored row got wrong. Everything
// else is left alone, and `--apply` is required to write anything.

import fs from 'fs';
import { newCaptureStamp } from '../capture-stamp.js';
import os from 'os';
import path from 'path';
import { api } from '../api.js';
import { capturePromptEdits } from '../prompt-capture/index.js';
import type { PromptCapture, PromptEdit } from '../prompt-capture/types.js';
import { buildDiffFromEdits } from '../transcript.js';
import { loadSessionState } from '../session-state.js';

export interface TurnNumbers {
  // The row's own identity, carried from the server so a correction replaces
  // the turn it was computed from rather than whatever now sits at its index.
  turnId?: string;
  promptIndex: number;
  linesAdded: number;
  linesRemoved: number;
  files: number;
}

export interface RepairPlanEntry {
  turnId?: string;
  promptIndex: number;
  before: TurnNumbers;
  after: TurnNumbers;
  droppedFailedEdits: number;
  diff: string;
  filesChanged: string[];
}

export interface SkippedTurn {
  promptIndex: number;
  reason: string;
}

export interface RepairPlan {
  repairs: RepairPlanEntry[];
  skipped: SkippedTurn[];
}

/** PromptEdit → the {file, toolName, input} shape buildDiffFromEdits consumes. */
export function editsToDiffInput(edits: PromptEdit[]): Array<{ file: string; toolName: string; input: Record<string, any> }> {
  return edits.map((e) => (e.op === 'write' || e.op === 'create')
    ? { file: e.file, toolName: 'Write', input: { content: e.newContent || '' } }
    : { file: e.file, toolName: 'Edit', input: { old_string: e.oldContent || '', new_string: e.newContent || '' } });
}

function countDiff(diff: string): { linesAdded: number; linesRemoved: number } {
  let linesAdded = 0;
  let linesRemoved = 0;
  for (const line of diff.split('\n')) {
    if (line.startsWith('+') && !line.startsWith('+++')) linesAdded++;
    else if (line.startsWith('-') && !line.startsWith('---')) linesRemoved++;
  }
  return { linesAdded, linesRemoved };
}

/**
 * Decide which turns to repair. Pure — no network, no disk — so the rules that
 * decide what gets overwritten in production are testable on their own.
 *
 * A turn qualifies only when ALL of these hold:
 *   1. the capture dropped at least one FAILED edit (the proof that the stored
 *      row contains work that never happened);
 *   2. the re-capture still has edits (an empty one would blank the turn);
 *   3. the corrected counts are LOWER than what is stored — this repair only
 *      ever removes phantom lines. A higher number means the transcript is
 *      seeing something the stored row didn't, which is not this bug, and is
 *      not something to "fix" by overwriting git-derived truth.
 */
export function planRepairs(captures: PromptCapture[], stored: TurnNumbers[]): RepairPlan {
  const storedByIndex = new Map(stored.map((s) => [s.promptIndex, s]));
  const repairs: RepairPlanEntry[] = [];
  const skipped: SkippedTurn[] = [];

  for (const cap of captures) {
    const before = storedByIndex.get(cap.promptIndex);
    if (!before) {
      skipped.push({ promptIndex: cap.promptIndex, reason: 'no stored turn on the server' });
      continue;
    }
    const dropped = cap.droppedFailedEdits || 0;
    if (dropped === 0) {
      skipped.push({ promptIndex: cap.promptIndex, reason: 'no failed edits — nothing to correct' });
      continue;
    }
    if (cap.edits.length === 0) {
      skipped.push({ promptIndex: cap.promptIndex, reason: 're-capture is empty — would blank the turn' });
      continue;
    }
    const diff = buildDiffFromEdits(editsToDiffInput(cap.edits));
    const { linesAdded, linesRemoved } = countDiff(diff);
    const filesChanged = Array.from(new Set(cap.edits.map((e) => e.file)));
    const after: TurnNumbers = { promptIndex: cap.promptIndex, linesAdded, linesRemoved, files: filesChanged.length };

    if (linesAdded > before.linesAdded || linesRemoved > before.linesRemoved) {
      skipped.push({
        promptIndex: cap.promptIndex,
        reason: `re-capture is LARGER (+${linesAdded}/-${linesRemoved} vs stored +${before.linesAdded}/-${before.linesRemoved}) — not this bug`,
      });
      continue;
    }
    if (linesAdded === before.linesAdded && linesRemoved === before.linesRemoved) {
      skipped.push({ promptIndex: cap.promptIndex, reason: 'stored numbers already match the corrected capture' });
      continue;
    }

    repairs.push({ promptIndex: cap.promptIndex, before, after, droppedFailedEdits: dropped, diff, filesChanged });
  }

  return { repairs, skipped };
}

/** Find the local state file for a session id, for its transcript + repo path. */
export function findLocalSessionState(sessionId: string): { transcriptPath?: string; repoPath?: string; agent?: string } | null {
  const dir = path.join(os.homedir(), '.origin', 'sessions');
  let entries: string[];
  try { entries = fs.readdirSync(dir); } catch { return null; }
  for (const entry of entries) {
    if (!entry.endsWith('.json')) continue;
    try {
      const state = JSON.parse(fs.readFileSync(path.join(dir, entry), 'utf-8'));
      if (state?.sessionId !== sessionId && state?.syncedSessionId !== sessionId) continue;
      return { transcriptPath: state.transcriptPath, repoPath: state.repoPath, agent: state.agentSlug };
    } catch { /* skip unreadable */ }
  }
  return null;
}

export async function recaptureCommand(
  sessionIdArg: string | undefined,
  opts: { apply?: boolean; transcript?: string; turn?: string } = {},
): Promise<void> {
  const local = loadSessionState();
  const sessionId = sessionIdArg || local?.sessionId;
  if (!sessionId) {
    console.error('No session id given and no active session in this directory.');
    console.error('Usage: origin recapture <sessionId> [--apply]');
    process.exitCode = 1;
    return;
  }

  const resolved = (local && local.sessionId === sessionId)
    ? { transcriptPath: local.transcriptPath, repoPath: local.repoPath, agent: local.agentSlug }
    : findLocalSessionState(sessionId);
  const transcriptPath = opts.transcript || resolved?.transcriptPath;
  const repoPath = resolved?.repoPath || process.cwd();

  if (!transcriptPath || !fs.existsSync(transcriptPath)) {
    // Stated plainly rather than guessed at: picking "the newest transcript in
    // the directory" is how a repair writes one session's work onto another.
    console.error(`No transcript found for session ${sessionId}.`);
    console.error(transcriptPath
      ? `  Recorded at ${transcriptPath}, which no longer exists.`
      : '  No local state file carries this session id (it may have been captured on another machine).');
    console.error('  Pass --transcript <path> if you know where it is.');
    process.exitCode = 1;
    return;
  }

  const agent = (resolved?.agent === 'cursor' ? 'cursor' : 'claude') as 'claude' | 'cursor';
  const captures = capturePromptEdits({ agent, repoPath, transcriptPath, sessionCommitShas: [] });

  let session: any;
  try {
    session = await api.getSession(sessionId);
  } catch (err: any) {
    console.error(`Could not read session ${sessionId} from the API: ${err?.message || err}`);
    process.exitCode = 1;
    return;
  }

  const stored: TurnNumbers[] = (session.promptChanges || []).map((pc: any) => {
    // filesChanged crosses the wire as an ARRAY from /api/sessions and as a
    // JSON STRING from the capture payloads. Reading only one shape reported
    // every stored turn as "0 files", which reads like data loss in the
    // before/after column when nothing was wrong.
    let files = 0;
    if (Array.isArray(pc.filesChanged)) files = pc.filesChanged.length;
    else if (typeof pc.filesChanged === 'string') {
      try { files = (JSON.parse(pc.filesChanged || '[]') || []).length; } catch { /* 0 */ }
    }
    return {
      // Preserve the row's own identity. recapture REPLACES a stored turn,
      // so re-keying it by position would let a renumbered list send the
      // correction to a different turn than the one it was computed from.
      turnId: pc.turnId,
      promptIndex: pc.promptIndex,
      linesAdded: pc.linesAdded || 0,
      linesRemoved: pc.linesRemoved || 0,
      files,
    };
  });

  const onlyTurn = opts.turn !== undefined ? Number(opts.turn) : undefined;
  const plan = planRepairs(
    onlyTurn === undefined ? captures : captures.filter((c) => c.promptIndex === onlyTurn),
    stored,
  );

  console.log(`Session ${sessionId} — ${captures.length} turns in transcript, ${stored.length} stored\n`);

  for (const s of plan.skipped) console.log(`  turn ${s.promptIndex}: skipped — ${s.reason}`);
  if (plan.skipped.length > 0 && plan.repairs.length > 0) console.log('');

  if (plan.repairs.length === 0) {
    console.log('Nothing to repair.');
    return;
  }

  for (const r of plan.repairs) {
    console.log(
      `  turn ${r.promptIndex}: +${r.before.linesAdded}/-${r.before.linesRemoved} (${r.before.files} files)`
      + `  ->  +${r.after.linesAdded}/-${r.after.linesRemoved} (${r.after.files} files)`
      + `   [${r.droppedFailedEdits} rejected edit${r.droppedFailedEdits === 1 ? '' : 's'} dropped]`,
    );
  }

  if (!opts.apply) {
    console.log(`\nDry run — pass --apply to send ${plan.repairs.length} corrected turn${plan.repairs.length === 1 ? '' : 's'}.`);
    return;
  }

  // One stamp for this repair run: every row it rewrites describes the same
  // capture, which is what lets the server order it against later writes.
  const captureStamp = newCaptureStamp('rc');
  const promptChanges = plan.repairs.map((r) => {
    const cap = captures.find((c) => c.promptIndex === r.promptIndex)!;
    return {
      ...captureStamp,
      ...(r.turnId ? { turnId: r.turnId } : {}),
      promptIndex: r.promptIndex,
      promptText: cap.promptText,
      filesChanged: r.filesChanged,
      diff: r.diff,
      linesAdded: r.after.linesAdded,
      linesRemoved: r.after.linesRemoved,
      // Carries the correction: the server treats a PATCH with a real
      // editsJson as authoritative for the row, so this replaces the stored
      // capture rather than merging the phantom back in.
      editsJson: JSON.stringify({ edits: cap.edits }),
      ...(cap.outOfRepoFiles && cap.outOfRepoFiles.length > 0
        ? { outOfRepoFiles: cap.outOfRepoFiles }
        : {}),
    };
  });

  try {
    await api.updateSession(sessionId, { promptChanges });
    console.log(`\nSent ${promptChanges.length} corrected turn${promptChanges.length === 1 ? '' : 's'}.`);
  } catch (err: any) {
    console.error(`\nPATCH failed: ${err?.message || err}`);
    process.exitCode = 1;
  }
}
