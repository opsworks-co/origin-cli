/**
 * The release gate must not fail on the session that is running it.
 *
 * `scripts/release-cli.sh` puts `origin verify-capture --fail-on-contradiction`
 * between the version bump and the tag — the one check that can be made before
 * a release. It runs from inside an agent's own turn, and at that moment the
 * session's state file is mid-turn: post-commit has already SET the header
 * totals (`applyAuthoredTotals`, the instant `git commit` ran), while the row
 * for the turn that ran it is appended by Stop, at the END of the turn.
 *
 * So the header carried work no turn carried yet, both header rules read that
 * as work no turn saw, and the gate failed on the releasing session every time.
 * The only way past was `--allow-contradictions`, which does not silence that
 * one session — it silences the check for every OTHER session in the range,
 * which is the entire point of running it.
 *
 * These tests drive `verifyCaptureCommand` over a real state file on disk, so
 * they cover the wiring (collectSessions reading `activeTurn`/`status` onto the
 * header) and not just the rule. `--session` scopes the run to this fixture;
 * the command also reads ~/.origin/sessions, which on a dev machine is real.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { verifyCaptureCommand } from '../commands/verify-capture.js';

const SESSION_ID = 'deadbeef-0000-4000-8000-00000000d0d0';

const patch = (file: string, adds: string[], removes: string[] = []) => [
  `diff --git a/${file} b/${file}`,
  'index 1111111..2222222 100644',
  `--- a/${file}`,
  `+++ b/${file}`,
  `@@ -1,${1 + removes.length} +1,${1 + adds.length} @@`,
  ' context',
  ...removes.map((l) => `-${l}`),
  ...adds.map((l) => `+${l}`),
].join('\n');

/**
 * A session two turns in, whose third turn is OPEN and has just committed:
 * the header holds the commit's +40 over three files, the two rows Stop has
 * written hold +3/-1 over two. Before the fix this is two contradictions.
 */
function midTurnState(): Record<string, unknown> {
  return {
    sessionId: SESSION_ID,
    sessionTag: 'gate',
    agentSlug: 'claude-code',
    startedAt: new Date().toISOString(),
    status: 'RUNNING',
    prompts: ['p0', 'p1', 'p2'],
    filesChanged: ['src/a.ts', 'src/b.ts', 'src/released.ts'],
    linesAdded: 40,
    linesRemoved: 1,
    activeTurn: { index: 2, turnId: 't_open', promptText: 'p2', openedAt: new Date().toISOString() },
    completedPromptMappings: [
      { promptIndex: 0, filesChanged: ['src/a.ts'], diff: patch('src/a.ts', ['one', 'two']) },
      { promptIndex: 1, filesChanged: ['src/b.ts'], diff: patch('src/b.ts', ['three'], ['old']) },
    ],
  };
}

describe('verify-capture over a session with a turn still open', () => {
  let repo: string;
  const origCwd = process.cwd();

  const write = (state: Record<string, unknown>) => {
    fs.writeFileSync(path.join(repo, '.git', 'origin-session-gate.json'), JSON.stringify(state, null, 2));
  };

  /** The gate's own invocation: exit code, and the totals it reports. */
  const runGate = async (strictEvidence = false): Promise<{
    failed: boolean; exitCode: number | undefined; headerContradictions: number; notChecked: number;
    turnContradictions: number; gatingTurns: number; live: number; liveWithFindings: number;
  }> => {
    // --json writes the record with process.stdout.write, not console.log.
    const out: string[] = [];
    const write = process.stdout.write.bind(process.stdout);
    const before = process.exitCode;
    process.stdout.write = ((chunk: unknown) => { out.push(String(chunk)); return true; }) as typeof process.stdout.write;
    try {
      await verifyCaptureCommand({
        session: SESSION_ID,
        failOnContradiction: true,
        failOnIncompleteEvidence: strictEvidence,
        json: true,
      });
    } finally {
      process.stdout.write = write;
    }
    const exitCode = typeof process.exitCode === 'number' ? process.exitCode : undefined;
    const failed = exitCode === 1;
    process.exitCode = before;
    const totals = JSON.parse(out.join('\n')).totals;
    return {
      failed,
      exitCode,
      headerContradictions: totals.sessionsWithHeaderContradiction,
      notChecked: totals.sessionsHeaderNotChecked,
      turnContradictions: totals.turnsWithContradiction,
      gatingTurns: totals.gatingTurnsWithContradiction,
      live: totals.liveSessions,
      liveWithFindings: totals.liveSessionsWithContradiction,
    };
  };

  beforeEach(() => {
    repo = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'origin-gate-')));
    execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: repo });
    write({ ...midTurnState(), repoPath: repo });
    process.chdir(repo);
  });

  afterEach(() => {
    process.chdir(origCwd);
    fs.rmSync(repo, { recursive: true, force: true });
  });

  it('does not fail the gate, and says so rather than skipping silently', async () => {
    const r = await runGate();
    expect(r.failed).toBe(false);
    expect(r.headerContradictions).toBe(0);
    // The exclusion is counted. A session held out with no number beside it is
    // indistinguishable from one that passed.
    expect(r.notChecked).toBe(1);
  });

  it('fails closed in strict evidence mode while a selected session is mutable', async () => {
    const r = await runGate(true);
    expect(r.failed).toBe(false);
    expect(r.exitCode).toBe(2);
    expect(r.live).toBe(1);
  });

  it('fails the gate once Stop has closed the turn and the session is final', async () => {
    // The session must be FINAL as well as past its open turn. A closed turn
    // alone is not enough while the session still runs: post-commit writes the
    // header totals at `git commit`, the row's content lands afterwards, so in
    // that window a live header exceeds its turns with nothing wrong. Measured
    // on the codex session that blocked cli-v0.20260911.2209 — header +221/-9
    // against turns +180/-14, `activeTurn: null`. #1516's rule did not apply and
    // the gate failed on a session that was merely mid-flight.
    write({
      ...midTurnState(), repoPath: repo, activeTurn: null,
      status: 'ENDED', endedAt: new Date().toISOString(),
    });
    const r = await runGate();
    expect(r.failed).toBe(true);
    expect(r.headerContradictions).toBe(1);
    expect(r.notChecked).toBe(0);
  });

  it('does NOT fail the gate on a live session whose turn has merely closed', async () => {
    // The window above, asserted directly: same rows, still running.
    write({ ...midTurnState(), repoPath: repo, activeTurn: null });
    const r = await runGate();
    expect(r.failed, 'a live session must not block a release').toBe(false);
    // Graded and counted, not hidden.
    expect(r.headerContradictions).toBe(1);
    expect(r.live).toBe(1);
    expect(r.liveWithFindings).toBe(1);
  });

  it('fails the gate on an ENDED session whose turn never Stopped', async () => {
    // A turn killed by an API error or an interrupt leaves `activeTurn` set for
    // good. Its capture is final, so it is graded — the exemption is for a
    // session still writing, never a permanent pass.
    write({ ...midTurnState(), repoPath: repo, status: 'ENDED', endedAt: new Date().toISOString() });
    const r = await runGate();
    expect(r.failed).toBe(true);
    expect(r.headerContradictions).toBe(1);
    expect(r.notChecked).toBe(0);
  });

  it('fails the gate on a ZOMBIE session — RUNNING, turn open, nothing alive', async () => {
    // A killed agent never runs session-end, so its row says RUNNING with the
    // turn open for good. Read literally that is a permanent exemption, which
    // is why liveness decides and not the status string. Aged past the same
    // 3-hour window every other liveness rung uses, with no heartbeat.
    write({ ...midTurnState(), repoPath: repo });
    const stale = Date.now() / 1000 - 4 * 60 * 60;
    fs.utimesSync(path.join(repo, '.git', 'origin-session-gate.json'), stale, stale);

    const r = await runGate();
    expect(r.failed).toBe(true);
    expect(r.headerContradictions).toBe(1);
    expect(r.notChecked).toBe(0);
  });

  it('fails the gate when the producer records no open turn at all', async () => {
    // Absence never confers the privilege: a producer that stops writing
    // `activeTurn` is graded again, not silently excused. ENDED so that liveness
    // is not what is being tested here — the missing field is.
    const s = midTurnState();
    delete s.activeTurn;
    write({ ...s, repoPath: repo, status: 'ENDED', endedAt: new Date().toISOString() });
    const r = await runGate();
    expect(r.failed).toBe(true);
    expect(r.headerContradictions).toBe(1);
  });

  it('fails closed when a finalized state has no turn evidence to grade', async () => {
    write({
      sessionId: SESSION_ID,
      sessionTag: 'gate',
      agentSlug: 'claude-code',
      startedAt: new Date().toISOString(),
      status: 'ENDED',
      endedAt: new Date().toISOString(),
      completedPromptMappings: [{ promptIndex: 0, filesChanged: ['src/a.ts'], fileSetOnly: true }],
    });
    const r = await runGate(true);
    expect(r.failed).toBe(false);
    expect(r.exitCode).toBe(2);
  });

  // ── A live session's PER-TURN rows are not final either ──────────────────
  //
  // The rule above covers the header. One level down is the same truth, and
  // #1533's per-turn window made it bite: a committing turn's content arrives
  // from post-commit and session-end heals what is still missing, so a row read
  // mid-session is a snapshot, not a verdict.
  //
  // Measured 2026-09-11 releasing cli-v0.20260911.2209 with two sibling agents
  // at work: a RUNNING codex session contributed `files_without_content` on
  // three committing turns (`packages/cli/package.json`, no diff yet) and a
  // RUNNING claude-code session 17 claimed files absent from its diff. Waiting
  // made it worse — 2 contradictions, then 4 — because both kept committing.
  // On a shared machine that is the normal state, so the gate was unsatisfiable
  // by waiting, and the only ways past were `--allow-contradictions` (which
  // would have silenced every OTHER session too) or not shipping.
  describe('per-turn rows of a session that is still alive', () => {
    /**
     * The exact shape that blocked the release: the turn is CLOSED
     * (`activeTurn: null`, so the header rule above does not apply) and names a
     * file it has no diff for, because post-commit has not filled it yet.
     */
    const committingTurnAwaitingContent = () => ({
      sessionId: SESSION_ID,
      sessionTag: 'gate',
      agentSlug: 'codex',
      startedAt: new Date().toISOString(),
      status: 'RUNNING',
      prompts: ['p0'],
      activeTurn: null,
      completedPromptMappings: [
        { promptIndex: 0, filesChanged: ['packages/cli/package.json'], diff: '', commitSha: 'abc1234' },
      ],
    });

    it('are graded and counted, but do not fail the gate', async () => {
      write({ ...committingTurnAwaitingContent(), repoPath: repo });
      const r = await runGate();
      expect(r.failed, 'a live session must not block a release').toBe(false);
      // Still graded — the finding is real diagnostic signal.
      expect(r.turnContradictions, 'the finding is still reported').toBe(1);
      // ...and held out of the gate, with a number beside it. An exclusion with
      // no count reads as a population that passed.
      expect(r.gatingTurns).toBe(0);
      expect(r.live).toBe(1);
      expect(r.liveWithFindings).toBe(1);
    });

    it('fail the gate once the session has ENDED', async () => {
      write({
        ...committingTurnAwaitingContent(),
        repoPath: repo,
        status: 'ENDED',
        endedAt: new Date().toISOString(),
      });
      const r = await runGate();
      expect(r.failed, 'a final row still gates').toBe(true);
      expect(r.gatingTurns).toBe(1);
      expect(r.live).toBe(0);
    });

    it('fail the gate on a ZOMBIE — RUNNING, but nothing alive', async () => {
      // Same asymmetry the header rule uses: liveness decides, never the status
      // string, or a killed agent's broken rows are exempt for good.
      write({ ...committingTurnAwaitingContent(), repoPath: repo });
      const stale = Date.now() / 1000 - 4 * 60 * 60;
      fs.utimesSync(path.join(repo, '.git', 'origin-session-gate.json'), stale, stale);
      const r = await runGate();
      expect(r.failed).toBe(true);
      expect(r.gatingTurns).toBe(1);
      expect(r.live).toBe(0);
    });
  });
});
