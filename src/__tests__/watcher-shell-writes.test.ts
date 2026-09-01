/**
 * Shell writes must reach editsJson for agents that fire NO hooks.
 *
 * The hook path records a write-shaped shell command live at PostToolUse and
 * resolves it at Stop (cli-v0.20260820.2238). Gemini, Antigravity and hookless
 * Cursor never fire those hooks — the poll-based watcher is their only capture
 * route, and it had no way to tell a heredoc from `ls`: `ParsedSession` carried
 * a tool-call COUNT and nothing else. So those turns still shipped `edits: []`,
 * which every read surface has to treat as "chat-only".
 *
 * The signal now rides the same tool-call walk that already spots `git commit`.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { execFileSync } from 'child_process';
import { extractPromptFileMappings } from '../transcript.js';
import { createShadowCommit, captureShadowRangeDiff, filesChangedSinceShadow, readFileAtRev } from '../git-capture.js';
import { shellWindowEdits, SHELL_WINDOW_SOURCE } from '../shell-write-capture.js';
import { transcriptWriterTurns, filesRecordedForOtherTurns } from '../transcript-attribution.js';

const gitIn = (dir: string, args: string[]) =>
  execFileSync('git', args, { cwd: dir, encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] }).toString();

const userTurn = (text: string) => JSON.stringify({
  type: 'user',
  message: { role: 'user', content: [{ type: 'text', text }] },
});
const shellTurn = (command: string) => JSON.stringify({
  type: 'assistant',
  message: { role: 'assistant', content: [{ type: 'tool_use', name: 'Bash', input: { command } }] },
});

describe('transcript parse — which turns wrote through the shell', () => {
  let dir: string;
  beforeEach(() => { dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'origin-wsw-'))); });
  afterEach(() => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ } });

  const write = (lines: string[]): string => {
    const p = path.join(dir, 't.jsonl');
    fs.writeFileSync(p, lines.join('\n'));
    return p;
  };

  it('flags only the turn that could have written', () => {
    const p = write([
      userTurn('turn zero: look around'),
      shellTurn('ls -la; git status --short; grep -rn foo src/'),
      userTurn('turn one: patch the config'),
      shellTurn("python3 - <<'PY'\nopen('next.config.ts','w').write(s)\nPY"),
      userTurn('turn two: just talk'),
    ]);
    const flagged = extractPromptFileMappings(p).filter((m) => m.wroteViaShell).map((m) => m.promptIndex);
    expect(flagged).toEqual([1]);
  });

  it('leaves a turn with no shell call alone', () => {
    const p = write([userTurn('hello'), userTurn('goodbye')]);
    expect(extractPromptFileMappings(p).some((m) => m.wroteViaShell)).toBe(false);
  });
});

describe('watcher window — bounded by the NEXT turn, not the working tree', () => {
  let dir: string;
  beforeEach(() => {
    dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'origin-wsw-git-')));
    gitIn(dir, ['init', '-q']);
    gitIn(dir, ['config', 'user.email', 't@t.co']);
    gitIn(dir, ['config', 'user.name', 'T']);
    gitIn(dir, ['config', 'commit.gpgsign', 'false']);
    fs.writeFileSync(path.join(dir, 'a.txt'), 'one\n');
    gitIn(dir, ['add', '-A']);
    gitIn(dir, ['commit', '-q', '-m', 'seed']);
  });
  afterEach(() => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ } });

  const baseline = (): string =>
    createShadowCommit(dir, 'watch-test') || gitIn(dir, ['rev-parse', 'HEAD']).trim();

  const editsFor = (from: string, to: string | null) => shellWindowEdits(
    {
      listChangedFiles: () => (to
        ? captureShadowRangeDiff(dir, from, to).filesChanged
        : filesChangedSinceShadow(dir, from)),
      readAtRev: (sha, file) => readFileAtRev(dir, sha, file),
      readWorking: (file) => (to
        ? readFileAtRev(dir, to, file)
        : (fs.existsSync(path.join(dir, file)) ? fs.readFileSync(path.join(dir, file), 'utf-8') : null)),
    },
    { baselineSha: from },
  ).edits;

  it('gives a finished turn ONLY its own work, not the turns after it', () => {
    // This is the whole reason the watcher can't reuse the hook path's
    // baseline→worktree window: by the time it polls, later turns have run.
    const turn0 = baseline();
    fs.writeFileSync(path.join(dir, 'a.txt'), 'one\ntwo\n');   // turn 0's write
    const turn1 = baseline();
    fs.writeFileSync(path.join(dir, 'b.txt'), 'turn one\n');    // turn 1's write
    const turn2 = baseline();
    fs.writeFileSync(path.join(dir, 'c.txt'), 'turn two\n');    // turn 2, still open

    expect(editsFor(turn0, turn1).map((e) => e.file)).toEqual(['a.txt']);
    expect(editsFor(turn1, turn2).map((e) => e.file)).toEqual(['b.txt']);
    // The newest turn has no successor, so it reads the working tree.
    expect(editsFor(turn2, null).map((e) => e.file)).toEqual(['c.txt']);
  });

  it('carries the content both sides, so the server can render a real diff', () => {
    const turn0 = baseline();
    fs.writeFileSync(path.join(dir, 'a.txt'), 'one\ntwo\n');
    const turn1 = baseline();

    const [edit] = editsFor(turn0, turn1);
    expect(edit).toMatchObject({
      file: 'a.txt',
      op: 'edit',
      oldContent: 'one\n',
      newContent: 'one\ntwo\n',
      source: 'uncommitted',
      backfillSource: SHELL_WINDOW_SOURCE,
    });
  });

  it('still sees a turn whose work was committed within the turn', () => {
    const turn0 = baseline();
    fs.writeFileSync(path.join(dir, 'a.txt'), 'one\ntwo\n');
    gitIn(dir, ['add', '-A']);
    gitIn(dir, ['commit', '-q', '-m', 'committed inside the turn']);
    const turn1 = baseline();

    expect(editsFor(turn0, turn1).map((e) => e.file)).toEqual(['a.txt']);
  });
});

// The window above is only as good as its right-hand edge, and that edge is a
// POLL. A turn's baseline is taken when the watcher NOTICES the turn, so a fast
// agent's first writes are already on disk by then and fall inside the previous
// turn's window. Prod session 376cc22f: turn 2 wrote README.md and turn 1's
// window claimed it, so the session rendered turn 2 as two files and turn 1 as
// five. The transcript said all along which turn wrote it.
describe('watcher window — a late baseline must not hand one turn another\'s file', () => {
  let dir: string;
  beforeEach(() => {
    dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'origin-wsw-late-')));
    gitIn(dir, ['init', '-q']);
    gitIn(dir, ['config', 'user.email', 't@t.co']);
    gitIn(dir, ['config', 'user.name', 'T']);
    gitIn(dir, ['config', 'commit.gpgsign', 'false']);
    fs.writeFileSync(path.join(dir, 'README.md'), '# proj\n');
    fs.writeFileSync(path.join(dir, 'analytics.py'), 'print(1)\n');
    gitIn(dir, ['add', '-A']);
    gitIn(dir, ['commit', '-q', '-m', 'seed']);
  });
  afterEach(() => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ } });

  const baseline = (): string =>
    createShadowCommit(dir, 'watch-test') || gitIn(dir, ['rev-parse', 'HEAD']).trim();

  const editsFor = (from: string, to: string, covered: string[]) => shellWindowEdits(
    {
      listChangedFiles: () => captureShadowRangeDiff(dir, from, to).filesChanged,
      readAtRev: (sha, file) => readFileAtRev(dir, sha, file),
      readWorking: (file) => readFileAtRev(dir, to, file),
    },
    { baselineSha: from, coveredFiles: covered },
  ).edits;

  // Turn 1 runs `python analytics.py` (write-shaped, so it gets a window) and
  // writes app.js. Turn 2 then writes README.md — and the poll only notices
  // turn 2 AFTER that write, so turn 2's baseline already contains it.
  const runSession = () => {
    const turn1Baseline = baseline();
    fs.writeFileSync(path.join(dir, 'app.js'), 'let a = 1;\n');           // turn 1's own work
    fs.appendFileSync(path.join(dir, 'README.md'), 'docs for the app\n'); // TURN 2's work
    const turn2BaselineTakenLate = baseline();
    return { turn1Baseline, turn2BaselineTakenLate };
  };

  it('reproduces the defect: without the transcript, turn 1 claims turn 2\'s README.md', () => {
    const { turn1Baseline, turn2BaselineTakenLate } = runSession();
    const files = editsFor(turn1Baseline, turn2BaselineTakenLate, []).map((e) => e.file).sort();
    expect(files).toEqual(['README.md', 'app.js']);
  });

  it('keeps README.md out of turn 1 once the transcript names turn 2 as its writer', () => {
    const { turn1Baseline, turn2BaselineTakenLate } = runSession();
    // What the watcher now feeds into coveredFiles — the agent's own
    // write_to_file records, per turn.
    const writers = transcriptWriterTurns(
      [
        { promptIndex: 1, edits: [{ file: path.join(dir, 'app.js') }] },
        { promptIndex: 2, edits: [{ file: path.join(dir, 'README.md') }] },
      ],
      (f) => path.relative(dir, f).split(path.sep).join('/') || null,
    );
    const covered = filesRecordedForOtherTurns(writers, 1);
    expect(covered).toEqual(['README.md']);

    const files = editsFor(turn1Baseline, turn2BaselineTakenLate, covered).map((e) => e.file);
    expect(files).toEqual(['app.js']);
  });

  it('still lets turn 1 claim a file the transcript says BOTH turns wrote', () => {
    // Shielding a genuinely shared file would delete the second turn's real work.
    const { turn1Baseline, turn2BaselineTakenLate } = runSession();
    const writers = transcriptWriterTurns(
      [
        { promptIndex: 1, edits: [{ file: path.join(dir, 'README.md') }] },
        { promptIndex: 2, edits: [{ file: path.join(dir, 'README.md') }] },
      ],
      (f) => path.relative(dir, f).split(path.sep).join('/') || null,
    );
    expect(filesRecordedForOtherTurns(writers, 1)).toEqual([]);
    const files = editsFor(turn1Baseline, turn2BaselineTakenLate, []).map((e) => e.file).sort();
    expect(files).toEqual(['README.md', 'app.js']);
  });
});
