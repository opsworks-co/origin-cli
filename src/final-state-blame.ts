// ---------------------------------------------------------------------------
// Origin CLI — per-turn attribution in FINAL-file coordinates
// ---------------------------------------------------------------------------
// A turn's captured diff is anchored to the file as it looked WHEN THAT TURN
// RAN. That is the right record of what the turn did, but it is the wrong
// coordinate system for blame: the dashboard renders the file as it is NOW, and
// a later turn that deletes or inserts above shifts every earlier turn's lines.
// The server can't correct for that — it never sees the file, only the diffs —
// so its By-File view either collapses onto one turn's window or, if it merged
// them, would place lines where they never sat.
//
// The watcher can do better, because it has the repo. It already snapshots the
// working tree at the START of every prompt (PromptShadow.baselineSha), so the
// session is a chain of REAL git states:
//
//   S0 ──turn 0──▶ S1 ──turn 1──▶ S2 ── … ──▶ Sn ──turn n──▶ working tree
//
// Each turn's contribution is `git diff S_i S_i+1`, and walking a line forward
// through the remaining transitions says where it ended up — or that it was
// deleted. What comes out is each turn's SURVIVING lines, numbered against the
// file as it stands now. Those merge cleanly, deletions included, because they all
// share one coordinate system.
//
// Everything here is best-effort and self-verifying: the surviving lines are
// checked against the real file content before being returned, and any mismatch
// (or any git failure) discards that file's result rather than shipping a guess.
// ---------------------------------------------------------------------------

import fs from 'fs';
import path from 'path';
import { execFileSync } from 'child_process';
import { replayLineMaps, type ReplayTurn } from './edit-replay-map.js';

export interface FinalHunk {
  file: string;    // repo-relative
  start: number;   // 1-based line in the file as it is NOW
  lines: string[]; // contiguous run of that turn's surviving lines
}

interface Hunk {
  oldStart: number;
  oldCount: number;
  newStart: number;
  newCount: number;
  added: Array<{ line: number; content: string }>;
}

export type GitRunner = (args: string[]) => string;

function realGit(workRoot: string): GitRunner {
  return (args) =>
    execFileSync('git', args, {
      cwd: workRoot,
      encoding: 'utf-8',
      windowsHide: true,
      timeout: 15_000,
      maxBuffer: 32 * 1024 * 1024,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
}

/**
 * Parse `git diff --unified=0` output for ONE file into hunks.
 * unified=0 means no context rows, so every `+` row is a real addition and
 * every `-` row a real removal — which is what the line walk below needs.
 */
export function parseUnifiedZero(diffText: string): Hunk[] {
  const hunks: Hunk[] = [];
  let cur: Hunk | null = null;
  let newCursor = 0;
  for (const line of diffText.split('\n')) {
    const m = line.match(/^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/);
    if (m) {
      cur = {
        oldStart: parseInt(m[1], 10),
        oldCount: m[2] === undefined ? 1 : parseInt(m[2], 10),
        newStart: parseInt(m[3], 10),
        newCount: m[4] === undefined ? 1 : parseInt(m[4], 10),
        added: [],
      };
      newCursor = cur.newStart;
      hunks.push(cur);
      continue;
    }
    if (!cur) continue;
    if (line.startsWith('+++') || line.startsWith('---')) continue;
    if (line.startsWith('+')) {
      cur.added.push({ line: newCursor, content: line.slice(1) });
      newCursor++;
    }
    // `-` rows consume old-side lines only; `\ No newline` and everything else
    // is noise at unified=0.
  }
  return hunks;
}

/**
 * Where does line `ln` of the OLD side of this diff end up on the NEW side?
 * Returns null when the line was removed or replaced by the diff.
 */
export function mapLineForward(ln: number, hunks: Hunk[]): number | null {
  let delta = 0;
  for (const h of hunks) {
    if (h.oldCount === 0) {
      // Pure insertion. git spells it `@@ -X,0 +Y,N @@` meaning "inserted AFTER
      // old line X", so line X itself does not move — only what follows it. The
      // `ln < oldStart` test used for replacements is off by one here, and got
      // the last line of every append (`@@ -12,0 +13,5 @@` → line 12) shifted
      // down into the appended block, where its content no longer matched and
      // the whole file was discarded as untrustworthy.
      if (ln <= h.oldStart) break;
      delta += h.newCount;
      continue;
    }
    if (ln < h.oldStart) break;                    // before this hunk — only prior deltas apply
    if (ln < h.oldStart + h.oldCount) return null; // inside the replaced range — gone
    delta += h.newCount - h.oldCount;
  }
  return ln + delta;
}

/** The lines an edit payload says a prompt ADDED — its content signature. */
export function expectedAddedLines(editsJsonRaw: string | null | undefined): Set<string> {
  const out = new Set<string>();
  if (typeof editsJsonRaw !== 'string' || !editsJsonRaw) return out;
  try {
    const cap = JSON.parse(editsJsonRaw);
    for (const e of Array.isArray(cap?.edits) ? cap.edits : []) {
      const oldLines = new Set(String(e?.oldContent ?? '').split('\n'));
      for (const l of String(e?.newContent ?? '').split('\n')) {
        if (l !== '' && !oldLines.has(l)) out.add(l);
      }
    }
  } catch { /* malformed — no signature */ }
  return out;
}

/**
 * Per-prompt surviving lines, numbered against the file as it is NOW.
 *
 * A shadow is NOT reliably the tree "before prompt i". The poll-based watcher
 * snapshots when it first NOTICES a prompt, which for a fast turn is after that
 * turn already wrote its files, while the hook path snapshots at prompt start.
 * So both alignments of shadows-to-turns are plausible and picking one by
 * assumption mis-credits every turn by one (measured: turn 0 was handed turn
 * 1's rows). Instead both are computed and checked against each prompt's own
 * recorded content — every line credited to a turn must be a line that turn's
 * edits say it wrote. The alignment that satisfies that for ALL prompts wins;
 * if neither does, nothing is emitted.
 *
 * Returns an empty map whenever the chain can't be trusted — a git failure,
 * surviving content that doesn't match the real file, or no verified alignment.
 */
export function computeFinalHunks(
  workRoot: string,
  shadows: Array<{ promptIndex: number; baselineSha: string }>,
  files: string[],
  opts?: { sessionStartSha?: string | null; expected?: Map<number, Set<string>>; runner?: GitRunner },
): Map<number, FinalHunk[]> {
  const ordered = [...shadows]
    .filter((s) => s && typeof s.baselineSha === 'string' && s.baselineSha)
    .sort((a, b) => a.promptIndex - b.promptIndex);
  if (ordered.length === 0 || files.length === 0) return new Map();

  const git = opts?.runner || realGit(workRoot);
  const expected = opts?.expected;

  // Candidate boundary chains. Each is [state before turn 0, …, final]; entry k
  // is the state turn k starts from, and the working tree (null) closes it.
  const candidates: Array<Array<string | null>> = [];
  // (a) shadows are pre-turn: turn k runs from shadows[k].
  candidates.push([...ordered.map((s) => s.baselineSha), null]);
  // (b) shadows are post-turn: turn 0 runs from the session-start snapshot and
  //     turn k>0 from shadows[k-1]; the last turn extends to the working tree.
  if (opts?.sessionStartSha) {
    candidates.push([opts.sessionStartSha, ...ordered.slice(0, -1).map((s) => s.baselineSha), null]);
  }

  let best: Map<number, FinalHunk[]> | null = null;
  let bestLines = -1;
  for (const boundaries of candidates) {
    const attempt = attributeOverChain(git, workRoot, ordered, boundaries, files, expected);
    if (!attempt) continue;
    const total = [...attempt.values()].reduce(
      (n, hs) => n + hs.reduce((m, h) => m + h.lines.length, 0), 0,
    );
    if (total > bestLines) { best = attempt; bestLines = total; }
  }
  return best || new Map();
}

/**
 * One alignment's worth of work: walk each turn's added lines forward to the
 * final file. Returns null when the result contradicts the repo or the prompts'
 * own records — the caller then tries the other alignment, or gives up.
 */
function attributeOverChain(
  git: GitRunner,
  workRoot: string,
  ordered: Array<{ promptIndex: number; baselineSha: string }>,
  boundaries: Array<string | null>,
  files: string[],
  expected?: Map<number, Set<string>>,
): Map<number, FinalHunk[]> | null {
  const out = new Map<number, FinalHunk[]>();
  const credited = new Map<number, string[]>();

  for (const file of files) {
    try {
      // Transition k = what turn k changed: boundaries[k] → boundaries[k+1],
      // with a null boundary meaning the current working tree.
      const transitions: Hunk[][] = [];
      for (let k = 0; k < ordered.length; k++) {
        const from = boundaries[k];
        const to = boundaries[k + 1];
        if (!from) return null; // no state to diff from — this alignment is unusable
        const args = to
          ? ['diff', '--unified=0', '--no-color', from, to, '--', file]
          : ['diff', '--unified=0', '--no-color', from, '--', file];
        transitions.push(parseUnifiedZero(git(args)));
      }

      // Final content, for verification. A file that no longer exists has no
      // surviving lines by definition — skip it rather than guess.
      const abs = path.isAbsolute(file) ? file : path.join(workRoot, file);
      let finalLines: string[];
      try {
        finalLines = fs.readFileSync(abs, 'utf-8').split('\n');
        if (finalLines.length > 0 && finalLines[finalLines.length - 1] === '') finalLines.pop();
      } catch {
        continue;
      }

      const perPrompt = new Map<number, Array<{ line: number; content: string }>>();
      let trustworthy = true;

      for (let i = 0; i < ordered.length && trustworthy; i++) {
        // What this turn added, in the coordinates of the state right after it.
        let live = transitions[i].flatMap((h) => h.added.map((a) => ({ ...a })));
        // Walk it forward through every later turn.
        for (let k = i + 1; k < transitions.length && live.length > 0; k++) {
          const next: Array<{ line: number; content: string }> = [];
          for (const item of live) {
            const mapped = mapLineForward(item.line, transitions[k]);
            if (mapped !== null) next.push({ line: mapped, content: item.content });
          }
          live = next;
        }
        // Verify against the real file. One mismatch means the chain doesn't
        // describe this file's history (a shadow was taken late, the tree moved
        // outside the session, submodule/CRLF weirdness) — drop the whole file.
        for (const item of live) {
          if (finalLines[item.line - 1] !== item.content) { trustworthy = false; break; }
        }
        if (trustworthy && live.length > 0) {
          perPrompt.set(ordered[i].promptIndex, live);
          const seen = credited.get(ordered[i].promptIndex) || [];
          credited.set(ordered[i].promptIndex, [...seen, ...live.map((l) => l.content)]);
        }
      }
      if (!trustworthy) continue;

      for (const [promptIndex, lines] of perPrompt) {
        lines.sort((a, b) => a.line - b.line);
        const hunks: FinalHunk[] = [];
        for (const item of lines) {
          const last = hunks[hunks.length - 1];
          if (last && last.start + last.lines.length === item.line) last.lines.push(item.content);
          else hunks.push({ file, start: item.line, lines: [item.content] });
        }
        const existing = out.get(promptIndex) || [];
        out.set(promptIndex, [...existing, ...hunks]);
      }
    } catch {
      // Unreadable state / git failure for this file — leave it out entirely.
    }
  }

  // Alignment check. Every line credited to a turn must be a line that turn's
  // own edits say it wrote; anything else means the chain is shifted and this
  // whole attempt is discarded. Prompts with no recorded content (terminal-only
  // work, older captures) can't vouch either way and are skipped — but if NO
  // prompt can vouch, there is nothing holding the alignment down, so refuse.
  if (expected && expected.size > 0) {
    let vouched = 0;
    for (const [promptIndex, lines] of credited) {
      const sig = expected.get(promptIndex);
      if (!sig || sig.size === 0) continue;
      if (lines.some((l) => l.trim() !== '' && !sig.has(l))) return null;
      vouched++;
    }
    if (vouched === 0) return null;
  }

  return out;
}

/**
 * The one entry point both capture paths use: given the per-prompt edit
 * payloads a session produced (promptIndex → editsJson), work out each turn's
 * surviving lines in the file's current coordinates.
 *
 * Kept as a single helper on purpose — the watcher and the Stop hook derive
 * their captures very differently, and the moment they each assemble the inputs
 * for this by hand is the moment one of them starts feeding it a subtly
 * different file list or content signature.
 *
 * `shadows` is whatever that path recorded per prompt; their meaning
 * (pre-turn / post-turn) is resolved by verification, not assumed.
 */
export function finalHunksForCaptures(
  workRoot: string,
  shadows: Array<{ promptIndex: number; baselineSha: string }>,
  editsJsonByIndex: Map<number, string>,
  sessionStartSha?: string | null,
  runner?: GitRunner,
): Map<number, FinalHunk[]> {
  if (!workRoot || shadows.length === 0 || editsJsonByIndex.size === 0) return new Map();
  const files = new Set<string>();
  const expected = new Map<number, Set<string>>();
  for (const [idx, raw] of editsJsonByIndex) {
    expected.set(idx, expectedAddedLines(raw));
    try {
      const cap = JSON.parse(raw);
      for (const e of Array.isArray(cap?.edits) ? cap.edits : []) {
        if (typeof e?.file === 'string' && e.file) files.add(e.file.replace(/\\/g, '/'));
      }
    } catch { /* malformed — contributes no files */ }
  }
  if (files.size === 0) return new Map();
  return computeFinalHunks(workRoot, shadows, [...files], {
    sessionStartSha,
    expected,
    runner,
  });
}

/** Turn-shaped view of the stored edit payloads, for the replay fallback. */
function replayTurnsFrom(editsJsonByIndex: Map<number, string>): ReplayTurn[] {
  const turns: ReplayTurn[] = [];
  for (const [promptIndex, raw] of editsJsonByIndex) {
    try {
      const cap = JSON.parse(raw);
      const edits = Array.isArray(cap?.edits) ? cap.edits : [];
      if (edits.length > 0) turns.push({ promptIndex, edits });
    } catch { /* malformed — contributes nothing */ }
  }
  return turns;
}

/** One run of consecutive current-file lines sharing an author. */
export interface LineMapRun {
  start: number;                  // 1-based line in the file as it is NOW
  promptIndex: number | null;     // null = predates this session's first snapshot
  lines: string[];
}

export interface FileLineMap {
  file: string;                   // repo-relative
  total: number;                  // total lines in the file now
  runs: LineMapRun[];
}

// A file bigger than this is not worth shipping line-by-line on every poll; the
// server keeps its existing behaviour for those. Generous enough to cover
// ordinary source files.
export const LINE_MAP_MAX_LINES = 4000;
export const LINE_MAP_MAX_BYTES = 256 * 1024;

/**
 * The whole point of the exercise: for every line of every file this session
 * touched, WHICH TURN wrote it — or null when the line predates the session.
 *
 * This replaces guesswork rather than adding to it. The server had six ways to
 * assemble a file view (session diff, latest prompt's window, per-prompt synth,
 * commit patch, unions of those) and picked whichever showed the most lines;
 * every blame bug in this area came from that choice going wrong, and each fix
 * added another candidate. A map computed where the repo actually IS needs no
 * choice at all: it carries the file's current content and each line's author.
 *
 * Crucially it covers lines it CANNOT attribute (promptIndex null) instead of
 * dropping them. That is what a partial answer should look like — a complete
 * file with some lines unowned, not a view missing its first ten rows.
 */
export function computeFileLineMaps(
  workRoot: string,
  shadows: Array<{ promptIndex: number; baselineSha: string }>,
  editsJsonByIndex: Map<number, string>,
  sessionStartSha?: string | null,
  runner?: GitRunner,
): FileLineMap[] {
  const hunksByPrompt = finalHunksForCaptures(workRoot, shadows, editsJsonByIndex, sessionStartSha, runner);
  // The git walk needs a snapshot BETWEEN two turns to tell them apart, and the
  // poll-based watcher does not guarantee one. When it comes back empty, replay
  // the turns' own edit records instead — same map, derived from what the agent
  // recorded rather than what git observed, and only kept if the replay
  // reproduces the file on disk exactly. See edit-replay-map.ts.
  if (hunksByPrompt.size === 0) {
    return replayLineMaps(workRoot, replayTurnsFrom(editsJsonByIndex), sessionStartSha);
  }

  // owner per file: line number → promptIndex
  const ownerByFile = new Map<string, Map<number, number>>();
  for (const [promptIndex, hunks] of hunksByPrompt) {
    for (const h of hunks) {
      if (!ownerByFile.has(h.file)) ownerByFile.set(h.file, new Map());
      const owners = ownerByFile.get(h.file)!;
      h.lines.forEach((_, i) => {
        // Earliest turn wins a line it established; a later turn only owns
        // lines it actually added, which the walk already guarantees.
        if (!owners.has(h.start + i)) owners.set(h.start + i, promptIndex);
      });
    }
  }

  const out: FileLineMap[] = [];
  let budget = LINE_MAP_MAX_BYTES;
  for (const [file, owners] of ownerByFile) {
    try {
      const abs = path.isAbsolute(file) ? file : path.join(workRoot, file);
      const raw = fs.readFileSync(abs, 'utf-8');
      if (raw.length > budget) continue;
      const lines = raw.split('\n');
      if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
      if (lines.length === 0 || lines.length > LINE_MAP_MAX_LINES) continue;

      // Verify before shipping: every attributed line must still hold the
      // content the walk credited. A mismatch means the file moved under us
      // between the walk and this read — emit nothing for it rather than a map
      // that points at the wrong lines.
      let ok = true;
      for (const [ln] of owners) {
        if (ln < 1 || ln > lines.length) { ok = false; break; }
      }
      if (!ok) continue;

      const runs: LineMapRun[] = [];
      for (let i = 0; i < lines.length; i++) {
        const ln = i + 1;
        const owner = owners.has(ln) ? owners.get(ln)! : null;
        const last = runs[runs.length - 1];
        if (last && last.promptIndex === owner && last.start + last.lines.length === ln) {
          last.lines.push(lines[i]);
        } else {
          runs.push({ start: ln, promptIndex: owner, lines: [lines[i]] });
        }
      }
      const map: FileLineMap = { file, total: lines.length, runs };
      budget -= raw.length;
      out.push(map);
      if (budget <= 0) break;
    } catch {
      // Unreadable file — skip it; the server falls back for that one.
    }
  }
  return out;
}

/**
 * Render a turn's final-coordinate hunks as a unified diff the server can parse
 * with the same code path as any other per-prompt diff. Every row is an
 * addition: these are the lines this turn authored that are still in the file.
 */
export function renderFinalHunks(hunks: FinalHunk[]): string {
  const byFile = new Map<string, FinalHunk[]>();
  for (const h of hunks) {
    if (!byFile.has(h.file)) byFile.set(h.file, []);
    byFile.get(h.file)!.push(h);
  }
  const out: string[] = [];
  for (const [file, list] of byFile) {
    out.push(`diff --git a/${file} b/${file}`, `--- a/${file}`, `+++ b/${file}`);
    for (const h of list.sort((a, b) => a.start - b.start)) {
      out.push(`@@ -${h.start},0 +${h.start},${h.lines.length} @@`);
      for (const l of h.lines) out.push(`+${l}`);
    }
  }
  return out.join('\n');
}
