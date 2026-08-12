/**
 * Integration test for the Antigravity capture path across an API outage.
 *
 * Reproduces the live incident of 2026-08-10 (session 8b603555): the handler
 * called `api.startSession()` BEFORE doing any capture and `return`ed when it
 * threw. A network blip spanning turn 1 meant all 9 of its PostToolUse fires
 * bailed, and two things broke at once:
 *
 *   1. turn 1's diff was lost outright, and
 *   2. `lastSyncShadow` never advanced — so when the network returned, turn 2
 *      diffed against turn 1's STARTING tree and was credited with every line
 *      turn 1 had written (103 of them; turn 2 had changed one).
 *
 * The unit tests next door cover the queue's merge semantics. THIS file exists
 * for the ordering: capture is pure git plumbing and must run before, and
 * independently of, any network call. Drive the real handler so that moving
 * startSession back above the capture fails loudly.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { execFileSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';

const startSession = vi.fn();
const updateSession = vi.fn();
const endSession = vi.fn();

vi.mock('../api.js', () => ({
  api: {
    startSession: (...a: any[]) => startSession(...a),
    updateSession: (...a: any[]) => updateSession(...a),
    endSession: (...a: any[]) => endSession(...a),
    ingestCommits: vi.fn(async () => ({ ingested: 1 })),
    importGitNote: vi.fn(async () => ({})),
  },
}));

vi.mock('../config.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../config.js')>();
  return {
    ...actual,
    isConnectedMode: () => true,
    loadAgentConfig: () => ({ machineId: 'test-machine' }),
  };
});

const { handleAntigravity } = await import('../commands/hooks.js');

let home: string;
let repo: string;
let transcriptPath: string;
let realHome: string | undefined;
const CID = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';

const git = (...args: string[]) =>
  execFileSync('git', args, { cwd: repo, stdio: 'pipe', encoding: 'utf-8' }).trim();

/** A transcript with `prompts.length` user turns, each editing `files`. */
function writeTranscript(prompts: string[], files: string[]) {
  const steps: any[] = [];
  prompts.forEach((p, i) => {
    steps.push({
      step_index: steps.length,
      source: 'USER_EXPLICIT',
      type: 'USER_INPUT',
      status: 'DONE',
      created_at: new Date(Date.UTC(2026, 7, 10, 16, 20 + i * 10, 0)).toISOString(),
      content: `<USER_REQUEST>\n${p}\n</USER_REQUEST>`,
    });
    steps.push({
      step_index: steps.length,
      source: 'MODEL',
      type: 'TOOL_CALL',
      status: 'DONE',
      created_at: new Date(Date.UTC(2026, 7, 10, 16, 21 + i * 10, 0)).toISOString(),
      content: 'working',
      tool_calls: files.map((f) => ({
        name: 'write_file',
        args: { file_path: path.join(repo, f) },
      })),
    });
  });
  fs.writeFileSync(transcriptPath, steps.map((s) => JSON.stringify(s)).join('\n'));
}

const cachePath = () => path.join(home, '.origin', 'agy-rules', `${CID}.json`);
const readCache = (): any => JSON.parse(fs.readFileSync(cachePath(), 'utf-8'));

const fire = (event = 'post-tool-use') =>
  handleAntigravity(event, { conversationId: CID, workspacePaths: [repo], transcriptPath, cwd: repo });

/**
 * agy fires PreToolUse before the first tool touches the tree; that is what
 * establishes the session's diff baseline (and it needs no network, which is
 * why the baseline survived the real outage while the captures did not).
 * Without it captureAgyDiff has nothing to diff against and returns empty by
 * design — so the fixture has to include it to be faithful.
 */
const firePreToolUse = () =>
  handleAntigravity('pre-tool-use', {
    conversationId: CID,
    workspacePaths: [repo],
    toolCall: { name: 'write_file', args: { file_path: path.join(repo, 'a.py') } },
    cwd: repo,
  });

beforeEach(async () => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'origin-agy-offline-')));
  home = path.join(root, 'home');
  repo = path.join(root, 'repo');
  fs.mkdirSync(home, { recursive: true });
  fs.mkdirSync(repo, { recursive: true });

  realHome = process.env.HOME;
  process.env.HOME = home;
  process.env.USERPROFILE = home;
  delete process.env.ORIGIN_AGY_IS_WATCHER;

  execFileSync('git', ['init', '-q', repo], { stdio: 'pipe' });
  git('config', 'user.email', 'a@test.dev');
  git('config', 'user.name', 'A');
  // Neutralize the developer's real global hooks for this fixture.
  git('config', 'core.hooksPath', path.join(repo, '.git', 'no-hooks'));
  fs.writeFileSync(path.join(repo, 'README.md'), 'seed\n');
  git('add', '.');
  git('commit', '-qm', 'seed');

  transcriptPath = path.join(root, 'transcript.jsonl');

  // A fresh watcher lock makes spawnAgyWatcher a no-op, so the test never
  // detaches a real background process.
  const lock = path.join(home, '.origin', 'agy-watch', `${CID}.lock`);
  fs.mkdirSync(path.dirname(lock), { recursive: true });
  fs.writeFileSync(lock, String(Date.now()));

  startSession.mockReset();
  updateSession.mockReset().mockResolvedValue({});
  endSession.mockReset().mockResolvedValue({});

  // Baseline on the CLEAN tree, before any test writes a file — same order agy
  // fires it in.
  await firePreToolUse();
});

afterEach(() => {
  if (realHome === undefined) delete process.env.HOME;
  else process.env.HOME = realHome;
});

describe('antigravity capture across an API outage', () => {
  it('captures and QUEUES the turn when startSession fails', async () => {
    fs.writeFileSync(path.join(repo, 'a.py'), 'print(1)\n'.repeat(20));
    writeTranscript(['turn one'], ['a.py']);

    startSession.mockRejectedValue(new Error('fetch failed'));
    await fire();

    // Nothing was sent…
    expect(updateSession).not.toHaveBeenCalled();
    // …but the work was captured to disk rather than lost.
    const cache = readCache();
    expect(cache.pendingPromptChanges).toHaveLength(1);
    expect(cache.pendingPromptChanges[0].promptIndex).toBe(0);
    expect(cache.pendingPromptChanges[0].filesChanged).toContain('a.py');
    expect(cache.pendingPromptChanges[0].linesAdded).toBeGreaterThan(0);
  });

  it('advances the baseline during the outage, so the NEXT turn cannot inherit its work', async () => {
    // This is the mis-attribution half of the incident.
    fs.writeFileSync(path.join(repo, 'a.py'), 'print(1)\n'.repeat(20));
    writeTranscript(['turn one'], ['a.py']);
    startSession.mockRejectedValue(new Error('fetch failed'));
    await fire();

    const shadowAfterOutage = readCache().lastSyncShadow;
    expect(shadowAfterOutage).toBeTruthy();

    // Network returns. Turn 2 makes a ONE-line change.
    fs.appendFileSync(path.join(repo, 'a.py'), '# one more line\n');
    writeTranscript(['turn one', 'turn two'], ['a.py']);
    startSession.mockResolvedValue({ sessionId: 'sess-1' });
    await fire();

    const sent = updateSession.mock.calls[0][1].promptChanges;
    const turn2 = sent.find((p: any) => p.promptIndex === 1);
    // Before the fix this was ~21 (all of turn 1's lines plus its own).
    expect(turn2.linesAdded).toBe(1);
  });

  it('flushes the queued turn onto its OWN turn when the network returns', async () => {
    fs.writeFileSync(path.join(repo, 'a.py'), 'print(1)\n'.repeat(20));
    writeTranscript(['turn one'], ['a.py']);
    startSession.mockRejectedValue(new Error('fetch failed'));
    await fire();

    fs.appendFileSync(path.join(repo, 'a.py'), '# one more line\n');
    writeTranscript(['turn one', 'turn two'], ['a.py']);
    startSession.mockResolvedValue({ sessionId: 'sess-1' });
    await fire();

    const sent = updateSession.mock.calls[0][1].promptChanges;
    const turn1 = sent.find((p: any) => p.promptIndex === 0);
    expect(turn1.filesChanged).toContain('a.py');
    expect(turn1.linesAdded).toBeGreaterThan(1);
    expect(turn1.diff).toContain('a.py');
  });

  it('clears the queue once the send that carried it lands', async () => {
    fs.writeFileSync(path.join(repo, 'a.py'), 'print(1)\n');
    writeTranscript(['turn one'], ['a.py']);
    startSession.mockRejectedValue(new Error('fetch failed'));
    await fire();
    expect(readCache().pendingPromptChanges).toHaveLength(1);

    writeTranscript(['turn one', 'turn two'], ['a.py']);
    startSession.mockResolvedValue({ sessionId: 'sess-1' });
    await fire();

    expect(readCache().pendingPromptChanges).toEqual([]);
  });

  it('keeps the queue when the flushing send itself fails', async () => {
    fs.writeFileSync(path.join(repo, 'a.py'), 'print(1)\n');
    writeTranscript(['turn one'], ['a.py']);
    startSession.mockRejectedValue(new Error('fetch failed'));
    await fire();

    // startSession recovers but the update does not — the queue must survive
    // for the next attempt rather than being dropped on the floor.
    writeTranscript(['turn one', 'turn two'], ['a.py']);
    startSession.mockResolvedValue({ sessionId: 'sess-1' });
    updateSession.mockRejectedValue(new Error('fetch failed'));
    await fire();

    expect(readCache().pendingPromptChanges).toHaveLength(1);
  });

  it('survives a multi-turn outage, giving every turn its own lines', async () => {
    startSession.mockRejectedValue(new Error('fetch failed'));

    fs.writeFileSync(path.join(repo, 'a.py'), 'a\n'.repeat(10));
    writeTranscript(['t1'], ['a.py']);
    await fire();

    fs.writeFileSync(path.join(repo, 'b.py'), 'b\n'.repeat(5));
    writeTranscript(['t1', 't2'], ['b.py']);
    await fire();

    expect(readCache().pendingPromptChanges).toHaveLength(2);

    fs.writeFileSync(path.join(repo, 'c.py'), 'c\n'.repeat(3));
    writeTranscript(['t1', 't2', 't3'], ['c.py']);
    startSession.mockResolvedValue({ sessionId: 'sess-1' });
    await fire();

    const sent = updateSession.mock.calls[0][1].promptChanges;
    const byIdx = (i: number) => sent.find((p: any) => p.promptIndex === i);
    expect(byIdx(0).filesChanged).toEqual(['a.py']);
    expect(byIdx(1).filesChanged).toEqual(['b.py']);
    expect(byIdx(2).filesChanged).toEqual(['c.py']);
  });

  it('does not queue anything when the API is reachable all along', async () => {
    fs.writeFileSync(path.join(repo, 'a.py'), 'print(1)\n');
    writeTranscript(['turn one'], ['a.py']);
    startSession.mockResolvedValue({ sessionId: 'sess-1' });
    await fire();

    expect(updateSession).toHaveBeenCalledTimes(1);
    expect(readCache().pendingPromptChanges || []).toEqual([]);
  });

  it('keeps the cache on a failed FINAL send, so a stop during an outage loses nothing', async () => {
    fs.writeFileSync(path.join(repo, 'a.py'), 'print(1)\n');
    writeTranscript(['turn one'], ['a.py']);
    startSession.mockRejectedValue(new Error('fetch failed'));
    await fire();

    writeTranscript(['turn one'], ['a.py']);
    startSession.mockResolvedValue({ sessionId: 'sess-1' });
    endSession.mockRejectedValue(new Error('fetch failed'));
    await fire('stop');

    // The cache is the only copy of the offline captures — deleting it here
    // would destroy exactly what the queue was protecting.
    expect(fs.existsSync(cachePath())).toBe(true);
    expect(readCache().pendingPromptChanges).toHaveLength(1);
  });
});
