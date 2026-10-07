// ─── Per-file card ───────────────────────────────────────────────────────────
//
// The first time a session reads or edits a file, the agent gets what it
// should know before changing THAT file — and nothing when there is nothing:
//
//   - bugs already fixed here, so it does not reintroduce them;
//   - attempts that were tried and undone (reverted, or mostly rewritten
//     since), so it does not repeat them;
//   - decisions recorded about the file, so it does not "fix" what is
//     deliberate;
//   - open TODOs that name the file.
//
// No counts, no percentages. The first version of this card led with "25 agent
// commits" and "89% of the lines agents added are still here". An agent can do
// nothing with either except be careful, which it should be anyway, and every
// busy file carried one. Survival is still computed — exact first-author-wins,
// the same measure as benchmark-survival.ts — but only to find the attempts
// that did not last, which are named by what they tried.
//
// Local and bounded: one `git log` (notes inline), at most one `git blame`, one
// memory-note read, no network, no LLM. Only the last CARD_WINDOW_DAYS count; a
// half-year-old history describes code that has mostly changed since.

import fs from 'fs';
import path from 'path';
import { runDetailed } from './utils/exec.js';
import { readMemoryRecordsForFile, memoryReadBlocked } from './memory.js';
import { readMemoryTodos } from './todo.js';
import { shouldIgnoreFile, isLockfile, isOriginAutoManagedPath } from './ignore-patterns.js';

export const CARD_WINDOW_DAYS = 90;
const CARD_MAX_COMMITS = 30;
// A change younger than this has had no chance to be undone.
const MIN_AGE_FOR_SURVIVAL_MS = 24 * 60 * 60 * 1000;
// An attempt counts as undone when it lost at least this many lines and most
// of what it added. Looser bars flagged half the busy files in Origin's repo.
const MIN_LINES_LOST_TO_NAME = 20;
const MAX_ITEMS = 2;
const MAX_FIXES = 3;
// A fix belongs to this file's card only when the file is central to it: at
// least this share of the commit's source-line changes, or one of at most
// CENTRAL_MAX_FILES source files. Squash commits fix one thing and touch thirty
// files; without this, heartbeat.ts listed "a Codex turn that ends in an error
// still gets its row" as one of its bugs.
const CENTRAL_SHARE = 0.3;
const CENTRAL_MAX_FILES = 3;
// In a small commit, a file still needs a real change of its own to be
// central: every CLI fix bumps packages/cli/package.json by one line, and the
// small-commit rule alone listed three unrelated capture fixes as that file's
// "bugs already fixed".
const CENTRAL_MIN_LINES = 3;


/** One commit that changed the file, as the card needs it. */
export interface FileChange {
  sha: string;
  date: string;
  subject: string;
  /** Session id when known (note or trailer), else the commit sha. */
  group: string;
  agent: boolean;
  added: number;
  deleted: number;
  /** Prompt keys (`session:index`) whose recorded files include this file. */
  promptKeys: string[];
  /** Text of those prompts, in the note's order. */
  promptTexts: string[];
  /** The session's recorded decisions (note markers). */
  decisions: string[];
  /**
   * Is this file central to the commit? Unknown (undefined) counts as central,
   * so a caller that did not measure loses nothing it had before.
   */
  central?: boolean;
}

export interface FileCard {
  path: string;
  /** Bugs fixed in this file recently, newest first. */
  fixes: Array<{ sha: string; subject: string; date: string }>;
  /** Attempts that did not last. */
  undone: Array<{ sha: string; subject: string; how: 'reverted' | 'rewritten' }>;
  decisions: string[];
  open: string[];
}

const AI_CO_AUTHOR = /claude|anthropic|codex|openai|copilot|gemini|cursor|devin|windsurf|antigravity/i;
const FIX_SUBJECT = /^(fix|bugfix|hotfix)(\(|:|!)|^fix(es|ed)?\b/i;

function git(repoPath: string, args: string[], timeoutMs: number): string | null {
  const r = runDetailed('git', args, { cwd: repoPath, timeoutMs, maxBuffer: 64 * 1024 * 1024 });
  return r.status === 0 ? r.stdout : null;
}

function parseNote(raw: string): Record<string, any> | null {
  const text = raw.trim();
  if (!text.startsWith('{')) return null;
  try {
    const parsed = JSON.parse(text);
    return parsed?.origin || parsed;
  } catch {
    return null;
  }
}

const strings = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string' && !!x.trim()) : []);

/**
 * Parse `git log --numstat` output written with the record format in
 * buildFileCard. Pure + exported for testing.
 */
export function parseFileHistory(out: string, relPath: string): FileChange[] {
  const changes: FileChange[] = [];
  for (const record of out.split('\x1e')) {
    if (!record.trim()) continue;
    const end = record.indexOf('\x1d');
    if (end < 0) continue;
    const [sha, date, subject, sessionTrailer, coAuthors, noteRaw] = record.slice(0, end).split('\x1f');
    if (!sha) continue;
    let added = 0;
    let deleted = 0;
    for (const line of record.slice(end + 1).split('\n')) {
      const m = /^(\d+|-)\t(\d+|-)\t/.exec(line);
      if (!m) continue;
      added += m[1] === '-' ? 0 : Number(m[1]);
      deleted += m[2] === '-' ? 0 : Number(m[2]);
    }
    const note = parseNote(noteRaw || '');
    const noteSession = typeof note?.sessionId === 'string' && note.sessionId !== 'unknown' ? note.sessionId : '';
    const trailerSession = (sessionTrailer || '').split(',')[0].trim();
    const agent = !!noteSession
      || (typeof note?.agent === 'string' && note.agent !== 'Human')
      || !!trailerSession
      || AI_CO_AUTHOR.test(coAuthors || '');
    const group = noteSession || trailerSession || sha;
    const promptKeys: string[] = [];
    const promptTexts: string[] = [];
    for (const p of Array.isArray(note?.prompts) ? note.prompts : []) {
      if (Array.isArray(p?.files) && p.files.includes(relPath)) {
        promptKeys.push(`${group}:${p.index}`);
        if (typeof p.text === 'string' && p.text.trim()) promptTexts.push(p.text);
      }
    }
    changes.push({
      sha, date, subject: subject || '', group, agent, added, deleted,
      promptKeys, promptTexts, decisions: strings(note?.markers?.decision),
    });
  }
  return changes;
}

/** Lines at HEAD per blamed commit (full sha → count). Pure + exported for testing. */
export function parseBlameCounts(porcelain: string): Map<string, number> {
  const counts = new Map<string, number>();
  for (const line of porcelain.split('\n')) {
    const m = /^([0-9a-f]{40}) \d+ \d+/.exec(line);
    if (m) counts.set(m[1], (counts.get(m[1]) || 0) + 1);
  }
  return counts;
}

/** "fix(capture): a turn keeps its row (#1969)" → "a turn keeps its row". Pure + exported for testing. */
export function plainSubject(subject: string): string {
  return subject.trim().replace(/^[a-z]+(\([^)]*\))?!?:\s*/i, '').replace(/\s*\(#\d+\)\s*$/, '');
}

/**
 * Is `relPath` central to the commit whose `git diff-tree --numstat` is
 * `numstat`? Tests, lockfiles and generated files do not count toward the
 * commit's size. Pure + exported for testing.
 */
export function isCentral(numstat: string, relPath: string): boolean {
  let total = 0;
  let mine = 0;
  let files = 0;
  for (const line of numstat.split('\n')) {
    const m = /^(\d+|-)\t(\d+|-)\t(.+)$/.exec(line);
    if (!m) continue;
    const file = m[3];
    if (shouldIgnoreFile(file) || isOriginAutoManagedPath(file) || /(^|\/)(__tests__|tests?)\/|\.test\.|\.spec\./.test(file)) continue;
    const n = (m[1] === '-' ? 0 : Number(m[1])) + (m[2] === '-' ? 0 : Number(m[2]));
    files++;
    total += n;
    if (file === relPath) mine = n;
  }
  if (files === 0) return true;
  const share = total > 0 ? mine / total : 0;
  if (share >= CENTRAL_SHARE) return true;
  return files <= CENTRAL_MAX_FILES && mine >= CENTRAL_MIN_LINES;
}

/** Does `text` name the file — its path, or a basename with an extension? */
function namesFile(text: string, relPath: string): boolean {
  const base = relPath.split('/').pop() || relPath;
  return text.includes(relPath) || (/\.[A-Za-z0-9]+$/.test(base) && text.includes(base));
}

/**
 * Reduce a file's history to what the card says. `changes` is newest first, as
 * git log prints it. `blame` is null when blame was not run or failed; nothing
 * is then called rewritten. Decisions and TODOs from the memory note come in
 * through `extra`. Pure + exported for testing.
 */
export function summarizeFileHistory(
  relPath: string,
  changes: FileChange[],
  blame: Map<string, number> | null,
  opts: { now: number; currentSessionId?: string | null },
  extra: { decisions?: string[]; open?: string[] } = {},
): FileCard {
  // This session's own changes are not history to it: it made them.
  const history = changes.filter((c) => !(opts.currentSessionId && c.group === opts.currentSessionId));
  const agentChanges = history.filter((c) => c.agent);

  const undone: FileCard['undone'] = [];
  for (const c of history) {
    const m = /^Revert "(.+)"$/.exec(c.subject.trim());
    const target = m ? agentChanges.find((a) => a.subject === m[1]) : undefined;
    if (target && !undone.some((u) => u.sha === target.sha)) undone.push({ sha: target.sha, subject: target.subject, how: 'reverted' });
  }
  if (blame) {
    const lost = agentChanges
      .filter((c) => c.added > 0 && Number.isFinite(Date.parse(c.date)) && opts.now - Date.parse(c.date) >= MIN_AGE_FOR_SURVIVAL_MS)
      .map((c) => ({ c, kept: Math.min(blame.get(c.sha) || 0, c.added) }))
      .filter(({ c, kept }) => c.added - kept >= MIN_LINES_LOST_TO_NAME && kept / c.added < 0.5)
      .sort((a, b) => (b.c.added - b.kept) - (a.c.added - a.kept));
    for (const { c } of lost) {
      if (!undone.some((u) => u.sha === c.sha)) undone.push({ sha: c.sha, subject: c.subject, how: 'rewritten' });
    }
  }
  const undoneShas = new Set(undone.map((u) => u.sha));

  const fixes = history
    .filter((c) => FIX_SUBJECT.test(c.subject.trim()) && !undoneShas.has(c.sha) && c.central !== false)
    .slice(0, MAX_FIXES)
    .map((c) => ({ sha: c.sha, subject: c.subject, date: c.date.slice(0, 10) }));

  const decisions: string[] = [];
  for (const d of [...agentChanges.flatMap((c) => c.decisions), ...(extra.decisions || [])]) {
    if (namesFile(d, relPath) && !decisions.includes(d)) decisions.push(d);
  }

  return {
    path: relPath,
    fixes,
    undone: undone.slice(0, MAX_ITEMS),
    decisions: decisions.slice(0, MAX_ITEMS),
    open: (extra.open || []).filter((t) => namesFile(t, relPath)).slice(0, MAX_ITEMS),
  };
}

function clip(text: string, max: number): string {
  const one = text.replace(/\s+/g, ' ').trim();
  return one.length <= max ? one : one.slice(0, max - 1).trimEnd() + '…';
}

/**
 * Render the card, or null when there is nothing the agent should act on.
 *
 * No "what was asked for": the prompt behind a file's latest change was tried
 * and dropped. It is usually a session's opening request ("add a discarded
 * pill") or a reply ("do both"), and on Origin's own files it named something
 * other than the file far more often than not. Pure + exported for testing.
 */
export function renderFileCard(card: FileCard): string | null {
  if (!card.fixes.length && !card.undone.length && !card.decisions.length && !card.open.length) return null;

  const lines = [`Origin — before you change ${card.path}:`];
  if (card.fixes.length) {
    lines.push('- Bugs already fixed here (do not reintroduce):');
    for (const f of card.fixes) lines.push(`    ${f.date}: ${clip(plainSubject(f.subject), 110)}`);
  }
  for (const u of card.undone) {
    lines.push(`- Tried and undone: "${clip(plainSubject(u.subject), 90)}" was ${u.how === 'reverted' ? 'reverted' : 'mostly rewritten later'}.`);
  }
  for (const d of card.decisions) lines.push(`- Decision: ${clip(d, 180)}`);
  for (const t of card.open) lines.push(`- Still open: ${clip(t, 180)}`);
  lines.push(`More: \`origin prompts ${card.path}\``);
  return lines.join('\n');
}

/**
 * Build the rendered card for `relPath` (repo-relative), or null. Never throws.
 */
export function buildFileCard(
  repoPath: string,
  relPath: string,
  opts: { currentSessionId?: string | null; now?: number } = {},
): string | null {
  try {
    if (!relPath || relPath.startsWith('..') || relPath.startsWith('/')) return null;
    if (memoryReadBlocked(repoPath)) return null;
    if (shouldIgnoreFile(relPath) || isLockfile(relPath) || isOriginAutoManagedPath(relPath)) return null;
    const now = opts.now ?? Date.now();

    const log = git(repoPath, [
      'log', '-n', String(CARD_MAX_COMMITS), `--since=${CARD_WINDOW_DAYS}.days`, '--no-merges',
      '--notes=refs/notes/origin',
      '--format=%x1e%H%x1f%aI%x1f%s%x1f%(trailers:key=Origin-Session,valueonly,separator=%x2C)%x1f%(trailers:key=Co-Authored-By,valueonly,separator=%x7C)%x1f%N%x1d',
      '--numstat', 'HEAD', '--', relPath,
    ], 3_000);
    const changes = log ? parseFileHistory(log, relPath) : [];
    // Centrality only matters for the fixes the card could show: measure fix
    // commits newest first until MAX_FIXES central ones are found, at most
    // MAX_FIXES * 3 of them. A fix past that cap was never measured, and it
    // must not count as central by default: on packages/cli/package.json,
    // which every CLI fix bumps, the first nine were rightly dropped and the
    // tenth onwards slipped through unmeasured.
    let fixSeen = 0;
    let centralFound = 0;
    for (const c of changes) {
      if (!FIX_SUBJECT.test(c.subject.trim())) continue;
      if (centralFound >= MAX_FIXES || ++fixSeen > MAX_FIXES * 3) {
        c.central = false;
        continue;
      }
      const stat = git(repoPath, ['diff-tree', '--no-commit-id', '--numstat', '-r', c.sha], 2_000);
      if (stat !== null) c.central = isCentral(stat, relPath);
      if (c.central !== false) centralFound++;
    }

    const needsBlame = changes.some((c) => c.agent && c.added >= MIN_LINES_LOST_TO_NAME && now - Date.parse(c.date) >= MIN_AGE_FOR_SURVIVAL_MS);
    const porcelain = needsBlame ? git(repoPath, ['blame', '--line-porcelain', 'HEAD', '--', relPath], 3_000) : null;

    const cutoff = now - CARD_WINDOW_DAYS * 24 * 60 * 60 * 1000;
    const recent = (d: string | undefined | null) => (Date.parse(d || '') || 0) >= cutoff;
    const records = readMemoryRecordsForFile(repoPath, relPath);
    const decisions = [
      ...records.commits.filter((c) => recent(c.committedAt) && c.sessionId !== opts.currentSessionId).flatMap((c) => c.decisions || []),
      ...records.sessions.filter((s) => recent(s.endedAt || s.startedAt) && s.sessionId !== opts.currentSessionId).flatMap((s) => s.decisions || []),
    ];
    // Closed TODOs are already filtered out by readMemoryTodos.
    let open: string[] = [];
    try { open = readMemoryTodos(repoPath).filter((t) => t.status === 'open').map((t) => t.text); } catch { /* none */ }

    const card = summarizeFileHistory(relPath, changes, porcelain ? parseBlameCounts(porcelain) : null, {
      now, currentSessionId: opts.currentSessionId,
    }, { decisions, open });
    return renderFileCard(card);
  } catch {
    return null;
  }
}

// Words in a shell command that are never a file: control operators and the
// commands that read files themselves.
const SHELL_SPLIT = /[\s;|&<>()`]+/;
const MAX_FILES_PER_COMMAND = 5;

/**
 * The existing files a shell command names, resolved against `cwd`.
 *
 * The card used to fire only on file tools (Read, Edit, Write). Agents in a
 * permission-bypassing mode are told to prefer `cat`, `sed -n`, `grep` and
 * shell edits, and in the first context bake-off the file-cards arm made 54
 * tool calls without one Read or Edit. It never saw a card, so the arm
 * measured nothing. Any token that names a real file counts: a file named in
 * a command is a file the agent is working on, whatever the command does
 * with it.
 *
 * Conservative on purpose: only tokens that exist as regular files, `path:line`
 * forms reduced to the path, at most MAX_FILES_PER_COMMAND per command. A
 * missed file costs one card; a wrong one costs a card about the wrong file.
 * Pure apart from the file-system check + exported for testing.
 */
export function filesNamedByCommand(command: string, cwd: string): string[] {
  if (!command || !cwd) return [];
  const out: string[] = [];
  const seen = new Set<string>();
  for (let token of command.split(SHELL_SPLIT)) {
    if (out.length >= MAX_FILES_PER_COMMAND) break;
    token = token.replace(/^['"]+|['"]+$/g, '').replace(/:\d+(?::\d+)?$/, '');
    if (!token || token.startsWith('-') || token.includes('$') || token.includes('*')) continue;
    if (!token.includes('/') && !/\.[A-Za-z0-9]{1,8}$/.test(token)) continue;
    const abs = path.isAbsolute(token) ? token : path.resolve(cwd, token);
    if (seen.has(abs)) continue;
    seen.add(abs);
    try {
      if (fs.statSync(abs).isFile()) out.push(abs);
    } catch { /* not a file */ }
  }
  return out;
}
