// END-TO-END: a turn that writes a file and puts it back before it ends names
// that file as DISCARDED on its row, and a turn that keeps its write does not.
//
// Session b300fdf0 turn 10 (2026-09-26): four Edit calls on
// antigravity-transcript.ts, the same fix found already merged as #1907,
// `git checkout --` on the file, no commit. The ledger resolved the file to
// netZero and the row went out with no files; the server kept an earlier
// capture's +46/-6 and the page read "uncommitted" — the same pill as work
// still dirty in the tree. `discardedFiles` is what lets it read "discarded".
//
// Built binary, real hook sequence, real repo, fake API. The unit tests prove
// the decision; only the spawned binary proves the ASSEMBLY — that Stop hands
// the ledger its edit captures, and that the verdict reaches the wire.
import { describe, it, expect } from 'vitest';
import { WINDOWS_SLOWDOWN } from './helpers/windows-e2e.js';
import { commitFiles, createHarness, haveDist, numbered, sleep } from './helpers/stop-next-prompt-harness.js';

const T = 120_000 * WINDOWS_SLOWDOWN;

describe.skipIf(!haveDist)('discarded work, through the built binary', () => {
  it('a file the turn wrote and checked out again is on its row as discarded, not as a change', async () => {
    const h = await createHarness('e2e-discard-0001', 'e2e-discard-srv-1');
    try {
      commitFiles(h, { 'src/agy.ts': numbered('agy', 5), 'src/other.ts': numbered('other', 3) }, 'base');

      await h.startSession('bill agy tool output as input');
      await h.agentWrites('tu-1', 'src/agy.ts', numbered('agy', 5) + 'agy_fix = 1\n');
      await sleep(500);
      // Found merged already as #1907.
      await h.agentRuns('tu-2', 'git checkout -- src/agy.ts', () => { h.git(['checkout', '--', 'src/agy.ts']); });
      await sleep(500);
      h.reply('Already merged as #1907; dropped my copy.');
      await h.stop();

      const row = h.rows().find((r: any) => r.promptIndex === 0);
      expect(row, 'turn 0 was never sent').toBeTruthy();
      expect(row.discardedFiles).toEqual(['src/agy.ts']);
      // Nothing of it is in the tree: the ledger's row lists no change.
      expect(row.filesChanged).toEqual([]);
      expect([row.linesAdded, row.linesRemoved]).toEqual([0, 0]);
      // (The shadow-window pass relabels an emptied row `turn-window` after
      // the ledger; which pass blanked it is not what this test is about.)
      // ...but the write itself stays on the record.
      expect(String(row.editsJson || '')).toContain('src/agy.ts');
    } finally {
      await h.close();
    }
  }, T);

  it('a file the turn wrote and stashed is not discarded — the stash still holds it', async () => {
    const h = await createHarness('e2e-discard-0003', 'e2e-discard-srv-3');
    try {
      commitFiles(h, { 'src/agy.ts': numbered('agy', 5) }, 'base');

      await h.startSession('try the fix, then park it');
      await h.agentWrites('tu-1', 'src/agy.ts', numbered('agy', 5) + 'agy_fix = 1\n');
      await sleep(500);
      await h.agentRuns('tu-2', 'git stash', () => { h.git(['stash']); });
      await sleep(500);
      h.reply('Stashed it for later.');
      await h.stop();

      const row = h.rows().find((r: any) => r.promptIndex === 0);
      expect(row, 'turn 0 was never sent').toBeTruthy();
      expect(row.discardedFiles).toEqual([]);
    } finally {
      await h.close();
    }
  }, T);

  // Session 7ba816a4 (2026-10-01): turns 1–6 all edited Landing.tsx with no
  // commit; turns 3 and 7 each ran `git checkout HEAD -- Landing.tsx` and
  // wrote something new. Every earlier turn kept reading "uncommitted" while
  // none of its lines existed anywhere. The verdict for an EARLIER turn comes
  // from a LATER Stop — discarded-by-later-turn.ts.
  const LANDING = 'src/landing.tsx';
  const baseLanding = numbered('landing', 8);
  const turnA = baseLanding + 'hero_line = "Make AI-generated code maintainable"\nsub_line = "Session history and blame"\n';

  it('a later turn that checks the file out and writes elsewhere makes the earlier turn\'s work discarded', async () => {
    const h = await createHarness('e2e-discard-0004', 'e2e-discard-srv-4');
    try {
      commitFiles(h, { [LANDING]: baseLanding }, 'base');

      await h.startSession('change the hero line');
      await h.agentWrites('tu-1', LANDING, turnA);
      await sleep(500);
      h.reply('Added the hero line.');
      await h.stop();

      await h.submit('no, keep the hero; change the footer only');
      await h.agentRuns('tu-2', `git checkout HEAD -- ${LANDING}`, () => { h.git(['checkout', 'HEAD', '--', LANDING]); });
      await sleep(500);
      await h.agentWrites('tu-3', LANDING, baseLanding.replace('landing_7 = 7', 'footer_note = "built for maintainers"'));
      await sleep(500);
      h.reply('Reverted the hero and changed the footer.');
      await h.stop();

      const rows = h.rows();
      const a = rows.find((r: any) => r.promptIndex === 0);
      const b = rows.find((r: any) => r.promptIndex === 1);
      expect(a?.filesChanged).toEqual([LANDING]);
      expect(a?.discardedFiles).toEqual([LANDING]);
      // Its diff and counts are untouched: the page still shows what it wrote.
      expect(String(a?.diff || '')).toContain('+hero_line');
      expect(b?.filesChanged).toEqual([LANDING]);
      expect(b?.discardedFiles).toEqual([]);
    } finally {
      await h.close();
    }
  }, T);

  it('a later turn that REFINES the earlier turn\'s lines leaves it uncommitted', async () => {
    const h = await createHarness('e2e-discard-0005', 'e2e-discard-srv-5');
    try {
      commitFiles(h, { [LANDING]: baseLanding }, 'base');

      await h.startSession('change the hero line');
      await h.agentWrites('tu-1', LANDING, turnA);
      await sleep(500);
      h.reply('Added the hero line.');
      await h.stop();

      await h.submit('reword the sub line');
      await h.agentWrites('tu-2', LANDING, turnA.replace('Session history and blame', 'Session history, memory and blame'));
      await sleep(500);
      h.reply('Reworded.');
      await h.stop();

      const a = h.rows().find((r: any) => r.promptIndex === 0);
      expect(a?.filesChanged).toEqual([LANDING]);
      expect(a?.discardedFiles || []).not.toContain(LANDING);
    } finally {
      await h.close();
    }
  }, T);

  it('an earlier turn whose work a later turn COMMITTED is never discarded, even once the tree moves on', async () => {
    const h = await createHarness('e2e-discard-0006', 'e2e-discard-srv-6');
    try {
      commitFiles(h, { [LANDING]: baseLanding }, 'base');

      await h.startSession('change the hero line');
      await h.agentWrites('tu-1', LANDING, turnA);
      await sleep(500);
      h.reply('Added the hero line.');
      await h.stop();

      await h.submit('commit it, then try a different hero');
      await h.agentRuns('tu-2', 'git commit -am "hero line"', () => {
        h.git(['commit', '-q', '-am', 'hero line']);
      });
      const pc = await h.gitHook('git-post-commit');
      expect(pc.code, pc.stderr).toBe(0);
      await sleep(500);
      // The committed lines leave the tree; the commit still holds them.
      await h.agentWrites('tu-3', LANDING, baseLanding + 'hero_line_v2 = "Something else entirely"\n');
      await sleep(500);
      h.reply('Committed, and drafted another hero.');
      await h.stop();

      const a = h.rows().find((r: any) => r.promptIndex === 0);
      expect(a?.filesChanged).toEqual([LANDING]);
      expect(a?.discardedFiles || []).not.toContain(LANDING);
    } finally {
      await h.close();
    }
  }, T);

  it('a turn that keeps its write sends a measured empty list, not nothing', async () => {
    const h = await createHarness('e2e-discard-0002', 'e2e-discard-srv-2');
    try {
      commitFiles(h, { 'src/agy.ts': numbered('agy', 5) }, 'base');

      await h.startSession('bill agy tool output as input');
      await h.agentWrites('tu-1', 'src/agy.ts', numbered('agy', 5) + 'agy_fix = 1\n');
      await sleep(500);
      h.reply('Done.');
      await h.stop();

      const row = h.rows().find((r: any) => r.promptIndex === 0);
      expect(row.filesChanged).toEqual(['src/agy.ts']);
      expect(row.discardedFiles).toEqual([]);
    } finally {
      await h.close();
    }
  }, T);
});
