// One applyable patch per turn: at most one `diff --git` section per file.
//
// Four producers used to concatenate a committed range with an uncommitted
// leftover (git-capture, Stop, heartbeat, after-file-edit). A file that was
// committed and then edited further appeared twice — verify-capture reports
// that as `duplicate_file_section` (acd825ed), and the field is not an
// applyable patch. Last-wins by path is also wrong: the uncommitted half is
// vs HEAD (the leftover +5), not vs the turn baseline (the full +105).
//
// For a file in both halves — or twice inside the committed half, which is
// `git show` of two commits joined — the working-tree section (baseline →
// current tree) is the net. For a file in only one half, that half is already
// the net. PURE: no IO, no git.

const GIT_FILE = /^diff --git (?:"?a\/(.*?)"?) (?:"?b\/(.*?)"?)$/;

export interface DiffFileSection {
  file: string;
  text: string;
}

/** Split a unified diff into per-file sections, preserving each one's exact bytes. */
export function splitDiffFileSections(diff: string): DiffFileSection[] {
  if (!diff || !diff.trim()) return [];
  const out: DiffFileSection[] = [];
  for (const part of diff.split(/^(?=diff --git )/m)) {
    if (!part.trim()) continue;
    const header = part.split('\n', 1)[0] || '';
    const m = GIT_FILE.exec(header);
    out.push({ file: m ? (m[2] || m[1] || '') : '', text: part });
  }
  return out;
}

export function hasDuplicateFileSections(diff: string): boolean {
  const seen = new Set<string>();
  for (const s of splitDiffFileSections(diff)) {
    if (!s.file) continue;
    if (seen.has(s.file)) return true;
    seen.add(s.file);
  }
  return false;
}

function lastSectionByFile(diff: string): Map<string, string> {
  const map = new Map<string, string>();
  for (const s of splitDiffFileSections(diff)) {
    if (s.file) map.set(s.file, s.text);
  }
  return map;
}

function firstSeenOrder(...diffs: string[]): string[] {
  const order: string[] = [];
  const seen = new Set<string>();
  for (const diff of diffs) {
    for (const s of splitDiffFileSections(diff)) {
      if (!s.file || seen.has(s.file)) continue;
      seen.add(s.file);
      order.push(s.file);
    }
  }
  return order;
}

function joinSections(texts: string[]): string {
  return texts.map((t) => t.replace(/\s+$/, '')).join('\n').trim();
}

/**
 * Combine a committed range and an uncommitted leftover into one applyable
 * patch. `workingTreeDiff` is consulted only for files that would otherwise
 * appear twice; files the caller already dropped from both halves stay dropped
 * (pre-existing dirt).
 */
export function combineApplyableTurnDiff(args: {
  committedDiff: string;
  uncommittedDiff: string;
  workingTreeDiff?: string;
}): string {
  const committed = (args.committedDiff || '').trim();
  const uncommitted = (args.uncommittedDiff || '').trim();
  const working = (args.workingTreeDiff || '').trim();
  if (!committed && !uncommitted) return working;
  if (!committed) {
    return hasDuplicateFileSections(uncommitted) && working
      ? rebuild(committed, uncommitted, working)
      : uncommitted;
  }
  if (!uncommitted) {
    if (!hasDuplicateFileSections(committed)) return committed;
    return working ? rebuild(committed, uncommitted, working) : joinSections([...lastSectionByFile(committed).values()]);
  }
  const concat = `${committed}\n${uncommitted}`;
  if (
    !hasDuplicateFileSections(concat)
    && !hasDuplicateFileSections(committed)
    && !hasDuplicateFileSections(uncommitted)
  ) {
    return concat;
  }
  return rebuild(committed, uncommitted, working);
}

function rebuild(committed: string, uncommitted: string, working: string): string {
  const wt = lastSectionByFile(working);
  const committedOnce = new Set<string>();
  const committedDupes = new Set<string>();
  for (const s of splitDiffFileSections(committed)) {
    if (!s.file) continue;
    if (committedOnce.has(s.file)) committedDupes.add(s.file);
    committedOnce.add(s.file);
  }
  const uncommittedFiles = new Set(
    splitDiffFileSections(uncommitted).map((s) => s.file).filter(Boolean),
  );
  const overlap = new Set<string>([
    ...[...committedOnce].filter((f) => uncommittedFiles.has(f)),
    ...committedDupes,
    ...[...uncommittedFiles].filter((f) => {
      const n = splitDiffFileSections(uncommitted).filter((s) => s.file === f).length;
      return n > 1;
    }),
  ]);

  const committedMap = lastSectionByFile(committed);
  const uncommittedMap = lastSectionByFile(uncommitted);
  const out: string[] = [];
  for (const file of firstSeenOrder(committed, uncommitted)) {
    let text: string | undefined;
    if (overlap.has(file)) {
      text = wt.get(file) || uncommittedMap.get(file) || committedMap.get(file);
    } else {
      text = committedMap.get(file) || uncommittedMap.get(file);
    }
    if (text) out.push(text);
  }
  return joinSections(out);
}
