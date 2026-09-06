// ── Capture self-consistency verification ───────────────────────────────────
//
// Nothing in Origin has ever checked whether a capture is INTERNALLY COHERENT,
// and that is why the same defects keep being found by eye on the dashboard
// months after they shipped.
//
// The insight this module rests on: most capture defects are visible as a row
// CONTRADICTING ITSELF, with no ground truth required. A turn that says it
// changed thirteen files while storing a diff describing five is wrong no
// matter what git says — the two halves of one row cannot both be right. That
// makes the check cheap (no git, no network, no baseline) and total (it runs on
// historical captures, on any agent, on any repo).
//
// Measured on this machine's 271 stored turns (36 sessions) the day the module
// was written — every one of these is a row disagreeing with itself:
//
//   contradictions
//     claimed_file_absent_from_diff    42
//     diff_file_unclaimed              23
//     files_without_content            17
//     diff_unparseable                 15
//   suspects
//     identical_change_in_two_turns   114
//     duplicate_file_section           24
//   ─────────────────────────────────────────────────────
//   turns with >=1 contradiction      69 of 271  (25%)
//   sessions with >=1 contradiction   19 of  36  (53%)
//
// Two worked examples, both from real stored captures:
//
//   717c96aa (claude-code). Turns 3 and 4 store diffs touching AGENTS.md /
//   CLAUDE.md / GEMINI.md without listing them, while turn 9 LISTS those three
//   and stores a diff that does not contain them. One capture wrote the file
//   list, a different capture wrote the diff, and nothing compared them.
//
//   The same session, cumulative diffs: turn 1 is 29 KB, turn 3 is 81 KB and
//   turn 4 is 82 KB, and turns 3 and 4 each re-contain turn 1's context-
//   injection.ts change BYTE FOR BYTE. A baseline that failed to advance makes
//   every later turn re-report its predecessors' work, so the same lines are
//   counted three times. `identical_change_in_two_turns` is what finds that,
//   and it is why the count is high: it fires once per repeated file.
//
// EPISTEMICS. A violation means "these two fields disagree", never "the agent
// did not do this". Absence of evidence is unknown, not false — the same rule
// transcript-attribution.ts follows. So a turn with no file list AND no diff is
// not reported: it is empty, which is a legitimate state for a chat-only turn.
// Only a row that asserts two incompatible things is a finding.
//
// PURE (no IO, no git, no clock), so the rules are testable on their own and
// can run over a stored corpus as easily as over a live payload.

/**
 * Repo-relative path key for comparison.
 *
 * NOT paths.ts's `samePath`: that one resolves against the filesystem
 * (realpath, 8.3 short names), which is exactly right for a live path and
 * exactly wrong here — a stored capture is history, and its files may have
 * been renamed or deleted since. Resolving them would compare whatever happens
 * to exist on disk today instead of what the capture recorded.
 *
 * So this is a pure string normalisation: separators, leading `./`, and a
 * `a/`|`b/` diff prefix. Case is preserved — two files differing only in case
 * are different files on the platforms Origin captures on, and folding it
 * would hide a real defect.
 */
export function diffPathKey(p: string | null | undefined): string {
  let s = String(p ?? '').trim().replace(/\\/g, '/');
  if (s.startsWith('"') && s.endsWith('"') && s.length > 1) s = s.slice(1, -1);
  s = s.replace(/^\.\//, '').replace(/^\/+/, '');
  return s;
}

/** Compare two paths that are already repo-relative capture records. */
function sameFile(a: string, b: string): boolean {
  const x = diffPathKey(a);
  const y = diffPathKey(b);
  if (x === y) return true; // path-compare-ok — both sides normalised above
  // A capture may store an absolute path where the diff stores a repo-relative
  // one (and vice versa). Suffix containment on a full component boundary is
  // the only tolerance allowed: it must never make `src/a.ts` match `b/a.ts`.
  return x.endsWith(`/${y}`) || y.endsWith(`/${x}`);
}

// ─── Unified diff parsing ───────────────────────────────────────────────────

export interface ParsedDiffFile {
  /** Repo-relative path, as the diff names it. */
  file: string;
  added: number;
  removed: number;
  /** True when the diff carries no hunks for this file (binary, mode-only). */
  contentless: boolean;
  /** The diff declares this file created (`--- /dev/null`). */
  isNew: boolean;
  /**
   * FNV-1a over this file's hunk body — the +/- lines only, so it identifies
   * the CHANGE rather than the surrounding context, which shifts between
   * captures. A hash rather than the text itself: the cross-turn check has to
   * hold one entry per file per turn, and retaining section text would double
   * the memory cost of verifying a large diff.
   */
  contentHash: string;
}

export interface ParsedDiff {
  files: ParsedDiffFile[];
  /** Human-readable reasons the text is not a well-formed unified diff. */
  malformed: string[];
  /**
   * Files carrying more than one section in this text.
   *
   * Kept OUT of `malformed` deliberately. It is not necessarily corruption: a
   * turn that made two commits has its diffs concatenated, and the same file
   * touched by both legitimately appears twice. It is still worth counting,
   * because the result is not an applyable patch and the second section's
   * context is written against the first section's result — so any consumer
   * that treats the field as one diff will double-count it.
   */
  duplicateFiles: string[];
}

const GIT_HEADER = /^diff --git (?:"?a\/(.*?)"?) (?:"?b\/(.*?)"?)$/;
const HUNK_HEADER = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;
// A COMBINED diff — what `git show` prints for a merge (`--cc`). Its hunk
// marker carries one `@` per parent (`@@@ -1,7 -1,7 +1,9 @@@`) and its body
// uses one prefix column per parent, so `++` and ` -` are single lines, not
// two. Standard tooling cannot apply it and every unified-diff parser silently
// miscounts it — which is precisely how it survived in stored captures.
const COMBINED_HUNK = /^@{3,} (?:-\d+(?:,\d+)? ){2,}\+\d+(?:,\d+)? @{3,}/;
// `index <a>,<b>..<result>` — the combined form's index line, present even when
// the hunks were truncated away.
const COMBINED_INDEX = /^index [0-9a-f]+,[0-9a-f]+\.\.[0-9a-f]+/;

/** FNV-1a, 32-bit. Not cryptographic — this only has to separate changes. */
function fnv1a(seed: string, text: string): string {
  let h = 0x811c9dc5;
  const s = seed + '\u0000' + text;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i) & 0xff;
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, '0');
}

/**
 * Parse a unified diff into per-file line counts, and report the ways it is
 * malformed.
 *
 * Deliberately reimplemented rather than reusing `parseUnifiedZero` from
 * final-state-blame.ts: that one is `-U0`-specific (it reads hunk headers to
 * map line numbers and never validates a hunk BODY), and validating the body
 * against its header is the whole point here — a diff truncated at the 200 KB
 * cap keeps a syntactically valid header above a body that stops mid-hunk.
 *
 * Verified line-for-line against `git apply --numstat` over the stored corpus;
 * `capture-verify.test.ts` keeps that agreement as a property test.
 */
export function parseUnifiedDiff(text: string | null | undefined): ParsedDiff {
  const files: ParsedDiffFile[] = [];
  const malformed: string[] = [];
  const raw = String(text ?? '');
  if (!raw.trim()) return { files, malformed, duplicateFiles: [] };

  const lines = raw.split('\n');
  let cur: ParsedDiffFile | null = null;
  let aPath = '';
  let bPath = '';
  // Outstanding line budget for the hunk being read.
  let wantOld = 0;
  let wantNew = 0;
  let inHunk = false;
  let hunkAt = 0;

  const closeHunk = () => {
    if (!inHunk) return;
    if (wantOld !== 0 || wantNew !== 0) {
      malformed.push(
        `hunk at line ${hunkAt} ends ${wantOld} old / ${wantNew} new lines short of its header`,
      );
    }
    inHunk = false;
  };

  // Returns the opened file rather than assigning `cur` itself: TypeScript does
  // not track assignments made inside a closure, so an inner `cur = …` leaves
  // the outer `cur` narrowed to null and every later field access an error.
  const openFile = (): ParsedDiffFile | null => {
    closeHunk();
    // A delete renders as `+++ /dev/null`; git's numstat names the a-side then.
    const named = bPath && bPath !== '/dev/null' ? bPath : aPath;
    if (!named || named === '/dev/null') return null;
    const opened: ParsedDiffFile = {
      file: diffPathKey(named),
      added: 0,
      removed: 0,
      contentless: true,
      // Set below, when `--- /dev/null` is read: for a created file the git
      // header still names `a/<path>`, so creation is only knowable from the
      // `---` line that follows it.
      isNew: false,
      contentHash: '',
    };
    files.push(opened);
    return opened;
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    const gh = GIT_HEADER.exec(line);
    if (gh) {
      closeHunk();
      aPath = gh[1] || '';
      bPath = gh[2] || '';
      cur = openFile();
      continue;
    }

    // A plain unified diff (no `diff --git`) announces itself with ---/+++.
    if (!inHunk && line.startsWith('--- ')) {
      aPath = line.slice(4).replace(/^"?a\//, '').replace(/"$/, '').split('\t')[0];
      if (cur && aPath === '/dev/null') cur.isNew = true; // path-compare-ok — sentinel, not a path
      continue;
    }
    if (!inHunk && line.startsWith('+++ ')) {
      bPath = line.slice(4).replace(/^"?b\//, '').replace(/"$/, '').split('\t')[0];
      // `diff --git` already opened the file; only open one if it did not.
      if (!cur || !sameFile(cur.file, bPath !== '/dev/null' ? bPath : aPath)) cur = openFile();
      continue;
    }

    if (COMBINED_HUNK.test(line) || COMBINED_INDEX.test(line)) {
      closeHunk();
      malformed.push(
        `line ${i + 1} is a combined (--cc) merge diff, which no unified-diff reader can apply`,
      );
      // Its body would be miscounted line-for-line, so stop attributing content
      // to the current file rather than reporting a number we know is wrong.
      if (cur) cur.contentless = true;
      cur = null;
      continue;
    }

    const hh = HUNK_HEADER.exec(line);
    if (hh) {
      closeHunk();
      if (!cur) {
        malformed.push(`hunk at line ${i + 1} precedes any file header`);
        continue;
      }
      wantOld = hh[2] === undefined ? 1 : parseInt(hh[2], 10);
      wantNew = hh[4] === undefined ? 1 : parseInt(hh[4], 10);
      inHunk = true;
      hunkAt = i + 1;
      cur.contentless = false;
      continue;
    }

    if (line.startsWith('Binary files ') || line.startsWith('GIT binary patch')) {
      if (cur) cur.contentless = true;
      continue;
    }

    if (!inHunk) continue;

    // `\ No newline at end of file` annotates the preceding line; it is not one.
    if (line.startsWith('\\')) continue;

    // The last element of split('\n') on a trailing newline is '', which is not
    // a body line. Any other bare '' IS an empty context line.
    if (line === '' && i === lines.length - 1) { closeHunk(); continue; }

    if (line.startsWith('+')) {
      if (wantNew <= 0) { closeHunk(); i--; continue; }
      cur!.added++; wantNew--;
      cur!.contentHash = fnv1a(cur!.contentHash, line);
    } else if (line.startsWith('-')) {
      if (wantOld <= 0) { closeHunk(); i--; continue; }
      cur!.removed++; wantOld--;
      cur!.contentHash = fnv1a(cur!.contentHash, line);
    } else if (line.startsWith(' ') || line === '') {
      if (wantOld <= 0 && wantNew <= 0) { closeHunk(); i--; continue; }
      wantOld--; wantNew--;
    } else {
      // Anything else inside a hunk ends it — the next file header, or noise.
      closeHunk();
      i--;
    }
  }
  closeHunk();

  // A created file has no previous content, so a hunk that removes lines from
  // it describes a state that never existed. git refuses such a patch outright
  // ("new file … depends on old contents"); Origin has stored several, from the
  // path that renders a whole-file write without a before-image.
  for (const f of files) {
    if (f.isNew && f.removed > 0) {
      malformed.push(`${f.file} is declared a new file but its diff removes ${f.removed} line(s)`);
    }
  }

  // The same file twice in one diff cannot be applied — the second section's
  // context is written against the first's result. It means two diff texts were
  // concatenated into one field rather than merged.
  const seenOnce = new Set<string>();
  const dupes = new Set<string>();
  for (const f of files) {
    if (seenOnce.has(f.file)) dupes.add(f.file);
    seenOnce.add(f.file);
  }

  return { files, malformed, duplicateFiles: [...dupes] };
}

/** Total added/removed across every file in a diff. */
export function diffTotals(d: ParsedDiff): { added: number; removed: number } {
  let added = 0;
  let removed = 0;
  for (const f of d.files) { added += f.added; removed += f.removed; }
  return { added, removed };
}

// ─── Violations ─────────────────────────────────────────────────────────────

export type ViolationCode =
  | 'diff_unparseable'
  | 'files_without_content'
  | 'content_without_files'
  | 'claimed_file_absent_from_diff'
  | 'diff_file_unclaimed'
  | 'line_counts_disagree_with_diff'
  | 'duplicate_file_section'
  | 'identical_change_in_two_turns';

/**
 * `contradiction` — the row asserts two incompatible things. Always a defect,
 *   whatever produced it.
 * `suspect` — coherent, but carries a shape that a correct capture rarely has.
 *   Reported so it can be counted, never treated as proof.
 */
export type ViolationSeverity = 'contradiction' | 'suspect';

export interface CaptureViolation {
  code: ViolationCode;
  severity: ViolationSeverity;
  promptIndex: number;
  detail: string;
  files?: string[];
}

export interface VerifiableTurn {
  promptIndex: number;
  filesChanged?: string[] | null;
  diff?: string | null;
  uncommittedDiff?: string | null;
  outOfRepoFiles?: string[] | null;
  /**
   * Files known to have changed whose CONTENT could not be retained — binary,
   * over the snapshot cap, or a full store (see write-journal-store.ts).
   *
   * Exempt from the file-set checks for the same reason `outOfRepoFiles` is:
   * the row is not contradicting itself, it is reporting a state it genuinely
   * knows. The alternative — dropping the file from `filesChanged` to keep the
   * row consistent — would make the capture quietly under-report, which is the
   * failure mode this whole rewrite exists to remove. A known change with no
   * bytes is information; a silently missing file is not.
   */
  contentUnavailableFiles?: string[] | null;
  linesAdded?: number | null;
  linesRemoved?: number | null;
  /**
   * This row is a FILE-SET record, not a turn capture.
   *
   * At least one producer stores, alongside its real captures, an accumulator
   * of every file a session has touched — a file list with deliberately no
   * diff — so the git-hook path can match a commit's staged files back to the
   * session that wrote them (see `registerAgySessionState`). Graded as a turn
   * it is `files_without_content` forever, which is how every Antigravity
   * session came to read as broken while its per-turn capture was correct.
   *
   * SKIPPED, not exempted. Exempting would grade it as a turn that happens to
   * pass; it is not a turn, and counting it as one clean would be as false as
   * counting it dirty. And the flag must be PRESENT to skip — absence never
   * confers the privilege, so a producer that stops writing it gets graded
   * again instead of silently excused.
   */
  fileSetOnly?: boolean;
}

/**
 * A row that declares itself a file-set accumulator rather than a turn capture.
 *
 * Strict `=== true`: a truthy-but-not-true value is a producer bug, and the
 * safe reading of a malformed flag is "grade it".
 */
export function isFileSetRecord(turn: VerifiableTurn | null | undefined): boolean {
  return !!turn && turn.fileSetOnly === true;
}

const MAX_LISTED = 8;

/**
 * Check one turn against itself.
 *
 * Both stored diffs are considered together: a file may legitimately appear in
 * `diff` (committed) or `uncommittedDiff` (working tree), and treating either
 * alone as the row's content reports a file as missing when it is simply in the
 * other field. That was a false positive in the first draft of this check.
 */
export function verifyTurn(turn: VerifiableTurn): CaptureViolation[] {
  const out: CaptureViolation[] = [];
  const at = turn.promptIndex;
  const add = (code: ViolationCode, severity: ViolationSeverity, detail: string, files?: string[]) =>
    out.push({ code, severity, promptIndex: at, detail, ...(files && files.length ? { files } : {}) });

  const committed = parseUnifiedDiff(turn.diff);
  const working = parseUnifiedDiff(turn.uncommittedDiff);

  const dupes = [...committed.duplicateFiles, ...working.duplicateFiles];
  if (dupes.length > 0) {
    add('duplicate_file_section', 'suspect',
      `${dupes.length} file(s) carry more than one section in one stored diff — `
      + 'two diff texts concatenated, so the field is not an applyable patch',
      dupes.slice(0, MAX_LISTED));
  }

  const badness = [...committed.malformed, ...working.malformed];
  if (badness.length > 0) {
    add('diff_unparseable', 'contradiction',
      `stored diff is not a well-formed unified diff: ${badness[0]}`);
  }

  // Out-of-repo writes are recorded separately and never appear in a repo diff,
  // and neither does a file whose content the store declined to keep.
  const outOfRepo = [
    ...(turn.outOfRepoFiles || []),
    ...(turn.contentUnavailableFiles || []),
  ].map(diffPathKey);
  const claimed = (turn.filesChanged || [])
    .map(diffPathKey)
    .filter((f) => f && !outOfRepo.some((o) => sameFile(o, f)));

  // Deduped: a file with two sections (see `duplicateFiles`) would otherwise be
  // listed twice in every message built from this.
  const inDiff = [...new Set([...committed.files, ...working.files].map((f) => f.file))];
  const hasContent = inDiff.length > 0;

  if (claimed.length > 0 && !hasContent && badness.length === 0) {
    add('files_without_content', 'contradiction',
      `claims ${claimed.length} changed file(s) but stores no diff for any of them`,
      claimed.slice(0, MAX_LISTED));
  } else if (hasContent && claimed.length === 0) {
    add('content_without_files', 'contradiction',
      `stores a diff touching ${inDiff.length} file(s) but claims none`,
      inDiff.slice(0, MAX_LISTED));
  } else if (hasContent && claimed.length > 0) {
    const missing = claimed.filter((c) => !inDiff.some((d) => sameFile(c, d)));
    const unclaimed = inDiff.filter((d) => !claimed.some((c) => sameFile(c, d)));
    if (missing.length > 0) {
      add('claimed_file_absent_from_diff', 'contradiction',
        `${missing.length} claimed file(s) do not appear in the stored diff`,
        missing.slice(0, MAX_LISTED));
    }
    if (unclaimed.length > 0) {
      add('diff_file_unclaimed', 'contradiction',
        `${unclaimed.length} file(s) in the stored diff are not in filesChanged`,
        unclaimed.slice(0, MAX_LISTED));
    }
  }

  // The mosaic tell: counts taken from one capture, diff from another.
  if (badness.length === 0 && (typeof turn.linesAdded === 'number' || typeof turn.linesRemoved === 'number')) {
    const t = diffTotals(committed);
    const anyContentless = committed.files.some((f) => f.contentless);
    const declaredA = turn.linesAdded ?? 0;
    const declaredR = turn.linesRemoved ?? 0;
    // A binary or mode-only file has no countable lines, so a mismatch there
    // says nothing. Only compare when every file in the diff carries hunks.
    if (!anyContentless && (declaredA !== t.added || declaredR !== t.removed)) {
      add('line_counts_disagree_with_diff', 'contradiction',
        `row says +${declaredA}/-${declaredR}, stored diff contains +${t.added}/-${t.removed}`);
    }
  }

  return out;
}

/**
 * Check a session's turns against each other.
 *
 * Only ONE cross-turn rule, and it is deliberately narrow: the SAME file
 * carrying a BYTE-IDENTICAL diff on two turns is one write counted twice, not
 * two writes. A file legitimately edited in two turns has different content
 * each time, so this cannot fire on it — the distinction transcript-attribution
 * .ts makes for the same reason.
 */
export function verifySession(turns: VerifiableTurn[]): CaptureViolation[] {
  const out: CaptureViolation[] = [];
  if (!Array.isArray(turns)) return out;

  // File-set records are not turns and cannot contradict themselves; they are
  // also invisible to the cross-turn rule below, which would otherwise read one
  // producer's session-wide file list as a turn repeating its neighbours' work.
  const graded = turns.filter((t) => !isFileSetRecord(t));

  for (const t of graded) {
    if (t && Number.isInteger(t.promptIndex)) out.push(...verifyTurn(t));
  }

  // file -> content signature -> turns carrying it
  const seen = new Map<string, Map<string, number[]>>();
  for (const t of graded) {
    if (!t || !Number.isInteger(t.promptIndex)) continue;
    for (const f of parseUnifiedDiff(t.diff).files) {
      if (f.contentless || (f.added === 0 && f.removed === 0)) continue;
      const sig = f.contentHash;
      const byContent = seen.get(f.file) || new Map<string, number[]>();
      const idxs = byContent.get(sig) || [];
      // A file duplicated WITHIN one turn is `duplicate_file_section`, a
      // different finding. Only distinct turns count as a cross-turn repeat.
      if (!idxs.includes(t.promptIndex)) byContent.set(sig, [...idxs, t.promptIndex]);
      else byContent.set(sig, idxs);
      seen.set(f.file, byContent);
    }
  }
  for (const [file, byContent] of seen) {
    for (const [sig, idxs] of byContent) {
      if (idxs.length < 2) continue;
      out.push({
        code: 'identical_change_in_two_turns',
        severity: 'suspect',
        promptIndex: idxs[idxs.length - 1],
        detail: `${file} carries a byte-identical change on turns ${idxs.join(', ')}`,
        files: [file],
      });
    }
  }

  return out;
}

/** Roll findings up for reporting. */
export interface VerifySummary {
  turns: number;
  cleanTurns: number;
  contradictions: number;
  suspects: number;
  /**
   * Rows skipped because they are file-set records. Reported rather than
   * silently dropped: a producer excluded without a number beside it is
   * indistinguishable from a producer that is passing.
   */
  fileSetRecords: number;
  byCode: Record<string, number>;
}

export function summarize(turns: VerifiableTurn[], violations: CaptureViolation[]): VerifySummary {
  const byCode: Record<string, number> = {};
  let contradictions = 0;
  let suspects = 0;
  const dirty = new Set<number>();
  for (const v of violations) {
    byCode[v.code] = (byCode[v.code] || 0) + 1;
    if (v.severity === 'contradiction') { contradictions++; dirty.add(v.promptIndex); }
    else suspects++;
  }
  const all = Array.isArray(turns) ? turns : [];
  const graded = all.filter((t) => !isFileSetRecord(t)).length;
  return {
    turns: graded,
    cleanTurns: graded - dirty.size,
    contradictions,
    suspects,
    fileSetRecords: all.length - graded,
    byCode,
  };
}
