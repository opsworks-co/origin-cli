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
      // Turn 1 only said thanks: no file, no line, in either direction. It
      // used to pass `not.toContain('+sib_')` while holding the REVERSED
      // text (-mine_new, src/sib.py deleted, -8): Stop read `shadow..HEAD` as
      // the turn's work.
      expect(one?.filesChanged || []).toEqual([]);
      expect(String(one?.diff || '')).toBe('');
      expect(String(one?.uncommittedDiff || '')).toBe('');
      expect([one?.linesAdded || 0, one?.linesRemoved || 0]).toEqual([0, 0]);
    } finally {
      await h.close();
    }
  }, T);

  it('a heartbeat tick inside the open turn sends none of the sibling\'s file or the earlier turn\'s work', async () => {
    // The daemon's in-flight row is `git diff HEAD` + untracked. In a shared
    // checkout the shadow-window pass declines, so nothing scoped it to the
    // turn: a tick inside turn 1 sent [src/mine.py, src/sib.py] +8, and on a
    // slow host that PATCH landed after Stop's and became the stored row
    // (local-ci 2026-09-18). The tick fires every 30s; hold the turn open
    // past one.
    const h = await createHarness('e2e-late-tick-0004', 'e2e-late-tick-srv-4');
    const SIB = 'src/sib.py';
    try {
      commitFiles(h, { [MINE]: numbered('mine', 5) }, 'base');

      await h.startSession('make my change');
      await h.agentWrites('tu-1', MINE, numbered('mine', 5) + 'mine_new = 1\n');
      h.reply('Done.');
      const beforeWorkStop = h.hits.length;
      await h.stop();
      // A turn that WROTE A FILE is closed on disk when its row arrives too.
      // Stop saves its state — read before the mark — as soon as a journal or
      // shell pass records the turn's edit, and that save used to put the turn
      // back to "open" before the row was stamped. Only a turn with no work,
      // like "thanks" below, kept the mark (review of #1725).
      const workSends = h.hits.slice(beforeWorkStop).filter((x) => x.method === 'PATCH'
        && x.url.startsWith('/api/mcp/session/e2e-late-tick-srv-4')
        && Array.isArray(x.body?.promptChanges) && x.body.promptChanges.some((pc: any) => pc.promptIndex === 0));
      expect(workSends.length).toBeGreaterThan(0);
      for (const send of workSends) expect(send.closedOnDisk).toBe(0);

      const sib = await h.sibling('e2e-sibtick-0005');
      await sib.submit('add the sibling module');
      await sib.agentWrites('s-1', SIB, numbered('sib', 7));
      sib.reply('Added.');
      await sib.stop();

      const before = h.hits.length;
      await h.submit('thanks');
      await sleep(36_000);
      const inFlight = h.hits.slice(before)
        .filter((x) => x.method === 'PATCH' && x.url.startsWith('/api/mcp/session/e2e-late-tick-srv-4'))
        .flatMap((x) => (Array.isArray(x.body?.promptChanges) ? x.body.promptChanges : []))
        .filter((pc: any) => pc.promptIndex === 1);
      for (const pc of inFlight) {
        expect(pc.filesChanged || []).toEqual([]);
        expect(String(pc.diff || '') + String(pc.uncommittedDiff || '')).not.toMatch(/sib_|mine_new/);
      }

      h.reply('You are welcome.');
      const beforeStop = h.hits.length;
      await h.stop();
      const one = h.rows().find((r: any) => r.promptIndex === 1);
      expect(one?.filesChanged || []).toEqual([]);
      expect(String(one?.diff || '')).toBe('');

      // Stop's row for turn 1 arrives with the turn ALREADY closed on disk. It
      // used to be recorded only in Stop's final save, after the send: a tick
      // starting in between read "open", out-stamped Stop, and won.
      const stopSends = h.hits.slice(beforeStop).filter((x) => x.method === 'PATCH'
        && x.url.startsWith('/api/mcp/session/e2e-late-tick-srv-4')
        && Array.isArray(x.body?.promptChanges) && x.body.promptChanges.some((pc: any) => pc.promptIndex === 1));
      expect(stopSends.length).toBeGreaterThan(0);
      for (const send of stopSends) expect(send.closedOnDisk).toBe(1);
    } finally {
      await h.close();
    }
  }, T);

  it('a turn Stop never closed: the next prompt saves the new turn before it sends the old one\'s row', async () => {
    // The other half of the ordering above. The heartbeat's tick works on the
    // LAST prompt in the state file and stamps itself before it reads that
    // file. The submit hook saves the new prompt and only then stamps and
    // sends the previous turn's row, so a tick either read the old state and
    // carries the older stamp, or reads the new one and works on the new
    // turn. Send-before-save would reopen the gap Stop had; this pins it.
    const h = await createHarness('e2e-late-nostop-0006', 'e2e-late-nostop-srv-6');
    try {
      commitFiles(h, { [MINE]: numbered('mine', 5) }, 'base');

      await h.startSession('make my change');
      await h.agentWrites('tu-1', MINE, numbered('mine', 5) + 'mine_new = 1\n');
      h.reply('Done.');
      // No Stop: an interrupt, a crash, a hook the agent killed.

      const before = h.hits.length;
      await h.submit('next thing');
      const sends = h.hits.slice(before).filter((x) => x.method === 'PATCH'
        && x.url.startsWith('/api/mcp/session/e2e-late-nostop-srv-6')
        && Array.isArray(x.body?.promptChanges) && x.body.promptChanges.some((pc: any) => pc.promptIndex === 0));
      expect(sends.length).toBeGreaterThan(0);
      for (const send of sends) expect(send.promptsOnDisk).toBe(2);
      const zero = sends[sends.length - 1].body.promptChanges.find((pc: any) => pc.promptIndex === 0);
      expect(zero.filesChanged).toEqual([MINE]);
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
