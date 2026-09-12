import { spawnSync } from 'child_process';
import { git, gitDetailed, gitOrNull } from './utils/exec.js';
import { shouldIgnoreFile, stripIgnoredSectionsFromDiff, trimDiffText } from './ignore-patterns.js';
import { combineApplyableTurnDiff } from './applyable-turn-diff.js';
import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';

const HEX = /^[a-fA-F0-9]+$/;

// Unique temp-index path. `pid + Date.now()` was not unique: two shadows created
// inside the same millisecond in one process reuse the same GIT_INDEX_FILE and
// corrupt each other's tree (one of them then reports the other's contents, or
// fails outright). Reproducible by running the git-heavy test suites in
// parallel. The counter makes it collision-free within a process, the pid across
// processes.
let tmpIndexSeq = 0;
function tmpIndexPath(prefix: string): string {
  tmpIndexSeq += 1;
  return path
    .join(os.tmpdir(), `${prefix}-${process.pid}-${Date.now()}-${tmpIndexSeq}.idx`)
    .replace(/\\/g, '/');
}

/**
 * A commit message as the server needs to receive it: subject AND body.
 *
 * The body is not decoration. Origin's own prepare-commit-msg hook writes
 * `Origin-Session: <id> | <Agent> | <N prompts>` into it precisely so a
 * commit's owner travels WITH the commit — and the API's ownership guards
 * (commitNamesOtherSession, used on the FK path, the display list and the
 * injected-commit sweep) all read that trailer off `Commit.message`.
 *
 * Both CLI writers of that column sent `--format=%s`, the subject alone. So
 * every CLI-captured commit reached the server trailerless, and each guard's
 * "no trailer — most commits have none — leave it alone" branch waved it
 * through. The guards were never wrong; the evidence had been discarded one
 * layer upstream. Session b05c4b43 shows the result: 35058c5d, trailered
 * `Origin-Session: 59a0fa03-dc5`, rendered on a DIFFERENT session's timeline
 * and badged a turn that had written nothing. Commits arriving by webhook kept
 * their full message, which is why only local, concurrent-agent commits — the
 * exact case the trailer exists for — were affected.
 *
 * Truncation keeps the TAIL. Trailers are the last lines of a message, so
 * head-truncating a long one would reintroduce the same blindness for the same
 * reason.
 */
export function capCommitMessage(raw: string, limit = 8000): string {
  const msg = (raw || '').trim();
  if (msg.length <= limit) return msg;
  const head = Math.floor(limit * 0.6);
  const tail = limit - head;
  return `${msg.slice(0, head)}\n…\n${msg.slice(-tail)}`;
}

// ─── Types ─────────────────────────────────────────────────────────────────

export interface CommitInfo {
  sha: string;
  message: string;
  author: string;
  filesChanged: string[];
  // Per-commit line counts (computed via --numstat). The API leaves a Commit
  // row's additions/deletions NULL unless a provider (GitHub/GitLab) backfill
  // runs — which never happens for local repos or RUNNING sessions, so commit
  // pages showed no line stats and "AI authored" had nothing to aggregate.
  // Sending them here lets the API populate the row at ingest time.
  linesAdded: number;
  linesRemoved: number;
  // The part of linesAdded/linesRemoved that was ALREADY uncommitted in the
  // working tree when this session started — work a previous session (or the
  // user) left behind and this commit swept up. Absent when it could not be
  // proven; see the computation for what "proven" means. Never a guess: the
  // number exists to explain a commit total that exceeds what the session
  // authored, and an invented one would explain it wrongly.
  preSessionLinesAdded?: number;
  preSessionLinesRemoved?: number;
  // Per-commit unified patch (`git show <sha>`). The API stores this on the
  // Commit row so blame + the Full Session Diff can source committed lines
  // from git truth. Without it, LOCAL-repo commits (never pushed, so the
  // provider patch-backfill can't reach them) and mid-session commits on a
  // RUNNING session land with `patch: null`, forcing the blame view into
  // fragile reconstruction that duplicated/inflated lines (session 4f36ee1c
  // `colors` rendered 14 lines for a 9-line file). Capped like the session
  // diff; omitted when empty or oversize.
  patch?: string;
  // Committer time (epoch ms). Lets the Codex rollout watcher scope commits to
  // the thread that actually authored them: its cumulative headShaAtStart..HEAD
  // walk otherwise sweeps in commits a DIFFERENT concurrent thread made in the
  // same repo, and an older still-running thread then steals a newer session's
  // commit (Windows-only — Mac uses hooks). Omitted if git can't report it.
  committedAt?: number;
}

export interface GitCaptureResult {
  headBefore: string;
  headAfter: string;
  commitShas: string[];     // Real commit SHAs created during session
  commitDetails: CommitInfo[]; // Per-commit metadata
  diff: string;             // Combined committed + uncommitted (capped at MAX_DIFF_SIZE)
  committedDiff: string;    // Committed changes only (sha..sha)
  uncommittedDiff: string;  // Uncommitted changes only (staged + unstaged + untracked)
  diffTruncated: boolean;
  linesAdded: number;
  linesRemoved: number;
  /**
   * Single unified diff of `working tree vs headBefore's tree`. When
   * headBefore is a "shadow commit" (created by createShadowCommit and
   * NOT an ancestor of HEAD), the legacy `committedDiff + uncommittedDiff`
   * pair produces self-canceling text. Use `workingTreeDiff` instead in
   * that case — it's always the clean "what changed between baseline
   * tree and current working tree" view.
   */
  workingTreeDiff: string;
  /**
   * True when headBefore is an Origin SHADOW commit, so callers should prefer
   * `workingTreeDiff` over the `committedDiff + uncommittedDiff` pair.
   *
   * This used to be computed as "headBefore is not an ancestor of HEAD", which
   * is necessary but not sufficient: a `git checkout` onto a branch cut before
   * the baseline leaves headBefore a perfectly real commit that is also not an
   * ancestor. Treating that as a shadow put the capture on the tree-to-tree
   * path and credited the turn with the whole branch delta — another agent's
   * commit, on a turn that only read files (session a6ad8379). It is now
   * decided by the shadow's own author identity; the divergence case
   * re-baselines `workingTreeDiff` to HEAD instead.
   */
  baselineIsShadow: boolean;
}

// ─── Constants ─────────────────────────────────────────────────────────────

const MAX_DIFF_SIZE = 500_000; // 500KB max diff size

/**
 * Author identity stamped on every shadow commit `createShadowCommit` writes.
 *
 * Load-bearing beyond cosmetics: it is how a baseline that is not an ancestor
 * of HEAD is told apart from a real commit left behind by a `git checkout`.
 * Change it in one place only — `createShadowCommit` sets it from here.
 */
export const SHADOW_IDENTITY_EMAIL = 'shadow@origin.local';

/**
 * Maximum byte length for a single per-prompt diff in payloads sent to the
 * API (PATCH /api/mcp/session/:id `promptChanges[].diff` /
 * `.uncommittedDiff`, plus the equivalent endpoints under /session/end and
 * /commits/ingest's per-prompt blocks).
 *
 * MUST match the API's per-prompt cap in apps/api/src/routes/mcp.ts:~1540
 * (`.slice(0, 200_000)` on each incoming `pc.diff` / `pc.uncommittedDiff`).
 * If the CLI sends a SMALLER slice than the API would store we silently
 * drop bytes the API would have happily accepted — a hard-to-spot
 * truncation that was capping every per-prompt diff at 100KB across nine
 * call sites before this constant existed.
 *
 * Bumping requires a coordinated update on the API side first; bumping
 * down here is safe (API just stores less).
 */
export const MAX_PROMPT_DIFF_LEN = 200_000;

// ─── Main Function ─────────────────────────────────────────────────────────

/**
 * Capture real git state at session end:
 * - Current HEAD SHA
 * - New commits created since headBefore
 * - Full unified diff (committed + uncommitted changes)
 */
/**
 * Context ladder for `fullContext` captures.
 *
 * `--unified=2000` renders whole files so AI Blame can attribute every line
 * without "N lines hidden" gaps. That costs ~25x the bytes of a normal diff,
 * so a session that touches a few dozen files blows MAX_DIFF_SIZE and used to
 * be stored as a raw byte `slice()` — cut mid-hunk, malformed, and silently
 * missing every file past the cut.
 *
 * Fidelity is now negotiated instead of assumed: try full context, and only if
 * the result would not fit, re-run with less. Reducing context drops SURROUNDING
 * lines, never CHANGED ones, so line counts and file coverage stay exact — the
 * degradation is confined to how much of the file blame can render.
 *
 * Small sessions (the overwhelming majority) still get full context and are
 * unaffected; only the captures that would have been corrupted pay anything.
 */
const CONTEXT_LADDER = [2000, 25, 3] as const;

/**
 * Run a git diff at the best context that fits the byte budget.
 * `pre`/`post` bracket where the --unified flag belongs in the argv.
 */
export interface LineTotals { added: number; removed: number }

/**
 * Line totals from `git … --numstat`, summed over the files the diff layer
 * would keep (stripIgnoredSectionsFromDiff drops lock files, dist, Origin's
 * own bookkeeping — numstat skips the same paths so the two agree).
 *
 * The diff TEXT is capped (MAX_DIFF_SIZE, and 200KB again on the server), and
 * counting `+`/`-` lines of a capped diff under-reports exactly on the
 * sessions that matter: commit 7f310b6b (683KB) read +1561/-892 for git's
 * +1959/-1249, and the session header read +1612/-927 for a 146-file range.
 * numstat is one line per file whatever the change size, so it never has to
 * be capped. Returns null when git fails, so a caller can fall back to the
 * text count rather than report 0.
 *
 * `args` is the full argument list after `git`, already carrying `--numstat`.
 */
export function numstatTotals(
  args: string[],
  gitOpts: Parameters<typeof git>[1],
  customPatterns?: string[],
): LineTotals | null {
  const rows = numstatByFile(args, gitOpts, customPatterns);
  return rows ? sumLineTotals(rows) : null;
}

export interface FileLineTotals extends LineTotals { file: string }

/** One numstat row per kept file (ignored paths dropped); null when git fails. */
export function numstatByFile(
  args: string[],
  gitOpts: Parameters<typeof git>[1],
  customPatterns?: string[],
): FileLineTotals[] | null {
  let out: string;
  try {
    out = git(args, gitOpts);
  } catch {
    return null;
  }
  const rows: FileLineTotals[] = [];
  for (const ln of out.split('\n')) {
    const parts = ln.split('\t');
    if (parts.length < 3) continue;
    // Renames print as "old => new" or "{a => b}/x"; the new path decides.
    const file = parts.slice(2).join('\t').replace(/^.*=> /, '').replace(/[{}]/g, '');
    if (shouldIgnoreFile(file, customPatterns)) continue;
    const a = Number(parts[0]);
    const r = Number(parts[1]);
    rows.push({ file, added: Number.isFinite(a) ? a : 0, removed: Number.isFinite(r) ? r : 0 });
  }
  return rows;
}

/**
 * A commit's own line totals, as git counts them (`git show --stat`).
 *
 * A MERGE needs its own path. Bare `diff-tree` prints nothing for a commit
 * with two parents, and "nothing" parsed as zero rows — so the merge's Commit
 * row stored +0/-0 under a diff that showed its resolution, and the session
 * accumulator's per-commit fallback added zero. `--cc --numstat` is no
 * better: its counts fall back to the first-parent view, which is the whole
 * absorbed branch (the overshoot #1488 removed from the header). What a merge
 * authored is its resolution — the files that differ from EVERY parent,
 * counted against the first — the definition `mergeOwnDiff` uses for its
 * content. `--cc --name-only` lists exactly those files; the count is then a
 * plain numstat over them. Only a commit whose bare numstat is silent pays
 * the two extra spawns.
 */
export function commitLineCounts(repoPath: string, sha: string): LineTotals | null {
  const gitOpts = { cwd: repoPath, timeoutMs: 15_000, maxBuffer: 16 * 1024 * 1024 };
  const rows = numstatByFile(['diff-tree', '--no-commit-id', '--numstat', '-r', '--root', sha], gitOpts);
  if (!rows) return null;
  if (rows.length > 0) return sumLineTotals(rows);
  // Silent: a merge, or a commit that changed nothing. Ask which.
  let resolved: string[];
  try {
    resolved = git(['diff-tree', '--no-commit-id', '-r', '--cc', '--name-only', sha], gitOpts)
      .split('\n').map((l) => l.trim()).filter(Boolean);
  } catch {
    return null;
  }
  if (resolved.length === 0) return { added: 0, removed: 0 };
  const resolution = numstatByFile(['diff', '--numstat', `${sha}^1`, sha, '--', ...resolved], gitOpts);
  return resolution ? sumLineTotals(resolution) : null;
}

function sumLineTotals(rows: LineTotals[]): LineTotals {
  const totals = { added: 0, removed: 0 };
  for (const r of rows) {
    totals.added += r.added;
    totals.removed += r.removed;
  }
  return totals;
}

/** Every line of an untracked file is an addition; binary files count 0. */
function untrackedLineTotals(repoPath: string, files: string[], customPatterns?: string[]): LineTotals {
  const totals = { added: 0, removed: 0 };
  for (const file of files) {
    if (shouldIgnoreFile(file, customPatterns)) continue;
    try {
      const buf = fs.readFileSync(path.join(repoPath, file));
      if (buf.includes(0)) continue;
      const text = buf.toString('utf-8');
      if (!text) continue;
      totals.added += text.split('\n').length - (text.endsWith('\n') ? 1 : 0);
    } catch { /* unreadable — leave it out */ }
  }
  return totals;
}

function diffWithinBudget(
  pre: string[],
  post: string[],
  gitOpts: Parameters<typeof git>[1],
  fullContext: boolean,
): string {
  if (!fullContext) return trimDiffText(git([...pre, ...post], gitOpts));
  let out = '';
  for (const u of CONTEXT_LADDER) {
    out = trimDiffText(git([...pre, `--unified=${u}`, ...post], gitOpts));
    if (out.length <= MAX_DIFF_SIZE) return out;
  }
  return out;
}

/**
 * Drop whole `diff --git` sections until the text fits, instead of slicing
 * bytes mid-hunk. A short-but-valid diff can be parsed; a byte-cut one
 * mis-parses and poisons every downstream surface.
 *
 * Returns '' when not even one section fits — matching the commit-patch path's
 * existing rule that no patch beats a malformed one.
 */
function truncateToWholeSections(diffText: string, max: number): string {
  if (diffText.length <= max) return diffText;
  const kept: string[] = [];
  let size = 0;
  for (const part of diffText.split(/^(?=diff --git )/m)) {
    if (!part.trim()) continue;
    if (size + part.length > max) break;
    kept.push(part);
    size += part.length;
  }
  return trimDiffText(kept.join(''));
}

/** Tracked + untracked paths that differ from HEAD. */
function filesDirtyVsHead(gitOpts: Parameters<typeof git>[1]): Set<string> {
  const names = new Set<string>();
  try {
    const t = git(['diff', '--name-only', 'HEAD'], gitOpts).trim();
    for (const f of t.split('\n').filter(Boolean)) names.add(f);
  } catch { /* shallow / missing HEAD */ }
  try {
    const u = git(['ls-files', '--others', '--exclude-standard'], gitOpts).trim();
    for (const f of u.split('\n').filter(Boolean)) names.add(f);
  } catch { /* ls-files failed */ }
  return names;
}

/** Keep `diff --git` sections whose path is in `allow`. */
function keepDiffPaths(diff: string, allow: Set<string>): string {
  if (!diff || allow.size === 0) return '';
  const kept: string[] = [];
  for (const part of diff.split(/(?=^diff --git )/m)) {
    if (!part.trim()) continue;
    const match = part.match(/^diff --git a\/(.*?) b\//);
    if (match && match[1] && !allow.has(match[1])) continue;
    kept.push(part);
  }
  return kept.join('').trim();
}

/** What the server needs to build a Commit row for one sha, in the wire shape post-commit sends. */
export interface CommitDetailWire {
  sha: string;
  message?: string;
  author?: string;
  filesChanged?: string[];
  linesAdded?: number;
  linesRemoved?: number;
  patch?: string;
  committedAt?: string | number;
}

const gitShowOpts = (repoPath: string) => ({ cwd: repoPath, timeoutMs: 15_000, maxBuffer: 10 * 1024 * 1024 });

/**
 * One commit's unified patch (`git show`), or undefined when empty, oversize,
 * a merge, or the object is missing. Used to fill a Commit row that landed
 * files-only because post-commit's PATCH died before the network call
 * (session e24477e2: local `commitTurns` via post-commit, dashboard pill
 * "5 files" with no hunks).
 *
 * Standard context, not `--unified=2000`: the Commit row needs git's own
 * hunks, and the full-file walk is what made Stop miss the PATCH entirely.
 * Merges are skipped: `git show <merge>` emits an unparseable `--cc` diff and
 * the first-parent view is the whole absorbed branch; post-commit owns those
 * through mergeOwnDiff. Trailing newlines only are stripped — a `.trim()`
 * would eat a trailing blank context line and mis-anchor the last hunk.
 */
export function patchForCommitSha(repoPath: string, sha: string): string | undefined {
  if (!sha || !HEX.test(sha)) return undefined;
  try {
    const parents = git(['rev-list', '--parents', '-n', '1', sha], gitShowOpts(repoPath)).trim().split(/\s+/);
    if (parents.length > 2) return undefined;
    const raw = git(['show', '--format=', sha], gitShowOpts(repoPath));
    const patch = stripIgnoredSectionsFromDiff(raw).replace(/\n+$/, '');
    if (!patch.trim() || patch.length > MAX_DIFF_SIZE) return undefined;
    return patch;
  } catch {
    return undefined;
  }
}

/**
 * Subject, author, date, files and numstat for one sha — so a rescued Commit
 * row is a real row. The server keeps a finite line count as the truth and
 * never re-counts a row that has a patch, so sending 0/0 here would freeze
 * the pill at +0/−0; absent fields let it count from the patch instead.
 */
export function commitMetaForSha(repoPath: string, sha: string): Omit<CommitDetailWire, 'sha' | 'patch'> | null {
  if (!sha || !HEX.test(sha)) return null;
  try {
    const head = git(['show', '--no-patch', '--format=%s%x1f%an%x1f%cI', sha], gitShowOpts(repoPath))
      .replace(/\n+$/, '').split('\x1f');
    const numstat = git(['show', '--numstat', '--format=', sha], gitShowOpts(repoPath));
    const filesChanged: string[] = [];
    let linesAdded = 0;
    let linesRemoved = 0;
    for (const line of numstat.split('\n')) {
      const m = line.match(/^(\d+|-)\t(\d+|-)\t(.+)$/);
      if (!m) continue;
      filesChanged.push(m[3]);
      if (m[1] !== '-') linesAdded += Number(m[1]);
      if (m[2] !== '-') linesRemoved += Number(m[2]);
    }
    return {
      message: head[0] || '',
      author: head[1] || '',
      committedAt: head[2] || undefined,
      filesChanged,
      linesAdded,
      linesRemoved,
    };
  } catch {
    return null;
  }
}

/** Two shas name the same commit when one abbreviates the other. */
export function sameSha(a: string, b: string): boolean {
  const x = (a || '').toLowerCase();
  const y = (b || '').toLowerCase();
  return !!x && !!y && (x.startsWith(y) || y.startsWith(x));
}

/**
 * Ensure every commitDetails entry carries a patch, and add any attested
 * shas the range walk missed as full rows (subject, author, date, numstat,
 * patch). Mutates nothing; returns a new array. A sha that yields no patch
 * (merge, missing object, oversize) is left out.
 */
export function fillMissingCommitPatches(
  repoPath: string,
  details: CommitDetailWire[],
  extraShas: string[] = [],
): CommitDetailWire[] {
  const out: CommitDetailWire[] = details.map((d) => {
    if ((d.patch || '').trim()) return d;
    const patch = patchForCommitSha(repoPath, d.sha);
    return patch ? { ...d, patch } : d;
  });
  for (const sha of extraShas) {
    if (!sha || !HEX.test(sha) || out.some((d) => sameSha(d.sha, sha))) continue;
    const patch = patchForCommitSha(repoPath, sha);
    if (!patch) continue;
    const meta = commitMetaForSha(repoPath, sha);
    out.push({ sha, patch, ...(meta || {}) });
  }
  return out;
}

export function captureGitState(
  repoPath: string,
  headBefore: string | null,
  opts?: {
    committedOnly?: boolean;
    // When true, run git diff with `--unified=99999` so the produced diff
    // contains the entire file as context — gives AI Blame the full file
    // to render with line-level attribution instead of "N lines hidden"
    // gaps between hunks. Bigger payload (capped by MAX_DIFF_SIZE), so
    // callers should only opt in for session-level snapshots, not the
    // per-prompt deltas that fire on every heartbeat.
    fullContext?: boolean;
    /**
     * The tree to measure a commit's INHERITED work against, when that is not
     * `headBefore`.
     *
     * The pre-session split (#1387) asks what a commit swept up that was
     * already dirty when the session began, so it has to be measured against a
     * tree that HELD that dirt — a baseline shadow commit. The hook path passes
     * exactly that as `headBefore`, so it needed no second argument. The Codex
     * watcher does not: it passes the session's HEAD sha, and a commit sitting
     * directly on that HEAD measures its own parent against itself, which is
     * empty by construction. Every Codex session therefore recorded +0/-0 —
     * "this session started clean" — no matter how dirty the tree was.
     *
     * kotleta f20f04c5 measured 0/0 from `369f4a82` (the session's HEAD) and
     * +83/-15 from `d8de1d6c` (its first prompt's shadow), against a commit
     * whose total exceeded the session's own work by exactly that.
     *
     * Only ever narrows what is measured; when absent, behaviour is unchanged.
     */
    preSessionBaseline?: string | null;
  },
): GitCaptureResult {
  const gitOpts = {
    cwd: repoPath,
    timeoutMs: 15_000,
    maxBuffer: 10 * 1024 * 1024, // 10MB buffer for large diffs
  };
  // Bounded "large context" instead of unlimited. 2000 lines covers a
  // typical full source file but caps the worst case so a giant generated
  // file (lock file, fixture, build artifact) doesn't blow up
  // MAX_DIFF_SIZE and truncate mid-hunk into a malformed diff that the
  // UI parser then chokes on. AI Blame still gets full-file rendering
  // for all reasonable source files.
  const wantFullContext = !!opts?.fullContext;

  // 1. Get current HEAD
  const headAfter = gitOrNull(['rev-parse', 'HEAD'], gitOpts);
  if (!headAfter || !HEX.test(headAfter)) {
    return emptyResult(headBefore || '');
  }

  const safeBefore = headBefore && HEX.test(headBefore) ? headBefore : headAfter;

  // 2. Find commits created during session (between headBefore and headAfter)
  let commitShas: string[] = [];
  if (safeBefore !== headAfter) {
    try {
      // `--reverse` → OLDEST-first (chronological). git log defaults to
      // newest-first, but the server's commit→prompt back-attribution
      // (mcp.ts: "insertion order ... mirrors committedAt") assumes the SHAs
      // arrive oldest-first and walks them in reverse to land the latest commit
      // on the latest turn. Sending newest-first double-reverses that, swapping
      // which commit attaches to which prompt whenever a single capture carries
      // more than one commit (e.g. Copilot's agentStop covering two committed
      // turns: "add 5"→"Add 6", "add 6"→"Add 5"). The server can't re-sort — it
      // stamps committedAt=now() and has no real per-commit time — so the
      // chronological order must come from here.
      const log = git(
        ['log', '--reverse', '--format=%H', `${safeBefore}..${headAfter}`],
        gitOpts,
      ).trim();
      commitShas = log ? log.split('\n').filter(Boolean) : [];
    } catch {
      // If headBefore is no longer reachable (e.g. rebase), just record headAfter
      commitShas = [headAfter];
    }
  }

  // 3. Capture per-commit metadata (message, author, files changed)
  const commitDetails: CommitInfo[] = [];
  for (const sha of commitShas) {
    if (!HEX.test(sha)) continue;
    try {
      // %B — subject AND body. `%s` was the subject alone, which threw away the
      // `Origin-Session:` trailer our own prepare-commit-msg hook had just
      // written into the body. See capCommitMessage for what that cost.
      const message = capCommitMessage(git(['log', '-1', '--format=%B', sha], gitOpts));
      const author = git(['log', '-1', '--format=%an', sha], gitOpts).trim();
      // Committer time in epoch SECONDS (%ct) → ms. Used to scope commits to the
      // authoring thread (see CommitInfo.committedAt / codex-watch).
      let committedAt: number | undefined;
      try {
        const ct = Number(git(['log', '-1', '--format=%ct', sha], gitOpts).trim());
        if (Number.isFinite(ct) && ct > 0) committedAt = ct * 1000;
      } catch { /* leave undefined — scoping falls back to keeping the commit */ }
      const filesRaw = git(
        ['diff-tree', '--no-commit-id', '--name-only', '-r', sha],
        gitOpts,
      ).trim();
      // Don't filter filesChanged through shouldIgnoreFile — this list is the
      // commit's metadata answer to "which files did this commit touch" and
      // drives Commit.fileCount on the dashboard. Hiding lock files / dist /
      // generated entries here makes the UI report fewer files than git
      // actually shows. Diff-content filtering still happens at the patch
      // layer (stripIgnoredSectionsFromDiff), which is the right place to
      // hide bookkeeping changes without lying about file counts.
      const filesChanged = filesRaw ? filesRaw.split('\n').filter(Boolean) : [];
      // Per-commit line counts from --numstat ("added<TAB>removed<TAB>path"
      // per file; binary files report "-"). Summed across files.
      let cAdded = 0;
      let cRemoved = 0;
      try {
        const numstat = git(
          ['diff-tree', '--no-commit-id', '--numstat', '-r', sha],
          gitOpts,
        ).trim();
        for (const ln of numstat.split('\n')) {
          const parts = ln.split('\t');
          if (parts.length < 2) continue;
          const a = Number(parts[0]);
          const r = Number(parts[1]);
          if (Number.isFinite(a)) cAdded += a;
          if (Number.isFinite(r)) cRemoved += r;
        }
      } catch { /* numstat failed (e.g. root commit edge) — leave 0 */ }
      // How much of this commit was ALREADY in the working tree when the
      // session started.
      //
      // `git commit -a` sweeps up whatever is dirty, including work a PREVIOUS
      // session left uncommitted, and the commit's own total then describes two
      // sessions at once. Session 38bcb56c committed +223/-16 while authoring
      // +97/-20; the other +144/-14 was the previous Codex session's last turn,
      // never committed, sitting in the tree when this one opened. The page had
      // no way to say so — the read side can compare a turn against the commit,
      // but only the CLI can see what the tree held before either.
      //
      // Measured against the SESSION BASELINE (a shadow commit when the tree
      // started dirty, which is exactly when this happens): the part of the
      // commit's own files that had already changed between its parent and that
      // baseline. Proven, never inferred — computed ONLY when the commit sits
      // directly on pre-session history (its parent is an ancestor of the
      // baseline). A later commit in the same session has a parent the baseline
      // never saw, and diffing across that pair reports reversals as though
      // they were inherited, so those report nothing at all.
      let preAdded: number | null = null;
      let preRemoved: number | null = null;
      // The pathspec is the commit's file list; a commit touching hundreds of
      // files would build a command line Windows rejects outright, and a
      // silently truncated pathspec would UNDER-report the inherited part —
      // the direction that makes a session look like it wrote more than it did.
      const pathspecBytes = filesChanged.reduce((n, f) => n + f.length + 1, 0);
      // The baseline is the tree the session STARTED from, which is only
      // `safeBefore` when the caller had nothing better. A caller holding a
      // shadow of the dirty tree passes it; measuring against a bare HEAD sha
      // can only ever answer "clean", because a commit on that HEAD has it as
      // its own parent. See opts.preSessionBaseline.
      const preBase = opts?.preSessionBaseline && HEX.test(opts.preSessionBaseline)
        ? opts.preSessionBaseline
        : safeBefore;
      if (preBase !== headAfter && filesChanged.length > 0 && pathspecBytes <= 8000) {
        try {
          const parent = gitOrNull(['rev-parse', `${sha}^`], gitOpts);
          if (parent && HEX.test(parent)
            && gitDetailed(['merge-base', '--is-ancestor', parent, preBase], gitOpts).status === 0) {
            const pre = git(
              ['diff', '--numstat', parent, preBase, '--', ...filesChanged],
              gitOpts,
            ).trim();
            let pa = 0;
            let pr = 0;
            for (const ln of pre.split('\n')) {
              const parts = ln.split('\t');
              if (parts.length < 2) continue;
              const a = Number(parts[0]);
              const r = Number(parts[1]);
              if (Number.isFinite(a)) pa += a;
              if (Number.isFinite(r)) pr += r;
            }
            // A clean start legitimately measures zero, and that is worth
            // saying — "nothing was inherited" is an answer, not a gap.
            preAdded = pa;
            preRemoved = pr;
          }
        } catch { /* unprovable — report nothing rather than a guess */ }
      }
      // Per-commit unified patch — git truth for the committed lines, so the
      // API doesn't have to reconstruct them. `git show --format=` prints only
      // the diff (no commit header); `-m --first-parent` gives a merge commit a
      // real patch too. Strip ignored sections and cap so a huge commit can't
      // blow the payload; drop it entirely past the cap (better no patch than a
      // truncated, malformed one that mis-parses in blame).
      let patch = '';
      try {
        const raw = diffWithinBudget(['show', '--format=', '-m', '--first-parent'], [sha], gitOpts, wantFullContext);
        patch = stripIgnoredSectionsFromDiff(raw);
        if (patch.length > MAX_DIFF_SIZE) patch = '';
      } catch { /* show failed — leave patch empty, API falls back */ }
      commitDetails.push({
        sha, message, author, filesChanged, linesAdded: cAdded, linesRemoved: cRemoved,
        ...(patch && { patch }),
        ...(committedAt != null && { committedAt }),
        ...(preAdded != null && preRemoved != null
          && { preSessionLinesAdded: preAdded, preSessionLinesRemoved: preRemoved }),
      });
    } catch {
      // If we can't get details for a commit, include it with minimal info
      commitDetails.push({ sha, message: '', author: '', filesChanged: [], linesAdded: 0, linesRemoved: 0 });
    }
  }

  // 3b. Decide what the baseline IS before any diff is built from it.
  let baselineIsShadow = false;
  // The baseline is on a DIFFERENT line of history than HEAD — the agent ran
  // `git checkout`/`reset` onto another branch mid-turn.
  let baselineDiverged = false;
  if (safeBefore && safeBefore !== headAfter) {
    try {
      // Is baseline an ancestor of HEAD?
      const ancestorRes = gitDetailed(['merge-base', '--is-ancestor', safeBefore, headAfter], gitOpts);
      if (ancestorRes.status !== 0) {
        // NOT an ancestor. This was read as "therefore a shadow commit", and
        // that is only one of the two ways it happens:
        //
        //   1. a real shadow — `createShadowCommit` builds a dangling
        //      commit-tree over the working tree, which is on no branch and so
        //      can never be an ancestor of HEAD. Diffing base tree → cur tree
        //      is exactly right for it.
        //   2. HEAD MOVED. `git checkout <other-branch>` leaves the baseline a
        //      perfectly real commit that simply sits on another line. Any diff
        //      taken from it then reports THE ENTIRE BRANCH DELTA as the turn's
        //      authored work.
        //
        // Case 2 is what session a6ad8379 hit. Turn 6 read three files and
        // merged a PR — it authored nothing — and was credited +229/-9 across
        // 3 files, which is byte-for-byte another agent's commit that a
        // `git checkout` had brought into the tree. Turn 5 showed -443 against
        // commits totalling -22. `verify-capture` reported ZERO contradictions
        // for the session, because the row's counts agree with its diff: the
        // diff itself is what is wrong, which no self-consistency check can see.
        //
        // The discriminator is authorship, not reachability: every shadow this
        // module writes is stamped with a fixed internal identity, and nothing
        // else in a repo carries it. That is one cheap subprocess, where
        // "is this commit on any ref" is O(refs) on a hook path.
        const baseAuthor = gitOrNull(['log', '-1', '--format=%ae', safeBefore], gitOpts);
        baselineIsShadow = baseAuthor === SHADOW_IDENTITY_EMAIL;
        if (baselineIsShadow) {
          // A shadow is only meaningful while the real commit it snapshots is
          // still on HEAD's history. A branch switch after a dirty turn leaves
          // a perfectly valid Origin shadow whose *parent* is on the abandoned
          // branch. Comparing that shadow tree to the new branch turns every
          // earlier PR difference into this prompt's diff.
          const shadowParent = gitOrNull(['rev-parse', `${safeBefore}^`], gitOpts);
          const parentStillOnHead = !!shadowParent
            && gitDetailed(['merge-base', '--is-ancestor', shadowParent, headAfter], gitOpts).status === 0;
          if (!parentStillOnHead) baselineIsShadow = false;
        }
        baselineDiverged = !baselineIsShadow;
      }
    } catch {
      baselineIsShadow = false;
      baselineDiverged = false;
    }
  }
  // A divergent range cannot identify commits authored by this turn: git log
  // A..B lists every commit on B's branch that A never contained. Commit hooks
  // carry real authorship; returning this speculative range lets Stop attach a
  // whole branch's files to the current prompt.
  if (baselineDiverged) {
    commitShas = [];
    commitDetails.length = 0;
  }
  // A diverged baseline cannot answer "what did this turn write": the branch it
  // names is not the branch in the tree, so ANY range or diff taken from it
  // hands back the whole divergence. Compare against HEAD instead — genuinely
  // uncommitted edits are kept, and the branch delta is not this turn's work.
  // Commits the turn actually made are captured by the commit path, not here.
  //
  // This has to govern `committedDiff` as much as `workingTreeDiff`. The first
  // cut of this fix re-based only the latter, and Stop does not read the
  // latter unless the baseline is a shadow — it reads
  // `committedDiff + uncommittedDiff`, and `committedDiff` was still
  // `<baseline>..HEAD`, i.e. the other branch's commits. The unit test was
  // green on the field the consumer never looked at.
  const workingTreeBase = baselineDiverged ? headAfter : safeBefore;

  // 4. Build diffs: committedDiff (sha..sha), uncommittedDiff (working tree),
  //    diff (combined for backwards compat)
  let committedDiff = '';
  let uncommittedDiff = '';
  let diffTruncated = false;
  // numstat beside each diff, so the counts survive the text cap.
  let committedStat: LineTotals | null = null;
  let uncommittedStat: LineTotals | null = null;
  let workingTreeStat: LineTotals | null = null;

  try {
    // Committed changes since session start. From `workingTreeBase`, not the
    // raw baseline: on a diverged baseline that range is the OTHER branch's
    // commits, and this is the field Stop reads for a non-shadow baseline.
    if (workingTreeBase !== headAfter) {
      committedDiff = diffWithinBudget(['diff'], [`${workingTreeBase}..${headAfter}`], gitOpts, wantFullContext);
      committedStat = numstatTotals(['diff', '--numstat', `${workingTreeBase}..${headAfter}`], gitOpts);
    }

    // Capture uncommitted changes (staged + unstaged + untracked)
    if (!opts?.committedOnly) {
      uncommittedDiff = diffWithinBudget(['diff'], ['HEAD'], gitOpts, wantFullContext);
      uncommittedStat = numstatTotals(['diff', '--numstat', 'HEAD'], gitOpts);
      // Also capture new untracked files as diff
      try {
        const untracked = git(
          ['ls-files', '--others', '--exclude-standard'],
          gitOpts,
        ).trim();
        if (untracked) {
          if (uncommittedStat) {
            const u = untrackedLineTotals(repoPath, untracked.split('\n').filter(Boolean));
            uncommittedStat = { added: uncommittedStat.added + u.added, removed: uncommittedStat.removed + u.removed };
          }
          for (const file of untracked.split('\n').filter(Boolean)) {
            // git diff --no-index exits 1 on diff; use gitDetailed to capture
            // stdout regardless of status. Pass the file path as a positional
            // arg — no shell, no quoting required.
            const r = gitDetailed(['diff', '--no-index', '/dev/null', file], gitOpts);
            const out = (r.stdout || '').trim();
            if (out) {
              uncommittedDiff = uncommittedDiff ? uncommittedDiff + '\n' + out : out;
            }
          }
        }
      } catch {
        // ls-files failed — skip untracked
      }
    }

    // Enforce size limits
    if (committedDiff.length > MAX_DIFF_SIZE) {
      committedDiff = truncateToWholeSections(committedDiff, MAX_DIFF_SIZE);
      diffTruncated = true;
    }
    if (uncommittedDiff.length > MAX_DIFF_SIZE) {
      uncommittedDiff = truncateToWholeSections(uncommittedDiff, MAX_DIFF_SIZE);
      diffTruncated = true;
    }
  } catch {
    // git diff can fail on shallow clones, detached HEAD issues, etc.
  }

  // Combined `diff` is filled AFTER ignore-stripping — concatenating here
  // stored two sections for a file that was committed and then edited further
  // (acd825ed). The working-tree view is the applyable patch.

  // Single "working tree vs baseline" diff — clean even when baseline is
  // a shadow commit not in HEAD's ancestry. Use this in callers that
  // store the diff per-prompt for AI blame.
  let workingTreeDiff = '';
  // `baselineIsShadow`, `baselineDiverged` and `workingTreeBase` are decided
  // above step 4, because `committedDiff` needs them too — see there.
  try {
    if (safeBefore && baselineIsShadow) {
      // SHADOW baseline (a session-start / per-prompt working-tree snapshot):
      // use a TREE-TO-TREE diff so PRE-EXISTING UNTRACKED files a prior session
      // left in the tree (already captured in the shadow) CANCEL OUT. Plain
      // `git diff <shadow>` would instead show them as spurious DELETIONS — the
      // shadow tracks them, but the real index doesn't — and the untracked
      // re-append would double them. Mirrors captureAgyDiff (writeWorkingTree +
      // baseTree..curTree), the mechanism that already handles this for agy.
      const baseTree = gitOrNull(['rev-parse', `${safeBefore}^{tree}`], gitOpts);
      const curTree = writeWorkingTree(repoPath, gitOpts);
      if (baseTree && HEX.test(baseTree) && curTree && HEX.test(curTree)) {
        workingTreeDiff = diffWithinBudget(['diff'], [baseTree, curTree], gitOpts, wantFullContext);
        workingTreeStat = numstatTotals(['diff', '--numstat', baseTree, curTree], gitOpts);
      }
    } else if (workingTreeBase) {
      // Real-commit baseline (clean start): `git diff <commit>` compares working
      // tree to the commit's tree (staged + unstaged); untracked appended below.
      // `workingTreeBase` is HEAD rather than the recorded baseline when the two
      // are on different branches — see the divergence note above.
      workingTreeDiff = diffWithinBudget(['diff'], [workingTreeBase], gitOpts, wantFullContext);
      if (!opts?.committedOnly) {
        try {
          const untracked = git(['ls-files', '--others', '--exclude-standard'], gitOpts).trim();
          if (untracked) {
            for (const file of untracked.split('\n').filter(Boolean)) {
              const r = gitDetailed(['diff', '--no-index', '/dev/null', file], gitOpts);
              const out = (r.stdout || '').trim();
              if (out) workingTreeDiff = workingTreeDiff ? workingTreeDiff + '\n' + out : out;
            }
          }
        } catch { /* skip */ }
      }
    }
    if (workingTreeDiff.length > MAX_DIFF_SIZE) {
      workingTreeDiff = truncateToWholeSections(workingTreeDiff, MAX_DIFF_SIZE);
      diffTruncated = true;
    }
  } catch {
    workingTreeDiff = '';
  }

  // Strip diff sections targeting ignored files (lock files, generated
  // dirs, Origin's own AGENTS.md / GEMINI.md / .windsurfrules). These
  // contribute noise to the per-prompt blame view — AGENTS.md alone shows
  // up as 13+ "AI-attributed" lines on every Codex turn because Origin
  // rewrites it as bookkeeping, not agent output.
  committedDiff = stripIgnoredSectionsFromDiff(committedDiff);
  uncommittedDiff = stripIgnoredSectionsFromDiff(uncommittedDiff);
  workingTreeDiff = stripIgnoredSectionsFromDiff(workingTreeDiff);

  // When the baseline is a session-start (or per-prompt) working-tree SHADOW,
  // the honest UNCOMMITTED half is the change since that shadow among files
  // that are still dirty vs HEAD — not `git diff HEAD`, which re-surfaces
  // files a PRIOR turn left in the tree.
  //
  // Two producers hit the same lie:
  //   • d0a25d8d — a read-only prompt captured +149 of pre-existing untracked
  //     because they were dirty vs HEAD and the shadow never rewrote the field.
  //   • 06a44883 prompt 3 — stash, `git checkout -b` from a newer main, restore.
  //     `git log shadow..HEAD` listed the checked-out history, so the old
  //     `commitShas.length === 0` gate refused to rewrite, and `git diff HEAD`
  //     stored the previous turn's whole patch as this turn's uncommitted work.
  //
  // Diffing the dirty paths against the shadow cancels content that has not
  // moved since the turn started (the restored stash) and keeps a real edit
  // (a version bump, a line this turn actually typed). Gating on "no SHAs
  // in shadow..HEAD" is wrong once HEAD has moved. Applies to every agent
  // that anchors on a shadow via captureGitState; Antigravity has its own
  // tree-to-tree captureAgyDiff.
  if (baselineIsShadow && !opts?.committedOnly) {
    // Intersect the shadow→worktree view with files that are still dirty vs
    // HEAD. Tree-to-tree already cancels blobs that have not moved since the
    // shadow (the restored stash). Files that match HEAD (the checked-out
    // line's own commits) are not dirty and drop out. What remains is this
    // turn's uncommitted work.
    //
    // Scope note: this narrows `uncommittedDiff` ONLY. #1556 made
    // `workingTreeDiff` the single source of both the shadow-baseline `diff`
    // and its line counts, so narrowing that here reaches far past this bug —
    // it silently re-cut the worktree-bootstrap header (+5 against +1 of work)
    // and dropped commits the post-commit hook had stamped. The field this
    // defect is about is the uncommitted half, and that is the field it fixes.
    const dirty = filesDirtyVsHead(gitOpts);
    uncommittedDiff = keepDiffPaths(workingTreeDiff, dirty);
    uncommittedStat = null;
  }

  // Combined `diff` is one applyable patch. Concatenating committedDiff +
  // uncommittedDiff stored two `diff --git` sections for a file that was
  // committed and then edited further (acd825ed). workingTreeDiff is the
  // net vs the baseline. `committedOnly` keeps the committed range alone —
  // that flag exists so a caller asking for commits does not pick up dirt.
  let diff = '';
  if (opts?.committedOnly) {
    diff = committedDiff;
  } else if (baselineIsShadow) {
    // committedDiff against a shadow is reverse-direction text (files the
    // shadow staged that HEAD does not track show up as deletions). The
    // tree-to-tree working view is the applyable patch — including empty,
    // which is a read-only turn over pre-existing untracked files.
    diff = workingTreeDiff;
  } else if (workingTreeDiff.trim()) {
    diff = combineApplyableTurnDiff({
      committedDiff,
      uncommittedDiff,
      workingTreeDiff,
    });
  } else {
    diff = combineApplyableTurnDiff({ committedDiff, uncommittedDiff });
  }

  // Count lines added/removed — from numstat where it ran, from the diff
  // text only as a fallback: the text is capped, numstat is not.
  const countText = (d: string): LineTotals => {
    const t = { added: 0, removed: 0 };
    for (const line of d.split('\n')) {
      if (line.startsWith('+') && !line.startsWith('+++')) t.added++;
      if (line.startsWith('-') && !line.startsWith('---')) t.removed++;
    }
    return t;
  };
  let linesAdded = 0;
  let linesRemoved = 0;
  // Combined view counts: workingTreeDiff is the net, so summing committed +
  // uncommitted double-counts a file present in both. Shadow committedDiff
  // is reverse-direction text and must never be counted.
  const countSrc: Array<[string, LineTotals | null]> =
    opts?.committedOnly
      ? [[committedDiff, committedStat]]
      : (baselineIsShadow || workingTreeDiff)
        ? [[workingTreeDiff, workingTreeStat]]
        : [[committedDiff, committedStat], [uncommittedDiff, uncommittedStat]];
  for (const [d, stat] of countSrc) {
    if (!d && !stat) continue;
    const t = stat ?? countText(d);
    linesAdded += t.added;
    linesRemoved += t.removed;
  }

  return {
    headBefore: safeBefore,
    headAfter,
    commitShas,
    commitDetails,
    diff,
    committedDiff,
    uncommittedDiff,
    diffTruncated,
    linesAdded,
    linesRemoved,
    workingTreeDiff,
    baselineIsShadow,
  };
}

/**
 * Get list of files with uncommitted changes (staged + unstaged).
 * Used to snapshot the dirty working tree before a prompt starts.
 */
export function getDirtyFiles(repoPath: string): string[] {
  try {
    const gitOpts = { cwd: repoPath, timeoutMs: 5_000 };
    // Tracked files with changes (staged + unstaged)
    const tracked = git(['diff', '--name-only', 'HEAD'], gitOpts).trim();
    // Untracked files
    const untracked = git(['ls-files', '--others', '--exclude-standard'], gitOpts).trim();
    const files = [
      ...(tracked ? tracked.split('\n').filter(Boolean) : []),
      ...(untracked ? untracked.split('\n').filter(Boolean) : []),
    ];
    return files;
  } catch {
    return [];
  }
}

/**
 * Create a "shadow commit" that captures the current working-tree state
 * (HEAD + staged + unstaged + untracked) as a real commit object.
 *
 * Returns the SHA of the new commit, or null on failure.
 *
 * This is used to anchor `prePromptSha` at a per-prompt baseline so that
 * the diff for the NEXT prompt is computed against "the state at end of
 * the previous prompt" — not against the last real HEAD, which would
 * incorrectly include any uncommitted-then-later-committed work from the
 * previous prompt.
 *
 * The shadow commit is kept alive via `refs/origin/shadow/<tag>` so git
 * GC can't prune it before the next STOP.
 *
 * NOTE: This does NOT modify the user's working tree, branch, or index.
 * It writes to a private temp index file, never to .git/index.
 */
export function createShadowCommit(repoPath: string, tag: string): string | null {
  try {
    const gitOpts = { cwd: repoPath, timeoutMs: 10_000, maxBuffer: 10 * 1024 * 1024 };

    const headSha = gitOrNull(['rev-parse', 'HEAD'], gitOpts);
    if (!headSha || !HEX.test(headSha)) return null;

    // Use a private index file so we don't touch .git/index.
    // The temp index starts as a copy of HEAD's tree.
    // Forward slashes: Git-for-Windows can mishandle a backslash GIT_INDEX_FILE.
    const tmpIndex = tmpIndexPath('origin-shadow');
    // A guaranteed committer identity. `git commit-tree` (step 5) FAILS with
    // "committer identity unknown" when the box has no user.name/user.email
    // configured — the root cause of shadow-commit failure on fresh Windows
    // installs, which then made the session diff fall back to `git diff HEAD`
    // and sweep in every pre-existing dirty file (the "+91 should be +2" bug).
    // These are internal objects, never pushed, so a fixed identity is safe.
    const shadowIdentity = {
      GIT_AUTHOR_NAME: 'Origin', GIT_AUTHOR_EMAIL: SHADOW_IDENTITY_EMAIL,
      GIT_COMMITTER_NAME: 'Origin', GIT_COMMITTER_EMAIL: SHADOW_IDENTITY_EMAIL,
    };
    const indexOpts = { ...gitOpts, env: { ...process.env, ...shadowIdentity, GIT_INDEX_FILE: tmpIndex } };

    try {
      // 1. Seed the temp index with HEAD's tree
      git(['read-tree', 'HEAD'], indexOpts);

      // 2. Stage all changes from the working tree (tracked changes +
      //    deletions) into the temp index.
      try {
        git(['add', '-A', '--', '.'], indexOpts);
      } catch {
        // best-effort: continue even if some paths fail
      }

      // 3. write-tree against the temp index
      const treeSha = git(['write-tree'], indexOpts).trim();
      if (!HEX.test(treeSha)) return null;

      // 4. Skip if the tree is identical to HEAD's (nothing dirty —
      //    caller should normally avoid calling us in that case, but
      //    we double-check so we never create no-op shadow commits)
      const headTree = gitOrNull(['rev-parse', `${headSha}^{tree}`], gitOpts);
      if (headTree === treeSha) return null;

      // 5. commit-tree with HEAD as parent. Pass the fixed identity so this
      //    never fails on a box without user.name/user.email configured.
      const commitRes = gitDetailed(
        ['commit-tree', treeSha, '-p', headSha, '-m', `origin shadow ${tag} ${new Date().toISOString()}`],
        { ...gitOpts, env: { ...process.env, ...shadowIdentity } },
      );
      if (commitRes.status !== 0) return null;
      const shadowSha = (commitRes.stdout || '').trim();
      if (!HEX.test(shadowSha)) return null;

      // 6. Keep it reachable so git GC doesn't prune it before next STOP
      try {
        git(['update-ref', `refs/origin/shadow/${tag}`, shadowSha], gitOpts);
      } catch { /* non-fatal — commit object still exists in objects/, GC won't run immediately */ }

      return shadowSha;
    } finally {
      try { fs.unlinkSync(tmpIndex); } catch { /* ignore */ }
    }
  } catch {
    return null;
  }
}

export interface AgyDiffResult {
  diff: string;            // unified diff of agy's work since the baseline
  filesChanged: string[];  // files agy actually touched (pre-existing dirt excluded)
  linesAdded: number;
  linesRemoved: number;
}

/**
 * Capture ONLY the changes `agy` made since a per-conversation baseline.
 *
 * agy exposes no per-prompt git baseline and no session-start event, so the
 * naive `git diff HEAD` sweeps in everything dirty in the tree — including
 * uncommitted edits and untracked files that existed BEFORE the agy session
 * (the bug behind "the diff is wrong": a stray `test.txt` / unrelated edits
 * showing up as the agent's work).
 *
 * `baselineSha` is a shadow commit (createShadowCommit) — or the session-start
 * HEAD when the tree was clean — snapshotting the pre-existing working tree.
 * Diffing against it means:
 *   - tracked edits that predate the session are in the baseline tree → excluded
 *   - untracked files present at baseline are in the baseline tree → excluded
 *     from the untracked append (the key leak this fixes)
 * Only files that exist now but NOT in the baseline are treated as agy-created.
 */
export function captureAgyDiff(repoPath: string, baselineSha: string | null): AgyDiffResult {
  const gitOpts = { cwd: repoPath, timeoutMs: 15_000, maxBuffer: 10 * 1024 * 1024 };
  const empty: AgyDiffResult = { diff: '', filesChanged: [], linesAdded: 0, linesRemoved: 0 };
  // No baseline → we CANNOT tell the agent's work apart from pre-existing dirt,
  // so return empty rather than falling back to `git diff HEAD` (which dumps the
  // whole dirty tree and mis-attributes pre-existing changes to a read-only
  // turn). A clean-start session records its baseline as the session-start HEAD
  // sha, so the caller still passes a real sha in that case — only the
  // genuinely-unset case lands here.
  if (!baselineSha || !HEX.test(baselineSha)) return empty;
  const base = baselineSha;

  // Resolve the baseline TREE (the shadow's snapshot of the pre-existing tree;
  // a bare HEAD sha resolves to its own tree).
  const baseTree = gitOrNull(['rev-parse', `${base}^{tree}`], gitOpts);
  if (!baseTree || !HEX.test(baseTree)) return empty;

  // Snapshot the CURRENT working tree (tracked + untracked) as a tree object,
  // then diff tree-to-tree. This is the only way to get a clean delta: a plain
  // `git diff <shadow>` compares the index to the shadow tree, so pre-existing
  // untracked files (in the shadow tree, absent from the index) surface as
  // spurious deletions. Tree-to-tree cancels anything identical in both.
  const curTree = writeWorkingTree(repoPath, gitOpts);
  if (!curTree) return empty;

  return diffTreeToTree(baseTree, curTree, gitOpts);
}

/** Tree-to-tree delta shared by the working-tree and shadow-range captures. */
function diffTreeToTree(
  baseTree: string,
  targetTree: string,
  gitOpts: { cwd: string; timeoutMs: number; maxBuffer: number },
  unified = 2000,
): AgyDiffResult {
  let diff = '';
  const files = new Set<string>();
  try {
    diff = trimDiffText(git(['diff', `--unified=${unified}`, baseTree, targetTree], gitOpts));
    const names = git(['diff', '--name-only', baseTree, targetTree], gitOpts).trim();
    if (names) for (const f of names.split('\n').filter(Boolean)) files.add(f);
  } catch { /* best-effort */ }

  diff = stripIgnoredSectionsFromDiff(diff);
  if (diff.length > MAX_DIFF_SIZE) diff = diff.slice(0, MAX_DIFF_SIZE);

  let linesAdded = 0;
  let linesRemoved = 0;
  for (const line of diff.split('\n')) {
    if (line.startsWith('+') && !line.startsWith('+++')) linesAdded++;
    else if (line.startsWith('-') && !line.startsWith('---')) linesRemoved++;
  }
  // Keep only files whose hunks survived stripIgnoredSectionsFromDiff (drops
  // Origin's own AGENTS.md / GEMINI.md bookkeeping from the count too).
  const filesChanged = [...files].filter(f => diff.includes(`b/${f}`));
  return { diff, filesChanged, linesAdded, linesRemoved };
}

/**
 * The delta between two per-prompt shadow baselines — i.e. exactly one
 * COMPLETED turn's work.
 *
 * The per-prompt shadow for prompt N snapshots the tree at the START of prompt
 * N, so `shadow[i] → shadow[i+1]` brackets turn i precisely. The watcher's other
 * capture (captureAgyDiff, baseline → CURRENT tree) can only ever describe the
 * turn still in flight; once a turn is superseded its work is unrecoverable
 * from the working tree alone, which is why stale/empty captures on earlier
 * turns used to be permanent (session 1ffc5f67 needed a manual repair).
 *
 * Returns empty when either shadow is missing or the two resolve to the SAME
 * tree — the latter happens when the watcher discovers several prompts in one
 * poll and stamps them all with the same baseline. Empty means "we genuinely
 * don't know", and callers must leave existing data alone rather than zero it.
 */
export function captureShadowRangeDiff(
  repoPath: string,
  fromSha: string | null,
  toSha: string | null,
): AgyDiffResult {
  const gitOpts = { cwd: repoPath, timeoutMs: 15_000, maxBuffer: 10 * 1024 * 1024 };
  const empty: AgyDiffResult = { diff: '', filesChanged: [], linesAdded: 0, linesRemoved: 0 };
  if (!fromSha || !toSha || !HEX.test(fromSha) || !HEX.test(toSha) || fromSha === toSha) return empty;

  const fromTree = gitOrNull(['rev-parse', `${fromSha}^{tree}`], gitOpts);
  const toTree = gitOrNull(['rev-parse', `${toSha}^{tree}`], gitOpts);
  if (!fromTree || !toTree || !HEX.test(fromTree) || !HEX.test(toTree)) return empty;
  if (fromTree === toTree) return empty;

  return diffTreeToTree(fromTree, toTree, gitOpts);
}

/**
 * Why a per-turn shadow window produced a given answer.
 *
 * `captureShadowRangeDiff` collapses "same sha", "same tree", "git failed"
 * and "not a shadow" into one empty result, and its callers treat empty as
 * unknown — leave the stored capture alone. That is right for the watcher
 * (several prompts stamped with one baseline). It is wrong for a question
 * turn whose two shadows are different objects over the same tree: the
 * window is EMPTY, leftover `HEAD..worktree` dirt is not this turn's work,
 * and leaving the dump would republish it.
 *
 * Callers that must tell those apart use this. `toSha === null` means the
 * current working tree (the turn still in flight).
 *
 * Default hunk context is git's 3, not `--unified=2000`. The 2000-line form
 * is for blame replay; the turn card needs a real hunk header (`@@ -820,6`)
 * so a mid-file insert is not rendered as `@@ -1,6` of a 6-line fragment.
 */
export type ShadowWindowStatus =
  | 'unavailable'
  | 'not-shadow'
  | 'identical-sha'
  | 'empty'
  | 'changed';

export interface ShadowWindowCapture extends AgyDiffResult {
  status: ShadowWindowStatus;
}

const EMPTY_WINDOW: AgyDiffResult = { diff: '', filesChanged: [], linesAdded: 0, linesRemoved: 0 };

export function captureShadowWindow(
  repoPath: string,
  fromSha: string | null,
  toSha: string | null,
  opts?: { unified?: number },
): ShadowWindowCapture {
  const none = (status: ShadowWindowStatus): ShadowWindowCapture => ({ status, ...EMPTY_WINDOW });
  if (!fromSha || !HEX.test(fromSha)) return none('unavailable');
  if (toSha && !HEX.test(toSha)) return none('unavailable');
  if (toSha && fromSha === toSha) return none('identical-sha');

  const gitOpts = { cwd: repoPath, timeoutMs: 15_000, maxBuffer: 10 * 1024 * 1024 };
  const author = gitOrNull(['log', '-1', '--format=%ae', fromSha], gitOpts);
  if (author !== SHADOW_IDENTITY_EMAIL) return none('not-shadow');

  const fromTree = gitOrNull(['rev-parse', `${fromSha}^{tree}`], gitOpts);
  if (!fromTree || !HEX.test(fromTree)) return none('unavailable');

  const toTree = toSha
    ? gitOrNull(['rev-parse', `${toSha}^{tree}`], gitOpts)
    : writeWorkingTree(repoPath, gitOpts);
  if (!toTree || !HEX.test(toTree)) return none('unavailable');
  // Tree object ids, not paths — raw identity is the question. // path-compare-ok
  if (fromTree === toTree) return none('empty'); // path-compare-ok

  const unified = opts?.unified ?? 3;
  const cap = diffTreeToTree(fromTree, toTree, gitOpts, unified);
  return { status: 'changed', ...cap };
}

/**
 * Write the current working tree (HEAD + staged + unstaged + untracked) to the
 * git object store as a tree object via a private temp index, WITHOUT touching
 * .git/index or the user's working tree. Returns the tree SHA, or null.
 */
function writeWorkingTree(repoPath: string, gitOpts: { cwd: string; timeoutMs: number; maxBuffer: number }): string | null {
  const tmpIndex = tmpIndexPath('origin-agy-tree');
  const indexOpts = { ...gitOpts, env: { ...process.env, GIT_INDEX_FILE: tmpIndex } };
  try {
    git(['read-tree', 'HEAD'], indexOpts);
    try { git(['add', '-A', '--', '.'], indexOpts); } catch { /* best-effort */ }
    const tree = git(['write-tree'], indexOpts).trim();
    return HEX.test(tree) ? tree : null;
  } catch {
    return null;
  } finally {
    try { fs.unlinkSync(tmpIndex); } catch { /* ignore */ }
  }
}

/**
 * Read a repo-relative file's content as of a commit/tree sha (shadow commits
 * included — they're ordinary objects kept reachable by a ref).
 *
 * Used to anchor Codex `apply_patch` hunks to their real line numbers: Codex's
 * Update-File sections carry a bare `@@` with no ranges, so the only way to
 * know where a hunk lands is to look at the file it was applied to. Returns
 * null on any failure (path absent at that rev, bad sha, binary blowup) —
 * callers must degrade gracefully rather than emit a guessed position.
 *
 * `relPath` must be relative to the repo ROOT and use forward slashes, which is
 * what `git show <sha>:<path>` expects.
 */
export function readFileAtRev(repoPath: string, sha: string, relPath: string): string | null {
  if (!sha || !HEX.test(sha) || !relPath) return null;
  // A leading `./` or `../` would make git resolve the path against cwd rather
  // than the repo root; an absolute path is never valid in this form.
  if (relPath.startsWith('.') || relPath.startsWith('/') || /^[A-Za-z]:/.test(relPath)) return null;
  try {
    return git(['show', `${sha}:${relPath}`], {
      cwd: repoPath, timeoutMs: 10_000, maxBuffer: 10 * 1024 * 1024,
    });
  } catch {
    return null;
  }
}

/**
 * Repo-relative paths whose content differs between a shadow commit and the
 * CURRENT working tree (tracked + untracked). Answers "what has this session
 * actually touched since it started".
 *
 * Callers must NOT hand-roll this as `git diff <shadow> --name-only`. That form
 * compares the shadow commit against the INDEX, and a pre-existing untracked
 * file lives in the shadow tree but not in the index — so git reports it as a
 * deletion and it looks "touched" when nothing changed. Snapshotting the
 * worktree as a tree and diffing tree-to-tree cancels anything identical in
 * both. Same reasoning as captureAgyDiff above.
 *
 * Returns [] on any failure — callers treat that as "no touch signal" and fall
 * back to their commit-based signal.
 */
export function filesChangedSinceShadow(repoPath: string, shadowSha: string): string[] {
  if (!shadowSha || !HEX.test(shadowSha)) return [];
  const gitOpts = { cwd: repoPath, timeoutMs: 15_000, maxBuffer: 10 * 1024 * 1024 };
  const baseTree = gitOrNull(['rev-parse', `${shadowSha}^{tree}`], gitOpts);
  if (!baseTree || !HEX.test(baseTree)) return [];
  const curTree = writeWorkingTree(repoPath, gitOpts);
  if (!curTree) return [];
  try {
    return git(['diff', '--name-only', baseTree, curTree], gitOpts)
      .trim().split('\n').map((s) => s.trim()).filter(Boolean);
  } catch {
    return [];
  }
}

/**
 * One prompt's share of a commit: the diff between that prompt's baseline
 * shadow and the commit, restricted to the commit's files.
 *
 * A commit's own stat is the wrong number to show against a prompt. Take a file
 * created untracked with 10 lines by prompt 2, then extended by 5 and committed
 * by prompt 3: git reports the commit as +15 (the whole file is new to git), so
 * crediting the raw commit stat makes prompt 3 look like it wrote 15 lines. The
 * prompt's baseline shadow already holds the 10-line version, so
 * baseline->commit is the +5 it actually contributed.
 *
 * Tree-to-tree, not `git diff <shadow> <commit>`, for the usual reason: the
 * shadow stages untracked files, so comparing against anything index-based
 * turns pre-existing untracked content into phantom deletions.
 *
 * Returns null when there is no usable baseline or the diff can't be computed —
 * callers then fall back to the commit's own stat, i.e. today's behaviour.
 */
export function commitDiffScopedToPrompt(
  repoPath: string,
  baselineSha: string | null | undefined,
  commitSha: string,
  files: string[],
): { diff: string; linesAdded: number; linesRemoved: number; files: string[]; diffTruncated: boolean } | null {
  if (!baselineSha || !HEX.test(baselineSha) || !HEX.test(commitSha)) return null;
  if (baselineSha === commitSha) return null;
  const gitOpts = { cwd: repoPath, timeoutMs: 15_000, maxBuffer: 10 * 1024 * 1024 };
  // A MERGE cannot be scoped this way. Its tree contains the whole branch it
  // absorbed, so baseline→merge credits the turn with every commit that came
  // in with it — and with no pathspec to hold it back there is nothing between
  // that and the turn claiming another PR's work (prod f7881a6e turn 3, +84/-20
  // of a file the session never opened). A merge's own contribution is its
  // conflict resolution; mergeOwnDiff is what answers that, and callers that
  // want it ask for it directly.
  const parentCount = (gitOrNull(['rev-list', '--parents', '-n', '1', commitSha], gitOpts)
    || '').trim().split(/\s+/).length - 1;
  if (parentCount > 1 && files.length === 0) return null;
  const baseTree = gitOrNull(['rev-parse', `${baselineSha}^{tree}`], gitOpts);
  const commitTree = gitOrNull(['rev-parse', `${commitSha}^{tree}`], gitOpts);
  if (!baseTree || !commitTree || !HEX.test(baseTree) || !HEX.test(commitTree)) return null;
  // Tree object ids, not paths — raw identity is the question. // path-compare-ok
  if (baseTree === commitTree) return { diff: '', linesAdded: 0, linesRemoved: 0, files: [], diffTruncated: false }; // path-compare-ok
  try {
    const pathspec = files.length ? ['--', ...files] : [];
    // The file list and the line counts come from numstat, which is one row
    // per file whatever the change size. The TEXT is what gets capped: a
    // 120-file turn at full-file context is 3.3MB, and a byte-slice at
    // MAX_DIFF_SIZE kept the first 22 files and counted only those — which
    // is how session 29b32c38 turn 1 was sent as 22 files / +794 after the
    // range itself was already right. Context steps down before anything is
    // dropped, and what is dropped is whole sections, never half a hunk.
    const rows = numstatByFile(['diff', '--numstat', baseTree, commitTree, ...pathspec], gitOpts);
    let diff = '';
    let diffTruncated = false;
    for (const u of CONTEXT_LADDER) {
      diff = stripIgnoredSectionsFromDiff(git(['diff', `--unified=${u}`, baseTree, commitTree, ...pathspec], gitOpts));
      if (diff.length <= MAX_DIFF_SIZE) break;
    }
    if (diff.length > MAX_DIFF_SIZE) {
      diff = truncateToWholeSections(diff, MAX_DIFF_SIZE);
      diffTruncated = true;
    }
    let linesAdded = 0;
    let linesRemoved = 0;
    if (rows) {
      for (const r of rows) { linesAdded += r.added; linesRemoved += r.removed; }
    } else {
      for (const line of diff.split('\n')) {
        if (line.startsWith('+') && !line.startsWith('+++')) linesAdded++;
        else if (line.startsWith('-') && !line.startsWith('---')) linesRemoved++;
      }
    }
    const named = rows ? rows.map((r) => r.file) : pathsInDiffText(diff);
    return { diff, linesAdded, linesRemoved, files: named, diffTruncated };
  } catch {
    return null;
  }
}

/** The paths a unified diff names, in order, without duplicates. */
function pathsInDiffText(diff: string): string[] {
  const out: string[] = [];
  for (const m of (diff || '').matchAll(/^diff --git a\/(.+?) b\/(.+)$/gm)) {
    if (m[2] && !out.includes(m[2])) out.push(m[2]);
  }
  return out;
}

// ─── Helpers ───────────────────────────────────────────────────────────────

function emptyResult(headBefore: string): GitCaptureResult {
  return {
    headBefore,
    headAfter: headBefore,
    commitShas: [],
    commitDetails: [],
    diff: '',
    committedDiff: '',
    uncommittedDiff: '',
    diffTruncated: false,
    linesAdded: 0,
    linesRemoved: 0,
    workingTreeDiff: '',
    baselineIsShadow: false,
  };
}

/**
 * Which of `files` does git ignore, asked in ONE call.
 *
 * `git check-ignore --stdin` answers a whole list at once, so this costs one
 * process per capture rather than one per observed write — the watcher sees
 * writes constantly and must never shell out on that path.
 *
 * Returns an EMPTY set on any failure, so an unanswerable question keeps every
 * file. Dropping a file the agent really wrote is far worse than keeping a
 * generated one: the first is work that vanishes, the second is a line item a
 * reader can dismiss.
 */
export function gitIgnoredFiles(repoPath: string, files: readonly string[]): Set<string> {
  const out = new Set<string>();
  if (!repoPath || files.length === 0) return out;
  try {
    const res = spawnSync(
      'git',
      ['-C', repoPath, 'check-ignore', '--stdin'],
      { input: files.join('\n'), encoding: 'utf-8', timeout: 10_000, windowsHide: true },
    );
    // Exit 0 = some ignored, 1 = none ignored, anything else = a real failure.
    if (res.error || (res.status !== 0 && res.status !== 1)) return out;
    for (const line of String(res.stdout || '').split('\n')) {
      const f = line.trim();
      if (f) out.add(f);
    }
  } catch { /* keep everything */ }
  return out;
}
