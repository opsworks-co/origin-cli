import { afterEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import ts from 'typescript';
import { newCaptureStamp } from '../capture-stamp.js';
import { turnIsClosed } from '../turn-commit-scope.js';
import { compareResolverWithPasses, createTurnObserver, observeReconstruction, onlyDifferences } from '../resolve-turn.js';

// Exercise the actual daemon function without starting its timers or exiting
// this test process. External I/O is controlled so Stop can finish inside Git.
const source = fs.readFileSync(new URL('../heartbeat.ts', import.meta.url), 'utf8');
const start = source.indexOf('async function pushInflightDiff()');
const end = source.indexOf('\n/**', start);
const body = ts.transpileModule(source.slice(start, end), {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
}).outputText;
const patch = 'diff --git a/app.ts b/app.ts\n--- a/app.ts\n+++ b/app.ts\n@@ -1 +1 @@\n-old\n+new\n';

function harness(duringGit: (state: any) => void = () => {}) {
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
    applyLedgerToMappings: noop, stateLedgerIsContended: () => false,
    readJournalEntries: noop, preferShadowRangeForTurns: noop,
    preferCommitPatchForCommittedTurns: noop,
    // The resolver's side-by-side run is pure; the real functions, like the stamp.
    createTurnObserver, observeReconstruction, compareResolverWithPasses, onlyDifferences, debugLog: noop,
    fetchWithTimeout: send, apiUrl: 'https://example.test', sessionId: 'session', apiKey: 'test',
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
});
