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
