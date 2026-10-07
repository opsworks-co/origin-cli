// End to end, through the built binary: Stop sends each turn's usage split by
// model (TODO b2fa4ebf), numbered like the rows, and the turns add up to what
// the session was priced on.
import { describe, it, expect } from 'vitest';
import { createHarness, haveDist } from './helpers/stop-next-prompt-harness.js';
import { WINDOWS_SLOWDOWN } from './helpers/windows-e2e.js';

const T = 120_000 * WINDOWS_SLOWDOWN;

describe.skipIf(!haveDist)('each turn\'s cost by model, through the built binary', () => {
  it('Stop sends every turn its own split, and a later turn\'s replies stay out of an earlier one', async () => {
    const h = await createHarness('e2e-turn-cost-0001', 'e2e-turn-cost-srv-1');
    try {
      await h.startSession('explain the build');
      h.reply('It runs tsc.', { model: 'claude-opus-5', in: 10, out: 100, read: 5_000 });
      await h.stop();

      await h.submit('and the tests?');
      h.reply('Vitest, in two projects.', { model: 'claude-fable-5-1', in: 20, out: 300, read: 9_000 });
      h.reply('Also a mirror check.', { model: 'claude-opus-5', in: 1, out: 7 });
      await h.stop();

      const rows = h.rows();
      const zero = rows.find((r: any) => r.promptIndex === 0) as any;
      const one = rows.find((r: any) => r.promptIndex === 1) as any;
      expect(zero?.modelUsage).toEqual([
        { model: 'claude-opus-5', inputTokens: 10, outputTokens: 100, cacheReadTokens: 5_000, cacheCreationTokens: 0, cacheCreation1hTokens: 0 },
      ]);
      expect((one?.modelUsage || []).map((m: any) => [m.model, m.outputTokens]).sort()).toEqual([
        ['claude-fable-5-1', 300], ['claude-opus-5', 7],
      ]);
    } finally {
      await h.close();
    }
  }, T);
});
