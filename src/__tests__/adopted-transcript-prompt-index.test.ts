// Origin adopting a transcript that already has history — installed
// mid-conversation, or `--resume` carrying a prior conversation forward.
//
// A promptIndex is a POSITION IN A LIST, so the two functions that produce one
// only agree if they enumerate the same prompts. parseTranscript has always
// scoped to the session (`since: state.startedAt`); extractPromptFileMappings
// enumerated the whole file from 0. On a fresh transcript the two are identical
// and nothing is wrong — the divergence only appears once the file holds turns
// from before the session, which is exactly the adoption case.
//
// Prod ff3ac057: transcript opened 2026-08-18, session started 2026-08-19.
// The session owned 32 prompts and shipped 45 mappings whose first 13 were the
// previous day's conversation. Every live-captured diff was written to a row 13
// positions earlier than the turn that produced it, so the dashboard listed 44
// turns, showed changes on 13, and rendered "No response or code changes
// captured" on the turns Origin had actually watched.
//
// The fix drops the out-of-session ROWS but keeps each surviving turn's NATIVE
// index. Renumbering from 0 looks tidier and breaks two things: a RESUMED
// session keeps its server rows, so restarting at 0 overwrites turns another
// session already recorded (prod 3bfa24e6 — its three fresh turns would have
// replaced rows holding "Why AI blame…" +49 and "now fix the capture side…"
// 7 files/+239); and the server stamps partialCapture /
// firstCapturedPromptIndex from the smallest incoming index, which a 0
// silently disables.

import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { parseTranscript, extractPromptFileMappings } from '../transcript.js';
import { homePromptIndexByText } from '../session-state.js';

const SESSION_START = '2026-08-19T18:48:53.878Z';

function userTurn(ts: string, text: string) {
  return JSON.stringify({ type: 'user', timestamp: ts, message: { role: 'user', content: text } });
}

function editTurn(ts: string, file: string) {
  return JSON.stringify({
    type: 'assistant',
    timestamp: ts,
    message: {
      role: 'assistant',
      id: `msg_${ts}`,
      model: 'claude-opus-5',
      content: [{
        type: 'tool_use',
        id: `toolu_${ts}`,
        name: 'Write',
        input: { file_path: file, content: 'hello\n' },
      }],
    },
  });
}

/** Two turns from the day before, then three the session actually watched. */
function writeAdoptedTranscript(): string {
  const lines = [
    // ── before the session started (a different day's conversation) ──
    userTurn('2026-08-18T19:21:12.063Z', 'why prompt 2 didnt capture changes'),
    editTurn('2026-08-18T19:22:00.000Z', 'old/a.ts'),
    userTurn('2026-08-18T20:05:00.000Z', 'yes, fix it and add the regression test'),
    editTurn('2026-08-18T20:06:00.000Z', 'old/b.ts'),
    // ── after Origin adopted the transcript ──
    userTurn('2026-08-19T18:50:00.000Z', 'check the state file now'),
    editTurn('2026-08-19T18:51:00.000Z', 'src/one.ts'),
    userTurn('2026-08-19T19:10:00.000Z', 'yes, fix it and verify with a re-attach'),
    editTurn('2026-08-19T19:11:00.000Z', 'src/two.ts'),
    userTurn('2026-08-19T19:40:00.000Z', 'merge and deploy it'),
    editTurn('2026-08-19T19:41:00.000Z', 'src/three.ts'),
  ];
  const f = path.join(
    fs.mkdtempSync(path.join(os.tmpdir(), 'origin-adopted-')),
    'transcript.jsonl',
  );
  fs.writeFileSync(f, lines.join('\n') + '\n');
  return f;
}

describe('adopted transcript — prompt index space', () => {
  it('scopes mappings to the session, exactly as parseTranscript does', () => {
    const f = writeAdoptedTranscript();

    const parsed = parseTranscript(f, { since: SESSION_START });
    const mappings = extractPromptFileMappings(f, { since: SESSION_START });

    expect(parsed.prompts).toEqual([
      'check the state file now',
      'yes, fix it and verify with a re-attach',
      'merge and deploy it',
    ]);
    // Same turns, same order — and the indices are the NATIVE ones (two turns
    // ran before the session), not a fresh 0,1,2.
    expect(mappings.map((m) => m.promptText)).toEqual(parsed.prompts);
    expect(mappings.map((m) => m.promptIndex)).toEqual([2, 3, 4]);
  });

  it('gives each turn its own diff, not one thirteen rows earlier', () => {
    const f = writeAdoptedTranscript();
    const mappings = extractPromptFileMappings(f, { since: SESSION_START });

    expect(mappings[0].filesChanged).toEqual(['src/one.ts']);
    expect(mappings[1].filesChanged).toEqual(['src/two.ts']);
    expect(mappings[2].filesChanged).toEqual(['src/three.ts']);
    // Native numbering is what keeps a resumed session's existing rows safe.
    expect(mappings.map((m) => m.promptIndex)).toEqual([2, 3, 4]);
    expect(Math.min(...mappings.map((m) => m.promptIndex))).toBeGreaterThan(0);
    // Nothing from before the session may appear at all — those rows belong to
    // another session and carry another day's work.
    const allFiles = mappings.flatMap((m) => m.filesChanged);
    expect(allFiles.some((p) => p.startsWith('old/'))).toBe(false);
  });

  it('is the prod ff3ac057 shape: the current turn keeps the index it is announced under', () => {
    const f = writeAdoptedTranscript();

    const parsed = parseTranscript(f, { since: SESSION_START });
    const mappings = extractPromptFileMappings(f, { since: SESSION_START });

    // handleStop announces the current turn as
    // `promptIndexBase + prompts.length - 1` and writes its diff to the mapping
    // holding that index. Those must be the same turn.
    expect(parsed.promptIndexBase).toBe(2);
    const currentIdx = parsed.promptIndexBase + parsed.prompts.length - 1;
    expect(currentIdx).toBe(4);
    const current = mappings.find((m) => m.promptIndex === currentIdx)!;
    expect(current.promptText).toBe(parsed.prompts[parsed.prompts.length - 1]);
    expect(current.filesChanged).toEqual(['src/three.ts']);

    // Un-rebased, the counter still names a REAL row — just the wrong turn's.
    // That is what makes this class of bug silent: nothing errors, the diff
    // simply lands on somebody else's row.
    const unrebased = parsed.prompts.length - 1;
    const wrongRow = mappings.find((m) => m.promptIndex === unrebased)!;
    expect(wrongRow).toBeDefined();
    expect(wrongRow.promptText).toBe('check the state file now');
    expect(wrongRow.filesChanged).toEqual(['src/one.ts']);

    // What shipped before: mappings ran whole-file AND the counter was
    // session-relative, so index 2 named the FIRST in-session turn's row and
    // the current turn's diff landed on it.
    const unscoped = extractPromptFileMappings(f);
    expect(unscoped.length).toBe(5);
    expect(unscoped[unrebased].promptText).toBe('check the state file now');
  });

  it('leaves an unscoped read whole-file, for the watcher path that wants that', () => {
    // transcript-adapters parses whole-file on BOTH sides, so it is already
    // self-consistent — passing no `since` must not change what it sees.
    const f = writeAdoptedTranscript();
    const mappings = extractPromptFileMappings(f);
    expect(mappings.map((m) => m.promptIndex)).toEqual([0, 1, 2, 3, 4]);
    expect(mappings[0].promptText).toBe('why prompt 2 didnt capture changes');
    expect(mappings.map((m) => m.promptText)).toEqual(parseTranscript(f).prompts);
  });

  it('drops the previous turn bleeding across the cutoff instead of numbering it', () => {
    // Adoption almost always lands MID-TURN: the agent is working when the
    // session starts, so the first entries past `since` are the previous
    // turn's trailing tool_results and edits. Those must not take index 0 —
    // that shifts every real turn down one, which corrupts exactly like the
    // whole-file drift, just by a single row.
    const lines = [
      userTurn('2026-08-18T19:21:12.063Z', 'previous session prompt'),
      // ...agent still working when the session starts:
      editTurn('2026-08-19T18:49:19.342Z', 'old/straddler.ts'),
      // first turn this session actually owns:
      userTurn('2026-08-19T18:50:00.000Z', 'check the state file now'),
      editTurn('2026-08-19T18:51:00.000Z', 'src/one.ts'),
    ];
    const f = path.join(
      fs.mkdtempSync(path.join(os.tmpdir(), 'origin-straddle-')),
      'transcript.jsonl',
    );
    fs.writeFileSync(f, lines.join('\n') + '\n');

    const parsed = parseTranscript(f, { since: SESSION_START });
    const mappings = extractPromptFileMappings(f, { since: SESSION_START });

    expect(parsed.prompts).toEqual(['check the state file now']);
    expect(mappings.length).toBe(1);
    // Native: one turn ran before the session, so this is row 1 — and the
    // straddling edit does not get a row of its own.
    expect(parsed.promptIndexBase).toBe(1);
    expect(mappings[0].promptIndex).toBe(1);
    expect(mappings[0].promptText).toBe('check the state file now');
    expect(mappings[0].filesChanged).toEqual(['src/one.ts']);
    // The straddling edit belongs to the previous session's turn.
    expect(mappings.flatMap((m) => m.filesChanged)).not.toContain('old/straddler.ts');
  });

  it('still synthesises index 0 for a whole-file read that opens mid-turn', () => {
    // Without a cutoff there is no previous session to attribute to, so the
    // original behaviour stands: attach the edits somewhere rather than lose
    // them under a phantom -1 bucket.
    const f = path.join(
      fs.mkdtempSync(path.join(os.tmpdir(), 'origin-midturn-')),
      'transcript.jsonl',
    );
    // A transcript that opens on a tool_result — the turn's own prompt is not
    // in the file. (Two lines: a single-line file parses as Gemini JSON.)
    fs.writeFileSync(f, [
      JSON.stringify({
        type: 'user',
        timestamp: '2026-08-19T18:49:00.000Z',
        message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't0', content: 'ok' }] },
      }),
      editTurn('2026-08-19T18:49:19.342Z', 'orphan.ts'),
    ].join('\n') + '\n');

    const mappings = extractPromptFileMappings(f);
    expect(mappings.length).toBe(1);
    expect(mappings[0].promptIndex).toBe(0);
    expect(mappings[0].filesChanged).toEqual(['orphan.ts']);
  });

  it('keeps entries that carry no timestamp (Cursor writes none)', () => {
    const f = path.join(
      fs.mkdtempSync(path.join(os.tmpdir(), 'origin-nots-')),
      'transcript.jsonl',
    );
    fs.writeFileSync(f, [
      JSON.stringify({ type: 'user', message: { role: 'user', content: 'no timestamp here' } }),
      JSON.stringify({
        type: 'assistant',
        message: {
          role: 'assistant', id: 'msg_x', model: 'claude-opus-5',
          content: [{ type: 'tool_use', id: 't1', name: 'Write', input: { file_path: 'x.ts', content: 'y' } }],
        },
      }),
    ].join('\n') + '\n');

    // A `since` must never silently empty a transcript that has no clock.
    const mappings = extractPromptFileMappings(f, { since: SESSION_START });
    expect(mappings.length).toBe(1);
    expect(mappings[0].filesChanged).toEqual(['x.ts']);
  });
});

// #1102 added homePromptIndexByText as the last line of defence before Stop
// writes a turn's diff: the mapping sitting at the index the counter derived
// must carry the same prompt text, else re-home by text, else write nothing.
// It reads the mapping list this file scopes — so the two fixes are coupled,
// and the guard only reaches "yes, write here" when both lists are in the same
// index space.
describe('adopted transcript — composition with the #1102 text-homing guard', () => {
  it('agrees on the index once both lists are session-scoped', () => {
    const f = writeAdoptedTranscript();
    const prompts = parseTranscript(f, { since: SESSION_START }).prompts;
    const mappings = extractPromptFileMappings(f, { since: SESSION_START });

    // Every turn, not just the newest — the guard runs on whichever turn Stop
    // is capturing.
    const base = parseTranscript(f, { since: SESSION_START }).promptIndexBase;
    prompts.forEach((text, i) => {
      const native = base + i;
      expect(homePromptIndexByText(native, text, mappings)).toBe(native);
    });
  });

  it('would have refused to write at all against whole-file mappings', () => {
    // The pre-fix pairing: session-space counter, whole-file mapping list.
    // The guard is doing its job here — it declines rather than overwrite the
    // previous day's row — but the user-visible result is still a turn with no
    // captured changes, which is the bug being reported.
    const f = writeAdoptedTranscript();
    const prompts = parseTranscript(f, { since: SESSION_START }).prompts;
    const unscoped = extractPromptFileMappings(f);

    const currentIdx = prompts.length - 1;
    const currentText = prompts[currentIdx];
    expect(unscoped[currentIdx].promptText).not.toBe(currentText);

    // It re-homes to where that text actually lives in whole-file space...
    const homed = homePromptIndexByText(currentIdx, currentText, unscoped);
    expect(homed).not.toBe(currentIdx);
    // ...which is an index the SESSION's prompt list does not have, so the row
    // the dashboard reads for turn `currentIdx` stays empty either way.
    expect(homed).toBeGreaterThanOrEqual(prompts.length);
  });
});
