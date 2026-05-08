// Acceptance backfill: after a session finishes, look at the *previous*
// session's commits and measure how many of those AI-added lines still exist
// on HEAD. This answers "did the human keep the prior agent's output, or
// override it?" — gold for the next agent reading blame.
//
// Stored in a separate ref (refs/notes/origin-acceptance) so we never mutate
// the original session's note. Same push semantics as refs/notes/origin.

import { execFileSync } from 'child_process';

const ACCEPTANCE_REF = 'refs/notes/origin-acceptance';

export interface AcceptanceNote {
  version: 1;
  sessionId: string;
  computedAt: string;
  // AI lines added by this commit (per `git diff-tree`).
  addedLines: number;
  // AI lines still present on HEAD per `git blame` (i.e., not overwritten).
  survivingLines: number;
  // survivingLines / addedLines, rounded to 2 decimals. 0..1.
  acceptanceRate: number;
}

const execOpts = (cwd: string) => ({
  cwd,
  encoding: 'utf-8' as const,
  stdio: ['pipe', 'pipe', 'pipe'] as ['pipe', 'pipe', 'pipe'],
  maxBuffer: 10 * 1024 * 1024,
  timeout: 15000,
});

// Files added by `commitSha` and the line ranges that commit added in each
// file's post-commit numbering. Returns null when diff-tree fails (e.g. root
// commit, broken refs).
function getAddedLineRanges(
  repoPath: string,
  commitSha: string,
): Array<{ file: string; lines: number[] }> | null {
  let diff: string;
  try {
    diff = execFileSync(
      'git',
      ['diff-tree', '-p', '--no-color', '-M', '-C', commitSha],
      execOpts(repoPath),
    );
  } catch {
    return null;
  }

  const out: Array<{ file: string; lines: number[] }> = [];
  let currentFile = '';
  let currentLines: number[] = [];
  let lineNum = 0;

  const flush = () => {
    if (currentFile && currentLines.length) {
      out.push({ file: currentFile, lines: currentLines });
    }
    currentFile = '';
    currentLines = [];
    lineNum = 0;
  };

  for (const line of diff.split('\n')) {
    const fileMatch = line.match(/^\+\+\+ b\/(.*)$/);
    if (fileMatch) {
      flush();
      currentFile = fileMatch[1];
      continue;
    }
    if (line.startsWith('--- ')) continue;
    const hunkMatch = line.match(/^@@ -\d+(?:,\d+)? \+(\d+)/);
    if (hunkMatch) {
      lineNum = parseInt(hunkMatch[1], 10);
      continue;
    }
    if (line.startsWith('+') && !line.startsWith('+++')) {
      currentLines.push(lineNum);
      lineNum++;
    } else if (line.startsWith('-')) {
      // deletion — don't advance post-commit line counter
    } else if (!line.startsWith('\\')) {
      lineNum++;
    }
  }
  flush();
  return out;
}

// For each (file, line) added by `commitSha`, check whether that line is
// still attributed to `commitSha` on HEAD. If yes, it survived. If the file
// was deleted or the line was overwritten, blame returns a different SHA.
function countSurviving(
  repoPath: string,
  commitSha: string,
  added: Array<{ file: string; lines: number[] }>,
): number {
  let surviving = 0;
  for (const { file, lines } of added) {
    if (!lines.length) continue;
    let blame: string;
    try {
      blame = execFileSync(
        'git',
        ['blame', '--porcelain', 'HEAD', '--', file],
        execOpts(repoPath),
      );
    } catch {
      // File deleted or unblameable — none of these lines survived.
      continue;
    }
    // Build line -> sha map. Porcelain header is `<sha> <orig> <final> [<n>]`.
    // Following lines until the content tab carry metadata. We only need sha
    // per final line, so we map header SHA to its `final` line number.
    const lineToSha = new Map<number, string>();
    for (const raw of blame.split('\n')) {
      const m = raw.match(/^([0-9a-f]{40})\s+\d+\s+(\d+)/);
      if (m) {
        lineToSha.set(parseInt(m[2], 10), m[1]);
      }
    }
    for (const ln of lines) {
      if (lineToSha.get(ln) === commitSha) surviving++;
    }
  }
  return surviving;
}

export function computeCommitAcceptance(
  repoPath: string,
  commitSha: string,
): { addedLines: number; survivingLines: number } {
  const added = getAddedLineRanges(repoPath, commitSha);
  if (!added) return { addedLines: 0, survivingLines: 0 };
  const addedLines = added.reduce((sum, f) => sum + f.lines.length, 0);
  if (addedLines === 0) return { addedLines: 0, survivingLines: 0 };
  const survivingLines = countSurviving(repoPath, commitSha, added);
  return { addedLines, survivingLines };
}

export function writeAcceptanceNote(
  repoPath: string,
  commitSha: string,
  note: AcceptanceNote,
): void {
  try {
    execFileSync(
      'git',
      ['notes', `--ref=${ACCEPTANCE_REF.replace('refs/notes/', '')}`, 'add', '-f', '-m', JSON.stringify(note, null, 2), commitSha],
      execOpts(repoPath),
    );
  } catch {
    // Non-fatal: acceptance is a nice-to-have.
  }
}

export function readAcceptanceNote(
  repoPath: string,
  commitSha: string,
): AcceptanceNote | null {
  try {
    const raw = execFileSync(
      'git',
      ['notes', `--ref=origin-acceptance`, 'show', commitSha],
      execOpts(repoPath),
    ).trim();
    const parsed = JSON.parse(raw);
    if (parsed?.version === 1) return parsed;
    return null;
  } catch {
    return null;
  }
}

// Find commits in the recent history that belong to `sessionId` (per their
// origin note) and write an acceptance note for each. Bounded both by commit
// scan window and per-session commit count to keep session-end snappy on
// repos with hot files (each commit triggers a `git blame` per touched file).
//
// Optionally pass `sinceIso` (the previous session's startedAt) to scope the
// scan to commits the prior session could have authored — much cheaper than
// reading notes on every recent commit.
export function backfillAcceptanceForSession(
  repoPath: string,
  sessionId: string,
  opts: { scanLimit?: number; maxCommits?: number; sinceIso?: string } = {},
): number {
  if (!sessionId || sessionId === 'unknown' || sessionId.startsWith('local-')) {
    return 0;
  }
  const scanLimit = opts.scanLimit ?? 50;
  const maxCommits = opts.maxCommits ?? 20;

  let shas: string[];
  try {
    const args = ['log', `-n${scanLimit}`, '--format=%H'];
    if (opts.sinceIso) args.push(`--since=${opts.sinceIso}`);
    args.push('HEAD');
    shas = execFileSync('git', args, execOpts(repoPath))
      .trim()
      .split('\n')
      .filter(Boolean);
  } catch {
    return 0;
  }

  // First pass: cheaply collect this session's commits without doing any
  // blame work. If the session touched too many commits, skip backfill —
  // running blame across all of them would block agent shutdown.
  const sessionCommits: string[] = [];
  for (const sha of shas) {
    let note: any = null;
    try {
      const raw = execFileSync(
        'git',
        ['notes', '--ref=origin', 'show', sha],
        execOpts(repoPath),
      ).trim();
      note = JSON.parse(raw);
    } catch {
      continue;
    }
    const noteSession = note?.origin?.sessionId || note?.sessionId;
    if (noteSession === sessionId) sessionCommits.push(sha);
    if (sessionCommits.length > maxCommits) return 0;
  }

  let written = 0;
  for (const sha of sessionCommits) {
    const { addedLines, survivingLines } = computeCommitAcceptance(repoPath, sha);
    if (addedLines === 0) continue;
    writeAcceptanceNote(repoPath, sha, {
      version: 1,
      sessionId,
      computedAt: new Date().toISOString(),
      addedLines,
      survivingLines,
      acceptanceRate: Math.round((survivingLines / addedLines) * 100) / 100,
    });
    written++;
  }
  return written;
}
