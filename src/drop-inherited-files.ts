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
  /** Files this pass removed, for trimWatchedEdits. Internal; never sent. */
  inheritedFiles?: string[];
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
  log?: (event: string, data: Record<string, unknown>) => void;
}

const norm = (f: string) => f.replace(/\\/g, '/');

const inSet = (set: Set<string>, file: string): boolean => {
  const f = norm(file);
  if (set.has(f)) return true;
  for (const s of set) if (s.endsWith(`/${f}`) || f.endsWith(`/${s}`)) return true;
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
    return !(f && inSet(drop, f));
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
      const files = rowFiles(pm);
      if (files.length === 0) continue;
      const inherited = end ? deps.inheritedFiles(start.shadowSha, end.shadowSha, local) : new Set<string>();
      const restored = deps.restoredFromHistory
        ? deps.restoredFromHistory(start.shadowSha, end?.shadowSha ?? null, local, files)
        : new Set<string>();
      if (inherited.size === 0 && restored.size === 0) continue;
      const authored = deps.authoredFiles(local, pm.promptIndex);
      const drop = new Set(files.filter((f) => (inSet(inherited, f) || inSet(restored, f)) && !inSet(authored, f)));
      if (drop.size === 0) continue;

      pm.filesChanged = (Array.isArray(pm.filesChanged) ? pm.filesChanged : [])
        .filter((f) => typeof f === 'string' && !inSet(drop, f));
      pm.diff = withoutFiles(pm.diff, drop);
      if (typeof pm.uncommittedDiff === 'string') pm.uncommittedDiff = withoutFiles(pm.uncommittedDiff, drop);
      if (Array.isArray(pm.contentUnavailableFiles)) {
        pm.contentUnavailableFiles = pm.contentUnavailableFiles.filter((f) => !inSet(drop, f));
      }
      const { added, removed } = countLines(`${pm.diff}\n${pm.uncommittedDiff || ''}`);
      pm.linesAdded = added;
      pm.linesRemoved = removed;
      const remaining = (pm.filesChanged as string[]).length;
      if (remaining === 0 && !pm.diff.trim() && !String(pm.uncommittedDiff || '').trim()) pm.chatOnly = true;
      pm.contentAuthoritative = true;
      pm.inheritedFiles = [...drop].sort();
      changed += 1;
      deps.log?.('inherited files dropped from an earlier turn', {
        promptIndex: pm.promptIndex, files: pm.inheritedFiles.slice(0, 20), count: drop.size, remaining,
      });
    } catch { /* leave the row as it was */ }
  }
  return changed;
}
