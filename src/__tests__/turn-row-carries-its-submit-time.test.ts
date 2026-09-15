// A turn's row carries the time its prompt was submitted.
//
// Prod session a7740ea3 (2026-09-15). Turn 7 ("add that priority rule…")
// was submitted at 20:24:03 and committed 562618d7 at 20:26:54. Claude Code
// writes no PromptChange row at submit, so the row was created by post-commit's
// PATCH at 20:27:42 and stamped with THAT time. post-commit's next PATCH carried
// only gitCapture; the server's back-attribution saw a carrier "created after
// the commit", decided it could not have made it, and moved the sha onto turn 6
// — a chat-only question. The page showed the commit under the wrong prompt.
//
// The server already stores a client-supplied per-prompt createdAt (Devin and
// Antigravity send one). These tests pin that every writer of a turn row sends
// the submit time, recorded once when the prompt arrives.
import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { turnStartForServerRow } from '../turn-index.js';
import { recordPromptSubmittedAt } from '../session-state.js';
import { promptChangesForSessionEnd } from '../session-end-payload.js';
import { carryForwardTurnState } from '../session-dedup.js';
import { hookModuleSource } from './helpers/hooks-source.js';

const SRC = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const SUBMIT = '2026-09-15T20:24:03.557Z';

describe('recordPromptSubmittedAt', () => {
  it('records the first time and keeps it', () => {
    const state: { promptSubmittedAt?: string[] } = {};
    recordPromptSubmittedAt(state, 5, Date.parse(SUBMIT));
    // post-commit or Stop running later must not move the turn's start past its commit.
    recordPromptSubmittedAt(state, 5, Date.parse('2026-09-15T20:27:42.763Z'));
    expect(state.promptSubmittedAt?.[5]).toBe(SUBMIT);
  });

  it('accepts ISO strings and Dates, and ignores unusable input', () => {
    const state: { promptSubmittedAt?: string[] } = {};
    recordPromptSubmittedAt(state, 0, SUBMIT);
    recordPromptSubmittedAt(state, 1, new Date(SUBMIT));
    recordPromptSubmittedAt(state, 2, 'not a time');
    recordPromptSubmittedAt(state, -1, SUBMIT);
    recordPromptSubmittedAt(state, 1.5, SUBMIT);
    expect(state.promptSubmittedAt?.[0]).toBe(SUBMIT);
    expect(state.promptSubmittedAt?.[1]).toBe(SUBMIT);
    expect(state.promptSubmittedAt?.[2]).toBeUndefined();
  });
});

describe('turnStartForServerRow', () => {
  it('reads the local turn behind a server row', () => {
    // a7740ea3 adopted a bootstrap session: local turn 5 is server row 6.
    const state = { promptSubmittedAt: [] as string[], promptIndexBase: 1 };
    state.promptSubmittedAt[5] = SUBMIT;
    expect(turnStartForServerRow(state, 6)).toBe(SUBMIT);
    expect(turnStartForServerRow(state, 5)).toBeUndefined();
  });

  it('has nothing for a row from before this launch, or a bad value', () => {
    expect(turnStartForServerRow({ promptSubmittedAt: [SUBMIT], promptIndexBase: 21 }, 0)).toBeUndefined();
    expect(turnStartForServerRow({ promptSubmittedAt: ['garbage'] }, 0)).toBeUndefined();
    expect(turnStartForServerRow({}, 0)).toBeUndefined();
    expect(turnStartForServerRow({ promptSubmittedAt: [SUBMIT] }, 0)).toBe(SUBMIT);
  });
});

describe('the daemon session-end rows', () => {
  it('attach the submit time to saved mappings', () => {
    const rows = promptChangesForSessionEnd({
      prompts: ['a', 'b'],
      promptTurnIds: ['t_a', 't_b'],
      promptSubmittedAt: ['2026-09-15T20:00:00.000Z', SUBMIT],
      promptIndexBase: 1,
      completedPromptMappings: [{ promptIndex: 1 }, { promptIndex: 2, turnId: 't_b' }],
    })!;
    expect(rows[0]).toMatchObject({ promptIndex: 1, turnId: 't_a', createdAt: '2026-09-15T20:00:00.000Z' });
    // A mapping that already names its turn still gets the time.
    expect(rows[1]).toMatchObject({ promptIndex: 2, turnId: 't_b', createdAt: SUBMIT });
  });

  it('keep a createdAt the mapping already carries', () => {
    const rows = promptChangesForSessionEnd({
      promptSubmittedAt: [SUBMIT],
      completedPromptMappings: [{ promptIndex: 0, createdAt: '2026-09-15T19:00:00.000Z' }],
    })!;
    expect(rows[0].createdAt).toBe('2026-09-15T19:00:00.000Z');
  });

  it('attach it to the fallback rows built from the prompt list', () => {
    const rows = promptChangesForSessionEnd({ prompts: ['a'], promptSubmittedAt: [SUBMIT], promptIndexBase: 3 })!;
    expect(rows[0]).toMatchObject({ promptIndex: 3, createdAt: SUBMIT });
  });
});

describe('a duplicate state file', () => {
  it('carries the submit times with the turn ids', () => {
    const state: Record<string, any> = { prompts: [], promptTurnIds: [] };
    carryForwardTurnState(state, { prompts: ['a'], promptTurnIds: ['t_a'], promptSubmittedAt: [SUBMIT] });
    expect(state.promptSubmittedAt).toEqual([SUBMIT]);
  });
});

describe('every writer of a turn row sends the submit time', () => {
  it('post-commit stamps the row it usually creates, the committing turn', () => {
    const src = hookModuleSource('post-commit');
    const at = src.indexOf('const perPromptUpdate = {');
    expect(at).toBeGreaterThan(-1);
    const block = src.slice(at, src.indexOf('promptText: latestPromptText', at));
    expect(block).toContain('createdAt: turnStartForServerRow(s, latestPromptRow)');
  });

  it('Stop, session-end, user-prompt-submit and post-commit replays attach it beside the turn id', () => {
    for (const mod of ['stop', 'session-end', 'user-prompt-submit', 'post-commit']) {
      expect(hookModuleSource(mod), mod).toContain('createdAt: turnStartForServerRow(state, pm.promptIndex)');
    }
  });

  it('both submit paths record the time when the turn id is minted', () => {
    const ups = hookModuleSource('user-prompt-submit');
    const mint = ups.indexOf('state.promptTurnIds[newTurnIdx] = `t_');
    expect(mint).toBeGreaterThan(-1);
    expect(ups.slice(mint, mint + 300)).toContain('recordPromptSubmittedAt(state, newTurnIdx');
    const hooks = fs.readFileSync(path.join(SRC, 'commands', 'hooks.ts'), 'utf-8');
    const pre = hooks.indexOf('export function preMarkTurnForBackgroundSubmit');
    expect(hooks.slice(pre, pre + 1500)).toContain('recordPromptSubmittedAt(state, idx)');
  });
});
