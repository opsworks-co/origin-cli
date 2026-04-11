import chalk from 'chalk';
import { existsSync, readdirSync, readFileSync, statSync } from 'fs';
import { join, resolve } from 'path';
import { isAiCommit } from '../attribution.js';
import { getGitRoot } from '../session-state.js';
import * as readline from 'readline';
import { git, gitDetailed } from '../utils/exec.js';

const HEX = /^[a-fA-F0-9]{4,64}$/;
const SAFE_ID = /^[a-zA-Z0-9_.-]+$/;

// ─── Types ────────────────────────────────────────────────────────────────

type Confidence = 'high' | 'medium' | 'low';

interface BackfillResult {
  sha: string;
  date: string;
  subject: string;
  agent: string;
  confidence: Confidence;
  source: string;
  authorName: string;
  authorEmail: string;
}

interface CommitInfo {
  sha: string;
  date: string;
  timestamp: number;
  subject: string;
  authorName: string;
  authorEmail: string;
  committerName: string;
  committerEmail: string;
}

// ─── Git Helpers ──────────────────────────────────────────────────────────

const gitOpts = (cwd: string) => ({
  cwd,
  maxBuffer: 10 * 1024 * 1024,
});

function getCommitsInRange(repoPath: string, days: number): CommitInfo[] {
  if (!Number.isFinite(days) || days < 0) return [];
  try {
    const output = git(
      ['log', `--since=${days} days ago`, '--format=%H|%aI|%at|%s|%an|%ae|%cn|%ce'],
      gitOpts(repoPath),
    ).trim();
    if (!output) return [];
    return output.split('\n').filter(Boolean).map(line => {
      const parts = line.split('|');
      if (parts.length < 8) return null;
      return {
        sha: parts[0],
        date: parts[1],
        timestamp: parseInt(parts[2], 10),
        subject: parts.slice(3, -4).join('|'), // subject may contain |
        authorName: parts[parts.length - 4],
        authorEmail: parts[parts.length - 3],
        committerName: parts[parts.length - 2],
        committerEmail: parts[parts.length - 1],
      };
    }).filter(Boolean) as CommitInfo[];
  } catch {
    return [];
  }
}

function getCommitMessage(repoPath: string, sha: string): string {
  if (!HEX.test(sha)) return '';
  try {
    return git(
      ['log', '-1', '--format=%B', sha],
      gitOpts(repoPath),
    ).trim();
  } catch {
    return '';
  }
}

function getCommitDiff(repoPath: string, sha: string): string {
  if (!HEX.test(sha)) return '';
  try {
    return git(
      ['diff-tree', '-p', sha, '--'],
      { ...gitOpts(repoPath), maxBuffer: 2 * 1024 * 1024 },
    ).trim();
  } catch {
    return '';
  }
}

// ─── Strategy 1: Local Agent History Matching ─────────────────────────────

interface SessionTimestamp {
  timestamp: number;
  agent: string;
  file: string;
}

function scanClaudeSessions(repoPath: string): SessionTimestamp[] {
  const timestamps: SessionTimestamp[] = [];
  const claudeDir = join(repoPath, '.claude', 'projects');
  if (!existsSync(claudeDir)) return timestamps;

  try {
    const walkDir = (dir: string) => {
      const entries = readdirSync(dir, { withFileTypes: true });
      for (const entry of entries) {
        const fullPath = join(dir, entry.name);
        if (entry.isDirectory()) {
          walkDir(fullPath);
        } else if (entry.name.endsWith('.jsonl') || entry.name.endsWith('.json')) {
          try {
            const content = readFileSync(fullPath, 'utf-8');
            const lines = content.split('\n').filter(Boolean);
            for (const line of lines) {
              try {
                const obj = JSON.parse(line);
                const ts = obj.timestamp || obj.createdAt || obj.ts;
                if (ts) {
                  const msTs = typeof ts === 'number' && ts < 1e12 ? ts * 1000 : ts;
                  timestamps.push({
                    timestamp: typeof msTs === 'string' ? new Date(msTs).getTime() : msTs,
                    agent: 'claude',
                    file: fullPath,
                  });
                }
              } catch { /* skip malformed lines */ }
            }
          } catch { /* skip unreadable files */ }
        }
      }
    };
    walkDir(claudeDir);
  } catch { /* directory read error */ }

  return timestamps;
}

function scanCursorSessions(repoPath: string): SessionTimestamp[] {
  const timestamps: SessionTimestamp[] = [];
  const cursorDir = join(repoPath, '.cursor');
  if (!existsSync(cursorDir)) return timestamps;

  try {
    const entries = readdirSync(cursorDir, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = join(cursorDir, entry.name);
      try {
        const stat = statSync(fullPath);
        timestamps.push({
          timestamp: stat.mtimeMs,
          agent: 'cursor',
          file: fullPath,
        });
      } catch { /* skip */ }
    }
  } catch { /* directory read error */ }

  return timestamps;
}

function scanCodexSessions(repoPath: string): SessionTimestamp[] {
  const timestamps: SessionTimestamp[] = [];
  const codexDir = join(repoPath, '.codex');
  if (!existsSync(codexDir)) return timestamps;

  try {
    const walkDir = (dir: string) => {
      const entries = readdirSync(dir, { withFileTypes: true });
      for (const entry of entries) {
        const fullPath = join(dir, entry.name);
        if (entry.isDirectory()) {
          walkDir(fullPath);
        } else {
          try {
            const stat = statSync(fullPath);
            timestamps.push({
              timestamp: stat.mtimeMs,
              agent: 'codex',
              file: fullPath,
            });
            // Also try to parse JSON content for timestamps
            if (entry.name.endsWith('.json') || entry.name.endsWith('.jsonl')) {
              const content = readFileSync(fullPath, 'utf-8');
              const lines = content.split('\n').filter(Boolean);
              for (const line of lines) {
                try {
                  const obj = JSON.parse(line);
                  const ts = obj.timestamp || obj.createdAt || obj.ts;
                  if (ts) {
                    const msTs = typeof ts === 'number' && ts < 1e12 ? ts * 1000 : ts;
                    timestamps.push({
                      timestamp: typeof msTs === 'string' ? new Date(msTs).getTime() : msTs,
                      agent: 'codex',
                      file: fullPath,
                    });
                  }
                } catch { /* skip */ }
              }
            }
          } catch { /* skip */ }
        }
      }
    };
    walkDir(codexDir);
  } catch { /* directory read error */ }

  return timestamps;
}

function matchSessionToCommit(
  commit: CommitInfo,
  sessions: SessionTimestamp[],
  windowMs: number = 5 * 60 * 1000,
): SessionTimestamp | null {
  const commitMs = commit.timestamp * 1000;
  let bestMatch: SessionTimestamp | null = null;
  let bestDelta = Infinity;

  for (const session of sessions) {
    const delta = Math.abs(session.timestamp - commitMs);
    if (delta <= windowMs && delta < bestDelta) {
      bestDelta = delta;
      bestMatch = session;
    }
  }

  return bestMatch;
}

// ─── Strategy 0: Origin Session State Files ────────────────────────────────
// Origin already tracked sessions — check ~/.origin/sessions/ for state files
// that contain commit SHAs, agent slugs, and timestamps

interface OriginSessionInfo {
  sessionId: string;
  agent: string;
  model: string;
  startedAt: number;
  endedAt: number;
  repoPath: string;
  commits: string[]; // SHAs captured during the session
}

function scanOriginSessions(repoPath: string): OriginSessionInfo[] {
  const results: OriginSessionInfo[] = [];
  const homedir = process.env.HOME || process.env.USERPROFILE || '';
  const sessionsDir = join(homedir, '.origin', 'sessions');
  if (!existsSync(sessionsDir)) return results;

  try {
    const walkDir = (dir: string) => {
      const entries = readdirSync(dir, { withFileTypes: true });
      for (const entry of entries) {
        const fullPath = join(dir, entry.name);
        if (entry.isDirectory()) {
          walkDir(fullPath);
        } else if (entry.name.endsWith('.json')) {
          try {
            const content = readFileSync(fullPath, 'utf-8');
            const state = JSON.parse(content);
            if (!state || typeof state !== 'object') continue;

            // Check if this session is for the current repo
            const sessionRepo = state.repoPath || '';
            if (sessionRepo && resolve(sessionRepo) !== resolve(repoPath)) continue;

            const m = (state.model || '').toLowerCase();
            const agent = m.includes('codex') ? 'codex'
              : m.includes('gemini') ? 'gemini'
              : m.includes('cursor') ? 'cursor'
              : m.includes('claude') ? 'claude'
              : /^gpt-/.test(m) ? 'codex'  // gpt-5.4 etc = Codex CLI
              : m === 'default' || m === 'unknown' ? 'ai'
              : m || 'ai';

            const startMs = state.startedAt ? new Date(state.startedAt).getTime() : 0;
            // Session end = last prompt time or startedAt + typical session length
            const stateFile = statSync(fullPath);
            const endMs = stateFile.mtimeMs;

            // Collect any commit SHAs stored in the state
            const commits: string[] = [];
            if (state.headShaAtStart) commits.push(state.headShaAtStart);
            if (state.gitCapture?.commitDetails) {
              for (const c of state.gitCapture.commitDetails) {
                if (c.sha) commits.push(c.sha);
              }
            }

            results.push({
              sessionId: state.sessionId || '',
              agent,
              model: state.model || 'unknown',
              startedAt: startMs,
              endedAt: endMs,
              repoPath: sessionRepo,
              commits,
            });
          } catch { /* skip malformed */ }
        }
      }
    };
    walkDir(sessionsDir);
  } catch { /* directory read error */ }

  return results;
}

function scanOriginSessionsBranch(repoPath: string): OriginSessionInfo[] {
  const results: OriginSessionInfo[] = [];
  try {
    // List all sessions in origin-sessions branch
    const raw = git(
      ['ls-tree', '--name-only', 'origin-sessions', 'sessions/'],
      gitOpts(repoPath),
    ).trim();
    if (!raw) return results;

    const dirs = raw.split('\n').filter(Boolean).map(d => d.replace('sessions/', ''));
    for (const dir of dirs) {
      if (!SAFE_ID.test(dir)) continue;
      try {
        const metaJson = git(
          ['show', `origin-sessions:sessions/${dir}/metadata.json`],
          gitOpts(repoPath),
        ).trim();
        const meta = JSON.parse(metaJson);
        if (!meta) continue;

        const m = (meta.model || '').toLowerCase();
        const agent = m.includes('codex') ? 'codex'
          : m.includes('gemini') ? 'gemini'
          : m.includes('cursor') ? 'cursor'
          : m.includes('claude') ? 'claude'
          : /^gpt-/.test(m) ? 'codex'
          : m || 'ai';

        const startMs = meta.startedAt ? new Date(meta.startedAt).getTime() : 0;
        const endMs = meta.endedAt ? new Date(meta.endedAt).getTime()
          : meta.updatedAt ? new Date(meta.updatedAt).getTime()
          : startMs + 3600000; // default 1hr window

        const commits: string[] = [];
        if (meta.commitSha) commits.push(meta.commitSha);
        if (meta.headShaAtStart) commits.push(meta.headShaAtStart);
        // Try to read commits list
        try {
          const commitsJson = git(
            ['show', `origin-sessions:sessions/${dir}/commits.json`],
            gitOpts(repoPath),
          ).trim();
          const commitsList = JSON.parse(commitsJson);
          if (Array.isArray(commitsList)) {
            for (const c of commitsList) {
              const sha = typeof c === 'string' ? c : c?.sha;
              if (sha) commits.push(sha);
            }
          }
        } catch { /* no commits file */ }

        results.push({
          sessionId: meta.sessionId || dir,
          agent,
          model: meta.model || 'unknown',
          startedAt: startMs,
          endedAt: endMs,
          repoPath,
          commits,
        });
      } catch { /* skip bad session */ }
    }
  } catch { /* no origin-sessions branch */ }
  return results;
}

function matchOriginSession(
  commit: CommitInfo,
  sessions: OriginSessionInfo[],
): OriginSessionInfo | null {
  const commitMs = commit.timestamp * 1000;

  for (const session of sessions) {
    // Direct SHA match — highest confidence
    if (session.commits.includes(commit.sha)) {
      return session;
    }
    // Timestamp match — commit happened during a known session
    if (session.startedAt > 0 && session.endedAt > 0) {
      // Allow 2 min buffer before start, 5 min after end
      if (commitMs >= session.startedAt - 120000 && commitMs <= session.endedAt + 300000) {
        return session;
      }
    }
  }
  return null;
}

// ─── Strategy 2: Commit Message Pattern Detection ─────────────────────────

const CONVENTIONAL_PREFIXES = [
  'feat:', 'fix:', 'refactor:', 'chore:', 'docs:', 'test:',
  'style:', 'perf:', 'ci:', 'build:',
];

const AI_PHRASES = [
  'as requested', 'based on', 'implement ', 'add support for',
  'update to', 'per the', 'as discussed', 'as per',
  'according to', 'implement the', 'add the', 'update the',
  'handle the', 'ensure that', 'make sure',
];

const AI_AUTHOR_NAMES = [
  'cursor', 'codex', 'claude', 'copilot', 'github-actions',
  'devin', 'aider', 'composer', 'windsurf', 'gemini',
];

const AI_EMAIL_PATTERNS = [
  'noreply', 'bot@', 'cursor@', 'users.noreply.github.com',
  'codex@', 'claude@', 'copilot@', 'devin@', 'aider@',
];

function detectFromCommitMessage(
  commit: CommitInfo,
  message: string,
): { agent: string; confidence: Confidence; source: string } | null {
  const lowerMsg = message.toLowerCase();
  const lowerSubject = commit.subject.toLowerCase();
  const lowerAuthorName = commit.authorName.toLowerCase();
  const lowerCommitterName = commit.committerName.toLowerCase();
  const lowerAuthorEmail = commit.authorEmail.toLowerCase();
  const lowerCommitterEmail = commit.committerEmail.toLowerCase();

  // Check author/committer names for known AI agents
  for (const name of AI_AUTHOR_NAMES) {
    if (lowerAuthorName.includes(name) || lowerCommitterName.includes(name)) {
      const agent = name === 'github-actions' ? 'ai' : name;
      return { agent, confidence: 'high', source: 'backfill-author-match' };
    }
  }

  // Check email patterns
  for (const pattern of AI_EMAIL_PATTERNS) {
    if (lowerAuthorEmail.includes(pattern) || lowerCommitterEmail.includes(pattern)) {
      // noreply alone is medium confidence; specific agent emails are high
      const isSpecific = pattern !== 'noreply' && pattern !== 'users.noreply.github.com';
      const agent = detectAgentFromEmail(lowerAuthorEmail + ' ' + lowerCommitterEmail);
      return {
        agent,
        confidence: isSpecific ? 'high' : 'medium',
        source: 'backfill-email-match',
      };
    }
  }

  // Co-Authored-By patterns
  if (lowerMsg.includes('co-authored-by:')) {
    const coAuthorMatch = message.match(/[Cc]o-[Aa]uthored-[Bb]y:\s*(.+)/);
    const coAuthor = coAuthorMatch?.[1]?.toLowerCase() || '';
    if (coAuthor.includes('claude') || coAuthor.includes('anthropic')) {
      return { agent: 'claude', confidence: 'high', source: 'backfill-coauthor' };
    }
    if (coAuthor.includes('codex') || coAuthor.includes('openai')) {
      return { agent: 'codex', confidence: 'high', source: 'backfill-coauthor' };
    }
    if (coAuthor.includes('copilot') || coAuthor.includes('github')) {
      return { agent: 'copilot', confidence: 'high', source: 'backfill-coauthor' };
    }
    if (coAuthor.includes('gemini') || coAuthor.includes('google')) {
      return { agent: 'gemini', confidence: 'high', source: 'backfill-coauthor' };
    }
    if (coAuthor.includes('cursor')) {
      return { agent: 'cursor', confidence: 'high', source: 'backfill-coauthor' };
    }
    if (coAuthor.includes('noreply') || coAuthor.includes('bot') || coAuthor.includes('ai')) {
      return { agent: 'ai', confidence: 'medium', source: 'backfill-coauthor' };
    }
  }

  // Codex default commit message
  if (message.trim() === '-') {
    return { agent: 'codex', confidence: 'high', source: 'backfill-pattern' };
  }

  // Explicit agent mentions
  if (lowerMsg.includes('generated by gemini') || lowerMsg.includes('gemini:')) {
    return { agent: 'gemini', confidence: 'high', source: 'backfill-pattern' };
  }
  if (lowerMsg.includes('generated by cursor') || lowerMsg.includes('cursor:')) {
    return { agent: 'cursor', confidence: 'high', source: 'backfill-pattern' };
  }

  // Origin-Session trailer (already tagged but maybe not in notes)
  if (lowerMsg.includes('origin-session:')) {
    return { agent: 'ai', confidence: 'high', source: 'backfill-trailer' };
  }

  // ── Agent-specific commit message style detection ──

  // Claude: very structured, verbose, em-dashes, detailed explanations
  const hasConventionalPrefix = CONVENTIONAL_PREFIXES.some(p => lowerSubject.startsWith(p));
  const hasEmDash = message.includes('—') || message.includes('--');
  const isVerboseSubject = commit.subject.length > 60;
  const hasDetailedBody = message.split('\n').filter(l => l.trim()).length > 3;
  const claudeSignals = [hasConventionalPrefix, hasEmDash, isVerboseSubject, hasDetailedBody]
    .filter(Boolean).length;
  if (claudeSignals >= 3) {
    return { agent: 'claude', confidence: 'medium', source: 'backfill-style-claude' };
  }

  // Codex: short messages, often lowercase, generic "Update/Add file" patterns,
  // maintenance-style commits, "small" in subject, marker/note patterns
  const isShort = commit.subject.length < 45;
  const isGenericUpdate = /^(update|add|fix|remove|delete|change|modify|edit|expand|refine|mention)\s+/i.test(commit.subject);
  const startsLowercase = /^[a-z]/.test(commit.subject);
  const hasMarkerOrNote = /\b(marker|note|maintenance|guidance|follow-?up)\b/i.test(commit.subject);
  const hasSmallWord = /\bsmall\b/i.test(commit.subject);
  const codexSignals = [isShort, isGenericUpdate, startsLowercase, hasMarkerOrNote, hasSmallWord].filter(Boolean).length;
  if (codexSignals >= 2) {
    return { agent: 'codex', confidence: 'medium', source: 'backfill-style-codex' };
  }

  // Gemini: often adds emoji, uses "✨", "🔧" etc in commit messages
  if (/[\u{1F300}-\u{1F9FF}]/u.test(message)) {
    return { agent: 'gemini', confidence: 'medium', source: 'backfill-style-gemini' };
  }

  // Generic AI: conventional prefix + AI phrases
  const hasAiPhrase = AI_PHRASES.some(p => lowerMsg.includes(p));
  if (hasConventionalPrefix && hasAiPhrase) {
    return { agent: 'ai', confidence: 'medium', source: 'backfill-pattern' };
  }

  return null;
}

function detectAgentFromEmail(emails: string): string {
  const lower = emails.toLowerCase();
  if (lower.includes('cursor')) return 'cursor';
  if (lower.includes('codex')) return 'codex';
  if (lower.includes('claude') || lower.includes('anthropic')) return 'claude';
  if (lower.includes('copilot')) return 'copilot';
  if (lower.includes('devin')) return 'devin';
  if (lower.includes('aider')) return 'aider';
  return 'ai';
}

// ─── Strategy 3: Code Style Heuristics ────────────────────────────────────

function detectFromCodeStyle(
  diff: string,
): { agent: string; confidence: Confidence; source: string } | null {
  if (!diff) return null;

  const addedLines: string[] = [];
  for (const line of diff.split('\n')) {
    if (line.startsWith('+') && !line.startsWith('+++')) {
      addedLines.push(line.slice(1));
    }
  }

  if (addedLines.length < 5) return null;

  let commentLines = 0;
  let docstringCount = 0;
  let todoImplement = 0;
  let thoroughErrorHandling = 0;

  for (const line of addedLines) {
    const trimmed = line.trim();
    // Count comments
    if (trimmed.startsWith('//') || trimmed.startsWith('#') || trimmed.startsWith('*') || trimmed.startsWith('/*')) {
      commentLines++;
    }
    // Docstrings
    if (trimmed.startsWith('/**') || trimmed.startsWith('"""') || trimmed.startsWith("'''")) {
      docstringCount++;
    }
    // TODO/FIXME referencing implement/add
    if (/\b(TODO|FIXME)\b/i.test(trimmed) && /\b(implement|add)\b/i.test(trimmed)) {
      todoImplement++;
    }
    // Thorough error handling
    if (/\b(try|catch|finally|except|rescue|throw|raise)\b/.test(trimmed)) {
      thoroughErrorHandling++;
    }
  }

  const commentRatio = commentLines / addedLines.length;

  // Excessive comments (>30%) is a signal
  let signals = 0;
  if (commentRatio > 0.3) signals++;
  if (docstringCount >= 3) signals++;
  if (todoImplement >= 2) signals++;
  if (thoroughErrorHandling >= 3 && thoroughErrorHandling / addedLines.length > 0.1) signals++;

  if (signals >= 2) {
    return { agent: 'ai', confidence: 'low', source: 'backfill-heuristic' };
  }

  return null;
}

// ─── Strategy 4: File Change Patterns ──────────────────────────────────────

function detectFromFileChanges(
  repoPath: string,
  sha: string,
): { agent: string; confidence: Confidence; source: string } | null {
  if (!HEX.test(sha)) return null;
  try {
    const files = git(
      ['diff-tree', '--no-commit-id', '--name-only', '-r', sha],
      gitOpts(repoPath),
    ).trim().split('\n').filter(Boolean);

    if (files.length === 0) return null;

    // If commit only touches .cursor/ files → Cursor
    if (files.every(f => f.startsWith('.cursor/'))) {
      return { agent: 'cursor', confidence: 'high', source: 'backfill-file-pattern' };
    }
    // If commit only touches .claude/ files → Claude
    if (files.every(f => f.startsWith('.claude/'))) {
      return { agent: 'claude', confidence: 'high', source: 'backfill-file-pattern' };
    }
    // If commit touches .cursor/ alongside other files → likely Cursor session
    if (files.some(f => f.startsWith('.cursor/'))) {
      return { agent: 'cursor', confidence: 'medium', source: 'backfill-file-pattern' };
    }
    // If commit touches .claude/ alongside other files → likely Claude session
    if (files.some(f => f.startsWith('.claude/'))) {
      return { agent: 'claude', confidence: 'medium', source: 'backfill-file-pattern' };
    }
    // If commit touches .codex/ files → Codex
    if (files.some(f => f.startsWith('.codex/'))) {
      return { agent: 'codex', confidence: 'medium', source: 'backfill-file-pattern' };
    }
  } catch { /* git command failed */ }

  return null;
}

// ─── Apply Tags ───────────────────────────────────────────────────────────

function applyBackfillNote(repoPath: string, result: BackfillResult): boolean {
  if (!HEX.test(result.sha)) return false;
  try {
    const noteData = JSON.stringify({
      sessionId: `backfill-${result.sha.slice(0, 8)}`,
      agent: result.agent,
      agentName: result.agent,
      model: 'unknown',
      confidence: result.confidence,
      source: result.source,
    });
    git(
      ['notes', '--ref=origin', 'add', '-f', '-m', noteData, result.sha],
      gitOpts(repoPath),
    );
    return true;
  } catch {
    return false;
  }
}

// ─── Prompt Helper ────────────────────────────────────────────────────────

function promptUser(question: string): Promise<string> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise(resolve => {
    rl.question(question, answer => {
      rl.close();
      resolve(answer.trim().toLowerCase());
    });
  });
}

// ─── Confidence Filter ────────────────────────────────────────────────────

const CONFIDENCE_ORDER: Record<Confidence, number> = { high: 3, medium: 2, low: 1 };

function meetsMinConfidence(confidence: Confidence, minConfidence: Confidence): boolean {
  return CONFIDENCE_ORDER[confidence] >= CONFIDENCE_ORDER[minConfidence];
}

// ─── Command ──────────────────────────────────────────────────────────────

export async function backfillCommand(opts: {
  days?: string;
  dryRun?: boolean;
  apply?: boolean;
  minConfidence?: string;
}) {
  const repoPath = getGitRoot(process.cwd());
  if (!repoPath) {
    console.error(chalk.red('Not a git repository.'));
    process.exit(1);
  }

  const days = parseInt(opts.days || '90', 10);
  const apply = opts.apply === true;
  const minConfidence = (opts.minConfidence || 'medium') as Confidence;

  if (!['high', 'medium', 'low'].includes(minConfidence)) {
    console.error(chalk.red(`Invalid confidence level: ${minConfidence}. Use high, medium, or low.`));
    process.exit(1);
  }

  // Get commits
  const commits = getCommitsInRange(repoPath, days);
  if (commits.length === 0) {
    console.log(chalk.gray(`No commits found in the last ${days} days.`));
    return;
  }

  console.log(`Scanning ${chalk.bold(String(commits.length))} commits...\n`);

  // Scan Origin session state files + origin-sessions branch (Strategy 0)
  const originSessions = [
    ...scanOriginSessions(repoPath),
    ...scanOriginSessionsBranch(repoPath),
  ];

  // Scan local agent history (Strategy 1)
  const sessions = [
    ...scanClaudeSessions(repoPath),
    ...scanCursorSessions(repoPath),
    ...scanCodexSessions(repoPath),
  ];

  const aiResults: BackfillResult[] = [];
  const humanResults: BackfillResult[] = [];

  for (const commit of commits) {
    // Skip already-tagged commits
    if (isAiCommit(repoPath, commit.sha)) continue;

    let result: BackfillResult | null = null;

    // Strategy 0: Origin session state match (absolute highest confidence)
    const originMatch = matchOriginSession(commit, originSessions);
    if (originMatch) {
      result = {
        sha: commit.sha,
        date: commit.date.split('T')[0],
        subject: commit.subject,
        agent: originMatch.agent,
        confidence: 'high',
        source: 'backfill-origin-session',
        authorName: commit.authorName,
        authorEmail: commit.authorEmail,
      };
    }

    // Strategy 1: Local agent history session match
    if (!result) {
      const sessionMatch = matchSessionToCommit(commit, sessions);
      if (sessionMatch) {
        result = {
          sha: commit.sha,
          date: commit.date.split('T')[0],
          subject: commit.subject,
          agent: sessionMatch.agent,
          confidence: 'high',
          source: 'backfill-session-match',
          authorName: commit.authorName,
          authorEmail: commit.authorEmail,
        };
      }
    }

    // Strategy 2: Commit message patterns
    if (!result) {
      const message = getCommitMessage(repoPath, commit.sha);
      const msgResult = detectFromCommitMessage(commit, message);
      if (msgResult) {
        result = {
          sha: commit.sha,
          date: commit.date.split('T')[0],
          subject: commit.subject,
          agent: msgResult.agent,
          confidence: msgResult.confidence,
          source: msgResult.source,
          authorName: commit.authorName,
          authorEmail: commit.authorEmail,
        };
      }
    }

    // Strategy 4: File change patterns
    if (!result) {
      const fileResult = detectFromFileChanges(repoPath, commit.sha);
      if (fileResult) {
        result = {
          sha: commit.sha,
          date: commit.date.split('T')[0],
          subject: commit.subject,
          agent: fileResult.agent,
          confidence: fileResult.confidence,
          source: fileResult.source,
          authorName: commit.authorName,
          authorEmail: commit.authorEmail,
        };
      }
    }

    // Strategy 3: Code style heuristics (lowest confidence)
    if (!result) {
      const diff = getCommitDiff(repoPath, commit.sha);
      const styleResult = detectFromCodeStyle(diff);
      if (styleResult) {
        result = {
          sha: commit.sha,
          date: commit.date.split('T')[0],
          subject: commit.subject,
          agent: styleResult.agent,
          confidence: styleResult.confidence,
          source: styleResult.source,
          authorName: commit.authorName,
          authorEmail: commit.authorEmail,
        };
      }
    }

    if (result) {
      aiResults.push(result);
    } else {
      humanResults.push({
        sha: commit.sha,
        date: commit.date.split('T')[0],
        subject: commit.subject,
        agent: 'Human',
        confidence: 'low',
        source: '',
        authorName: commit.authorName,
        authorEmail: commit.authorEmail,
      });
    }
  }

  // Display results
  const allResults = [...aiResults, ...humanResults].sort((a, b) => b.date.localeCompare(a.date));

  for (const r of allResults) {
    const sha = chalk.yellow(r.sha.slice(0, 7));
    const date = chalk.gray(r.date);
    const subject = truncate(r.subject, 35);
    const isHuman = r.agent === 'Human';

    if (isHuman) {
      console.log(`  ${sha}  ${date}  ${chalk.white(subject.padEnd(37))} ${chalk.gray('\u2192 Human').padEnd(52)} ${chalk.gray('  LOW')}`);
    } else {
      const agentLabel = formatAgent(r.agent, r.source);
      const confidenceLabel = formatConfidence(r.confidence);
      console.log(`  ${sha}  ${date}  ${chalk.white(subject.padEnd(37))} ${agentLabel.padEnd(52)} ${confidenceLabel}`);
    }
  }

  // Summary
  const highCount = aiResults.filter(r => r.confidence === 'high').length;
  const mediumCount = aiResults.filter(r => r.confidence === 'medium').length;
  const lowCount = aiResults.filter(r => r.confidence === 'low').length;

  console.log(`\nFound: ${chalk.cyan(String(aiResults.length))} AI commits (${highCount} high confidence, ${mediumCount} medium, ${lowCount} low)`);
  console.log(`       ${chalk.gray(String(humanResults.length))} human commits`);

  // Filter by confidence for tagging
  const taggable = aiResults.filter(r => meetsMinConfidence(r.confidence, minConfidence));

  if (taggable.length === 0) {
    console.log(chalk.gray('\nNo commits to tag above minimum confidence threshold.'));
    return;
  }

  if (!apply) {
    console.log(chalk.gray(`\nDry run — ${taggable.length} commits would be tagged. Use --apply to write git notes.`));
    return;
  }

  // Apply mode: prompt for confirmation
  const answer = await promptUser(`\nApply tags to ${taggable.length} commits? [y/N] `);
  if (answer !== 'y' && answer !== 'yes') {
    console.log(chalk.gray('Aborted.'));
    return;
  }

  let tagged = 0;
  let failed = 0;
  for (const r of taggable) {
    if (applyBackfillNote(repoPath, r)) {
      tagged++;
    } else {
      failed++;
    }
  }

  console.log(chalk.green(`\nTagged ${tagged} commits with AI attribution notes.`));
  if (failed > 0) {
    console.log(chalk.yellow(`${failed} commits failed to tag.`));
  }
}

// ─── Formatting Helpers ───────────────────────────────────────────────────

function truncate(str: string, maxLen: number): string {
  if (str.length <= maxLen) return str;
  return str.slice(0, maxLen - 1) + '\u2026';
}

function formatAgent(agent: string, source: string): string {
  const sourceLabel = source.replace('backfill-', '').replace('-', ' ');
  const agentName = agent.charAt(0).toUpperCase() + agent.slice(1);
  return chalk.cyan(`\u2192 ${agentName}`) + chalk.gray(` (${sourceLabel})`);
}

function formatConfidence(confidence: Confidence): string {
  switch (confidence) {
    case 'high':
      return chalk.green('\u2713 HIGH');
    case 'medium':
      return chalk.yellow('~ MEDIUM');
    case 'low':
      return chalk.gray('  LOW');
  }
}
