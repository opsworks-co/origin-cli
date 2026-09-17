// The agent's lines in a context file Origin also writes to.
//
// CLAUDE.md, AGENTS.md, GEMINI.md (and the other ORIGIN_AUTHORED_CONTEXT_PATHS)
// hold two kinds of text: Origin's `<!-- origin-managed -->` block, which
// session-start rewrites every session, and whatever a person or an agent wrote
// around it. Capture used to drop these files whole. That hid Origin's
// bookkeeping, and it also hid real work: session 97c6ba73 turn 4 committed a
// rule change below the block (f5880972, +6/-3 across the three files) and the
// turn rendered no diff, under a commit chip claiming three files.
//
// Where a section is the key question is position — is this hunk inside the
// block? — and a diff hunk cannot answer it from its own lines: with git's
// default context the marker is usually out of view (the API's read-time strip
// tried exactly that and went path-only; see apps/api auto-managed-files.ts).
// So this works on CONTENT, never on hunk position: rebuild the file on both
// sides from a whole-file section, remove the block from each, and diff what is
// left. A section that does not carry the whole file cannot be rebuilt and is
// dropped, as before.

import { renderFileDiff } from './write-journal-diff.js';

export const ORIGIN_MANAGED_MARKER = '<!-- origin-managed -->';

// Anchor where the human-facing portion of the preamble begins. Everything
// before it (budget banner, agent system prompt) is either already surfaced
// on its own stderr line or is model-only config, not a user banner.
export const PREAMBLE_VISIBLE_ANCHOR = 'Origin: Session tracking active';

/**
 * The budget-lock notice budget-breach.ts writes at the top of AGENTS.md while a
 * hard cap is breached: a second Origin block, with its own pair of markers.
 */
export const ORIGIN_BUDGET_LOCK_MARKER = '<!-- origin-budget-lock -->';

const isBlank = (line: string): boolean => line.trim() === '';

/**
 * `lines` with lines [from, to] removed, and the blank lines Origin put around
 * the block with them: `renderManagedFile` appends `\n\n` before a block it adds
 * to a file, and the budget notice is followed by `\n\n`.
 */
function cut(lines: string[], from: number, to: number): string[] {
  const before = lines.slice(0, from);
  const after = lines.slice(to + 1);
  while (after.length > 0 && isBlank(after[0])) after.shift();
  if (after.length === 0 || before.length === 0) {
    while (before.length > 0 && isBlank(before[before.length - 1])) before.pop();
  }
  return [...before, ...after];
}

/**
 * The file with Origin's blocks removed: the budget-lock notice, then the
 * `<!-- origin-managed -->` block.
 *
 * A line CONTAINING a marker counts as one, because the writers find markers
 * with `indexOf`, not by line. The managed block mirrors `renderManagedFile`
 * (commands/hooks.ts), which decides what the block is when it writes it:
 * - two or more markers: everything from the first to the last, inclusive;
 * - one marker followed by Origin's preamble: from the marker to the end;
 * - one marker with no preamble after it: only the orphan marker line.
 * The budget notice is a non-greedy pair, as `writeBudgetLockNotice` replaces it.
 *
 * The result is normalized — no trailing blank lines, and one final newline
 * when non-empty — so a block appended to a file without a trailing newline
 * does not read as an edit to its last line. Both sides of a diff go through
 * the same normalization, so it never invents a change; at worst it hides an
 * edit that only added or removed blank lines or the final newline.
 */
export function stripOriginManagedBlock(text: string): string {
  // Keep each retained line's CR: renderFileDiff must match the original
  // content byte-for-byte for CRLF patches to apply. Marker includes() and
  // isBlank() already tolerate CRLF, including files with mixed line endings.
  let lines = text.split('\n');

  const budget = (): number[] => lines.flatMap((l, i) => (l.includes(ORIGIN_BUDGET_LOCK_MARKER) ? [i] : []));
  for (let at = budget(); at.length > 0; at = budget()) {
    lines = at.length >= 2 ? cut(lines, at[0], at[1]) : cut(lines, at[0], at[0]);
  }

  const markers = lines.flatMap((l, i) => (l.includes(ORIGIN_MANAGED_MARKER) ? [i] : []));
  if (markers.length >= 2) {
    lines = cut(lines, markers[0], markers[markers.length - 1]);
  } else if (markers.length === 1) {
    const tailIsPreamble = lines.slice(markers[0] + 1).some((l) => l.includes(PREAMBLE_VISIBLE_ANCHOR));
    lines = cut(lines, markers[0], tailIsPreamble ? lines.length - 1 : markers[0]);
  }

  while (lines.length > 0 && isBlank(lines[lines.length - 1])) lines.pop();
  return lines.length === 0 ? '' : `${lines.join('\n')}\n`;
}

interface WholeFileSides {
  before: string | null;
  after: string | null;
}

/**
 * Both sides of a file, rebuilt from its diff section — only when the section
 * holds the whole file: one hunk starting at the top of each side (the
 * 2000-line context the turn-window and commit-patch captures ask for), or a
 * created/deleted file. Null for anything else: a hunk that starts below line 1
 * leaves the lines above it unknown, and the block may be among them.
 */
function wholeFileSides(section: string): WholeFileSides | null {
  const lines = section.split('\n');
  if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
  let created = false;
  let deleted = false;
  let i = 0;
  for (; i < lines.length && !lines[i].startsWith('@@'); i++) {
    const l = lines[i];
    if (l.startsWith('Binary files ') || l.startsWith('GIT binary patch')) return null;
    if (l.startsWith('new file mode') || l === '--- /dev/null') created = true;
    if (l.startsWith('deleted file mode') || l === '+++ /dev/null') deleted = true;
  }
  const hunkHeaders = lines.slice(i).filter((l) => l.startsWith('@@'));
  if (hunkHeaders.length === 0) {
    // A mode-only or empty-file change: nothing of the agent's to show.
    return created || deleted ? { before: created ? null : '', after: deleted ? null : '' } : null;
  }
  if (hunkHeaders.length !== 1) return null;
  const m = hunkHeaders[0].match(/^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/);
  if (!m) return null;
  if (Number(m[1]) > 1 || Number(m[3]) > 1) return null;

  const old: string[] = [];
  const neu: string[] = [];
  let oldNoEol = false;
  let newNoEol = false;
  let last: ' ' | '-' | '+' | null = null;
  for (const l of lines.slice(i + 1)) {
    if (l.startsWith('\\')) {
      if (last === '-') oldNoEol = true;
      else if (last === '+') newNoEol = true;
      else if (last === ' ') { oldNoEol = true; newNoEol = true; }
      continue;
    }
    const tag = l[0];
    const body = l.slice(1);
    if (tag === ' ' || l === '') { old.push(body); neu.push(body); last = ' '; }
    else if (tag === '-') { old.push(body); last = '-'; }
    else if (tag === '+') { neu.push(body); last = '+'; }
    else return null;
  }
  if (old.length !== Number(m[2] ?? 1) || neu.length !== Number(m[4] ?? 1)) return null;
  const join = (ls: string[], noEol: boolean): string => (ls.length === 0 ? '' : ls.join('\n') + (noEol ? '' : '\n'));
  return {
    before: created ? null : join(old, oldNoEol),
    after: deleted ? null : join(neu, newNoEol),
  };
}

/**
 * The agent's part of one context-file diff section, as a section of its own —
 * or '' when there is none (Origin's block was the whole change) or when the
 * section does not carry the whole file and so cannot be split.
 *
 * The result has no marker line in it by construction. The API relies on that:
 * a context-file section in a turn diff with no marker is the agent's.
 */
export function agentPartOfManagedSection(section: string, file: string): string {
  const sides = wholeFileSides(section);
  if (!sides) return '';
  const strip = (t: string | null): string | null => (t === null ? null : stripOriginManagedBlock(t));
  const before = strip(sides.before);
  const after = strip(sides.after);
  if (before === after) return '';
  return renderFileDiff({ file, before, after }, 2000).replace(/\n+$/, '');
}
