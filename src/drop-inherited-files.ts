/**
 * A carried row keeps only what its own turn wrote.
 *
 * Every Stop re-sends every earlier turn from `completedPromptMappings`, the
 * row an earlier Stop saved. A row saved by a capture with a defect is re-sent
 * with that defect on every later Stop: nothing downstream re-checks it.
 *
 * Session c5487aa9 turn 3 ran `git checkout --detach origin/main` (#1642, 12
 * files) and wrote nothing, yet a re-Stop saved it as 5 of #1642's files.
 * #1648 stopped new rows going wrong; the saved one kept going out. The
 * shadow-window pass, which could have replaced it, declines both a tree
 * another live session shares and a window that spans inherited commits —
 * both true for that turn.
 *
 * So each CLOSED turn is re-checked against its own window
 * (`shadow[L] → shadow[L+1]`): a file that a commit the turn did not make
 * left unchanged at the turn's end, and that the turn shows no authorship of,
 * leaves the row. What remains is re-counted, and the row goes out as
 * content-authoritative so the server replaces what it stored. The turn still
 * in flight is scoped when it is captured (foreignCommitFilesForTurn).
 *
 * Mutates in place, never throws. Returns how many rows changed.
 */
import { turnWindowEndShadow } from './restored-from-history.js';
import { localTurnForServerRow } from './turn-index.js';
import type { TurnObservation } from './resolve-turn.js';

export interface InheritedFilesState {
  /** LOCAL-numbered: index L is this launch's turn L. */
  promptShadows?: Array<{ promptIndex: number; shadowSha: string; completeBaseline?: boolean }>;
  /** Server row of this launch's turn 0 — see turn-index.ts. */
  promptIndexBase?: number | null;
  /** LOCAL-numbered: the tree Stop closed turn L with — see restored-from-history.ts. */
  turnEndShadows?: Array<{ promptIndex: number; shadowSha: string; capturedAt: string; completeBaseline?: boolean }>;
  /** This launch's prompts; the last one is the turn still in flight. */
  prompts?: string[];
}

export interface InheritedFilesRow {
  promptIndex: number;
  filesChanged?: unknown;
  diff?: string;
  uncommittedDiff?: string | null;
  linesAdded?: number;
  linesRemoved?: number;
  contentUnavailableFiles?: string[];
  chatOnly?: boolean;
  contentAuthoritative?: boolean;
  /** This pass left the row with nothing. Persisted; never sent. */
  emptiedOfInheritedFiles?: boolean;
  /** Files this pass removed, for trimWatchedEdits. Internal; never sent. */
  inheritedFiles?: string[];
  /** Which pass filled the row — the source its post-drop observation reports under. */
  diffSource?: string;
}

export interface DropInheritedFilesDeps {
  /**
   * Files commits the turn did not make changed inside its window and left
   * exactly as they wrote them at the window's end.
   */
  inheritedFiles: (fromShadow: string, toShadow: string, localTurn: number) => Set<string>;
  /** Files the turn shows it wrote: tool calls, edit hooks, named commands, its own commits. */
  authoredFiles: (localTurn: number, serverRow: number) => Set<string>;
  /**
   * Files among `files` the window (ending at `toShadow`, or the live tree
   * when null) only put back — what a background job's pathspec checkout of an
   * older commit, or its restoration, put on disk. Stop and session-end answer
   * with `filesPutBackAcrossTheGap`; see restored-from-history.ts. Optional:
   * without it only commit-borne inheritance is dropped.
   */
  restoredFromHistory?: (fromShadow: string, toShadow: string | null, localTurn: number, files: string[]) => Set<string>;
  /**
   * Files the turn's editsJson carries on watched-only evidence (the write
   * journal, a shell probe, the turn window). A row can name no files while
   * its card still carries the journal's record of a pull — prod 6b770703
   * turn 29 (e87a35d5). Optional: without it only the row's own files are
   * checked.
   */
  watchedFiles?: (serverRow: number) => string[];
  log?: (event: string, data: Record<string, unknown>) => void;
  /**
   * Report a row this pass changed, under the source that filled it, so the
   * resolver's latest observation for that source is the row AFTER the drop.
   * Every pass observes before this one runs; without this the resolver kept
   * resurrecting the inherited file — all 33 differences in ten days of
   * side-by-side logs (resolver audit 3, 2026-09-27) were exactly that.
   */
  observe?: (promptIndex: number, observation: TurnObservation) => void;
}

/** The row as it now stands, reported under the source that filled it. */
function observationAfterDrop(pm: InheritedFilesRow): TurnObservation {
  const files = Array.isArray(pm.filesChanged)
    ? (pm.filesChanged as unknown[]).filter((f): f is string => typeof f === 'string' && !!f)
    : [];
  const content = {
    files,
    diff: (pm.diff && pm.diff.trim()) ? pm.diff : (pm.uncommittedDiff || ''),
    added: pm.linesAdded ?? 0,
    removed: pm.linesRemoved ?? 0,
    contentUnavailable: Array.isArray(pm.contentUnavailableFiles) ? [...pm.contentUnavailableFiles] : [],
  };
  if (pm.diffSource === 'ledger') return { source: 'ledger', outcome: 'applied', ...content };
  if (pm.diffSource === 'turn-window') return { source: 'turn-window', outcome: 'applied', ...content };
  return { source: 'reconstruction', ...content };
}

const norm = (f: string) => f.replace(/\\/g, '/');

const inSet = (set: Set<string>, file: string): boolean => {
  const f = norm(file);
  if (set.has(f)) return true;
  for (const s of set) if (s.endsWith(`/${f}`) || f.endsWith(`/${s}`)) return true;
  return false;
};

/**
 * A file in a set git produced (repo-relative paths). Exact: the suffix match
 * above takes root `package.json` for `packages/api/package.json`, so a turn's
 * own edit left the row whenever a pulled commit touched a nested file of the
 * same name (review of e87a35d5). Only an absolute path, which git never
 * produces, may end with one.
 */
const inGitSet = (set: Set<string>, file: string): boolean => {
  const f = norm(file);
  if (set.has(f)) return true;
  if (!f.startsWith('/') && !/^[A-Za-z]:\//.test(f)) return false;
  for (const s of set) if (f.endsWith(`/${s}`)) return true;
  return false;
};

function sectionFile(section: string): string | null {
  const m = section.match(/^diff --git a\/(.*?) b\/(.*)$/m);
  return m ? norm(m[2] || m[1]) : null;
}

function sectionFiles(diff: string | null | undefined): string[] {
  const out: string[] = [];
  for (const part of String(diff || '').split(/(?=^diff --git )/m)) {
    const f = sectionFile(part);
    if (f) out.push(f);
  }
  return out;
}

export function withoutFiles(diff: string | null | undefined, drop: Set<string>): string {
  const text = String(diff || '');
  if (!text) return text;
  return text.split(/(?=^diff --git )/m).filter((part) => {
    const f = sectionFile(part);
    return !(f && drop.has(f));
  }).join('');
}

function countLines(diff: string): { added: number; removed: number } {
  let added = 0;
  let removed = 0;
  for (const line of diff.split('\n')) {
    if (line.startsWith('+') && !line.startsWith('+++')) added++;
    else if (line.startsWith('-') && !line.startsWith('---')) removed++;
  }
  return { added, removed };
}

function rowFiles(pm: InheritedFilesRow): string[] {
  const out = new Set<string>();
  if (Array.isArray(pm.filesChanged)) {
    for (const f of pm.filesChanged) if (typeof f === 'string' && f) out.add(norm(f));
  }
  for (const f of sectionFiles(pm.diff)) out.add(f);
  for (const f of sectionFiles(pm.uncommittedDiff)) out.add(f);
  for (const f of pm.contentUnavailableFiles || []) if (typeof f === 'string' && f) out.add(norm(f));
  return [...out];
}

export function dropInheritedFilesFromTurns(
  state: InheritedFilesState,
  mappings: InheritedFilesRow[],
  deps: DropInheritedFilesDeps,
): number {
  const shadows = state.promptShadows || [];
  if (!Array.isArray(mappings) || shadows.length === 0) return 0;
  let changed = 0;
  for (const pm of mappings) {
    try {
      if (!pm || !Number.isInteger(pm.promptIndex)) continue;
      const local = localTurnForServerRow(pm.promptIndex, state.promptIndexBase);
      if (local === null) continue;
      const start = shadows.find((s) => s.promptIndex === local);
      // A closed turn ends at the tree its Stop recorded, else at the next
      // turn's start. The turn still in flight ends at the live tree, and only
      // the history test answers for it: its commits are scoped when captured.
      const end = turnWindowEndShadow(state, local);
      const inFlight = !end && Array.isArray(state.prompts) && local === state.prompts.length - 1;
      if (!start?.shadowSha || (!end?.shadowSha && !inFlight)) continue;
      if (start.completeBaseline === false || end?.completeBaseline === false) continue;
      const own = rowFiles(pm);
      const watched = deps.watchedFiles ? deps.watchedFiles(pm.promptIndex).map(norm) : [];
      const files = [...new Set([...own, ...watched])];
      if (files.length === 0) continue;
      const inherited = end ? deps.inheritedFiles(start.shadowSha, end.shadowSha, local) : new Set<string>();
      const restored = deps.restoredFromHistory
        ? deps.restoredFromHistory(start.shadowSha, end?.shadowSha ?? null, local, files)
        : new Set<string>();
      if (inherited.size === 0 && restored.size === 0) continue;
      const authored = deps.authoredFiles(local, pm.promptIndex);
      // Authorship keeps the generous match — erring there keeps a file.
      const drop = new Set(files.filter((f) => (inGitSet(inherited, f) || inGitSet(restored, f)) && !inSet(authored, f)));
      if (drop.size === 0) continue;
      // Only in the card: the row itself is left as it is. Its emptiness is
      // not ours to decide — a shell-only turn's work lives in the card too —
      // and trimWatchedEdits takes the inherited files' watched edits out.
      if (!own.some((f) => drop.has(f))) {
        pm.inheritedFiles = [...new Set([...(pm.inheritedFiles || []), ...drop])].sort();
        changed += 1;
        deps.log?.('inherited files dropped from an earlier turn\'s card', {
          promptIndex: pm.promptIndex, files: pm.inheritedFiles.slice(0, 20), count: drop.size,
        });
        continue;
      }

      pm.filesChanged = (Array.isArray(pm.filesChanged) ? pm.filesChanged : [])
        .filter((f) => typeof f === 'string' && !drop.has(norm(f)));
      pm.diff = withoutFiles(pm.diff, drop);
      if (typeof pm.uncommittedDiff === 'string') pm.uncommittedDiff = withoutFiles(pm.uncommittedDiff, drop);
      if (Array.isArray(pm.contentUnavailableFiles)) {
        pm.contentUnavailableFiles = pm.contentUnavailableFiles.filter((f) => !drop.has(norm(f)));
      }
      const { added, removed } = countLines(`${pm.diff}\n${pm.uncommittedDiff || ''}`);
      pm.linesAdded = added;
      pm.linesRemoved = removed;
      const remaining = (pm.filesChanged as string[]).length;
      if (remaining === 0 && !pm.diff.trim() && !String(pm.uncommittedDiff || '').trim()) {
        pm.chatOnly = true;
        // Survives the state round-trip (stop.ts persistCompletedMappings) and
        // keeps the row its place in mergePromptMappings, so every LATER Stop
        // re-sends the blank with the authority that makes the server drop its
        // stale list. Its own marker, not `contentAuthoritative`: every
        // chat-only turn already saves as `[]` + authoritative, and those must
        // keep yielding to a fresh capture.
        pm.emptiedOfInheritedFiles = true;
      }
      pm.contentAuthoritative = true;
      pm.inheritedFiles = [...drop].sort();
      changed += 1;
      deps.log?.('inherited files dropped from an earlier turn', {
        promptIndex: pm.promptIndex, files: pm.inheritedFiles.slice(0, 20), count: drop.size, remaining,
      });
      deps.observe?.(pm.promptIndex, observationAfterDrop(pm));
    } catch { /* leave the row as it was */ }
  }
  return changed;
}
