/**
 * A re-launched session's header is not checked against the rows of ONE launch.
 *
 * Session ed0e33c8 (2026-09-18) was re-launched twice. Each session-start
 * rebuilt its state file — `seeded promptIndexBase from the transcript (no
 * prior state found) {"promptIndexBase":23}` — while keeping the session's
 * commit records, so the header went on totalling all twelve commits
 * (10 files, +59/-22) over a state file that held rows 23 and 24 only. Rows
 * 0-22 were sent by the earlier launches and live on the server.
 *
 * The gate read that as `header_file_unclaimed_by_turns` and
 * `header_exceeds_turns`, and would have with every row correct: eight of the
 * ten files belong to rows this file never had.
 *
 * Driven through `verifyCaptureCommand` over a real state file, like
 * verify-capture-skips-an-open-turn.test.ts, so `collectSessions` is covered.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { verifyCaptureCommand } from '../commands/verify-capture.js';

const SESSION_ID = 'deadbeef-0000-4000-8000-0000000023ba';

const patch = (file: string, adds: string[]) => [
  `diff --git a/${file} b/${file}`,
  'index 1111111..2222222 100644',
  `--- a/${file}`,
  `+++ b/${file}`,
  `@@ -1,1 +1,${1 + adds.length} @@`,
  ' context',
  ...adds.map((l) => `+${l}`),
].join('\n');

const STARTED_AT = new Date().toISOString();
/** A commit record from a launch before this state file was written. */
const earlierLaunchCommit = { sha: 'a'.repeat(40), turnId: 't_earlier', at: new Date(Date.parse(STARTED_AT) - 3_600_000).toISOString(), via: 'post-commit' };
/** A commit this launch made itself. */
const ownCommit = { sha: 'b'.repeat(40), turnId: 't_own', at: new Date(Date.parse(STARTED_AT) + 60_000).toISOString(), via: 'post-commit' };

/** Ended, two rows from this launch, a header that spans the whole session. */
const relaunched = (
  rows: Array<Record<string, unknown>>,
  promptIndexBase: number | undefined,
  commitTurns: Array<Record<string, unknown>> | null = [earlierLaunchCommit, ownCommit],
) => ({
  sessionId: SESSION_ID,
  sessionTag: 'relaunch',
  agentSlug: 'claude-code',
  startedAt: STARTED_AT,
  status: 'ENDED',
  endedAt: new Date().toISOString(),
  activeTurn: null,
  prompts: ['full height', 'commit'],
  ...(promptIndexBase === undefined ? {} : { promptIndexBase }),
  ...(commitTurns === null ? {} : { commitTurns }),
  filesChanged: ['web/Header.tsx', 'web/Hero.tsx', 'web/DossierViewer.tsx'],
  linesAdded: 59,
  linesRemoved: 0,
  completedPromptMappings: rows,
});

describe('verify-capture over a re-launched session', () => {
  let repo: string;
  const origCwd = process.cwd();

  const write = (state: Record<string, unknown>) =>
    fs.writeFileSync(path.join(repo, '.git', 'origin-session-relaunch.json'), JSON.stringify({ ...state, repoPath: repo }, null, 2));

  const runGate = async () => {
    const out: string[] = [];
    const real = process.stdout.write.bind(process.stdout);
    const before = process.exitCode;
    process.stdout.write = ((chunk: unknown) => { out.push(String(chunk)); return true; }) as typeof process.stdout.write;
    try {
      await verifyCaptureCommand({ session: SESSION_ID, failOnContradiction: true, json: true });
    } finally {
      process.stdout.write = real;
    }
    const failed = process.exitCode === 1;
    process.exitCode = before;
    const totals = JSON.parse(out.join('\n')).totals;
    return { failed, header: totals.sessionsWithHeaderContradiction, elsewhere: totals.sessionsHeaderRowsElsewhere };
  };

  beforeEach(() => {
    repo = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'origin-gate-relaunch-')));
    execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: repo });
    process.chdir(repo);
  });
  afterEach(() => {
    process.chdir(origCwd);
    fs.rmSync(repo, { recursive: true, force: true });
  });

  const thisLaunch = [
    { promptIndex: 23, filesChanged: ['web/DossierViewer.tsx'], diff: patch('web/DossierViewer.tsx', ['full']) },
    { promptIndex: 24, filesChanged: [], diff: '', chatOnly: true },
  ];

  it('holds the header back, and says so', async () => {
    write(relaunched(thisLaunch, 23));
    expect(await runGate()).toEqual({ failed: false, header: 0, elsewhere: 1 });
  });

  it('still checks a header whose rows are all here', async () => {
    // Same rows, numbered from the first turn: nothing is elsewhere, and two
    // header files no turn names is the leak the rule exists for.
    write(relaunched(thisLaunch.map((r, i) => ({ ...r, promptIndex: i })), undefined));
    expect(await runGate()).toEqual({ failed: true, header: 1, elsewhere: 0 });
  });

  it('still checks a resumed session that kept its earlier rows', async () => {
    write(relaunched([{ promptIndex: 0, filesChanged: [], diff: '', chatOnly: true }, ...thisLaunch], 23));
    expect(await runGate()).toEqual({ failed: true, header: 1, elsewhere: 0 });
  });

  // The hold-back fired on `promptIndexBase > 0` with no row below the base —
  // which an ADOPTED session matches too, though every commit it holds is its
  // own and its header totals only those. The tell for rows elsewhere is a
  // commit record older than this state file (ed0e33c8 had eleven).
  it('still checks an adopted session whose every commit record is its own', async () => {
    write(relaunched(thisLaunch, 23, [ownCommit]));
    expect(await runGate()).toEqual({ failed: true, header: 1, elsewhere: 0 });
  });

  it('still checks a session with no commit records at all — the hold-back needs evidence', async () => {
    write(relaunched(thisLaunch, 23, []));
    expect(await runGate()).toEqual({ failed: true, header: 1, elsewhere: 0 });
    write(relaunched(thisLaunch, 23, null));
    expect(await runGate()).toEqual({ failed: true, header: 1, elsewhere: 0 });
  });

  it('a commit record with no usable date is not evidence of an earlier launch', async () => {
    write(relaunched(thisLaunch, 23, [{ sha: 'c'.repeat(40), turnId: 't_undated' }]));
    expect(await runGate()).toEqual({ failed: true, header: 1, elsewhere: 0 });
  });
});
