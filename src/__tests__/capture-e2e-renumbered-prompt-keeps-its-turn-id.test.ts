// End to end, through the built binary: Stop adopts the transcript's numbering
// when the transcript holds a prompt no hook recorded AHEAD of one we store
// (Cursor flushes its transcript late; a killed submit hook leaves the same
// shape). The numbering is right; what went wrong was identity. The prompt
// that moved kept nothing — `promptTurnIds[1]` still named it while index 1
// now held the newcomer — and the server, which finds a row by turn id first,
// wrote the newcomer onto the moved prompt's row (TODO b4c19d8f).
import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';
import { commitFiles, createHarness, haveDist, numbered } from './helpers/stop-next-prompt-harness.js';
import { WINDOWS_SLOWDOWN } from './helpers/windows-e2e.js';

const T = 120_000 * WINDOWS_SLOWDOWN;
const SESSION = 'e2e-renumber-0001';

describe.skipIf(!haveDist)('a prompt the transcript puts ahead of one we store', () => {
  it('each prompt keeps its own turn id: the newcomer never wears the moved prompt\'s id', async () => {
    const h = await createHarness(SESSION, 'e2e-renumber-srv-1');
    try {
      commitFiles(h, { 'a.py': numbered('a', 3) }, 'base');

      await h.startSession('prompt A: add the first thing');
      await h.agentWrites('tu-a', 'a.py', numbered('a', 3) + 'a_new = 1\n');
      h.reply('Did A.');
      await h.stop();

      await h.submit('prompt Y: add the second thing');
      await h.agentWrites('tu-y', 'y.py', 'y = 1\n');
      h.reply('Did Y.');

      const stateFile = path.join(h.repo, '.git', `origin-session-${SESSION.slice(0, 12)}.json`);
      const before = JSON.parse(fs.readFileSync(stateFile, 'utf-8'));
      expect(before.prompts.map((p: string) => p.slice(0, 8))).toEqual(['prompt A', 'prompt Y']);
      const idY: string = before.promptTurnIds[1];
      expect(idY).toBeTruthy();

      // The transcript now shows a prompt no hook ever saw, BEFORE Y.
      const transcript = path.join(path.dirname(h.repo), `${SESSION}.jsonl`);
      const lines = fs.readFileSync(transcript, 'utf-8').split('\n').filter(Boolean);
      const atY = lines.findIndex((l) => l.includes('prompt Y: add the second thing'));
      expect(atY).toBeGreaterThan(0);
      const x = JSON.stringify({ type: 'user', timestamp: new Date(JSON.parse(lines[atY]).timestamp).toISOString(), message: { role: 'user', content: [{ type: 'text', text: 'prompt X: a question' }] } });
      lines.splice(atY, 0, x);
      fs.writeFileSync(transcript, lines.join('\n') + '\n');

      const sent = h.hits.length;
      await h.stop();

      const rows = h.hits.slice(sent)
        .filter((hit) => hit.method === 'PATCH' && Array.isArray(hit.body?.promptChanges))
        .flatMap((hit) => hit.body.promptChanges as Array<{ promptIndex: number; promptText?: string; turnId?: string | null }>);
      expect(rows.length).toBeGreaterThan(0);
      const textOf = (r: { promptText?: string }) => String(r.promptText || '').slice(0, 8);

      // The bug: X was sent under Y's id, and the server would write it onto Y's row.
      expect(rows.filter((r) => textOf(r) === 'prompt X').map((r) => r.turnId)).not.toContain(idY);
      // Y's id travels only with Y's text. (A background sender that built its
      // payload before Stop's reconcile may still say index 1 — the server
      // finds the row by id and moves it; the text and id are what must agree.)
      for (const r of rows.filter((r) => r.turnId === idY)) expect(textOf(r)).toBe('prompt Y');
      // Every payload built after the reconcile — the ones that know X — puts
      // Y at its new index under its own id.
      const renumbered = h.hits.slice(sent)
        .filter((hit) => hit.method === 'PATCH' && Array.isArray(hit.body?.promptChanges)
          && hit.body.promptChanges.some((r: { promptText?: string }) => textOf(r) === 'prompt X'))
        .map((hit) => hit.body.promptChanges.find((r: { promptText?: string }) => textOf(r) === 'prompt Y'))
        .filter(Boolean);
      expect(renumbered.length).toBeGreaterThan(0);
      for (const y of renumbered) expect([y.promptIndex, y.turnId]).toEqual([2, idY]);

      const after = JSON.parse(fs.readFileSync(stateFile, 'utf-8'));
      expect(after.prompts.map((p: string) => p.slice(0, 8))).toEqual(['prompt A', 'prompt X', 'prompt Y']);
      expect(after.promptTurnIds[2]).toBe(idY);
      expect(after.promptTurnIds[1]).toBeTruthy();
      expect(after.promptTurnIds[1]).not.toBe(idY);
      expect(after.promptTurnIds[0]).toBe(before.promptTurnIds[0]);
    } finally {
      await h.close();
    }
  }, T);
});
