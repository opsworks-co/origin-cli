// Stage 2: reading a turn's capture out of the write journal.
//
// Stages 0 and 1 established the two halves. Stage 0 measured that 21% of
// stored turns contradict themselves and gave us a gate. Stage 1 made the
// journal record content, so a turn's before-state and after-state are both
// known exactly. This is the part that USES them.
//
// THE PRECEDENCE RULE, and it is the whole design: a turn's capture comes from
// the ledger or from the legacy reconstruction, NEVER from a blend of the two.
//
// Blending is the disease. `keepRicherTurnCapture` merges a fresh capture with
// a stored one and settles disagreements with
//
//     const diff = curDiff.length >= priorDiff.length ? curDiff : priorDiff;
//
// — the longer STRING wins, because nothing in that pipeline knows which is
// right. Adding the ledger as one more opinion in that vote would produce a
// fourth reconstruction and the same class of bug. So when the journal marked
// this turn, its answer is the answer; when it did not, this module returns
// null and the caller keeps today's behaviour untouched. There is no middle.
//
// Everything here is CONSISTENT BY CONSTRUCTION. `filesChanged` is derived from
// the diff that is actually emitted, and the line counts are counted off that
// same text, so the three cannot disagree — which is four of stage 0's six
// violation classes made unreachable rather than fixed.
import {
  turnFileChanges,
  turnSpan,
  type JournalEntry,
} from './write-journal.js';
import { getSnapshot } from './write-journal-store.js';
import { localTurnForServerRow } from './turn-index.js';
import { renderFileDiff, type FileDiffInput } from './write-journal-diff.js';
import { fitDiffToBudget } from './diff-budget.js';
import { MAX_PROMPT_DIFF_LEN } from './git-capture.js';

/**
 * How far a file's mtime may sit BEFORE its turn's mark and still be that
 * turn's write.
 *
 * A turn's first write lands milliseconds after the mark, and those two
 * timestamps do not come from the same clock: `markTurn` reads `Date.now()`,
 * while an inode's mtime is stamped by the kernel's COARSE realtime clock,
 * which only advances on a timer tick. On Linux that rounds backwards by a few
 * milliseconds, so a file genuinely written 1 ms after the mark can report an
 * mtime a few ms before it. `new-agent-day-one.test.ts` fails exactly that way
 * on the Linux runner while passing on Windows — a real hazard, found by CI
 * rather than reasoned about in advance.
 *
 * 60s is four orders of magnitude above that skew and four below the case this
 * rule exists for, where the phantoms' mtimes were four WEEKS old. Anything
 * inside the band is treated as the turn's own work, because a missed phantom
 * costs a few lines and a dropped real write costs the user their turn.
 */
export const PHANTOM_MTIME_SLACK_MS = 60_000;

/** How the before-state of each file was obtained. */
export type BeforeSource = 'ledger' | 'baseline' | 'absent' | 'unavailable';

export interface LedgerFile {
  file: string;
  before: string | null;
  after: string | null;
  beforeSource: BeforeSource;
}

export interface LedgerCapture {
  turnId: string;
  /** Files with a rendered diff section. Derived FROM the diff, never beside it. */
  filesChanged: string[];
  diff: string;
  linesAdded: number;
  linesRemoved: number;
  /**
   * Files this turn provably changed whose content could not be retrieved.
   *
   * Reported, never dropped and never silently listed without a diff: the
   * caller passes this through as its own field so the row stays internally
   * consistent while still saying the file changed.
   */
  contentUnavailable: string[];
  /** Files the turn wrote and then restored — real work, zero net change. */
  netZero: string[];
  /** True when every file resolved on both sides. */
  complete: boolean;
}

export interface LedgerCaptureDeps {
  entries: readonly JournalEntry[];
  turnId: string;
  snapshotDir: string;
  /**
   * Commit whose tree holds the before-state for a file this turn is the first
   * to write. A per-prompt SHADOW is the right value — it reflects the working
   * tree, dirt included, at the turn's start, where HEAD would miss anything
   * uncommitted and make the turn claim someone else's edits.
   */
  baselineSha?: string | null;
  /**
   * The PREVIOUS turn's baseline, for a file this turn reclaimed from ahead
   * of its own mark (TurnFileChange.reclaimed). This turn's own baseline was
   * cut after that write and already contains it; the state the write really
   * changed is the tree as the previous turn found it.
   */
  priorBaselineSha?: string | null;
  /** Injected so the rules are testable without a repository. */
  readAtRev?: (sha: string, file: string) => string | null;
  /**
   * Which of these paths git IGNORES. Batched, because it is one question about
   * a whole turn rather than a question per write.
   *
   * The watcher records every write it observes, including generated files —
   * `packages/cli/src/build-info.ts` is written by the build on its way past
   * and is gitignored, so it can never appear in a commit. Left in, it inflates
   * the turn's file count and manufactures a turn-vs-commit gap that has no
   * cause to find. Observed on session 1ea7a947, whose ledger capture listed it
   * alongside four real files.
   *
   * Omit to keep every observed write, which is the right default for a caller
   * with no repo to ask.
   */
  ignoredFiles?: (files: string[]) => Set<string>;
  /**
   * Before-states for files the turn INHERITED rather than wrote — see
   * inherited-window-baseline.ts.
   *
   * A `gh pr checkout`, `git pull`, `git rebase` or `git merge` rewrites files
   * on disk, and the watcher records each rewrite as a write of whichever turn
   * happened to be open. The bytes it saw arrive are real; WHOSE work they are
   * is the question, and against the turn's own baseline the answer comes back
   * "the turn's" for an entire pull request. Measured against what the
   * inherited commit left, a file the turn merely received cancels to netZero
   * and one it edited on top reports that edit alone.
   *
   * Consulted BEFORE the journal's own previous snapshot: that snapshot holds
   * the state before the turn's first write of the file, which for a checkout
   * is the pre-checkout content — the same stale answer in a closer voice.
   */
  beforeOverrides?: Map<string, string | null>;
}

/**
 * Build a turn's capture from the journal, or return null.
 *
 * Null means "this turn is not in the ledger" — no mark, so no claim. The
 * caller must then fall back wholesale rather than treating an empty result as
 * "the turn wrote nothing", which is the mistake that produced empty turn cards
 * for real work.
 */
export function captureTurnFromLedger(deps: LedgerCaptureDeps): LedgerCapture | null {
  const { entries, turnId, snapshotDir } = deps;
  if (turnSpan(entries, turnId) === null) return null;

  let changes = turnFileChanges(entries, turnId);
  // Generated files never reach a commit, so counting them as the turn's work
  // only creates a discrepancy the reader cannot resolve.
  if (deps.ignoredFiles && changes.length > 0) {
    try {
      const ignored = deps.ignoredFiles(changes.map((c) => c.file));
      if (ignored.size > 0) changes = changes.filter((c) => !ignored.has(c.file));
    } catch { /* an unanswerable question keeps every write */ }
  }
  // PHANTOM WRITES. `fs.watch(recursive)` on Windows fires for files whose
  // bytes never changed, and the journal records an event as a write. Session
  // bd3c110a turn 2 took seven of them in one second — .claude/launch.json,
  // dev.sh, docker-start.sh, fly.dev.toml, fly.toml, pnpm-workspace.yaml,
  // stop.sh — whose mtimes on disk were from the previous MONTH. Nothing wrote
  // them. Each was the turn's first sighting, so `beforeHash` was null; with no
  // baseline to answer, `before` stayed null and renderFileDiff emitted the
  // WHOLE FILE as an add. A turn that ran `git commit`, `gh pr create` and a
  // version bump — one edited file — was recorded as 11 files, +684/-0. The
  // zero deletions are the signature: whole files billed as new.
  //
  // The file's own mtime settles it. A write that happened during this turn has
  // an mtime at or after the turn's mark; one from last month did not happen
  // here, whatever the watcher reported. Dropped outright rather than named in
  // `contentUnavailable`, because there is nothing to report — the file did not
  // change, so a row saying it did would be the same lie in a quieter voice.
  //
  // Strictly evidence-driven, in both directions: a record with NO mtime (every
  // journal written before the field existed) is not evidence of anything and
  // passes through untouched, so old journals behave exactly as they did.
  const turnStartedAt = (() => {
    const mark = entries[turnSpan(entries, turnId)!.start - 1];
    return mark && mark.kind === 'turn' ? mark.at : null;
  })();
  if (turnStartedAt !== null) {
    const stale = changes.filter(
      (c) => typeof c.mtime === 'number'
        && c.mtime < turnStartedAt - PHANTOM_MTIME_SLACK_MS
        && !c.deleted,
    );
    if (stale.length > 0) {
      const staleFiles = new Set(stale.map((c) => c.file));
      changes = changes.filter((c) => !staleFiles.has(c.file));
    }
  }

  const resolved: LedgerFile[] = [];
  const contentUnavailable: string[] = [];
  const netZero: string[] = [];
  let complete = true;

  for (const c of changes) {
    // AFTER. A delete has no after-state, which is different from empty.
    let after: string | null = null;
    if (!c.deleted) {
      after = getSnapshot(snapshotDir, c.afterHash);
      if (after === null) {
        // We know it changed and to exactly which state; we just do not hold
        // the bytes. Say that, rather than dropping it or listing it bare.
        contentUnavailable.push(c.file);
        complete = false;
        continue;
      }
    }

    // BEFORE. The ledger's own previous snapshot first — that is the whole
    // point, and it is what makes a turn unable to inherit its predecessor's
    // work. Only a file this turn saw FIRST needs git at all.
    let before: string | null = null;
    let beforeSource: BeforeSource = 'absent';
    const inherited = deps.beforeOverrides;
    if (inherited && inherited.has(c.file)) {
      // The turn found this file already holding the inherited commit's bytes.
      // Whatever the journal or the baseline says about an earlier state
      // describes work that is not this turn's to claim.
      before = inherited.get(c.file) ?? null;
      if (before !== null) beforeSource = 'baseline';
    } else if (c.beforeHash) {
      before = getSnapshot(snapshotDir, c.beforeHash);
      if (before === null) {
        contentUnavailable.push(c.file);
        complete = false;
        continue;
      }
      beforeSource = 'ledger';
    } else if ((c.reclaimed ? (deps.priorBaselineSha || deps.baselineSha) : deps.baselineSha) && deps.readAtRev) {
      // One precise blob read for one file — O(files this turn touched), not
      // the whole-tree diff the legacy path takes. This is why the ledger scales
      // to a large repo: cost follows the work, not the checkout.
      const at = (c.reclaimed ? (deps.priorBaselineSha || deps.baselineSha) : deps.baselineSha) as string;
      const fromGit = deps.readAtRev(at, c.file);
      if (fromGit !== null) { before = fromGit; beforeSource = 'baseline'; }
      // A null read is the normal answer for a file the turn CREATED: it did
      // not exist at the baseline. `before` stays null and the diff renders as
      // a creation.
    }

    if (before !== null && after !== null && before === after) netZero.push(c.file);
    resolved.push({ file: c.file, before, after, beforeSource });
  }

  const inputs: FileDiffInput[] = resolved.map((r) => ({ file: r.file, before: r.before, after: r.after }));
  const sections = inputs.map((i) => ({ file: i.file, text: renderFileDiff(i) }));

  // Fit to the wire/storage budget at FILE boundaries. The old path sliced the
  // string at 200 KB, which cuts mid-hunk and yields a diff `git apply` refuses
  // — a corrupt capture rather than a smaller one. Anything dropped is NAMED
  // below, so the row still says the file changed.
  const budgeted = fitDiffToBudget(sections.map((s) => s.text).join(''), MAX_PROMPT_DIFF_LEN);
  const diff = budgeted.diff;
  for (const f of budgeted.omittedFiles) {
    if (!contentUnavailable.includes(f)) contentUnavailable.push(f);
  }
  if (budgeted.truncated) complete = false;

  // filesChanged is read back OFF the emitted diff. Deriving it separately is
  // how a row ends up naming files its own diff does not contain.
  const filesChanged = sections
    .filter((s) => s.text && !budgeted.omittedFiles.includes(s.file))
    .map((s) => s.file);

  let linesAdded = 0;
  let linesRemoved = 0;
  for (const line of diff.split('\n')) {
    if (line.startsWith('+') && !line.startsWith('+++')) linesAdded++;
    else if (line.startsWith('-') && !line.startsWith('---')) linesRemoved++;
  }

  return {
    turnId,
    filesChanged,
    diff,
    linesAdded,
    linesRemoved,
    contentUnavailable: [...new Set(contentUnavailable)],
    netZero,
    complete,
  };
}

/**
 * Should this capture be used in place of the legacy reconstruction?
 *
 * A ledger capture that resolved NOTHING is not evidence that the turn did
 * nothing — a watcher that never started, a platform with no recursive watch,
 * or a session predating snapshots all look identical to a chat-only turn from
 * here. In that case say no and let the old path answer, exactly as before.
 *
 * A capture with real content is trusted outright, including when some files
 * were unretained: those are reported separately and do not make the files it
 * DID resolve any less exact.
 */
export function ledgerCaptureIsUsable(cap: LedgerCapture | null): cap is LedgerCapture {
  if (!cap) return false;
  return cap.filesChanged.length > 0 || cap.contentUnavailable.length > 0 || cap.netZero.length > 0;
}

// ─── Applying the ledger to a set of mappings ───────────────────────────────

/** The pieces of session state the ledger needs. Kept structural so the three
 *  producers (Stop, the heartbeat, the transcript watcher) can all pass their
 *  own state object without a shared concrete type. */
export interface LedgerSessionState {
  writeJournalPath?: string;
  writeSnapshotDir?: string;
  /** LOCAL-numbered: index L is this launch's turn L. */
  promptTurnIds?: string[];
  /** LOCAL-numbered, like the ids. */
  promptShadows?: Array<{ promptIndex: number; shadowSha: string }>;
  prePromptSha?: string | null;
  headShaAtStart?: string | null;
  /** Server row of this launch's turn 0 — see turn-index.ts. */
  promptIndexBase?: number | null;
  /**
   * True once this journal has observed another session in its working tree.
   * A journal observes bytes, not processes, so contested records must never
   * become admissible merely because that peer later exits.
   */
  ledgerContended?: boolean;
}

/** A per-turn mapping, as each producer builds it before sending. */
export interface LedgerApplicableMapping {
  promptIndex: number;
  filesChanged?: unknown;
  diff?: string;
  uncommittedDiff?: string | null;
  /** Set together with the diff — see the note in `applyLedgerToMappings`. */
  linesAdded?: number;
  linesRemoved?: number;
  contentUnavailableFiles?: string[];
  /** Provenance, sent on the wire. See utils/diff-provenance.ts on the server. */
  diffSource?: 'ledger';
  /** Internal marker for callers that must suppress their own re-derivation. */
  ledgerOwned?: boolean;
}

export interface ApplyLedgerDeps {
  /** Read the whole ordered journal. Injected so this module does no IO itself. */
  readEntries: (journalPath: string) => JournalEntry[];
  /** `git show <sha>:<file>`, scoped to the tree the session writes in. */
  readAtRev?: (sha: string, file: string) => string | null;
  /** Batched "does git ignore this?" — see LedgerCaptureDeps.ignoredFiles. */
  ignoredFiles?: (files: string[]) => Set<string>;
  /**
   * Per-turn before-states for files the turn inherited from a checkout, pull,
   * rebase or merge that landed inside its window. Injected because answering
   * it needs the repo, and this module does no IO of its own.
   */
  inheritedBefore?: (baselineSha: string, localTurn: number) => Map<string, string | null>;
  /** Optional trace hook; never throws. */
  log?: (event: string, data: Record<string, unknown>) => void;
}

/**
 * Replace each turn's capture with the ledger's, where the ledger has one.
 *
 * THE PRECEDENCE RULE: a mapping is replaced WHOLESALE or left completely
 * alone. It is never merged with what the producer reconstructed, because
 * merging reconstructions is the defect this rewrite exists to remove —
 * `keepRicherTurnCapture` settles disagreements with
 * `curDiff.length >= priorDiff.length`, and adding the ledger to that vote
 * would make a fourth opinion rather than an answer.
 *
 * Shared by all three producers deliberately. Stop, the heartbeat and the
 * transcript watcher each built their own per-turn capture independently, and
 * every one of those is a separate chance to apply the ledger slightly
 * differently — which is how the pipeline acquired fourteen producers in the
 * first place.
 *
 * Returns how many mappings it replaced. Never throws: the new path must never
 * break a capture the old one could still produce.
 */
export function applyLedgerToMappings(
  state: LedgerSessionState,
  mappings: LedgerApplicableMapping[],
  deps: ApplyLedgerDeps,
): number {
  try {
    const journalPath = state.writeJournalPath;
    const snapshotDir = state.writeSnapshotDir;
    if (!journalPath || !snapshotDir || !Array.isArray(mappings)) return 0;
    if (state.ledgerContended) {
      deps.log?.('ledger declined: another live session shares this working tree', {});
      return 0;
    }
    const entries = deps.readEntries(journalPath);
    if (entries.length === 0) return 0;

    let replaced = 0;
    for (const pm of mappings) {
      if (!pm || !Number.isInteger(pm.promptIndex)) continue;
      // The mapping is a SERVER row; ids and shadows are numbered by this
      // launch. Resolve once, or a resumed conversation's rows find no id
      // (row 21 → `promptTurnIds[21]`) while the row of a turn from before
      // the resume (row 0 → `promptTurnIds[0]`) borrows this launch's first
      // turn — prod 8a626742.
      const local = localTurnForServerRow(pm.promptIndex, state.promptIndexBase);
      if (local === null) {
        deps.log?.('ledger declined: row predates this launch', { promptIndex: pm.promptIndex });
        continue;
      }
      const turnId = state.promptTurnIds?.[local];
      if (typeof turnId !== 'string' || !turnId) {
        deps.log?.('ledger declined: turn has no id', { promptIndex: pm.promptIndex });
        continue;
      }

      // A per-prompt SHADOW, not HEAD: it reflects the working tree including
      // anything already dirty when the turn began, so a file this turn is the
      // first to touch is diffed against what was really there rather than
      // against the last commit — which would credit the turn with someone
      // else's uncommitted edits.
      const shadow = state.promptShadows?.find((ps) => ps.promptIndex === local)?.shadowSha;
      const baselineSha = shadow || state.prePromptSha || state.headShaAtStart || null;
      // For a write reclaimed from ahead of this turn's mark: the tree as the
      // previous turn found it. Same fallbacks — a session with no shadows
      // still reads its first turn against the session start.
      const priorShadow = state.promptShadows?.find((ps) => ps.promptIndex === local - 1)?.shadowSha;
      const priorBaselineSha = priorShadow || state.headShaAtStart || state.prePromptSha || null;

      let beforeOverrides: Map<string, string | null> | undefined;
      if (deps.inheritedBefore && baselineSha) {
        try {
          const m = deps.inheritedBefore(baselineSha, local);
          if (m && m.size > 0) beforeOverrides = m;
        } catch { /* unanswerable: the turn keeps the baseline it always had */ }
      }
      const cap = captureTurnFromLedger({
        entries, turnId, snapshotDir, baselineSha, priorBaselineSha,
        readAtRev: deps.readAtRev, ignoredFiles: deps.ignoredFiles, beforeOverrides,
      });
      if (!ledgerCaptureIsUsable(cap)) {
        // A silent fallback is indistinguishable from a working ledger that
        // saw a chat-only turn. Say which it was.
        deps.log?.(cap ? 'ledger declined: turn is marked but resolved nothing' : 'ledger declined: turn is not marked in the journal', {
          promptIndex: pm.promptIndex, turnId,
        });
        continue;
      }

      pm.filesChanged = cap.filesChanged;
      pm.diff = cap.diff;
      // Cleared to the EMPTY STRING, not undefined. The ledger diff already
      // describes everything the turn wrote, committed or not, so leaving the
      // producer's working-tree diff beside it would count the same lines
      // twice — but `undefined` does not clear it: JSON.stringify DROPS an
      // undefined key, the field arrives absent, and the server's
      // "preserve existing on absent" rule keeps the stale value forever. An
      // explicit empty string is what the server reads as "cleared".
      pm.uncommittedDiff = '';
      // Counts move WITH the content they describe. The heartbeat and the
      // transcript watcher both set these from their own reconstruction before
      // this runs, and leaving them would produce exactly the mosaic stage 0
      // reports as `line_counts_disagree_with_diff`: numbers from one capture
      // over a diff from another.
      pm.linesAdded = cap.linesAdded;
      pm.linesRemoved = cap.linesRemoved;
      // Set on the MAPPING, not just at one call site: the producers build
      // their wire payloads by spreading `...pm`, so provenance that lives
      // anywhere else silently fails to travel.
      pm.diffSource = 'ledger';
      pm.ledgerOwned = true;
      if (cap.contentUnavailable.length > 0) pm.contentUnavailableFiles = cap.contentUnavailable;
      replaced++;
      deps.log?.('turn capture taken from the write journal', {
        promptIndex: pm.promptIndex,
        turnId,
        inherited: beforeOverrides?.size ?? 0,
        files: cap.filesChanged.length,
        unavailable: cap.contentUnavailable.length,
        netZero: cap.netZero.length,
        complete: cap.complete,
      });
    }
    return replaced;
  } catch (err: unknown) {
    deps.log?.('ledger capture failed, keeping the reconstructed mappings', { err: String(err) });
    return 0;
  }
}
