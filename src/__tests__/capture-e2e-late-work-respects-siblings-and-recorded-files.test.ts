// END-TO-END: what the next prompt adds to a turn Stop closed.
//
// #1684 lets the next prompt EXTEND a closed turn with what its background job
// changed after Stop (extendClosedTurnWithLateWork). Re-review of d40c389c0
// found two ways that differed from main:
//
//   1. a second live session in the same checkout wrote src/sib.py between the
//      Stop and the next prompt, and the closed turn's diff carried it (+8
//      against main's +1) while a later pass trimmed only filesChanged;
//   2. the background job appended ten lines to a file Stop had already
//      recorded, and "keep Stop's version" lost them (+1 against main's +11).
//
// Built binary, real hook sequence, real repo, fake API.
import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';
import { WINDOWS_SLOWDOWN, isWindows } from './helpers/windows-e2e.js';
import { commitFiles, createHarness, haveDist, numbered, sleep, waitFor } from './helpers/stop-next-prompt-harness.js';

const T = 150_000 * WINDOWS_SLOWDOWN;
const MINE = 'src/mine.py';

describe.skipIf(!haveDist || isWindows)('what the next prompt adds to a closed turn, through the built binary', () => {
  it('a sibling session\'s write between Stop and the next prompt is not added to the closed turn', async () => {
    const h = await createHarness('e2e-late-sib-0001', 'e2e-late-sib-srv-1');
    const SIB = 'src/sib.py';
    try {
      commitFiles(h, { [MINE]: numbered('mine', 5) }, 'base');

      await h.startSession('make my change');
      await h.agentWrites('tu-1', MINE, numbered('mine', 5) + 'mine_new = 1\n');
      h.reply('Done.');
      await h.stop();

      // Another live agent session in the same checkout writes and Stops.
      const sib = await h.sibling('e2e-sibwriter-0002');
      await sib.submit('add the sibling module');
      await sib.agentWrites('s-1', SIB, numbered('sib', 7));
      sib.reply('Added.');
      await sib.stop();
      await sleep(500);

      await h.submit('thanks');
      h.reply('You are welcome.');
      await h.stop();

      const rows = h.rows();
      const zero = rows.find((r: any) => r.promptIndex === 0);
      const one = rows.find((r: any) => r.promptIndex === 1);
      expect(zero?.filesChanged).toEqual([MINE]);
      expect(String(zero?.diff || '')).not.toContain(SIB);
      expect(String(zero?.uncommittedDiff || '')).not.toContain(SIB);
      expect([zero?.linesAdded, zero?.linesRemoved]).toEqual([1, 0]);
      // Turn 1 may name the session's files with no lines (as on main); it
      // carries none of the sibling's content.
      expect(String(one?.diff || '')).not.toContain('+sib_');
    } finally {
      await h.close();
    }
  }, T);

  it('a background job\'s append to a file Stop recorded extends that file\'s section (+11, as on main)', async () => {
    const h = await createHarness('e2e-late-append-0003', 'e2e-late-append-srv-3');
    try {
      commitFiles(h, { [MINE]: numbered('mine', 5), 'gen.sh': 'echo generated\n' }, 'base');

      await h.startSession('add a line and regenerate the tail');
      await h.agentWrites('tu-1', MINE, numbered('mine', 5) + 'mine_new = 1\n');
      await h.agentRuns('tu-2', 'sleep 2 && ./gen.sh >> src/mine.py', () => { /* background */ }, { run_in_background: true });
      h.reply('Started the generator.');
      await h.stop();
      expect([h.rows().find((r: any) => r.promptIndex === 0)?.linesAdded]).toEqual([1]);

      // The job appends ten lines after Stop; no hook fires.
      fs.appendFileSync(path.join(h.repo, MINE), numbered('generated', 10));
      await waitFor(() => (h.journalText().match(/mine\.py/g) || []).length >= 2, 10_000, 'the journal to record the append');
      await sleep(300);

      await h.submit('looks good');
      h.reply('Thanks.');
      await h.stop();

      const rows = h.rows();
      const zero = rows.find((r: any) => r.promptIndex === 0);
      const one = rows.find((r: any) => r.promptIndex === 1);
      expect(zero?.filesChanged).toEqual([MINE]);
      expect([zero?.linesAdded, zero?.linesRemoved]).toEqual([11, 0]);
      expect(String(zero?.diff || '')).toContain('+mine_new = 1');
      expect(String(zero?.diff || '')).toContain('+generated_9 = 9');
      expect((one?.filesChanged || []) as string[]).not.toContain(MINE);
    } finally {
      await h.close();
    }
  }, T);
});
