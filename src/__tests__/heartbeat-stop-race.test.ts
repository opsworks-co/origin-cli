import { afterEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import ts from 'typescript';
import { newCaptureStamp } from '../capture-stamp.js';
import { turnIsClosed } from '../turn-commit-scope.js';
import { openTurnNarrowingBase, scopeUncommittedToOpenTurn } from '../open-turn-uncommitted-scope.js';
import { compareResolverWithPasses, createTurnObserver, observeReconstruction, onlyDifferences } from '../resolve-turn.js';
import { redactSessionPayloadContent } from '../captured-diff-redaction.js';

// Exercise the actual daemon function without starting its timers or exiting
// this test process. External I/O is controlled so Stop can finish inside Git.
const source = fs.readFileSync(new URL('../heartbeat.ts', import.meta.url), 'utf8');
const start = source.indexOf('async function pushInflightDiff()');
const end = source.indexOf('\n/**', start);
const body = ts.transpileModule(source.slice(start, end), {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
}).outputText;
const patch = 'diff --git a/app.ts b/app.ts\n--- a/app.ts\n+++ b/app.ts\n@@ -1 +1 @@\n-old\n+new\n';

function harness(duringGit: (state: any) => void = () => {}, owns: () => boolean = () => true, replaying: () => string | null = () => null) {
  const state = { repoPath: '/repo', prePromptSha: 'abcdef0', prompts: ['edit'],
    promptTurnIds: ['turn-a'], promptIndexBase: 4, lastClosedTurnIndex: null as number | null };
  const send = vi.fn().mockResolvedValue({});
  const git = vi.fn((_command, args) => {
    duringGit(state);
    return args.includes('diff') ? patch : '';
  });
  const noop = () => {};
  const dependencies = {
    isConnected: true, stateFile: '/state',
    fs: { readFileSync: () => JSON.stringify(state) },
    newCaptureStamp, turnIsClosed,
    serverRowForLocalTurn: (index: number, base: number) => index + base,
    execFileSync: git,
    stripIgnoredSectionsFromDiff: (s: string) => s,
    hasDuplicateFileSections: () => false,
    combineApplyableTurnDiff: ({ uncommittedDiff }: any) => uncommittedDiff,
    capDiff: (s: string) => s, MAX_PROMPT_DIFF_LEN: 10000,
    applyLedgerToMappings: noop, stateLedgerIsContended: () => false, startDirtReader: () => () => null,
    readJournalEntries: noop, preferShadowRangeForTurns: noop,
    preferCommitPatchForCommittedTurns: noop,
    // The open-turn scoping is pure; no start shadow and no sibling here, so it narrows nothing.
    scopeUncommittedToOpenTurn, openTurnNarrowingBase, filesChangedSinceShadowOrNull: () => null, filesClaimedByOtherLiveSessions: () => [],
    // The resolver's side-by-side run is pure; the real functions, like the stamp.
    createTurnObserver, observeReconstruction, compareResolverWithPasses, onlyDifferences, debugLog: noop,
    redactSessionPayloadContent,
    fetchWithTimeout: send, apiUrl: 'https://example.test', sessionId: 'session', apiKey: 'test',
    stillOwnsSession: owns,
    replayInProgress: replaying,
  };
  const run = new Function(...Object.keys(dependencies), `${body}\nreturn pushInflightDiff;`)(...Object.values(dependencies));
  return { run, state, send, git };
}

afterEach(() => vi.useRealTimers());

describe('heartbeat racing Stop', () => {
  it('does not send a reconstruction when Stop closes the turn during Git', async () => {
    const h = harness(state => { state.lastClosedTurnIndex = 0; });
    await h.run();
    expect(h.git).toHaveBeenCalled();
    expect(h.send).not.toHaveBeenCalled();
  });

  it('does no Git work for a turn already closed before the tick', async () => {
    const h = harness();
    h.state.lastClosedTurnIndex = 0;
    await h.run();
    expect(h.git).not.toHaveBeenCalled();
    expect(h.send).not.toHaveBeenCalled();
  });

  it('dates an open-turn capture before slow Git, preserving its server row and identity', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1000);
    const h = harness(() => vi.setSystemTime(2000));
    await h.run();
    expect(h.send).toHaveBeenCalledOnce();
    const row = JSON.parse(h.send.mock.calls[0][1].body).promptChanges[0];
    expect(row).toMatchObject({ capturedAt: 1000, promptIndex: 4, turnId: 'turn-a', diff: patch, linesAdded: 1, linesRemoved: 1 });
    expect(row.captureId).toMatch(/^hb_/);
  });

  // A rebase stopped on a conflict leaves HEAD on its base and the picked
  // commit in the tree: HEAD..worktree is the replayed commit, not the turn.
  it('does no Git work while a rebase, cherry-pick or am is stopped mid-way', async () => {
    const h = harness(() => {}, () => true, () => 'rebase');
    await h.run();
    expect(h.git).not.toHaveBeenCalled();
    expect(h.send).not.toHaveBeenCalled();
  });

  it('does not send when a replay started while the tick ran Git', async () => {
    let replaying: string | null = null;
    const h = harness(() => { replaying = 'rebase'; }, () => true, () => replaying);
    await h.run();
    expect(h.git).toHaveBeenCalled();
    expect(h.send).not.toHaveBeenCalled();
  });

  // TODO 0caf3c77: session-end deletes the pid file but can only SIGTERM a
  // daemon whose command line it can read. One it cannot read finishes its
  // tick — and used to PATCH after /session/end.
  it('does not send once the daemon no longer owns the session (pid file gone mid-tick)', async () => {
    let owned = true;
    const h = harness(() => { owned = false; }, () => owned);
    await h.run();
    expect(h.git).toHaveBeenCalled();
    expect(h.send).not.toHaveBeenCalled();
  });
});

