// The release gate graded ZERO sessions on two consecutive releases
// (2026-09-10, cli-v…1639 and cli-v…2037) while 25 contradictory turns across
// 18 sessions sat on the machine. Both printed "No stored captures found to
// verify" and passed — a vacuous pass that reads exactly like a real one.
//
// Cause: `--since` kept a session only when its `startedAt` was inside the
// window, and those tags were cut 50 and 40 minutes after their predecessors.
// Almost nothing STARTS in a window that short. Every long-running session —
// precisely the ones doing the work — was invisible to the gate.
//
// It cannot be fixed by keeping a session for being ACTIVE in the window: a
// stored row is FINAL, so a long session would drag its old contradictions
// into every future release and wedge the gate for good. That deadlock
// happened at cli-v0.20260910.630 and needed a one-time waiver.
//
// So the window is per-TURN. A session started inside it is graded whole; a
// session started earlier is graded on the turns it captured inside it, and
// its header — a whole-session total — is left alone.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { execFileSync } from 'child_process';
import { stampCaptured } from '../session-state.js';

const HOUR = 60 * 60 * 1000;
const NOW = Date.now();
const LAST_RELEASE = new Date(NOW - HOUR).toISOString();     // window opens here
const OLD = new Date(NOW - 48 * HOUR).toISOString();
const FRESH = new Date(NOW - 10 * 60 * 1000).toISOString();

let home: string;
let repo: string;

// A turn whose filesChanged names a file its diff never mentions — the
// `claimed_file_absent_from_diff` contradiction.
function contradictoryTurn(promptIndex: number, capturedAt?: string) {
  const t: Record<string, unknown> = {
    promptIndex,
    promptText: `turn ${promptIndex}`,
    filesChanged: ['src/ghost.ts'],
    diff: 'diff --git a/src/other.ts b/src/other.ts\n--- a/src/other.ts\n+++ b/src/other.ts\n@@ -1,1 +1,2 @@\n+added\n',
    linesAdded: 1,
    linesRemoved: 0,
  };
  return capturedAt ? { ...t, capturedAt } : t;
}

function writeSession(id: string, startedAt: string, turns: unknown[]) {
  fs.writeFileSync(
    path.join(home, '.origin', 'sessions', `${id}.json`),
    JSON.stringify({
      sessionId: id, agentSlug: 'claude-code', repoPath: repo,
      startedAt, status: 'ENDED', endedAt: new Date(NOW).toISOString(),
      completedPromptMappings: turns,
    }),
  );
}

// ── Failure legibility ───────────────────────────────────────────────────
//
// These helpers used to swallow BOTH failure modes — a non-zero exit and an
// unparseable stdout — into `[]`, so every distinct cause surfaced as the one
// message `expected [] to include 'aaaaaaaa-long'`. That cost two separate
// misdiagnoses of the native-Windows job:
//
//   1. (2026-09-11, #1533) only HOME was set, but verify-capture resolves the
//      sessions dir through os.homedir(), which reads %USERPROFILE% on Windows.
//      The CLI read the runner's real, empty ~/.origin/sessions and graded
//      nothing. A genuinely empty session list.
//   2. (2026-09-11, #1544, an API-only change on a branch that already had the
//      USERPROFILE fix) the postAction update-check banner printed "Update
//      available: …" on STDOUT after the JSON, so JSON.parse threw. Nothing
//      about an empty array says that.
//
// So: a non-zero exit, stdout that is not JSON, and a command that ran fine and
// graded nothing are now three different messages. The rule is that the test
// names its own failure — never that it tolerates one.
const CLI = path.resolve(__dirname, '../../dist/index.js');

interface Run { args: string[]; out: string; err: string; code: number }

function runVerify(sinceIso: string): Run {
  // A missing build exits non-zero with empty stdout, which reads exactly like
  // "graded nothing". Say which file is absent instead. Both CI legs run
  // `pnpm run build` in packages/cli before the suite; locally it is on you.
  if (!fs.existsSync(CLI)) {
    throw new Error(`CLI not built: ${CLI} does not exist. Run \`pnpm run build\` in packages/cli.`);
  }
  const args = ['verify-capture', '--since', sinceIso, '--json'];
  try {
    const out = execFileSync(process.execPath, [CLI, ...args], {
      cwd: repo, encoding: 'utf-8',
      // Pipe stderr rather than inheriting it: it is the only place a
      // diagnostic from the command itself shows up, and these helpers quote it.
      stdio: ['pipe', 'pipe', 'pipe'],
      // Both, per cause 1 above: os.homedir() reads $HOME on POSIX and
      // %USERPROFILE% on Windows, and this isolation is the whole fixture.
      env: { ...process.env, HOME: home, USERPROFILE: home },
    });
    return { args, out, err: '', code: 0 };
  } catch (e: unknown) {
    const err = e as { stdout?: string; stderr?: string; status?: number | null; message?: string };
    return {
      args,
      out: err.stdout ?? '',
      err: err.stderr || err.message || '',
      code: err.status ?? 1,
    };
  }
}

/** What the command was and what it said — quoted into every failure below. */
function context(run: Run): string {
  const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n)}… (${s.length} bytes total)` : s || '(empty)');
  return [
    `  command: ${process.execPath} ${CLI} ${run.args.join(' ')}`,
    `  cwd:     ${repo}`,
    `  HOME/USERPROFILE: ${home}`,
    `  exit:    ${run.code}`,
    `  stderr:  ${clip(run.err.trim(), 2000)}`,
    `  stdout:  ${clip(run.out, 500)}`,
  ].join('\n');
}

type VerifyJson = {
  totals?: { sessions?: number; turns?: number } | null;
  sessions?: Array<{ sessionId?: string; turns?: number }>;
};

/**
 * The parsed record, or a failure that says which of the two non-answers
 * happened. Never returns a stand-in for "the command did not run".
 */
function parsed(run: Run): VerifyJson {
  if (run.code !== 0) {
    throw new Error(`verify-capture exited ${run.code} — it did not run to completion.\n${context(run)}`);
  }
  try {
    return JSON.parse(run.out) as VerifyJson;
  } catch (e: unknown) {
    const why = e instanceof Error ? e.message : String(e);
    // Pollution is appended, so the tail is where the cause usually is — a
    // trailing banner, a warning, a progress line. Quote both ends.
    const tail = run.out.length > 500 ? `\n  stdout tail: ${JSON.stringify(run.out.slice(-300))}` : '';
    throw new Error(
      `verify-capture --json wrote stdout that is not JSON: ${why}\n`
      + 'Something on this path appended to stdout, which is the command\'s machine-readable output.\n'
      + `${context(run)}${tail}`,
    );
  }
}

/** A one-line summary of what the run actually graded, for the empty case. */
const summary = (j: VerifyJson): string =>
  `graded ${j.sessions?.length ?? 0} session(s), totals=${JSON.stringify(j.totals ?? null)}`;

const gradedIds = (run: Run): string[] =>
  (parsed(run).sessions || []).map((s) => s.sessionId || '').filter(Boolean);

const gradedTurns = (run: Run, id: string): number | undefined =>
  parsed(run).sessions?.find((s) => s.sessionId === id)?.turns;

describe('the release gate windows on turns, not on session start', () => {
  beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'origin-gate-home-'));
    fs.mkdirSync(path.join(home, '.origin', 'sessions'), { recursive: true });
    repo = fs.mkdtempSync(path.join(os.tmpdir(), 'origin-gate-repo-'));
    execFileSync('git', ['init', '-q'], { cwd: repo });
  });
  afterEach(() => {
    for (const d of [home, repo]) { try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* ignore */ } }
  });

  it('grades a long session on the turns it captured since the last release', () => {
    // Started two days ago — invisible to the old startedAt window — but it
    // captured a contradictory turn ten minutes ago.
    writeSession('aaaaaaaa-long', OLD, [
      contradictoryTurn(0, OLD),
      contradictoryTurn(1, FRESH),
    ]);
    const run = runVerify(LAST_RELEASE);
    expect(gradedIds(run), summary(parsed(run))).toContain('aaaaaaaa-long');
  });

  it('grades ONLY the fresh turns of that session, not its whole history', () => {
    writeSession('bbbbbbbb-long', OLD, [
      contradictoryTurn(0, OLD),
      contradictoryTurn(1, OLD),
      contradictoryTurn(2, FRESH),
    ]);
    const run = runVerify(LAST_RELEASE);
    // One turn in the window — the two older ones are already shipped over.
    expect(gradedTurns(run, 'bbbbbbbb-long'), summary(parsed(run))).toBe(1);
  });

  it('leaves the legacy backlog out — rows with no capturedAt never re-enter', () => {
    // Exactly the shape that would re-wedge the gate: an old session full of
    // contradictions written before capturedAt existed.
    writeSession('cccccccc-legacy', OLD, [
      contradictoryTurn(0),
      contradictoryTurn(1),
    ]);
    // A control the gate MUST grade, in the same run. Without it this asserts
    // only that one id is absent from a list, which is also true of a run that
    // graded nothing at all — and that is exactly the state both Windows
    // incidents put it in, so it passed through both of them for the wrong
    // reason while its three neighbours failed.
    writeSession('cccccccc-fresh', OLD, [contradictoryTurn(0, FRESH)]);
    const run = runVerify(LAST_RELEASE);
    const ids = gradedIds(run);
    expect(ids, summary(parsed(run))).toContain('cccccccc-fresh');
    expect(ids).not.toContain('cccccccc-legacy');
  });

  it('still grades a session that STARTED in the window exactly as before', () => {
    writeSession('dddddddd-new', FRESH, [contradictoryTurn(0, FRESH)]);
    const run = runVerify(LAST_RELEASE);
    expect(gradedIds(run), summary(parsed(run))).toContain('dddddddd-new');
  });

  it('stampCaptured overwrites, because a rewritten row is a new capture', () => {
    const m = { promptIndex: 0, capturedAt: OLD } as Record<string, unknown>;
    const at = new Date(NOW);
    expect(stampCaptured(m, at).capturedAt).toBe(at.toISOString());
  });
});
