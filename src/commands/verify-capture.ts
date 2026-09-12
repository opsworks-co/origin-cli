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
import { getGitCommonDir, getGitDir, isSessionAlive, type SessionState } from '../session-state.js';
import {
  verifySession,
  summarize,
  isFileSetRecord,
  isMidTurnHeader,
  SESSION_LEVEL_INDEX,
  type CaptureViolation,
  type VerifiableHeader,
  type VerifiableTurn,
} from '../capture-verify.js';

interface StoredSession {
  sessionId: string;
  agentSlug?: string;
  repoPath?: string;
  startedAt?: string;
  status?: string;
  /**
   * The session header the CLI keeps — its own file list and line totals.
   * Checked against the turns (verifyHeader): a header claiming more than
   * every turn together is work no turn saw, which is what every foreign-
   * commit and merge leak looks like from here.
   *
   * Carries the two session-level facts that say whether it can be compared
   * with the turns at all: a turn still open means Stop has not appended its
   * row yet, so the comparison is unknown (see `isMidTurnHeader`).
   */
  header: VerifiableHeader | null;
  /** Rows that are turn captures — the only ones there is anything to check. */
  turns: VerifiableTurn[];
  /** Rows skipped as file-set accumulators (see capture-verify.ts). */
  fileSetRecords: number;
  /**
   * The session is still alive, so NONE of its rows are final — a committing
   * turn's content arrives from post-commit, and session-end heals what is
   * still missing. Graded and reported exactly as before; simply not allowed to
   * decide `--fail-on-contradiction`. See the gating note in the command below.
   */
  alive: boolean;
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
    const hasHeader = Array.isArray(d.filesChanged)
      || Number.isFinite(d.linesAdded as number)
      || Number.isFinite(d.linesRemoved as number);
    // `closeTurn` sets activeTurn to null at Stop, so an object here means a
    // turn is genuinely mid-flight and one more row is still to come.
    const active = d.activeTurn as { index?: unknown } | null | undefined;
    const openTurnIndex = active && Number.isInteger(active.index as number)
      ? (active.index as number)
      : null;
    // isSessionAlive, not `status === 'ENDED'`: a killed agent never runs
    // session-end, so it leaves the row RUNNING with its turn open for good.
    // Read literally, that is a header exempted from the only check it has,
    // permanently. Alive means the state file or the heartbeat moved inside
    // the same 3-hour window every other liveness rung uses — and the session
    // this exemption exists for has just had post-commit WRITE that file, so
    // the check it needs to pass is the one it cannot fail.
    const noMoreTurns = !isSessionAlive(d as unknown as SessionState, file);
    out.push({
      sessionId: d.sessionId,
      agentSlug: typeof d.agentSlug === 'string' ? d.agentSlug : undefined,
      repoPath: typeof d.repoPath === 'string' ? d.repoPath : undefined,
      startedAt: typeof d.startedAt === 'string' ? d.startedAt : undefined,
      status: typeof d.status === 'string' ? d.status : undefined,
      header: hasHeader
        ? {
            filesChanged: Array.isArray(d.filesChanged) ? (d.filesChanged as string[]) : null,
            linesAdded: Number.isFinite(d.linesAdded as number) ? (d.linesAdded as number) : null,
            linesRemoved: Number.isFinite(d.linesRemoved as number) ? (d.linesRemoved as number) : null,
            openTurnIndex,
            noMoreTurns,
          }
        : null,
      turns,
      fileSetRecords: rows.length - turns.length,
      alive: !noMoreTurns,
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

/** One contradiction, flattened for the waiver record. */
export interface WaivedFinding {
  sessionId: string;
  agent?: string | null;
  /** SESSION_LEVEL_INDEX for a header finding. */
  promptIndex: number;
  code: string;
  detail: string;
}

/**
 * The record a release leaves behind when it ships with contradictions unread.
 *
 * `scripts/release-cli.sh --allow-contradictions` used to print one line of
 * stderr and then tag exactly as a clean release does, so a release that waived
 * findings was indistinguishable from one that had none — the flag's whole
 * effect vanished the moment the terminal scrolled. That is the shape of an
 * override nobody can audit afterwards, and it is worse than the false positive
 * it was reached for.
 *
 * Rendered as plain text with no colour: it goes to a terminal, into the
 * annotated tag's message, and into a CI log, and an escape code in a tag
 * message is noise forever.
 *
 * ITEMISED on purpose. A count ("3 contradictions waived") is a number someone
 * can wave through; a list naming each session, turn and rule is a thing they
 * have to look at. The flag's own help says "if you have read them" — this is
 * what makes that claim checkable.
 */
export function renderWaiverBlock(findings: WaivedFinding[], since?: string): string {
  if (findings.length === 0) return '';
  const sessions = new Set(findings.map((f) => f.sessionId));
  const where = (f: WaivedFinding) => (f.promptIndex === SESSION_LEVEL_INDEX ? 'header' : `turn ${f.promptIndex}`);
  // Columns, not a ragged list: the point is that someone can scan it and see
  // which sessions and which rules, without reading every line end to end.
  const agentOf = (f: WaivedFinding) => f.agent || '';
  const agentWidth = Math.max(...findings.map((f) => agentOf(f).length));
  const width = Math.max(...findings.map((f) => where(f).length));
  const lines = [
    `RELEASED WITH ${findings.length} UNREAD CAPTURE CONTRADICTION(S) in ${sessions.size} session(s).`,
    '',
    'The pre-release gate found these and they were WAIVED, not fixed',
    `(--allow-contradictions${since ? `, sessions since ${since}` : ''}):`,
    '',
  ];
  for (const f of findings) {
    const agent = agentWidth > 0 ? ` ${agentOf(f).padEnd(agentWidth)}` : '';
    lines.push(`  ${f.sessionId.slice(0, 8)}${agent}  ${where(f).padEnd(width)}  ${f.code}`);
    if (f.detail) lines.push(`      ${f.detail}`);
  }
  lines.push('');
  lines.push('These sessions were captured by the PREVIOUS build, not this one —');
  lines.push('the honest limit of a pre-release check. They remain unexplained.');
  return lines.join('\n');
}

/** Every contradiction in a verify-capture result, flattened in report order. */
export function waivedFindings(
  results: Array<{ session: { sessionId: string; agentSlug?: string }; violations: CaptureViolation[] }>,
): WaivedFinding[] {
  const out: WaivedFinding[] = [];
  for (const r of results) {
    for (const v of r.violations) {
      if (v.severity !== 'contradiction') continue;
      out.push({
        sessionId: r.session.sessionId,
        agent: r.session.agentSlug ?? null,
        promptIndex: v.promptIndex,
        code: v.code,
        detail: v.detail,
      });
    }
  }
  return out;
}

export interface VerifyCaptureOptions {
  json?: boolean;
  session?: string;
  agent?: string;
  all?: boolean;
  failOnContradiction?: boolean;
  /**
   * Fail when the selected population cannot produce a final verdict: an
   * active session may still rewrite its rows, and a file-set-only/empty
   * session has no turn evidence to inspect. Intended for the release gate;
   * ordinary diagnostic runs still report these states without blocking work.
   */
  failOnIncompleteEvidence?: boolean;
  /**
   * Print the waiver record instead of the report — what a release that ships
   * these findings unread should carry with it. Nothing else is printed, so the
   * release script can put it straight into a tag message.
   */
  waiver?: boolean;
  /** Only sessions started at or after this point: an ISO date, or `<N>d`. */
  since?: string;
}

/**
 * `--since` accepts an ISO timestamp or a relative `<N>d`. Returns the cut-off
 * in ms, or null for an unparseable value (reported by the caller).
 */
export function parseSince(value: string | undefined, now: number = Date.now()): number | null {
  if (!value) return null;
  const rel = value.trim().match(/^(\d+)d$/i);
  if (rel) return now - Number(rel[1]) * 24 * 60 * 60 * 1000;
  const abs = Date.parse(value);
  return Number.isFinite(abs) ? abs : null;
}

export async function verifyCaptureCommand(opts: VerifyCaptureOptions = {}): Promise<void> {
  let sessions = collectSessions();
  if (opts.session) sessions = sessions.filter((s) => s.sessionId.startsWith(opts.session as string));
  if (opts.agent) sessions = sessions.filter((s) => s.agentSlug === opts.agent);
  if (opts.since) {
    const cutoff = parseSince(opts.since);
    if (cutoff === null) {
      console.error(`--since: cannot read "${opts.since}" — use an ISO date or <N>d (e.g. 7d)`);
      process.exitCode = 2;
      return;
    }
    // Two ways into the window, because a session is the wrong unit.
    //
    // Windowing on `startedAt` alone is what made the gate vacuous: with tags
    // cut minutes apart, almost nothing STARTS inside the window, and two
    // consecutive releases on 2026-09-10 graded ZERO sessions while 25
    // contradictory turns sat on the machine. But a session cannot simply be
    // kept for being ACTIVE either — a stored row is final, so a long session
    // would drag its old contradictions into every future release and wedge
    // the gate permanently (the deadlock waived at cli-v0.20260910.630).
    //
    // So: a session that STARTED in the window is graded whole, exactly as
    // before. A session that started earlier is graded on the TURNS it
    // captured inside the window, and on nothing else.
    sessions = sessions.map((s) => {
      if (!s.startedAt || Date.parse(s.startedAt) >= cutoff) return s;
      const fresh = s.turns.filter((t) => {
        const at = t.capturedAt ? Date.parse(t.capturedAt) : NaN;
        return Number.isFinite(at) && at >= cutoff;
      });
      // A currently active session with no finalized row in this window is
      // evidence that is still being produced, not evidence that passed. Keep
      // it so the strict release gate can fail closed instead of reporting an
      // empty sample while an agent is mid-turn.
      if (fresh.length === 0) return s.alive ? { ...s, turns: [], header: null } : null;
      // The header is a whole-session total; comparing it against a SUBSET of
      // the turns would report a difference that is arithmetic, not a defect.
      // Grade the fresh turns and leave the header to the release that owns
      // the session's start.
      return { ...s, turns: fresh, header: null };
    }).filter((s): s is StoredSession => s !== null);
  }

  // Sessions whose state file holds file-set records ONLY. They are not clean
  // and not dirty — there is no turn capture here to check. Counting them as
  // clean would flatter the rate; counting them as sessions with zero turns
  // would leave a 0-turn row on the report that reads like a bug.
  const unverifiable = sessions.filter((s) => s.turns.length === 0);
  sessions = sessions.filter((s) => s.turns.length > 0);

  if (sessions.length === 0 && unverifiable.length === 0) {
    if (opts.json) { process.stdout.write(JSON.stringify({ sessions: [], totals: null }, null, 2) + '\n'); }
    else console.log(chalk.dim('No stored captures found to verify.'));
    if (opts.failOnIncompleteEvidence) process.exitCode = 2;
    return;
  }

  const results = sessions.map((s) => {
    const violations = verifySession(s.turns, s.header);
    return { session: s, violations, summary: summarize(s.turns, violations) };
  }).sort((a, b) => b.summary.contradictions - a.summary.contradictions);

  const totalTurns = results.reduce((n, r) => n + r.summary.turns, 0);
  // A row of a live session is provisional even when it currently looks
  // consistent: Stop/session-end can still replace its diff and totals. A
  // file-set-only (or zero-row) state is also not a verdict. These do not make
  // ordinary diagnostics fail, but a release cannot call either one evidence.
  const mutableSessions = [...results.map((r) => r.session), ...unverifiable]
    .filter((s) => s.alive);
  const incompleteEvidenceSessions = [
    ...mutableSessions,
    ...unverifiable.filter((s) => !s.alive),
  ];
  // The hole this closes is a window that grades NOTHING — a release cut
  // minutes after another one, where every session in range is still running
  // or carries no turn capture, reported as a clean empty sample (#1524's
  // "the gate can grade ZERO sessions").
  //
  // It is NOT "a live session exists". On a shared machine that is the normal
  // state — this repo had 19 mutable sessions and 4 live ones while the fix
  // was being written — and release-cli.sh treats exit 2 as unwaivable, ahead
  // of --allow-contradictions. Gating on presence would make every release on
  // a busy machine impossible AND unwaivable, which is precisely the
  // unsatisfiable gate #1557 was written to remove.
  //
  // So: incomplete means no FINAL session produced a verdict, while something
  // unjudgeable sat in the window. A real graded sample beside a live sibling
  // is evidence, and its contradictions gate through the ordinary exit 1.
  const finalGradedSessions = results.filter((r) => !r.session.alive);
  const evidenceIncomplete = finalGradedSessions.length === 0
    && incompleteEvidenceSessions.length > 0;
  const dirtySessions = results.filter((r) => r.summary.contradictions > 0);
  const byCode: Record<string, number> = {};
  const dirtyTurnKeys = new Set<string>();
  // Sessions whose HEADER disagrees with their turns — counted apart from the
  // per-turn rate, because it is a different producer that is wrong.
  const headerDirtySessions = new Set<string>();
  // Contradictions that may GATE a release: those of a session whose capture is
  // FINAL. A live session's findings are still counted and printed — see
  // liveSessions below — they just do not decide the exit code.
  //
  // This COMPLETES #1516 rather than reversing it. That fix exempted the header
  // of a session with a turn still OPEN, on the grounds that Stop has not
  // written the row yet so the comparison is unknown. The case it missed is one
  // level along: post-commit sets the header totals the instant `git commit`
  // runs, while the row's CONTENT arrives afterwards — so between those two
  // moments a live session's header legitimately exceeds its turns with nothing
  // wrong. Measured on the live codex session that blocked
  // cli-v0.20260911.2209: header +221/-9 against turns +180/-14, plus one header
  // file no turn had yet, with `activeTurn: null` — closed turn, so #1516's rule
  // did not apply and the gate failed on a session that was simply mid-flight.
  //
  // Liveness decides, never the status string: an ENDED session, and a ZOMBIE
  // left RUNNING by a killed agent, are both final and both still graded.
  const gatingTurnKeys = new Set<string>();
  const gatingHeaderSessions = new Set<string>();
  for (const r of results) {
    for (const v of r.violations) {
      byCode[v.code] = (byCode[v.code] || 0) + 1;
      if (v.severity !== 'contradiction') continue;
      const header = v.promptIndex === SESSION_LEVEL_INDEX;
      if (header) headerDirtySessions.add(r.session.sessionId);
      else dirtyTurnKeys.add(`${r.session.sessionId}#${v.promptIndex}`);
      if (r.session.alive) continue;
      if (header) gatingHeaderSessions.add(r.session.sessionId);
      else gatingTurnKeys.add(`${r.session.sessionId}#${v.promptIndex}`);
    }
  }
  /**
   * A LIVE session cannot fail the gate, because none of its rows are final.
   *
   * #1516 established this for headers (`isMidTurnHeader`): a turn still open
   * means Stop has not written its row, so the comparison is unknown. The same
   * is true one level down, and #1533's per-turn window made it bite — a
   * committing turn's content arrives from post-commit, and session-end heals
   * what is still missing, so a row read mid-session is a snapshot, not a
   * verdict.
   *
   * Measured 2026-09-11 while releasing cli-v0.20260911.2209 on a machine with
   * two sibling agents working: the gate blocked on a RUNNING codex session
   * (`files_without_content` on three committing turns — `packages/cli/package.json`
   * with no diff yet) and a RUNNING claude-code session (17 claimed files absent
   * from its diff). Waiting made it WORSE, 2 contradictions then 4, because both
   * sessions kept committing. On a shared machine that is the normal state, so
   * the gate was unsatisfiable by waiting and the only ways past it were a
   * release that skipped it entirely (`--allow-contradictions`, which is
   * all-or-nothing and would have hidden every OTHER session's findings too) or
   * not shipping.
   *
   * Deliberately NOT done by dropping live sessions from the report: the
   * findings are real diagnostic signal, and an exclusion with no number beside
   * it reads as a population that is passing — the same rule this command
   * already follows for file-set records and unchecked headers. They are printed
   * and counted; they simply do not decide the exit code.
   */
  const liveSessions = results.filter((r) => r.session.alive);
  const liveWithFindings = liveSessions.filter((r) => r.summary.contradictions > 0);
  const anyContradiction = gatingTurnKeys.size > 0 || gatingHeaderSessions.size > 0;
  const gateBlockedByIncompleteEvidence = opts.failOnIncompleteEvidence && evidenceIncomplete;
  // Sessions whose header was NOT compared with their turns, because a turn is
  // still open. Reported rather than silently skipped, for the same reason
  // file-set records are: an exclusion with no number beside it is
  // indistinguishable from a population that is passing.
  const headersNotChecked = results.filter((r) => isMidTurnHeader(r.session.header)).length;

  if (opts.waiver) {
    // Only what could GATE is waived. A live session's findings never blocked
    // the release, so recording them in the tag as "shipped unread" would be a
    // lie in the one place that is permanent.
    const block = renderWaiverBlock(waivedFindings(results.filter((r) => !r.session.alive)), opts.since);
    if (block) process.stdout.write(block + '\n');
    if (gateBlockedByIncompleteEvidence) process.exitCode = 2;
    else if (opts.failOnContradiction && anyContradiction) process.exitCode = 1;
    return;
  }

  if (opts.json) {
    process.stdout.write(JSON.stringify({
      totals: {
        sessions: results.length,
        turns: totalTurns,
        turnsWithContradiction: dirtyTurnKeys.size,
        sessionsWithContradiction: dirtySessions.length,
        sessionsWithHeaderContradiction: headerDirtySessions.size,
        sessionsHeaderNotChecked: headersNotChecked,
        unverifiableSessions: unverifiable.length,
        fileSetRecords: [...sessions, ...unverifiable].reduce((n, s) => n + s.fileSetRecords, 0),
        // Live sessions are reported but do not gate — their rows are not final.
        liveSessions: liveSessions.length,
        liveSessionsWithContradiction: liveWithFindings.length,
        mutableSessions: mutableSessions.length,
        incompleteEvidenceSessions: incompleteEvidenceSessions.length,
        evidenceComplete: !evidenceIncomplete,
        gatingTurnsWithContradiction: gatingTurnKeys.size,
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
          alive: r.session.alive,
          contradictions: r.summary.contradictions,
          suspects: r.summary.suspects,
          violations: r.violations,
        })),
    }, null, 2) + '\n');
    if (gateBlockedByIncompleteEvidence) process.exitCode = 2;
    else if (opts.failOnContradiction && anyContradiction) process.exitCode = 1;
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
  console.log(`  headers != their turns    ${headerDirtySessions.size}  ${chalk.dim(`(${pct(headerDirtySessions.size, results.length)})`)}`);
  if (headersNotChecked > 0) {
    console.log(`  headers not checked       ${headersNotChecked}  ${chalk.dim('(a turn is still open — Stop has not written its row yet)')}`);
  }
  if (liveSessions.length > 0) {
    console.log(`  live, not gating          ${liveSessions.length}  ${chalk.dim(`(${liveWithFindings.length} with findings — rows are not final until the session ends)`)}`);
  }
  if (evidenceIncomplete) {
    console.log(`  incomplete evidence       ${incompleteEvidenceSessions.length}  ${chalk.dim('(mutable or without a turn capture)')}`);
  }
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
          const where = idx === SESSION_LEVEL_INDEX ? 'header  ' : `turn ${String(idx).padEnd(3)}`;
          console.log(`    ${mark} ${where} ${v.code}`);
          console.log(`        ${chalk.dim(v.detail)}`);
          if (v.files?.length) console.log(`        ${chalk.dim(v.files.join(', '))}`);
        }
      }
    }
  }

  console.log('');
  if (gateBlockedByIncompleteEvidence) {
    console.log(chalk.red(`  Release evidence is incomplete: ${incompleteEvidenceSessions.length} selected session(s) are still mutable or have no turn capture.`));
    console.log(chalk.dim('  End or finish those sessions, then re-run the release gate.'));
  } else if (!anyContradiction && liveWithFindings.length > 0) {
    // Green would be a lie and red would block: the findings are real, they are
    // simply not final. Name them so nobody reads silence as a clean bill.
    console.log(chalk.yellow(`  No contradictions in final rows — ${liveWithFindings.length} live session(s) have findings that are not final yet.`));
    console.log(chalk.dim('  Re-run once they end to grade them.'));
  } else if (!anyContradiction) {
    console.log(chalk.green('  No contradictions found.'));
  } else {
    console.log(chalk.dim('  A contradiction is a defect in the capture, not in the agent\'s work.'));
    console.log(chalk.dim('  Re-run with --json for the full record.'));
  }
  console.log('');

  if (gateBlockedByIncompleteEvidence) process.exitCode = 2;
  else if (opts.failOnContradiction && anyContradiction) process.exitCode = 1;
}
