import fs from 'fs';
import path from 'path';

// ─── Default Ignore Patterns ──────────────────────────────────────────────

const DEFAULT_IGNORE_PATTERNS = [
  // Lock files
  'package-lock.json',
  'yarn.lock',
  'pnpm-lock.yaml',
  'Cargo.lock',
  'go.sum',
  'Gemfile.lock',
  'poetry.lock',
  'composer.lock',
  'Pipfile.lock',
  'shrinkwrap.yaml',
  // Generated / minified
  '*.generated.*',
  '*.min.js',
  '*.min.css',
  '*.map',
  // Directories
  '**/node_modules/**',
  '**/vendor/**',
  '**/__snapshots__/**',
  '**/dist/**',
  '**/.next/**',
  '**/build/**',
  // Snapshots
  '**/*.snap',
  '**/*.snap.new',
  // Database migrations metadata
  '**/drizzle/meta/**',
  '**/prisma/migrations/**',
  // Origin auto-managed agent-rules files. The CLI writes these as a
  // per-repo agent rules buffer (`<!-- origin-managed -->` blocks); the
  // churn they generate is bookkeeping, not the agent's actual work, and
  // pollutes per-prompt AI Blame attribution. AGENTS.md / GEMINI.md /
  // .windsurfrules are *exclusively* Origin-managed (users don't hand-edit
  // them), so blanket-ignoring is safe. We DO NOT add CLAUDE.md here —
  // many projects maintain that file themselves; we only strip the
  // Origin-marker section from those, not the whole file.
  'AGENTS.md',
  'GEMINI.md',
  '.windsurfrules',
  // Claude Code's parallel-branch worktrees. They show up as submodule
  // (160000 mode) entries in git diff when Cursor / other agents run in
  // a repo that previously hosted Claude Code worktrees. They aren't the
  // current agent's work — strip them.
  '**/.claude/worktrees/**',
  '.claude/worktrees/*',
];

// ─── Glob Matching ────────────────────────────────────────────────────────

/**
 * Simple glob matcher supporting *, **, and ? wildcards.
 * Handles the patterns we need without pulling in a dependency.
 */
function globToRegex(pattern: string): RegExp {
  let regex = '';
  let i = 0;
  while (i < pattern.length) {
    const c = pattern[i];
    if (c === '*') {
      if (pattern[i + 1] === '*') {
        if (pattern[i + 2] === '/') {
          regex += '(?:.+/)?';
          i += 3;
          continue;
        }
        regex += '.*';
        i += 2;
        continue;
      }
      regex += '[^/]*';
    } else if (c === '?') {
      regex += '[^/]';
    } else if (c === '.') {
      regex += '\\.';
    } else if (c === '/' || c === '\\') {
      regex += '/';
    } else {
      regex += c;
    }
    i++;
  }
  return new RegExp(`^${regex}$`);
}

// ─── Public API ───────────────────────────────────────────────────────────

/**
 * Check if a file path should be ignored based on patterns.
 * Patterns can be globs (e.g., "*.lock") or exact matches.
 */
export function shouldIgnoreFile(filePath: string, customPatterns?: string[]): boolean {
  const patterns = [...DEFAULT_IGNORE_PATTERNS, ...(customPatterns || [])];
  const normalized = filePath.replace(/\\/g, '/');
  const basename = path.basename(normalized);

  for (const pattern of patterns) {
    // Check against full path and basename
    try {
      const regex = globToRegex(pattern);
      if (regex.test(normalized) || regex.test(basename)) {
        return true;
      }
    } catch {
      // If glob parsing fails, try exact match
      if (normalized.endsWith(pattern) || basename === pattern) {
        return true;
      }
    }
  }
  return false;
}

/**
 * Load additional ignore patterns from .gitattributes (linguist-generated).
 */
export function loadGitattributesPatterns(repoPath: string): string[] {
  const patterns: string[] = [];
  try {
    const content = fs.readFileSync(path.join(repoPath, '.gitattributes'), 'utf-8');
    for (const line of content.split('\n')) {
      const trimmed = line.trim();
      if (trimmed.includes('linguist-generated') || trimmed.includes('linguist-vendored')) {
        const filePart = trimmed.split(/\s+/)[0];
        if (filePart) patterns.push(filePart);
      }
    }
  } catch {
    // No .gitattributes or unreadable
  }
  return patterns;
}

/**
 * Get the combined ignore patterns for a repo.
 */
export function getIgnorePatterns(repoPath: string, customPatterns?: string[]): string[] {
  return [
    ...DEFAULT_IGNORE_PATTERNS,
    ...loadGitattributesPatterns(repoPath),
    ...(customPatterns || []),
  ];
}

export { DEFAULT_IGNORE_PATTERNS };

/**
 * Remove `diff --git` sections whose target file is ignored. Walks a
 * unified diff text and drops any section whose `b/<path>` header matches
 * an ignore pattern. Order-preserving, returns the trimmed remainder.
 *
 * Used by git-capture so the per-prompt diffs we ship to the platform
 * don't include Origin's auto-managed agent-rules files (AGENTS.md,
 * GEMINI.md, etc.) — that churn would otherwise show up as
 * AI-attributed lines in the blame view.
 */
export function stripIgnoredSectionsFromDiff(
  diffText: string,
  customPatterns?: string[],
): string {
  if (!diffText) return diffText;
  // Split keeping the leading "diff --git " marker on each section.
  const parts = diffText.split(/^(?=diff --git )/m);
  const kept: string[] = [];
  for (const part of parts) {
    const header = part.split('\n', 1)[0] || '';
    const m = header.match(/^diff --git a\/(.+?) b\/(.+)$/);
    const filePath = m ? m[2] : '';
    if (filePath && shouldIgnoreFile(filePath, customPatterns)) continue;
    // CLAUDE.md is special — many projects hand-edit it, so we DON'T blanket
    // ignore. But Origin's hooks write a `<!-- origin-managed -->` block into
    // it on every session, and when the entire diff for CLAUDE.md is inside
    // that block (e.g. a freshly-created file with only Origin's content),
    // it's pure bookkeeping noise that pollutes the per-prompt blame view.
    // Drop the section only in that case; if the diff has any non-managed
    // `+`/`-` line, keep it.
    const basename = filePath.split('/').pop() || '';
    if (basename === 'CLAUDE.md' && isDiffEntirelyOriginManaged(part)) continue;
    kept.push(part);
  }
  return kept.join('').trim();
}

// True iff every `+` / `-` line in the section is either a paired
// `<!-- origin-managed -->` marker line or sits between such markers.
function isDiffEntirelyOriginManaged(fileSection: string): boolean {
  let inBlock = false;
  let hasChanges = false;
  let hasNonManagedChange = false;
  const MARKER = '<!-- origin-managed -->';
  for (const raw of fileSection.split('\n')) {
    if (
      raw.startsWith('diff --git ') ||
      raw.startsWith('index ') ||
      raw.startsWith('new file') ||
      raw.startsWith('deleted file') ||
      raw.startsWith('old mode') ||
      raw.startsWith('new mode') ||
      raw.startsWith('similarity') ||
      raw.startsWith('rename ') ||
      raw.startsWith('Binary ') ||
      raw.startsWith('--- ') ||
      raw.startsWith('+++ ') ||
      raw.startsWith('@@') ||
      raw.startsWith('\\ ')
    ) continue;
    if (!raw.startsWith('+') && !raw.startsWith('-')) continue;
    hasChanges = true;
    const content = raw.slice(1);
    if (content.includes(MARKER)) {
      // The marker line itself toggles block membership AFTER it's read;
      // either way it's pure Origin content so don't flag it.
      inBlock = !inBlock;
      continue;
    }
    if (!inBlock) hasNonManagedChange = true;
  }
  return hasChanges && !hasNonManagedChange;
}
