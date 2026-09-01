// `origin repair-merges` — heal turns that a merge commit corrupted.
//
// The bug it repairs (fixed in capture 2026-08-28, #1334): three git reads
// return the wrong thing for a merge, and the capture trusted all three —
// `diff-tree --name-only` gives NOTHING, `git diff <merge>~1..<merge>` gives
// the ENTIRE absorbed branch, and `git show <merge>` gives an unparseable
// `--cc`. So the merging turn stored `+0/-0` while another PR's code was
// credited somewhere in the session (prod f7881a6e: turn 3 sent
// `{filesChanged:0, a:84, r:20}` for `final-state-blame.ts` —
// a file that session never opened).
//
// Rows already written are wrong and no read-side rule can spot it: "this turn
// changed final-state-blame.ts" looks exactly like a turn that did. Only git,
// run against the repo the merge lives in, can tell the difference. That is
// why this is a CLI command and not a server script — the API has no checkout.
//
// THE SAFETY RULE, same as `origin recapture`: a row is only ever proposed
// when there is POSITIVE evidence it holds work that did not happen.
//   A. the row names a commit git says is a MERGE — replace its content with
//      what that merge actually resolved (what is in it and in NEITHER
//      parent), which is the only part of a merge its turn authored;
//   B. the row names no commit, carries no editsJson, every file it names is
//      explained by one of the session's merges, and the turn's own transcript
//      shows it edited nothing — merge fallout on a turn that did no work.
//
// Rule B REQUIRES the transcript. Without it a shell-only turn (`sed -i`,
// `cat >`) is indistinguishable from a turn that did nothing, and blanking one
// of those would destroy a correct row. No transcript, no rule B.

import fs from 'fs';
import { newCaptureStamp } from '../capture-stamp.js';
import { api } from '../api.js';
import { gitOrNull } from '../utils/exec.js';
import { mergeOwnDiff, commitParents } from '../history-backfill.js';
import { capturePromptEdits } from '../prompt-capture/index.js';
import { loadSessionState } from '../session-state.js';
import { findLocalSessionState } from './recapture.js';

export interface StoredTurn {
  turnId?: string;
  promptIndex: number;
  promptText: string;
  linesAdded: number;
  linesRemoved: number;
  files: string[];
  commitShas: string[];
  hasEdits: boolean;
}

/** What one of the session's merges did, split into the two halves that the
 *  broken reads conflated. */
export interface MergeFacts {
  sha: string;
  /** Files the merge RESOLVED — in it and in neither parent. Its turn's work. */
  ownFiles: string[];
  /** That resolution as an ordinary unified diff. */
  ownDiff: string;
  /** Files that arrived WITH the merge and were authored on the other side. */
  absorbedFiles: string[];
}

export interface MergeRepair {
  turnId?: string;
  promptIndex: number;
  rule: 'merge-turn' | 'merge-fallout';
  why: string;
  before: { linesAdded: number; linesRemoved: number; files: number };
  after: { linesAdded: number; linesRemoved: number; files: number };
  filesChanged: string[];
  diff: string;
  chatOnly: boolean;
}

export interface MergeSkip { promptIndex: number; reason: string }
export interface MergeRepairPlan { repairs: MergeRepair[]; skipped: MergeSkip[] }

function countDiff(diff: string): { linesAdded: number; linesRemoved: number } {
  let linesAdded = 0;
  let linesRemoved = 0;
  for (const line of diff.split('\n')) {
    if (line.startsWith('+') && !line.startsWith('+++')) linesAdded++;
    else if (line.startsWith('-') && !line.startsWith('---')) linesRemoved++;
  }
  return { linesAdded, linesRemoved };
}

const shaMatches = (a: string, b: string): boolean =>
  !!a && !!b && (a === b || a.startsWith(b) || b.startsWith(a));

/**
 * Decide which turns to correct. Pure — no network, no disk — so the rules
 * that overwrite production data are testable on their own.
 *
 * `editedFilesByTurn` is the transcript's answer to "what did this turn
 * actually edit". A turn absent from the map has no transcript evidence, and
 * rule B refuses to touch it.
 */
export function planMergeRepairs(
  stored: StoredTurn[],
  merges: MergeFacts[],
  editedFilesByTurn: Map<number, string[]> | null,
): MergeRepairPlan {
  const repairs: MergeRepair[] = [];
  const skipped: MergeSkip[] = [];
  if (merges.length === 0) return { repairs, skipped };

  const absorbedOnly = new Set<string>();
  const resolvedFiles = new Set<string>();
  for (const m of merges) {
    for (const f of m.ownFiles) resolvedFiles.add(f);
    for (const f of m.absorbedFiles) absorbedOnly.add(f);
  }
  for (const f of resolvedFiles) absorbedOnly.delete(f);

  for (const row of stored) {
    const before = {
      linesAdded: row.linesAdded, linesRemoved: row.linesRemoved, files: row.files.length,
    };

    // ── A. the turn that made the merge ──────────────────────────────────
    const merge = merges.find((m) => row.commitShas.some((s) => shaMatches(s, m.sha)));
    if (merge) {
      // ONLY when the merge is all this turn committed. A turn that also made
      // a real commit has that commit's work in the same row, and replacing
      // the row with the merge's resolution would DELETE it — prod f7881a6e
      // turn 4 carried `e3f75913` (the merge) beside `5709877b2` (~150 lines
      // of actual work), and this repair was one `--apply` from erasing it.
      // Composing every commit's own content would be the fuller answer, but
      // it also drops whatever the turn left uncommitted, and this command
      // exists to remove work that did not happen — never to risk removing
      // work that did.
      const others = row.commitShas.filter((s) => !shaMatches(s, merge.sha));
      if (others.length > 0) {
        skipped.push({
          promptIndex: row.promptIndex,
          reason: `committed ${others.map((o) => o.slice(0, 8)).join(', ')} as well as the merge`
            + ' — correcting it here would drop that work',
        });
        continue;
      }
      const after = { ...countDiff(merge.ownDiff), files: merge.ownFiles.length };
      const unchanged = after.linesAdded === before.linesAdded
        && after.linesRemoved === before.linesRemoved
        && merge.ownFiles.length === row.files.length
        && merge.ownFiles.every((f) => row.files.includes(f));
      if (unchanged) {
        skipped.push({ promptIndex: row.promptIndex, reason: 'already matches what the merge resolved' });
        continue;
      }
      repairs.push({
        turnId: row.turnId,
        promptIndex: row.promptIndex,
        rule: 'merge-turn',
        why: `merge ${merge.sha.slice(0, 8)} resolved ${merge.ownFiles.length} file(s);`
          + ` ${merge.absorbedFiles.length} more came in WITH it and belong to whoever wrote them`,
        before,
        after,
        filesChanged: merge.ownFiles,
        diff: merge.ownDiff,
        chatOnly: merge.ownFiles.length === 0,
      });
      continue;
    }

    // ── B. a turn wearing another turn's merge ───────────────────────────
    if (row.files.length === 0) continue; // nothing claimed, nothing to strip
    if (row.commitShas.length > 0) {
      skipped.push({ promptIndex: row.promptIndex, reason: 'names a commit of its own — not merge fallout' });
      continue;
    }
    const mergeExplained = row.files.every((f) => absorbedOnly.has(f) || resolvedFiles.has(f));
    if (!mergeExplained) continue; // ordinary turn; not this bug
    const touchesAbsorbed = row.files.some((f) => absorbedOnly.has(f));
    if (!touchesAbsorbed) {
      skipped.push({
        promptIndex: row.promptIndex,
        reason: 'files are all merge-resolved but none absorbed — too weak to call fallout',
      });
      continue;
    }
    if (row.hasEdits) {
      skipped.push({ promptIndex: row.promptIndex, reason: 'carries its own editsJson — the turn really did edit' });
      continue;
    }
    if (!editedFilesByTurn) {
      skipped.push({
        promptIndex: row.promptIndex,
        reason: 'no transcript to corroborate — a shell-only turn looks identical, refusing',
      });
      continue;
    }
    const edited = editedFilesByTurn.get(row.promptIndex);
    if (edited === undefined) {
      skipped.push({ promptIndex: row.promptIndex, reason: 'turn missing from the transcript — refusing' });
      continue;
    }
    if (edited.length > 0) {
      skipped.push({
        promptIndex: row.promptIndex,
        reason: `transcript shows ${edited.length} edited file(s) — the turn did work`,
      });
      continue;
    }
    repairs.push({
      turnId: row.turnId,
      promptIndex: row.promptIndex,
      rule: 'merge-fallout',
      why: `every file traces to a merge (${row.files.filter((f) => absorbedOnly.has(f)).join(', ')} `
        + 'came in with it), the row names no commit, and the transcript shows no edits',
      before,
      after: { linesAdded: 0, linesRemoved: 0, files: 0 },
      filesChanged: [],
      diff: '',
      chatOnly: true,
    });
  }

  return { repairs, skipped };
}

export interface SessionDiffRepair {
  before: { linesAdded: number; linesRemoved: number; sections: number };
  after: { linesAdded: number; linesRemoved: number; sections: number };
  droppedFiles: string[];
  diff: string;
}

/**
 * The session HEADER, which is a different surface from the per-turn rows and
 * was left wrong when those were fixed.
 *
 * For a claude-code session the session-level capture goes through the APPEND
 * path in mcp.ts (only codex/gemini/cursor send `snapshot: true`), and an
 * append only ever grows: sections written by a pre-#1334 capture — with a
 * merge's whole absorbed branch in them — stay in the stored SessionDiff
 * forever, no matter how correct every later capture is.
 *
 * Measured on prod f7881a6e: stored +1607/-119 across 30 sections, of which
 * eight files were another PR's code arriving with a merge —
 * `session-detail-delimiter-locality.test.ts` +144, `synthesize-prompt-diff.ts`
 * +81/-25, `final-state-blame.ts` +54/-12 and five more, +533/-50 together.
 * 1607 - 533 = 1074, the session's own three commits. The entire inflation is
 * those files; there is no double-count residue underneath.
 *
 * So this is a SECTION DROP, not a recompute. Rebuilding the diff from the
 * session's commits would also discard whatever it left uncommitted, which is
 * real work no commit can vouch for. Dropping only the files git proves came
 * in with a merge — and that the session never authored itself — cannot lose
 * anything the session did.
 *
 * Returns null when there is nothing to drop, or when the result would not be
 * strictly smaller (this only ever removes work that did not happen).
 */
export function planSessionDiffRepair(
  storedDiff: string,
  storedTotals: { linesAdded: number; linesRemoved: number },
  dropFiles: Set<string>,
): SessionDiffRepair | null {
  if (!storedDiff.trim() || dropFiles.size === 0) return null;
  const sections = storedDiff.split(/^(?=diff --git )/m).filter((p) => p.trim());
  const kept: string[] = [];
  const dropped = new Set<string>();
  for (const sec of sections) {
    const header = sec.split('\n', 1)[0] || '';
    const m = header.match(/^diff --git a\/(.+?) b\/(.+)$/);
    // An unparseable header is never dropped — it cannot be shown to be foreign.
    const file = m ? m[2] : '';
    if (file && dropFiles.has(file)) { dropped.add(file); continue; }
    kept.push(sec);
  }
  if (dropped.size === 0) return null;
  const diff = kept.join('').trim();
  const after = { ...countDiff(diff), sections: kept.length };
  if (after.linesAdded > storedTotals.linesAdded || after.linesRemoved > storedTotals.linesRemoved) {
    return null;
  }
  return {
    before: { ...storedTotals, sections: sections.length },
    after,
    droppedFiles: [...dropped],
    diff,
  };
}

export interface EditsRepair {
  turnId?: string;
  promptIndex: number;
  droppedFiles: string[];
  before: { linesAdded: number; linesRemoved: number; files: number; edits: number };
  after: { linesAdded: number; linesRemoved: number; files: number; edits: number };
  editsJson: string;
  filesChanged: string[];
  diff: string;
}

/** Drop whole `diff --git` sections for the named paths. Content whose header
 *  does not parse is kept — it cannot be shown to be foreign, and a repair that
 *  removes what it cannot identify is how a diff loses real work. */
function dropSections(diffText: string, drop: Set<string>): { text: string; dropped: string[] } {
  if (!diffText.trim()) return { text: '', dropped: [] };
  const dropped: string[] = [];
  const kept = diffText.split(/^(?=diff --git )/m).filter((sec) => {
    if (!sec.trim()) return false;
    const m = (sec.split('\n', 1)[0] || '').match(/^diff --git a\/(.+?) b\/(.+)$/);
    if (m && drop.has(m[2])) { dropped.push(m[2]); return false; }
    return true;
  });
  return { text: kept.join('').trim(), dropped };
}

/**
 * Strip merge-absorbed work out of the STORED per-turn capture.
 *
 * The session header is synthesized from every turn's editsJson, so until the
 * stored captures are cleaned the header keeps counting another PR's code no
 * matter what the capture side does from now on.
 *
 * All three projections of the row move together — editsJson, filesChanged and
 * the diff text — because the server treats a real editsJson as authoritative
 * for the whole row, and leaving the other two behind would have a corrected
 * capture rendering beneath stale numbers.
 *
 * Only ever REMOVES. A row where nothing is foreign is left alone, and a result
 * that is not strictly smaller is refused.
 */
export function planEditsJsonRepair(
  rows: Array<{
    turnId?: string; promptIndex: number; editsJson?: string | null;
    diff?: string | null; filesChanged?: string[]; linesAdded?: number; linesRemoved?: number;
  }>,
  dropFiles: Set<string>,
): EditsRepair[] {
  const out: EditsRepair[] = [];
  if (dropFiles.size === 0) return out;
  for (const row of rows) {
    let cap: any = null;
    try { cap = row.editsJson ? JSON.parse(row.editsJson) : null; } catch { cap = null; }
    const edits: any[] = Array.isArray(cap?.edits) ? cap.edits : [];
    const keptEdits = edits.filter((e) => !dropFiles.has(e?.file));
    const files = row.filesChanged || [];
    const keptFiles = files.filter((f) => !dropFiles.has(f));
    const { text: diff, dropped: droppedSections } = dropSections(row.diff || '', dropFiles);

    const droppedEdits = edits.length - keptEdits.length;
    const droppedFilesList = files.filter((f) => dropFiles.has(f));
    // Gated on a section actually being REMOVED, never on the text getting
    // shorter: `dropSections` trims, so a clean row measured as "shrank" and
    // would have been rewritten — with `authoritative: true` on the payload,
    // that is a wholesale overwrite of a row with nothing wrong with it.
    if (droppedEdits === 0 && droppedFilesList.length === 0 && droppedSections.length === 0) continue;

    const counts = countDiff(diff);
    const before = {
      linesAdded: row.linesAdded || 0, linesRemoved: row.linesRemoved || 0,
      files: files.length, edits: edits.length,
    };
    const after = { ...counts, files: keptFiles.length, edits: keptEdits.length };
    if (after.linesAdded > before.linesAdded || after.linesRemoved > before.linesRemoved) continue;

    out.push({
      turnId: row.turnId,
      promptIndex: row.promptIndex,
      droppedFiles: [...new Set([...droppedFilesList, ...edits.filter((e) => dropFiles.has(e?.file)).map((e) => e.file)])],
      before,
      after,
      editsJson: JSON.stringify({ ...(cap || {}), edits: keptEdits }),
      filesChanged: keptFiles,
      diff,
    });
  }
  return out;
}

/** Files the session itself authored — every path in its own NON-merge commits.
 *  A file it wrote is never treated as foreign, even when a merge also carried
 *  changes to it; dropping that section would delete the session's own work. */
export function sessionAuthoredFiles(repoPath: string, shas: string[]): Set<string> {
  const files = new Set<string>();
  for (const sha of shas) {
    if (commitParents(repoPath, sha).length > 1) continue;
    const out = gitOrNull(['show', '--no-renames', '--name-only', '--format=', sha], { cwd: repoPath });
    for (const line of (out || '').split('\n')) {
      const f = line.trim();
      if (f) files.add(f);
    }
  }
  return files;
}

/** Read every merge among a session's commits, split into resolved vs absorbed. */
export function readMergeFacts(repoPath: string, shas: string[]): MergeFacts[] {
  const out: MergeFacts[] = [];
  for (const sha of shas) {
    const parents = commitParents(repoPath, sha);
    if (parents.length < 2) continue;
    const own = mergeOwnDiff(repoPath, sha);
    if (!own) continue;
    const vsFirst = gitOrNull(['diff', '--name-only', parents[0], sha], { cwd: repoPath });
    const firstParentFiles = vsFirst ? vsFirst.trim().split('\n').filter(Boolean) : [];
    const ownSet = new Set(own.filesChanged);
    out.push({
      sha,
      ownFiles: own.filesChanged,
      ownDiff: own.diff,
      absorbedFiles: firstParentFiles.filter((f) => !ownSet.has(f)),
    });
  }
  return out;
}

function storedFiles(pc: any): string[] {
  if (Array.isArray(pc.filesChanged)) return pc.filesChanged;
  if (typeof pc.filesChanged === 'string') {
    try { return JSON.parse(pc.filesChanged || '[]') || []; } catch { return []; }
  }
  return [];
}

export async function repairMergesCommand(
  sessionIdArg: string | undefined,
  opts: { apply?: boolean; repo?: string; headerOnly?: boolean; skipTurnRules?: boolean } = {},
): Promise<void> {
  const local = loadSessionState();
  const sessionId = sessionIdArg || local?.sessionId;
  if (!sessionId) {
    console.error('No session id given and no active session in this directory.');
    console.error('Usage: origin repair-merges <sessionId> [--apply]');
    process.exitCode = 1;
    return;
  }

  const resolved = (local && local.sessionId === sessionId)
    ? { transcriptPath: local.transcriptPath, repoPath: local.repoPath, agent: local.agentSlug }
    : findLocalSessionState(sessionId);
  const repoPath = opts.repo || resolved?.repoPath || process.cwd();

  let session: any;
  try {
    session = await api.getSession(sessionId);
  } catch (err: any) {
    console.error(`Could not read session ${sessionId} from the API: ${err?.message || err}`);
    process.exitCode = 1;
    return;
  }

  const stored: StoredTurn[] = (session.promptChanges || []).map((pc: any) => ({
    turnId: pc.turnId,
    promptIndex: pc.promptIndex,
    promptText: pc.promptText || '',
    linesAdded: pc.linesAdded || 0,
    linesRemoved: pc.linesRemoved || 0,
    files: storedFiles(pc),
    commitShas: [
      ...(Array.isArray(pc.commitShas) ? pc.commitShas : []),
      ...(pc.commitSha ? [pc.commitSha] : []),
    ].filter(Boolean),
    hasEdits: !!(pc.editsJson && String(pc.editsJson).length > 2),
  }));

  // Every sha the session is associated with, so a merge is found whether the
  // row carries it or only the session-level diff does.
  const sessionShas = Array.from(new Set<string>([
    ...stored.flatMap((s) => s.commitShas),
    ...((session.commits || []).map((c: any) => c.sha).filter(Boolean)),
    ...((session.sessionDiff?.commitShas) || []),
  ]));

  const merges = readMergeFacts(repoPath, sessionShas);
  if (merges.length === 0) {
    console.log(`Session ${sessionId}: no merge commits among its ${sessionShas.length} commit(s) in ${repoPath}.`);
    console.log('Nothing this command can repair.');
    return;
  }

  // Transcript evidence for rule B, when we can get it.
  let editedFilesByTurn: Map<number, string[]> | null = null;
  const transcriptPath = resolved?.transcriptPath;
  if (transcriptPath && fs.existsSync(transcriptPath)) {
    try {
      const agent = (resolved?.agent === 'cursor' ? 'cursor' : 'claude') as 'claude' | 'cursor';
      const captures = capturePromptEdits({ agent, repoPath, transcriptPath, sessionCommitShas: [] });
      editedFilesByTurn = new Map(
        captures.map((c) => [c.promptIndex, Array.from(new Set(c.edits.map((e) => e.file)))]),
      );
    } catch (err: any) {
      console.log(`  (transcript unreadable: ${err?.message || err} — rule B disabled)`);
    }
  }

  // Rule A reads the row's OWN commitShas, so it is only as good as the
  // server's commit-to-turn attribution. When that attribution is itself
  // suspect — a stale attestation re-attaching a merge to the wrong turn after
  // a repair, as happened to f7881a6e idx 1 — `--header-only` lets the session
  // aggregate be corrected without acting on it.
  // Rule A/B INFER what a row should say. Stripping merge-absorbed files out of
  // a stored capture does not — it removes named files git proves came from
  // another branch. So the two are separable, and on a session whose commit
  // attribution has gone bad the inference is the half you want to skip.
  const skipTurnRules = opts.headerOnly || opts.skipTurnRules;
  const plan = skipTurnRules
    ? {
      repairs: [] as MergeRepair[],
      skipped: [{
        promptIndex: -1,
        reason: opts.headerOnly
          ? '--header-only: turn rows left alone'
          : '--skip-turn-rules: captures cleaned, but no row rewritten from inference',
      }],
    }
    : planMergeRepairs(stored, merges, editedFilesByTurn);

  // The session HEADER is a separate stored surface from the per-turn rows —
  // fixing the rows leaves it untouched. Foreign = arrived with a merge, minus
  // anything the merge resolved, minus anything the session itself authored.
  const authored = sessionAuthoredFiles(repoPath, sessionShas);
  const foreign = new Set<string>();
  for (const m of merges) for (const f of m.absorbedFiles) foreign.add(f);
  for (const m of merges) for (const f of m.ownFiles) foreign.delete(f);
  for (const f of authored) foreign.delete(f);
  const editsRepairs = opts.headerOnly
    ? []
    : planEditsJsonRepair(
      (session.promptChanges || []).map((pc: any) => ({
        turnId: pc.turnId, promptIndex: pc.promptIndex, editsJson: pc.editsJson,
        diff: pc.diff, filesChanged: storedFiles(pc),
        linesAdded: pc.linesAdded, linesRemoved: pc.linesRemoved,
      })),
      foreign,
    );
  const storedSessionDiff = session.sessionDiff || {};
  const headerPlan = planSessionDiffRepair(
    storedSessionDiff.diff || '',
    { linesAdded: storedSessionDiff.linesAdded || 0, linesRemoved: storedSessionDiff.linesRemoved || 0 },
    foreign,
  );

  console.log(`Session ${sessionId} — ${stored.length} stored turns, ${merges.length} merge commit(s)\n`);
  for (const m of merges) {
    console.log(`  merge ${m.sha.slice(0, 8)}: resolved ${m.ownFiles.length} file(s)`
      + `${m.ownFiles.length ? ` (${m.ownFiles.join(', ')})` : ''}`
      + `, absorbed ${m.absorbedFiles.length}`
      + `${m.absorbedFiles.length ? ` (${m.absorbedFiles.join(', ')})` : ''}`);
  }
  console.log('');

  for (const s of plan.skipped) {
    console.log(s.promptIndex < 0 ? `  ${s.reason}` : `  turn ${s.promptIndex}: skipped — ${s.reason}`);
  }
  if (plan.skipped.length > 0 && (plan.repairs.length > 0 || headerPlan)) console.log('');

  if (plan.repairs.length === 0 && !headerPlan && editsRepairs.length === 0) {
    console.log('Nothing to repair.');
    return;
  }

  for (const r of plan.repairs) {
    console.log(
      `  turn ${r.promptIndex}: +${r.before.linesAdded}/-${r.before.linesRemoved} (${r.before.files} files)`
      + `  ->  +${r.after.linesAdded}/-${r.after.linesRemoved} (${r.after.files} files)   [${r.rule}]`,
    );
    console.log(`      ${r.why}`);
  }

  if (editsRepairs.length > 0) {
    if (plan.repairs.length > 0) console.log('');
    console.log('  stored captures carrying merge-absorbed work:');
    for (const e of editsRepairs) {
      console.log(
        `    turn ${e.promptIndex}: +${e.before.linesAdded}/-${e.before.linesRemoved}`
        + ` (${e.before.files} files, ${e.before.edits} edits)  ->  +${e.after.linesAdded}/-${e.after.linesRemoved}`
        + ` (${e.after.files} files, ${e.after.edits} edits)`,
      );
      console.log(`        dropping ${e.droppedFiles.join(', ')}`);
    }
  }

  if (headerPlan) {
    if (plan.repairs.length > 0 || editsRepairs.length > 0) console.log('');
    console.log(
      `  session header: +${headerPlan.before.linesAdded}/-${headerPlan.before.linesRemoved}`
      + ` (${headerPlan.before.sections} sections)  ->  +${headerPlan.after.linesAdded}/-${headerPlan.after.linesRemoved}`
      + ` (${headerPlan.after.sections} sections)`,
    );
    console.log(`      dropping ${headerPlan.droppedFiles.length} file(s) that arrived with a merge and`
      + ' were authored on the other side:');
    for (const f of headerPlan.droppedFiles) console.log(`        ${f}`);
  }

  if (!opts.apply) {
    const bits = [
      plan.repairs.length > 0 ? `${plan.repairs.length} corrected turn${plan.repairs.length === 1 ? '' : 's'}` : '',
      editsRepairs.length > 0 ? `${editsRepairs.length} cleaned capture${editsRepairs.length === 1 ? '' : 's'}` : '',
      headerPlan ? 'the corrected session header' : '',
    ].filter(Boolean);
    console.log(`\nDry run — pass --apply to send ${bits.join(' and ')}.`);
    return;
  }

  const captureStamp = newCaptureStamp('mr');
  // `authoritative` is the ONLY thing that makes the server replace the whole
  // row. A real editsJson normally does it, but a repair that removes edits can
  // leave zero — and a zero-edit capture is deliberately NOT authoritative, so
  // the stale diff and filesChanged would keep rendering underneath. This is an
  // explicit producer claim: what is sent here IS the complete record.
  const editsChanges = editsRepairs.map((e) => ({
    ...captureStamp,
    ...(e.turnId ? { turnId: e.turnId } : {}),
    promptIndex: e.promptIndex,
    authoritative: true,
    editsJson: e.editsJson,
    filesChanged: e.filesChanged,
    diff: e.diff,
    linesAdded: e.after.linesAdded,
    linesRemoved: e.after.linesRemoved,
  }));
  const promptChanges = plan.repairs.map((r) => ({
    ...captureStamp,
    ...(r.turnId ? { turnId: r.turnId } : {}),
    promptIndex: r.promptIndex,
    filesChanged: r.filesChanged,
    diff: r.diff,
    uncommittedDiff: '',
    linesAdded: r.after.linesAdded,
    linesRemoved: r.after.linesRemoved,
    // An empty editsJson is the explicit "this turn's captured edits are
    // nothing", which is what makes the server replace the stored row instead
    // of merging the merge's content back in.
    editsJson: JSON.stringify({ edits: [] }),
    ...(r.chatOnly ? { chatOnly: true } : {}),
  }));

  // `snapshot: true` is what makes the server REPLACE the SessionDiff wholesale
  // instead of appending (mcp.ts: `shouldReplace = isSnapshot || sameBaseline`),
  // and the same write SETs the session's own linesAdded/linesRemoved from it —
  // so one payload heals both the Full Session Diff and the header counters.
  // headBefore/headAfter/commitShas are carried over unchanged: this repair
  // corrects the diff TEXT, and nothing else about the session's shape.
  const gitCapture = headerPlan
    ? {
      headBefore: storedSessionDiff.headBefore || '',
      headAfter: storedSessionDiff.headAfter || '',
      commitShas: storedSessionDiff.commitShas || [],
      diff: headerPlan.diff,
      linesAdded: headerPlan.after.linesAdded,
      linesRemoved: headerPlan.after.linesRemoved,
      snapshot: true as const,
    }
    : undefined;

  try {
    await api.updateSession(sessionId, {
      ...(promptChanges.length + editsChanges.length > 0
        ? { promptChanges: [...promptChanges, ...editsChanges] }
        : {}),
      ...(gitCapture ? { gitCapture } : {}),
    } as any);
    const sent = [
      promptChanges.length > 0 ? `${promptChanges.length} corrected turn${promptChanges.length === 1 ? '' : 's'}` : '',
      editsChanges.length > 0 ? `${editsChanges.length} cleaned capture${editsChanges.length === 1 ? '' : 's'}` : '',
      gitCapture ? 'the corrected session header' : '',
    ].filter(Boolean);
    console.log(`\nSent ${sent.join(' and ')}.`);
  } catch (err: any) {
    console.error(`\nPATCH failed: ${err?.message || err}`);
    process.exitCode = 1;
  }
}
