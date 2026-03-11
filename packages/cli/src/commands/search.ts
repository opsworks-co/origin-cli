import chalk from 'chalk';
import { execSync } from 'child_process';
import { searchPrompts, type PromptRecord } from '../local-db.js';
import { getGitRoot } from '../session-state.js';

// ─── Helpers ──────────────────────────────────────────────────────────────

/**
 * Highlight matching portions of text with chalk.
 */
function highlightMatch(text: string, query: string): string {
  const lowerText = text.toLowerCase();
  const lowerQuery = query.toLowerCase();
  const idx = lowerText.indexOf(lowerQuery);
  if (idx < 0) return text;

  const before = text.slice(0, idx);
  const match = text.slice(idx, idx + query.length);
  const after = text.slice(idx + query.length);
  return before + chalk.bgYellow.black(match) + after;
}

/**
 * Extract a snippet around the first match for display.
 */
function extractSnippet(text: string, query: string, contextChars: number = 80): string {
  const lowerText = text.toLowerCase();
  const lowerQuery = query.toLowerCase();
  const idx = lowerText.indexOf(lowerQuery);
  if (idx < 0) return text.slice(0, contextChars * 2);

  const start = Math.max(0, idx - contextChars);
  const end = Math.min(text.length, idx + query.length + contextChars);
  let snippet = text.slice(start, end).replace(/\n/g, ' ');
  if (start > 0) snippet = '...' + snippet;
  if (end < text.length) snippet = snippet + '...';
  return snippet;
}

/**
 * Fallback: scan origin-sessions branch for prompts matching query.
 */
function scanSessionsBranch(repoPath: string, query: string, limit: number): PromptRecord[] {
  const results: PromptRecord[] = [];
  try {
    // List all session directories
    const listing = execSync(
      `git ls-tree --name-only refs/heads/origin-sessions sessions/`,
      {
        encoding: 'utf-8',
        cwd: repoPath,
        stdio: ['pipe', 'pipe', 'pipe'],
      },
    ).trim();

    if (!listing) return results;

    const dirs = listing.split('\n').filter(Boolean);
    const lowerQuery = query.toLowerCase();

    for (const dir of dirs) {
      if (results.length >= limit) break;
      try {
        const promptsMd = execSync(
          `git show refs/heads/origin-sessions:${dir}/prompts.md`,
          {
            encoding: 'utf-8',
            cwd: repoPath,
            stdio: ['pipe', 'pipe', 'pipe'],
          },
        ).trim();

        if (promptsMd.toLowerCase().includes(lowerQuery)) {
          // Parse session ID from directory name
          const sessionId = dir.replace('sessions/', '');

          // Try to get model from metadata
          let model = 'unknown';
          try {
            const metaRaw = execSync(
              `git show refs/heads/origin-sessions:${dir}/metadata.json`,
              {
                encoding: 'utf-8',
                cwd: repoPath,
                stdio: ['pipe', 'pipe', 'pipe'],
              },
            ).trim();
            const meta = JSON.parse(metaRaw);
            model = meta.model || 'unknown';
          } catch { /* ignore */ }

          // Extract individual prompts from the markdown
          const promptSections = promptsMd.split(/^## Prompt \d+/m).slice(1);
          for (const section of promptSections) {
            if (section.toLowerCase().includes(lowerQuery)) {
              const text = section.split('**Files changed:**')[0].trim();
              results.push({
                id: `${sessionId}-branch`,
                sessionId,
                promptIndex: results.length,
                promptText: text,
                timestamp: '',
                model,
                repoPath,
                filesChanged: [],
              });
              if (results.length >= limit) break;
            }
          }
        }
      } catch { /* skip session */ }
    }
  } catch { /* branch doesn't exist or other error */ }
  return results;
}

// ─── Command ──────────────────────────────────────────────────────────────

/**
 * origin search <query> [--model <model>] [--repo <path>] [--limit <n>]
 *
 * Searches the local prompt database for matching prompts.
 * Falls back to scanning the origin-sessions branch if local DB has no results.
 */
export async function searchCommand(
  query: string,
  opts?: { model?: string; repo?: string; limit?: string },
): Promise<void> {
  if (!query || query.trim().length === 0) {
    console.error(chalk.red('Error: Search query is required.'));
    return;
  }

  const limit = opts?.limit ? parseInt(opts.limit, 10) : 20;
  const repoFilter = opts?.repo || undefined;

  // Search local database first
  let results = searchPrompts(query, {
    model: opts?.model,
    repoPath: repoFilter,
    limit,
  });

  let source = 'local database';

  // Fallback: scan origin-sessions branch
  if (results.length === 0) {
    const cwd = process.cwd();
    const repoPath = repoFilter || getGitRoot(cwd);
    if (repoPath) {
      results = scanSessionsBranch(repoPath, query, limit);
      source = 'origin-sessions branch';
    }
  }

  if (results.length === 0) {
    console.log(chalk.gray(`No prompts found matching "${query}".`));
    return;
  }

  console.log(chalk.bold(`\n  Search Results`));
  console.log(chalk.gray(`  Found ${results.length} match${results.length === 1 ? '' : 'es'} in ${source}\n`));

  for (let i = 0; i < results.length; i++) {
    const r = results[i];
    const index = chalk.gray(`${i + 1}.`);
    const session = chalk.blue(r.sessionId.slice(0, 12));
    const model = chalk.cyan(r.model);
    const timestamp = r.timestamp ? chalk.gray(new Date(r.timestamp).toLocaleString()) : '';

    console.log(`  ${index} ${session}  ${model}  ${timestamp}`);

    // Show highlighted snippet
    const snippet = extractSnippet(r.promptText, query);
    console.log(`     ${highlightMatch(snippet, query)}`);

    if (r.filesChanged.length > 0) {
      const fileList = r.filesChanged.slice(0, 3).join(', ');
      const more = r.filesChanged.length > 3 ? ` +${r.filesChanged.length - 3} more` : '';
      console.log(chalk.gray(`     Files: ${fileList}${more}`));
    }
    console.log('');
  }
}
