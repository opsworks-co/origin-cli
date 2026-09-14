/**
 * A whole-file Write over an EXISTING file is a modification, not a create.
 *
 * The transcript extractor renders a turn's diff from the tool calls alone
 * (`buildDiffFromEdits`). It has no repository, so a Write that is the file's
 * first edit in the turn is rendered as a creation — `new file mode`,
 * `@@ -0,0 +1,N @@` — whether or not the file already existed. Stop then
 * backfills each whole-file Write's `oldContent` from git
 * (`backfillWriteBaselines`), but only into `editsJson`; the diff it sends is
 * still the creation.
 *
 * On the legacy reconstruction (no `diffSource`: the ledger declined and no
 * shadow window owns the turn) that creation IS the row. A turn that added one
 * line to a 30-line file was stored as +31/-0, the whole file billed as new.
 *
 * This re-renders exactly those sections from the evidence Stop already holds:
 * the backfilled before-state and the final after-state of the turn's
 * whole-file Writes. Anything else is left as it was:
 *   - a file whose section is not a creation (a real per-edit rendering),
 *   - a file with a non-Write edit in the turn (its before-state is not a
 *     single known text),
 *   - a Write whose `oldContent` is empty (the file really was created).
 */
import { renderFileDiff } from './write-journal-diff.js';

type WriteEdit = { file?: string; op?: string; oldContent?: string | null; newContent?: string | null };

const SECTION_SPLIT = /(?=^diff --git )/m;

function sectionFile(section: string): string | null {
  const m = /^diff --git a\/(.+?) b\//.exec(section);
  return m ? m[1] : null;
}

const sameFile = (a: string, b: string): boolean => a === b || a.endsWith(`/${b}`) || b.endsWith(`/${a}`);

/**
 * Re-render the creation sections of `diff` that are really modifications,
 * using the whole-file Writes in `editsJson`. Returns the new diff and the
 * files it changed; `changed` is empty when nothing was re-rendered, and the
 * diff is then returned untouched.
 */
export function reRenderCreatedWrites(
  diff: string | null | undefined,
  editsJson: string | null | undefined,
): { diff: string; changed: string[] } {
  const text = diff || '';
  if (!text.includes('new file mode') || !editsJson) return { diff: text, changed: [] };
  let edits: WriteEdit[];
  try {
    const parsed = JSON.parse(editsJson) as { edits?: WriteEdit[] };
    edits = Array.isArray(parsed?.edits) ? parsed.edits : [];
  } catch {
    return { diff: text, changed: [] };
  }
  if (edits.length === 0) return { diff: text, changed: [] };

  const changed: string[] = [];
  const sections = text.split(SECTION_SPLIT).map((section) => {
    if (!/^new file mode /m.test(section)) return section;
    const file = sectionFile(section);
    if (!file) return section;
    const forFile = edits.filter((e) => typeof e.file === 'string' && sameFile(e.file, file));
    if (forFile.length === 0) return section;
    // Every edit to this file in the turn must be a whole-file write, or the
    // before-state is not one known text.
    if (!forFile.every((e) => e.op === 'write' || e.op === 'create')) return section;
    const before = forFile.find((e) => typeof e.oldContent === 'string' && e.oldContent.length > 0)?.oldContent;
    const after = [...forFile].reverse().find((e) => typeof e.newContent === 'string')?.newContent;
    // No before-state: the file really was created. No after-state: nothing to render.
    if (typeof before !== 'string' || !before || typeof after !== 'string') return section;
    const rendered = renderFileDiff({ file, before, after });
    changed.push(file);
    // A write that put the file back exactly as it was is a net-zero change:
    // no section, rather than a whole-file add.
    return rendered;
  });
  if (changed.length === 0) return { diff: text, changed: [] };
  return { diff: sections.join(''), changed };
}
