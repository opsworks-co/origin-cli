import chalk from 'chalk';
import path from 'path';
import { getGitRoot, getWorkingGitRoot } from '../session-state.js';
import { ProvenanceRoots, provenanceRoots, resolveQueryTarget } from '../session-worktree.js';
import {
  aiConfidenceSplit,
  getLineBlame,
  isLineProvenAttribution,
  resolveLineAttribution,
  type HistoryAnchor,
  type LineAttribution,
  type LineAttributionResolution,
} from '../attribution.js';
import { linesOf } from '../attribution-line-reanchor.js';
import { isCanonicalRepoPath } from '../attribution-line-ranges.js';
import { withOpenedPrompts } from '../note-seal.js';
import { isConnectedMode, loadConfig } from '../config.js';
import { git, gitOrNull, runDetailed } from '../utils/exec.js';

const HEX = /^[a-fA-F0-9]{4,64}$/;
const FULL_SHA = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
/** Commits of a line's history asked about, the current one included. */
const LINE_HISTORY_MAX = 6;
/** Server lookups one `why --trace` makes at most, over all its frames. */
const TRACE_SERVER_LOOKUPS_MAX = 50;

/** One server question about a commit and a line; `tryServerWhy` unless a caller budgets it. */
type ServerLookup = (roots: ProvenanceRoots, relPath: string, sha: string, lineContent: string) => Promise<any | null>;

function formatDuration(ms: number): string {
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${s % 60}s`;
  const h = Math.floor(m / 60);
  return `${h}h ${m % 60}m`;
}

// ─── origin why <file>:<line> ────────────────────────────────────────────
// Tells you WHY a specific line exists — which AI session and prompt wrote it.

function parseFileAndLine(input: string): { file: string; line?: number } {
  // Support: file.ts:42, file.ts 42, file.ts
  const colonMatch = input.match(/^(.+):(\d+)$/);
  if (colonMatch) return { file: colonMatch[1], line: parseInt(colonMatch[2], 10) };
  return { file: input };
}

function readOriginNote(repoPath: string, sha: string): any | null {
  if (!HEX.test(sha)) return null;
  const r = runDetailed('git', ['notes', '--ref=origin', 'show', sha], { cwd: repoPath });
  if (r.status !== 0) return null;
  try {
    const parsed = JSON.parse(r.stdout.trim());
    return parsed.origin || parsed;
  } catch {
    return null;
  }
}

function getCommitInfo(repoPath: string, sha: string): { date: string; author: string; message: string } | null {
  if (!HEX.test(sha)) return null;
  try {
    const info = git(
      ['log', '-1', '--format=%aI|%an|%s', sha],
      { cwd: repoPath }
    ).trim();
    const [date, author, ...msgParts] = info.split('|');
    return { date, author, message: msgParts.join('|') };
  } catch {
    return null;
  }
}

async function showLineWhy(roots: ProvenanceRoots, filePath: string, lineNum: number): Promise<void> {
  // Blame the tree the user is STANDING IN. A linked worktree has its own
  // branch and its own copy of the file; resolving against the canonical root
  // instead produced `.claude/worktrees/<name>/…`, which git blame cannot
  // attribute, and every line came back "Uncommitted change".
  const { relPath, root: repoPath } = resolveQueryTarget(filePath, roots, process.cwd());

  // The line's proven authorship and its text, from one resolution: the text
  // shown is the text the attribution numbers (see resolveLineAttribution).
  const resolution = Number.isInteger(lineNum) && lineNum >= 1 ? resolveLineAttribution(repoPath, relPath) : null;
  const attr = resolution?.lines[lineNum - 1];
  const anchor = resolution?.historyAnchors[lineNum - 1] ?? null;
  const lineContent = resolution ? (linesOf(resolution.text)[lineNum - 1] ?? '') : '';

  console.log(chalk.bold(`\n  Line ${lineNum} in ${relPath}`));
  if (lineContent) {
    console.log(chalk.gray(`  ${lineContent.trimStart()}`));
  }
  console.log('');

  // Step 1: the commit strict blame names for the line, at HEAD.
  const commitSha = attr?.commitSha;
  if (!attr || !commitSha) {
    console.log(chalk.yellow('  Uncommitted change — not yet attributed.\n'));
    return;
  }

  // Step 2: get commit info
  const commitInfo = getCommitInfo(repoPath, commitSha);
  const dateStr = commitInfo?.date
    ? new Date(commitInfo.date).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })
    : '—';

  // A committed line without line proof ([AI~], human, unknown): the server
  // may know its commit — a fresh clone has no notes. Asked once, for the
  // blamed commit and the shown text, before any local answer. Its card is
  // commit-level: it never proves the line, and the resolver's answer stays.
  if (!isLineProvenAttribution(attr) && isConnectedMode()) {
    const card = await commitLevelServerCard(roots, repoPath, relPath, anchor, commitSha, lineContent);
    if (card) { renderServerCard(card, relPath, lineNum, lineContent, { commitLevel: true }); return; }
  }

  if (attr.authorship === 'human') {
    // HUMAN_WHEN_NO_AI_EVIDENCE: the commit carries no Origin AI evidence at all.
    console.log(chalk.white(`  Written by ${chalk.cyan(commitInfo?.author || 'unknown')} · ${dateStr}`));
    console.log(chalk.gray(`  Commit: ${commitSha.slice(0, 8)} — ${commitInfo?.message || ''}`));
    console.log(chalk.gray('\n  No Origin session found for this commit.'));
    console.log(chalk.gray('  This line was committed without an active Origin session.\n'));
    return;
  }
  if (attr.authorship !== 'ai') {
    // No evidence either way: no agent, model or prompt.
    console.log(chalk.white(`  Committed by ${chalk.cyan(commitInfo?.author || 'unknown')} · ${dateStr}`));
    console.log(chalk.gray(`  Commit: ${commitSha.slice(0, 8)} — ${commitInfo?.message || ''}`));
    console.log(chalk.gray(`\n  Line-level attribution unknown (${attr.unknownReason ?? 'no_record'}).`));
    console.log(chalk.gray('  Origin has no proof of who wrote this line.\n'));
    return;
  }
  if (!isLineProvenAttribution(attr)) {
    // [AI~]: the line's commit carries AI evidence (a commit-level record, a
    // legacy note, a trailer, an active session), but nothing proves this
    // line. Said as such: no line prompt, no server card for a proven line.
    const who = attr.agent || attr.model || 'AI';
    console.log(chalk.white(`  AI commit: ${chalk.cyan(who)} · ${dateStr}` +
      (attr.sessionId ? ` · Session ${chalk.cyan(attr.sessionId.slice(0, 8))}` : '')));
    console.log(chalk.gray(`  Commit: ${commitSha.slice(0, 8)} — ${commitInfo?.message || ''}`));
    console.log(chalk.gray('\n  commit-level attribution: this commit carries AI evidence, but there is no line-level proof'));
    console.log(chalk.gray('  that it wrote this line. No prompt is attributed to the line.'));
    await showCommitLevelSessionPrompt(repoPath, commitSha, attr.sessionId);
    console.log('');
    return;
  }

  // A proven line claim. The server may enrich it, but only for the very
  // session the canonical record names (provenServerCard); otherwise the
  // local answer below stands.
  if (isConnectedMode()) {
    const card = await provenServerCard(roots, relPath, attr, lineContent);
    if (card) { renderServerCard(card, relPath, lineNum, lineContent); return; }
  }

  // Its session comes from the canonical record. The prompt is shown only when
  // the claim names it (iterationIndex) and the platform has exactly that
  // prompt of exactly that session: no guess from the file, the line's text,
  // a diff hunk, a single-prompt session or a session-wide summary. The legacy
  // note adds session metadata only when it describes that same session.
  const rawNote = readOriginNote(repoPath, commitSha);
  const note = attr.sessionId && rawNote?.sessionId === attr.sessionId ? rawNote : null;
  const agent = attr.agent || attr.model || 'AI';
  const sessionId = attr.sessionId;

  if (!sessionId) {
    console.log(chalk.white(`  Written by ${chalk.cyan(agent)} · ${dateStr}`));
    console.log(chalk.gray(`  Commit: ${commitSha.slice(0, 8)} — ${commitInfo?.message || ''}\n`));
    return;
  }

  console.log(chalk.white(`  Written by ${chalk.cyan(agent)} · ${dateStr} · Session ${chalk.cyan(sessionId.slice(0, 8))}`));

  // Step 4: the claim's own prompt, from the platform
  if (isConnectedMode()) {
    try {
      const { api } = await import('../api.js');
      const session = await api.getSession(sessionId) as any;
      const changes: any[] = Array.isArray(session?.promptChanges) ? session.promptChanges : [];
      const exact = attr.iterationIndex === undefined
        ? []
        : changes.filter((pc) => pc?.promptIndex === attr.iterationIndex);

      if (exact.length === 1) {
        const pc = exact[0];
        console.log(chalk.green(`  Prompt #${pc.promptIndex}: "${pc.promptText}"`));
        // What KIND of change this was, from the server's frozen taxonomy.
        // Printed only when the server had an opinion.
        if (Array.isArray(pc.changeKinds) && pc.changeKinds.length > 0) {
          console.log(chalk.gray(`  Changed: ${pc.changeKinds.join(', ')}`));
        }
        if (pc.filesChanged?.length) {
          console.log(chalk.gray(`  Files: ${[].concat(pc.filesChanged).join(', ')}`));
        }
      } else if (attr.iterationIndex === undefined) {
        console.log(chalk.gray('  Prompt: not recorded for this line (the claim names the session only)'));
      } else {
        console.log(chalk.gray(`  Prompt #${attr.iterationIndex}: not available from Origin`));
      }

      if (changes.length > 0) {
        // Session summary
        const turns = changes.length;
        const cost = session.costUsd ? `$${session.costUsd.toFixed(2)}` : '$0.00';
        const filesCount = (() => {
          try { return JSON.parse(session.filesChanged || '[]').length; } catch { return 0; }
        })();
        const duration = session.durationMs ? formatDuration(session.durationMs) : '—';
        console.log(chalk.gray(`\n  Session: ${turns} turn${turns === 1 ? '' : 's'} · ${cost} · ${filesCount} files · ${duration}`));
      }

      console.log(chalk.gray(`  Run ${chalk.cyan(`origin explain ${sessionId.slice(0, 8)}`)} for full details\n`));
      return;
    } catch {
      // Fall through to local-only display
    }
  }

  // Local-only: show what we know from git notes. A note's prompt summary is
  // session-wide, not this line's prompt: it is not shown as one.
  if (note?.promptTextWithheld === true) {
    // Metadata-only note (the default): the prompt lives in the permissioned
    // Origin record, not in the repository.
    const where = typeof note.originUrl === 'string' && /^https?:\/\//.test(note.originUrl) ? ` — ${note.originUrl}` : '';
    console.log(chalk.gray(note.sealed
      ? `  Prompt: sealed in git notes — no key for this user (needs repo access in Origin)${where}`
      : `  Prompt: not stored in git notes${where}`));
  }
  const cost = note?.costUsd ? `$${note.costUsd.toFixed(2)}` : '';
  const tokens = note?.tokensUsed ? `${(note.tokensUsed / 1000).toFixed(1)}k tokens` : '';
  const meta = [cost, tokens, note?.promptCount ? `${note.promptCount} turns` : ''].filter(Boolean).join(' · ');
  if (meta) console.log(chalk.gray(`  ${meta}`));

  console.log(chalk.gray(`  Commit: ${commitSha.slice(0, 8)} — ${commitInfo?.message || ''}`));
  console.log(chalk.gray(`  Run ${chalk.cyan(`origin explain ${sessionId.slice(0, 8)}`)} for full details\n`));
}

/**
 * The session prompt of an [AI~] line, from the legacy note of its blamed
 * commit — only when the line names exactly one session and that note
 * describes the same one (no aggregate of several). It is the session's
 * summary, said as commit-level, never this line's prompt: no `Prompt #N`,
 * no element of `prompts`, no `fullPrompt`. A seal that cannot be opened
 * leaves the metadata-only answer.
 */
async function showCommitLevelSessionPrompt(repoPath: string, commitSha: string, sessionId: string | undefined): Promise<void> {
  if (!sessionId) return;
  const note = readOriginNote(repoPath, commitSha);
  if (!note || typeof note !== 'object' || note.sessionId !== sessionId) return;
  const sessions = new Set([note.sessionId, ...(Array.isArray(note.sessionIds) ? note.sessionIds : [])]
    .filter((id) => typeof id === 'string' && id && id !== 'unknown'));
  if (sessions.size !== 1) return;
  let opened: Record<string, any> = note;
  try { opened = await withOpenedPrompts(note); } catch { /* no key, no server: metadata only */ }
  const caveat = '(commit-level; not proof for this line)';
  if (typeof opened.promptSummary === 'string' && opened.promptSummary.trim()) {
    console.log(chalk.gray(`  Session prompt ${caveat}: ${opened.promptSummary.replace(/\s+/g, ' ').trim()}`));
  } else if (note.sealed) {
    console.log(chalk.gray(`  Session prompt: sealed in git notes — no key for this user ${caveat}`));
  } else if (note.promptTextWithheld === true) {
    console.log(chalk.gray(`  Session prompt: not stored in git notes ${caveat}`));
  }
  const meta = [
    typeof note.costUsd === 'number' ? `$${note.costUsd.toFixed(2)}` : '',
    typeof note.tokensUsed === 'number' && note.tokensUsed ? `${(note.tokensUsed / 1000).toFixed(1)}k tokens` : '',
    note.promptCount ? `${note.promptCount} turns` : '',
  ].filter(Boolean).join(' · ');
  if (meta) console.log(chalk.gray(`  Session metadata: ${meta}`));
}

async function showFileWhy(roots: ProvenanceRoots, filePath: string): Promise<void> {
  const { relPath, root: repoPath } = resolveQueryTarget(filePath, roots, process.cwd());

  // Get line-level attribution
  const lines = getLineBlame(repoPath, relPath);
  if (lines.length === 0) {
    console.log(chalk.yellow(`\n  No attribution data for ${relPath}\n`));
    return;
  }

  const total = lines.length;
  const aiLines = lines.filter(l => l.authorship === 'ai').length;
  const { lineProvenAiLines, commitConfidenceAiLines } = aiConfidenceSplit(lines);
  const humanLines = lines.filter(l => l.authorship === 'human').length;
  const unknownLines = lines.filter(l => l.authorship === 'unknown').length;
  const aiPct = Math.round((aiLines / total) * 100);
  const humanPct = Math.round((humanLines / total) * 100);
  const unknownPct = Math.round((unknownLines / total) * 100);

  console.log(chalk.bold(`\n  ${relPath}`));
  console.log(chalk.gray(`  ${total} lines — `) +
    chalk.green(`${aiPct}% AI (${aiLines})`) +
    (commitConfidenceAiLines > 0
      ? chalk.gray(` [${lineProvenAiLines} line-proven, ${commitConfidenceAiLines} commit-level attribution — no line-level proof]`)
      : '') +
    chalk.gray(' · ') +
    chalk.white(`${humanPct}% human (${humanLines})`) +
    chalk.gray(' · ') +
    chalk.gray(`${unknownPct}% unknown (${unknownLines})`));
  console.log('');

  // Group by session/agent. Unknown lines belong to no session and no human.
  // A commit-level row is kept apart from a proven one of the same session.
  const sessionMap = new Map<string, { model: string; lines: number; sessionId: string; commitLevel: boolean }>();
  let humanCount = 0;
  for (const line of lines) {
    if (line.authorship === 'human') {
      humanCount++;
      continue;
    }
    if (line.authorship === 'unknown') continue;
    const commitLevel = !isLineProvenAttribution(line);
    const sessionId = line.sessionId || 'unknown';
    const key = `${sessionId}|${commitLevel ? 'commit' : 'line'}`;
    const existing = sessionMap.get(key);
    if (existing) {
      existing.lines++;
    } else {
      sessionMap.set(key, { model: line.model || line.tool || 'AI', lines: 1, sessionId, commitLevel });
    }
  }

  // Sort by line count
  const agents = [...sessionMap.values()].sort((a, b) => b.lines - a.lines);

  for (const a of agents.slice(0, 5)) {
    const pct = Math.round((a.lines / total) * 100);
    console.log(
      chalk.cyan(`  ${a.model.padEnd(20)}`) +
      chalk.green(`${String(a.lines).padStart(4)} lines  ${String(pct).padStart(3)}%`) +
      chalk.gray(`  session ${a.sessionId.slice(0, 8)}`) +
      (a.commitLevel ? chalk.gray('  (commit-level attribution, no line-level proof)') : '')
    );
  }
  if (humanCount > 0) {
    const pct = Math.round((humanCount / total) * 100);
    console.log(
      chalk.white(`  ${'Human'.padEnd(20)}${String(humanCount).padStart(4)} lines  ${String(pct).padStart(3)}%`)
    );
  }
  if (unknownLines > 0) {
    console.log(
      chalk.gray(`  ${'Unknown'.padEnd(20)}${String(unknownLines).padStart(4)} lines  ${String(unknownPct).padStart(3)}%`)
    );
  }

  console.log(chalk.gray(`\n  Tip: ${chalk.cyan(`origin why ${relPath}:42`)} to see which prompt wrote a specific line\n`));
}

// Map the local checkout to its Origin repo id (git remote → fullName, else
// repo basename) so we can call the server /why endpoint.
async function resolveOriginRepoId(repoPath: string): Promise<{ id: string } | null> {
  try {
    const { api } = await import('../api.js');
    const repos = (await api.getRepos()) as any[];
    const remote = gitOrNull(['remote', 'get-url', 'origin'], { cwd: repoPath }) || '';
    const fullName = (remote.match(/[/:]([^/]+\/[^/]+?)(?:\.git)?$/) || [])[1] || '';
    const base = path.basename(repoPath);
    return (
      (fullName && repos.find((r: any) => r.fullName === fullName || r.name === fullName.split('/')[1])) ||
      repos.find((r: any) => r.name === base) ||
      null
    );
  } catch {
    return null;
  }
}

/**
 * Server enrichment of a PROVEN line (OR-46). Only a line-proven `ai` line
 * (`confidence: 'line'`, never `[AI~]`) asks, for the
 * commit that holds its claim; the card is kept only when it names the same
 * session as the canonical record, and its prompt only when the claim names
 * that same prompt (iteration). No other commit is searched: the resolver
 * already found the line's source, so no `git log -L` drift walk looks for a
 * different author. Null means "answer locally".
 */
async function provenServerCard(
  roots: ProvenanceRoots, relPath: string, attr: LineAttribution, lineContent: string, lookup: ServerLookup = tryServerWhy,
): Promise<any | null> {
  if (!isLineProvenAttribution(attr) || !attr.commitSha || !attr.sessionId) return null;
  const card = await lookup(roots, relPath, attr.commitSha, lineContent);
  if (!card?.session || card.session.id !== attr.sessionId) return null;
  const p = card.prompt;
  const promptProven = !!p && attr.iterationIndex !== undefined && p.index === attr.iterationIndex;
  const { drifted: _drifted, ...rest } = card;
  return { ...rest, prompt: promptProven ? p : undefined };
}

/**
 * The commits that touched one line, newest first, at most LINE_HISTORY_MAX:
 * `git log -L` without a shell, started at the line's strict-blame origin
 * (its source revision, path and line) — never at the displayed line number,
 * which a dirty worktree shifts. Empty without an anchor, for an anchor that
 * could not name one line of one commit, and on any git error.
 */
function lineHistory(repoPath: string, anchor: HistoryAnchor | null): string[] {
  if (!anchor || !FULL_SHA.test(anchor.revision) || !isCanonicalRepoPath(anchor.path)
    || !Number.isSafeInteger(anchor.line) || anchor.line < 1) return [];
  const { revision, path: p, line } = anchor;
  const r = runDetailed('git', ['log', `-L${line},${line}:${p}`, '--format=%H', '-s', `--max-count=${LINE_HISTORY_MAX}`, revision], { cwd: repoPath });
  if (r.status !== 0) return [];
  return [...new Set(r.stdout.split('\n').map((l) => l.trim()).filter((l) => FULL_SHA.test(l)))];
}

/**
 * The server card of a committed line WITHOUT line proof. The current blamed
 * commit first: a high-confidence card with a session ends the search. Else
 * the line's bounded history, newest first: an older high card wins; an older
 * weak one is kept only when the current commit had no usable card. A
 * historical card is marked `drifted`. Null: answer locally. Never used for a
 * line-proven line (provenServerCard).
 */
async function commitLevelServerCard(
  roots: ProvenanceRoots, repoPath: string, relPath: string, anchor: HistoryAnchor | null, sha: string, lineContent: string,
  lookup: ServerLookup = tryServerWhy,
): Promise<any | null> {
  const current = await lookup(roots, relPath, sha, lineContent);
  const usable = current?.session ? current : null;
  if (usable?.confidence === 'high') return usable;
  let historical: any = null;
  for (const older of lineHistory(repoPath, anchor)) {
    if (older === sha) continue;
    const card = await lookup(roots, relPath, older, lineContent);
    if (!card?.session) continue;
    if (card.confidence === 'high') return { ...card, drifted: true };
    if (!usable && !historical) historical = { ...card, drifted: true };
  }
  return usable ?? historical;
}

// Ask the server which session + prompt authored this line. Returns null on any
// failure so the caller falls back to the local git-notes path.
async function tryServerWhy(roots: ProvenanceRoots, relPath: string, sha: string, lineContent: string): Promise<any | null> {
  // First by the repo's remote, resolved by the server in the org this user's
  // captures for it go to. The id lookup below lists only the KEY's org: with
  // a key from the personal workspace and the repo assigned in a team org, it
  // found nothing and every squash on main read "no Origin session" (TODO
  // 75f06eff). A server without the endpoint answers 404 and the id lookup
  // runs as before.
  try {
    const { api } = await import('../api.js');
    const remote = gitOrNull(['remote', 'get-url', 'origin'], { cwd: roots.canonicalRoot }) || '';
    const card = await api.getWhyByRemote({ sha, remote, path: roots.canonicalRoot, file: relPath, content: lineContent });
    if (card) return card;
  } catch { /* older server, or not found there — try the key's org */ }
  // Repo IDENTITY is the canonical root's job — `resolveOriginRepoId` falls
  // back to the directory basename, which in a worktree is the worktree's
  // name (`session-reuse-old-agent-f7056f`), matching no repo on the server.
  const repo = await resolveOriginRepoId(roots.canonicalRoot);
  if (!repo) return null;
  try {
    const { api } = await import('../api.js');
    return await api.getWhy(repo.id, { sha, file: relPath, content: lineContent });
  } catch {
    return null;
  }
}

function renderServerCard(card: any, relPath: string, lineNum: number, lineContent: string, opts: { commitLevel?: boolean } = {}): void {
  const s = card.session || {};
  const p = card.prompt;
  const apiUrl = loadConfig()?.apiUrl || 'https://getorigin.io';
  const dateStr = s.startedAt
    ? new Date(s.startedAt).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })
    : '';

  // The caller (showLineWhy) already printed the "Line N in file" + content
  // header before choosing this path — don't repeat it.
  if (opts.commitLevel) {
    // Whatever the server's own confidence, locally this is commit-level.
    console.log(chalk.yellow('  commit-level · server attribution; local line proof unavailable'));
  }
  console.log(
    chalk.white(`  Written by ${chalk.cyan(s.agent || s.model || 'AI')}`) +
      (s.model ? chalk.gray(` · ${s.model}`) : '') +
      (dateStr ? chalk.gray(` · ${dateStr}`) : ''),
  );
  if (p) {
    const label = opts.commitLevel ? `Server prompt #${p.index}` : `Prompt #${p.index}`;
    console.log(chalk.green(`  ${label}: "${(p.text || '').replace(/\s+/g, ' ').trim()}"`));
  }
  const meta = [
    typeof s.costUsd === 'number' ? `$${s.costUsd.toFixed(2)}` : '',
    s.tokensUsed ? `${(s.tokensUsed / 1000).toFixed(1)}k tokens` : '',
    card.confidence ? `confidence: ${card.confidence}` : '',
  ]
    .filter(Boolean)
    .join(' · ');
  if (meta) console.log(chalk.gray(`  ${meta}`));
  console.log(chalk.gray(`  Commit: ${String(card.sha || '').slice(0, 8)} — ${(card.message || '').split('\n')[0]}`));
  if (card.drifted) console.log(chalk.gray('  (line moved since it was written — traced to the introducing commit)'));

  // ── Accountability: markers, review, rework ──────────────────────────
  const mk = card.markers;
  if (mk) {
    for (const d of (mk.decisions || []).slice(0, 2)) console.log(chalk.cyan('  Decision: ') + chalk.gray(d));
    for (const v of (mk.verifies || []).slice(0, 2)) console.log(chalk.yellow('  Verify: ') + chalk.gray(v) + chalk.gray(' — was this checked?'));
    for (const o of (mk.opens || []).slice(0, 1)) console.log(chalk.gray('  Open: ' + o));
  }
  const rv = card.review;
  if (rv) {
    const badge =
      rv.status === 'APPROVED' ? chalk.green('reviewed ✓') :
      rv.status === 'REJECTED' ? chalk.red('rejected ✗') :
      chalk.yellow('review pending');
    const who = rv.isAutoReview ? 'AI review' : 'human';
    const risk = rv.riskLevel ? `, risk: ${rv.riskLevel}` : '';
    console.log('  ' + badge + chalk.gray(` (${who}${risk})`));
  } else {
    console.log('  ' + chalk.yellow('not reviewed'));
  }
  if (typeof card.reworkTouches === 'number' && card.reworkTouches > 1) {
    console.log(chalk.gray(`  re-touched ${card.reworkTouches}× in this session (churn)`));
  }

  console.log('');
  console.log(chalk.blue(`  ${apiUrl}${s.url || '/sessions/' + s.id}`));
  console.log(chalk.gray(`\n  Run ${chalk.cyan(`origin explain ${String(s.id || '').slice(0, 8)}`)} for full details\n`));
}

// ─── Stack-trace ingestion: `origin why --trace [file]` ──────────────────
// Parse a stack trace (stdin or a file) into file:line frames and run the same
// per-line provenance for each frame inside this repo — so a crash points at
// the prompts that authored the failing code path.

function readStdin(): Promise<string> {
  return new Promise((resolve) => {
    if (process.stdin.isTTY) { resolve(''); return; }
    let data = '';
    process.stdin.setEncoding('utf-8');
    process.stdin.on('data', (c) => (data += c));
    process.stdin.on('end', () => resolve(data));
    setTimeout(() => resolve(data), 2000); // don't hang forever if no EOF
  });
}

function parseStackFrames(text: string): Array<{ file: string; line: number }> {
  const frames: Array<{ file: string; line: number }> = [];
  const seen = new Set<string>();
  const add = (file: string, lineStr: string) => {
    const line = parseInt(lineStr, 10);
    if (!file || !Number.isInteger(line) || line < 1) return;
    if (/node_modules|site-packages|\/dist\/|\.min\.js/.test(file)) return; // deps/build noise
    const key = `${file}:${line}`;
    if (seen.has(key)) return;
    seen.add(key);
    frames.push({ file, line });
  };
  const patterns: RegExp[] = [
    /File\s+"([^"]+)",\s+line\s+(\d+)/g,          // Python:  File "x.py", line 47
    /\(([^\s()]+\.[A-Za-z]+):(\d+)\)/g,           // Java/JS: (Foo.java:47) / (file.ts:47)
    /at\s+[^\s(]+\s+\(?([^\s():]+):(\d+)(?::\d+)?\)?/g, // JS: at fn (file.ts:47:9)
    /([^\s():"']+\.[A-Za-z]+):(\d+)/g,            // generic: path/file.ext:47
  ];
  for (const re of patterns) {
    let m: RegExpExecArray | null;
    while ((m = re.exec(text)) !== null) add(m[1], m[2]);
  }
  return frames;
}

// Map a trace frame's path (absolute / relative / module-ish) to a repo file.
function resolveFrameFile(framePath: string, repoPath: string, repoFiles: string[]): string | null {
  const norm = framePath.replace(/^\.\//, '');
  // Exact repo-relative or suffix match against tracked files.
  const hit = repoFiles.find((f) => f === norm || norm.endsWith('/' + f) || f.endsWith('/' + norm));
  if (hit) return hit;
  // Fall back to basename (last resort; ambiguous if the name repeats).
  const base = path.basename(norm);
  const byBase = repoFiles.filter((f) => path.basename(f) === base);
  return byBase.length === 1 ? byBase[0] : null;
}

// Resolve the PR/MR number to comment on. Explicit --pr-comment <n> wins; then
// common CI env vars; then GitHub Actions' refs/pull/<n>/merge. Returns null if
// none are present — the CLI still prints the trace, just can't post it.
function resolvePrNumber(prCommentArg: string | boolean | undefined): number | null {
  if (typeof prCommentArg === 'string' && /^\d+$/.test(prCommentArg.trim())) return parseInt(prCommentArg, 10);
  const env = process.env;
  for (const v of [env.ORIGIN_PR_NUMBER, env.PR_NUMBER, env.CHANGE_ID /* Jenkins */, env.CI_MERGE_REQUEST_IID /* GitLab */]) {
    if (v && /^\d+$/.test(v.trim())) return parseInt(v, 10);
  }
  const ref = env.GITHUB_REF || '';                 // refs/pull/123/merge
  const m = ref.match(/refs\/pull\/(\d+)\//);
  if (m) return parseInt(m[1], 10);
  return null;
}

async function whyTraceCommand(
  traceArg: string | boolean,
  roots: ProvenanceRoots,
  opts?: { prComment?: string | boolean; json?: boolean },
): Promise<void> {
  // Frames name files in the tree that ran, and that is the worktree.
  const repoPath = roots.workRoot;
  const { readFileSync, existsSync } = await import('fs');
  let text = '';
  if (typeof traceArg === 'string' && traceArg && existsSync(traceArg)) text = readFileSync(traceArg, 'utf-8');
  else text = await readStdin();
  if (!text.trim()) {
    console.error(chalk.red('No stack trace provided. Pipe one in:  ') + chalk.gray('cat error.log | origin why --trace'));
    process.exitCode = 1;
    return;
  }
  if (!isConnectedMode()) {
    console.error(chalk.red('Trace resolution needs a connected Origin account.'));
    process.exitCode = 1;
    return;
  }
  const frames = parseStackFrames(text);
  let repoFiles: string[] = [];
  try { repoFiles = git(['ls-files'], { cwd: repoPath }).split('\n').filter(Boolean); } catch { /* ignore */ }

  // Resolve the repo once so both the per-frame cards and the PR-comment POST
  // share it. (tryServerWhy resolves it too, but we need the id here anyway.)
  const repo = await resolveOriginRepoId(roots.canonicalRoot);

  // Every frame goes through the same gates as `origin why <file>:<line>`: a
  // proven line asks only for its own commit and keeps only a card of its own
  // session ([AI]); any other committed line takes the bounded commit-level
  // lookup from its strict-blame anchor ([AI~]: server attribution, no local
  // line proof). An uncommitted frame is never sent.
  const resolutions = new Map<string, LineAttributionResolution | null>();
  const results: Array<{ file: string; line: number; content: string; sha: string; card: any; tier: 'line' | 'commit' }> = [];
  // One budget of server lookups for the whole trace, proven, direct and
  // history alike. Past it nothing more is asked: frames already answered
  // keep their results, and no answer is made up for the rest.
  let serverLookups = 0;
  let serverLookupLimitReached = false;
  const lookup: ServerLookup = async (r, relPath, sha, lineContent) => {
    if (serverLookups >= TRACE_SERVER_LOOKUPS_MAX) { serverLookupLimitReached = true; return null; }
    serverLookups++;
    return tryServerWhy(r, relPath, sha, lineContent);
  };
  for (const fr of frames) {
    const rel = resolveFrameFile(fr.file, repoPath, repoFiles);
    if (!rel) continue;
    if (!resolutions.has(rel)) resolutions.set(rel, resolveLineAttribution(repoPath, rel));
    const resolution = resolutions.get(rel);
    const attr = resolution?.lines[fr.line - 1];
    if (!resolution || !attr || !attr.commitSha) continue;
    const content = (linesOf(resolution.text)[fr.line - 1] ?? '').trim();
    if (isLineProvenAttribution(attr)) {
      const card = await provenServerCard(roots, rel, attr, content, lookup);
      if (card) results.push({ file: rel, line: fr.line, content, sha: attr.commitSha, card, tier: 'line' });
    } else {
      const anchor = resolution.historyAnchors[fr.line - 1] ?? null;
      const card = await commitLevelServerCard(roots, repoPath, rel, anchor, attr.commitSha, content, lookup);
      if (card) results.push({ file: rel, line: fr.line, content, sha: attr.commitSha, card, tier: 'commit' });
    }
  }

  const apiUrl = loadConfig()?.apiUrl || 'https://getorigin.io';

  // Machine-readable output for a CI/agent fix-forward step: pipe this into an
  // agent alongside the failing trace so it fixes with the authoring prompt +
  // the [Origin: Verify] checklist in hand.
  if (opts?.json) {
    console.log(JSON.stringify({
      frames: frames.length,
      attributed: results.length,
      serverLookups,
      serverLookupLimitReached,
      results: results.map((r) => ({
        file: r.file, line: r.line, sha: r.sha, content: r.content,
        session: { id: r.card.session?.id, agent: r.card.session?.agent, model: r.card.session?.model, url: `${apiUrl}${r.card.session?.url || '/sessions/' + r.card.session?.id}` },
        prompt: r.card.prompt || null,
        // The server's own confidence in its card; the local tier is apart:
        // `line` is canonical line proof, `commit` is server attribution only.
        confidence: r.card.confidence,
        attributionConfidence: r.tier,
        drifted: r.card.drifted === true,
        verify: r.card.markers?.verifies || [],
      })),
    }, null, 2));
    // Still honor --pr-comment below when both are set.
  }

  if (!opts?.json) {
    console.log(chalk.bold(`\n  Origin Why · stack trace`) + chalk.gray(`  (${frames.length} frames, ${results.length} attributed in this repo)`));
    if (serverLookupLimitReached) {
      console.log(chalk.yellow(`  Server lookup limit reached (${TRACE_SERVER_LOOKUPS_MAX}): later frames were not queried.`));
    }
  }
  if (results.length === 0) {
    if (!opts?.json) console.log(chalk.gray('\n  No frames mapped to AI-authored code in this repo.\n'));
    return;
  }
  if (!opts?.json) {
    for (const r of results) {
      const s = r.card.session || {};
      const p = r.card.prompt;
      console.log('');
      const tag = r.tier === 'line' ? chalk.green('[AI] ') : chalk.greenBright('[AI~]');
      console.log('  ' + tag + ' ' + chalk.white(`${r.file}:${r.line}`) + (r.content ? chalk.gray(`  ${r.content.slice(0, 60)}`) : ''));
      if (r.tier === 'commit') console.log('    ' + chalk.yellow('commit-level · server attribution; local line proof unavailable'));
      if (r.card.drifted) console.log('    ' + chalk.gray('(line moved since it was written — traced to the introducing commit)'));
      console.log('    ' + chalk.cyan(s.agent || s.model || 'AI') + (p ? chalk.gray(` · prompt #${p.index} `) + chalk.green(`"${(p.text || '').replace(/\s+/g, ' ').trim().slice(0, 60)}"`) : ''));
      const vs = r.card.markers?.verifies || [];
      if (vs.length) console.log('    ' + chalk.yellow('Verify: ') + chalk.gray(vs[0]) + chalk.gray(' — checked?'));
      console.log('    ' + chalk.blue(`${apiUrl}${s.url || '/sessions/' + s.id}`));
    }
    console.log('');
  }

  // ── CI auto-link: post the provenance back to the PR/MR ────────────────
  if (opts?.prComment) {
    const prNumber = resolvePrNumber(opts.prComment);
    if (!repo) {
      console.error(chalk.yellow('  --pr-comment: this checkout isn\'t linked to an Origin repo; skipping.'));
      return;
    }
    if (!prNumber) {
      console.error(chalk.yellow('  --pr-comment: no PR number found. Pass ') + chalk.cyan('--pr-comment <number>') + chalk.yellow(' or set ORIGIN_PR_NUMBER.'));
      process.exitCode = 1;
      return;
    }
    try {
      const { api } = await import('../api.js');
      const resp: any = await api.postWhyPrComment(repo.id, {
        prNumber,
        frames: results.map((r) => ({ file: r.file, line: r.line, sha: r.sha, content: r.content })),
      });
      if (resp?.posted) {
        console.log('  ' + chalk.green(`✓ Posted provenance for ${resp.resolved} line(s) to PR #${prNumber}.`));
      } else {
        console.error('  ' + chalk.yellow(`Could not post to PR #${prNumber}: ${resp?.error || resp?.reason || 'unknown'}`));
      }
    } catch (e: any) {
      console.error('  ' + chalk.red(`--pr-comment failed: ${e?.message || e}`));
    }
  }
}

export async function whyCommand(input: string, opts?: { trace?: string | boolean; prComment?: string | boolean; json?: boolean }) {
  const roots = provenanceRoots(process.cwd(), { gitRoot: getGitRoot, workingGitRoot: getWorkingGitRoot });
  if (opts?.trace || opts?.prComment) {
    if (!roots) { console.log(chalk.red('Not inside a git repository.')); process.exit(1); }
    await whyTraceCommand(opts.trace ?? true, roots, { prComment: opts.prComment, json: opts.json });
    return;
  }
  if (!input) {
    console.error(chalk.red('Usage: ') + 'origin why <file>:<line>   ' + chalk.gray('or  origin why --trace < error.log'));
    process.exitCode = 1;
    return;
  }
  const { file, line } = parseFileAndLine(input);

  if (!roots) {
    console.log(chalk.red('Not inside a git repository.'));
    process.exit(1);
  }

  if (line) {
    await showLineWhy(roots, file, line);
  } else {
    await showFileWhy(roots, file);
  }
}
