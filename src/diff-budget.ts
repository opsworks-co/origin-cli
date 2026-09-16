// Fitting a diff into a byte budget WITHOUT corrupting it.
//
// Stage 3 of the capture rewrite. The pipeline had two size cliffs and both
// produced wrong data rather than less data:
//
//   `diff.slice(0, MAX_PROMPT_DIFF_LEN)`   200 KB, cuts MID-HUNK. The result
//                                          is not a smaller diff, it is a
//                                          CORRUPT one: a hunk header claiming
//                                          more lines than its body, which is
//                                          exactly what `origin verify-capture`
//                                          reports as `diff_unparseable`, and
//                                          what `git apply` refuses outright.
//   `len <= MAX_INGEST_PATCH ? {diff} : {}` 2 MB, and above it the diff is
//                                          DROPPED with no marker at all — so a
//                                          huge commit renders as a turn that
//                                          did nothing.
//
// Both are the same mistake: degrading to WRONG instead of degrading to LESS.
// A truncated unified diff is worse than no diff, because nothing downstream
// can tell it apart from a complete one.
//
// The rule here: cut only at boundaries the format defines. Whole file sections
// first, whole hunks within a section second, and never a partial hunk. What
// cannot be kept is NAMED, so the row can say "this file changed and its bytes
// are not here" instead of quietly shrinking. That name flows into
// `contentUnavailableFiles`, which the verifier already exempts from the
// file-set check for exactly this reason — the row is reporting a state it
// knows, not contradicting itself.
//
// CANONICAL COPY. apps/api/src/utils/diff-budget.ts is generated from this file
// by scripts/sync-shared-modules.mjs — edit here, then `pnpm sync:shared-modules`.
//
// PURE. No IO, no git.

/** Marks a file section that was dropped whole. */
export interface BudgetedDiff {
  /** A VALID unified diff, always. Never a partial hunk. */
  diff: string;
  /** Files whose sections did not fit, in the order they appeared. */
  omittedFiles: string[];
  /** Files kept only in part — some hunks dropped. */
  partialFiles: string[];
  /** True when file sections or changed hunks were dropped (not just context). */
  truncated: boolean;
  /** Size of the input, so a caller can report how much was lost. */
  originalBytes: number;
}

/** One `diff --git` section: its path and its exact text. */
interface Section {
  file: string;
  header: string;
  hunks: string[];
  text: string;
}

const GIT_HEADER = /^diff --git (?:"?a\/(.*?)"?) (?:"?b\/(.*?)"?)$/;

/**
 * Split a unified diff into per-file sections, preserving each one's exact
 * bytes.
 *
 * Deliberately text-preserving rather than re-rendering: a diff that came from
 * git carries `index`/`mode`/`similarity` lines this code has no business
 * reconstructing, and re-emitting a parsed form is how a faithful diff becomes
 * an approximate one.
 */
export function splitDiffSections(diff: string): Section[] {
  const out: Section[] = [];
  const lines = (diff || '').split('\n');
  let cur: Section | null = null;
  let headerDone = false;

  const flush = () => { if (cur) { cur.text = [cur.header, ...cur.hunks].join(''); out.push(cur); } };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const isLast = i === lines.length - 1;
    // The final '' from split() on a trailing newline is not a line.
    const withNl = isLast && line === '' ? '' : `${line}\n`;
    if (!withNl && isLast) continue;

    const gh = GIT_HEADER.exec(line);
    if (gh) {
      flush();
      cur = { file: gh[2] || gh[1] || '', header: withNl, hunks: [], text: '' };
      headerDone = false;
      continue;
    }
    if (!cur) continue; // preamble before any file section — dropped, as git does
    if (line.startsWith('@@ ')) {
      headerDone = true;
      cur.hunks.push(withNl);
      continue;
    }
    if (!headerDone) cur.header += withNl;
    else cur.hunks[cur.hunks.length - 1] += withNl;
  }
  flush();
  return out;
}

/** Bytes of a string as UTF-8 — the unit every transport and column measures. */
function byteLen(s: string): number {
  return Buffer.byteLength(s, 'utf-8');
}

/** Keep every change, reducing only unchanged context to Git's usual ±3 rows. */
function compactHunk(hunk: string): string {
  const lines = hunk.split('\n');
  if (lines[lines.length - 1] === '') lines.pop();
  const m = lines[0]?.match(/^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(.*)$/);
  if (!m) return hunk;
  const oldStart = Number(m[1]), newStart = Number(m[3]);
  const oldSize = m[2] === undefined ? 1 : Number(m[2]);
  const newSize = m[4] === undefined ? 1 : Number(m[4]);
  const rows: Array<{ text: string; old: number; next: number; oldNo: number; newNo: number }> = [];
  let oldNo = oldStart, newNo = newStart;
  for (const line of lines.slice(1)) {
    if (line.startsWith('\\ No newline at end of file')) {
      if (!rows.length) return hunk;
      rows[rows.length - 1].text += line + '\n';
      continue;
    }
    const op = line[0];
    // Unknown or malformed hunks must remain untouched, not be "repaired"
    // into a smaller patch that silently loses content.
    if (op !== ' ' && op !== '+' && op !== '-') return hunk;
    const old = op === '+' ? 0 : 1, next = op === '-' ? 0 : 1;
    rows.push({ text: line + '\n', old, next, oldNo, newNo });
    oldNo += old;
    newNo += next;
  }
  if (oldNo - oldStart !== oldSize || newNo - newStart !== newSize) return hunk;
  const ranges: Array<{ start: number; end: number }> = [];
  for (let i = 0; i < rows.length; i++) {
    if (rows[i].old && rows[i].next) continue;
    const start = Math.max(0, i - 3), end = Math.min(rows.length, i + 4);
    const last = ranges[ranges.length - 1];
    if (last && start <= last.end) last.end = end;
    else ranges.push({ start, end });
  }
  if (!ranges.length || (ranges.length === 1 && ranges[0].start === 0 && ranges[0].end === rows.length)) return hunk;
  return ranges.map(({ start, end }) => {
    const kept = rows.slice(start, end);
    const oldCount = kept.reduce((n, row) => n + row.old, 0);
    const newCount = kept.reduce((n, row) => n + row.next, 0);
    // Zero-length ranges point to the line BEFORE an insertion/deletion.
    // An originally empty side already has that anchor in its header.
    const oldAt = kept[0].oldNo - (oldCount === 0 && oldSize > 0 ? 1 : 0);
    const newAt = kept[0].newNo - (newCount === 0 && newSize > 0 ? 1 : 0);
    return `@@ -${oldAt},${oldCount} +${newAt},${newCount} @@${m[5]}\n`
      + kept.map(row => row.text).join('');
  }).join('');
}

/**
 * Reduce a diff to fit `maxBytes`, cutting only at format boundaries.
 *
 * Order of preference, each strictly better than the next:
 *   1. Everything fits — returned unchanged, byte for byte.
 *   2. Remove excess unchanged context before omitting any changed hunks.
 *   3. Whole file sections are kept until the budget runs out; the rest are
 *      named in `omittedFiles`.
 *   4. A section that will not fit whole is kept as its header plus as many
 *      WHOLE hunks as remain affordable, and named in `partialFiles`. A header
 *      with no hunks is a valid diff section (git emits one for a mode-only
 *      change), so this never produces something unparseable.
 *   5. When even a header does not fit, the file is omitted entirely.
 *
 * Sections are considered in their original order rather than smallest-first.
 * Reordering would be a better packing and a worse diff: a reviewer reads a
 * diff in file order, and a "first N files" cut is explicable where an
 * arbitrary subset is not.
 */
export function fitDiffToBudget(diff: string, maxBytes: number): BudgetedDiff {
  let text = diff || '';
  const originalBytes = byteLen(text);
  if (!text.trim() || originalBytes <= maxBytes) {
    return { diff: text, omittedFiles: [], partialFiles: [], truncated: false, originalBytes };
  }

  // Full-file context can spend the entire budget on unchanged lines. In
  // session 805c1429 a +225/-5 turn became +218/-5 even though its changes
  // fit comfortably: one 224KB file crowded out its own later hunk and the
  // last file. Shrink context across ALL files before choosing any omissions.
  let sections = splitDiffSections(text);
  text = sections.map(s => s.header + s.hunks.map(compactHunk).join('')).join('');
  if (sections.length > 0 && byteLen(text) <= maxBytes) {
    return { diff: text, omittedFiles: [], partialFiles: [], truncated: false, originalBytes };
  }
  sections = splitDiffSections(text);
  // No recognisable sections (not a git-style diff): keeping a prefix would be
  // the mid-cut this module exists to prevent, so keep nothing and say so.
  if (sections.length === 0) {
    return { diff: '', omittedFiles: [], partialFiles: [], truncated: true, originalBytes };
  }

  const kept: string[] = [];
  const omittedFiles: string[] = [];
  const partialFiles: string[] = [];
  let used = 0;

  for (const s of sections) {
    const whole = byteLen(s.text);
    if (used + whole <= maxBytes) {
      kept.push(s.text);
      used += whole;
      continue;
    }
    // Try the section partially: header plus whole hunks, in order.
    const headerBytes = byteLen(s.header);
    if (used + headerBytes > maxBytes) { omittedFiles.push(s.file); continue; }
    let partial = s.header;
    let partialBytes = headerBytes;
    let tookAny = false;
    for (const h of s.hunks) {
      const hb = byteLen(h);
      if (used + partialBytes + hb > maxBytes) break;
      partial += h;
      partialBytes += hb;
      tookAny = true;
    }
    if (!tookAny) {
      // Not one whole hunk fits. A header alone says "this file changed" and
      // stays parseable, but it is not worth the bytes if nothing follows —
      // name the file instead, which carries the same information for free.
      omittedFiles.push(s.file);
      continue;
    }
    kept.push(partial);
    used += partialBytes;
    partialFiles.push(s.file);
  }

  return {
    diff: kept.join(''),
    omittedFiles,
    partialFiles,
    truncated: omittedFiles.length > 0 || partialFiles.length > 0,
    originalBytes,
  };
}

/**
 * Drop-in replacement for `diff.slice(0, MAX_PROMPT_DIFF_LEN)`.
 *
 * Same signature shape as the slice it replaces so every call site can be
 * converted without restructuring, but it cuts at file/hunk boundaries instead
 * of mid-hunk. Callers that can carry the omitted file names should use
 * `fitDiffToBudget` directly and report them — this is for the sites that only
 * have somewhere to put a string.
 */
export function capDiff(diff: string | null | undefined, maxBytes: number): string {
  return fitDiffToBudget(diff || '', maxBytes).diff;
}
