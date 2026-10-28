import { execFileSync } from 'child_process';
import crypto from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { listActiveSessions } from './session-state.js';
import { readAcceptanceNote } from './acceptance.js';
import { gitIdentityEnv } from './utils/exec.js';
import { shouldIgnoreFile, isLockfile, isOriginAutoManagedPath } from './ignore-patterns.js';
import { gitDetailed } from './utils/exec.js';
import { mandatoryAlignment } from './line-alignment.js';
import {
  MAX_FILE_BYTES,
  MAX_FILE_LINES,
  ProjectionTimeout,
  checkDeadline,
  createProjectionDeadline,
  gitTimeoutMs,
  isCanonicalRepoPath,
  withinBounds,
  type ProjectionDeadline,
} from './attribution-line-ranges.js';
import {
  REANCHOR_BUDGET_MS,
  commitRecordIdentity,
  contributionIdentity,
  linesOf,
  matchSourceClaim,
  parseBlameIncremental,
  recordViewReason,
  resolveFileAtRevision,
  resolveFilesAtRevision,
  sourceRecordView,
  type BlameOrigin,
  type BlameOriginWithoutContent,
  type NoteSnapshotEntry,
  type SourceLineRange,
  type SourceRecordView,
  type ContributionIdentity,
  type FileReanchorFailure,
  type LineReanchorReason,
  type ReanchoredLineClaim,
} from './attribution-line-reanchor.js';
import { BatchTooLarge, GitBatchError, catFileCheck, gitWithin, noteBlobs, readBlobs, readObjects, type ObjectInfo } from './git-object-batch.js';

// ─── Tool Detection ──────────────────────────────────────────────────────

function detectToolFromModel(model: string, fallbackTool?: string): string {
  const m = (model || '').toLowerCase();
  if (m.includes('claude') || m.includes('sonnet') || m.includes('opus') || m.includes('haiku')) return 'claude-code';
  if (m.includes('gemini') || m.includes('gemma')) return 'gemini-cli';
  if (m.includes('gpt') || m.includes('o1-') || m.includes('o3-') || m.includes('o4-')) return 'cursor';
  if (m.includes('codex')) return 'codex';
  if (m.includes('devin') || m.includes('windsurf') || m.includes('cascade')) return 'devin';
  if (m.includes('copilot')) return 'copilot';
  if (m.includes('continue')) return 'continue';
  if (m.includes('amp')) return 'amp';
  if (m.includes('junie')) return 'junie';
  if (m.includes('opencode')) return 'opencode';
  if (m.includes('aider')) return 'aider';
  if (m.includes('rovo')) return 'rovo';
  if (m.includes('droid')) return 'droid';
  return fallbackTool || 'ai';
}

// ─── Types ────────────────────────────────────────────────────────────────

/**
 * `ai` — AI work, in one of two tiers named by `LineAttribution.confidence`
 *        (see AttributionConfidence). Totals of `ai` count both tiers.
 * `human` — only under HUMAN_WHEN_NO_AI_EVIDENCE (see `classifyBlamedCommits`).
 * `unknown` — everything else: no evidence either way. Never counted as human.
 * `mixed` — kept for the type's older readers; line blame never produces it.
 */
export type LineAuthorship = 'ai' | 'human' | 'mixed' | 'unknown';

/**
 * How an `ai` line is known (OR-46 CR1).
 *
 * `line`   — a canonical v1 line claim re-anchored onto this line: strict
 *            blame, the exact source record and a mandatory alignment agree.
 *            The only line proof. Shown as `[AI]`.
 * `commit` — nothing proves this line, but the commit strict blame names for
 *            it carries AI evidence (a commit-level record, a legacy note, a
 *            trailer or agent pattern, an active session that recorded this
 *            exact commit). Shown as `[AI~]`. Never a line claim: no gate that needs a proven
 *            session or line may accept it (isLineProvenAttribution).
 */
export type AttributionConfidence = 'line' | 'commit';

/** Why a line is `unknown`. Never carries content. */
export type LineUnknownReason = LineReanchorReason | FileReanchorFailure;

/** What every line attribution carries, whatever its authorship. */
interface LineAttributionBase {
  lineNumber: number;
  /** Set exactly when `authorship` is `unknown`. */
  unknownReason?: LineUnknownReason;
  /** The proven claim's iteration (prompt), when the record names one. `line` confidence only. */
  iterationIndex?: number;
  // For `line` confidence: the canonical claim's session. For `commit`
  // confidence: set only when the commit's evidence names exactly one
  // session — never picked out of several, never a proven line session.
  sessionId?: string;
  // Model name from the Origin git note, e.g. "gpt-5.5", "claude-opus-4".
  model?: string;
  // Agent slug from the Origin git note, e.g. "codex", "claude-code",
  // "cursor", "gemini". Independent of model — answers "which tool", not
  // "which underlying LLM". Surfaced in `origin blame` output.
  agent?: string;
  // Git author of the commit (the human who ran the session). For AI
  // lines this is the human who launched the agent; for human lines it
  // IS the author.
  author?: string;
  tool?: string;
  // The commit strict blame names for the line: for an `ai` line, the
  // revision whose record holds the claim. Absent for an uncommitted line.
  commitSha?: string;
}

/**
 * An `ai` line always names its tier; no other line carries one. A missing
 * confidence is a type error, never a silent `[AI~]`.
 */
export type LineAttribution =
  | (LineAttributionBase & { authorship: 'ai'; confidence: AttributionConfidence })
  | (LineAttributionBase & { authorship: Exclude<LineAuthorship, 'ai'>; confidence?: never });

/**
 * A line of one of the two AI tiers. `aiLines` totals count both; the split
 * says how many of them are proven.
 */
export interface AiConfidenceSplit {
  /** `ai` lines with `confidence: 'line'`: canonical line proof. */
  lineProvenAiLines: number;
  /** `ai` lines with `confidence: 'commit'`: commit-level evidence only. */
  commitConfidenceAiLines: number;
}

/**
 * The strict gate: a canonical line claim proves this line. Every consumer
 * that needs a proven session, prompt, line identity or acceptance fate uses
 * this, never `authorship === 'ai'` (which also holds for `commit` confidence).
 */
export function isLineProvenAttribution(line: Pick<LineAttribution, 'authorship' | 'confidence'>): boolean {
  return line.authorship === 'ai' && line.confidence === 'line';
}

/** AI by commit-level evidence only: `[AI~]`, never a line claim. */
export function isCommitConfidenceAttribution(line: Pick<LineAttribution, 'authorship' | 'confidence'>): boolean {
  return line.authorship === 'ai' && line.confidence === 'commit';
}

/** The two AI tiers of `lines`, counted apart. */
export function aiConfidenceSplit(lines: ReadonlyArray<Pick<LineAttribution, 'authorship' | 'confidence'>>): AiConfidenceSplit {
  let lineProvenAiLines = 0;
  let commitConfidenceAiLines = 0;
  for (const l of lines) {
    if (isLineProvenAttribution(l)) lineProvenAiLines++;
    else if (isCommitConfidenceAttribution(l)) commitConfidenceAiLines++;
  }
  return { lineProvenAiLines, commitConfidenceAiLines };
}

export interface FileAttribution extends AiConfidenceSplit {
  filePath: string;
  lines: LineAttribution[];
  totalLines: number;
  /** Both AI tiers together; see AiConfidenceSplit for the split. */
  aiLines: number;
  humanLines: number;
  mixedLines: number;
  unknownLines: number;
  aiPercentage: number;
  humanPercentage: number;
  mixedPercentage: number;
  unknownPercentage: number;
}

export interface CommitAttribution extends AiConfidenceSplit {
  commitSha: string;
  files: FileAttribution[];
  totalLines: number;
  /** Both AI tiers together; see AiConfidenceSplit for the split. */
  aiLines: number;
  humanLines: number;
  mixedLines: number;
  unknownLines: number;
  aiPercentage: number;
  humanPercentage: number;
  mixedPercentage: number;
  unknownPercentage: number;
}

export interface AcceptanceMetrics {
  totalAiLines: number;
  acceptedLines: number;
  overriddenLines: number;
  deletedLines: number;
  /** Tracked lines whose current line has no proof either way: neither accepted nor overridden. */
  unknownLines: number;
  /**
   * accepted / (tracked − unknown), deletions still counted: unknown is never
   * evidence either way. Null when nothing tracked has a known fate.
   */
  acceptanceRate: number | null;
  /**
   * Set when the claims of the range exceed the tracking bounds: every count
   * is then zero and the rate null — the figures are unavailable, not partial.
   */
  unavailable?: TrackingUnavailableReason;
}

export interface MoveDetection {
  oldPath: string;
  newPath: string;
  similarity: number;
}

// ─── Git Helpers ──────────────────────────────────────────────────────────

const execOpts = (cwd: string) => ({
    windowsHide: true,
  // `git notes add` builds an object and needs an identity; supply Origin's
  // only when the box has none (see gitIdentityEnv).
  env: { ...process.env, ...gitIdentityEnv(cwd) },
  encoding: 'utf-8' as const,
  cwd,
  stdio: ['pipe', 'pipe', 'pipe'] as ['pipe', 'pipe', 'pipe'],
  maxBuffer: 10 * 1024 * 1024,
});

/**
 * Read Origin note data from a commit.
 */
function readOriginNote(repoPath: string, commitSha: string): Record<string, any> | null {
  try {
    const note = execFileSync('git', ['notes', '--ref=origin', 'show', commitSha], execOpts(repoPath)).trim();
    return JSON.parse(note);
  } catch {
    return null;
  }
}

/**
 * Does an unwrapped legacy note claim AI work on its commit? A session note
 * names its session; a backfill note names only an agent; a squash aggregate
 * of several sessions (OR-11) names no single one — its `sessionIds` are the
 * claim, and no reader may pick one of them as the commit's owner.
 */
export function isAiNote(note: Record<string, any> | null | undefined): boolean {
  if (!note) return false;
  if (note.sessionId && note.sessionId !== 'unknown') return true;
  if (note.agent && note.agent !== 'Human') return true;
  return note.squashMerge === true && Array.isArray(note.sessionIds)
    && note.sessionIds.some((id: unknown) => typeof id === 'string' && !!id && id !== 'unknown');
}

/**
 * Check if a commit has an Origin-Session trailer or note.
 */
export function isAiCommit(repoPath: string, commitSha: string): boolean {
  // Check git notes (stored as { origin: { sessionId, ... } })
  const rawNote = readOriginNote(repoPath, commitSha);
  const note = rawNote?.origin || rawNote;
  // Session notes, backfill notes (agent, no sessionId), squash aggregates.
  if (isAiNote(note)) return true;

  // Check commit message for Origin-Session trailer
  try {
    const message = execFileSync('git', ['log', '-1', '--format=%B', commitSha], execOpts(repoPath)).trim();
    if (message.includes('Origin-Session:')) return true;
  } catch {
    // ignore
  }

  // Check if commit falls within an active session's range
  // (notes haven't been written yet because session is still running)
  try {
    const activeSessions = listActiveSessions(repoPath);
    for (const session of activeSessions) {
      if (session.headShaAtStart) {
        // Check if commitSha is an ancestor of HEAD and descendant of headShaAtStart
        try {
          execFileSync('git', ['merge-base', '--is-ancestor', session.headShaAtStart, commitSha], execOpts(repoPath));
          // If we get here, commitSha is after session start — it's an AI commit
          return true;
        } catch {
          // Not an ancestor — commit is before session start
        }
      }
    }
  } catch {
    // Non-fatal
  }

  return false;
}

/**
 * Get the session start SHA from a commit's origin note.
 */
function getSessionBaseSha(repoPath: string, commitSha: string): string | null {
  const note = readOriginNote(repoPath, commitSha);
  if (!note) return null;
  // Look for headBefore in various note formats
  return note.headBefore || note.headShaAtStart || null;
}

/**
 * Detect AI authorship from commit message trailers or known patterns.
 * Fallback when no origin note exists for a commit.
 */
function detectAiFromCommit(repoPath: string, commitSha: string): { isAi: boolean; model?: string } | null {
  // Skip uncommitted lines (all zeros)
  if (commitSha === '0000000000000000000000000000000000000000') return null;
  try {
    return detectAiFromMessage(execFileSync('git', ['log', '-1', '--format=%B', commitSha], execOpts(repoPath)));
  } catch {
    return null;
  }
}

/** The commit-message half of `detectAiFromCommit`: trailers and known agent patterns. */
function detectAiFromMessage(rawMessage: string): { isAi: boolean; model?: string } | null {
  const message = rawMessage.trim();

  // Check Origin-Session trailer
  if (message.includes('Origin-Session:')) {
    // Try to extract model from Origin-Model trailer
    const modelMatch = message.match(/Origin-Model:\s*(.+)/);
    return { isAi: true, model: modelMatch?.[1]?.trim() };
  }

  // Detect common AI agent commit patterns
  const lowerMsg = message.toLowerCase();

  // Gemini CLI: often uses specific patterns
  if (lowerMsg.includes('generated by gemini') || lowerMsg.includes('gemini:')) {
    return { isAi: true, model: 'gemini' };
  }

  // Claude Code: co-authored-by trailer
  if (message.includes('Co-Authored-By:') && message.toLowerCase().includes('claude')) {
    return { isAi: true, model: 'claude' };
  }

  // Cursor / Copilot patterns
  if (lowerMsg.includes('generated by cursor') || lowerMsg.includes('cursor:')) {
    return { isAi: true, model: 'cursor' };
  }

  // Codex CLI: uses "-" as the default commit message
  if (message.trim() === '-') {
    return { isAi: true, model: 'codex' };
  }

  // Co-Authored-By patterns for other AI agents
  if (message.includes('Co-Authored-By:') || message.includes('co-authored-by:')) {
    const coAuthor = message.match(/[Cc]o-[Aa]uthored-[Bb]y:\s*(.+)/);
    const coAuthorName = coAuthor?.[1]?.toLowerCase() || '';
    if (coAuthorName.includes('codex') || coAuthorName.includes('openai')) {
      return { isAi: true, model: 'codex' };
    }
    if (coAuthorName.includes('copilot') || coAuthorName.includes('github')) {
      return { isAi: true, model: 'copilot' };
    }
    if (coAuthorName.includes('gemini') || coAuthorName.includes('google')) {
      return { isAi: true, model: 'gemini' };
    }
    // Generic AI co-author
    if (coAuthorName.includes('ai') || coAuthorName.includes('bot') || coAuthorName.includes('noreply')) {
      return { isAi: true, model: undefined };
    }
  }

  return null;
}

// Rich session context surfaced from per-commit origin notes — used by
// `origin blame --json` so consumers can answer "what was the prior agent
// trying to do here?" without having to parse git notes themselves.
export interface SessionContext {
  sessionId: string;
  model?: string;
  agent?: string;
  fullPrompt?: string;
  promptSummary?: string;
  previousSessionId?: string;
  filesRead?: string[];
  // Fraction (0..1) of this session's added lines still present on HEAD.
  // Sourced from refs/notes/origin-acceptance, written by the *next* session.
  acceptanceRate?: number;
  acceptanceComputedAt?: string;
  originUrl?: string;
}

export function getSessionContextForCommit(
  repoPath: string,
  commitSha: string,
): SessionContext | null {
  const rawNote = readOriginNote(repoPath, commitSha);
  const note = rawNote?.origin || rawNote;
  if (!note?.sessionId) return null;

  const acc = readAcceptanceNote(repoPath, commitSha);

  return {
    sessionId: note.sessionId,
    model: note.model,
    agent: note.agent,
    fullPrompt: note.fullPrompt,
    promptSummary: note.promptSummary,
    previousSessionId: note.previousSessionId,
    filesRead: Array.isArray(note.filesRead) ? note.filesRead : undefined,
    acceptanceRate: acc?.acceptanceRate,
    acceptanceComputedAt: acc?.computedAt,
    originUrl: note.originUrl,
  };
}

// ─── Line-Level Attribution ──────────────────────────────────────────────
//
// A line's authorship comes in tiers, and a tier is never inferred from a
// weaker one (OR-46, CR1):
//
//   • `ai`, confidence `line` — a canonical v1 line claim survives into the
//     viewed file (attribution-line-reanchor.ts: strict blame + the exact
//     source record + a mandatory line alignment). Nothing else is line proof.
//   • `ai`, confidence `commit` — no line proof, but the commit strict blame
//     names for the line carries AI evidence (classifyBlamedCommits). A valid
//     line-level record of that commit that does NOT cover the blamed line is
//     more precise than any other evidence of the commit: that line stays
//     `unknown` (`no_line_claim`), whatever the legacy payload or the message.
//   • `human` only under HUMAN_WHEN_NO_AI_EVIDENCE.
//   • `unknown` otherwise, with a reason. Absence of a claim is not human.
//
// View contract. Proof is always computed on one exact commit — HEAD of the
// working tree the caller names, or `revision` for a commit view — against
// that commit's blob:
//
//   • 'head'     — lines are numbered in the commit's blob, and `text` IS that
//     blob. `revision` (default HEAD) picks the commit.
//   • 'worktree' — lines are numbered in the file on disk, and `text` IS the
//     disk text those numbers refer to. A disk line takes the answer of the
//     HEAD line that every optimal alignment of HEAD's blob onto the disk text
//     pairs it with; any other disk line (edited, added, ambiguous) is
//     `unknown` / `uncommitted`. HEAD's answer is never shown against a line
//     of different text.
//
// One budget covers a call, spent in phases whose answers are final once
// given. The strict resolver and the dirty-file alignment come first: running
// out there leaves every line `unknown` / `timeout` — no proof was shown yet.
// Commit evidence comes last: running out there keeps every proven line and
// every commit already classified; only lines still pending become
// `unknown` / `timeout`.
//
// A text file past the OR-45 line-proof bounds (MAX_FILE_LINES /
// MAX_FILE_BYTES) takes a bounded commit-only path instead
// (commitOnlyResolution): no alignment, never `line` confidence, the same
// commit evidence, explicit caps (COMMIT_ONLY_LIMITS).

export type LineBlameView = 'head' | 'worktree';

export interface LineAttributionResolution {
  view: LineBlameView;
  /** The HEAD commit the proof was computed on; null on an unborn branch. */
  revision: string | null;
  /** Repo-relative POSIX path. */
  path: string;
  /** The text whose lines `lines` number — HEAD's blob or the disk file, per `view`. */
  text: string;
  lines: LineAttribution[];
  /**
   * Parallel to `lines` (same length): the strict-blame origin of each line,
   * where a line's history starts. Null for an uncommitted line, a disk line
   * no HEAD line stands for, an unsafe origin, or a file answered before
   * blame. Presentation only: never part of a line's attribution or its JSON.
   */
  historyAnchors: Array<HistoryAnchor | null>;
}

/** A line's own coordinate in the commit strict blame names for it. */
export interface HistoryAnchor {
  revision: string;
  path: string;
  line: number;
}

function historyAnchorOf(o: { sourceRevision: string; sourcePath: string | null; sourceLine: number } | null | undefined): HistoryAnchor | null {
  if (!o || !/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(o.sourceRevision) || /^0+$/.test(o.sourceRevision)) return null;
  if (o.sourcePath === null || !isCanonicalRepoPath(o.sourcePath)) return null;
  if (!Number.isSafeInteger(o.sourceLine) || o.sourceLine < 1) return null;
  return { revision: o.sourceRevision, path: o.sourcePath, line: o.sourceLine };
}

/** Caps of the commit-only path for files past the line-proof bounds. */
export interface CommitOnlyLimits {
  /** Bytes of a HEAD blob read for the 'head' view; past it there is no view. */
  maxTextBytes: number;
  /** Lines of the viewed text; past it every line is `unknown` / `oversized`. */
  maxLines: number;
  /** Bytes of `blame --incremental` output; past it every line is `unknown`. */
  maxBlameBytes: number;
}

export const COMMIT_ONLY_LIMITS: Readonly<CommitOnlyLimits> = {
  maxTextBytes: 32 * 1024 * 1024,
  maxLines: 200_000,
  maxBlameBytes: 16 * 1024 * 1024,
};

export interface LineBlameOptions {
  /** Default 'worktree'. */
  view?: LineBlameView;
  /** Wall-clock budget of the whole call. Default REANCHOR_BUDGET_MS. */
  budgetMs?: number;
  /** An absolute deadline instead of `budgetMs` (a caller sharing one budget, or a test clock). */
  deadline?: ProjectionDeadline;
  /** 'head' view only: the commit to view instead of HEAD (any commit-ish git resolves). */
  revision?: string;
  /** Tighter caps for the commit-only path of large files (default COMMIT_ONLY_LIMITS). */
  commitOnlyLimits?: Partial<CommitOnlyLimits>;
}

/** The budget a pre-tool-use hook gives a file's attribution: hooks must not stall the agent. */
export const LINE_BLAME_HOOK_BUDGET_MS = 1_500;

function gitLine(args: string[], cwd: string, deadline: ProjectionDeadline): string | null {
  const r = gitDetailed(args, { cwd, timeoutMs: gitTimeoutMs(deadline, 10_000) });
  checkDeadline(deadline);
  const out = r.stdout.trim();
  return r.status === 0 && out ? out : null;
}

function realpathOrNull(p: string): string | null {
  try { return fs.realpathSync(p); } catch { return null; }
}

/** `filePath` (absolute, or relative to `repoPath`) as a POSIX path relative to `top`; null outside it. */
function repoRelativePath(top: string, repoPath: string, filePath: string): string | null {
  const abs = path.resolve(repoPath, filePath);
  const dir = realpathOrNull(path.dirname(abs));
  const absReal = realpathOrNull(abs) ?? (dir ? path.join(dir, path.basename(abs)) : abs);
  const rel = path.relative(realpathOrNull(top) ?? top, absReal);
  if (!rel || rel === '..' || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel)) return null;
  return rel.split(path.sep).join('/');
}

/** What the HEAD resolution says about one HEAD line. */
type HeadLine =
  | { kind: 'claim'; claim: ReanchoredLineClaim; origin: BlameOrigin | undefined }
  | { kind: 'unknown'; reason: LineUnknownReason; origin: BlameOrigin | undefined };

function headLinesOf(resolved: ReturnType<typeof resolveFileAtRevision>, count: number): HeadLine[] {
  const { result, origins } = resolved;
  const originAt = (line: number) => origins?.[line - 1];
  if (result.status === 'failed') {
    const reason = result.failure ?? 'internal_error';
    return Array.from({ length: count }, (_, k) => ({ kind: 'unknown' as const, reason, origin: originAt(k + 1) }));
  }
  const out: HeadLine[] = Array.from({ length: count }, (_, k) => ({ kind: 'unknown' as const, reason: 'internal_error' as const, origin: originAt(k + 1) }));
  for (const u of result.unresolved) {
    for (let l = u.start_line; l <= u.end_line; l++) out[l - 1] = { kind: 'unknown', reason: u.reason, origin: originAt(l) };
  }
  for (const c of result.claims) {
    for (let l = c.start_line; l <= c.end_line; l++) out[l - 1] = { kind: 'claim', claim: c, origin: originAt(l) };
  }
  return out;
}

// ─── Commit evidence (the `commit` tier and the human policy) ────────────

/**
 * A line the strict phase did not prove, waiting for the evidence of the
 * commit strict blame names for it.
 */
interface PendingLine {
  /** 0-based index of the output line. */
  index: number;
  /** Why the line has no line proof. */
  reason: LineUnknownReason;
  /** The blamed commit's line-level record claims the blamed source line, but the claim did not re-anchor. */
  covered: boolean;
  origin: BlameOriginWithoutContent | undefined;
}

/**
 * Reasons whose line has a source the blamed commit's line-level record
 * claims, though the claim did not survive the re-anchor (repeated content,
 * several contributions on the line, an unreadable source blob). The commit
 * evidence of that record holds for them; the line claim does not.
 */
const COVERED_REASONS: ReadonlySet<LineUnknownReason> = new Set<LineUnknownReason>([
  'ambiguous_claim', 'ambiguous_alignment', 'duplicate_source', 'source_unreadable', 'source_oversized',
]);

/**
 * Reasons that leave the line to the evidence of its commit as a whole: the
 * commit has no line-level record (none, legacy, commit-level, unusable).
 * Every other reason — `no_line_claim` first of all — is final.
 */
const COMMIT_EVIDENCE_REASONS: ReadonlySet<LineUnknownReason> = new Set<LineUnknownReason>([
  'no_record', 'commit_level', 'record_invalid', 'record_unsupported', 'record_wrong_revision',
]);

/** What a blamed commit as a whole says. */
export type CommitEvidence =
  /** AI evidence; identity fields only where unambiguous. */
  | { kind: 'ai'; identity: ContributionIdentity }
  /** No Origin AI evidence of any kind: HUMAN_WHEN_NO_AI_EVIDENCE applies. */
  | { kind: 'none' }
  /** Neither: a note that is not evidence, a check that failed or ran out (`reason`, when it did). */
  | { kind: 'unknown'; reason?: LineUnknownReason };

const FULL_COMMIT_SHA = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
const ZERO_COMMIT_SHA = /^0+$/;
/** Bytes of commit messages one call reads; past it the messages are unknown. */
const COMMIT_MESSAGE_BYTES = 16 * 1024 * 1024;
/** Bytes of the notes the commit-only path reads in one call. */
const COMMIT_ONLY_NOTE_BYTES = 32 * 1024 * 1024;

function isPlainRecord(v: unknown): v is Record<string, any> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/**
 * The identity a legacy Origin AI note gives its commit; null when the note
 * is not one (isAiNote). A squash aggregate of several sessions names no
 * session, agent or model: none is picked out of its list.
 */
function legacyAiIdentity(noteText: string): ContributionIdentity | null {
  let envelope: unknown;
  try { envelope = JSON.parse(noteText); } catch { return null; }
  if (!isPlainRecord(envelope)) return null;
  const note = isPlainRecord(envelope.origin) ? envelope.origin : envelope;
  if (!isAiNote(note)) return null;
  const valid = (id: unknown): id is string => typeof id === 'string' && !!id && id !== 'unknown';
  const sessions = new Set<string>([note.sessionId, ...(Array.isArray(note.sessionIds) ? note.sessionIds : [])].filter(valid));
  const out: ContributionIdentity = {};
  if (sessions.size > 1) return out;
  if (sessions.size === 1) out.sessionId = [...sessions][0];
  if (typeof note.agent === 'string' && note.agent && note.agent !== 'Human') out.agentId = note.agent;
  if (valid(note.model)) out.modelId = note.model;
  return out;
}

/** The identity an Origin-Session trailer or a known agent pattern gives its commit; null when there is none. */
function messageAiIdentity(message: string): ContributionIdentity | null {
  const detected = detectAiFromMessage(message);
  if (!detected?.isAi) return null;
  const out: ContributionIdentity = {};
  const sessions = new Set([...message.matchAll(/^Origin-Session:[ \t]*(\S+)[ \t]*$/gm)].map((m) => m[1]));
  if (sessions.size > 0) {
    if (sessions.size === 1) out.sessionId = [...sessions][0];
    if (detected.model) out.modelId = detected.model;
  } else if (detected.model) {
    // A pattern names the tool, not the model ("claude", "codex").
    const tool = detectToolFromModel(detected.model);
    out.agentId = tool === 'ai' ? detected.model : tool;
  }
  return out;
}

/**
 * Full messages of `shas`, one `git log --no-walk --stdin` call. A commit git
 * does not print is absent. Throws ProjectionTimeout when the budget runs out
 * and GitBatchError when the output cannot be framed or passes its cap.
 */
function commitMessages(top: string, shas: readonly string[], deadline: ProjectionDeadline): Map<string, string> {
  const out = new Map<string, string>();
  if (shas.length === 0) return out;
  const r = gitWithin(
    ['-c', 'log.showSignature=false', 'log', '--no-walk=unsorted', '--no-notes', '--stdin', '--format=%H%x00%B%x00'],
    { cwd: top, input: shas.join('\n') + '\n', capMs: 10_000, maxBuffer: COMMIT_MESSAGE_BYTES },
    deadline,
  );
  if (r.status !== 0) throw new GitBatchError('git log failed');
  const frame = /([0-9a-f]{40,64})\u0000([^\u0000]*)\u0000\n/y;
  let m: RegExpExecArray | null;
  let pos = 0;
  while ((m = frame.exec(r.stdout)) !== null) {
    out.set(m[1], m[2]);
    pos = frame.lastIndex;
  }
  if (pos !== r.stdout.length) throw new GitBatchError('git log unframed');
  return out;
}

/**
 * HUMAN_WHEN_NO_AI_EVIDENCE and the `commit` tier, for every blamed commit at
 * once. `noteOf` is the note snapshot the strict phase read (the same one its
 * claims were proven on), so a note is never re-read here. Precedence:
 *
 *   1. a valid canonical line-level record: AI evidence for its covered
 *      lines only (the caller never asks for an uncovered one);
 *   2. a valid canonical commit-level record with a contribution: AI;
 *   3. no canonical record at all: a legacy Origin AI note is AI;
 *   4. whatever the note: an Origin-Session trailer, a known agent commit
 *      pattern, or an active session whose state recorded this exact commit
 *      in sessionCommitShas is AI (several such sessions: no identity);
 *   5. otherwise `none` (human) only when the commit has no note at all; a
 *      note that is not evidence — unreadable, foreign, of another revision,
 *      unsupported, non-AI — leaves the commit `unknown`.
 *
 * The git work is one `log` for all commits that need their message — never
 * one call per commit; active sessions are read from their state. Never throws:
 * a commit decided before the budget runs out keeps its answer, and only the
 * commits still undecided become `unknown` / `timeout`.
 */
export function classifyBlamedCommits(
  top: string,
  shas: Iterable<string>,
  noteOf: (revision: string) => NoteSnapshotEntry | undefined,
  deadline: ProjectionDeadline,
): Map<string, CommitEvidence> {
  const out = new Map<string, CommitEvidence>();
  const wanted = [...new Set(shas)].filter((sha) => FULL_COMMIT_SHA.test(sha) && !ZERO_COMMIT_SHA.test(sha));
  const undecided = new Set<string>();
  const humanIfNothing = new Set<string>();

  // From the note snapshot alone: no git.
  for (const sha of wanted) {
    const entry = noteOf(sha);
    if (!entry) { out.set(sha, { kind: 'unknown', reason: 'internal_error' }); continue; }
    const { view, text } = entry;
    if (view.kind === 'line_claims' || view.kind === 'commit_level') {
      const identity = commitRecordIdentity(text, sha);
      if (identity) { out.set(sha, { kind: 'ai', identity }); continue; }
    } else if (view.kind === 'no_record') {
      if (text === null) {
        humanIfNothing.add(sha);
      } else {
        const identity = legacyAiIdentity(text);
        if (identity) { out.set(sha, { kind: 'ai', identity }); continue; }
      }
    }
    undecided.add(sha);
  }
  const giveUp = (reason?: LineUnknownReason) => {
    for (const sha of undecided) out.set(sha, { kind: 'unknown', ...(reason ? { reason } : {}) });
    undecided.clear();
  };
  const failure = (err: unknown): LineUnknownReason => (err instanceof ProjectionTimeout ? 'timeout' : 'internal_error');
  if (undecided.size === 0) return out;

  // Trailers and agent patterns, one call for every undecided commit.
  try {
    const messages = commitMessages(top, [...undecided], deadline);
    for (const sha of [...undecided]) {
      const message = messages.get(sha);
      if (message === undefined) { out.set(sha, { kind: 'unknown', reason: 'internal_error' }); undecided.delete(sha); continue; }
      const identity = messageAiIdentity(message);
      if (identity) { out.set(sha, { kind: 'ai', identity }); undecided.delete(sha); }
    }
  } catch (err) {
    giveUp(failure(err));
    return out;
  }
  if (undecided.size === 0) return out;

  // Active sessions: only a commit a session's own state recorded as one it
  // made (sessionCommitShas). Its start commit and whatever landed after it —
  // a pull, a merge, a colleague's work — is not its evidence. An entry counts
  // only as a full object id in either case, lowercased before it is deduped
  // and looked up; an abbreviated, overlong, non-hex or zero one never matches.
  const recordedSha = (sha: unknown): string | null => {
    if (typeof sha !== 'string') return null;
    const full = sha.toLowerCase();
    return FULL_COMMIT_SHA.test(full) && !ZERO_COMMIT_SHA.test(full) ? full : null;
  };
  const inSessions = new Map<string, Array<{ sessionId?: string; model?: string }>>();
  try {
    checkDeadline(deadline);
    for (const s of listActiveSessions(top)) {
      if (!Array.isArray(s.sessionCommitShas)) continue;
      const who = {
        sessionId: typeof s.sessionId === 'string' && s.sessionId ? s.sessionId : undefined,
        model: typeof s.model === 'string' && s.model ? s.model : undefined,
      };
      for (const sha of new Set(s.sessionCommitShas.map(recordedSha))) {
        if (sha && undecided.has(sha)) inSessions.set(sha, [...(inSessions.get(sha) ?? []), who]);
      }
    }
    checkDeadline(deadline);
  } catch (err) {
    // The states cannot be told: no commit left is AI, and none is human either.
    giveUp(err instanceof ProjectionTimeout ? 'timeout' : undefined);
    return out;
  }
  for (const sha of undecided) {
    const matched = inSessions.get(sha);
    if (matched) {
      const identity: ContributionIdentity = {};
      if (matched.length === 1) {
        if (matched[0].sessionId) identity.sessionId = matched[0].sessionId;
        if (matched[0].model) identity.modelId = matched[0].model;
      }
      out.set(sha, { kind: 'ai', identity });
    } else {
      out.set(sha, humanIfNothing.has(sha) ? { kind: 'none' } : { kind: 'unknown' });
    }
  }
  undecided.clear();
  return out;
}

/**
 * The answer of every pending line from its commit's evidence (see
 * classifyBlamedCommits). Never throws.
 */
function settlePendingLines(
  top: string,
  pending: readonly PendingLine[],
  noteOf: (revision: string) => NoteSnapshotEntry | undefined,
  deadline: ProjectionDeadline,
): Map<number, LineAttribution> {
  const out = new Map<number, LineAttribution>();
  const blamedOf = (p: PendingLine) => (p.origin && !ZERO_COMMIT_SHA.test(p.origin.sourceRevision) ? p.origin.sourceRevision : undefined);
  const asks = (p: PendingLine) => !!blamedOf(p) && (p.covered || COMMIT_EVIDENCE_REASONS.has(p.reason));
  let evidence: Map<string, CommitEvidence>;
  try {
    evidence = classifyBlamedCommits(top, pending.filter(asks).map((p) => blamedOf(p)!), noteOf, deadline);
  } catch {
    evidence = new Map();
  }
  for (const p of pending) {
    const lineNumber = p.index + 1;
    const author = p.origin?.author;
    const commitSha = blamedOf(p);
    const unknown = (reason: LineUnknownReason): LineAttribution => ({ lineNumber, authorship: 'unknown', unknownReason: reason, author, commitSha });
    if (!asks(p)) { out.set(p.index, unknown(p.reason)); continue; }
    const e = evidence.get(commitSha!) ?? { kind: 'unknown', reason: 'internal_error' };
    if (e.kind === 'ai') {
      const line: LineAttribution = { lineNumber, authorship: 'ai', confidence: 'commit', author, commitSha };
      if (e.identity.sessionId) line.sessionId = e.identity.sessionId;
      if (e.identity.modelId) line.model = e.identity.modelId;
      if (e.identity.agentId) { line.agent = e.identity.agentId; line.tool = e.identity.agentId; }
      out.set(p.index, line);
    } else if (e.kind === 'none' && p.reason === 'no_record' && !p.covered) {
      out.set(p.index, { lineNumber, authorship: 'human', author, commitSha });
    } else {
      out.set(p.index, unknown(e.kind === 'unknown' && e.reason ? e.reason : p.reason));
    }
  }
  return out;
}

/**
 * The commit-only path: a text file past the line-proof bounds, in the
 * coordinates of `view`. One `blame --incremental` (the disk text through
 * `--contents -` for the 'worktree' view, so lines are numbered in the very
 * text shown), one notes snapshot, then the same commit evidence as every
 * other line. Never `line` confidence: nothing is aligned here. Every cap is
 * explicit (CommitOnlyLimits); past one, every line is `unknown`. Null only
 * when the 'head' view has no readable blob within `maxTextBytes`.
 */
function commitOnlyResolution(args: {
  view: LineBlameView;
  top: string;
  rel: string;
  head: string;
  diskText: string | null;
  deadline: ProjectionDeadline;
  limits: CommitOnlyLimits;
}): LineAttributionResolution | null {
  const { view, top, rel, head, deadline, limits } = args;
  const answer = (text: string, lines: LineAttribution[], historyAnchors: Array<HistoryAnchor | null> = lines.map(() => null)): LineAttributionResolution =>
    ({ view, revision: head, path: rel, text, lines, historyAnchors });
  const allUnknown = (text: string, reason: LineUnknownReason) =>
    answer(text, linesOf(text).map((_, k) => ({ lineNumber: k + 1, authorship: 'unknown' as const, unknownReason: reason })));

  let text: string;
  if (view === 'worktree') {
    text = args.diskText!;
  } else {
    try {
      const read = readBlobs(top, [`${head}:${rel}`], { maxBytes: limits.maxTextBytes }, deadline).get(`${head}:${rel}`);
      if (read?.kind !== 'text') return null;
      text = read.text;
    } catch {
      return null;
    }
  }
  if (text.includes('\u0000')) return allUnknown(text, 'non_text');
  const textLines = linesOf(text);
  if (textLines.length > limits.maxLines || Buffer.byteLength(text, 'utf-8') > limits.maxTextBytes) return allUnknown(text, 'oversized');

  let origins: BlameOriginWithoutContent[];
  try {
    const r = gitWithin(
      ['-c', 'core.quotePath=false', 'blame', '--incremental', '--root', '--no-textconv', '--ignore-revs-file', '',
        ...(view === 'worktree' ? ['--contents', '-'] : [head]), '--', rel],
      { cwd: top, capMs: 15_000, maxBuffer: limits.maxBlameBytes, ...(view === 'worktree' ? { input: text } : {}) },
      deadline,
    );
    // A non-zero exit includes output past maxBlameBytes: nothing is read from it.
    if (r.status !== 0) return allUnknown(text, 'blame_unreadable');
    const parsed = parseBlameIncremental(r.stdout, textLines.length);
    if (!parsed.ok) return allUnknown(text, 'blame_malformed');
    origins = parsed.origins;
  } catch (err) {
    return allUnknown(text, err instanceof ProjectionTimeout ? 'timeout' : 'internal_error');
  }

  // The notes of every blamed commit: one snapshot, one bounded batch.
  const snapshot = new Map<string, NoteSnapshotEntry>();
  const revisions = [...new Set(origins.map((o) => o.sourceRevision).filter((sha) => !ZERO_COMMIT_SHA.test(sha)))];
  try {
    if (revisions.length > 0) {
      const listed = noteBlobs(top, 'refs/notes/origin', deadline);
      const ids = [...new Set(revisions.map((rev) => listed.get(rev)).filter((id): id is string => id !== undefined))];
      const reads = readBlobs(top, ids, { maxBytes: MAX_FILE_BYTES, totalBytes: COMMIT_ONLY_NOTE_BYTES }, deadline);
      for (const rev of revisions) {
        const id = listed.get(rev);
        const read = id === undefined ? undefined : reads.get(id);
        if (!read) { snapshot.set(rev, { view: { kind: 'no_record' }, text: null }); continue; }
        if (read.kind === 'missing' || read.kind === 'not_blob') throw new GitBatchError('a listed note is unreadable');
        snapshot.set(rev, read.kind === 'text'
          ? { view: sourceRecordView(read.text, rev), text: read.text }
          : { view: { kind: 'invalid' }, text: null });
      }
    }
  } catch (err) {
    return allUnknown(text, err instanceof ProjectionTimeout ? 'timeout' : 'internal_error');
  }

  const lines: LineAttribution[] = new Array(origins.length);
  const pending: PendingLine[] = [];
  origins.forEach((o, k) => {
    const lineNumber = k + 1;
    if (ZERO_COMMIT_SHA.test(o.sourceRevision)) { lines[k] = { lineNumber, authorship: 'unknown', unknownReason: 'uncommitted' }; return; }
    const final = (reason: LineUnknownReason) => { lines[k] = { lineNumber, authorship: 'unknown', unknownReason: reason, author: o.author, commitSha: o.sourceRevision }; };
    if (o.boundary) return final('boundary');
    if (o.sourcePath === null || !isCanonicalRepoPath(o.sourcePath)) return final('unsafe_path');
    const view = snapshot.get(o.sourceRevision)!.view;
    if (view.kind === 'line_claims') {
      const match = matchSourceClaim(view, o.sourcePath, o.sourceLine);
      if (match.kind === 'none') return final(match.reason);
      pending.push({ index: k, reason: match.kind === 'ambiguous' ? 'ambiguous_claim' : 'oversized', covered: true, origin: o });
      return;
    }
    pending.push({ index: k, reason: recordViewReason(view), covered: false, origin: o });
  });
  for (const [k, line] of settlePendingLines(top, pending, (rev) => snapshot.get(rev), deadline)) lines[k] = line;
  return answer(text, lines, origins.map(historyAnchorOf));
}

/**
 * Line authorship of one file, in the coordinates of `opts.view` (see the
 * view contract above). Null when the path is outside the repository, the
 * file cannot be read in that view, or `repoPath` is not in a work tree.
 * Never throws.
 */
export function resolveLineAttribution(repoPath: string, filePath: string, opts: LineBlameOptions = {}): LineAttributionResolution | null {
  const view = opts.view ?? 'worktree';
  // A disk file has no other commit to stand on; a revision that reads as an option is refused.
  if (opts.revision !== undefined && (view !== 'head' || !opts.revision || opts.revision.startsWith('-'))) return null;
  const deadline = opts.deadline ?? createProjectionDeadline(opts.budgetMs ?? REANCHOR_BUDGET_MS);
  const limits: CommitOnlyLimits = { ...COMMIT_ONLY_LIMITS, ...opts.commitOnlyLimits };
  const allUnknown = (text: string, revision: string | null, rel: string, reason: LineUnknownReason): LineAttributionResolution => ({
    view, revision, path: rel, text,
    lines: linesOf(text).map((_, k) => ({ lineNumber: k + 1, authorship: 'unknown' as const, unknownReason: reason })),
    historyAnchors: linesOf(text).map(() => null),
  });

  let top: string | null;
  let rel: string | null;
  let head: string | null;
  try {
    top = gitLine(['rev-parse', '--show-toplevel'], repoPath, deadline);
    if (!top) return null;
    rel = repoRelativePath(top, repoPath, filePath);
    if (!rel) return null;
    head = gitLine(['rev-parse', '--verify', '-q', `${opts.revision ?? 'HEAD'}^{commit}`], top, deadline);
    if (opts.revision !== undefined && !head) return null;
  } catch {
    return null;
  }

  let diskText: string | null = null;
  if (view === 'worktree') {
    try { diskText = fs.readFileSync(path.join(top, ...rel.split('/')), 'utf-8'); } catch { return null; }
  }

  // A disk text past the line-proof bounds can never show a line proof: the
  // strict resolver would only spend the budget. Commit evidence only — once
  // one bounded check shows HEAD has the path; a path HEAD lacks is all
  // uncommitted, and a check that fails says so, never blame's failure.
  if (head && diskText !== null && !diskText.includes('\u0000') && !withinBounds(diskText)) {
    let atHead: ObjectInfo | undefined;
    try {
      atHead = catFileCheck(top, [`${head}:${rel}`], deadline).get(`${head}:${rel}`);
    } catch (err) {
      return allUnknown(diskText, head, rel, err instanceof ProjectionTimeout ? 'timeout' : 'internal_error');
    }
    if (atHead?.kind !== 'object') return allUnknown(diskText, head, rel, 'uncommitted');
    return commitOnlyResolution({ view, top, rel, head, diskText, deadline, limits });
  }

  // Phase 1: the strict resolver at HEAD.
  const resolved = head ? resolveFileAtRevision({ repoPath: top, targetRevision: head, targetPath: rel, deadline }) : null;
  const headText = resolved?.targetText ?? null;

  // HEAD past the line-proof bounds: the file is still attributed, by
  // commit evidence only.
  if (head && resolved?.result.failure === 'oversized') {
    return commitOnlyResolution({ view, top, rel, head, diskText, deadline, limits });
  }

  if (view === 'head' && headText === null) return null;
  const text = view === 'head' ? headText! : diskText!;

  // Nothing at HEAD to inherit from: on disk only, so uncommitted.
  if (!resolved || headText === null) {
    const failure = resolved?.result.failure;
    const reason: LineUnknownReason = !failure || failure === 'target_unreadable' ? 'uncommitted' : failure;
    return allUnknown(text, head, rel, reason);
  }

  // Phase 2: which HEAD line each output line stands on. Nothing is shown
  // yet, so a failure here answers `unknown` for every line (fail-closed).
  const headLines = headLinesOf(resolved, linesOf(headText).length);
  const outLines = linesOf(text);
  let fromHead: Array<HeadLine | null>;
  try {
    if (text === headText) {
      fromHead = headLines;
    } else if (text.includes('\u0000')) {
      return allUnknown(text, head, rel, 'non_text');
    } else {
      fromHead = outLines.map(() => null);
      const toDisk = mandatoryAlignment(linesOf(headText), outLines, { maxLines: MAX_FILE_LINES + 1, tick: () => checkDeadline(deadline) });
      toDisk.forEach((j, i) => { if (j >= 0) fromHead[j] = headLines[i]; });
    }
  } catch (err) {
    return allUnknown(text, head, rel, err instanceof ProjectionTimeout ? 'timeout' : 'internal_error');
  }

  // Phase 3: the proven lines, final from here on. Identity comes from the
  // note snapshot the claim was proven on — never a second read that could
  // meet a replaced record.
  const lines: LineAttribution[] = new Array(outLines.length);
  const pending: PendingLine[] = [];
  const identities = new Map<ReanchoredLineClaim, ContributionIdentity | null>();
  const identityOf = (claim: ReanchoredLineClaim): ContributionIdentity | null => {
    if (!identities.has(claim)) {
      let id: ContributionIdentity | null;
      try { id = resolved.identityOf(claim); } catch { id = null; }
      identities.set(claim, id);
    }
    return identities.get(claim)!;
  };
  outLines.forEach((_, k) => {
    const lineNumber = k + 1;
    const h = fromHead[k];
    if (!h) { lines[k] = { lineNumber, authorship: 'unknown', unknownReason: 'uncommitted' }; return; }
    if (h.kind === 'unknown') {
      pending.push({ index: k, reason: h.reason, covered: COVERED_REASONS.has(h.reason), origin: h.origin });
      return;
    }
    const author = h.origin?.author;
    const id = identityOf(h.claim);
    if (!id) {
      // The snapshot does not re-prove the claim: nothing is proven, and no
      // commit evidence stands in for a claim that failed its own check.
      const blamed = h.origin && !ZERO_COMMIT_SHA.test(h.origin.sourceRevision) ? h.origin.sourceRevision : undefined;
      lines[k] = { lineNumber, authorship: 'unknown', unknownReason: 'record_invalid', author, commitSha: blamed };
      return;
    }
    const line: LineAttribution = {
      lineNumber,
      authorship: 'ai',
      confidence: 'line',
      sessionId: id.sessionId,
      model: id.modelId,
      agent: id.agentId,
      tool: id.agentId,
      author,
      commitSha: h.claim.source_revision,
    };
    if (h.claim.iteration_index !== undefined) line.iterationIndex = h.claim.iteration_index;
    lines[k] = line;
  });

  // Phase 4: commit evidence for the rest. Best effort: it never takes back
  // a line of phase 3, and running out only leaves the undecided unknown.
  for (const [k, line] of settlePendingLines(top, pending, resolved.noteOf, deadline)) lines[k] = line;
  return { view, revision: head, path: rel, text, lines, historyAnchors: outLines.map((_, k) => historyAnchorOf(fromHead[k]?.origin)) };
}

/**
 * Line-level attribution of a file (see resolveLineAttribution). Empty when
 * the file cannot be read in the requested view.
 */
export function getLineBlame(repoPath: string, filePath: string, opts: LineBlameOptions = {}): LineAttribution[] {
  return resolveLineAttribution(repoPath, filePath, opts)?.lines ?? [];
}

// ─── File Attribution ────────────────────────────────────────────────────

/**
 * Attribution for a single file as it is at HEAD (the 'head' view: metrics do
 * not move with uncommitted edits). `unknownLines` are neither AI nor human;
 * `aiLines` counts both AI tiers, split in `lineProvenAiLines` /
 * `commitConfidenceAiLines`.
 */
export function computeFileAttribution(repoPath: string, filePath: string): FileAttribution {
  const lines = getLineBlame(repoPath, filePath, { view: 'head' });
  const totalLines = lines.length;
  const aiLines = lines.filter(l => l.authorship === 'ai').length;
  const humanLines = lines.filter(l => l.authorship === 'human').length;
  const mixedLines = lines.filter(l => l.authorship === 'mixed').length;
  const unknownLines = lines.filter(l => l.authorship === 'unknown').length;
  const pct = (n: number) => (totalLines > 0 ? Math.round((n / totalLines) * 100) : 0);

  return {
    filePath,
    lines,
    totalLines,
    aiLines,
    ...aiConfidenceSplit(lines),
    humanLines,
    mixedLines,
    unknownLines,
    aiPercentage: pct(aiLines),
    humanPercentage: pct(humanLines),
    mixedPercentage: pct(mixedLines),
    unknownPercentage: pct(unknownLines),
  };
}

// ─── Commit Attribution ──────────────────────────────────────────────────

/**
 * Get files changed in a commit.
 */
function getCommitFiles(repoPath: string, commitSha: string): string[] {
  try {
    return execFileSync('git', ['diff-tree', '--no-commit-id', '--name-only', '-r', commitSha], execOpts(repoPath)).trim().split('\n').filter(Boolean);
  } catch {
    return [];
  }
}

/**
 * Compute attribution for a commit using three-tree comparison.
 *
 * Tree A = state before AI session started (headBefore from note)
 * Tree B = state at the commit
 * Tree C = current HEAD (for detecting human modifications after AI)
 *
 * Lines only in A→B diff that came from an AI session = AI-authored
 * Lines in B→C that overlap AI lines = mixed (human modified AI code)
 */
export function computeCommitAttribution(repoPath: string, commitSha: string): CommitAttribution {
  const files = getCommitFiles(repoPath, commitSha);
  const fileAttributions: FileAttribution[] = [];

  let totalAi = 0, totalHuman = 0, totalMixed = 0, totalUnknown = 0, totalLines = 0;
  let totalLineProven = 0, totalCommitConfidence = 0;

  for (const file of files) {
    try {
      // Check if file still exists at HEAD
      execFileSync('git', ['cat-file', '-e', `HEAD:${file}`], execOpts(repoPath));
      const attr = computeFileAttribution(repoPath, file);
      fileAttributions.push(attr);
      totalAi += attr.aiLines;
      totalLineProven += attr.lineProvenAiLines;
      totalCommitConfidence += attr.commitConfidenceAiLines;
      totalHuman += attr.humanLines;
      totalMixed += attr.mixedLines;
      totalUnknown += attr.unknownLines;
      totalLines += attr.totalLines;
    } catch {
      // File was deleted or doesn't exist — skip
    }
  }

  return {
    commitSha,
    files: fileAttributions,
    totalLines,
    aiLines: totalAi,
    lineProvenAiLines: totalLineProven,
    commitConfidenceAiLines: totalCommitConfidence,
    humanLines: totalHuman,
    mixedLines: totalMixed,
    unknownLines: totalUnknown,
    aiPercentage: totalLines > 0 ? Math.round((totalAi / totalLines) * 100) : 0,
    humanPercentage: totalLines > 0 ? Math.round((totalHuman / totalLines) * 100) : 0,
    mixedPercentage: totalLines > 0 ? Math.round((totalMixed / totalLines) * 100) : 0,
    unknownPercentage: totalLines > 0 ? Math.round((totalUnknown / totalLines) * 100) : 0,
  };
}

// ─── Acceptance Metrics ──────────────────────────────────────────────────
//
// What happened to the lines AI was PROVEN to write (OR-46). The tracked
// lines are the canonical line claims of the commits in the range — a
// commit-level record, a legacy note or a trailer tracks nothing. Each tracked
// line is then looked for at HEAD by its source identity, never by its old
// line number:
//
//   • accepted   — a HEAD line carries the re-anchored claim of exactly this
//                  source (revision, path, line) and record identity
//                  (contribution, file entry, range, iteration);
//   • overridden — every HEAD file of the line's lineage resolved, and strict
//                  blame names this source line on none of them: a later
//                  commit rewrote or removed it;
//   • deleted    — no file of the lineage is at HEAD (neither the path nor a
//                  rename git detects between the source commit and HEAD);
//   • unknown    — anything not proven: a HEAD line that still blames to the
//                  source line but whose claim did not re-anchor (repeated
//                  content, an ambiguous record), any line of a source whose
//                  lines the HEAD file could not tell apart (one of two
//                  identical claimed lines deleted: which one survived is not
//                  known), a resolver failure or timeout, an unreadable note.
//                  Never in a rate's denominator.

/** One line a canonical record of a commit in the range claims. */
interface TrackedClaimLine {
  revision: string;
  path: string;
  line: number;
  /** `${contribution}:${file}:${range}:${iteration}` in that record; null when the record is ambiguous there. */
  identity: string | null;
  modelId?: string;
}

type ClaimFate = 'accepted' | 'overridden' | 'deleted' | 'unknown';

const claimKey = (revision: string, path: string, line: number) => `${revision}\u0000${path}\u0000${line}`;
const rangeIdentity = (contribution: number, file: number, range: number, iteration: number | undefined) =>
  `${contribution}:${file}:${range}:${iteration ?? ''}`;

/**
 * Bounds of one tracking pass. A canonical record may come from any producer
 * and the schema allows line numbers up to 2^53, so declared ranges are
 * checked arithmetically — never walked — before one line is materialized.
 * Past a bound the whole pass is `unavailable`: no partial metrics.
 */
export const MAX_TRACKED_CLAIM_LINES = 50_000;
export const MAX_TRACKED_CLAIM_FILES = 2_000;
export const MAX_TRACKED_CLAIM_RANGES = 20_000;

/** Bytes of all notes one tracking pass reads; past it the pass is `too_many_note_bytes`. */
export const MAX_TRACKED_NOTE_BYTES = 64 * 1024 * 1024;

export type TrackingUnavailableReason =
  | 'too_many_claim_lines'
  | 'too_many_claim_files'
  | 'too_many_claim_ranges'
  /** The notes of the range pass MAX_TRACKED_NOTE_BYTES, one or all together. Nothing was read. */
  | 'too_many_note_bytes'
  /** The notes ref or a note could not be read: what the range claims is not known. */
  | 'notes_unreadable';

/** A file's claimed lines as sorted, merged, inclusive intervals. */
function mergedIntervals(ranges: readonly { startLine: number; endLine: number }[]): Array<[number, number]> {
  const sorted = ranges.map((r) => [r.startLine, r.endLine] as [number, number]).sort((a, b) => a[0] - b[0]);
  const out: Array<[number, number]> = [];
  for (const [s, e] of sorted) {
    const last = out[out.length - 1];
    if (last && s <= last[1] + 1) last[1] = Math.max(last[1], e);
    else out.push([s, e]);
  }
  return out;
}

/**
 * The line count of each `rev:path` that is a readable text blob within the
 * OR-45 bounds; null otherwise. One `--batch-check` and chunked `--batch`
 * reads for all of them; no text is kept. A batch that fails leaves every
 * count null: those claims can only end `unknown`.
 */
function sourceLineCounts(repoPath: string, names: readonly string[]): Map<string, number | null> {
  const out = new Map<string, number | null>(names.map((n) => [n, null]));
  try {
    const info = catFileCheck(repoPath, names, undefined);
    const byOid = new Map<string, { size: number; names: string[] }>();
    for (const name of names) {
      const i = info.get(name);
      if (i?.kind !== 'object' || i.type !== 'blob' || i.size > MAX_FILE_BYTES) continue;
      const entry = byOid.get(i.oid) ?? { size: i.size, names: [] };
      entry.names.push(name);
      byOid.set(i.oid, entry);
    }
    readObjects(repoPath, [...byOid].map(([oid, { size }]) => ({ oid, size })), undefined, (chunk) => {
      for (const [oid, text] of chunk) {
        const count = text.includes('\u0000') || !withinBounds(text) ? null : linesOf(text).length;
        for (const n of byOid.get(oid)!.names) out.set(n, count);
      }
    });
  } catch {
    return new Map(names.map((n) => [n, null]));
  }
  return out;
}

/**
 * The canonical line claims of `commits`, one entry per claimed source line,
 * or why the pass is unavailable. Every declared interval is first measured:
 * the total over the call must stay within MAX_TRACKED_CLAIM_LINES, the files
 * within MAX_TRACKED_CLAIM_FILES and the declared ranges within
 * MAX_TRACKED_CLAIM_RANGES. A file whose blob cannot be read, or
 * whose intervals run past its last line, cannot hold the claim it states: its
 * (bounded) lines are tracked with no identity and end `unknown`.
 */
function trackedClaimLines(repoPath: string, commits: string[]): { lines: TrackedClaimLine[] } | { unavailable: TrackingUnavailableReason } {
  type ClaimFile = { revision: string; path: string; view: Extract<SourceRecordView, { kind: 'line_claims' }>; noteText: string; intervals: Array<[number, number]> };
  const files: ClaimFile[] = [];
  let declared = 0;
  let rangeCount = 0;
  // One snapshot of the notes ref and one batch for the notes of the range,
  // bounded in total before any is read. A commit without a note has no
  // claims; a note that cannot be read leaves the whole pass unavailable —
  // never an empty one.
  const shas = commits.filter((sha) => /^[0-9a-f]{40,64}$/.test(sha));
  const noteTexts = new Map<string, string>();
  if (shas.length > 0) {
    try {
      const listed = noteBlobs(repoPath, 'refs/notes/origin', undefined);
      const ids = [...new Set(shas.map((sha) => listed.get(sha)).filter((id): id is string => id !== undefined))];
      const reads = readBlobs(repoPath, ids, { maxBytes: MAX_TRACKED_NOTE_BYTES, totalBytes: MAX_TRACKED_NOTE_BYTES }, undefined);
      for (const sha of shas) {
        const id = listed.get(sha);
        if (id === undefined) continue;
        const read = reads.get(id);
        if (read?.kind === 'oversized') return { unavailable: 'too_many_note_bytes' };
        if (read?.kind !== 'text') return { unavailable: 'notes_unreadable' };
        noteTexts.set(sha, read.text);
      }
    } catch (err) {
      return { unavailable: err instanceof BatchTooLarge ? 'too_many_note_bytes' : 'notes_unreadable' };
    }
  }
  for (const sha of shas) {
    const noteText = noteTexts.get(sha);
    if (noteText === undefined) continue;
    const view = sourceRecordView(noteText, sha);
    if (view.kind !== 'line_claims') continue;
    for (const [filePath, ranges] of view.byPath) {
      if (files.length >= MAX_TRACKED_CLAIM_FILES) return { unavailable: 'too_many_claim_files' };
      rangeCount += ranges.length;
      if (rangeCount > MAX_TRACKED_CLAIM_RANGES) return { unavailable: 'too_many_claim_ranges' };
      const intervals = mergedIntervals(ranges);
      for (const [s, e] of intervals) {
        declared += e - s + 1;
        if (declared > MAX_TRACKED_CLAIM_LINES) return { unavailable: 'too_many_claim_lines' };
      }
      files.push({ revision: sha, path: filePath, view, noteText, intervals });
    }
  }

  const out: TrackedClaimLine[] = [];
  const counts = sourceLineCounts(repoPath, files.map((f) => `${f.revision}:${f.path}`));
  // One parse of a record per contribution, not one per claimed line.
  const identities = new Map<string, ContributionIdentity | null>();
  for (const f of files) {
    const count = counts.get(`${f.revision}:${f.path}`) ?? null;
    const consistent = count !== null && f.intervals.every(([, e]) => e <= count);
    // A sweep over the ranges sorted by start: each line is matched against
    // the ranges covering it only, not against every range of the file.
    const byStart = [...(f.view.byPath.get(f.path) ?? [])].sort((a, b) => a.startLine - b.startLine);
    let next = 0;
    let active: SourceLineRange[] = [];
    for (const [s, e] of f.intervals) {
      for (let line = s; line <= e; line++) {
        if (!consistent) { out.push({ revision: f.revision, path: f.path, line, identity: null }); continue; }
        while (next < byStart.length && byStart[next].startLine <= line) active.push(byStart[next++]);
        active = active.filter((r) => r.endLine >= line);
        const m = matchSourceClaim({ kind: 'line_claims', byPath: new Map([[f.path, active]]) }, f.path, line);
        if (m.kind !== 'claim') { out.push({ revision: f.revision, path: f.path, line, identity: null }); continue; }
        const idKey = `${f.revision}\u0000${m.range.contributionIndex}`;
        if (!identities.has(idKey)) identities.set(idKey, contributionIdentity(f.noteText, f.revision, m.range.contributionIndex));
        const id = identities.get(idKey);
        out.push({
          revision: f.revision,
          path: f.path,
          line,
          identity: rangeIdentity(m.range.contributionIndex, m.range.fileIndex, m.range.rangeIndex, m.range.iterationIndex),
          ...(id?.modelId ? { modelId: id.modelId } : {}),
        });
      }
    }
  }
  return { lines: out };
}

/** What one HEAD file says about source lines: re-anchored claims and plain blame origins. */
interface HeadFileEvidence {
  failed: boolean;
  claims: Map<string, string>; // claimKey → range identity
  origins: Set<string>;        // claimKey of every blame origin
  /** `${revision}\0${path}` of sources some HEAD line of which could not be told apart. */
  undecided: Set<string>;
}

/** Unresolved reasons that mean "this source's lines could not be told apart", not "absent". */
const UNDECIDED_SOURCE_REASONS: ReadonlySet<LineUnknownReason> = new Set<LineUnknownReason>([
  'ambiguous_alignment', 'duplicate_source', 'source_mismatch', 'ambiguous_claim', 'source_unreadable', 'source_oversized',
]);

/**
 * The fate at HEAD of every canonical claimed line of `commits` (see the
 * section comment). Files are resolved once each, through the same strict
 * re-anchor as `getLineBlame`; candidate HEAD paths come from the source path
 * and git's own rename detection, and only blame decides what survived.
 */
function claimFatesAtHead(
  repoPath: string,
  commits: string[],
): { fates: Array<TrackedClaimLine & { fate: ClaimFate }> } | { unavailable: TrackingUnavailableReason } {
  const tracking = trackedClaimLines(repoPath, commits);
  if ('unavailable' in tracking) return tracking;
  return { fates: fatesAtHead(repoPath, tracking.lines) };
}

function fatesAtHead(repoPath: string, tracked: TrackedClaimLine[]): Array<TrackedClaimLine & { fate: ClaimFate }> {
  if (tracked.length === 0) return [];
  const top = gitDetailed(['rev-parse', '--show-toplevel'], { cwd: repoPath, timeoutMs: 10_000 }).stdout.trim();
  const head = gitDetailed(['rev-parse', '--verify', '-q', 'HEAD^{commit}'], { cwd: repoPath, timeoutMs: 10_000 }).stdout.trim();
  if (!top || !/^[0-9a-f]{40,64}$/.test(head)) return tracked.map((t) => ({ ...t, fate: 'unknown' as const }));

  // Which tracked paths HEAD still has (any object type), in one batch. A
  // batch that fails decides nothing: those claims end `unknown`.
  let present: Map<string, ObjectInfo> | null;
  try {
    present = catFileCheck(top, [...new Set(tracked.filter((t) => t.identity !== null).map((t) => `${head}:${t.path}`))], undefined);
  } catch {
    present = null;
  }
  const existsAtHead = (p: string) => present!.get(`${head}:${p}`)?.kind === 'object';
  const renamesBySource = new Map<string, Map<string, string[]> | null>();
  const renamesFrom = (rev: string): Map<string, string[]> | null => {
    if (!renamesBySource.has(rev)) {
      const r = gitDetailed(['diff', '--name-status', '-z', '-M', '--no-ext-diff', rev, head], { cwd: top, timeoutMs: 15_000, maxBuffer: 64 * 1024 * 1024 });
      let map: Map<string, string[]> | null = null;
      if (r.status === 0) {
        map = new Map();
        const parts = r.stdout.split('\u0000');
        for (let i = 0; i < parts.length;) {
          const status = parts[i];
          if (/^[RC]\d*$/.test(status)) {
            if (status.startsWith('R')) map.set(parts[i + 1], [...(map.get(parts[i + 1]) ?? []), parts[i + 2]]);
            i += 3;
          } else {
            i += 2;
          }
        }
      }
      renamesBySource.set(rev, map);
    }
    return renamesBySource.get(rev)!;
  };

  const candidatesCache = new Map<string, string[] | null>();
  const candidatesOf = (rev: string, p: string): string[] | null => {
    const k = `${rev}\u0000${p}`;
    if (!candidatesCache.has(k)) {
      if (present === null) { candidatesCache.set(k, null); return null; }
      const out = existsAtHead(p) ? [p] : [];
      const renames = renamesFrom(rev);
      // Rename detection unavailable: we cannot tell a rename from a deletion.
      if (renames === null && out.length === 0) { candidatesCache.set(k, null); return null; }
      for (const to of renames?.get(p) ?? []) if (!out.includes(to)) out.push(to);
      candidatesCache.set(k, out);
    }
    return candidatesCache.get(k)!;
  };

  // Every candidate HEAD path resolved together: one strict blame each, and
  // batch reads of everything else (resolveFilesAtRevision).
  const headPaths = new Set<string>();
  for (const t of tracked) if (t.identity !== null) for (const p of candidatesOf(t.revision, t.path) ?? []) headPaths.add(p);
  const resolvedAtHead = resolveFilesAtRevision({ repoPath: top, targetRevision: head, targetPaths: [...headPaths] });

  const evidence = new Map<string, HeadFileEvidence>();
  const evidenceFor = (headPath: string): HeadFileEvidence => {
    let e = evidence.get(headPath);
    if (e) return e;
    const resolved = resolvedAtHead.get(headPath)!;
    e = { failed: resolved.result.status === 'failed' || !resolved.origins, claims: new Map(), origins: new Set(), undecided: new Set() };
    for (const c of resolved.result.claims) {
      for (let l = c.source_start_line; l <= c.source_end_line; l++) {
        e.claims.set(claimKey(c.source_revision, c.source_path, l), rangeIdentity(c.contribution_index, c.file_index, c.range_index, c.iteration_index));
      }
    }
    for (const o of resolved.origins ?? []) {
      if (o.sourcePath !== null) e.origins.add(claimKey(o.sourceRevision, o.sourcePath, o.sourceLine));
    }
    for (const u of resolved.result.unresolved) {
      if (!UNDECIDED_SOURCE_REASONS.has(u.reason)) continue;
      for (let l = u.start_line; l <= u.end_line; l++) {
        const o = resolved.origins?.[l - 1];
        if (o?.sourcePath != null) e.undecided.add(`${o.sourceRevision}\u0000${o.sourcePath}`);
      }
    }
    evidence.set(headPath, e);
    return e;
  };

  return tracked.map((t) => {
    if (t.identity === null) return { ...t, fate: 'unknown' as const };
    const candidates = candidatesOf(t.revision, t.path);
    if (candidates === null) return { ...t, fate: 'unknown' as const };
    if (candidates.length === 0) return { ...t, fate: 'deleted' as const };
    const key = claimKey(t.revision, t.path, t.line);
    const files = candidates.map(evidenceFor);
    if (files.some((f) => f.claims.get(key) === t.identity)) return { ...t, fate: 'accepted' as const };
    const source = `${t.revision}\u0000${t.path}`;
    if (files.some((f) => f.failed || f.origins.has(key) || f.undecided.has(source))) return { ...t, fate: 'unknown' as const };
    return { ...t, fate: 'overridden' as const };
  });
}

function acceptanceFromTracking(tracking: ReturnType<typeof claimFatesAtHead>): AcceptanceMetrics {
  if ('unavailable' in tracking) {
    return { totalAiLines: 0, acceptedLines: 0, overriddenLines: 0, deletedLines: 0, unknownLines: 0, acceptanceRate: null, unavailable: tracking.unavailable };
  }
  const { fates } = tracking;
  const count = (f: ClaimFate) => fates.filter((x) => x.fate === f).length;
  const acceptedLines = count('accepted');
  const unknownLines = count('unknown');
  const known = fates.length - unknownLines;
  return {
    totalAiLines: fates.length,
    acceptedLines,
    overriddenLines: count('overridden'),
    deletedLines: count('deleted'),
    unknownLines,
    acceptanceRate: known > 0 ? acceptedLines / known : null,
  };
}

/**
 * Acceptance of the lines AI was proven to write in a range (see the section
 * comment). `acceptanceRate` is null when no tracked line has a known fate:
 * there is no denominator, and none is invented. Past the tracking bounds the
 * result is `unavailable`.
 */
export function computeAcceptanceMetrics(
  repoPath: string,
  commitRange?: string,
): AcceptanceMetrics {
  return acceptanceFromTracking(claimFatesAtHead(repoPath, commitsInRange(repoPath, commitRange || 'HEAD~20..HEAD')));
}

function commitsInRange(repoPath: string, range: string): string[] {
  if (range.startsWith('-')) return [];
  const r = gitDetailed(['log', '--format=%H', range, '--'], { cwd: repoPath, timeoutMs: 15_000 });
  return r.status === 0 ? r.stdout.split('\n').filter(Boolean) : [];
}

// ─── Move Detection ──────────────────────────────────────────────────────

/**
 * Detect file renames/moves in a commit.
 */
export function detectMoves(repoPath: string, commitSha: string): MoveDetection[] {
  const moves: MoveDetection[] = [];
  try {
    const output = execFileSync('git', ['diff-tree', '-r', '-M', '-C', '--find-renames', '--find-copies', '--diff-filter=R', commitSha], execOpts(repoPath)).trim();

    for (const line of output.split('\n')) {
      // Format: :100644 100644 <hash> <hash> R<similarity> oldpath newpath
      const match = line.match(/R(\d+)\t(.+)\t(.+)/);
      if (match) {
        moves.push({
          oldPath: match[2],
          newPath: match[3],
          similarity: parseInt(match[1], 10),
        });
      }
    }
  } catch { /* ignore */ }
  return moves;
}

/**
 * Preserve attribution across file renames.
 * Copies origin notes data from old path to new path.
 */
export function preserveAttributionOnMove(
  repoPath: string,
  commitSha: string,
  moves: MoveDetection[],
): void {
  if (moves.length === 0) return;

  const note = readOriginNote(repoPath, commitSha);
  if (!note?.attribution?.files) return;

  let modified = false;
  for (const move of moves) {
    if (note.attribution.files[move.oldPath]) {
      note.attribution.files[move.newPath] = note.attribution.files[move.oldPath];
      delete note.attribution.files[move.oldPath];
      modified = true;
    }
  }

  if (modified) {
    try {
      execFileSync('git', ['notes', '--ref=origin', 'add', '-f', '-m', JSON.stringify(note), commitSha], execOpts(repoPath));
    } catch { /* best effort */ }
  }
}

// ─── Aggregate Stats ─────────────────────────────────────────────────────

export interface PerModelStats {
  commits: number;
  linesAdded: number;
  // Cost in USD, summed from git notes. Zero if no notes carry cost data.
  costUsd: number;
  // Acceptance metrics for lines originally written by this model.
  // `acceptedLines` survived in their original AI attribution, `overriddenLines`
  // were later edited by a human or different model, `deletedLines` were
  // removed entirely, `unknownLines` now carry no line-level proof either way.
  // Rate excludes deletions and unknown lines from the denominator (we can't
  // tell whether a deletion was rejection or intended cleanup, and an unknown
  // line is evidence of neither).
  acceptedLines: number;
  overriddenLines: number;
  deletedLines: number;
  unknownLines: number;
  /** accepted / (accepted + overridden); null when that is zero. */
  acceptanceRate: number | null;
}

export interface AttributionStats {
  totalCommits: number;
  aiCommits: number;
  humanCommits: number;
  totalLinesAdded: number;
  aiLinesAdded: number;
  humanLinesAdded: number;
  mixedLinesAdded: number;
  byTool: Map<string, { commits: number; linesAdded: number }>;
  byModel: Map<string, PerModelStats>;
  acceptance: AcceptanceMetrics;
}

/**
 * Compute aggregate attribution stats over a commit range.
 */
export function computeAttributionStats(
  repoPath: string,
  commitRange?: string,
): AttributionStats {
  const range = commitRange || 'HEAD~50..HEAD';
  const byTool = new Map<string, { commits: number; linesAdded: number }>();
  const byModel = new Map<string, PerModelStats>();
  let totalCommits = 0, aiCommits = 0, humanCommits = 0;
  let totalLinesAdded = 0, aiLinesAdded = 0, humanLinesAdded = 0, mixedLinesAdded = 0;


  try {
    // Scope to current branch (HEAD) only
    // Check if origin-sessions branch exists to exclude it (it has session metadata, not code)
    let hasOriginSessions = false;
    try {
      execFileSync('git', ['rev-parse', '--verify', 'refs/heads/origin-sessions'], execOpts(repoPath));
      hasOriginSessions = true;
    } catch { /* branch doesn't exist, nothing to exclude */ }
    const logArgs = commitRange
      ? ['log', '--first-parent', '--format=%H', range]
      : ['log', '--first-parent', '--format=%H', '-50', 'HEAD', ...(hasOriginSessions ? ['--not', 'refs/heads/origin-sessions'] : [])];
    const commits = execFileSync('git', logArgs, execOpts(repoPath)).trim().split('\n').filter(Boolean);

    for (const sha of commits) {
      totalCommits++;
      const rawNote = readOriginNote(repoPath, sha);
      // Unwrap { origin: { ... } } nesting
      const note = rawNote?.origin || rawNote;

      // Also check commit message trailers as fallback
      let isAi = isAiNote(note);
      if (!isAi) {
        const detected = detectAiFromCommit(repoPath, sha);
        if (detected?.isAi) {
          isAi = true;
          if (!note) {
            // Create a synthetic note for tool/model detection below
            Object.assign(rawNote || {}, { model: detected.model });
          }
        }
      }

      if (isAi) {
        aiCommits++;
        const model = note?.model || 'unknown';
        const tool = detectToolFromModel(model, note?.agent || undefined);

        // Count lines from this commit
        try {
          const stat = execFileSync('git', ['show', '--numstat', '--format=', sha, '--'], execOpts(repoPath)).trim();
          let commitLines = 0;
          for (const line of stat.split('\n')) {
            const parts = line.split('\t');
            const added = parseInt(parts[0], 10);
            if (!isNaN(added)) {
              commitLines += added;
            }
          }
          aiLinesAdded += commitLines;
          totalLinesAdded += commitLines;

          // By tool
          const toolEntry = byTool.get(tool) || { commits: 0, linesAdded: 0 };
          toolEntry.commits++;
          toolEntry.linesAdded += commitLines;
          byTool.set(tool, toolEntry);

          // By model — includes per-model acceptance + cost fields
          const modelEntry = byModel.get(model) || {
            commits: 0,
            linesAdded: 0,
            costUsd: 0,
            acceptedLines: 0,
            overriddenLines: 0,
            deletedLines: 0,
            unknownLines: 0,
            acceptanceRate: null,
          };
          modelEntry.commits++;
          modelEntry.linesAdded += commitLines;
          // Pull per-commit cost from the git note if present.
          const noteCost = typeof note?.costUsd === 'number' ? note.costUsd : 0;
          modelEntry.costUsd += noteCost;
          byModel.set(model, modelEntry);

        } catch { /* skip */ }
      } else {
        humanCommits++;
        try {
          const stat = execFileSync('git', ['show', '--numstat', '--format=', sha, '--'], execOpts(repoPath)).trim();
          let commitLines = 0;
          for (const line of stat.split('\n')) {
            const parts = line.split('\t');
            const added = parseInt(parts[0], 10);
            if (!isNaN(added)) {
              commitLines += added;
            }
          }
          humanLinesAdded += commitLines;
          totalLinesAdded += commitLines;
        } catch { /* skip */ }
      }
    }
  } catch { /* empty range */ }

  // ── Acceptance, overall and per model ───────────────────────────────
  // One pass over the canonical line claims of the range (claimFatesAtHead):
  // a line counts for the model its canonical contribution names, and only by
  // its proven fate at HEAD — never by its old line number. The bucket exists
  // because of the claim: a model the commit-level pass above never saw (a
  // note with only a canonical record) gets one with zero commits and lines.
  // Unknown is neither accepted nor overridden; a rate with no known line is
  // null, not 100%. An unavailable tracking pass fills no bucket at all.
  const tracking = claimFatesAtHead(repoPath, commitsInRange(repoPath, range));
  const fates = 'fates' in tracking ? tracking.fates : [];
  for (const f of fates) {
    if (!f.modelId) continue;
    let entry = byModel.get(f.modelId);
    if (!entry) {
      entry = { commits: 0, linesAdded: 0, costUsd: 0, acceptedLines: 0, overriddenLines: 0, deletedLines: 0, unknownLines: 0, acceptanceRate: null };
      byModel.set(f.modelId, entry);
    }
    if (f.fate === 'accepted') entry.acceptedLines++;
    else if (f.fate === 'overridden') entry.overriddenLines++;
    else if (f.fate === 'deleted') entry.deletedLines++;
    else entry.unknownLines++;
  }
  for (const entry of byModel.values()) {
    const denom = entry.acceptedLines + entry.overriddenLines;
    entry.acceptanceRate = denom > 0 ? entry.acceptedLines / denom : null;
  }

  return {
    totalCommits,
    aiCommits,
    humanCommits,
    totalLinesAdded,
    aiLinesAdded,
    humanLinesAdded,
    mixedLinesAdded,
    byTool,
    byModel,
    acceptance: acceptanceFromTracking(tracking),
  };
}

// NO time budget here, deliberately. An earlier version capped the walk at
// 1500ms and published a partial result, which meant the agent could silently
// receive an attribution summary covering only some of the 30 commits — a wrong
// answer dressed up as a right one. The context is the product; truncating it to
// hit a latency target is the wrong trade. The disk cache below is what makes
// this affordable: the walk runs once per HEAD, not once per prompt.
function attributionCacheFile(repoPath: string): string {
  // Hash the path so a repo-relative name can't escape the cache dir, and so
  // Windows drive colons / separators don't leak into the filename.
  const key = crypto.createHash('sha256').update(path.resolve(repoPath)).digest('hex').slice(0, 32);
  return path.join(os.homedir(), '.origin', 'attribution-cache', `${key}.json`);
}

/**
 * Build a concise AI attribution context string for injection into agent system
 * prompts, memoized on (repoPath, HEAD).
 *
 * The cache MUST be on disk, not in memory: every hook fire is a brand-new node
 * process, so a module-level map would never see a second hit. Keyed on HEAD
 * because that is what the content derives from — consecutive prompts in a
 * session almost always share a HEAD, so only the first prompt after a commit
 * pays anything.
 *
 * Returns null if no meaningful AI activity found.
 */
// Bumped when what the block says changes, so a cache written by an older CLI
// at the same HEAD is rebuilt rather than served.
const ATTRIBUTION_CACHE_VERSION = 2;

export function buildAttributionContext(repoPath: string): string | null {
  let head = '';
  try {
    head = execFileSync('git', ['rev-parse', 'HEAD'], execOpts(repoPath)).trim();
  } catch { /* not a repo / no commits — fall through to an uncached build */ }

  const cacheFile = head ? attributionCacheFile(repoPath) : '';
  if (cacheFile) {
    try {
      const c = JSON.parse(fs.readFileSync(cacheFile, 'utf-8')) as { v?: number; head?: string; context?: string | null };
      // A cached `null` is a real answer ("no AI activity here") and is worth
      // honouring — re-deriving it costs the same full walk as a hit.
      if (c && c.v === ATTRIBUTION_CACHE_VERSION && c.head === head) return c.context ?? null;
    } catch { /* absent or corrupt — rebuild */ }
  }

  const context = buildAttributionContextUncached(repoPath);

  if (cacheFile) {
    try {
      fs.mkdirSync(path.dirname(cacheFile), { recursive: true });
      fs.writeFileSync(cacheFile, JSON.stringify({ v: ATTRIBUTION_CACHE_VERSION, head, context, builtAt: new Date().toISOString() }), { mode: 0o600 });
    } catch { /* cache is an optimization — never fail the hook over it */ }
  }

  return context;
}

function buildAttributionContextUncached(repoPath: string): string | null {
  try {
    const opts = execOpts(repoPath);

    // Get last 30 commits quickly
    let logOutput: string;
    try {
      let hasOriginSessions = false;
      try {
        execFileSync('git', ['rev-parse', '--verify', 'refs/heads/origin-sessions'], opts);
        hasOriginSessions = true;
      } catch {}
      const logArgs = ['log', '--first-parent', '--format=%H|%an|%aI|%s', '-30', 'HEAD', ...(hasOriginSessions ? ['--not', 'refs/heads/origin-sessions'] : [])];
      logOutput = execFileSync('git', logArgs, { ...opts, timeout: 3000 }).trim();
    } catch {
      return null;
    }

    if (!logOutput) return null;

    const commits = logOutput.split('\n').filter(Boolean);
    let totalCommits = 0;
    let aiCommits = 0;
    const recentAiActivity: Array<{ model: string; tool: string; date: string; files: string[] }> = [];
    const aiFileHits = new Map<string, number>(); // file → AI commit count

    for (const line of commits) {
      const [sha, , dateStr] = line.split('|');
      if (!sha) continue;
      totalCommits++;

      const rawNote = readOriginNote(repoPath, sha);
      const note = rawNote?.origin || rawNote;

      let isAi = (!!note?.sessionId && note.sessionId !== 'unknown') || isAiNote(note?.squashMerge ? note : null);
      let model = note?.model || '';

      if (!isAi) {
        const detected = detectAiFromCommit(repoPath, sha);
        if (detected?.isAi) {
          isAi = true;
          model = detected.model || 'unknown';
        }
      }

      if (!isAi) continue;
      aiCommits++;

      // Get files changed in this commit (lightweight)
      let changedFiles: string[] = [];
      try {
        const filesRaw = execFileSync('git', ['diff-tree', '--no-commit-id', '--name-only', '-r', sha], { ...opts, timeout: 1000 }).trim();
        // Lockfiles, generated output and Origin's own context files are
        // never the file an agent should be told about: they topped this list
        // in Origin's own repo (package-lock.json, "15 AI commits") because
        // every release bumps them, and no decision changes on reading that.
        changedFiles = filesRaw.split('\n').filter(Boolean)
          .filter((f) => !shouldIgnoreFile(f) && !isLockfile(f) && !isOriginAutoManagedPath(f))
          .slice(0, 10);
      } catch {}

      const tool = detectToolFromModel(model, note?.agent || undefined);
      const date = dateStr ? dateStr.split('T')[0] : '';

      // Track recent AI activity (first 3 only)
      if (recentAiActivity.length < 3) {
        recentAiActivity.push({ model: model || tool, tool, date, files: changedFiles.slice(0, 3) });
      }

      // Count AI hits per file
      for (const f of changedFiles) {
        aiFileHits.set(f, (aiFileHits.get(f) || 0) + 1);
      }
    }

    if (aiCommits === 0) return null;

    const aiPct = Math.round((aiCommits / totalCommits) * 100);

    // Build context string
    const parts: string[] = [];

    parts.push(`Repository AI context: ${aiPct}% of recent commits (${aiCommits}/${totalCommits}) are AI-generated.`);

    // Recent AI activity
    if (recentAiActivity.length > 0) {
      const activityLines = recentAiActivity.map(a => {
        const fileStr = a.files.length > 0 ? a.files.join(', ') : 'multiple files';
        return `  - ${a.tool} wrote ${fileStr} on ${a.date} (${a.model})`;
      });
      parts.push('Recent AI activity:\n' + activityLines.join('\n'));
    }

    // Top AI-modified files
    if (aiFileHits.size > 0) {
      const topFiles = Array.from(aiFileHits.entries())
        .sort((a, b) => b[1] - a[1])
        .slice(0, 5)
        .map(([file, count]) => `  - ${file} (${count} AI commits)`)
        .join('\n');
      parts.push('Top AI-modified files:\n' + topFiles);
    }

    return parts.join('\n');
  } catch {
    return null;
  }
}

/**
 * Build per-file attribution context for injection into pre-tool-use hooks.
 * Summarizes line-level authorship into compact ranges, numbered as the file
 * is on disk (the 'worktree' view) since that is the file the agent edits.
 * Unknown lines are said to be unknown — never human, never AI. A
 * commit-confidence range is said to be commit-level, with no line-level
 * proof: never presented as the proven author of those lines.
 * Returns null if no attribution data available.
 */
export function buildFileAttributionContext(repoPath: string, filePath: string): string | null {
  try {
    const lines = getLineBlame(repoPath, filePath, { budgetMs: LINE_BLAME_HOOK_BUDGET_MS });
    if (lines.length === 0) return null;

    // Group consecutive lines by the same author/tool
    interface Range {
      start: number;
      end: number;
      authorship: LineAuthorship;
      confidence?: AttributionConfidence;
      tool?: string;
      model?: string;
      author: string;
    }

    const ranges: Range[] = [];
    let current: Range | null = null;

    // An unknown line's author is not who wrote it: unknown runs ignore it.
    const keyOf = (r: { authorship: LineAuthorship; confidence?: AttributionConfidence; tool?: string; model?: string; author?: string }) =>
      r.authorship === 'unknown' ? 'unknown' : `${r.authorship}|${r.confidence || ''}|${r.tool || ''}|${r.model || ''}|${r.author || 'unknown'}`;
    for (const line of lines) {
      const key = keyOf(line);
      const prevKey = current ? keyOf(current) : '';

      if (current && key === prevKey && line.lineNumber === current.end + 1) {
        current.end = line.lineNumber;
      } else {
        if (current) ranges.push(current);
        current = {
          start: line.lineNumber,
          end: line.lineNumber,
          authorship: line.authorship,
          confidence: line.confidence,
          tool: line.tool,
          model: line.model,
          author: line.author || 'unknown',
        };
      }
    }
    if (current) ranges.push(current);

    // Build compact summary — limit to top ranges by size
    const sorted = ranges.sort((a, b) => (b.end - b.start) - (a.end - a.start));
    const topRanges = sorted.slice(0, 10);
    // Re-sort by line number for display
    topRanges.sort((a, b) => a.start - b.start);

    const totalLines = lines.length;
    const aiLines = lines.filter(l => l.authorship === 'ai').length;
    const { lineProvenAiLines, commitConfidenceAiLines } = aiConfidenceSplit(lines);
    const unknownLines = lines.filter(l => l.authorship === 'unknown').length;
    const aiPct = Math.round((aiLines / totalLines) * 100);

    const parts: string[] = [];
    const split = commitConfidenceAiLines > 0
      ? ` — ${lineProvenAiLines} line-proven, ${commitConfidenceAiLines} commit-level attribution (no line-level proof)`
      : '';
    parts.push(`File attribution for ${filePath}: ${aiPct}% AI-generated (${aiLines}/${totalLines} lines${split})` +
      (unknownLines > 0 ? `; ${unknownLines} lines have no line-level attribution.` : '.'));

    for (const r of topRanges) {
      const lineRange = r.start === r.end ? `Line ${r.start}` : `Lines ${r.start}-${r.end}`;
      if (r.authorship === 'ai' && r.confidence === 'commit') {
        parts.push(`  ${lineRange}: ${r.tool || 'AI'} (${r.model || 'unknown'}) — commit-level attribution, no line-level proof`);
      } else if (r.authorship === 'ai') {
        parts.push(`  ${lineRange}: ${r.tool || 'AI'} (${r.model || 'unknown'})`);
      } else if (r.authorship === 'unknown') {
        parts.push(`  ${lineRange}: unknown (no line-level attribution)`);
      } else {
        parts.push(`  ${lineRange}: human (${r.author})`);
      }
    }

    if (ranges.length > 10) {
      parts.push(`  ... and ${ranges.length - 10} more ranges`);
    }

    return parts.join('\n');
  } catch {
    return null;
  }
}
