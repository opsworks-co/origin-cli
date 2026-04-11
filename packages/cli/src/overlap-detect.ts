import fs from 'fs';
import path from 'path';
import { git } from './utils/exec.js';
import { listActiveSessions, getGitRoot, type SessionState } from './session-state.js';

// ─── Types ─────────────────────────────────────────────────────────────────

export interface OverlapResult {
  file: string;
  sessions: string[];
  overlappingLines: number[];
  severity: 'none' | 'partial' | 'conflict';
}

interface SessionFileInfo {
  sessionId: string;
  sessionTag?: string;
  files: string[];
  lineMap: Map<string, Set<number>>;
}

// ─── Overlap Detection ─────────────────────────────────────────────────────

/**
 * Detect files modified by multiple concurrent sessions.
 * Uses transcript data and git diff to find overlapping file edits.
 * Returns overlap results sorted by severity (conflict > partial > none).
 */
export function detectOverlaps(repoPath: string): OverlapResult[] {
  const sessions = listActiveSessions(repoPath);
  if (sessions.length < 2) {
    return [];
  }

  // Gather file modifications for each session
  const sessionInfos = sessions.map(s => gatherSessionFiles(repoPath, s));

  // Find files touched by multiple sessions
  const fileToSessions = new Map<string, SessionFileInfo[]>();
  for (const info of sessionInfos) {
    for (const file of info.files) {
      const existing = fileToSessions.get(file) || [];
      existing.push(info);
      fileToSessions.set(file, existing);
    }
  }

  // Build overlap results for files touched by 2+ sessions
  const results: OverlapResult[] = [];
  for (const [file, infos] of fileToSessions) {
    if (infos.length < 2) continue;

    const sessionIds = infos.map(i => i.sessionId);
    const overlappingLines = findOverlappingLines(file, infos);
    const severity = computeSeverity(overlappingLines, infos, file);

    results.push({
      file,
      sessions: sessionIds,
      overlappingLines,
      severity,
    });
  }

  // Sort by severity: conflict first, then partial, then none
  const severityOrder = { conflict: 0, partial: 1, none: 2 };
  results.sort((a, b) => severityOrder[a.severity] - severityOrder[b.severity]);

  return results;
}

/**
 * Quick check: are there any file overlaps between active sessions?
 * Cheaper than full detectOverlaps — just checks file lists.
 */
export function hasOverlaps(repoPath: string): boolean {
  const sessions = listActiveSessions(repoPath);
  if (sessions.length < 2) return false;

  const allFiles = new Set<string>();
  for (const session of sessions) {
    const files = getSessionModifiedFiles(repoPath, session);
    for (const file of files) {
      if (allFiles.has(file)) return true;
      allFiles.add(file);
    }
  }
  return false;
}

/**
 * Format overlap results for display in CLI output.
 */
export function formatOverlapWarnings(results: OverlapResult[]): string[] {
  const warnings: string[] = [];

  for (const result of results) {
    if (result.severity === 'none') continue;

    const sessionList = result.sessions.map(s => s.slice(0, 8)).join(', ');
    if (result.severity === 'conflict') {
      warnings.push(
        `CONFLICT: ${result.file} modified by sessions [${sessionList}] ` +
        `(${result.overlappingLines.length} overlapping lines)`
      );
    } else if (result.severity === 'partial') {
      warnings.push(
        `WARNING: ${result.file} modified by sessions [${sessionList}] ` +
        `(different sections)`
      );
    }
  }

  return warnings;
}

// ─── Internal Helpers ──────────────────────────────────────────────────────

/**
 * Gather files modified by a session from its transcript and git state.
 */
function gatherSessionFiles(repoPath: string, session: SessionState): SessionFileInfo {
  const files = getSessionModifiedFiles(repoPath, session);
  const lineMap = new Map<string, Set<number>>();

  // For each modified file, get the significant lines changed
  for (const file of files) {
    const lines = getModifiedLines(repoPath, session, file);
    lineMap.set(file, new Set(lines));
  }

  return {
    sessionId: session.sessionId,
    sessionTag: session.sessionTag,
    files,
    lineMap,
  };
}

/**
 * Get list of files modified by a session.
 * Uses git diff from session's headShaAtStart to current HEAD,
 * and also checks the transcript for Write/Edit tool calls.
 */
function getSessionModifiedFiles(repoPath: string, session: SessionState): string[] {
  const files = new Set<string>();

  // Method 1: Git diff from session start to current HEAD
  if (session.headShaAtStart && /^[a-fA-F0-9]+$/.test(session.headShaAtStart)) {
    try {
      const raw = git(
        ['diff', '--name-only', `${session.headShaAtStart}..HEAD`],
        { cwd: repoPath, timeoutMs: 10_000 }
      ).trim();
      if (raw) {
        for (const f of raw.split('\n').filter(Boolean)) {
          files.add(f);
        }
      }
    } catch {
      // Session start SHA may not exist anymore (e.g., after rebase)
    }
  }

  // Method 2: Parse transcript for file modification tool calls
  if (session.transcriptPath && fs.existsSync(session.transcriptPath)) {
    try {
      const raw = fs.readFileSync(session.transcriptPath, 'utf-8');
      const transcriptFiles = extractFilesFromTranscript(raw, repoPath);
      for (const f of transcriptFiles) {
        files.add(f);
      }
    } catch {
      // Transcript may be corrupt or in an unexpected format
    }
  }

  return Array.from(files);
}

/**
 * Extract file paths from transcript data (Write/Edit tool calls).
 */
function extractFilesFromTranscript(raw: string, repoPath: string): string[] {
  const files = new Set<string>();
  const FILE_TOOLS = new Set(['Write', 'Edit', 'NotebookEdit', 'mcp__acp__Write', 'mcp__acp__Edit']);

  const lines = raw.split('\n').filter(l => l.trim());
  for (const line of lines) {
    try {
      const entry = JSON.parse(line);
      const content = entry.message?.content;
      if (!Array.isArray(content)) continue;

      for (const block of content) {
        if (block.type === 'tool_use' && block.name && FILE_TOOLS.has(block.name) && block.input) {
          const filePath = block.input.file_path || block.input.notebook_path || block.input.path;
          if (filePath && typeof filePath === 'string') {
            // Make path relative to repo root
            const rel = filePath.startsWith(repoPath)
              ? filePath.slice(repoPath.length + 1)
              : filePath;
            files.add(rel);
          }
        }
      }
    } catch {
      continue;
    }
  }

  return Array.from(files);
}

/**
 * Get line numbers modified by a session in a specific file.
 * Uses git diff with line numbers.
 */
function getModifiedLines(repoPath: string, session: SessionState, file: string): number[] {
  const lines: number[] = [];

  if (!session.headShaAtStart) return lines;
  if (!/^[a-fA-F0-9]+$/.test(session.headShaAtStart)) return lines;

  try {
    const diff = git(
      ['diff', '-U0', `${session.headShaAtStart}..HEAD`, '--', file],
      { cwd: repoPath, timeoutMs: 10_000 }
    ).trim();

    if (!diff) return lines;

    // Parse unified diff hunk headers: @@ -old,count +new,count @@
    const hunkPattern = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/gm;
    let match;
    while ((match = hunkPattern.exec(diff)) !== null) {
      const start = parseInt(match[1], 10);
      const count = match[2] ? parseInt(match[2], 10) : 1;
      for (let i = start; i < start + count; i++) {
        lines.push(i);
      }
    }
  } catch {
    // File may not exist in one of the revisions
  }

  return lines;
}

/**
 * Find line numbers that overlap between multiple sessions for a given file.
 */
function findOverlappingLines(file: string, infos: SessionFileInfo[]): number[] {
  if (infos.length < 2) return [];

  // Count how many sessions modify each line
  const lineCounts = new Map<number, number>();
  for (const info of infos) {
    const lines = info.lineMap.get(file);
    if (!lines) continue;
    for (const line of lines) {
      lineCounts.set(line, (lineCounts.get(line) || 0) + 1);
    }
  }

  // Lines touched by 2+ sessions
  const overlapping: number[] = [];
  for (const [line, count] of lineCounts) {
    if (count >= 2) {
      overlapping.push(line);
    }
  }

  return overlapping.sort((a, b) => a - b);
}

/**
 * Determine severity of overlap based on line analysis.
 * - 'conflict': same significant lines modified by multiple sessions
 * - 'partial': same file but different sections
 * - 'none': file listed by both but no actual line overlap
 */
function computeSeverity(
  overlappingLines: number[],
  infos: SessionFileInfo[],
  file: string,
): 'none' | 'partial' | 'conflict' {
  if (overlappingLines.length === 0) {
    // No line overlap — check if both actually modified lines
    let sessionsWithLines = 0;
    for (const info of infos) {
      const lines = info.lineMap.get(file);
      if (lines && lines.size > 0) sessionsWithLines++;
    }
    return sessionsWithLines >= 2 ? 'partial' : 'none';
  }

  // Filter to significant lines (>10 chars, not just whitespace/imports/braces)
  // We can't check content here without reading the file, so use line count heuristic
  if (overlappingLines.length >= 3) {
    return 'conflict';
  }

  return 'partial';
}

