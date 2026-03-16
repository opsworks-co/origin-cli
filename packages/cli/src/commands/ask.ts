import chalk from 'chalk';
import { execSync } from 'child_process';
import { getGitRoot } from '../session-state.js';
import { searchPrompts, getPromptsBySession } from '../local-db.js';
import { isConnectedMode } from '../config.js';
import { api } from '../api.js';

/**
 * origin ask <query> [--file <path>] [--line <n>] [--session <id>]
 *
 * Query the context behind AI-generated code.
 * Finds the session and prompts that generated a file/line and shows them.
 *
 * How it works:
 * 1. If --file is given, looks up the session via git notes on recent commits touching that file
 * 2. If --session is given, searches that session's prompts
 * 3. Otherwise, searches all prompts matching the query
 *
 * Works in standalone mode (local git data) and connected mode (API).
 */
export async function askCommand(
  query: string,
  opts?: { file?: string; line?: string; session?: string; limit?: string }
) {
  const cwd = process.cwd();
  const repoPath = getGitRoot(cwd);
  const limit = parseInt(opts?.limit || '5', 10);

  console.log(chalk.bold('\n  Origin Ask\n'));

  // Strategy 1: File-based lookup
  if (opts?.file && repoPath) {
    const results = await askAboutFile(opts.file, query, repoPath, opts.line);
    if (results) return;
  }

  // Strategy 2: Session-specific search
  if (opts?.session) {
    const prompts = getPromptsBySession(opts.session);
    if (prompts.length === 0) {
      // Try connected mode
      if (isConnectedMode()) {
        try {
          const session = await api.getSession(opts.session);
          if (session.promptChanges) {
            console.log(chalk.gray(`  Session ${chalk.white(opts.session)} — ${chalk.cyan(session.model)}\n`));
            const lowerQuery = query.toLowerCase();
            const matching = session.promptChanges.filter((pc: any) =>
              pc.promptText.toLowerCase().includes(lowerQuery) ||
              (pc.filesChanged || []).some((f: string) => f.toLowerCase().includes(lowerQuery))
            );
            if (matching.length > 0) {
              for (const pc of matching.slice(0, limit)) {
                printPromptResult(pc.promptIndex, pc.promptText, pc.filesChanged || [], session.model);
              }
            } else {
              console.log(chalk.yellow('  No prompts matching your query in this session.'));
              console.log(chalk.gray(`  Showing all ${session.promptChanges.length} prompts:\n`));
              for (const pc of session.promptChanges.slice(0, limit)) {
                printPromptResult(pc.promptIndex, pc.promptText, pc.filesChanged || [], session.model);
              }
            }
            console.log('');
            return;
          }
        } catch { /* fall through */ }
      }
      console.log(chalk.yellow(`  No prompts found for session ${opts.session}`));
      console.log(chalk.gray('  Run: origin db import    (to import from origin-sessions branch)'));
      console.log('');
      return;
    }

    console.log(chalk.gray(`  Session ${chalk.white(opts.session)} — ${chalk.cyan(prompts[0].model)}\n`));
    const lowerQuery = query.toLowerCase();
    const matching = prompts.filter(p =>
      p.promptText.toLowerCase().includes(lowerQuery) ||
      p.filesChanged.some(f => f.toLowerCase().includes(lowerQuery))
    );

    const results = matching.length > 0 ? matching : prompts;
    if (matching.length === 0) {
      console.log(chalk.yellow(`  No prompts matching "${query}" — showing all prompts:\n`));
    }
    for (const p of results.slice(0, limit)) {
      printPromptResult(p.promptIndex, p.promptText, p.filesChanged, p.model);
    }
    console.log('');
    return;
  }

  // Strategy 3: Global search across all prompts
  const results = searchPrompts(query, { limit });
  if (results.length > 0) {
    console.log(chalk.gray(`  Found ${results.length} matching prompts:\n`));
    for (const r of results) {
      console.log(chalk.gray(`  ${chalk.blue(r.sessionId.slice(0, 12))} ${chalk.gray('—')} ${chalk.cyan(r.model)}`));
      printPromptResult(r.promptIndex, r.promptText, r.filesChanged, r.model);
    }
    console.log('');
    return;
  }

  // Strategy 4: Try searching origin-sessions branch directly
  if (repoPath) {
    const branchResults = searchOriginSessionsBranch(query, repoPath, limit);
    if (branchResults.length > 0) {
      console.log(chalk.gray(`  Found ${branchResults.length} matches in origin-sessions branch:\n`));
      for (const r of branchResults) {
        console.log(chalk.gray(`  ${chalk.blue(r.sessionId)} — match in ${r.source}`));
        if (r.snippet) {
          console.log(chalk.white(`    ${r.snippet.slice(0, 200)}`));
        }
        console.log('');
      }
      return;
    }
  }

  console.log(chalk.yellow(`  No results for "${query}"`));
  console.log(chalk.gray('\n  Tips:'));
  console.log(chalk.gray('    origin ask "auth" --file src/auth.ts     # Ask about a specific file'));
  console.log(chalk.gray('    origin ask "refactor" --session abc123   # Ask within a session'));
  console.log(chalk.gray('    origin db import                         # Import prompts for search'));
  console.log('');
}

// ── File-based lookup: find which session wrote a file ───────────────────────

async function askAboutFile(file: string, query: string, repoPath: string, line?: string): Promise<boolean> {
  const execOpts = { encoding: 'utf-8' as const, cwd: repoPath, stdio: ['pipe', 'pipe', 'pipe'] as ['pipe', 'pipe', 'pipe'] };

  // Find recent commits that touched this file
  let commits: string[];
  try {
    const log = execSync(`git log --format=%H -20 -- "${file}"`, execOpts).trim();
    commits = log ? log.split('\n') : [];
  } catch {
    console.log(chalk.yellow(`  Could not find git history for ${file}`));
    return false;
  }

  if (commits.length === 0) {
    console.log(chalk.yellow(`  No commits found for ${file}`));
    return false;
  }

  // Check git notes on those commits to find Origin sessions
  const sessionIds: string[] = [];
  const commitToSession: Record<string, string> = {};

  for (const sha of commits) {
    try {
      const noteContent = execSync(
        `git notes --ref=origin show ${sha} 2>/dev/null`,
        { ...execOpts, stdio: ['pipe', 'pipe', 'pipe'] }
      ).trim();
      const noteData = JSON.parse(noteContent);
      const sid = noteData?.origin?.sessionId || noteData?.sessionId;
      if (sid && !sessionIds.includes(sid)) {
        sessionIds.push(sid);
        commitToSession[sid] = sha;
      }
    } catch { /* no note on this commit */ }
  }

  if (sessionIds.length === 0) {
    // Fallback: search prompts DB for file references
    const prompts = searchPrompts(file, { limit: 10 });
    if (prompts.length > 0) {
      console.log(chalk.gray(`  File: ${chalk.white(file)}\n`));
      console.log(chalk.gray(`  Found ${prompts.length} prompts referencing this file:\n`));
      for (const p of prompts.slice(0, 5)) {
        console.log(chalk.gray(`  ${chalk.blue(p.sessionId.slice(0, 12))} ${chalk.gray('—')} ${chalk.cyan(p.model)}`));
        printPromptResult(p.promptIndex, p.promptText, p.filesChanged, p.model);
      }
      console.log('');
      return true;
    }
    return false;
  }

  console.log(chalk.gray(`  File: ${chalk.white(file)}`));
  if (line) console.log(chalk.gray(`  Line: ${chalk.white(line)}`));
  console.log(chalk.gray(`  Sessions that modified this file: ${chalk.white(String(sessionIds.length))}\n`));

  // Show prompts from those sessions
  for (const sid of sessionIds.slice(0, 3)) {
    const prompts = getPromptsBySession(sid);
    const sha = commitToSession[sid]?.slice(0, 8) || '';

    // Filter prompts relevant to this file
    const relevant = prompts.filter(p =>
      p.filesChanged.some(f => f.includes(file) || file.includes(f))
    );
    const toShow = relevant.length > 0 ? relevant : prompts;

    console.log(chalk.gray(`  ${chalk.blue(sid.slice(0, 12))} ${sha ? chalk.gray(`(${sha})`) : ''} — ${toShow.length > 0 ? chalk.cyan(toShow[0].model) : ''}`));

    for (const p of toShow.slice(0, 3)) {
      printPromptResult(p.promptIndex, p.promptText, p.filesChanged, p.model);
    }

    if (relevant.length === 0 && prompts.length === 0) {
      // Try loading from git branch
      try {
        const md = execSync(
          `git show origin-sessions:sessions/${sid}/prompts.md 2>/dev/null`,
          execOpts
        ).trim();
        if (md) {
          const preview = md.slice(0, 300).replace(/\n/g, ' ');
          console.log(chalk.white(`    ${preview}${md.length > 300 ? '...' : ''}`));
        }
      } catch { /* no prompts.md */ }
    }
    console.log('');
  }

  return true;
}

// ── Search origin-sessions branch directly ──────────────────────────────────

interface BranchSearchResult {
  sessionId: string;
  source: string;
  snippet?: string;
}

function searchOriginSessionsBranch(query: string, repoPath: string, limit: number): BranchSearchResult[] {
  const execOpts = { encoding: 'utf-8' as const, cwd: repoPath, stdio: ['pipe', 'pipe', 'pipe'] as ['pipe', 'pipe', 'pipe'] };
  const results: BranchSearchResult[] = [];

  try {
    execSync('git rev-parse refs/heads/origin-sessions', execOpts);
  } catch {
    return results;
  }

  try {
    // List all session directories
    const tree = execSync('git ls-tree --name-only origin-sessions:sessions/', execOpts).trim();
    if (!tree) return results;

    const sessionDirs = tree.split('\n');
    const lowerQuery = query.toLowerCase();

    for (const sid of sessionDirs) {
      if (results.length >= limit) break;

      try {
        // Search prompts.md
        const md = execSync(
          `git show origin-sessions:sessions/${sid}/prompts.md 2>/dev/null`,
          execOpts
        ).trim();
        if (md.toLowerCase().includes(lowerQuery)) {
          const idx = md.toLowerCase().indexOf(lowerQuery);
          const start = Math.max(0, idx - 50);
          const end = Math.min(md.length, idx + query.length + 100);
          results.push({
            sessionId: sid,
            source: 'prompts.md',
            snippet: md.slice(start, end).replace(/\n/g, ' '),
          });
        }
      } catch { /* skip */ }
    }
  } catch { /* ignore */ }

  return results;
}

// ── Helpers ─────────────────────────────────────────────────────────────────

function printPromptResult(index: number, text: string, files: string[], model: string) {
  const preview = text.slice(0, 150).replace(/\n/g, ' ');
  console.log(chalk.gray(`    Prompt #${index + 1}: ${chalk.white(preview)}${text.length > 150 ? '...' : ''}`));
  if (files.length > 0) {
    for (const f of files.slice(0, 5)) {
      console.log(chalk.gray(`      → ${chalk.green(f)}`));
    }
    if (files.length > 5) {
      console.log(chalk.gray(`      ... and ${files.length - 5} more files`));
    }
  }
}
