// A file-set record is not a turn, and the verifier had no way to know.
//
// `registerAgySessionState` stores ONE `completedPromptMappings` entry holding
// every file an Antigravity session has touched, with no diff — an accumulator
// the git-hook path uses to match a commit's staged files back to the session
// that wrote them. Agy's real per-turn captures never go through that field;
// they are derived from the write journal and sent straight to the API.
//
// `origin verify-capture` reads that same field as if every entry were a turn
// capture, so it scored `files_without_content` on every agy session ever
// recorded — while the capture it was grading was correct. Two of the four
// contradictions left in the local corpus on 2026-09-04 were this, and being a
// permanent 100% failure for one producer it put a floor under a number that is
// also a CI gate (`--fail-on-contradiction`).
//
// The rule this pins: the flag must be PRESENT to skip a row. Absence conferring
// the exemption is how an optional wire field quietly makes a producer exempt.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { execFileSync } from 'child_process';
import { agySessionTag, registerAgySessionState } from '../commands/hooks/antigravity.js';
import { loadSessionState } from '../session-state.js';
import {
  verifySession,
  summarize,
  isFileSetRecord,
  type VerifiableTurn,
} from '../capture-verify.js';

const DIFF = [
  'diff --git a/cool_code.py b/cool_code.py',
  'new file mode 100644',
  'index 0000000..1111111',
  '--- /dev/null',
  '+++ b/cool_code.py',
  '@@ -0,0 +1,2 @@',
  '+import os',
  '+print(os.name)',
  '',
].join('\n');

describe('isFileSetRecord', () => {
  it('skips only a row that says so, so absence never confers the exemption', () => {
    expect(isFileSetRecord({ promptIndex: 0, fileSetOnly: true })).toBe(true);
    expect(isFileSetRecord({ promptIndex: 0 })).toBe(false);
    // A truthy-but-not-true flag is a producer bug; the safe reading is "grade it".
    expect(isFileSetRecord({ promptIndex: 0, fileSetOnly: 1 as unknown as boolean })).toBe(false);
    expect(isFileSetRecord(null)).toBe(false);
  });
});

describe('verifySession with a file-set record', () => {
  const accumulator: VerifiableTurn = {
    promptIndex: 0,
    filesChanged: ['sys_info.py', 'cool_code.py'],
    fileSetOnly: true,
  };

  it('does not grade it — the shape that read files_without_content forever', () => {
    expect(verifySession([accumulator])).toEqual([]);
  });

  it('grades the SAME row when the flag is absent', () => {
    const { fileSetOnly, ...unflagged } = accumulator;
    const codes = verifySession([unflagged]).map((v) => v.code);
    expect(codes).toContain('files_without_content');
  });

  it('counts it apart from turns instead of hiding it', () => {
    const turn: VerifiableTurn = { promptIndex: 1, filesChanged: ['cool_code.py'], diff: DIFF };
    const s = summarize([accumulator, turn], verifySession([accumulator, turn]));
    expect(s.turns).toBe(1);          // the accumulator is not a turn
    expect(s.fileSetRecords).toBe(1); // and it is not silently gone either
    expect(s.contradictions).toBe(0);
    expect(s.cleanTurns).toBe(1);
  });

  it('keeps the session-wide file list out of the cross-turn repeat rule', () => {
    // The accumulator restates files the real turns already carry. Graded as a
    // turn it would also manufacture `identical_change_in_two_turns`.
    const t1: VerifiableTurn = { promptIndex: 1, filesChanged: ['cool_code.py'], diff: DIFF };
    const t2: VerifiableTurn = { promptIndex: 2, filesChanged: ['cool_code.py'], diff: DIFF };
    const withAcc = verifySession([{ ...accumulator, diff: DIFF }, t1, t2]);
    const repeats = withAcc.filter((v) => v.code === 'identical_change_in_two_turns');
    // t1 and t2 genuinely repeat each other — one finding, naming those two.
    expect(repeats).toHaveLength(1);
    expect(repeats[0].detail).toContain('turns 1, 2');
  });
});

// The half that actually shipped broken: a rule the verifier honours is worth
// nothing if the producer never sets the flag. This calls the real writer and
// grades what it wrote.
describe('the agy writer marks its accumulator', () => {
  let repo: string;

  beforeEach(() => {
    repo = fs.mkdtempSync(path.join(os.tmpdir(), 'origin-agy-fileset-'));
    execFileSync('git', ['init', '-q'], { cwd: repo });
  });
  afterEach(() => {
    try { fs.rmSync(repo, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  it('writes fileSetOnly, and the verifier finds nothing to report', () => {
    registerAgySessionState({
      serverSessionId: 'srv-1',
      conversationId: 'conv-fileset-1',
      repoPath: repo,
      model: 'gemini-3.1-pro',
      transcriptPath: path.join(repo, 'transcript.json'),
      prompts: ['make a utility script', 'add sys info'],
      filesChanged: ['sys_info.py', 'cool_code.py'],
    });

    const state = loadSessionState(repo, agySessionTag('conv-fileset-1'));
    const mappings = state?.completedPromptMappings || [];
    expect(mappings).toHaveLength(1);
    expect(mappings[0].filesChanged.sort()).toEqual(['cool_code.py', 'sys_info.py']);
    expect(mappings[0].fileSetOnly).toBe(true);

    const rows = mappings as unknown as VerifiableTurn[];
    expect(verifySession(rows)).toEqual([]);
    expect(summarize(rows, []).fileSetRecords).toBe(1);
  });
});
