import { execFileSync } from 'child_process';
import { listActiveSessions } from './session-state.js';

// ─── Tool Detection ──────────────────────────────────────────────────────

function detectToolFromModel(model: string, fallbackTool?: string): string {
  const m = (model || '').toLowerCase();
  if (m.includes('claude') || m.includes('sonnet') || m.includes('opus') || m.includes('haiku')) return 'claude-code';
  if (m.includes('gemini') || m.includes('gemma')) return 'gemini-cli';
  if (m.includes('gpt') || m.includes('o1-') || m.includes('o3-') || m.includes('o4-')) return 'cursor';
  if (m.includes('codex')) return 'codex';
  if (m.includes('windsurf')) return 'windsurf';
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

export type LineAuthorship = 'ai' | 'human' | 'mixed';

export interface LineAttribution {
  lineNumber: number;
  authorship: LineAuthorship;
  sessionId?: string;
  model?: string;
  author?: string;
  tool?: string;
}

export interface FileAttribution {
  filePath: string;
  lines: LineAttribution[];
  totalLines: number;
  aiLines: number;
  humanLines: number;
  mixedLines: number;
  aiPercentage: number;
  humanPercentage: number;
  mixedPercentage: number;
}

export interface CommitAttribution {
  commitSha: string;
  files: FileAttribution[];
  totalLines: number;
  aiLines: number;
  humanLines: number;
  mixedLines: number;
  aiPercentage: number;
  humanPercentage: number;
  mixedPercentage: number;
}

export interface AcceptanceMetrics {
  totalAiLines: number;
  acceptedLines: number;
  overriddenLines: number;
  deletedLines: number;
  acceptanceRate: number;
}

export interface MoveDetection {
  oldPath: string;
  newPath: string;
  similarity: number;
}

// ─── Git Helpers ──────────────────────────────────────────────────────────

const execOpts = (cwd: string) => ({
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
 * Check if a commit has an Origin-Session trailer or note.
 */
export function isAiCommit(repoPath: string, commitSha: string): boolean {
  // Check git notes (stored as { origin: { sessionId, ... } })
  const rawNote = readOriginNote(repoPath, commitSha);
  const note = rawNote?.origin || rawNote;
  if (note?.sessionId && note.sessionId !== 'unknown') return true;
  // Backfill notes have agent but no sessionId
  if (note?.agent && note.agent !== 'Human') return true;

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

// ─── Line-Level Attribution ──────────────────────────────────────────────

/**
 * Parse git blame --porcelain output to get per-line commit info.
 */
function parseBlameOutput(output: string): Array<{ lineNumber: number; commitSha: string; author: string }> {
  const lines = output.split('\n');
  const result: Array<{ lineNumber: number; commitSha: string; author: string }> = [];
  let currentSha = '';
  let currentAuthor = '';
  let currentLine = 0;

  for (const line of lines) {
    // Header line: <sha> <orig-line> <final-line> [<num-lines>]
    const headerMatch = line.match(/^([0-9a-f]{40})\s+\d+\s+(\d+)/);
    if (headerMatch) {
      currentSha = headerMatch[1];
      currentLine = parseInt(headerMatch[2], 10);
      continue;
    }
    if (line.startsWith('author ')) {
      currentAuthor = line.slice(7);
      continue;
    }
    if (line.startsWith('\t')) {
      // Content line — finalize this entry
      result.push({ lineNumber: currentLine, commitSha: currentSha, author: currentAuthor });
    }
  }
  return result;
}

/**
 * Detect AI authorship from commit message trailers or known patterns.
 * Fallback when no origin note exists for a commit.
 */
function detectAiFromCommit(repoPath: string, commitSha: string): { isAi: boolean; model?: string } | null {
  // Skip uncommitted lines (all zeros)
  if (commitSha === '0000000000000000000000000000000000000000') return null;
  try {
    const message = execFileSync('git', ['log', '-1', '--format=%B', commitSha], execOpts(repoPath)).trim();

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
  } catch {
    return null;
  }
}

/**
 * Get line-level AI attribution for a file by cross-referencing git blame with origin notes.
 * Falls back to commit message trailer detection and AI process pattern matching.
 */
export function getLineBlame(repoPath: string, filePath: string): LineAttribution[] {
  try {
    const blameOutput = execFileSync('git', ['blame', '--porcelain', '--', filePath], execOpts(repoPath)).trim();

    const blameLines = parseBlameOutput(blameOutput);

    // Cache note lookups per commit
    const noteCache = new Map<string, Record<string, any> | null>();
    const getNote = (sha: string) => {
      if (!noteCache.has(sha)) {
        noteCache.set(sha, readOriginNote(repoPath, sha));
      }
      return noteCache.get(sha)!;
    };

    // Cache commit message fallback detection per commit
    const commitDetectCache = new Map<string, { isAi: boolean; model?: string } | null>();
    const getCommitDetection = (sha: string) => {
      if (!commitDetectCache.has(sha)) {
        commitDetectCache.set(sha, detectAiFromCommit(repoPath, sha));
      }
      return commitDetectCache.get(sha);
    };

    return blameLines.map(({ lineNumber, commitSha, author }) => {
      const rawNote = getNote(commitSha);
      // Notes are stored as { origin: { sessionId, model, ... } }
      const note = rawNote?.origin || rawNote;
      let isAi = !!note?.sessionId && note.sessionId !== 'unknown';
      let model = note?.model;

      // Fallback: check commit message trailers and patterns
      if (!isAi) {
        const detected = getCommitDetection(commitSha);
        if (detected?.isAi) {
          isAi = true;
          model = model || detected.model;
        }
      }

      const tool = model ? detectToolFromModel(model, note?.tool) : undefined;
      return {
        lineNumber,
        authorship: isAi ? 'ai' as const : 'human' as const,
        sessionId: note?.sessionId,
        model: model,
        tool: tool,
        author: author,
      };
    });
  } catch {
    return [];
  }
}

// ─── File Attribution ────────────────────────────────────────────────────

/**
 * Compute attribution for a single file.
 */
export function computeFileAttribution(repoPath: string, filePath: string): FileAttribution {
  const lines = getLineBlame(repoPath, filePath);
  const totalLines = lines.length;
  const aiLines = lines.filter(l => l.authorship === 'ai').length;
  const humanLines = lines.filter(l => l.authorship === 'human').length;
  const mixedLines = lines.filter(l => l.authorship === 'mixed').length;

  return {
    filePath,
    lines,
    totalLines,
    aiLines,
    humanLines,
    mixedLines,
    aiPercentage: totalLines > 0 ? Math.round((aiLines / totalLines) * 100) : 0,
    humanPercentage: totalLines > 0 ? Math.round((humanLines / totalLines) * 100) : 0,
    mixedPercentage: totalLines > 0 ? Math.round((mixedLines / totalLines) * 100) : 0,
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

  let totalAi = 0, totalHuman = 0, totalMixed = 0, totalLines = 0;

  for (const file of files) {
    try {
      // Check if file still exists at HEAD
      execFileSync('git', ['cat-file', '-e', `HEAD:${file}`], execOpts(repoPath));
      const attr = computeFileAttribution(repoPath, file);
      fileAttributions.push(attr);
      totalAi += attr.aiLines;
      totalHuman += attr.humanLines;
      totalMixed += attr.mixedLines;
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
    humanLines: totalHuman,
    mixedLines: totalMixed,
    aiPercentage: totalLines > 0 ? Math.round((totalAi / totalLines) * 100) : 0,
    humanPercentage: totalLines > 0 ? Math.round((totalHuman / totalLines) * 100) : 0,
    mixedPercentage: totalLines > 0 ? Math.round((totalMixed / totalLines) * 100) : 0,
  };
}

// ─── Acceptance Metrics ──────────────────────────────────────────────────

/**
 * Compute acceptance metrics: how many AI-written lines survived vs were overridden.
 *
 * Walks commits in a range, identifies AI-authored lines, then checks if
 * they were subsequently modified by human commits.
 */
export function computeAcceptanceMetrics(
  repoPath: string,
  commitRange?: string,
): AcceptanceMetrics {
  const range = commitRange || 'HEAD~20..HEAD';
  let totalAiLines = 0;
  let acceptedLines = 0;
  let overriddenLines = 0;
  let deletedLines = 0;

  try {
    // Get commits in range
    const commits = execFileSync('git', ['log', '--format=%H', range], execOpts(repoPath)).trim().split('\n').filter(Boolean);

    // Track AI-authored lines across commits
    const aiLineTracker = new Map<string, Set<number>>(); // file -> line numbers

    for (const sha of commits.reverse()) {
      if (!isAiCommit(repoPath, sha)) continue;

      // Get added lines from this AI commit
      try {
        const diff = execFileSync('git', ['diff-tree', '-p', sha], execOpts(repoPath)).trim();

        let currentFile = '';
        let lineNum = 0;
        for (const line of diff.split('\n')) {
          const fileMatch = line.match(/^\+\+\+ b\/(.*)/);
          if (fileMatch) {
            currentFile = fileMatch[1];
            if (!aiLineTracker.has(currentFile)) {
              aiLineTracker.set(currentFile, new Set());
            }
            continue;
          }
          const hunkMatch = line.match(/^@@ -\d+(?:,\d+)? \+(\d+)/);
          if (hunkMatch) {
            lineNum = parseInt(hunkMatch[1], 10);
            continue;
          }
          if (line.startsWith('+') && !line.startsWith('+++')) {
            aiLineTracker.get(currentFile)?.add(lineNum);
            totalAiLines++;
            lineNum++;
          } else if (line.startsWith('-')) {
            // deletion, don't increment
          } else {
            lineNum++;
          }
        }
      } catch { /* skip */ }
    }

    // Check current state of AI-authored lines
    for (const [file, lineNums] of aiLineTracker) {
      try {
        const fileAttr = computeFileAttribution(repoPath, file);
        for (const ln of lineNums) {
          const lineAttr = fileAttr.lines.find(l => l.lineNumber === ln);
          if (!lineAttr) {
            deletedLines++;
          } else if (lineAttr.authorship === 'ai') {
            acceptedLines++;
          } else {
            overriddenLines++;
          }
        }
      } catch {
        deletedLines += lineNums.size;
      }
    }
  } catch { /* empty range or git error */ }

  return {
    totalAiLines,
    acceptedLines,
    overriddenLines,
    deletedLines,
    acceptanceRate: totalAiLines > 0 ? acceptedLines / totalAiLines : 1,
  };
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
  // removed entirely. Rate excludes deletions from the denominator (we can't
  // tell whether a deletion was rejection or intended cleanup).
  acceptedLines: number;
  overriddenLines: number;
  deletedLines: number;
  acceptanceRate: number;
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

  // Track which AI-written lines belong to which model so we can roll up
  // per-model acceptance after the per-commit loop. File -> (lineNum -> model).
  const aiLineOwners = new Map<string, Map<number, string>>();

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
      let isAi = (!!note?.sessionId && note.sessionId !== 'unknown') || (!!note?.agent && note.agent !== 'Human');
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
            acceptanceRate: 1,
          };
          modelEntry.commits++;
          modelEntry.linesAdded += commitLines;
          // Pull per-commit cost from the git note if present.
          const noteCost = typeof note?.costUsd === 'number' ? note.costUsd : 0;
          modelEntry.costUsd += noteCost;
          byModel.set(model, modelEntry);

          // Record which lines this model wrote so we can compute per-model
          // acceptance after the loop.
          try {
            const diff = execFileSync('git', ['diff-tree', '-p', sha], execOpts(repoPath)).trim();
            let currentFile = '';
            let lineNum = 0;
            for (const diffLine of diff.split('\n')) {
              const fileMatch = diffLine.match(/^\+\+\+ b\/(.*)/);
              if (fileMatch) { currentFile = fileMatch[1]; continue; }
              const hunkMatch = diffLine.match(/^@@ -\d+(?:,\d+)? \+(\d+)/);
              if (hunkMatch) { lineNum = parseInt(hunkMatch[1], 10); continue; }
              if (diffLine.startsWith('+') && !diffLine.startsWith('+++')) {
                if (!aiLineOwners.has(currentFile)) aiLineOwners.set(currentFile, new Map());
                // A later AI commit by a different model OVERWRITES the owner
                // for that line number — this matches the "most recent AI
                // author wins" semantic used elsewhere in the codebase.
                aiLineOwners.get(currentFile)!.set(lineNum, model);
                lineNum++;
              } else if (!diffLine.startsWith('-')) {
                lineNum++;
              }
            }
          } catch { /* skip line tracking on this commit */ }
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

  // ── Per-model acceptance rollup ─────────────────────────────────────
  // For each tracked AI-written line, check whether it's still attributed to
  // 'ai' in the current file state. If yes → accepted. If it's now 'human' or
  // 'mixed' → overridden. If the file or line is gone → deleted. Roll the
  // totals up per model so `byModel[m].acceptanceRate` has a real value.
  //
  // `computeFileAttribution` hits git blame per file, so cache per file.
  const fileAttrCache = new Map<string, ReturnType<typeof computeFileAttribution> | null>();
  for (const [file, owners] of aiLineOwners) {
    let fileAttr = fileAttrCache.get(file);
    if (fileAttr === undefined) {
      try { fileAttr = computeFileAttribution(repoPath, file); }
      catch { fileAttr = null; }
      fileAttrCache.set(file, fileAttr);
    }
    for (const [ln, model] of owners) {
      const entry = byModel.get(model);
      if (!entry) continue;
      if (!fileAttr) {
        entry.deletedLines++;
        continue;
      }
      const lineAttr = fileAttr.lines.find((l) => l.lineNumber === ln);
      if (!lineAttr) entry.deletedLines++;
      else if (lineAttr.authorship === 'ai') entry.acceptedLines++;
      else entry.overriddenLines++;
    }
  }
  // Compute rate per model. Denominator excludes deletions on the same
  // rationale as the global AcceptanceMetrics: a removed line might be a
  // rejection OR an intentional cleanup, so we don't penalize either way.
  for (const [model, entry] of byModel) {
    const denom = entry.acceptedLines + entry.overriddenLines;
    entry.acceptanceRate = denom > 0 ? entry.acceptedLines / denom : 1;
    byModel.set(model, entry);
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
    acceptance: computeAcceptanceMetrics(repoPath, range),
  };
}

/**
 * Build a concise AI attribution context string for injection into agent system prompts.
 * Designed to be fast (lightweight git operations, limited commit range).
 * Returns null if no meaningful AI activity found.
 */
export function buildAttributionContext(repoPath: string): string | null {
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

      let isAi = !!note?.sessionId && note.sessionId !== 'unknown';
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
        changedFiles = filesRaw.split('\n').filter(Boolean).slice(0, 10);
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
 * Summarizes line-level authorship into compact ranges.
 * Returns null if no attribution data available.
 */
export function buildFileAttributionContext(repoPath: string, filePath: string): string | null {
  try {
    const lines = getLineBlame(repoPath, filePath);
    if (lines.length === 0) return null;

    // Group consecutive lines by the same author/tool
    interface Range {
      start: number;
      end: number;
      authorship: 'ai' | 'human';
      tool?: string;
      model?: string;
      author: string;
    }

    const ranges: Range[] = [];
    let current: Range | null = null;

    for (const line of lines) {
      const key = `${line.authorship}|${line.tool || ''}|${line.model || ''}|${line.author}`;
      const prevKey = current
        ? `${current.authorship}|${current.tool || ''}|${current.model || ''}|${current.author}`
        : '';

      if (current && key === prevKey && line.lineNumber === current.end + 1) {
        current.end = line.lineNumber;
      } else {
        if (current) ranges.push(current);
        current = {
          start: line.lineNumber,
          end: line.lineNumber,
          authorship: line.authorship as 'ai' | 'human',
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
    const aiPct = Math.round((aiLines / totalLines) * 100);

    const parts: string[] = [];
    parts.push(`File attribution for ${filePath}: ${aiPct}% AI-generated (${aiLines}/${totalLines} lines).`);

    for (const r of topRanges) {
      const lineRange = r.start === r.end ? `Line ${r.start}` : `Lines ${r.start}-${r.end}`;
      if (r.authorship === 'ai') {
        parts.push(`  ${lineRange}: ${r.tool || 'AI'} (${r.model || 'unknown'})`);
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
