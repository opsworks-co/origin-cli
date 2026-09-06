// `origin verify-capture` — check stored captures for self-contradiction.
//
// Reads the LOCAL state files, never the API. `/api/sessions/:id` synthesises
// `sessionDiff` and narrows `filesChanged` per row before serving them, so a
// verifier pointed at it would grade the read path rather than the capture —
// and would report a row as healthy that is stored broken. The state file is
// what the CLI actually sent, so it is the honest subject.
//
// Exists to answer a question nobody could answer before: how much of what
// Origin captured is wrong? Every capture defect found so far was found by a
// human looking at a dashboard. This makes the defect rate a number, and
// `--fail-on-contradiction` makes it a gate.
import chalk from 'chalk';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { getGitCommonDir, getGitDir } from '../session-state.js';
import {
  verifySession,
  summarize,
  isFileSetRecord,
  type CaptureViolation,
  type VerifiableTurn,
} from '../capture-verify.js';

interface StoredSession {
  sessionId: string;
  agentSlug?: string;
  repoPath?: string;
  startedAt?: string;
  status?: string;
  /** Rows that are turn captures — the only ones there is anything to check. */
  turns: VerifiableTurn[];
  /** Rows skipped as file-set accumulators (see capture-verify.ts). */
  fileSetRecords: number;
  source: string;
}

/**
 * Every session state file this machine can see, ENDED ones included.
 *
 * Deliberately not `listActiveSessions`: that drops anything marked ENDED,
 * which is precisely the population worth verifying — a finished session is the
 * one whose capture is final and whose rows are already on the dashboard.
 */
function collectSessions(cwd?: string): StoredSession[] {
  const out: StoredSession[] = [];
  const seen = new Set<string>();

  const take = (file: string) => {
    if (seen.has(file)) return;
    seen.add(file);
    let raw: unknown;
    try { raw = JSON.parse(fs.readFileSync(file, 'utf-8')); } catch { return; }
    const d = raw as Record<string, unknown>;
    if (!d || typeof d !== 'object' || typeof d.sessionId !== 'string') return;
    const rows = Array.isArray(d.completedPromptMappings)
      ? (d.completedPromptMappings as VerifiableTurn[])
      : [];
    // A file-set record is a producer's accumulator, not a capture. Held apart
    // here rather than dropped, so a session made entirely of them is reported
    // as unverifiable instead of vanishing into a smaller denominator.
    const turns = rows.filter((t) => !isFileSetRecord(t));
    if (rows.length === 0) return; // nothing captured — nothing to contradict
    out.push({
      sessionId: d.sessionId,
      agentSlug: typeof d.agentSlug === 'string' ? d.agentSlug : undefined,
      repoPath: typeof d.repoPath === 'string' ? d.repoPath : undefined,
      startedAt: typeof d.startedAt === 'string' ? d.startedAt : undefined,
      status: typeof d.status === 'string' ? d.status : undefined,
      turns,
      fileSetRecords: rows.length - turns.length,
      source: file,
    });
  };

  const dirs = [path.join(os.homedir(), '.origin', 'sessions')];
  const gitDir = getGitCommonDir(cwd) || getGitDir(cwd);
  if (gitDir) dirs.push(path.isAbsolute(gitDir) ? gitDir : path.resolve(cwd || process.cwd(), gitDir));

  for (const dir of dirs) {
    let entries: string[] = [];
    try { entries = fs.readdirSync(dir); } catch { continue; }
    for (const e of entries) {
      if (!e.endsWith('.json')) continue;
      if (dir.endsWith(path.join('.origin', 'sessions')) || e.startsWith('origin-session')) {
        take(path.join(dir, e));
      }
    }
  }
  return dedupeSessions(out);
}

/**
 * One row per session, whichever copy of its state file says the most.
 *
 * The hook path writes a session's state twice: `.git/origin-session-<tag>.json`
 * in the repo and a mirror under `~/.origin/sessions/`. Both were verified,
 * so every such session counted twice — 15 of 54 in one run — and the
 * percentages this command prints were computed over a doubled population.
 * The two copies can also disagree (one written by Stop, the other by an
 * earlier hook); the copy with more turns is the later one, and on a tie the
 * repo's own file wins over the mirror.
 */
export function dedupeSessions<T extends { sessionId: string; turns: unknown[]; source: string }>(sessions: T[]): T[] {
  const byId = new Map<string, T>();
  for (const s of sessions) {
    const prev = byId.get(s.sessionId);
    if (!prev) { byId.set(s.sessionId, s); continue; }
    // Separator-agnostic: the source is whatever the collector joined, and on
    // Windows that is backslashes, while a caller (or a test) may hand in
    // forward slashes. `path.join` here compared one spelling to the other.
    const isMirror = (p: string) => p.replace(/\\/g, '/').includes('/.origin/sessions/');
    const prevIsRepo = !isMirror(prev.source);
    const curIsRepo = !isMirror(s.source);
    if (s.turns.length > prev.turns.length || (s.turns.length === prev.turns.length && curIsRepo && !prevIsRepo)) {
      byId.set(s.sessionId, s);
    }
  }
  return [...byId.values()];
}

export interface VerifyCaptureOptions {
  json?: boolean;
  session?: string;
  agent?: string;
  all?: boolean;
  failOnContradiction?: boolean;
}

export async function verifyCaptureCommand(opts: VerifyCaptureOptions = {}): Promise<void> {
  let sessions = collectSessions();
  if (opts.session) sessions = sessions.filter((s) => s.sessionId.startsWith(opts.session as string));
  if (opts.agent) sessions = sessions.filter((s) => s.agentSlug === opts.agent);

  // Sessions whose state file holds file-set records ONLY. They are not clean
  // and not dirty — there is no turn capture here to check. Counting them as
  // clean would flatter the rate; counting them as sessions with zero turns
  // would leave a 0-turn row on the report that reads like a bug.
  const unverifiable = sessions.filter((s) => s.turns.length === 0);
  sessions = sessions.filter((s) => s.turns.length > 0);

  if (sessions.length === 0 && unverifiable.length === 0) {
    if (opts.json) { process.stdout.write(JSON.stringify({ sessions: [], totals: null }, null, 2) + '\n'); return; }
    console.log(chalk.dim('No stored captures found to verify.'));
    return;
  }

  const results = sessions.map((s) => {
    const violations = verifySession(s.turns);
    return { session: s, violations, summary: summarize(s.turns, violations) };
  }).sort((a, b) => b.summary.contradictions - a.summary.contradictions);

  const totalTurns = results.reduce((n, r) => n + r.summary.turns, 0);
  const dirtySessions = results.filter((r) => r.summary.contradictions > 0);
  const byCode: Record<string, number> = {};
  const dirtyTurnKeys = new Set<string>();
  for (const r of results) {
    for (const v of r.violations) {
      byCode[v.code] = (byCode[v.code] || 0) + 1;
      if (v.severity === 'contradiction') dirtyTurnKeys.add(`${r.session.sessionId}#${v.promptIndex}`);
    }
  }

  if (opts.json) {
    process.stdout.write(JSON.stringify({
      totals: {
        sessions: results.length,
        turns: totalTurns,
        turnsWithContradiction: dirtyTurnKeys.size,
        sessionsWithContradiction: dirtySessions.length,
        unverifiableSessions: unverifiable.length,
        fileSetRecords: [...sessions, ...unverifiable].reduce((n, s) => n + s.fileSetRecords, 0),
        byCode,
      },
      sessions: results
        .filter((r) => opts.all || r.violations.length > 0)
        .map((r) => ({
          sessionId: r.session.sessionId,
          agent: r.session.agentSlug ?? null,
          repoPath: r.session.repoPath ?? null,
          startedAt: r.session.startedAt ?? null,
          turns: r.summary.turns,
          contradictions: r.summary.contradictions,
          suspects: r.summary.suspects,
          violations: r.violations,
        })),
    }, null, 2) + '\n');
    if (opts.failOnContradiction && dirtyTurnKeys.size > 0) process.exitCode = 1;
    return;
  }

  const pct = (n: number, d: number) => (d === 0 ? '0%' : `${Math.round((100 * n) / d)}%`);

  console.log('');
  console.log(chalk.bold('Capture self-consistency'));
  console.log(chalk.dim('  A violation means one stored row disagrees with itself.'));
  console.log('');
  console.log(`  sessions checked          ${results.length}`);
  console.log(`  turns checked             ${totalTurns}`);
  console.log(`  turns w/ contradiction    ${dirtyTurnKeys.size}  ${chalk.dim(`(${pct(dirtyTurnKeys.size, totalTurns)})`)}`);
  console.log(`  sessions w/ contradiction ${dirtySessions.length}  ${chalk.dim(`(${pct(dirtySessions.length, results.length)})`)}`);
  if (unverifiable.length > 0) {
    console.log(`  not verifiable            ${unverifiable.length}  ${chalk.dim('(file-set records only — no turn capture stored locally)')}`);
  }

  if (Object.keys(byCode).length > 0) {
    console.log('');
    for (const [code, n] of Object.entries(byCode).sort((a, b) => b[1] - a[1])) {
      const isContradiction = results.some((r) =>
        r.violations.some((v) => v.code === code && v.severity === 'contradiction'));
      const label = isContradiction ? chalk.red(code) : chalk.yellow(code);
      console.log(`  ${label.padEnd(42)} ${String(n).padStart(4)}`);
    }
  }

  const shown = results.filter((r) => opts.all || r.violations.length > 0);
  if (shown.length > 0) {
    console.log('');
    console.log(chalk.bold('  Sessions'));
    for (const r of shown) {
      const id = r.session.sessionId.slice(0, 8);
      const agent = r.session.agentSlug ? chalk.dim(` ${r.session.agentSlug}`) : '';
      const head = r.summary.contradictions > 0
        ? chalk.red(`${r.summary.contradictions} contradiction(s)`)
        : chalk.green('clean');
      const susp = r.summary.suspects > 0 ? chalk.dim(` +${r.summary.suspects} suspect`) : '';
      console.log(`\n  ${chalk.bold(id)}${agent}  ${r.summary.turns} turns  ${head}${susp}`);
      const groups = new Map<number, CaptureViolation[]>();
      for (const v of r.violations) groups.set(v.promptIndex, [...(groups.get(v.promptIndex) || []), v]);
      for (const [idx, vs] of [...groups.entries()].sort((a, b) => a[0] - b[0])) {
        for (const v of vs) {
          const mark = v.severity === 'contradiction' ? chalk.red('✗') : chalk.yellow('~');
          console.log(`    ${mark} turn ${String(idx).padEnd(3)} ${v.code}`);
          console.log(`        ${chalk.dim(v.detail)}`);
          if (v.files?.length) console.log(`        ${chalk.dim(v.files.join(', '))}`);
        }
      }
    }
  }

  console.log('');
  if (dirtyTurnKeys.size === 0) {
    console.log(chalk.green('  No contradictions found.'));
  } else {
    console.log(chalk.dim('  A contradiction is a defect in the capture, not in the agent\'s work.'));
    console.log(chalk.dim('  Re-run with --json for the full record.'));
  }
  console.log('');

  if (opts.failOnContradiction && dirtyTurnKeys.size > 0) process.exitCode = 1;
}
