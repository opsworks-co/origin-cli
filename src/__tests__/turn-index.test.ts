// One turn, two index spaces — see turn-index.ts.
//
// Prod 8a626742 (2026-09-09), a Claude Code conversation resumed with 21
// earlier turns. The transcript numbered the new turn 21 and every
// local-numbered structure (ids, shadows, the live ledger, `prompts`) was
// numbered 0. Four writers conflated the two:
//
//   - the ledger passes looked up `promptTurnIds[21]` (nothing) and, for the
//     row of a turn from BEFORE the resume, `promptTurnIds[0]` (this launch's
//     first turn) — so the ledger's answer was written onto row 0's mapping;
//   - the prompt-history clip kept rows below `prompts.length` (1), i.e. row 0
//     only, and dropped row 21 — Stop sent one row, at 0;
//   - post-commit sent the commit under local index 0;
//   - the daemon's end payload replayed the saved mappings (at 0..2, no ids)
//     and put turn 2's commit patch onto row 2, a chat-only turn from the day
//     before.
//
// Row 21 was created late by the one writer that converted (user-prompt-
// submit's retroactive capture); rows 22 and 23 never existed; the page showed
// commit 4f591373 under turn 19 and 432d5dce under turn 22, each one turn
// early, with a +52/-10 turn whose "commit total" read +26/-0.
import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import {
  serverRowForLocalTurn, localTurnForServerRow, turnIdForServerRow, rebaseToServerRows,
} from '../turn-index.js';
import { clipMappingsToPromptHistory } from '../session-state.js';
import { promptChangesForSessionEnd } from '../session-end-payload.js';
import { applyLiveLedger } from '../commands/hooks.js';
import { hookModuleSource } from './helpers/hooks-source.js';

const SRC = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

describe('the two index spaces', () => {
  it('coincide while the base is 0 or unknown', () => {
    for (const base of [0, undefined, null, -1]) {
      expect(serverRowForLocalTurn(3, base)).toBe(3);
      expect(localTurnForServerRow(3, base)).toBe(3);
    }
  });

  it('differ by the base on a resumed conversation', () => {
    expect(serverRowForLocalTurn(0, 21)).toBe(21);
    expect(serverRowForLocalTurn(2, 21)).toBe(23);
    expect(localTurnForServerRow(21, 21)).toBe(0);
    expect(localTurnForServerRow(23, 21)).toBe(2);
  });

  it('a row from before the launch has no local turn', () => {
    expect(localTurnForServerRow(0, 21)).toBeNull();
    expect(localTurnForServerRow(20, 21)).toBeNull();
  });

  it('turnIdForServerRow reads the local id for a server row', () => {
    const state = { promptTurnIds: ['t_a', 't_b'], promptIndexBase: 21 };
    expect(turnIdForServerRow(state, 21)).toBe('t_a');
    expect(turnIdForServerRow(state, 22)).toBe('t_b');
    // THE BUG: row 0 is turn one from before the resume, not this launch's t_a.
    expect(turnIdForServerRow(state, 0)).toBeUndefined();
    expect(turnIdForServerRow(state, 23)).toBeUndefined();
    expect(turnIdForServerRow({ promptTurnIds: ['t_a'] }, 0)).toBe('t_a');
  });

  it('rebaseToServerRows lifts local captures in place', () => {
    const caps = [{ promptIndex: 0 }, { promptIndex: 1 }];
    expect(rebaseToServerRows(caps, 21).map((c) => c.promptIndex)).toEqual([21, 22]);
    expect(rebaseToServerRows([{ promptIndex: 0 }], 0).map((c) => c.promptIndex)).toEqual([0]);
  });
});

describe('clipMappingsToPromptHistory on a resumed conversation', () => {
  const rows = [
    { promptIndex: 0, promptText: 'Check if the code in here and github' },
    { promptIndex: 20, promptText: 'did you commit and push latest changes' },
    { promptIndex: 21, promptText: 'Привіт' },
    { promptIndex: 22, promptText: '' },
  ];

  it('THE BUG: without the base, this launch\'s one prompt keeps row 0 and drops row 21', () => {
    expect(clipMappingsToPromptHistory(rows, ['Привіт']).map((m) => m.promptIndex)).toEqual([0]);
  });

  it('with the base, this launch\'s rows survive and read their text at the LOCAL position', () => {
    const out = clipMappingsToPromptHistory(rows, ['Привіт :wave:', 'tell me in short'], 21);
    expect(out.find((m) => m.promptIndex === 21)?.promptText).toBe('Привіт :wave:');
    expect(out.find((m) => m.promptIndex === 22)?.promptText).toBe('tell me in short');
  });

  it('an EMPTY row from before the launch is dropped — it is this launch\'s numbering artifact', () => {
    // Stop synthesizes a chat-only mapping per turn and on a resumed session
    // one lands below the base. Sent, it would tell the server that a real
    // earlier turn authored nothing.
    const out = clipMappingsToPromptHistory(rows, ['Привіт :wave:', 'tell me in short'], 21);
    expect(out.map((m) => m.promptIndex)).toEqual([21, 22]);
  });

  it('a row from before the launch that CARRIES work is kept, and never renamed', () => {
    // Dropping it would delete the only local copy — the caller persists what
    // this returns. Whether it may land is the server's call, not ours.
    const withWork = [
      { promptIndex: 0, promptText: 'an earlier turn', filesChanged: ['a.ts'], diff: 'd' },
      { promptIndex: 21, promptText: 'Привіт' },
    ];
    const out = clipMappingsToPromptHistory(withWork, ['Привіт :wave:'], 21);
    expect(out.map((m) => m.promptIndex)).toEqual([0, 21]);
    expect(out[0].promptText).toBe('an earlier turn');
  });

  it('is unchanged for an ordinary session', () => {
    expect(clipMappingsToPromptHistory(rows, ['a', 'b'], 0).map((m) => m.promptIndex)).toEqual([0]);
  });
});

describe('the daemon\'s session-end payload', () => {
  it('stamps each saved mapping with its turn id, resolved through the base', () => {
    const out = promptChangesForSessionEnd({
      prompts: ['Привіт', 'tell me', 'AMIQA'],
      promptTurnIds: ['t_8e9fd433', 't_fd52a256', 't_0d3cdea4'],
      promptIndexBase: 21,
      completedPromptMappings: [
        { promptIndex: 21, filesChanged: ['a.ts'] },
        { promptIndex: 23, filesChanged: ['next.config.ts'], turnId: 't_already' },
      ],
    })!;
    expect(out.map((m) => [m.promptIndex, m.turnId])).toEqual([
      [21, 't_8e9fd433'],
      [23, 't_already'],
    ]);
  });

  it('THE BUG: a saved mapping at a row this launch has no id for goes out without one', () => {
    // The row can then only be matched by position — and, with the server's
    // unlabelled-write guard, by its prompt text.
    const out = promptChangesForSessionEnd({
      prompts: ['AMIQA'], promptTurnIds: ['t_0d3cdea4'], promptIndexBase: 21,
      completedPromptMappings: [{ promptIndex: 2, filesChanged: ['next.config.ts'] }],
    })!;
    expect(out[0].turnId).toBeUndefined();
  });

  it('builds the empty fallback rows on their server rows, with ids', () => {
    const out = promptChangesForSessionEnd({
      prompts: ['p0', 'p1'], promptTurnIds: ['t_0', 't_1'], promptIndexBase: 21,
    })!;
    expect(out.map((m) => [m.promptIndex, m.turnId, m.promptText])).toEqual([
      [21, 't_0', 'p0'],
      [22, 't_1', 'p1'],
    ]);
  });

  it('nothing to send without a state or prompts', () => {
    expect(promptChangesForSessionEnd(null)).toBeNull();
    expect(promptChangesForSessionEnd({ prompts: [] })).toBeNull();
  });
});

describe('the live ledger is lifted onto server rows before it meets the transcript', () => {
  const edit = { file: 'src/x.ts', op: 'create' as const, newContent: 'a\n', source: 'tool_call' as const };
  const state = () => ({
    promptIndexBase: 21,
    liveEdits: [{ promptIndex: 0, toolName: 'Write', capturedAt: '2026-09-09T11:30:00Z', edits: [edit] }],
  });
  const transcript = () => [
    { promptIndex: 21, promptText: 'Привіт', agent: 'claude' as const, edits: [], commits: [] },
  ];

  it('an edit the transcript never saw lands on THIS launch\'s row, not row 0', () => {
    const merged = applyLiveLedger(transcript() as any, state() as any, 'test');
    const byIndex = new Map(merged.map((c) => [c.promptIndex, c]));
    expect(byIndex.has(0)).toBe(false);
    expect(byIndex.get(21)?.edits.map((e) => e.file)).toEqual(['src/x.ts']);
  });

  it('is the identity for an ordinary session', () => {
    const s = { ...state(), promptIndexBase: 0 };
    const t = [{ ...transcript()[0], promptIndex: 0 }];
    const merged = applyLiveLedger(t as any, s as any, 'test');
    expect(merged.map((c) => c.promptIndex)).toEqual([0]);
    expect(merged[0].edits.map((e) => e.file)).toEqual(['src/x.ts']);
  });
});

describe('the positional writers convert before they name a row', () => {
  it('post-commit sends the commit under the server row', () => {
    const src = hookModuleSource('post-commit');
    const at = src.indexOf('const perPromptUpdate = {');
    expect(at).toBeGreaterThan(-1);
    expect(src.slice(at, at + 200)).toContain('promptIndex: latestPromptRow');
    expect(src).toContain('const latestPromptRow = serverRowForLocalTurn(latestPromptIdx, s.promptIndexBase)');
  });

  it('the heartbeat tick sends the current turn under the server row', () => {
    const src = fs.readFileSync(path.join(SRC, 'heartbeat.ts'), 'utf-8');
    expect(src).toContain('const promptRow = serverRowForLocalTurn(promptIndex, state.promptIndexBase)');
    // Both the mapping the ledger passes read and the wire payload.
    expect(src.match(/promptIndex: promptRow,/g)?.length).toBe(2);
    // The id stays local — it is read from the local-numbered list.
    expect(src).toContain('state.promptTurnIds?.[promptIndex] ? { turnId: state.promptTurnIds[promptIndex] }');
  });

  it('Stop, session-end and the two replays read a mapping\'s id through the base', () => {
    for (const mod of ['stop', 'session-end', 'user-prompt-submit', 'post-commit']) {
      const src = hookModuleSource(mod);
      expect(src, mod).toContain('turnIdForServerRow(state, pm.promptIndex)');
      expect(src, mod).not.toMatch(/\bturnIdFor\(state, pm\.promptIndex\)/);
    }
  });
});
