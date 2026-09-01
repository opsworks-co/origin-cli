import { execFileSync } from 'child_process';

// ─── Pull-based file context from git notes ──────────────────────────────
//
// Origin writes per-commit metadata (the prompt behind the change, the
// agent/model that made it, the session URL) to `refs/notes/origin`, and
// those notes travel with the repo. This module lets an agent pull that
// history for specific files ON DEMAND — "what was the prior agent trying
// to do in this file before I touch it?" — instead of relying only on the
// fixed start-of-session summary.
//
// Self-contained by design: reads local git notes via `git` (no Origin DB
// round-trip, works offline, and no coupling to the CLI package). Token
// cost is opt-in — summaries by default, full prompts only when asked.

/** The agent's own [Origin: …] markers captured from the session. */
export interface FileContextMarkers {
  intent?: string[];
  decision?: string[];
  open?: string[];
  verify?: string[];
}

/**
 * Compact, cheap-to-read headline for a commit — always returned. Lets an
 * agent triage "is there anything here I must read?" for a few tokens
 * before deciding to pull the detail (goal: minimum tokens).
 */
export interface FileContextSignals {
  /** survivingLines/addedLines on HEAD, 0..1 — how much of the change stuck. */
  acceptanceRate?: number;
  /** True when acceptanceRate is low (≤0.5) — this area was reworked/reverted; tread carefully. */
  fragile?: boolean;
  /** Count of [Origin: Decision] markers (the "why"). */
  decisions?: number;
  /** Count of unresolved [Origin: Open] items touching this work. */
  openItems?: number;
  /** Count of [Origin: Verify] reviewer-check items. */
  verifyItems?: number;
  /** How many files the prior agent loaded into context for this work. */
  filesReadCount?: number;
}

export interface FileContextCommit {
  sha: string;
  date?: string;
  agent?: string;
  model?: string;
  /** Which of the queried paths this commit changed. */
  touched: string[];
  /** Files the commit's note records as changed (may be broader than `touched`). */
  files?: string[];
  /** promptSummary, or the full prompt when includeDetail is set. */
  prompt?: string;
  /** True when the repo's privacy setting withheld prompt text from the note. */
  promptWithheld?: boolean;
  /** Always present: cheap headline for triage before pulling detail. */
  signals: FileContextSignals;
  /** The agent's [Origin: …] markers — the "why". Only when includeDetail. */
  markers?: FileContextMarkers;
  /** Files the prior agent read to do this work — what to load. Only when includeDetail. */
  filesRead?: string[];
  sessionUrl?: string;
  previousSessionId?: string;
}

export interface FileContextResult {
  repoPath: string;
  paths: string[];
  commits: FileContextCommit[];
  /** Human-readable note when there was nothing to return (not an error). */
  message?: string;
  error?: string;
}

export interface FileContextOptions {
  /**
   * Most-recent commits to inspect per queried path (default 10). This is
   * SCAN DEPTH, not result count — `maxCommits` bounds what comes back. The
   * default is deep enough to see past the unannotated squash commits that
   * sit on top of every path in a squash-merge repo; at 3 the tool reported
   * "no attribution" on repos with a full notes history.
   */
  perPathLimit?: number;
  /** Hard cap on commits returned after de-duping across paths (default 8). */
  maxCommits?: number;
  /**
   * Include the token-heavy detail: full (≤8KB) prompts, the full
   * [Origin: …] markers, and the prior agent's filesRead list. Default
   * false → only short prompt summaries + the compact `signals` headline,
   * so a survey stays cheap and the agent pulls detail only where it
   * matters.
   */
  includeDetail?: boolean;
}

const SUMMARY_MAX = 240;
const FRAGILE_THRESHOLD = 0.5;
const ACCEPTANCE_REF = 'refs/notes/origin-acceptance';

function git(repoPath: string, args: string[]): string {
  return execFileSync('git', ['-C', repoPath, ...args], {
    windowsHide: true,
    stdio: 'pipe',
    timeout: 10_000,
    encoding: 'utf-8',
    maxBuffer: 16 * 1024 * 1024,
  }).toString();
}

function isGitRepo(repoPath: string): boolean {
  try {
    git(repoPath, ['rev-parse', '--git-dir']);
    return true;
  } catch {
    return false;
  }
}

function readOriginNote(repoPath: string, sha: string): Record<string, any> | null {
  let raw: string;
  try {
    raw = git(repoPath, ['notes', '--ref=origin', 'show', sha]).trim();
  } catch {
    return null; // no note on this commit
  }
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw);
    // Notes are stored as { origin: { … } }; tolerate a bare object too.
    return parsed?.origin || parsed;
  } catch {
    return null;
  }
}

function truncate(text: string, max: number): string {
  return text.length > max ? text.slice(0, max) + '…' : text;
}

// Read the acceptance note (refs/notes/origin-acceptance) for a commit —
// how much of that commit's AI-added lines still survive on HEAD. Written
// by the CLI's acceptance backfill (packages/cli/src/acceptance.ts); we
// mirror its ~15-line read path here to stay self-contained. Returns the
// 0..1 rate, or undefined when there's no acceptance note yet.
function readAcceptanceRate(repoPath: string, sha: string): number | undefined {
  let raw: string;
  try {
    raw = git(repoPath, ['notes', `--ref=${ACCEPTANCE_REF}`, 'show', sha]).trim();
  } catch {
    return undefined;
  }
  try {
    const parsed = JSON.parse(raw);
    if (parsed?.version === 1 && typeof parsed.acceptanceRate === 'number') {
      return parsed.acceptanceRate;
    }
  } catch { /* unparseable */ }
  return undefined;
}

// Normalize the note's `markers` object into string[] buckets, dropping
// empties. Tolerant of missing/garbage shapes.
function normalizeMarkers(raw: unknown): FileContextMarkers | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const m = raw as Record<string, unknown>;
  const bucket = (v: unknown): string[] | undefined => {
    if (!Array.isArray(v)) return undefined;
    const out = v.filter((x): x is string => typeof x === 'string' && x.length > 0);
    return out.length ? out : undefined;
  };
  const result: FileContextMarkers = {};
  const intent = bucket(m.intent);
  const decision = bucket(m.decision);
  const open = bucket(m.open);
  const verify = bucket(m.verify);
  if (intent) result.intent = intent;
  if (decision) result.decision = decision;
  if (open) result.open = open;
  if (verify) result.verify = verify;
  return intent || decision || open || verify ? result : undefined;
}

/**
 * Gather the Origin prompts/attribution behind one or more files, newest
 * first. Never throws — returns `{ error }` for a bad repo and `{ message }`
 * when the paths simply have no Origin notes yet.
 */
export function getFileContext(
  repoPath: string,
  paths: string[],
  opts: FileContextOptions = {},
): FileContextResult {
  const perPathLimit = Math.max(1, Math.min(opts.perPathLimit ?? 10, 20));
  const maxCommits = Math.max(1, Math.min(opts.maxCommits ?? 8, 30));
  const includeDetail = opts.includeDetail === true;

  const cleanPaths = Array.from(
    new Set(paths.map((p) => (p || '').trim()).filter(Boolean)),
  );
  if (cleanPaths.length === 0) {
    return { repoPath, paths: [], commits: [], error: 'No file paths provided.' };
  }
  if (!isGitRepo(repoPath)) {
    return { repoPath, paths: cleanPaths, commits: [], error: `Not a git repository: ${repoPath}` };
  }

  // Map each recent commit → the queried paths it touched, keeping the most
  // recent commit date so we can order the merged set.
  const byCommit = new Map<string, { date?: string; touched: Set<string> }>();
  for (const p of cleanPaths) {
    let out = '';
    try {
      // One commit per record. `-z` NUL-TERMINATES each record, so the
      // separator between fields must NOT also be a NUL: the old format
      // (`%H%x00%cI`) produced `sha<NUL>date<NUL>sha<NUL>date…` with no
      // double-NUL anywhere, so splitting records on `\0\0` matched nothing
      // and collapsed the whole log into ONE record — only the newest commit
      // per path was ever inspected and `per_path_limit` did nothing. On a
      // squash-merge repo the newest commit is the squash (never annotated),
      // so the tool reported "no attribution found" against thousands of
      // notes. A space is unambiguous here: %cI is strict ISO-8601, no spaces.
      out = git(repoPath, [
        'log', `-n${perPathLimit}`, '--no-merges', '-z',
        '--format=%H %cI', '--', p,
      ]);
    } catch {
      continue; // unknown path, or file predates history — skip it
    }
    for (const record of out.split('\0')) {
      const [sha, date] = record.trim().split(' ');
      if (!sha || !/^[0-9a-f]{7,40}$/.test(sha.trim())) continue;
      const key = sha.trim();
      const entry = byCommit.get(key) || { date: date?.trim(), touched: new Set<string>() };
      entry.touched.add(p);
      byCommit.set(key, entry);
    }
  }

  // Newest first. NOT capped here: `maxCommits` bounds the commits we
  // RETURN, not the candidates we inspect. Slicing candidates up front threw
  // away annotated commits sitting behind unannotated ones — and on a
  // squash-merge repo the newest commits on a path are exactly that (the
  // squash is a fresh sha the CLI never annotated), so a small max_commits
  // returned nothing against a full notes history. The walk is bounded by
  // perPathLimit × paths regardless, and we stop as soon as the cap fills.
  const ordered = Array.from(byCommit.entries())
    .sort((a, b) => (b[1].date || '').localeCompare(a[1].date || ''));

  const commits: FileContextCommit[] = [];
  for (const [sha, meta] of ordered) {
    if (commits.length >= maxCommits) break;
    const note = readOriginNote(repoPath, sha);
    if (!note || !note.sessionId) continue; // non-Origin commit — nothing to say

    const rawPrompt: string | undefined = includeDetail
      ? (note.fullPrompt || note.promptSummary)
      : (note.promptSummary || (note.fullPrompt ? truncate(note.fullPrompt, SUMMARY_MAX) : undefined));

    const markers = normalizeMarkers(note.markers);
    const filesRead = Array.isArray(note.filesRead)
      ? note.filesRead.filter((f: unknown): f is string => typeof f === 'string')
      : undefined;
    const acceptanceRate = readAcceptanceRate(repoPath, sha);

    // Compact headline — always present, a few tokens, for triage.
    const signals: FileContextSignals = {};
    if (typeof acceptanceRate === 'number') {
      signals.acceptanceRate = acceptanceRate;
      if (acceptanceRate <= FRAGILE_THRESHOLD) signals.fragile = true;
    }
    if (markers?.decision?.length) signals.decisions = markers.decision.length;
    if (markers?.open?.length) signals.openItems = markers.open.length;
    if (markers?.verify?.length) signals.verifyItems = markers.verify.length;
    if (filesRead?.length) signals.filesReadCount = filesRead.length;

    commits.push({
      sha: sha.slice(0, 12),
      date: meta.date,
      agent: note.agent || undefined,
      model: note.model || undefined,
      touched: Array.from(meta.touched),
      files: Array.isArray(note.filesChanged) ? note.filesChanged : undefined,
      prompt: rawPrompt || undefined,
      promptWithheld: !rawPrompt && note.promptTextWithheld === true ? true : undefined,
      signals,
      // Detail is token-heavy — only when explicitly asked.
      markers: includeDetail ? markers : undefined,
      filesRead: includeDetail ? filesRead : undefined,
      sessionUrl: note.originUrl || undefined,
      previousSessionId: note.previousSessionId || undefined,
    });
  }

  if (commits.length === 0) {
    return {
      repoPath,
      paths: cleanPaths,
      commits: [],
      message:
        'No Origin attribution found in git notes for these paths. Either the ' +
        'files predate Origin tracking, or notes have not been fetched into this ' +
        'clone yet (they sync on `origin link` / `origin blame`, and on session start).',
    };
  }

  return { repoPath, paths: cleanPaths, commits };
}
