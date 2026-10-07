// End to end, through the built binary and a real heartbeat tick: a turn whose
// start shadow was cut AFTER it began writing keeps its file in the in-flight
// row (TODO f7406e7e).
//
// Cursor's after-file-edit cuts the shadow of a prompt its hooks never
// announced after the edit that revealed it; the Codex heartbeat cuts one when
// it notices the prompt. The tick narrowed the open turn's diff to files that
// changed since that shadow — the turn's own first edit had not — and, alone
// in the checkout, the shadow-window pass then read the window as empty. The
// row went out without the file, or not at all.
//
// Driven with the Claude Code hooks (which the harness speaks) and the late
// cut written into the state the way those producers record it.
import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';
import { commitFiles, createHarness, haveDist, numbered, sleep } from './helpers/stop-next-prompt-harness.js';
import { WINDOWS_SLOWDOWN } from './helpers/windows-e2e.js';
import { createShadowCommit } from '../git-capture.js';

const T = 120_000 * WINDOWS_SLOWDOWN;
const MINE = 'src/mine.py';
const LATE = 'src/late.py';

describe.skipIf(!haveDist)('heartbeat tick for a turn whose shadow was cut late', () => {
  it('sends the file the turn wrote before its shadow was cut', async () => {
    const SID = 'e2e-late-cut-0001';
    const h = await createHarness(SID, 'e2e-late-cut-srv-1');
    const stateFile = path.join(h.repo, '.git', `origin-session-${SID.slice(0, 12)}.json`);
    try {
      commitFiles(h, { [MINE]: numbered('mine', 5), [LATE]: numbered('late', 5) }, 'base');

      await h.startSession('first change');
      await h.agentWrites('tu-1', MINE, numbered('mine', 5) + 'mine_new = 1\n');
      h.reply('Done.');
      await h.stop();

      await h.submit('second change');
      await h.agentWrites('tu-2', LATE, numbered('late', 5) + 'late_new = 1\n');
      // The producer noticed turn 1 only now, after its edit: re-cut its shadow.
      const late = createShadowCommit(h.repo, 'late-cut-1');
      expect(late).toBeTruthy();
      const st = JSON.parse(fs.readFileSync(stateFile, 'utf-8'));
      st.promptShadows = (st.promptShadows || []).filter((s: any) => s.promptIndex !== 1)
        .concat([{ promptIndex: 1, shadowSha: late, capturedAt: new Date().toISOString(), cutAfterTurnStart: true }]);
      fs.writeFileSync(stateFile, JSON.stringify(st));

      const before = h.hits.length;
      await sleep(36_000); // past one 30s tick, turn still open
      const inFlight = h.hits.slice(before)
        .filter((x) => x.method === 'PATCH' && x.url.startsWith('/api/mcp/session/e2e-late-cut-srv-1'))
        .flatMap((x) => (Array.isArray(x.body?.promptChanges) ? x.body.promptChanges : []))
        .filter((pc: any) => pc.promptIndex === 1);
      expect(inFlight.length, 'no heartbeat row for the open turn arrived').toBeGreaterThan(0);
      const last = inFlight[inFlight.length - 1];
      expect(last.filesChanged || []).toContain(LATE);
      expect(String(last.diff || '') + String(last.uncommittedDiff || '')).toContain('late_new');
      // Still scoped to the turn: the first turn's uncommitted edit stays out.
      expect(last.filesChanged || []).not.toContain(MINE);
    } finally {
      await h.close();
    }
  }, T);
});
