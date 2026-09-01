/**
 * Antigravity's Stop hook is a TURN boundary, not a process exit.
 *
 * Origin's agy capture was written against builds that fired Stop only when the
 * CLI exited, so the stop branch called api.endSession() — COMPLETING the row.
 * Current builds fire Stop at the end of every turn. Proven from the live hook
 * log for conversation ddc56723 (repo korop): Stops at 13:23, 13:25, 13:27 and
 * 13:41, each followed by more Pre/PostToolUse fires from the same agy process,
 * and each one flipping the session to "Completed" while the user was still
 * working in it (the next turn's /session/start silently re-opened it, so the
 * badge flickered per turn and rested on Completed).
 *
 * Stop must therefore behave like the per-turn "session end" every other IDE
 * agent fires: send the turn's final state as an UPDATE and leave the session
 * RUNNING, so the server's normal lifecycle (IDLE at 1h, COMPLETED by the
 * activity-idle sweep at 3h) decides when it is over.
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
const CID = 'ddc56723-9d5b-4551-aeea-0842101c02fc';

const git = (...args: string[]) =>
  execFileSync('git', args, { cwd: repo, stdio: 'pipe', encoding: 'utf-8' }).trim();

function writeTranscript(prompts: string[], files: string[]) {
  const steps: any[] = [];
  prompts.forEach((p, i) => {
    steps.push({
      step_index: steps.length,
      source: 'USER_EXPLICIT',
      type: 'USER_INPUT',
      status: 'DONE',
      created_at: new Date(Date.UTC(2026, 7, 24, 13, 20 + i * 5, 0)).toISOString(),
      content: `<USER_REQUEST>\n${p}\n</USER_REQUEST>`,
    });
    steps.push({
      step_index: steps.length,
      source: 'MODEL',
      type: 'TOOL_CALL',
      status: 'DONE',
      created_at: new Date(Date.UTC(2026, 7, 24, 13, 21 + i * 5, 0)).toISOString(),
      content: 'working',
      tool_calls: files.map((f) => ({ name: 'write_file', args: { file_path: path.join(repo, f) } })),
    });
  });
  fs.writeFileSync(transcriptPath, steps.map((s) => JSON.stringify(s)).join('\n'));
}

const fire = (event: string) =>
  handleAntigravity(event, { conversationId: CID, workspacePaths: [repo], transcriptPath, cwd: repo });

const firePreToolUse = () =>
  handleAntigravity('pre-tool-use', {
    conversationId: CID,
    workspacePaths: [repo],
    toolCall: { name: 'write_file', args: { file_path: path.join(repo, 'a.py') } },
    cwd: repo,
  });

const cachePath = () => path.join(home, '.origin', 'agy-rules', `${CID}.json`);
const stateFile = () => path.join(repo, '.git', `origin-session-agy-${CID.slice(0, 12)}.json`);

beforeEach(async () => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'origin-agy-stop-')));
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
  git('config', 'core.hooksPath', path.join(repo, '.git', 'no-hooks'));
  fs.writeFileSync(path.join(repo, 'README.md'), 'seed\n');
  git('add', '.');
  git('commit', '-qm', 'seed');

  transcriptPath = path.join(root, 'transcript.jsonl');

  // A fresh watcher lock keeps spawnAgyWatcher a no-op — no detached process.
  const lock = path.join(home, '.origin', 'agy-watch', `${CID}.lock`);
  fs.mkdirSync(path.dirname(lock), { recursive: true });
  fs.writeFileSync(lock, String(Date.now()));

  startSession.mockReset().mockResolvedValue({ sessionId: 'sess-agy-1' });
  updateSession.mockReset().mockResolvedValue({});
  endSession.mockReset().mockResolvedValue({});

  await firePreToolUse();
});

afterEach(() => {
  if (realHome === undefined) delete process.env.HOME;
  else process.env.HOME = realHome;
});

describe('agy Stop closes a turn, not the session', () => {
  it('sends the turn as an update and never ends the session', async () => {
    fs.writeFileSync(path.join(repo, 'a.py'), 'print(1)\n'.repeat(10));
    writeTranscript(['build the timer'], ['a.py']);

    await fire('stop');

    // The bug: this was api.endSession(), which COMPLETES the row mid-session.
    expect(endSession).not.toHaveBeenCalled();
    expect(updateSession).toHaveBeenCalledTimes(1);

    const [sentId, payload] = updateSession.mock.calls[0];
    expect(sentId).toBe('sess-agy-1');
    // Stop still carries the full final state of the turn — no capture lost.
    expect(payload.prompt).toContain('build the timer');
    expect(payload.transcript).toBeTruthy();
    expect(payload.promptChanges[0].filesChanged).toContain('a.py');
    // …and nothing in it asks the server to close the session.
    expect(payload.status).toBeUndefined();
  });

  it('keeps the local session state RUNNING so the next commit still has an owner', async () => {
    fs.writeFileSync(path.join(repo, 'a.py'), 'print(1)\n'.repeat(10));
    writeTranscript(['build the timer'], ['a.py']);

    await fire('stop');

    // Stop used to mark the state ENDED and archive it, retiring a session that
    // was still working — a commit landing next would find no candidate to own.
    const state = JSON.parse(fs.readFileSync(stateFile(), 'utf-8'));
    expect(state.status).toBe('RUNNING');
    expect(state.endedAt).toBeUndefined();
    expect(state.sessionId).toBe('sess-agy-1');
  });

  it('keeps the diff baselines, so the turn AFTER a stop reports only its own lines', async () => {
    // Stop used to delete the conversation cache. With a per-turn Stop that
    // wipes baselineSha/lastSyncShadow mid-session, and the next turn re-reports
    // the whole cumulative session as its own work.
    fs.writeFileSync(path.join(repo, 'a.py'), 'print(1)\n'.repeat(20));
    writeTranscript(['turn one'], ['a.py']);
    await fire('stop');

    expect(fs.existsSync(cachePath())).toBe(true);
    expect(JSON.parse(fs.readFileSync(cachePath(), 'utf-8')).lastSyncShadow).toBeTruthy();

    // Same conversation continues: turn 2 adds exactly one line.
    fs.appendFileSync(path.join(repo, 'a.py'), '# one more line\n');
    writeTranscript(['turn one', 'turn two'], ['a.py']);
    await fire('post-tool-use');

    const sent = updateSession.mock.calls.at(-1)![1].promptChanges;
    const turn2 = sent.find((p: any) => p.promptIndex === 1);
    expect(turn2.linesAdded).toBe(1);
  });
});
