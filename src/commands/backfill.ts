import chalk from 'chalk';
import { listSessionIds, readSessionFile } from '../session-store.js';
import { existsSync, readdirSync, readFileSync, statSync } from 'fs';
import { homedir } from 'os';
import { join, resolve } from 'path';
import { isAiCommit } from '../attribution.js';
import { getGitRoot } from '../session-state.js';
import * as readline from 'readline';
import { git, gitDetailed, gitIdentityEnv } from '../utils/exec.js';
import { buildInferredAttributionRecord, ATTRIBUTION_RECORD_NOTE_KEY } from '../attribution-note.js';
import { publishAttributionNotes, resolvePushRemote, describePublishResult } from '../git-notes.js';
import { cliVersion } from '../cli-version.js';

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

// ─── Strategy 1: the agent's own transcript shows it making the commit ─────
//
// `git commit` prints `[<branch> <short-sha>] <subject>`, and an agent that ran
// it has that line in its transcript as the tool result. Finding THIS repo's
// commit sha there is the agent saying, in its own record, that it made it.
//
// This used to read `<repo>/.claude/projects`, `<repo>/.cursor` and
// `<repo>/.codex` — config folders, not transcripts (Claude Code keeps them in
// ~/.claude/projects/<slug>, Codex in ~/.codex/sessions) — and matched commits
// to any file's timestamp within five minutes, labelled "high".

const COMMIT_OUTPUT_RE = /\[[^\]\s]+(?: \(root-commit\))? ([0-9a-f]{7,40})\]/g;

interface TranscriptCommit { short: string; agent: string; file: string }

/** Claude Code's project folder name for a path: every non-alphanumeric → '-'. */
export function claudeProjectSlug(repoPath: string): string {
  return resolve(repoPath).replace(/[^a-zA-Z0-9]/g, '-');
}

function commitShasInFile(file: string, agent: string, out: TranscriptCommit[]): void {
  let text: string;
  try { text = readFileSync(file, 'utf-8'); } catch { return; }
  if (!text.includes('git commit') && !text.includes('root-commit')) return;
  for (const m of text.matchAll(COMMIT_OUTPUT_RE)) out.push({ short: m[1].toLowerCase(), agent, file });
}

/** Claude Code transcripts of this repo and its worktrees (~/.claude/projects/<slug>*). */
function scanClaudeTranscripts(repoPath: string, home: string, sinceMs: number): TranscriptCommit[] {
  const out: TranscriptCommit[] = [];
  const root = join(home, '.claude', 'projects');
  const slug = claudeProjectSlug(repoPath);
  let dirs: string[] = [];
  try { dirs = readdirSync(root).filter((d) => d === slug || d.startsWith(`${slug}-`)); } catch { return out; }
  for (const d of dirs) {
    let files: string[] = [];
    try { files = readdirSync(join(root, d)).filter((f) => f.endsWith('.jsonl')); } catch { continue; }
    for (const f of files) {
      const file = join(root, d, f);
      try { if (statSync(file).mtimeMs < sinceMs) continue; } catch { continue; }
      commitShasInFile(file, 'claude', out);
    }
  }
  return out;
}

/** Codex rollouts whose session ran in this repo (~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl). */
function scanCodexTranscripts(repoPath: string, home: string, sinceMs: number): TranscriptCommit[] {
  const out: TranscriptCommit[] = [];
  const root = join(home, '.codex', 'sessions');
  const repo = resolve(repoPath);
  const walk = (dir: string, depth: number) => {
    let entries: import('fs').Dirent[] = [];
    try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const full = join(dir, e.name);
      if (e.isDirectory() && depth < 4) { walk(full, depth + 1); continue; }
      if (!e.isFile() || !e.name.endsWith('.jsonl')) continue;
      try { if (statSync(full).mtimeMs < sinceMs) continue; } catch { continue; }
      // The first line is the session's metadata, with the directory it ran in.
      let cwd = '';
      try {
        const first = readFileSync(full, 'utf-8').split('\n', 1)[0];
        const meta = JSON.parse(first);
        cwd = meta?.payload?.cwd || meta?.cwd || '';
      } catch { continue; }
      if (!cwd || !(resolve(cwd) === repo || resolve(cwd).startsWith(`${repo}/`))) continue;
      commitShasInFile(full, 'codex', out);
    }
  };
  walk(root, 0);
  return out;
}

function matchTranscriptCommit(commit: CommitInfo, found: TranscriptCommit[]): TranscriptCommit | null {
  const sha = commit.sha.toLowerCase();
  const hits = found.filter((t) => sha.startsWith(t.short));
  // Two agents claiming one commit is no answer.
  return hits.length > 0 && hits.every((h) => h.agent === hits[0].agent) ? hits[0] : null;
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

            // Only a session of THIS repo. One with no repoPath used to match
            // every repo on the machine.
            const sessionRepo = state.repoPath || '';
            if (!sessionRepo || resolve(sessionRepo) !== resolve(repoPath)) continue;

            const m = (state.model || '').toLowerCase();
            const agent = m.includes('codex') ? 'codex'
              : m.includes('gemini') ? 'gemini'
              : m.includes('cursor') ? 'cursor'
              : m.includes('claude') ? 'claude'
              : /^gpt-/.test(m) ? 'codex'  // gpt-5.4 etc = Codex CLI
              : m === 'default' || m === 'unknown' ? 'ai'
              : m || 'ai';

            const startMs = state.startedAt ? new Date(state.startedAt).getTime() : 0;
            // The session's own end when it recorded one; the file's mtime
            // only says when anything last touched the file.
            const recordedEnd = Date.parse(state.endedAt || state.lastActivityAt || '');
            const endMs = Number.isFinite(recordedEnd) ? recordedEnd : statSync(fullPath).mtimeMs;

            // The commits the session captured. NOT headShaAtStart: that is the
            // commit the session STARTED on — someone else's, made before it.
            const commits: string[] = [];
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
    // List all stored sessions (refs or branch backend)
    const dirs = listSessionIds(repoPath);
    if (dirs.length === 0) return results;

    for (const dir of dirs) {
      if (!SAFE_ID.test(dir)) continue;
      try {
        const metaJson = (readSessionFile(repoPath, dir, 'metadata.json') ?? '').trim();
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

        // The session's commits live in metadata.json under `git`, which is
        // where the CLI has always written them (see buildMetadataJson).
        //
        // This used to read `meta.commitSha` / `meta.headShaAtStart` — a flat
        // shape the writer never produced — and then a commits.json that nothing
        // writes at all. Both silently yielded nothing, so `commits` was ALWAYS
        // empty and every session looked commit-less to the backfill.
        const commits: string[] = [];
        const seen = new Set<string>();
        const addSha = (sha: unknown) => {
          if (typeof sha !== 'string' || !/^[a-fA-F0-9]{7,64}$/.test(sha)) return;
          if (seen.has(sha)) return;
          seen.add(sha);
          commits.push(sha);
        };
        for (const sha of meta.git?.commitShas ?? []) addSha(sha);
        // headAfter is the session's end state — useful when commitShas is empty
        // (e.g. a session captured before commitShas was populated).
        addSha(meta.git?.headAfter);

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
  localEmail: string,
): { session: OriginSessionInfo; bySha: boolean } | null {
  // The session recorded this commit — whoever's machine it was.
  for (const session of sessions) {
    if (session.commits.includes(commit.sha)) return { session, bySha: true };
  }
  // A commit made while one of THIS machine's sessions ran, by THIS machine's
  // git user: a teammate's commit pulled in during the window is not ours.
  // Exactly one session must cover it.
  if (!localEmail || commit.authorEmail.toLowerCase() !== localEmail) return null;
  const commitMs = commit.timestamp * 1000;
  const covering = sessions.filter((s) => s.startedAt > 0 && s.endedAt > 0
    && commitMs >= s.startedAt - 120_000 && commitMs <= s.endedAt + 300_000);
  return covering.length === 1 ? { session: covering[0], bySha: false } : null;
}

// ─── Strategy 2: the commit names its agent ────────────────────────────────
//
// Only what the commit itself SAYS: an Origin-Session trailer, a co-author or
// author that is an agent by name or address, a message an agent writes
// verbatim. The style guesses that lived here (a conventional prefix, an em
// dash, a short lowercase subject, an emoji, "update the") labelled ordinary
// human commits as Claude, Codex or Gemini — and `users.noreply.github.com`,
// every GitHub web user's address, read as Copilot.

/** An agent named by a person-ish identity string (name and/or email). */
export function agentNamedBy(identity: string): string | null {
  const s = identity.toLowerCase();
  if (/\bclaude\b|@anthropic\.com/.test(s)) return 'claude';
  if (/\bcodex\b|@openai\.com/.test(s)) return 'codex';
  if (/\bcopilot\b|copilot@/.test(s)) return 'copilot';
  if (/\bcursor ?agent\b|cursoragent@|@cursor\.(com|sh)/.test(s)) return 'cursor';
  if (/\bgemini\b/.test(s)) return 'gemini';
  if (/\bdevin\b|devin-ai-integration/.test(s)) return 'devin';
  if (/\baider\b/.test(s)) return 'aider';
  return null;
}

const TRAILER_AGENT_RE = /^Origin-Session:\s*[^|\n]*\|\s*([^|\n]+)/im;

export function detectFromCommitMessage(
  commit: CommitInfo,
  message: string,
): { agent: string; confidence: Confidence; source: string } | null {
  // Origin's own trailer (a commit Origin captured but has no note for).
  const trailer = message.match(TRAILER_AGENT_RE);
  if (trailer) {
    return { agent: agentNamedBy(trailer[1]) || 'ai', confidence: 'high', source: 'backfill-trailer' };
  }
  // A co-author that is an agent.
  for (const m of message.matchAll(/^co-authored-by:\s*(.+)$/gim)) {
    const agent = agentNamedBy(m[1]);
    if (agent) return { agent, confidence: 'high', source: 'backfill-coauthor' };
  }
  // The author or committer IS an agent (a bot account, an agent's identity).
  const author = agentNamedBy(`${commit.authorName} <${commit.authorEmail}>`)
    || agentNamedBy(`${commit.committerName} <${commit.committerEmail}>`);
  if (author) return { agent: author, confidence: 'high', source: 'backfill-author-match' };
  // Codex Cloud's default message.
  if (message.trim() === '-') return { agent: 'codex', confidence: 'medium', source: 'backfill-pattern' };
  const said = message.match(/\bgenerated (?:by|with) (claude|codex|copilot|cursor|gemini)\b/i);
  if (said) return { agent: said[1].toLowerCase(), confidence: 'medium', source: 'backfill-pattern' };
  return null;
}

// ─── Apply Tags ───────────────────────────────────────────────────────────

/** The record slug for a backfill agent label. */
const RECORD_AGENT: Record<string, string> = { claude: 'claude-code' };

function hasNote(repoPath: string, sha: string): boolean {
  return gitDetailed(['notes', '--ref=origin', 'show', sha], gitOpts(repoPath)).status === 0;
}

function applyBackfillNote(repoPath: string, result: BackfillResult): boolean {
  if (!HEX.test(result.sha)) return false;
  // Never over a note that is already there — it was written by a session,
  // which knows more than any of this.
  if (hasNote(repoPath, result.sha)) return false;
  try {
    const envelope: Record<string, unknown> = {
      // Read by this CLI (isAiNote: an agent and no session).
      origin: {
        agent: result.agent,
        agentName: result.agent,
        model: 'unknown',
        confidence: result.confidence,
        source: result.source,
        backfill: true,
      },
    };
    // Read by the server: a validated v1 record with `inferred` evidence sets
    // the commit's agent and, carrying no session, never makes one up.
    const built = buildInferredAttributionRecord(result.sha, RECORD_AGENT[result.agent] || result.agent, {
      recordedAt: new Date(),
      producerVersion: cliVersion(),
    });
    if (built.record) envelope[ATTRIBUTION_RECORD_NOTE_KEY] = built.record;
    git(
      ['notes', '--ref=origin', 'add', '-m', JSON.stringify(envelope), result.sha],
      // `notes add` builds an object, so it needs a git identity exactly like
      // `commit-tree` — and this caller swallows its error, so a box without
      // one fails every write silently. Defers to real config (see
      // gitIdentityEnv); only the note WRITE needs it, not the reads above.
      { ...gitOpts(repoPath), env: { ...process.env, ...gitIdentityEnv(repoPath) } },
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
  push?: boolean;
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

  const commits = getCommitsInRange(repoPath, days);
  if (commits.length === 0) {
    console.log(chalk.gray(`No commits found in the last ${days} days.`));
    return;
  }

  console.log(`Scanning ${chalk.bold(String(commits.length))} commits...\n`);

  const home = process.env.HOME || process.env.USERPROFILE || homedir();
  const sinceMs = Date.now() - (days + 1) * 86_400_000;
  let localEmail = '';
  try { localEmail = git(['config', 'user.email'], gitOpts(repoPath)).trim().toLowerCase(); } catch { /* none set */ }

  // Strategy 0: Origin's own session records (state files + the session store).
  const originSessions = [
    ...scanOriginSessions(repoPath),
    ...scanOriginSessionsBranch(repoPath),
  ];
  // Strategy 1: the agents' own transcripts on this machine.
  const transcriptCommits = [
    ...scanClaudeTranscripts(repoPath, home, sinceMs),
    ...scanCodexTranscripts(repoPath, home, sinceMs),
  ];

  const aiResults: BackfillResult[] = [];
  const humanResults: BackfillResult[] = [];

  for (const commit of commits) {
    // Skip already-tagged commits
    if (isAiCommit(repoPath, commit.sha)) continue;

    const base = {
      sha: commit.sha,
      date: commit.date.split('T')[0],
      subject: commit.subject,
      authorName: commit.authorName,
      authorEmail: commit.authorEmail,
    };
    let result: BackfillResult | null = null;

    const originMatch = matchOriginSession(commit, originSessions, localEmail);
    if (originMatch) {
      result = {
        ...base,
        agent: originMatch.session.agent,
        confidence: originMatch.bySha ? 'high' : 'medium',
        source: originMatch.bySha ? 'backfill-origin-session' : 'backfill-origin-session-window',
      };
    }

    if (!result) {
      const t = matchTranscriptCommit(commit, transcriptCommits);
      if (t) result = { ...base, agent: t.agent, confidence: 'high', source: 'backfill-transcript' };
    }

    if (!result) {
      const msgResult = detectFromCommitMessage(commit, getCommitMessage(repoPath, commit.sha));
      if (msgResult) result = { ...base, ...msgResult };
    }

    if (result) aiResults.push(result);
    else humanResults.push({ ...base, agent: 'Human', confidence: 'low', source: '' });
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

  const highCount = aiResults.filter(r => r.confidence === 'high').length;
  const mediumCount = aiResults.filter(r => r.confidence === 'medium').length;
  const lowCount = aiResults.filter(r => r.confidence === 'low').length;

  console.log(`\nFound: ${chalk.cyan(String(aiResults.length))} AI commits (${highCount} high confidence, ${mediumCount} medium, ${lowCount} low)`);
  console.log(`       ${chalk.gray(String(humanResults.length))} with no agent evidence`);

  const taggable = aiResults.filter(r => meetsMinConfidence(r.confidence, minConfidence));

  if (taggable.length === 0) {
    console.log(chalk.gray('\nNo commits to tag above minimum confidence threshold.'));
    return;
  }

  if (!apply) {
    console.log(chalk.gray(`\nDry run — ${taggable.length} commits would be tagged. Use --apply to write git notes${opts.push ? '' : ', and --push to send them to the remote'}.`));
    return;
  }

  const answer = await promptUser(`\nApply tags to ${taggable.length} commits? [y/N] `);
  if (answer !== 'y' && answer !== 'yes') {
    console.log(chalk.gray('Aborted.'));
    return;
  }

  let tagged = 0;
  let skipped = 0;
  for (const r of taggable) {
    if (applyBackfillNote(repoPath, r)) tagged++;
    else skipped++;
  }

  console.log(chalk.green(`\nTagged ${tagged} commits with AI attribution notes.`));
  if (skipped > 0) {
    console.log(chalk.yellow(`${skipped} commits were not tagged (a note was already there, or the write failed).`));
  }

  // Notes live in this clone until they reach the remote; Origin reads them
  // from there on the next sync of the repo.
  if (opts.push && tagged > 0) {
    const remote = resolvePushRemote(repoPath);
    const pushed = publishAttributionNotes(repoPath, remote, { budgetMs: 60_000 });
    if (pushed.status === 'pushed') {
      console.log(chalk.green(`Pushed refs/notes/origin to ${remote}. Origin reads them on the repo's next sync.`));
    } else {
      console.log(chalk.yellow(`Could not push the notes: ${JSON.stringify(describePublishResult(pushed))}`));
    }
  } else if (tagged > 0) {
    console.log(chalk.gray('The notes are local. Run again with --push, or `origin push-metadata`, to send them to the remote.'));
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

// Internals exercised by session-file-shape-readers.test.ts. Not a public API.
export const __testing = { scanOriginSessionsBranch, scanOriginSessions, matchOriginSession, scanClaudeTranscripts, scanCodexTranscripts, matchTranscriptCommit, applyBackfillNote };
