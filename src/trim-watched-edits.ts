/**
 * A turn's editsJson keeps only the watched writes its own row names.
 *
 * A checkout inside a turn rewrites files on disk, and the write journal (and
 * the shell probe, and the turn window) records each rewrite as a write of the
 * turn that is open. The commit-patch and shadow-window passes scope the ROW to
 * what git says the turn changed, but they never touch editsJson, and the
 * server synthesizes a turn's card from editsJson. Session 936ac5d1 turn 2
 * committed fc8e7130, one file, +13/-5; `gh pr merge --squash --delete-branch`
 * and a `git switch` rewrote three more, and the row went out with three extra
 * `write_journal` edits, so the card read four files, +15/-56, and the read
 * path's heal persisted that back.
 *
 * The API drops the same edits on read (synthesize-prompt-diff.ts, #1638);
 * this is the producer half, with the same rule, so the stored payload, the
 * git notes and changes.json say what the card says.
 *
 * Only watched evidence is dropped. A tool call, an edit hook or a command that
 * names its file is the agent's authoring wherever it lands. And only on a row
 * that names files: a row with none drops nothing, as on read. That keeps a
 * hookless, shell-only turn's edits, where the journal is the only evidence,
 * and a row the shadow window blanked too.
 *
 * Two lists override that last rule, because their files are proven to be no
 * turn's work: `row.inheritedFiles` (removed from the row by
 * dropInheritedFilesFromTurns) and `abandonedFiles` (git proved the file
 * existed only inside a commit the session reset away — abandonedOnlyFiles in
 * hooks.ts). Both are proofs; an empty list, which is also every git failure,
 * drops nothing.
 *
 * Neither overrides the FIRST rule. A file a tool call named keeps its edit
 * however the work ended, abandonment included: the turn stops showing the
 * lines and the file, but the record that the agent wrote it is the product
 * and does not go. Only the watcher's own evidence is ever dropped here.
 */

/** Evidence that saw a file change without seeing the agent write it. */
export const WATCHED_ONLY_EVIDENCE: ReadonlySet<string> = new Set(['write_journal', 'command_probe', 'turn_window']);

export interface TrimmableRow {
  promptIndex: number;
  filesChanged?: unknown;
  diff?: string;
  uncommittedDiff?: string | null;
  contentUnavailableFiles?: string[];
  /**
   * Files dropInheritedFilesFromTurns removed from the row. Their watched
   * edits go too, even when the row names nothing else — an emptied row would
   * otherwise keep them, and the server would synthesize them back.
   */
  inheritedFiles?: string[];
}

const norm = (f: string) => f.replace(/\\/g, '/');

function diffFiles(text: string | null | undefined, into: Set<string>): void {
  for (const line of String(text || '').split('\n')) {
    if (!line.startsWith('diff --git ')) continue;
    const f = line.split(' b/')[1];
    if (f) into.add(norm(f));
  }
}

/**
 * Every file the row names for itself: `filesChanged`, the sections of `diff`
 * and `uncommittedDiff` (a watcher row carries its text there), and
 * `contentUnavailableFiles`.
 */
export function rowOwnedFiles(row: TrimmableRow): Set<string> {
  const out = new Set<string>();
  diffFiles(row.diff, out);
  diffFiles(row.uncommittedDiff, out);
  for (const list of [row.filesChanged, row.contentUnavailableFiles]) {
    if (!Array.isArray(list)) continue;
    for (const f of list) if (typeof f === 'string' && f) out.add(norm(f));
  }
  return out;
}

/**
 * Drop the watched-only edits on files the row does not name, and the
 * finalHunks of files no edit is left on. Returns the payload unchanged (same
 * string) when nothing is dropped, the row names no files, or it does not parse.
 */
export function trimWatchedEdits(
  raw: string,
  row: TrimmableRow,
  abandonedFiles?: readonly string[],
): { raw: string; dropped: string[] } {
  const owned = rowOwnedFiles(row);
  const inherited = new Set((Array.isArray(row.inheritedFiles) ? row.inheritedFiles : [])
    .filter((f): f is string => typeof f === 'string' && !!f).map(norm));
  const abandoned = new Set((Array.isArray(abandonedFiles) ? abandonedFiles : [])
    .filter((f): f is string => typeof f === 'string' && !!f).map(norm));
  if (owned.size === 0 && inherited.size === 0 && abandoned.size === 0) return { raw, dropped: [] };
  let cap: { edits?: unknown; finalHunks?: unknown };
  try { cap = JSON.parse(raw); } catch { return { raw, dropped: [] }; }
  if (!cap || !Array.isArray(cap.edits)) return { raw, dropped: [] };

  const dropped = new Set<string>();
  const kept = (cap.edits as Array<{ file?: unknown; evidence?: unknown }>).filter((e) => {
    if (!e || typeof e.file !== 'string' || !e.file) return true;
    // AUTHORSHIP OUTRANKS ABANDONMENT. A tool call that wrote the file is a
    // record of what the agent did, and the session throwing the commit away
    // afterwards does not unmake it — the lines and the file leave the turn
    // (dropVanishedWatchedAdds does that), but the edit stays. Erasing it
    // would make the page match the repository by deleting the evidence that
    // anything happened, which is the one thing this product must not do.
    if (typeof e.evidence !== 'string' || !WATCHED_ONLY_EVIDENCE.has(e.evidence)) return true;
    const file = norm(e.file);
    // Below the evidence check on purpose: an abandoned-only file whose only
    // witness is the watcher goes. That is the live ccd07b34 row — the
    // journal's `delete only_wip.txt`, the reset itself taking the file off
    // disk, rendered as a card of -1 on a turn that authored nothing.
    if (abandoned.has(file)) { dropped.add(file); return false; }
    if (!inherited.has(file) && (owned.size === 0 || owned.has(file))) return true;
    dropped.add(file);
    return false;
  });
  if (dropped.size === 0) return { raw, dropped: [] };

  const next: Record<string, unknown> = { ...cap, edits: kept };
  if (Array.isArray(cap.finalHunks)) {
    const left = new Set(kept.map((e) => (typeof e?.file === 'string' ? norm(e.file) : '')));
    next.finalHunks = (cap.finalHunks as Array<{ file?: unknown }>).filter((h) =>
      !(h && typeof h.file === 'string' && dropped.has(norm(h.file)) && !left.has(norm(h.file))));
  }
  return { raw: JSON.stringify(next), dropped: [...dropped].sort() };
}

/**
 * Trim every turn's payload in `editsByIndex` against its row, in place.
 * Run after the git passes, before editsJson is attached. Never throws.
 */
export function trimWatchedEditsForTurns(
  editsByIndex: Map<number, string> | null | undefined,
  rows: ReadonlyArray<TrimmableRow | null | undefined>,
  log?: (event: string, data: Record<string, unknown>) => void,
  abandonedFiles?: readonly string[],
): number {
  if (!editsByIndex || editsByIndex.size === 0 || !Array.isArray(rows)) return 0;
  let trimmed = 0;
  for (const row of rows) {
    if (!row || !Number.isInteger(row.promptIndex)) continue;
    const raw = editsByIndex.get(row.promptIndex);
    if (!raw) continue;
    try {
      const out = trimWatchedEdits(raw, row, abandonedFiles);
      if (out.dropped.length === 0) continue;
      editsByIndex.set(row.promptIndex, out.raw);
      trimmed++;
      log?.('watched-only edits dropped: the row does not name their files', {
        promptIndex: row.promptIndex, files: out.dropped.slice(0, 20), count: out.dropped.length,
      });
    } catch { /* leave the payload as it was */ }
  }
  return trimmed;
}
