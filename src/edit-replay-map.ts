// ---------------------------------------------------------------------------
// Origin CLI — per-line authorship by REPLAYING the turns' edits
// ---------------------------------------------------------------------------
// The shadow-chain walk (final-state-blame.ts) is the better answer when it
// works: it compares real git states, so it sees everything that landed,
// including work done through the shell. But it can only separate two turns if
// a snapshot exists BETWEEN them, and the poll-based watcher does not guarantee
// that — on session 0079e36c both of its shadows sat outside the pair (one
// before the first turn, one after the second), so the walk could not say which
// turn wrote what and correctly refused to guess.
//
// The transcripts, though, record each turn's edits as old→new content. Replay
// them in order over the file's pre-session state, carrying an owner for every
// line, and the result is the same map — derived from what the agent said it
// did rather than from what git observed.
//
// That trade is only acceptable because the result is CHECKED: the replayed
// file must come out byte-identical to the file on disk. If the agent also
// edited through the shell, or a record is missing or malformed, the
// reconstruction diverges and nothing is emitted. A map that survives this is
// one whose every line is accounted for.
// ---------------------------------------------------------------------------

import fs from 'fs';
import path from 'path';
import { execFileSync } from 'child_process';
import { lineLevelDiff } from './transcript.js';
import type { FileLineMap, LineMapRun } from './final-state-blame.js';

export interface ReplayEdit {
  file: string;
  op: string;
  oldContent?: string;
  newContent?: string;
}

export interface ReplayTurn {
  promptIndex: number;
  edits: ReplayEdit[];
}

const MAX_REPLAY_LINES = 8000;

function splitLines(text: string): string[] {
  const out = text.split('\n');
  if (out.length > 0 && out[out.length - 1] === '') out.pop();
  return out;
}

/** The file's content at a git revision, or null when it didn't exist there. */
function readAtRev(workRoot: string, rev: string, file: string): string | null {
  try {
    return execFileSync('git', ['show', `${rev}:${file}`], {
      cwd: workRoot,
      encoding: 'utf-8',
      windowsHide: true,
      timeout: 15_000,
      maxBuffer: 16 * 1024 * 1024,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
  } catch {
    return null; // not in that tree — treat as "did not exist yet"
  }
}

/**
 * Apply one replacement to the running state, carrying ownership.
 *
 * Only the lines the edit actually CHANGES take the new owner: an LCS between
 * the replaced block and its replacement keeps untouched lines with whoever
 * wrote them. Without that, a whole-file rewrite would re-credit the entire
 * file to whichever turn happened to rewrite it last.
 */
function applyBlock(
  lines: string[],
  owners: Array<number | null>,
  at: number,
  removeCount: number,
  replacement: string[],
  owner: number,
): void {
  const removed = lines.slice(at, at + removeCount);
  const removedOwners = owners.slice(at, at + removeCount);
  const newLines: string[] = [];
  const newOwners: Array<number | null> = [];
  let oi = 0;
  for (const op of lineLevelDiff(removed, replacement)) {
    if (op.type === 'context') {
      newLines.push(op.line);
      newOwners.push(removedOwners[oi] ?? null);
      oi++;
    } else if (op.type === 'remove') {
      oi++;
    } else {
      newLines.push(op.line);
      newOwners.push(owner);
    }
  }
  lines.splice(at, removeCount, ...newLines);
  owners.splice(at, removeCount, ...newOwners);
}

/** Index of the first line where `needle` occurs as a contiguous block. */
function findBlock(lines: string[], needle: string[], from = 0): number {
  if (needle.length === 0) return -1;
  outer: for (let i = from; i + needle.length <= lines.length; i++) {
    for (let j = 0; j < needle.length; j++) {
      if (lines[i + j] !== needle[j]) continue outer;
    }
    return i;
  }
  return -1;
}

/**
 * Per-line authorship for the files a session edited, reconstructed by replaying
 * the turns' own edit records and verified against the file on disk.
 *
 * Returns only the files whose replay reproduced the real file exactly.
 * `baseRev` is the session's pre-session git revision; without it a file that
 * already existed can't be reconstructed and is skipped.
 */
export function replayLineMaps(
  workRoot: string,
  turns: ReplayTurn[],
  baseRev?: string | null,
): FileLineMap[] {
  const files = new Set<string>();
  for (const t of turns) for (const e of t.edits) if (e.file) files.add(e.file.replace(/\\/g, '/'));
  if (files.size === 0) return [];

  const out: FileLineMap[] = [];
  for (const file of files) {
    try {
      const abs = path.isAbsolute(file) ? file : path.join(workRoot, file);
      let actual: string;
      try {
        actual = fs.readFileSync(abs, 'utf-8');
      } catch {
        continue; // gone from disk — nothing to attribute
      }
      const actualLines = splitLines(actual);
      if (actualLines.length === 0 || actualLines.length > MAX_REPLAY_LINES) continue;

      // Pre-session state. A file that did not exist starts empty; one that did
      // needs its real prior content, or the replay can't line up.
      const rel = path.isAbsolute(file) ? path.relative(workRoot, file).replace(/\\/g, '/') : file;
      const base = baseRev ? readAtRev(workRoot, baseRev, rel) : null;
      const lines = base === null ? [] : splitLines(base);
      const owners: Array<number | null> = lines.map(() => null);

      let applied = 0;
      for (const turn of [...turns].sort((a, b) => a.promptIndex - b.promptIndex)) {
        for (const e of turn.edits) {
          if (!e.file || e.file.replace(/\\/g, '/') !== file) continue;
          const newLines = splitLines(String(e.newContent ?? ''));
          const oldLines = splitLines(String(e.oldContent ?? ''));

          if (e.op === 'delete') {
            const at = findBlock(lines, oldLines);
            if (at < 0) continue;
            lines.splice(at, oldLines.length);
            owners.splice(at, oldLines.length);
            applied++;
            continue;
          }
          if (oldLines.length === 0) {
            // A create, or a write with no recorded "before": it replaces the
            // whole file. Diffing against the current state keeps the owners of
            // lines it left alone.
            applyBlock(lines, owners, 0, lines.length, newLines, turn.promptIndex);
            applied++;
            continue;
          }
          const at = findBlock(lines, oldLines);
          if (at < 0) {
            // The recorded "before" isn't in the file we've built — the replay
            // has diverged from reality. Stop; verification would fail anyway.
            applied = -1;
            break;
          }
          applyBlock(lines, owners, at, oldLines.length, newLines, turn.promptIndex);
          applied++;
        }
        if (applied < 0) break;
      }
      if (applied <= 0) continue;

      // The check that makes this trustworthy.
      if (lines.length !== actualLines.length) continue;
      let identical = true;
      for (let i = 0; i < lines.length; i++) {
        if (lines[i] !== actualLines[i]) { identical = false; break; }
      }
      if (!identical) continue;

      const runs: LineMapRun[] = [];
      for (let i = 0; i < lines.length; i++) {
        const owner = owners[i] ?? null;
        const last = runs[runs.length - 1];
        if (last && last.promptIndex === owner && last.start + last.lines.length === i + 1) {
          last.lines.push(lines[i]);
        } else {
          runs.push({ start: i + 1, promptIndex: owner, lines: [lines[i]] });
        }
      }
      out.push({ file, total: lines.length, runs });
    } catch {
      // Never let one file's replay break the rest.
    }
  }
  return out;
}
