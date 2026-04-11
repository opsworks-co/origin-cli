import chalk from 'chalk';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { git, gitDetailed } from '../utils/exec.js';
import { searchPrompts, type PromptRecord } from '../local-db.js';
import { getGitRoot, type SessionState } from '../session-state.js';
import { isConnectedMode } from '../config.js';
import { api } from '../api.js';

const HEX = /^[a-fA-F0-9]{4,64}$/;
const SAFE_ID = /^[a-zA-Z0-9_.-]+$/;

// ─── Types ───────────────────────────────────────────────────────────────

interface SearchResult {
  sessionId: string;
  agentName: string;
  timestamp: string;
  filesChanged: string[];
  promptText: string;
}

// ─── Helpers ─────────────────────────────────────────────────────────────

function timeAgo(dateStr: string): string {
  if (!dateStr) return '';
  const seconds = Math.floor((Date.now() - new Date(dateStr).getTime()) / 1000);
  if (seconds < 0) return 'just now';
  if (seconds < 60) return 'just now';
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

function highlightMatch(text: string, query: string): string {
  const lowerText = text.toLowerCase();
  const lowerQuery = query.toLowerCase();
  const idx = lowerText.indexOf(lowerQuery);
  if (idx < 0) return text;

  const before = text.slice(0, idx);
  const match = text.slice(idx, idx + query.length);
  const after = text.slice(idx + query.length);
  return before + chalk.bold(match) + after;
}

function truncatePrompt(text: string, maxLen: number = 200): string {
  const clean = text.replace(/\n/g, ' ').replace(/\s+/g, ' ').trim();
  if (clean.length <= maxLen) return clean;
  return clean.slice(0, maxLen) + '...';
}

function extractSnippet(text: string, query: string, contextChars: number = 80): string {
  const lowerText = text.toLowerCase();
  const lowerQuery = query.toLowerCase();
  const idx = lowerText.indexOf(lowerQuery);
  if (idx < 0) return text.slice(0, contextChars * 2).replace(/\n/g, ' ');

  const start = Math.max(0, idx - contextChars);
  const end = Math.min(text.length, idx + query.length + contextChars);
  let snippet = text.slice(start, end).replace(/\n/g, ' ');
  if (start > 0) snippet = '...' + snippet;
  if (end < text.length) snippet = snippet + '...';
  return snippet;
}

function parseFromDate(from: string): Date | null {
  // Support relative dates like "7d", "2w", "1m" and absolute dates
  const relMatch = from.match(/^(\d+)([dwm])$/);
  if (relMatch) {
    const n = parseInt(relMatch[1], 10);
    const unit = relMatch[2];
    const now = new Date();
    if (unit === 'd') now.setDate(now.getDate() - n);
    else if (unit === 'w') now.setDate(now.getDate() - n * 7);
    else if (unit === 'm') now.setMonth(now.getMonth() - n);
    return now;
  }
  const d = new Date(from);
  return isNaN(d.getTime()) ? null : d;
}

function agentFromModel(model: string): string {
  const lower = model.toLowerCase();
  if (lower.includes('claude') || lower.includes('anthropic')) return 'Claude';
  if (lower.includes('cursor')) return 'Cursor';
  if (lower.includes('gemini') || lower.includes('google')) return 'Gemini';
  if (lower.includes('codex') || lower.includes('openai') || lower.includes('gpt')) return 'Codex';
  if (lower.includes('windsurf')) return 'Windsurf';
  if (lower.includes('aider')) return 'Aider';
  return model;
}

function matchesAgent(model: string, agentName: string | undefined, filterAgent: string): boolean {
  const filter = filterAgent.toLowerCase();
  const lowerModel = model.toLowerCase();
  const lowerAgent = (agentName || '').toLowerCase();
  return lowerModel.includes(filter) || lowerAgent.includes(filter);
}

// ─── Data Sources ────────────────────────────────────────────────────────

/**
 * Search connected mode API sessions.
 */
async function searchConnected(
  query: string,
  opts: { limit: number; from?: Date; agent?: string },
): Promise<SearchResult[]> {
  const results: SearchResult[] = [];
  try {
    const params: Record<string, string> = { limit: String(Math.min(opts.limit * 3, 100)) };
    const data = await api.getSessions(params) as any;
    const sessions = data.sessions || [];
    const lowerQuery = query.toLowerCase();

    for (const s of sessions) {
      if (results.length >= opts.limit) break;

      // Date filter
      if (opts.from) {
        const sessionDate = new Date(s.createdAt || s.startedAt);
        if (sessionDate < opts.from) continue;
      }

      // Agent filter
      if (opts.agent && !matchesAgent(s.model || '', s.agentName, opts.agent)) continue;

      // Check prompts field or prompt data
      const promptTexts: string[] = [];
      if (s.prompts && Array.isArray(s.prompts)) {
        for (const p of s.prompts) {
          const text = typeof p === 'string' ? p : p.text || p.prompt || '';
          if (text) promptTexts.push(text);
        }
      }
      if (s.prompt) promptTexts.push(s.prompt);

      // If no prompts, try fetching session detail
      if (promptTexts.length === 0) {
        try {
          const detail = await api.getSession(s.id) as any;
          if (detail.prompts && Array.isArray(detail.prompts)) {
            for (const p of detail.prompts) {
              const text = typeof p === 'string' ? p : p.text || p.prompt || '';
              if (text) promptTexts.push(text);
            }
          }
          if (detail.prompt) promptTexts.push(detail.prompt);
        } catch { /* skip */ }
      }

      for (const text of promptTexts) {
        if (results.length >= opts.limit) break;
        if (text.toLowerCase().includes(lowerQuery)) {
          const files = (() => {
            try { return JSON.parse(s.filesChanged); } catch { return []; }
          })();
          results.push({
            sessionId: s.id,
            agentName: s.agentName || agentFromModel(s.model || 'unknown'),
            timestamp: s.createdAt || s.startedAt || '',
            filesChanged: Array.isArray(files) ? files : [],
            promptText: text,
          });
        }
      }
    }
  } catch { /* API unavailable */ }
  return results;
}

/**
 * Scan ~/.origin/sessions/ state files for prompt matches.
 */
function searchSessionStateFiles(
  query: string,
  opts: { limit: number; from?: Date; agent?: string },
): SearchResult[] {
  const results: SearchResult[] = [];
  const sessionsDir = path.join(os.homedir(), '.origin', 'sessions');

  try {
    if (!fs.existsSync(sessionsDir)) return results;
    const entries = fs.readdirSync(sessionsDir).filter(e => e.endsWith('.json'));
    const lowerQuery = query.toLowerCase();

    for (const entry of entries) {
      if (results.length >= opts.limit) break;
      try {
        const raw = fs.readFileSync(path.join(sessionsDir, entry), 'utf-8');
        const state: SessionState = JSON.parse(raw);
        if (!state || !state.sessionId || !state.prompts) continue;

        // Date filter
        if (opts.from && state.startedAt) {
          if (new Date(state.startedAt) < opts.from) continue;
        }

        // Agent filter
        if (opts.agent && !matchesAgent(state.model || '', undefined, opts.agent)) continue;

        for (const prompt of state.prompts) {
          if (results.length >= opts.limit) break;
          if (prompt.toLowerCase().includes(lowerQuery)) {
            results.push({
              sessionId: state.sessionId,
              agentName: agentFromModel(state.model || 'unknown'),
              timestamp: state.startedAt || '',
              filesChanged: [],
              promptText: prompt,
            });
          }
        }
      } catch { /* skip corrupt files */ }
    }
  } catch { /* ignore */ }
  return results;
}

/**
 * Check git notes for prompt data.
 */
function searchGitNotes(
  repoPath: string,
  query: string,
  opts: { limit: number; from?: Date; agent?: string },
): SearchResult[] {
  const results: SearchResult[] = [];
  const lowerQuery = query.toLowerCase();

  {
    const r = gitDetailed(['notes', '--ref=origin', 'list'], { cwd: repoPath });
    if (r.status !== 0) return results;
    const notesList = r.stdout.trim();
    if (!notesList) return results;

    for (const line of notesList.split('\n').filter(Boolean)) {
      if (results.length >= opts.limit) break;
      const parts = line.trim().split(/\s+/);
      const noteBlob = parts[0];
      if (!noteBlob) continue;
      const target = parts[1] || noteBlob;
      if (!HEX.test(target)) continue;

      {
        const nr = gitDetailed(['notes', '--ref=origin', 'show', target], { cwd: repoPath });
        if (nr.status !== 0) continue;
        const noteContent = nr.stdout.trim();

        // Try to parse as JSON
        try {
          const data = JSON.parse(noteContent);
          const prompts = data.prompts || (data.prompt ? [data.prompt] : []);
          for (const p of prompts) {
            if (results.length >= opts.limit) break;
            const text = typeof p === 'string' ? p : p.text || p.prompt || '';
            if (text.toLowerCase().includes(lowerQuery)) {
              // Date filter
              if (opts.from && data.startedAt && new Date(data.startedAt) < opts.from) continue;
              // Agent filter
              if (opts.agent && !matchesAgent(data.model || '', data.agentName, opts.agent)) continue;

              results.push({
                sessionId: data.sessionId || target.slice(0, 12) || 'unknown',
                agentName: data.agentName || agentFromModel(data.model || 'unknown'),
                timestamp: data.startedAt || '',
                filesChanged: data.filesChanged || [],
                promptText: text,
              });
            }
          }
        } catch {
          // Plain text note — search it directly
          if (noteContent.toLowerCase().includes(lowerQuery)) {
            results.push({
              sessionId: target.slice(0, 12),
              agentName: 'unknown',
              timestamp: '',
              filesChanged: [],
              promptText: noteContent,
            });
          }
        }
      }
    }
  }
  return results;
}

/**
 * Scan origin-sessions branch for matching prompts.
 */
function searchSessionsBranch(
  repoPath: string,
  query: string,
  opts: { limit: number; from?: Date; agent?: string },
): SearchResult[] {
  const results: SearchResult[] = [];
  {
    const r = gitDetailed(['rev-parse', 'refs/heads/origin-sessions'], { cwd: repoPath });
    if (r.status !== 0) return results;
  }

  try {
    const listing = git(
      ['ls-tree', '--name-only', 'refs/heads/origin-sessions', 'sessions/'],
      { cwd: repoPath },
    ).trim();
    if (!listing) return results;

    const dirs = listing.split('\n').filter(Boolean);
    const lowerQuery = query.toLowerCase();

    for (const dir of dirs) {
      if (results.length >= opts.limit) break;
      const sessionId = dir.replace('sessions/', '');
      if (!SAFE_ID.test(sessionId)) continue;
      try {
        let model = 'unknown';
        let agentName = '';
        let startedAt = '';
        let filesChanged: string[] = [];

        // Read metadata
        try {
          const metaRaw = git(
            ['show', `refs/heads/origin-sessions:${dir}/metadata.json`],
            { cwd: repoPath },
          ).trim();
          const meta = JSON.parse(metaRaw);
          model = meta.model || 'unknown';
          agentName = meta.agentName || '';
          startedAt = meta.startedAt || '';
          filesChanged = meta.filesChanged || [];
        } catch { /* ignore */ }

        // Date filter
        if (opts.from && startedAt && new Date(startedAt) < opts.from) continue;
        // Agent filter
        if (opts.agent && !matchesAgent(model, agentName, opts.agent)) continue;

        const promptsMd = git(
          ['show', `refs/heads/origin-sessions:${dir}/prompts.md`],
          { cwd: repoPath },
        ).trim();

        if (!promptsMd.toLowerCase().includes(lowerQuery)) continue;

        const sections = promptsMd.split(/^## Prompt \d+/m).slice(1);

        for (const section of sections) {
          if (results.length >= opts.limit) break;
          if (section.toLowerCase().includes(lowerQuery)) {
            const text = section.split('**Files changed:**')[0].trim();
            results.push({
              sessionId,
              agentName: agentName || agentFromModel(model),
              timestamp: startedAt,
              filesChanged,
              promptText: text,
            });
          }
        }
      } catch { /* skip session */ }
    }
  } catch { /* branch error */ }
  return results;
}

/**
 * Convert local-db PromptRecords to SearchResults.
 */
function dbToSearchResults(records: PromptRecord[]): SearchResult[] {
  return records.map(r => ({
    sessionId: r.sessionId,
    agentName: agentFromModel(r.model),
    timestamp: r.timestamp,
    filesChanged: r.filesChanged,
    promptText: r.promptText,
  }));
}

// ─── Command ─────────────────────────────────────────────────────────────

export async function searchCommand(
  query: string,
  opts?: { limit?: string; from?: string; agent?: string; model?: string; repo?: string },
): Promise<void> {
  if (!query || query.trim().length === 0) {
    console.error(chalk.red('Error: Search query is required.'));
    return;
  }

  const limit = opts?.limit ? parseInt(opts.limit, 10) : 20;
  const fromDate = opts?.from ? parseFromDate(opts.from) : undefined;
  const agentFilter = opts?.agent;
  const searchOpts = { limit, from: fromDate || undefined, agent: agentFilter };

  const allResults: SearchResult[] = [];
  const seenKeys = new Set<string>();

  function addResults(results: SearchResult[]) {
    for (const r of results) {
      const key = `${r.sessionId}:${r.promptText.slice(0, 100)}`;
      if (seenKeys.has(key)) continue;
      seenKeys.add(key);
      allResults.push(r);
    }
  }

  // 1. Search local database
  const dbResults = searchPrompts(query, {
    model: opts?.model,
    repoPath: opts?.repo,
    limit,
  });
  addResults(dbToSearchResults(dbResults));

  // 2. Connected mode: search API
  if (isConnectedMode()) {
    try {
      const apiResults = await searchConnected(query, searchOpts);
      addResults(apiResults);
    } catch { /* API unavailable */ }
  }

  // 3. Standalone: scan session state files
  const stateResults = searchSessionStateFiles(query, searchOpts);
  addResults(stateResults);

  // 4. Scan git notes and origin-sessions branch
  const repoPath = opts?.repo || getGitRoot(process.cwd());
  if (repoPath) {
    const noteResults = searchGitNotes(repoPath, query, searchOpts);
    addResults(noteResults);
    const branchResults = searchSessionsBranch(repoPath, query, searchOpts);
    addResults(branchResults);
  }

  // Apply date filter to all results
  let filtered = allResults;
  if (fromDate) {
    filtered = filtered.filter(r => {
      if (!r.timestamp) return true;
      return new Date(r.timestamp) >= fromDate;
    });
  }

  // Sort by most recent first
  filtered.sort((a, b) => {
    if (!a.timestamp && !b.timestamp) return 0;
    if (!a.timestamp) return 1;
    if (!b.timestamp) return -1;
    return new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime();
  });

  // Apply limit
  filtered = filtered.slice(0, limit);

  if (filtered.length === 0) {
    console.log(chalk.gray(`No prompts found matching "${query}".`));
    return;
  }

  console.log(chalk.bold(`\n  Search Results`));
  console.log(chalk.gray(`  Found ${filtered.length} match${filtered.length === 1 ? '' : 'es'}\n`));

  for (const r of filtered) {
    const shortId = r.sessionId.slice(0, 8);
    const agent = r.agentName || 'unknown';
    const age = r.timestamp ? timeAgo(r.timestamp) : '';
    const fileList = r.filesChanged.length > 0
      ? r.filesChanged.slice(0, 3).join(', ') + (r.filesChanged.length > 3 ? ` +${r.filesChanged.length - 3} more` : '')
      : '';

    // Header line: Session abc12345 | Claude | 2d ago | src/api.ts, src/auth.ts
    const parts = [
      `Session ${chalk.blue(shortId)}`,
      chalk.cyan(agent),
      age ? chalk.dim(age) : null,
      fileList ? chalk.gray(fileList) : null,
    ].filter(Boolean);
    console.log(`  ${parts.join(' | ')}`);

    // Prompt line (truncated)
    const promptDisplay = truncatePrompt(r.promptText);
    console.log(`    Prompt: ${chalk.gray('"' + promptDisplay + '"')}`);

    // Match line with highlight
    const snippet = extractSnippet(r.promptText, query);
    console.log(`    Match: ${highlightMatch(snippet, query)}`);

    console.log('');
  }
}
