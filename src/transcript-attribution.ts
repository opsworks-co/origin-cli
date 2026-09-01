// ── Transcript-vs-attribution reconciliation ────────────────────────────────
//
// A turn-window sweep answers "what was dirty while turn N was open?". That is
// an inference, and its window has a known soft edge: the watcher POLLS, so a
// turn's baseline shadow is taken when the turn is NOTICED, up to one poll
// interval after it was submitted. Turn N's window therefore runs to turn N+1's
// baseline and can swallow turn N+1's first writes.
//
// Prod session 376cc22f (Antigravity, repo kotleta) is the worked example.
// Turn 2 ("make some edits and commit the shit") wrote .gitignore, README.md
// and task_analytics.py — the transcript records all three as write_to_file
// calls. Turn 1 ("do the shit") ran `python task_analytics.py`, which is
// write-shaped, so it got a shell window bounded by turn 2's baseline. That
// baseline was late, so README.md was dirty inside turn 1's window and landed
// on turn 1 as `evidence: 'turn_window'`. The session then rendered turn 2 as
// two files and turn 1 as five, and every downstream surface — turn diff, AI%,
// By-File blame — inherited the wrong turn.
//
// The transcript already knew. `parsed.promptEdits` carries each turn's own
// write tool calls, and it says plainly that turn 2 wrote README.md. This
// module is that knowledge applied as a check: a `turn_window` GUESS must never
// outrank the transcript's own record of which turn did the writing.
//
// Deliberately narrow. It only ever moves or drops an edit the capture itself
// labelled `turn_window` — the self-declared inference. Proof-grade evidence
// (tool_call, command_named, command_probe, edit_hook, write_journal) is never
// touched, so a correct row cannot be degraded by running this, and a file the
// transcript never mentions (a shell heredoc write, `sed -i`) is left exactly
// where the window put it. Absence of a transcript record is "unknown", not
// "did not happen" — the same rule computeAgyEmptyTurnRepairs follows.
//
// PURE (no IO), so the rules that decide what gets re-attributed in production
// are testable on their own.

/** The evidence value this module acts on — the capture's own "I inferred this". */
const INFERRED: string = 'turn_window';

export interface AttributedEdit {
  file: string;
  evidence?: string;
  backfillSource?: string;
  [key: string]: unknown;
}

export interface AttributedTurn {
  promptIndex: number;
  edits: AttributedEdit[];
}

export interface AttributionFinding {
  file: string;
  /** The turn whose edits carried the file before this pass. */
  heldBy: number;
  /** The turn the transcript records writing it. */
  recordedBy: number;
  /**
   * `moved`   — the recorded turn had no edit for this file, so the window
   *             edit was re-parented to it (content and all).
   * `dropped` — the recorded turn already carried its own edit for the file,
   *             so the window copy was a duplicate on the wrong turn.
   */
  action: 'moved' | 'dropped';
}

/**
 * Which turns the TRANSCRIPT records writing each file.
 *
 * `promptEdits` is the adapter's per-turn write records (Antigravity's
 * write_to_file / replace_file_content, and the same shape for any other
 * transcript-only agent). `toRepoRel` maps an absolute path to a repo-relative
 * one and returns null/'' for anything outside the repo — pass the caller's own
 * mapper so out-of-repo scratch is dropped here exactly as it is everywhere
 * else.
 */
export function transcriptWriterTurns(
  promptEdits: Array<{ promptIndex: number; edits?: Array<{ file?: string }> }> | null | undefined,
  toRepoRel: (file: string) => string | null,
): Map<string, Set<number>> {
  const byFile = new Map<string, Set<number>>();
  for (const pe of promptEdits || []) {
    if (!pe || !Number.isInteger(pe.promptIndex)) continue;
    for (const e of pe.edits || []) {
      const raw = e && typeof e.file === 'string' ? e.file : '';
      if (!raw) continue;
      let rel: string | null = null;
      try { rel = toRepoRel(raw); } catch { rel = null; }
      if (!rel) continue;
      let turns = byFile.get(rel);
      if (!turns) { turns = new Set(); byFile.set(rel, turns); }
      turns.add(pe.promptIndex);
    }
  }
  return byFile;
}

/**
 * Files the transcript attributes to some OTHER turn — the prevention half.
 *
 * Feed this into a window sweep's `coveredFiles` so turn N's window never
 * claims a file the transcript says turn M wrote. `coveredFiles` already
 * protects a turn's own tool-call edits from being re-derived; this extends the
 * same protection across turn boundaries, which is where the poll-interval slop
 * actually bites.
 *
 * A file this turn ALSO wrote is not foreign — a file legitimately written in
 * two turns must stay claimable by both, or the second turn's real work
 * disappears.
 */
export function filesRecordedForOtherTurns(
  byFile: Map<string, Set<number>>,
  promptIndex: number,
): string[] {
  const out: string[] = [];
  for (const [file, turns] of byFile) {
    if (turns.size === 0) continue;
    if (turns.has(promptIndex)) continue;
    out.push(file);
  }
  return out;
}

/**
 * Reconcile assembled per-turn edits against the transcript — the check half.
 *
 * Mutates `turns` in place and returns what it changed, so the caller can log
 * findings rather than re-deriving them. Returns an empty array when there is
 * nothing to reconcile, including whenever the transcript recorded no writes at
 * all: a parser miss must never be allowed to move real captured data.
 *
 * The repair half exists as well as the prevention half because a window edit
 * can be assembled by paths that never consult `coveredFiles` (the hook path's
 * own sweep, an already-stored payload being re-sent), and because prevention
 * only helps sessions captured after it ships.
 */
export function reconcileWindowAttribution(
  turns: AttributedTurn[],
  byFile: Map<string, Set<number>>,
): AttributionFinding[] {
  const findings: AttributionFinding[] = [];
  if (!Array.isArray(turns) || turns.length === 0) return findings;
  if (!byFile || byFile.size === 0) return findings;

  const byIndex = new Map<number, AttributedTurn>();
  for (const t of turns) {
    if (t && Number.isInteger(t.promptIndex) && Array.isArray(t.edits)) byIndex.set(t.promptIndex, t);
  }

  /**
   * Does this edit actually change anything?
   *
   * Mirrors the server's rendering rule exactly: synthesizePromptDiff emits a
   * file section only when some edit for it produces a non-empty hunk, and an
   * edit whose before and after are identical produces none. That distinction
   * decides whether the window copy is a duplicate or the only real record.
   *
   * A turn's OWN tool-call record can land as a no-op through the same late
   * baseline that misfiles the window edit: the baseline is taken after the
   * write, so backfillWriteBaselines recovers a before-state equal to the
   * after-state and the turn renders nothing for a file it demonstrably wrote.
   * Treating that as "the right turn already has it" and dropping the window
   * copy would erase the file from BOTH turns.
   */
  const carriesChange = (e: AttributedEdit): boolean => {
    const before = typeof e.oldContent === 'string' ? e.oldContent : '';
    const after = typeof e.newContent === 'string' ? e.newContent : '';
    return before !== after;
  };

  const editsFor = (turn: AttributedTurn, file: string): AttributedEdit[] =>
    turn.edits.filter((e) => e && e.file === file);

  for (const turn of turns) {
    if (!turn || !Array.isArray(turn.edits) || turn.edits.length === 0) continue;
    const keep: AttributedEdit[] = [];
    for (const edit of turn.edits) {
      if (!edit || typeof edit.file !== 'string' || edit.evidence !== INFERRED) {
        keep.push(edit);
        continue;
      }
      const writers = byFile.get(edit.file);
      // The transcript never saw this file written — a shell heredoc, `sed -i`,
      // a build artifact. The window is the only evidence there is; keep it.
      if (!writers || writers.size === 0) { keep.push(edit); continue; }
      // The transcript agrees this turn wrote it. Nothing to correct.
      if (writers.has(turn.promptIndex)) { keep.push(edit); continue; }
      // Written in several turns, none of them this one: there is no single
      // right answer, and guessing again is what put the edit here. Leave it.
      if (writers.size !== 1) { keep.push(edit); continue; }
      const recordedBy = [...writers][0];
      const target = byIndex.get(recordedBy);
      // The turn the transcript names isn't in this payload (a partial capture,
      // a windowed re-send). Moving it nowhere would delete real work.
      if (!target || target === turn) { keep.push(edit); continue; }

      const onTarget = editsFor(target, edit.file);
      if (onTarget.some(carriesChange)) {
        // The right turn already renders its own record of this file. The copy
        // sitting on the wrong turn is a duplicate that inflates that turn's
        // file list and line counts — drop it rather than move it.
        findings.push({ file: edit.file, heldBy: turn.promptIndex, recordedBy, action: 'dropped' });
        continue;
      }
      // Everything the target holds for this file is a no-op that renders
      // nothing. The window copy is the only record with the real delta, so it
      // REPLACES them rather than being dropped beside them.
      if (onTarget.length > 0) {
        target.edits = target.edits.filter((e) => !(e && e.file === edit.file));
      }

      // Re-parent, content and all. The window edit's content is a real diff of
      // the file across a window that CONTAINED this write, so it is the best
      // record available; what was wrong was only which turn it hung off.
      // Evidence becomes `tool_call` because the attribution is now backed by
      // the transcript's own record of the call — the same reasoning
      // computeAgyEmptyTurnRepairs uses when it builds edits from those records.
      // The provenance stamp keeps a bad re-attribution attributable.
      const stamp = `transcript-reattributed-from-${turn.promptIndex}`;
      edit.evidence = 'tool_call';
      edit.backfillSource = edit.backfillSource ? `${edit.backfillSource}+${stamp}` : stamp;
      target.edits.push(edit);
      findings.push({ file: edit.file, heldBy: turn.promptIndex, recordedBy, action: 'moved' });
    }
    turn.edits = keep;
  }

  return findings;
}
