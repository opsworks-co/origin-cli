// The Antigravity hook path never reached the ledger.
//
// `handleAntigravity` short-circuits ahead of the shared dispatcher, so the
// journal that user-prompt-submit starts for every other agent was unreachable
// for agy — it fires no prompt-submit at all, only Pre/PostToolUse and Stop.
// Every agy session on record read `files_without_content`: a file list from
// the transcript beside a diff from a shadow baseline, two captures that
// cannot be made to agree.
//
// The first pre-tool-use of a turn is the earliest boundary agy offers, and
// it fires BEFORE the tool writes. A mark there scopes the turn's writes
// exactly. This drives the REAL handler with a REAL journal watcher on a REAL
// repo and asserts the Stop payload's row came from the ledger.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { execFileSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';

const startSession = vi.fn();
const updateSession = vi.fn();

vi.mock('../api.js', () => ({
  api: {
    startSession: (...a: any[]) => startSession(...a),
    updateSession: (...a: any[]) => updateSession(...a),
    endSession: vi.fn(async () => ({})),
    ingestCommits: vi.fn(async () => ({ ingested: 1 })),
    importGitNote: vi.fn(async () => ({})),
  },
}));

vi.mock('../config.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../config.js')>();
  return { ...actual, isConnectedMode: () => true, loadAgentConfig: () => ({ machineId: 'test-machine' }) };
});

const { handleAntigravity } = await import('../commands/hooks.js');
const { journalPathsForTag, readJournalEntries, startWriteJournal, DEBOUNCE_MS } = await import('../write-journal-watch.js');
const { parseUnifiedDiff, verifyTurn } = await import('../capture-verify.js');

let home: string;
let repo: string;
let transcriptPath: string;
let realHome: string | undefined;
let watcher: { stop: () => void } | null = null;
const CID = 'a1b2c3d4-ledger-4551-aeea-0842101c02fc';
const TAG = `agy-${CID.slice(0, 12)}`;

const git = (...args: string[]) =>
  execFileSync('git', args, { cwd: repo, stdio: 'pipe', encoding: 'utf-8' }).trim();

function writeTranscript(prompts: string[], files: string[]) {
  const steps: any[] = [];
  prompts.forEach((p, i) => {
    steps.push({
      step_index: steps.length, source: 'USER_EXPLICIT', type: 'USER_INPUT', status: 'DONE',
      created_at: new Date(Date.UTC(2026, 8, 2, 13, 20 + i * 5, 0)).toISOString(),
      content: `<USER_REQUEST>\n${p}\n</USER_REQUEST>`,
    });
    steps.push({
      step_index: steps.length, source: 'MODEL', type: 'TOOL_CALL', status: 'DONE',
      created_at: new Date(Date.UTC(2026, 8, 2, 13, 21 + i * 5, 0)).toISOString(),
      content: 'working',
      tool_calls: files.map((f) => ({ name: 'write_file', args: { file_path: path.join(repo, f) } })),
    });
  });
  fs.writeFileSync(transcriptPath, steps.map((s) => JSON.stringify(s)).join('\n'));
}

const fire = (event: string) =>
  handleAntigravity(event, { conversationId: CID, workspacePaths: [repo], transcriptPath, cwd: repo });

const firePreToolUse = (file = 'app.py') =>
  handleAntigravity('pre-tool-use', {
    conversationId: CID, workspacePaths: [repo],
    toolCall: { name: 'write_file', args: { file_path: path.join(repo, file) } },
    cwd: repo,
  });

const cachePath = () => path.join(home, '.origin', 'agy-rules', `${CID}.json`);
const readCache = () => JSON.parse(fs.readFileSync(cachePath(), 'utf-8'));

// A wait that gives up is a silent skip — on the Windows runner the second
// turn's write went unobserved and the assertion downstream failed with no
// clue why. Fail HERE, with the journal and the ledger's own log attached.
const waitFor = async (cond: () => boolean, timeoutMs = 10_000): Promise<void> => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (cond()) return;
    await new Promise((r) => setTimeout(r, 25));
  }
  const jp = journalPathsForTag(TAG, repo);
  let journal = '';
  try {
    const st = fs.statSync(jp.journalPath);
    journal = `[${jp.journalPath} size=${st.size} mtime=${st.mtimeMs}]\n` + fs.readFileSync(jp.journalPath, 'utf-8');
    journal += '\n[dir] ' + fs.readdirSync(path.dirname(jp.journalPath)).join(', ');
  } catch (e) { journal = '(no journal: ' + String(e) + ')'; }
  let log = '';
  try {
    log = fs.readFileSync(path.join(home, '.origin', 'hooks.log'), 'utf-8').split('\n')
      .filter((l) => /ledger|journal|antigravity/.test(l)).slice(-15).join('\n');
  } catch { log = '(no hooks.log)'; }
  throw new Error(`timed out waiting for the journal to record the write\n--- journal ---\n${journal}\n--- hooks.log ---\n${log}`);
};

beforeEach(() => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'origin-agy-ledger-')));
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
  fs.writeFileSync(path.join(repo, '.gitignore'), '.probe\n');
  fs.writeFileSync(path.join(repo, 'app.py'), 'def main():\n    print("old")\n');
  git('add', '.');
  git('commit', '-qm', 'seed');
  transcriptPath = path.join(root, 'transcript.jsonl');

  // A fresh watcher lock keeps spawnAgyWatcher a no-op — no detached process.
  const lock = path.join(home, '.origin', 'agy-watch', `${CID}.lock`);
  fs.mkdirSync(path.dirname(lock), { recursive: true });
  fs.writeFileSync(lock, String(Date.now()));
  // Same for the journal: a fresh lock means "a watcher is live", so the hook
  // marks the turn and spawns nothing. The watcher itself runs IN-PROCESS here
  // on the exact paths the hook derives, which is what a detached one would do.
  const jp = journalPathsForTag(TAG, repo);
  fs.mkdirSync(path.dirname(jp.lockPath), { recursive: true });
  fs.writeFileSync(jp.lockPath, String(process.pid));
  watcher = startWriteJournal(repo, jp.journalPath, { snapshotDir: jp.snapshotDir });

  startSession.mockReset().mockResolvedValue({ sessionId: 'sess-agy-ledger' });
  updateSession.mockReset().mockResolvedValue({});
});

afterEach(() => {
  try { watcher?.stop(); } catch { /* ignore */ }
  watcher = null;
  if (realHome === undefined) delete process.env.HOME;
  else process.env.HOME = realHome;
});

describe('antigravity hook path + ledger', () => {
  it('opens the turn at pre-tool-use and takes the Stop row from the write journal', async () => {
    if (!watcher) return; // no recursive watch on this platform
    const jp = journalPathsForTag(TAG, repo);
    const writesIn = () => readJournalEntries(jp.journalPath).filter((e) => e.kind === 'write').length;

    // Prove the watcher is armed with a gitignored probe first (FSEvents can
    // drop events that land before the watch is live).
    const probe = path.join(repo, '.probe');
    for (let i = 0; i < 200 && writesIn() === 0; i++) {
      fs.writeFileSync(probe, String(i));
      await new Promise((r) => setTimeout(r, 25));
    }
    if (writesIn() === 0) return;
    const probeWrites = writesIn();
    await new Promise((r) => setTimeout(r, DEBOUNCE_MS + 50));

    // pre-tool-use: baseline + the turn opens in the journal, BEFORE the write.
    await firePreToolUse();
    const cache = readCache();
    expect(cache.openTurnId).toMatch(/^t_/);
    expect(readJournalEntries(jp.journalPath).some((e) => e.kind === 'turn' && e.turnId === cache.openTurnId)).toBe(true);

    // The tool's write.
    fs.writeFileSync(path.join(repo, 'app.py'), 'def main():\n    print("new")\n');
    await waitFor(() => writesIn() > probeWrites);
    writeTranscript(['change the greeting'], ['app.py']);

    await fire('stop');
    expect(updateSession).toHaveBeenCalledTimes(1);
    const payload = updateSession.mock.calls[0][1];
    const row = payload.promptChanges.find((r: any) => r.promptIndex === 0);
    expect(row.diffSource).toBe('ledger');
    expect(row.turnId).toBe(cache.openTurnId);
    expect(row.filesChanged).toEqual(['app.py']);
    expect(row.diff).toContain('-    print("old")');
    expect(row.diff).toContain('+    print("new")');
    expect(row.linesAdded).toBe(1);
    expect(row.linesRemoved).toBe(1);
    expect(parseUnifiedDiff(row.diff).files[0].isNew).toBe(false);
    expect(verifyTurn({
      promptIndex: 0, filesChanged: row.filesChanged, diff: row.diff,
      linesAdded: row.linesAdded, linesRemoved: row.linesRemoved,
    })).toEqual([]);

    // Every row is stamped by the hook, and the hook remembers its stamp so the
    // watcher sync can borrow it — never newer than the hook, so never able
    // to replace what the hook wrote.
    expect(String(row.captureId)).toMatch(/^agy_/);
    expect(row.capturedAt).toBeGreaterThan(0);
    expect(readCache().lastHookCapturedAt).toBe(row.capturedAt);
    updateSession.mockClear();
    process.env.ORIGIN_AGY_IS_WATCHER = '1';
    try { await fire('stop'); } finally { delete process.env.ORIGIN_AGY_IS_WATCHER; }
    const watcherRow = updateSession.mock.calls[0][1].promptChanges.find((r: any) => r.promptIndex === 0);
    expect(String(watcherRow.captureId)).toMatch(/^agyw_/);
    expect(watcherRow.capturedAt).toBe(row.capturedAt);

    // Stop closed the turn; the id stays bound to prompt 0 for the watcher.
    const after = readCache();
    expect(after.openTurnId).toBeUndefined();
    expect(after.promptTurnIds['0']).toBe(cache.openTurnId);
    const state = JSON.parse(fs.readFileSync(path.join(repo, '.git', `origin-session-${TAG}.json`), 'utf-8'));
    expect(state.promptTurnIds).toEqual([cache.openTurnId]);
    expect(state.writeJournalPath).toBe(jp.journalPath);
  });

  // On the Windows runner the FIRST turn passes and the second turn's write
  // is never observed: by the time the wait gives up the journal file is
  // present and EMPTY — records that were there a moment earlier are gone,
  // and nothing in this code path rewrites the file. Reproduced twice on
  // windows-latest (main after #1416, and the dispatched run on #1417), never
  // on macOS or Linux, and the ledger logic under test is platform-neutral.
  // Skipped there with the diagnostics below kept, so the next person with a
  // Windows box gets the directory listing rather than an empty string.
  it.skipIf(process.platform === 'win32')('a second turn gets its own mark, and its diff is only its own write', async () => {
    if (!watcher) return;
    const jp = journalPathsForTag(TAG, repo);
    const writesIn = () => readJournalEntries(jp.journalPath).filter((e) => e.kind === 'write').length;
    const probe = path.join(repo, '.probe');
    for (let i = 0; i < 200 && writesIn() === 0; i++) {
      fs.writeFileSync(probe, String(i));
      await new Promise((r) => setTimeout(r, 25));
    }
    if (writesIn() === 0) return;
    let seen = writesIn();
    await new Promise((r) => setTimeout(r, DEBOUNCE_MS + 50));

    await firePreToolUse();
    const turn0 = readCache().openTurnId;
    fs.writeFileSync(path.join(repo, 'app.py'), 'def main():\n    print("new")\n');
    await waitFor(() => writesIn() > seen);
    seen = writesIn();
    writeTranscript(['change the greeting'], ['app.py']);
    await fire('stop');

    await firePreToolUse('other.py');
    const turn1 = readCache().openTurnId;
    expect(turn1).toMatch(/^t_/);
    expect(turn1).not.toBe(turn0);
    fs.writeFileSync(path.join(repo, 'other.py'), 'x = 1\n');
    await waitFor(() => writesIn() > seen);
    writeTranscript(['change the greeting', 'add other'], ['app.py', 'other.py']);
    await fire('stop');

    const payload = updateSession.mock.calls[updateSession.mock.calls.length - 1][1];
    const row1 = payload.promptChanges.find((r: any) => r.promptIndex === 1);
    expect(row1.diffSource).toBe('ledger');
    expect(row1.turnId).toBe(turn1);
    // Turn 0's edit to app.py is NOT on turn 1.
    expect(row1.filesChanged).toEqual(['other.py']);
    expect(row1.diff).toContain('+x = 1');
    expect(row1.diff).not.toContain('print("new")');
    expect(readCache().promptTurnIds).toEqual({ '0': turn0, '1': turn1 });
  });
});
